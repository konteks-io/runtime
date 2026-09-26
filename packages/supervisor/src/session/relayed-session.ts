import { isAbsolute } from "node:path";
import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  SessionToCoreMessageSchema,
  RemoteAuthorizedOperationSchema,
  SessionToRuntimeMessageSchema,
  RemoteTransferBindingSchema,
  RemoteExecutionReadyResultSchema,
  RemoteInstanceError,
  createLogger,
  type AcpJsonRpcError,
  type AgentTurnUsageObservation,
  type Clock,
  type JsonValue,
  type Logger,
  type PendingPermissionView,
  type RemoteWorkAssignment,
  type RemoteTransferBinding,
  type RemoteExecutionReadyResult,
  type RemoteDeliveryAcceptanceReceipt,
  type RetainedProcessOwner,
  type SessionToCoreMessage,
  type SessionToRuntimeMessage,
} from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import type { RunnerPort } from "../runner-port.js";
import type { SupervisorJournal } from "../state/journal.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { deferredPermissionBody, PermissionBroker, registerDeferral, sanitizeElicitationRequest, sanitizePermissionRequest, type PendingHumanRequest, type SanitizedElicitation, type SanitizedPermission } from "./permissions.js";
import type { CapabilityTokenIssue, DeferredPermissionBody } from "../core/client.js";
import type { PolicyResponder } from "./policy-responder.js";
import type { PreparedSessionInputs } from "../skills/session-inputs.js";
import { McpCapabilityFacade } from "../mcp/capability-facade.js";
import { PREVIEW_WORK_KINDS, PreviewMcpServer, type SessionPreviewAccess } from "../preview/mcp-server.js";
import {
  canonicalizeAcpToolActivity,
  continuesAtBoundary,
  endsInsidePath,
  redactActivity,
  type CanonicalAcpToolIdentity,
} from "./activity.js";
import { NativeExecutionGate, type NativeExecutionGateOptions } from "../native/execution-gate.js";
import { DshToolGovernance } from "./dsh-tool-governance.js";

/**
 * One relayed ACP session (D98/D113/D114): bootstrapped by the supervisor as a
 * consequence of a claim, announced with `session_ready`, driven by the grant
 * holder / orchestrator through `SessionToRuntimeMessage`s, and closed with
 * `session_closed`. The supervisor's durable pending-request journal is the
 * authoritative correlation store: every request received (prompt, set_mode,
 * set_config_option) or issued (request_permission, elicitation/create) is
 * journaled per `acpSessionRef`, and a completion whose id is unknown, already
 * closed, or whose method disagrees is rejected locally.
 */
export interface RelayedSessionDeps {
  clock: Clock;
  journal: SupervisorJournal;
  transport: TransportManager;
  runner: RunnerPort;
  policy: PolicyResponder;
  broker: PermissionBroker;
  /**
   * Register a policy deferral with Core (`permissions/deferred`) before the
   * request is surfaced. Core owns the pending view the holder resolves, the
   * requestDigest an answer permit echoes, and the deadline. Absent only in
   * legacy local tests; a production session always registers.
   */
  registerDeferral?: (body: DeferredPermissionBody) => Promise<PendingPermissionView>;
  instanceId: string;
  /** Redeems/renews one logical `mcpCapabilityTokenRef`; bearer stays in memory. */
  redeemCapabilityToken: (assignment: RemoteWorkAssignment) => Promise<CapabilityTokenIssue>;
  /** The runner's workspace folder: the confinement root the tool policy judges against. */
  workspaceRoot: string;
  /** Verified local inputs (workspace, skills, binding) for the claimed assignment. */
  prepareInputs: (assignment: RemoteWorkAssignment) => Promise<PreparedSessionInputs>;
  /**
   * Native-only local ownership commit. Cloud/file preparation and capability
   * redemption finish before this is called; the callback then opens or
   * transfers the durable execution generation immediately before the runner
   * adopts/creates provider state.
   */
  activateExecution?: () => Promise<{ continueReference?: string; restoreReference?: string }>;
  /** Registers execution readiness with Core before the session is announced. */
  registerReady: (assignment: RemoteWorkAssignment, binding: RemoteTransferBinding, acpSessionRef: string) => Promise<RemoteExecutionReadyResult>;
  /** Reserve an exclusive local channel after input verification, before bridge bootstrap. */
  reserveChannel?: (channelId: string, session: RelayedSession) => () => void;
  /** Actual WorkOrchestrator retained-admission fence, not a permission grant. */
  assertExecutionOwned?: () => void;
  /**
   * Admission-scoped ownership for the recovery stop this session drives
   * itself. That stop has already fenced the session and moved the execution
   * out of `opened`, so `assertExecutionOwned` refuses by construction; what
   * must still hold while the runner settles ACP is that the admission is
   * exactly this runtime's. Absent, `assertExecutionOwned` is used.
   */
  assertRecoveryOwned?: () => void;
  executionAuthority?: Pick<
    NativeExecutionGateOptions,
    "client" | "runnerIncarnation" | "currentRevisionFenceConnection" | "onFenceApplied"
  >;
  onExecutionAuthorityLost?: () => Promise<void>;
  reserveExecutionReference?: (opaqueRef: string) => Promise<void>;
  /**
   * Native only: the live reference the orchestrator actually handed over.
   * Absent means there is no same-process predecessor to adopt.
   */
  continueReference?: string;
  /** Native only: prior durable mapping to load after process loss. */
  restoreReference?: string;
  recordExecutionProcessOwner?: (owner: import("@konteks/remote-common").RetainedProcessOwner) => Promise<void>;
  /** Native bootstrap only: replace an exact stopped process before ready. */
  replaceExecutionProcessOwner?: (previous: RetainedProcessOwner, replacement: RetainedProcessOwner) => Promise<void>;
  /** ACP settlement only; does not release the retained generation fence. */
  recordCompletedSettlement?: (opaqueRef: string) => Promise<void>;
  /** Durably fold a planning message before transport and return its exact logical sequence. */
  beforeSendToCore?: (message: SessionToCoreMessage) => Promise<number>;
  /** Rechecked immediately before a local prompt crosses into the bridge. */
  assertPromptAllowed?: () => void;
  onUsage: (observation: AgentTurnUsageObservation) => Promise<void>;
  onClosed: (session: RelayedSession, reason: SessionClosedReason) => Promise<void>;
  /**
   * This machine's preview dev servers. Present, the session's agent gets the
   * preview tools (a loopback MCP server beside the platform facade) and the
   * session's preview stops when the session ends other than by a completed
   * turn (a completed turn's preview stays for the next turn, bounded by the
   * idle stop).
   */
  preview?: SessionPreviewAccess;
  logger?: Logger;
}

export type SessionClosedReason = Extract<SessionToCoreMessage, { kind: "session_closed" }>["reason"];

const HOLDER_REQUEST_METHODS = new Set(["session/prompt", "session/set_mode", "session/set_config_option"]);

export class RelayedSession {
  private boundChannelId: string | null;
  /** Native channels are unavailable until Core-authorized input binding is verified. */
  get channelId(): string | null { return this.boundChannelId; }
  acpSessionRef: string | null = null;
  private closed = false;
  private recoveryStopping = false;
  private recoveryStopTask: Promise<void> | null = null;
  private creationReturned = false;
  private readonly activities = new Set<Promise<unknown>>();
  private closeTask: Promise<void> | null = null;
  /**
   * Normal native completion closes the public session lane before asking the
   * runner for its settlement receipt.  The retained runner lifecycle fence
   * must stay valid for that one settlement operation; recovery/cancellation
   * closures still fence it immediately.
   */
  private completedSettlementInProgress = false;
  /**
   * The recovery counterpart: `stopForRecovery` fences this session before it
   * asks the runner to settle ACP, and the runner re-asserts the lifecycle
   * fence before it will stop anything. For exactly that runner call the fence
   * must answer with admission ownership instead of refusing its own stop.
   */
  private recoverySettlementInProgress = false;
  private channelOpened = false;
  private releaseChannel: (() => void) | null = null;
  /** Last streamed text per chunk kind, so redaction can tell a mid-token chunk start. */
  private readonly lastChunkText = new Map<string, { text: string; inPath: boolean }>();
  /** Safe tool identity carried from `tool_call` to sparse terminal updates. */
  private readonly toolActivityIdentity = new Map<string, CanonicalAcpToolIdentity>();
  /** Rebuilds DeepSeek Harness permission requests and trips on an unasked tool (dsh-tool-governance.ts). */
  private readonly dshGovernance: DshToolGovernance | null;
  private readonly logger: Logger;
  private preparedInputs: PreparedSessionInputs | null = null;
  private readonly executionGate: NativeExecutionGate | null;
  /** Durable key of the last prompt admitted on this session (see promptBusy). */
  private promptReservation: string | null = null;
  private lastPromptCompletion: { usage: AgentTurnUsageObservation | null } = { usage: null };
  private deliveryAcceptance: RemoteDeliveryAcceptanceReceipt | null = null;
  private mcpFacade: McpCapabilityFacade | null = null;
  private previewTools: PreviewMcpServer | null = null;
  /** The logical session whose preview this session's agent drives. */
  private previewSessionId: string | null = null;
  readonly counters = { unknownCompletions: 0, malformedResponses: 0 };

  constructor(readonly assignment: RemoteWorkAssignment, private readonly deps: RelayedSessionDeps) {
    this.dshGovernance = assignment.agentRoute.agentId === "dsh" ? new DshToolGovernance() : null;
    // Bound only after input preparation proves Core's claim-bound session.
    this.boundChannelId = null;
    this.logger = deps.logger ?? createLogger({ name: "relayed-session" });
    this.executionGate = (assignment.kind === "assistant_execution" || assignment.source.kind === "harness_delivery") && deps.executionAuthority
      ? new NativeExecutionGate({ ...deps.executionAuthority, assignment, logger: this.logger, journal: deps.journal, clock: deps.clock,
        assertOwned: () => {
          if (!deps.assertExecutionOwned) throw new RemoteInstanceError("execution_fenced", "Execution ownership is unavailable.");
          deps.assertExecutionOwned();
        }, onAuthorityLost: () => this.onExecutionAuthorityLost() }) : null;
  }

  private async onExecutionAuthorityLost(): Promise<void> {
    this.logger.warn({ event: "execution.authority_lost", workspaceId: this.assignment.workspaceId,
      assignmentId: this.assignment.id, attempt: this.assignment.attempt, acpSessionRef: this.acpSessionRef,
      outcome: "recovery_required" }, "Native execution fenced; notifying the session holder");
    try {
      // Notify while the admission still owns its channel, before recovery
      // suppresses normal traffic. This is failure visibility, not a claim of
      // operation settlement or background-tool quiescence.
      await this.sendToCore({ kind: "session_closed", assignmentId: this.assignment.id, reason: "lease_lost" });
    } catch {
      this.logger.warn({ event: "execution.authority_loss_notice_failed", assignmentId: this.assignment.id,
        attempt: this.assignment.attempt }, "Execution fenced without a current delivery owner");
    }
    try { await (this.deps.onExecutionAuthorityLost?.() ?? this.stopForRecovery()); }
    catch (error) {
      this.logger.warn({ event: "execution.recovery_stop_unconfirmed", assignmentId: this.assignment.id,
        attempt: this.assignment.attempt, code: error instanceof RemoteInstanceError ? error.code : "recovery_required", err: error },
      "Execution remains fenced; recovery settlement is unconfirmed");
      throw error;
    }
  }

  /** D98 bootstrap: initialize is runner-local; token → mcpServers; load/resume when proven; else session/new. */
  bootstrap(): Promise<{ acpSessionRef: string; resumed: boolean }> {
    return this.track(async () => {
      try { return await this.bootstrapImpl(); }
      catch (error) {
        await this.closeMcpFacade();
        throw error;
      }
    });
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(operation);
    this.activities.add(task);
    void task.then(() => this.activities.delete(task), () => this.activities.delete(task));
    return task;
  }

  /**
   * Keep bootstrap failures diagnosable without copying provider/Core error
   * messages into logs. Stage, stable code and retryability are sufficient to
   * locate the failing boundary; raw messages may contain private response or
   * workspace data and are deliberately excluded.
   */
  private async bootstrapStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await operation();
      // One line per finished stage, so a slow bootstrap says where (WS2-156).
      this.logger.info({ event: "native.bootstrap.stage", assignmentId: this.assignment.id, attempt: this.assignment.attempt,
        stage, durationMs: Date.now() - startedAt }, "native session bootstrap stage finished");
      return result;
    } catch (error) {
      const known = error instanceof RemoteInstanceError;
      this.logger.warn({
        assignmentId: this.assignment.id,
        attempt: this.assignment.attempt,
        stage,
        code: known ? error.code : "unexpected_error",
        retryable: known ? error.retryable : false,
        ...(known && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      }, "native session bootstrap stage failed");
      throw error;
    }
  }

  private async bootstrapImpl(): Promise<{ acpSessionRef: string; resumed: boolean }> {
    this.deps.assertExecutionOwned?.();
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    let prepared: PreparedSessionInputs;
    try { prepared = await this.bootstrapStage("input_preparation", () => this.deps.prepareInputs(this.assignment)); }
    catch { throw new RemoteInstanceError("capability_unavailable", "Required local session inputs are unavailable."); }
    this.deps.assertExecutionOwned?.();
    const parsedBinding = RemoteTransferBindingSchema.safeParse(prepared.binding);
    if (!parsedBinding.success) throw new RemoteInstanceError("workspace_binding_invalid", "Prepared local inputs do not match the assignment.");
    const binding = parsedBinding.data;
    if (binding.workspaceId !== this.assignment.workspaceId || binding.assignmentId !== this.assignment.id || binding.attempt !== this.assignment.attempt || binding.instanceId !== this.assignment.instanceId || binding.instanceId !== this.deps.instanceId ||
        (this.assignment.source.kind === "conversation" && binding.sessionId !== this.assignment.source.sessionId) || !isAbsolute(prepared.cwd) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(prepared.cwd)) {
      throw new RemoteInstanceError("workspace_binding_invalid", "Prepared local inputs do not match the assignment.");
    }
    this.preparedInputs = prepared;
    // Input preparation verifies Core's claim-bound selection. Use its logical
    // session identity, never a bridge ref or an assignment-local random ID.
    this.boundChannelId = `session:${binding.sessionId}`;
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    const mcpServers: Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }> = [];
    if (this.assignment.agentRoute.mcpCapabilityTokenRef) {
      const issue = await this.bootstrapStage("capability_redemption", () => this.deps.redeemCapabilityToken(this.assignment));
      this.deps.assertExecutionOwned?.();
      const facade = new McpCapabilityFacade({
        initial: issue,
        renew: () => {
          this.deps.assertExecutionOwned?.();
          if (this.closed) throw new RemoteInstanceError("execution_fenced", "The execution session is closed.");
          return this.deps.redeemCapabilityToken(this.assignment);
        },
        onUnavailable: () => this.close("agent_exited"),
        context: {
          assignmentId: this.assignment.id,
          attempt: this.assignment.attempt,
          sessionId: binding.sessionId,
        },
        logger: this.logger,
        now: () => this.deps.clock.coreNow(),
      });
      this.mcpFacade = facade;
      mcpServers.push({ type: "http", ...await this.bootstrapStage("facade", () => facade.start()) });
    }
    const preview = this.deps.preview;
    if (preview && PREVIEW_WORK_KINDS.has(this.assignment.kind)) {
      const sessionId = binding.sessionId;
      const cwd = prepared.cwd;
      const tools = new PreviewMcpServer({
        start: () => preview.start(sessionId, cwd),
        stop: () => preview.stop(sessionId, "agent"),
        status: () => preview.status(sessionId),
      }, { logger: this.logger, context: { assignmentId: this.assignment.id, attempt: this.assignment.attempt } });
      this.previewTools = tools;
      this.previewSessionId = sessionId;
      // A viewer may start this worktree's preview too (the same process
      // manager and inference as preview_start).
      preview.permit?.(sessionId, cwd);
      mcpServers.push({ type: "http", ...await this.bootstrapStage("preview_tools", () => tools.start()) });
    }
    // Optional tool wiring (Graft) ran alongside redemption and the facade.
    // The agent must find it in place, and the ownership commit below must
    // stay a short step from runner adoption, so settle it here. It never
    // rejects: a failed wiring is logged and the delivery continues.
    if (this.preparedInputs?.toolWiring) {
      await this.bootstrapStage("tool_wiring_wait", () => this.preparedInputs!.toolWiring!);
      this.deps.assertExecutionOwned?.();
      if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    }
    // Keep every fallible cloud/file input ahead of the local ownership
    // commit. Once activation succeeds, only local channel reservation and
    // runner adoption stand between the old and new ACP generations.
    const activation = this.deps.activateExecution
      ? await this.bootstrapStage("activation", () => this.deps.activateExecution!())
      : undefined;
    this.deps.assertExecutionOwned?.();
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    if (this.boundChannelId !== null && this.deps.reserveChannel) {
      this.releaseChannel = this.deps.reserveChannel(this.boundChannelId, this);
    }
    const source = this.assignment.source;
    const priorRef = activation?.continueReference ?? this.deps.continueReference;
    // A live in-process owner is strictly stronger than Core's restart-only
    // restore fallback. Passing both references is ambiguous and rejected by
    // the native runner; once live continuation wins, suppress the fallback.
    const restoreRef = priorRef === undefined
      ? activation?.restoreReference ?? this.deps.restoreReference
      : undefined;
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    this.deps.assertExecutionOwned?.();
    let reservedRef: string | undefined;
    const lifecycle = this.deps.reserveExecutionReference ? {
      beforeCreate: async (ref: string) => {
        await this.deps.reserveExecutionReference!(ref);
        reservedRef = ref;
        // This is an opaque ownership reservation, NOT a confirmed bridge
        // creation. Unknown creation still fails the runner settlement lookup.
        this.acpSessionRef = ref;
      },
      recordProcessOwner: async (owner: RetainedProcessOwner) => {
        if (!this.deps.recordExecutionProcessOwner) throw new RemoteInstanceError("recovery_required", "Durable execution-process ownership is unavailable.");
        await this.deps.recordExecutionProcessOwner(owner);
      },
      replaceProcessOwner: async (previous: RetainedProcessOwner, replacement: RetainedProcessOwner) => {
        if (!this.deps.replaceExecutionProcessOwner) throw new RemoteInstanceError("recovery_required", "Durable bootstrap process-owner replacement is unavailable.");
        await this.deps.replaceExecutionProcessOwner(previous, replacement);
      },
      assertCurrent: () => {
        // The runner's recovery stop asserts this fence first. The fence is
        // this session's own recovery mark, not a stale owner, so answer with
        // admission ownership for that one settlement operation only.
        if (this.recoverySettlementInProgress) return void this.assertRecoveryOwned();
        if (this.closed && !this.completedSettlementInProgress) {
          throw new RemoteInstanceError("recovery_required", "Session generation is fenced.", { diagnostic: "session_generation_fenced" });
        }
        this.deps.assertExecutionOwned?.();
      },
    } : undefined;
    const created = await this.bootstrapStage("acp_session_bootstrap", () => this.deps.runner.createSession({
      context: { instanceId: this.deps.instanceId, assignmentId: this.assignment.id, attempt: this.assignment.attempt, agentId: this.assignment.agentRoute.agentId },
      readinessDeadlineAt: new Date(Date.now() + Math.max(0, Date.parse(this.assignment.expiresAt) - this.deps.clock.coreNow())).toISOString(),
      cwd: prepared.cwd,
      mcpServers,
      ...(this.assignment.agentRoute.sessionConfig ? { sessionConfig: this.assignment.agentRoute.sessionConfig } : {}),
      ...(priorRef ? { acpSessionRef: priorRef } : {}),
      ...(restoreRef ? { restoreAcpSessionRef: restoreRef } : {}),
      ...(restoreRef && source.kind === "conversation" && this.assignment.agentRoute.agentId === "claude-code" ? { freshProviderSessionOnRestore: true } : {}),
      ...(this.assignment.sessionLabel ? { sessionLabel: this.assignment.sessionLabel } : {}),
    }, lifecycle));
    this.creationReturned = true;
    if (lifecycle && reservedRef !== created.acpSessionRef) throw new RemoteInstanceError("recovery_required", "Runner did not preserve durable reference ownership.");
    this.acpSessionRef = created.acpSessionRef;
    this.deps.assertExecutionOwned?.();
    if (this.closed) {
      if (!this.recoveryStopping) {
        await this.deps.runner.cancel(created.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
        await this.deps.runner.closeSession(created.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
      }
      throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    }
    let readyProjection: Pick<RemoteExecutionReadyResult, "attempt" | "recoveryEpoch" | "readyRevision"> | undefined;
    try {
      const binding = this.preparedInputs!.binding;
      const ready = RemoteExecutionReadyResultSchema.parse(await this.bootstrapStage("readiness", () =>
        this.deps.registerReady(this.assignment, binding, created.acpSessionRef)));
      this.deps.assertExecutionOwned?.();
      if (ready.workspaceId !== binding.workspaceId || ready.instanceId !== binding.instanceId || ready.sessionId !== binding.sessionId || ready.assignmentId !== binding.assignmentId || ready.attempt !== binding.attempt ||
          ready.agentId !== this.assignment.agentRoute.agentId || ready.acpSessionRef !== created.acpSessionRef || ready.channelId !== this.boundChannelId) {
        throw new RemoteInstanceError("workspace_binding_invalid", "Core readiness does not match the prepared local session.");
      }
      if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
      readyProjection = { attempt: ready.attempt, recoveryEpoch: ready.recoveryEpoch, readyRevision: ready.readyRevision };
    } catch (error) {
      this.deps.assertExecutionOwned?.();
      if (!this.recoveryStopping) {
        await this.deps.runner.cancel(created.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
        await this.deps.runner.closeSession(created.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
      }
      throw error;
    }
    if (this.boundChannelId === null) throw new RemoteInstanceError("workspace_binding_invalid", "The session channel has no authorized binding.");
    this.deps.assertExecutionOwned?.();
    this.deps.transport.openChannel(this.boundChannelId, "session");
    this.channelOpened = true;
    await this.sendToCore({ kind: "session_ready", assignmentId: this.assignment.id, acpSessionRef: created.acpSessionRef, resumed: created.resumed, agentId: this.assignment.agentRoute.agentId, capabilities: created.capabilities, ...readyProjection });
    if (this.assignment.source.kind === "harness_delivery" && this.preparedInputs?.resumeDeliveryOutput) {
      void this.track(() => this.resumeDurableDeliveryOutput()).catch(error => {
        this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt,
          code: error instanceof RemoteInstanceError ? error.code : "delivery_output_recovery_failed" }, "durable delivery output recovery stopped");
      });
    }
    return { acpSessionRef: created.acpSessionRef, resumed: created.resumed };
  }

  private deliveryAuthority(requestId: string) {
    const ref = this.acpSessionRef;
    const pending = ref === null ? undefined : this.deps.journal.pendingRequests.get(`${ref}:received:${requestId}`);
    const claims = pending?.authorization?.claims;
    if (!pending || pending.closedAt !== null || !claims || !("deliveryIdentity" in claims)) {
      throw new RemoteInstanceError("capability_unavailable", "Generated delivery output cannot be accepted without current delivery authority.");
    }
    return { claimId: claims.claimId, invocationRef: claims.deliveryIdentity.invocationId };
  }

  private async resumeDurableDeliveryOutput(): Promise<void> {
    const ref = this.acpSessionRef;
    if (ref === null || !this.preparedInputs?.resumeDeliveryOutput) return;
    for (const pending of this.deps.journal.openRequests(ref)) {
      if (pending.direction !== "received" || pending.method !== "session/prompt" || !("deliveryIdentity" in (pending.authorization?.claims ?? {}))) continue;
      await this.completeDeliveryOutput(pending.id, undefined, true);
      if (this.closed) return;
    }
  }

  /** Keep the original terminal handler alive across bounded transport attempts.
   * The candidate and completion are frozen locally before the first wait, so
   * retries and restart recovery cannot recapture different bytes. */
  private async completeDeliveryOutput(requestId: string, completion?: SessionToCoreMessage, resumeOnly = false): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      this.deps.assertExecutionOwned?.();
      if (this.deps.clock.coreNow() >= Date.parse(this.assignment.expiresAt)) throw new RemoteInstanceError("execution_fenced", "Delivery output authority expired before acceptance.");
      const authority = this.deliveryAuthority(requestId);
      try {
        const result = resumeOnly
          ? await this.preparedInputs!.resumeDeliveryOutput!(authority)
          : { receipt: await this.preparedInputs!.acceptDeliveryOutput!({ ...authority, completion: completion! }), completion: completion! };
        if (!result) return;
        this.deps.assertExecutionOwned?.();
        this.deliveryAcceptance = result.receipt;
        const parsed = SessionToCoreMessageSchema.parse(result.completion);
        if (parsed.kind !== "acp_result" || parsed.method !== "session/prompt" || parsed.id !== requestId) throw new RemoteInstanceError("capability_unavailable", "Durable delivery output completion does not match its prompt.");
        const accepted = await this.completeReceived(requestId, "session/prompt", parsed);
        if (accepted && (parsed.result as { stopReason?: string }).stopReason === "end_turn") await this.close("completed");
        return;
      } catch (error) {
        this.deps.assertExecutionOwned?.();
        if (this.deps.clock.coreNow() >= Date.parse(this.assignment.expiresAt)) throw error;
        attempt += 1;
        if (attempt === 1 || attempt % 12 === 0) this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt,
          transferAttempt: attempt }, "durable delivery output retained for retry");
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(5_000, 250 * 2 ** Math.min(attempt, 5))));
      }
    }
  }

  private async sendToCore(message: SessionToCoreMessage): Promise<void> {
    if (this.recoveryStopping) return;
    this.deps.assertExecutionOwned?.();
    const channelId = this.boundChannelId;
    if (channelId === null || !this.channelOpened) return;
    // Canonicalize while the bridge's private metadata is still present. The
    // strict relay schema deliberately discards `_meta`; doing this after its
    // first parse would permanently lose Claude's safe Agent/ToolSearch name.
    let canonicalMessage: unknown = message;
    let canonicalIdentity: {
      toolCallId: string;
      identity: CanonicalAcpToolIdentity;
      terminal: boolean;
    } | undefined;
    if (message.kind === "acp" && message.method === "session/update") {
      const rawUpdate = message.params.update as unknown as Record<string, unknown>;
      const toolCallId = typeof rawUpdate.toolCallId === "string" ? rawUpdate.toolCallId : undefined;
      const canonicalUpdate = canonicalizeAcpToolActivity(
        rawUpdate,
        this.assignment.agentRoute.agentId,
        toolCallId === undefined ? undefined : this.toolActivityIdentity.get(toolCallId),
      ) as Record<string, unknown>;
      if (toolCallId !== undefined) {
        const identity: CanonicalAcpToolIdentity = {
          ...(typeof canonicalUpdate.name === "string" ? { name: canonicalUpdate.name } : {}),
          ...(typeof canonicalUpdate.kind === "string" ? { kind: canonicalUpdate.kind } : {}),
          ...(typeof canonicalUpdate.title === "string" ? { title: canonicalUpdate.title } : {}),
        };
        canonicalIdentity = {
          toolCallId,
          identity,
          terminal: canonicalUpdate.status === "completed" || canonicalUpdate.status === "failed" || canonicalUpdate.status === "cancelled",
        };
      }
      canonicalMessage = {
        ...message,
        params: { ...message.params, update: canonicalUpdate },
      };
    }
    const parsed = SessionToCoreMessageSchema.safeParse(canonicalMessage);
    if (!parsed.success) {
      // A bridge payload that fails the vendored ACP schema is converted, never forwarded (D113).
      this.counters.malformedResponses += 1;
      if ("id" in message && typeof message.id === "string" && "method" in message && message.kind !== "acp") {
        await this.sendToCore({ kind: "acp_error", id: message.id, method: message.method as "session/prompt", error: malformed() });
      }
      return;
    }
    let body = parsed.data;
    if (body.kind === "acp" && body.method === "session/update") {
      if (body.params.sessionId !== this.acpSessionRef) {
        this.counters.malformedResponses += 1;
        return;
      }
      if (body.params.update.sessionUpdate === "agent_thought_chunk") return;
      if (canonicalIdentity) {
        if (canonicalIdentity.terminal) this.toolActivityIdentity.delete(canonicalIdentity.toolCallId);
        else if (Object.keys(canonicalIdentity.identity).length > 0) {
          this.toolActivityIdentity.set(canonicalIdentity.toolCallId, canonicalIdentity.identity);
        }
      }
      const update = body.params.update as { sessionUpdate: string; content?: { type?: string; text?: unknown } };
      const chunkText = (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk") &&
        update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : undefined;
      // Streamed text is split at arbitrary points; judge a chunk's first
      // character against the previous chunk of the same stream.
      const previous = chunkText === undefined ? undefined : this.lastChunkText.get(update.sessionUpdate);
      const startsAtBoundary = continuesAtBoundary(previous?.text);
      const continuesPath = previous?.inPath ?? false;
      if (chunkText === undefined) this.lastChunkText.clear();
      else this.lastChunkText.set(update.sessionUpdate, { text: chunkText, inPath: endsInsidePath(chunkText, continuesPath, startsAtBoundary) });
      const safe = SessionToCoreMessageSchema.safeParse(redactActivity(body, this.preparedInputs?.cwd ?? `${this.deps.workspaceRoot}/${this.assignment.id}`,
        { startsAtBoundary, continuesPath }));
      if (!safe.success) { this.counters.malformedResponses += 1; return; }
      body = safe.data;
    }
    const sourceSequence = await this.deps.beforeSendToCore?.(body);
    this.deps.assertExecutionOwned?.();
    this.deps.transport.send({ channel: "session", channelId, body, ...(sourceSequence === undefined ? {} : { sourceSequence }) });
  }

  /** Inbound from the grant holder / orchestrator. */
  onToRuntime(body: unknown): Promise<void> { return this.track(() => this.onToRuntimeImpl(body)); }

  /** Separate Core answer ingress: preserve its captured socket/lease fence
   * through the existing durable operation gate, never a raw ACP shortcut. */
  onCorePermissionAnswer(body: unknown, assertCurrent: () => void): Promise<void> {
    return this.track(async () => {
      assertCurrent();
      const parsed = RemoteAuthorizedOperationSchema.safeParse(body);
      if (!parsed.success || parsed.data.message.kind === "acp") throw new RemoteInstanceError("operation_conflict", "Core answer ingress cannot execute ACP requests.");
      if (this.closed || this.acpSessionRef === null || !this.channelOpened || !this.executionGate) {
        throw new RemoteInstanceError("execution_fenced", "Native answer session is unavailable.");
      }
      this.deps.assertExecutionOwned?.();
      await this.onAuthorizedOperation(parsed.data, assertCurrent);
      assertCurrent();
    });
  }

  private async onToRuntimeImpl(body: unknown): Promise<void> {
    const channelId = this.boundChannelId;
    if (this.closed || this.acpSessionRef === null || channelId === null || !this.channelOpened) return;
    this.deps.assertExecutionOwned?.();
    if (this.assignment.kind === "assistant_execution" || this.assignment.source.kind === "harness_delivery") {
      // Prepared Harness delivery must never fall back to bare ACP. The gate
      // must independently support its workload authority before dispatch.
      if (!this.executionGate) throw new RemoteInstanceError("execution_authority_unavailable", "Native execution admission is unavailable.");
      return this.onAuthorizedOperation(body);
    }
    const parsed = SessionToRuntimeMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn({ channelId: this.channelId }, "dropped a session frame that fails the schema");
      return;
    }
    const message = parsed.data;
    const ref = this.acpSessionRef;
    if (message.kind === "acp") {
      if (message.params.sessionId !== ref) {
        if ("id" in message) await this.sendToCore({ kind: "acp_error", id: message.id, method: message.method, error: { code: -32602, class: "invalid_params", message: "request session does not match the channel", retryable: false } });
        return;
      }
      if (message.method === "session/cancel") {
        await this.deps.runner.cancel(ref).catch(() => undefined);
        return;
      }
      if (!HOLDER_REQUEST_METHODS.has(message.method)) return;
      const request = message as Extract<SessionToRuntimeMessage, { kind: "acp"; id: string }>;
      // A terminal planning directive fences the input lane before this prompt
      // can create any durable request or outbound transcript fact. Keep the
      // later check as well to close a race while input preparation awaits I/O.
      if (request.method === "session/prompt") this.deps.assertPromptAllowed?.();
      const existing = this.deps.journal.pendingRequests.get(`${ref}:received:${request.id}`);
      if (existing) {
        this.counters.unknownCompletions += 1;
        await this.sendToCore({ kind: "acp_error", id: request.id, method: request.method as "session/prompt", error: { code: -32600, class: "unknown_request", message: "duplicate request id", retryable: false } });
        return;
      }
      await this.deps.journal.pendingRequests.put({ acpSessionRef: ref, id: request.id, method: request.method as "session/prompt", direction: "received", openedAt: this.deps.clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
      if (this.closed) return;
      this.deps.assertExecutionOwned?.();
      try {
        if (request.method === "session/prompt") {
          this.deps.assertPromptAllowed?.();
          if (this.preparedInputs) {
            try { await this.preparedInputs.beforePrompt(); }
            catch { throw new RemoteInstanceError("capability_unavailable", "Required local session inputs are unavailable."); }
          }
          if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
          this.deps.assertExecutionOwned?.();
          this.deps.assertPromptAllowed?.();
          if (this.previewSessionId !== null) this.deps.preview?.touch(this.previewSessionId);
          const instructions = this.preparedInputs?.skillInstructions;
          const params = instructions ? { ...request.params, prompt: [{ type: "text" as const, text: instructions }, ...request.params.prompt] } : request.params;
          await this.deps.runner.prompt(ref, request.id, params);
        }
        else if (request.method === "session/set_mode") await this.deps.runner.setMode(ref, request.id, request.params);
        else await this.deps.runner.setConfigOption(ref, request.id, request.params);
      } catch (error) {
        await this.completeReceived(request.id, request.method as "session/prompt", { kind: "acp_error", id: request.id, method: request.method as "session/prompt", error: classify(error) });
      }
      return;
    }
    // Completions of OUR issued requests (permission / elicitation answers).
    const journaled = this.deps.journal.pendingRequests.get(`${ref}:issued:${message.id}`);
    if (!journaled || journaled.closedAt !== null || journaled.method !== message.method) {
      this.counters.unknownCompletions += 1;
      this.logger.warn({ id: message.id }, "rejected a completion for an unknown, closed, or mismatched request");
      return;
    }
    const answer = message.kind === "acp_result" ? message.result : { outcome: { outcome: "cancelled" } };
    const verdict = this.deps.broker.answer(ref, message.id, message.kind === "acp_result" ? answer : journaled.method === "elicitation/create" ? { action: "cancel" } : answer);
    if (!verdict.ok) {
      this.logger.warn({ id: message.id, reason: verdict.reason }, "answer rejected");
      return;
    }
    await this.deps.journal.pendingRequests.put({ ...journaled, closedAt: this.deps.clock.nowIso() });
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    await this.deps.runner.answer(ref, message.id, message.kind === "acp_result" ? message.result : journaled.method === "elicitation/create" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } });
  }

  private async onAuthorizedOperation(body: unknown, assertDeliveryCurrent: () => void = () => {}): Promise<void> {
    const gate = this.executionGate!;
    assertDeliveryCurrent();
    const operation = await gate.admit(body);
    assertDeliveryCurrent();
    if (operation.replay) {
      if (operation.replayCompletion && !this.closed) await this.sendToCore(operation.replayCompletion);
      return;
    }
    const message = operation.envelope.message;
    const ref = this.acpSessionRef!;
    if (message.kind === "acp" && message.method === "session/prompt") {
      // Check and reserve with no await between them: exactly one prompt may
      // be admitted or running on this ACP session at a time.
      if (this.promptBusy(operation.key)) {
        await this.refuseConcurrentPrompt(gate, operation.key, message.id);
        return;
      }
      this.promptReservation = operation.key;
    }
    let params = message.kind === "acp" ? message.params : null;
    try {
      if (message.kind === "acp" && message.method === "session/prompt") {
        this.deps.assertPromptAllowed?.();
        try { await this.preparedInputs?.beforePrompt(); }
        catch { throw new RemoteInstanceError("capability_unavailable", "Required local session inputs are unavailable."); }
        this.deps.assertPromptAllowed?.();
        const instructions = this.preparedInputs?.skillInstructions;
        params = instructions ? { ...message.params, prompt: [{ type: "text" as const, text: instructions }, ...message.params.prompt] } : message.params;
      }
      if (this.closed) throw new RemoteInstanceError("execution_fenced", "The execution session is closed.");
      if (!(await gate.begin(operation))) return;
      assertDeliveryCurrent();
    } catch (error) {
      const state = this.deps.journal.pendingRequests.get(operation.key)?.authorization?.state;
      // Only a proven pre-dispatch refusal can become a replayable rejection.
      // A started operation remains unresolved for explicit recovery.
      if (state !== "admitted" && state !== "denied") throw error;
      const completion: SessionToCoreMessage | undefined = message.kind === "acp" && "id" in message
        ? { kind: "acp_error", id: message.id, method: message.method, error: classify(error) } : undefined;
      await gate.denyBeforeDispatch(operation.key, completion);
      const terminalTurnFailure =
        (this.assignment.kind === "assistant_execution" || this.assignment.source.kind === "harness_delivery") &&
        message.kind === "acp" &&
        message.method === "session/prompt" &&
        completion?.kind === "acp_error";
      try {
        if (completion && !this.closed) await this.sendToCore(completion);
      } finally {
        // No runner prompt exists to produce a later terminal event. Close the
        // failed turn locally so its durable assignment report and capacity
        // release do not depend on a best-effort cloud cancellation round trip.
        if (terminalTurnFailure && !this.closed) await this.close("agent_exited");
      }
      return;
    }
    // Do not convert a bridge transport exception into proof of completion.
    if (message.kind === "acp") {
      if (message.method === "session/prompt") {
        try { await this.deps.runner.prompt(ref, message.id, params); }
        catch (error) {
          // The runner's backstop: it refused because a prompt already runs
          // on this session. Nothing reached the agent, so this is a known
          // denial and the running turn is left alone.
          if (!(error instanceof RemoteInstanceError) || error.code !== "operation_conflict") throw error;
          const completion = concurrentPromptError(message.id);
          await gate.refuseAtDispatch(operation.key, completion);
          this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage: "prompt_dispatch",
            outcome: "denied_concurrent_prompt", source: "runner" }, "runner refused a second prompt on a busy session");
          if (!this.closed) await this.sendToCore(completion);
        }
      }
      else if (message.method === "session/set_mode") await this.deps.runner.setMode(ref, message.id, params);
      else if (message.method === "session/set_config_option") await this.deps.runner.setConfigOption(ref, message.id, params);
      else {
        if (this.assignment.source.kind === "harness_delivery") {
          // Harness owns whether its delivery invocation can proceed. An exact
          // Core-permitted cancellation (including before the first prompt)
          // closes this assignment through the normal local terminal-report
          // path so a stale claim cannot consume native runtime capacity.
          await gate.complete(operation.key);
          await this.close("cancelled");
        } else {
          await this.deps.runner.cancel(ref);
          await gate.complete(operation.key);
        }
      }
      return;
    }
    const answer = message.kind === "acp_result" ? message.result : message.method === "elicitation/create" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } };
    const verdict = this.deps.broker.answer(ref, message.id, answer);
    if (!verdict.ok) throw new RemoteInstanceError("operation_conflict", "The pending human answer is no longer admissible.");
    const delivered = await this.deps.runner.answer(ref, message.id, answer);
    if (!delivered.delivered) throw new RemoteInstanceError("operation_interrupted", "Answer delivery is unproven.");
    await gate.complete(operation.key);
  }

  /**
   * Whether another prompt on this session is admitted or running. The
   * reservation names the last prompt that passed this check; it holds only
   * while that prompt is admitted, or started in this process and unsettled
   * (a started row recovered from a crashed process never blocks a new turn).
   */
  private promptBusy(key: string): boolean {
    const reserved = this.promptReservation;
    if (reserved === null || reserved === key) return false;
    const state = this.deps.journal.pendingRequests.get(reserved)?.authorization?.state;
    return state === "admitted" || (state === "dispatch_started" && this.executionGate?.isDispatching(reserved) === true);
  }

  /** Deny before dispatch: a known outcome with an ACP error that never reaches the runner. */
  private async refuseConcurrentPrompt(gate: NativeExecutionGate, key: string, id: string): Promise<void> {
    const completion = concurrentPromptError(id);
    await gate.denyBeforeDispatch(key, completion);
    this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage: "prompt_dispatch",
      outcome: "denied_concurrent_prompt", source: "supervisor" }, "refused a second prompt while one is running on this session");
    // The running turn keeps the session; do not close it for this refusal.
    if (!this.closed) await this.sendToCore(completion);
  }

  private async completeReceived(id: string, method: "session/prompt" | "session/set_mode" | "session/set_config_option", completion: SessionToCoreMessage): Promise<boolean> {
    this.deps.assertExecutionOwned?.();
    const ref = this.acpSessionRef;
    if (ref === null) return false;
    const journaled = this.deps.journal.pendingRequests.get(`${ref}:received:${id}`);
    if (!journaled || journaled.closedAt !== null || journaled.method !== method) {
      this.counters.unknownCompletions += 1;
      return false;
    }
    if (journaled.authorization && this.executionGate) await this.executionGate.complete(`${ref}:received:${id}`, completion);
    else await this.deps.journal.pendingRequests.put({ ...journaled, closedAt: this.deps.clock.nowIso() });
    this.deps.assertExecutionOwned?.();
    await this.sendToCore(completion);
    return true;
  }

  /** Runner events for this session. */
  onRunnerEvent(event: RunnerEvent): Promise<void> { return this.track(() => this.onRunnerEventImpl(event)); }

  private async onRunnerEventImpl(event: RunnerEvent): Promise<void> {
    if (this.closed || this.acpSessionRef === null || !("acpSessionRef" in event) || event.acpSessionRef !== this.acpSessionRef) return;
    this.deps.assertExecutionOwned?.();
    switch (event.kind) {
      case "session_update": {
        // A working agent keeps its preview from stopping as idle.
        if (this.previewSessionId !== null) this.deps.preview?.touch(this.previewSessionId);
        const bypass = this.dshGovernance?.observe((event.params as { update?: unknown } | null)?.update) ?? null;
        await this.sendToCore({ kind: "acp", method: "session/update", params: event.params as never });
        if (bypass) await this.onDshGovernanceBypass(bypass);
        return;
      }
      case "prompt_result": {
        if (this.assignment.kind === "delivery" && this.assignment.source.kind === "harness_delivery") {
          if (!this.preparedInputs?.acceptDeliveryOutput) {
            throw new RemoteInstanceError("capability_unavailable", "Generated delivery output cannot be accepted without current delivery authority.");
          }
          await this.completeDeliveryOutput(event.requestId, { kind: "acp_result", id: event.requestId, method: "session/prompt", result: event.result as never });
          return;
        }
        const accepted = await this.completeReceived(event.requestId, "session/prompt", { kind: "acp_result", id: event.requestId, method: "session/prompt", result: event.result as never });
        // Assistant admission creates one assignment per turn. A persistent
        // native Codex thread does not exit when its turn ends, so waiting for
        // session_exited leaks a claimed assignment and blocks the next turn.
        // Close this assignment, not the shared native server or its history.
        const stopReason = (event.result as { stopReason?: string })?.stopReason;
        const nativeTurn = accepted &&
          (this.assignment.kind === "assistant_execution" || this.assignment.source.kind === "harness_delivery");
        if (nativeTurn && stopReason === "end_turn") await this.close("completed");
        else if (nativeTurn && typeof stopReason === "string" && !this.closed) {
          // A turn that ends any other way has still ENDED: a rejected tool
          // interrupts Claude Code's turn as `cancelled`, a refusal or token
          // cap ends it likewise. Left open, the claimed assignment kept
          // heartbeating until the harness deadline (2026-09-15, 27 minutes
          // for a turn that had stopped at minute ten). Close it so a
          // terminal reaches Core now.
          this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stopReason },
            "native turn ended without end_turn; closing the assignment as an agent exit");
          await this.close("agent_exited");
        }
        return;
      }
      case "set_mode_result":
        await this.completeReceived(event.requestId, "session/set_mode", { kind: "acp_result", id: event.requestId, method: "session/set_mode", result: event.result as never });
        return;
      case "set_config_option_result":
        await this.completeReceived(event.requestId, "session/set_config_option", { kind: "acp_result", id: event.requestId, method: "session/set_config_option", result: event.result as never });
        return;
      case "request_error": {
        const accepted = await this.completeReceived(event.requestId, event.method, { kind: "acp_error", id: event.requestId, method: event.method, error: { code: event.code, class: event.class, message: event.message, retryable: event.retryable } });
        if (accepted && event.method === "session/prompt" &&
            (this.assignment.kind === "assistant_execution" || this.assignment.source.kind === "harness_delivery")) {
          // Say why before the close: its SIGTERM on the bridge was the only
          // trace of a Codex sign-in that could not refresh (WS2-141).
          this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, code: event.code, errorClass: event.class, retryable: event.retryable },
            "native turn failed with a request error; closing the assignment as an agent exit");
          await this.close("agent_exited");
        }
        return;
      }
      case "usage_observation":
        this.lastPromptCompletion = { usage: event.observation };
        await this.deps.onUsage(event.observation);
        return;
      case "permission_request":
        await this.onPermissionRequest(event.requestId, event.params as RequestPermissionRequest);
        return;
      case "elicitation_request":
        await this.onElicitationRequest(event.requestId, event.params as CreateElicitationRequest);
        return;
      case "elicitation_complete":
        await this.sendToCore({ kind: "acp", method: "elicitation/complete", params: event.params as never });
        return;
      case "session_exited":
        await this.close(event.reason === "agent_exited" ? "agent_exited" : "completed");
        return;
      default:
        return;
    }
  }

  /** D87: policy first; defer to a human via the relay when policy allows; fail closed at the deadline. */
  private async onPermissionRequest(requestId: string, params: RequestPermissionRequest): Promise<void> {
    const ref = this.acpSessionRef;
    if (ref === null) return;
    if (this.dshGovernance) {
      // dsh asks with only a tool call id; judge the call it names, or refuse.
      const verdict = this.dshGovernance.decide(params, this.preparedInputs?.cwd ?? `${this.deps.workspaceRoot}/${this.assignment.id}`);
      if (verdict.kind !== "evaluate") {
        if (this.closed) return;
        this.deps.assertExecutionOwned?.();
        const kind = verdict.kind === "allow" ? "allow_once" : "reject_once";
        const optionId = params.options.find(option => option.kind === kind)?.optionId;
        if (verdict.kind === "deny") {
          this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, toolCallId: params.toolCall.toolCallId, reason: verdict.reason }, "DeepSeek Harness tool call refused by policy");
        }
        return void (await this.deps.runner.answer(ref, requestId, optionId === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } }));
      }
      params = verdict.request;
    }
    const decision = await this.deps.policy.evaluatePermission(params, { assignmentId: this.assignment.id, agentId: this.assignment.agentRoute.agentId, workspaceRoot: this.deps.workspaceRoot });
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    if (decision.kind === "allow") return void (await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "selected", optionId: decision.optionId } }));
    // A refused tool ends the agent's turn on Claude Code; the log named
    // nothing about it, so a turn that stopped at a build command read as a
    // hung agent. Bounded, sanitized title only.
    this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, toolCallId: params.toolCall.toolCallId,
      title: sanitizePermissionRequest(params).params.title, decision: decision.kind,
      humanDeferralAllowed: this.assignment.policy.humanDeferralAllowed }, "tool permission not allowed by policy");
    if (decision.kind === "deny") {
      return void (await this.deps.runner.answer(ref, requestId, decision.optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: decision.optionId } }));
    }
    if (!this.assignment.policy.humanDeferralAllowed) return void (await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "cancelled" } }));
    const sanitized = sanitizePermissionRequest(params);
    const pending = await this.deferToHuman(ref, requestId, "session/request_permission", sanitized);
    if (!pending) return void (await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "cancelled" } }));
    await this.sendToCore({ kind: "acp", method: "session/request_permission", id: requestId, params: { sessionId: ref, toolCall: { toolCallId: params.toolCall.toolCallId, title: sanitized.params.title, ...(sanitized.params.toolKind ? { kind: sanitized.params.toolKind } : {}) }, options: sanitized.params.options } as never });
  }

  /**
   * The Konteks ask hook did not run for a gated dsh tool that has now
   * completed: stop the turn and take dsh out of service until the connector
   * restarts, so at most one call ever runs unjudged.
   */
  private async onDshGovernanceBypass(bypass: { toolCallId: string; title: string }): Promise<void> {
    const ref = this.acpSessionRef;
    this.logger.error({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, toolCallId: bypass.toolCallId, tool: bypass.title.slice(0, 128), diagnostic: "dsh_tool_governance_bypassed" },
      "DeepSeek Harness ran a gated tool without asking; stopping the turn and taking it out of service");
    if (ref !== null) await this.deps.runner.cancel(ref).catch(error => this.logger.warn({ err: error }, "cancel after a governance bypass failed"));
    await this.deps.runner.quarantine?.("DeepSeek Harness ran a tool without asking Konteks first. Update or reinstall DeepSeek Harness, then restart the connector.")
      .catch(error => this.logger.warn({ err: error }, "quarantine after a governance bypass failed"));
    await this.close("agent_exited");
  }

  private async onElicitationRequest(requestId: string, params: CreateElicitationRequest): Promise<void> {
    const ref = this.acpSessionRef;
    if (ref === null) return;
    const sanitized = sanitizeElicitationRequest(params);
    const decision = await this.deps.policy.evaluateElicitation(params);
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    if (decision.kind === "decline" || sanitized.isSignIn || !this.assignment.policy.humanDeferralAllowed) {
      // Sign-in elicitations are surfaced to the operator, never automated or remotely answered; a headless run fails closed.
      if (sanitized.isSignIn) this.logger.warn({ assignmentId: this.assignment.id }, "agent asked for a sign-in; failing closed with agent_auth_required");
      await this.deps.runner.answer(ref, requestId, { action: "decline" });
      return;
    }
    const pending = await this.deferToHuman(ref, requestId, "elicitation/create", sanitized);
    if (!pending) return void (await this.deps.runner.answer(ref, requestId, { action: "decline" }));
    await this.sendToCore({ kind: "acp", method: "elicitation/create", id: requestId, params: { mode: "form", message: sanitized.params.message, requestedSchema: sanitized.params.requestedSchema } as never });
  }

  /**
   * Register with Core first, then track and journal the request under Core's
   * requestDigest and deadline, so the answer permit Core issues matches the
   * journaled request. Null means Core never confirmed it: fail closed rather
   * than surface a request nobody can resolve or answer.
   */
  private async deferToHuman(ref: string, requestId: string, method: "session/request_permission" | "elicitation/create",
    sanitized: SanitizedPermission | SanitizedElicitation): Promise<PendingHumanRequest | null> {
    const args = { acpSessionRef: ref, requestId, assignmentId: this.assignment.id, attempt: this.assignment.attempt, agentId: this.assignment.agentRoute.agentId, sanitized };
    let registered: PendingPermissionView | null = null;
    if (this.deps.registerDeferral) {
      const source = this.assignment.source;
      // Core threads a request onto the assignment's own session: the
      // conversation, a native delivery's execution session, else the assignment.
      const sessionId = source.kind === "conversation" ? source.sessionId
        : source.kind === "harness_delivery" ? source.executionSessionId : this.assignment.id;
      registered = await registerDeferral(this.deps.registerDeferral, deferredPermissionBody({ ...args, sessionId }), { logger: this.logger });
      if (!registered) return null;
      if (this.closed) return null;
      this.deps.assertExecutionOwned?.();
    }
    const pending = this.deps.broker.defer(args, registered?.deadlineAt);
    await this.deps.journal.pendingRequests.put({ acpSessionRef: ref, id: requestId, method, direction: "issued", openedAt: pending.raisedAt, closedAt: null,
      deadlineAt: pending.deadlineAt, requestDigest: registered?.requestDigest ?? sanitized.requestDigest });
    return pending;
  }

  /** Deadline reached with no authorized answer: fail closed (D87 step 3). */
  onDeadline(request: PendingHumanRequest): Promise<void> { return this.track(() => this.onDeadlineImpl(request)); }

  private async onDeadlineImpl(request: PendingHumanRequest): Promise<void> {
    const ref = this.acpSessionRef;
    if (this.closed || ref === null || request.acpSessionRef !== ref) return;
    const journaled = this.deps.journal.pendingRequests.get(`${ref}:issued:${request.requestId}`);
    if (journaled && journaled.closedAt === null) await this.deps.journal.pendingRequests.put({ ...journaled, closedAt: this.deps.clock.nowIso() });
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    await this.deps.runner.answer(ref, request.requestId, request.sanitized.kind === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" }).catch(() => undefined);
  }

  usage(): AgentTurnUsageObservation | null {
    return this.lastPromptCompletion.usage;
  }

  deliveryAcceptanceReceipt(): RemoteDeliveryAcceptanceReceipt | null {
    return this.deliveryAcceptance ? structuredClone(this.deliveryAcceptance) : null;
  }

  /** Recovery owns the terminal report, so this never invokes onClosed or
   * synthesizes session_closed(cancelled). Failure keeps the session fenced.
   */
  fenceForRecovery(): void { this.executionGate?.stop(); this.recoveryStopping = true; this.closed = true; }

  stopForRecovery(): Promise<void> {
    if (this.recoveryStopTask) return this.recoveryStopTask;
    this.fenceForRecovery();
    this.recoveryStopTask = (async () => {
      await this.closeMcpFacade();
      this.stopPreview("claim_lost");
      const initialRef = this.creationReturned ? this.acpSessionRef : null;
      const stop = async (ref: string): Promise<void> => {
        const stopRunner = this.deps.runner.stopForRecovery;
        if (!stopRunner) throw new RemoteInstanceError("recovery_required", "Runner cannot prove a per-session recovery stop.");
        this.deps.broker.cancelSession(ref);
        this.recoverySettlementInProgress = true;
        try { await stopRunner.call(this.deps.runner, ref); }
        finally { this.recoverySettlementInProgress = false; }
      };
      // Request cancellation before awaiting a handler that may itself be
      // waiting for that agent. Late bootstrap is handled after it settles.
      const initialStop = initialRef === null ? null : stop(initialRef);
      void initialStop?.catch(() => undefined);
      await Promise.allSettled([...this.activities]);
      // Normal closure may have failed while persisting/reporting a settled
      // turn. Await its termination, but require independent runner settlement
      // below; that failure alone is neither stop evidence nor a permanent
      // veto on recovery's separately journaled ACP-settlement stage.
      if (this.closeTask) await Promise.allSettled([this.closeTask]);
      if (initialStop) await initialStop;
      else if (this.acpSessionRef !== null) await stop(this.acpSessionRef);
      else throw new RemoteInstanceError("recovery_required", "Bridge session creation has an unknown outcome; recovery stop is unproven.");
      // The execution is already `stopping` under this session's own recovery
      // fence; only admission ownership can still be current here.
      this.assertRecoveryOwned();
      // Stage one only. ACP settlement never releases the final live/channel
      // owner or qualifies background tool quiescence.
    })();
    return this.recoveryStopTask;
  }

  private assertRecoveryOwned(): void {
    (this.deps.assertRecoveryOwned ?? this.deps.assertExecutionOwned)?.();
  }

  /**
   * Resolves once this session is closed and every prompt on it was asked to
   * stop. A session still open has not reached its own terminal, so it throws
   * and the caller retries later. Used before a claim reports itself
   * `interrupted(not_resumable)`.
   */
  async confirmStopped(): Promise<void> {
    if (!this.closed) throw new RemoteInstanceError("recovery_required", "The session is still open.");
    if (this.closeTask) await Promise.allSettled([this.closeTask]);
    if (this.acpSessionRef !== null) await this.deps.runner.cancel(this.acpSessionRef).catch(() => undefined);
    await Promise.allSettled([...this.activities]);
  }

  /** Dispatch owns the failure report; disposal must not invent a user cancellation. */
  async disposeFailedBootstrap(): Promise<void> {
    this.executionGate?.stop();
    this.deps.assertExecutionOwned?.();
    if (this.closed) {
      // A cancellation may already own cleanup and its terminal report.
      await this.closeTask;
      this.deps.assertExecutionOwned?.();
      return;
    }
    this.closed = true;
    try {
      await this.closeMcpFacade();
      if (this.acpSessionRef !== null) {
        await this.deps.runner.cancel(this.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
        await this.deps.runner.closeSession(this.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
      }
      // A post-ready journal failure must also close the advertised session.
      // No readiness announcement means there is no remote session to close.
      if (this.channelOpened) await this.sendToCore({ kind: "session_closed", assignmentId: this.assignment.id, reason: "agent_exited" });
    } finally {
      if (!this.recoveryStopping) {
        this.deps.assertExecutionOwned?.();
        this.releaseChannel?.();
        this.releaseChannel = null;
      }
    }
  }

  close(reason: SessionClosedReason): Promise<void> {
    this.executionGate?.stop();
    if (this.closeTask) return this.closeTask;
    if (this.closed) return Promise.resolve();
    this.completedSettlementInProgress = reason === "completed";
    this.closed = true;
    this.closeTask = Promise.resolve().then(() => this.finishClose(reason));
    return this.closeTask;
  }

  private async finishClose(reason: SessionClosedReason): Promise<void> {
    const nativeCompletion = reason === "completed";
    let settlementRecorded = false;
    try {
      if (nativeCompletion && this.acpSessionRef === null) throw new RemoteInstanceError("recovery_required", "Native completed closure requires its exact session reference.");
      if (this.acpSessionRef !== null) {
        // Defensive cancellation of this exact retained reference remains
        // possible after lease loss; it is not qualified stop or release.
        if (reason === "relay_replay_gap" || reason === "lease_lost" || reason === "drain" || reason === "cancelled") await this.deps.runner.cancel(this.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
        for (const pending of this.deps.broker.cancelSession(this.acpSessionRef)) {
          this.deps.assertExecutionOwned?.();
          await this.deps.runner.answer(this.acpSessionRef, pending.requestId, pending.sanitized.kind === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" }).catch(() => undefined);
          this.deps.assertExecutionOwned?.();
        }
        this.deps.assertExecutionOwned?.();
        if (nativeCompletion) {
          const receipt = await this.deps.runner.closeSession(this.acpSessionRef, { completed: true });
          if (!receipt || typeof receipt !== "object" || !("completion" in receipt) || receipt.completion !== "native_continuation_ready" || !this.deps.recordCompletedSettlement) {
            throw new RemoteInstanceError("recovery_required", "Native completed-turn settlement is unavailable.");
          }
          this.deps.assertExecutionOwned?.();
          await this.deps.recordCompletedSettlement(this.acpSessionRef);
          settlementRecorded = true;
          this.logger.info({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, acpSessionRef: this.acpSessionRef, stage: "completed_turn_settlement", outcome: "recorded" }, "native ACP settlement recorded; generation ownership retained");
        } else await this.deps.runner.closeSession(this.acpSessionRef).catch(() => undefined);
        this.deps.assertExecutionOwned?.();
      }
      try {
        await this.sendToCore({ kind: "session_closed", assignmentId: this.assignment.id, reason });
      } catch (error) {
        // A broken transcript channel must not suppress the independent durable
        // terminal report. Ownership and native completion checks still apply.
        this.deps.assertExecutionOwned?.();
        this.logger.warn({ event: "session.close.relay_unavailable", assignmentId: this.assignment.id,
          attempt: this.assignment.attempt, channelId: this.boundChannelId, reason,
          stage: "terminal_report", code: error instanceof RemoteInstanceError ? error.code : "transport_failed" },
          "session closure could not use relay; continuing durable terminal reporting");
      }
      // Native assignment closure is not logical-session channel retirement:
      // its final frame, replay buffer and sequence space stay for the next turn.
      if (!this.recoveryStopping) await this.deps.onClosed(this, reason);
      this.deps.assertExecutionOwned?.();
    } catch (error) {
      if (nativeCompletion) this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage: "completed_turn_settlement", outcome: settlementRecorded ? "report_failed" : "unconfirmed", code: "recovery_required" }, "native completed closure remains unconfirmed");
      throw error;
    } finally {
      await this.closeMcpFacade();
      if (!nativeCompletion) this.stopPreview(reason);
      this.completedSettlementInProgress = false;
      // The completed receipt is not qualified handoff. Keep the channel's
      // retry owner even after its terminal report has been persisted.
      if (!this.recoveryStopping && !nativeCompletion) {
        this.deps.assertExecutionOwned?.();
        this.releaseChannel?.();
        this.releaseChannel = null;
      }
    }
  }

  private async closeMcpFacade(): Promise<void> {
    const facade = this.mcpFacade;
    this.mcpFacade = null;
    const tools = this.previewTools;
    this.previewTools = null;
    await Promise.all([facade?.close(), tools?.close()]);
  }

  /** The session's preview goes with the session (not with a completed turn). */
  private stopPreview(reason: string): void {
    const sessionId = this.previewSessionId;
    if (sessionId === null || !this.deps.preview) return;
    this.deps.preview.forget?.(sessionId);
    void this.deps.preview.stop(sessionId, reason).catch(error => this.logger.warn({ event: "preview.stop_failed", assignmentId: this.assignment.id, err: error }, "session preview could not be stopped"));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * The next turn of the same conversation takes the logical channel from a
   * retained completed owner (bb stops a thread's existing session before
   * starting another). Only a closed, fully settled native completion may
   * hand over; any other owner keeps its reservation.
   */
  releaseCompletedChannel(): void {
    if (!this.closed || this.closeTask === null || this.completedSettlementInProgress || this.recoveryStopping) {
      throw new RemoteInstanceError("assignment_conflict", "The conversation's previous turn still owns its session channel.");
    }
    this.releaseChannel?.();
    this.releaseChannel = null;
  }

  /**
   * A recovery-fenced owner keeps its channel reservation until the
   * orchestrator has proven its exact process stopped and Core settled the
   * claim (WS2-159). Only then may the next turn take the channel, always
   * with a fresh ACP session. Its own recovery stop must have run to the end.
   */
  releaseRecoveredChannel(): void {
    if (!this.closed || !this.recoveryStopping || this.recoveryStopTask === null || this.recoverySettlementInProgress) {
      throw new RemoteInstanceError("assignment_conflict", "The previous execution still owns its session channel.");
    }
    this.releaseChannel?.();
    this.releaseChannel = null;
  }

  waitForAuthorityStop(): Promise<void> { return this.executionGate?.waitForAuthorityStop() ?? Promise.resolve(); }
}

function malformed(): AcpJsonRpcError {
  return { code: -32603, class: "malformed_response", message: "bridge response failed schema validation", retryable: false };
}

function concurrentPromptError(id: string): SessionToCoreMessage {
  return { kind: "acp_error", id, method: "session/prompt",
    error: { code: -32600, class: "invalid_params", message: "Another prompt is already running on this session.", retryable: false } };
}

function classify(error: unknown): AcpJsonRpcError {
  const message = error instanceof Error ? error.message.slice(0, 1_024) : "request failed";
  if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "agent_auth_required") {
    return { code: -32000, class: "agent_auth_required", message, retryable: false };
  }
  return { code: -32603, class: "internal", message, retryable: false };
}

export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
