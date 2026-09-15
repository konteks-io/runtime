import { randomUUID } from "node:crypto";
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
import {
  canonicalizeAcpToolActivity,
  continuesAtBoundary,
  endsInsidePath,
  redactActivity,
  type CanonicalAcpToolIdentity,
} from "./activity.js";
import { NativeExecutionGate, type NativeExecutionGateOptions } from "../native/execution-gate.js";

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
  browserToolUrl: string | null;
  workspaceRoot: string;
  /** Legacy appliance callers may omit this during migration. Native cannot. */
  deploymentKind?: "appliance" | "native_connector";
  prepareInputs?: (assignment: RemoteWorkAssignment) => Promise<PreparedSessionInputs>;
  /**
   * Native-only local ownership commit. Cloud/file preparation and capability
   * redemption finish before this is called; the callback then opens or
   * transfers the durable execution generation immediately before the runner
   * adopts/creates provider state.
   */
  activateExecution?: () => Promise<{ continueReference?: string; restoreReference?: string }>;
  registerReady?: (assignment: RemoteWorkAssignment, binding: RemoteTransferBinding, acpSessionRef: string) => Promise<RemoteExecutionReadyResult>;
  /** Reserve an exclusive local channel after input verification, before bridge bootstrap. */
  reserveChannel?: (channelId: string, session: RelayedSession) => () => void;
  /** Actual WorkOrchestrator retained-admission fence, not a permission grant. */
  assertExecutionOwned?: () => void;
  executionAuthority?: Pick<NativeExecutionGateOptions, "client" | "runnerIncarnation">;
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
  private channelOpened = false;
  private releaseChannel: (() => void) | null = null;
  /** Last streamed text per chunk kind, so redaction can tell a mid-token chunk start. */
  private readonly lastChunkText = new Map<string, { text: string; inPath: boolean }>();
  /** Safe tool identity carried from `tool_call` to sparse terminal updates. */
  private readonly toolActivityIdentity = new Map<string, CanonicalAcpToolIdentity>();
  private readonly logger: Logger;
  private preparedInputs: PreparedSessionInputs | null = null;
  private readonly executionGate: NativeExecutionGate | null;
  private lastPromptCompletion: { usage: AgentTurnUsageObservation | null } = { usage: null };
  private deliveryAcceptance: RemoteDeliveryAcceptanceReceipt | null = null;
  private mcpFacade: McpCapabilityFacade | null = null;
  readonly counters = { unknownCompletions: 0, malformedResponses: 0 };

  constructor(readonly assignment: RemoteWorkAssignment, private readonly deps: RelayedSessionDeps) {
    this.boundChannelId = deps.deploymentKind === "native_connector" ? null : `session:${assignment.id}:${assignment.attempt}:${randomUUID().slice(0, 8)}`;
    this.logger = deps.logger ?? createLogger({ name: "relayed-session" });
    this.executionGate = deps.deploymentKind === "native_connector" &&
      (assignment.kind === "assistant_execution" || assignment.source.kind === "harness_delivery") && deps.executionAuthority
      ? new NativeExecutionGate({ ...deps.executionAuthority, assignment, journal: deps.journal, clock: deps.clock,
        assertOwned: () => {
          if (!deps.assertExecutionOwned) throw new RemoteInstanceError("execution_fenced", "Execution ownership is unavailable.");
          deps.assertExecutionOwned();
        }, onAuthorityLost: () => deps.onExecutionAuthorityLost ? deps.onExecutionAuthorityLost() : this.stopForRecovery() }) : null;
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
    try {
      return await operation();
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
    if (this.deps.deploymentKind === "native_connector" && (!this.deps.prepareInputs || !this.deps.registerReady)) {
      throw new RemoteInstanceError("capability_unavailable", "Native input preparation and Core readiness registration are required.");
    }
    if (this.deps.prepareInputs) {
      let prepared: PreparedSessionInputs;
      try { prepared = await this.bootstrapStage("input_preparation", () => this.deps.prepareInputs!(this.assignment)); }
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
      if (this.deps.deploymentKind === "native_connector") this.boundChannelId = `session:${binding.sessionId}`;
    }
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    const mcpServers: Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }> = [];
    if (this.assignment.agentRoute.mcpCapabilityTokenRef) {
      const issue = await this.bootstrapStage("mcp_capability_redemption", () => this.deps.redeemCapabilityToken(this.assignment));
      this.deps.assertExecutionOwned?.();
      if (this.deps.deploymentKind === "native_connector") {
        const facade = new McpCapabilityFacade({
          initial: issue,
          renew: () => this.deps.redeemCapabilityToken(this.assignment),
          context: {
            assignmentId: this.assignment.id,
            attempt: this.assignment.attempt,
            sessionId: this.preparedInputs?.binding.sessionId ?? this.assignment.id,
          },
          logger: this.logger,
          now: () => this.deps.clock.coreNow(),
        });
        this.mcpFacade = facade;
        mcpServers.push({ type: "http", ...await this.bootstrapStage("mcp_facade_start", () => facade.start()) });
      } else {
        mcpServers.push({ type: "http", ...issue.mcpServer });
      }
    }
    if (this.assignment.agentRoute.requiredRole === "qa" && this.deps.browserToolUrl) {
      mcpServers.push({ type: "http", name: "konteks-browser-tool", url: this.deps.browserToolUrl, headers: [] });
    }
    // Keep every fallible cloud/file input ahead of the local ownership
    // commit. Once activation succeeds, only local channel reservation and
    // runner adoption stand between the old and new ACP generations.
    const activation = this.deps.activateExecution
      ? await this.bootstrapStage("execution_activation", () => this.deps.activateExecution!())
      : undefined;
    this.deps.assertExecutionOwned?.();
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
    if (this.boundChannelId !== null && this.deps.reserveChannel) {
      this.releaseChannel = this.deps.reserveChannel(this.boundChannelId, this);
    }
    const source = this.assignment.source;
    const priorRef = this.deps.deploymentKind === "native_connector" && this.deps.reserveChannel
      ? activation?.continueReference ?? this.deps.continueReference
      : source.kind === "conversation" ? source.acpSessionRef : undefined;
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
        if (this.closed && !this.completedSettlementInProgress) {
          throw new RemoteInstanceError("recovery_required", "Session generation is fenced.", { diagnostic: "session_generation_fenced" });
        }
        this.deps.assertExecutionOwned?.();
      },
    } : undefined;
    const created = await this.bootstrapStage("acp_session_bootstrap", () => this.deps.runner.createSession({
      context: { instanceId: this.deps.instanceId, assignmentId: this.assignment.id, attempt: this.assignment.attempt, agentId: this.assignment.agentRoute.agentId },
      readinessDeadlineAt: new Date(Date.now() + Math.max(0, Date.parse(this.assignment.expiresAt) - this.deps.clock.coreNow())).toISOString(),
      cwd: this.preparedInputs?.cwd ?? `${this.deps.workspaceRoot}/${this.assignment.id}`,
      mcpServers,
      ...(this.assignment.agentRoute.sessionConfig ? { sessionConfig: this.assignment.agentRoute.sessionConfig } : {}),
      ...(priorRef ? { acpSessionRef: priorRef } : {}),
      ...(restoreRef ? { restoreAcpSessionRef: restoreRef } : {}),
      ...(restoreRef && source.kind === "conversation" && this.assignment.agentRoute.agentId === "claude-code" ? { freshProviderSessionOnRestore: true } : {}),
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
    if (this.deps.deploymentKind === "native_connector") {
      try {
        const binding = this.preparedInputs!.binding;
        const ready = RemoteExecutionReadyResultSchema.parse(await this.bootstrapStage("core_readiness_registration", () =>
          this.deps.registerReady!(this.assignment, binding, created.acpSessionRef)));
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
    if (channelId === null || (this.deps.deploymentKind === "native_connector" && !this.channelOpened)) return;
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
    if (this.deps.deploymentKind === "native_connector" &&
      (this.assignment.kind === "assistant_execution" || this.assignment.source.kind === "harness_delivery")) {
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
      const terminalDeliveryFailure =
        this.assignment.source.kind === "harness_delivery" &&
        message.kind === "acp" &&
        message.method === "session/prompt" &&
        completion?.kind === "acp_error" &&
        completion.error.retryable === false;
      try {
        if (completion && !this.closed) await this.sendToCore(completion);
      } finally {
        // No runner prompt exists to produce a later terminal event. Close the
        // failed delivery locally so its durable assignment report and capacity
        // release do not depend on a best-effort cloud cancellation round trip.
        if (terminalDeliveryFailure) await this.close("agent_exited");
      }
      return;
    }
    // Do not convert a bridge transport exception into proof of completion.
    if (message.kind === "acp") {
      if (message.method === "session/prompt") await this.deps.runner.prompt(ref, message.id, params);
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
      case "session_update":
        await this.sendToCore({ kind: "acp", method: "session/update", params: event.params as never });
        return;
      case "prompt_result": {
        if (this.deps.deploymentKind === "native_connector" && this.assignment.kind === "delivery" &&
            this.assignment.source.kind === "harness_delivery") {
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
        if (accepted && this.deps.deploymentKind === "native_connector" &&
          (this.assignment.kind === "assistant_execution" || this.assignment.source.kind === "harness_delivery") &&
          (event.result as { stopReason?: string })?.stopReason === "end_turn") await this.close("completed");
        return;
      }
      case "set_mode_result":
        await this.completeReceived(event.requestId, "session/set_mode", { kind: "acp_result", id: event.requestId, method: "session/set_mode", result: event.result as never });
        return;
      case "set_config_option_result":
        await this.completeReceived(event.requestId, "session/set_config_option", { kind: "acp_result", id: event.requestId, method: "session/set_config_option", result: event.result as never });
        return;
      case "request_error":
        await this.completeReceived(event.requestId, event.method, { kind: "acp_error", id: event.requestId, method: event.method, error: { code: event.code, class: event.class, message: event.message, retryable: event.retryable } });
        return;
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
    const decision = await this.deps.policy.evaluatePermission(params, { assignmentId: this.assignment.id, agentId: this.assignment.agentRoute.agentId, workspaceRoot: this.deps.workspaceRoot });
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    if (decision.kind === "allow") return void (await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "selected", optionId: decision.optionId } }));
    if (decision.kind === "deny") {
      return void (await this.deps.runner.answer(ref, requestId, decision.optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: decision.optionId } }));
    }
    if (!this.assignment.policy.humanDeferralAllowed) return void (await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "cancelled" } }));
    const sanitized = sanitizePermissionRequest(params);
    const pending = await this.deferToHuman(ref, requestId, "session/request_permission", sanitized);
    if (!pending) return void (await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "cancelled" } }));
    await this.sendToCore({ kind: "acp", method: "session/request_permission", id: requestId, params: { sessionId: ref, toolCall: { toolCallId: params.toolCall.toolCallId, title: sanitized.params.title, ...(sanitized.params.toolKind ? { kind: sanitized.params.toolKind } : {}) }, options: sanitized.params.options } as never });
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
      const initialRef = this.creationReturned ? this.acpSessionRef : null;
      const stop = async (ref: string): Promise<void> => {
        const stopRunner = this.deps.runner.stopForRecovery;
        if (!stopRunner) throw new RemoteInstanceError("recovery_required", "Runner cannot prove a per-session recovery stop.");
        this.deps.broker.cancelSession(ref);
        await stopRunner.call(this.deps.runner, ref);
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
      this.deps.assertExecutionOwned?.();
      // Stage one only. ACP settlement never releases the final live/channel
      // owner or qualifies background tool quiescence.
    })();
    return this.recoveryStopTask;
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
    this.completedSettlementInProgress = reason === "completed" && this.deps.deploymentKind === "native_connector";
    this.closed = true;
    this.closeTask = Promise.resolve().then(() => this.finishClose(reason));
    return this.closeTask;
  }

  private async finishClose(reason: SessionClosedReason): Promise<void> {
    const nativeCompletion = reason === "completed" && this.deps.deploymentKind === "native_connector";
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
      await this.sendToCore({ kind: "session_closed", assignmentId: this.assignment.id, reason });
      // Native assignment closure is not logical-session channel retirement.
      // Retain its final frame, replay buffer and sequence space for the next turn.
      if (this.deps.deploymentKind !== "native_connector" && this.boundChannelId !== null) this.deps.transport.closeChannel(this.boundChannelId);
      if (!this.recoveryStopping) await this.deps.onClosed(this, reason);
      this.deps.assertExecutionOwned?.();
    } catch (error) {
      if (nativeCompletion) this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage: "completed_turn_settlement", outcome: settlementRecorded ? "report_failed" : "unconfirmed", code: "recovery_required" }, "native completed closure remains unconfirmed");
      throw error;
    } finally {
      await this.closeMcpFacade();
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
    await facade?.close();
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
    if (!this.closed || this.closeTask === null || this.completedSettlementInProgress || this.recoveryStopping || this.deps.deploymentKind !== "native_connector") {
      throw new RemoteInstanceError("assignment_conflict", "The conversation's previous turn still owns its session channel.");
    }
    this.releaseChannel?.();
    this.releaseChannel = null;
  }

  waitForAuthorityStop(): Promise<void> { return this.executionGate?.waitForAuthorityStop() ?? Promise.resolve(); }
}

function malformed(): AcpJsonRpcError {
  return { code: -32603, class: "malformed_response", message: "bridge response failed schema validation", retryable: false };
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
