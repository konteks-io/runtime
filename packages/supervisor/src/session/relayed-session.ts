import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  SessionToCoreMessageSchema,
  RemoteAuthorizedOperationSchema,
  SessionToRuntimeMessageSchema,
  RemoteTransferBindingSchema,
  RemoteExecutionReadyResultSchema,
  RemoteInstanceError,
  allEqual,
  createLogger,
  type AcpJsonRpcError,
  type AgentTurnUsageObservation,
  type Clock,
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
import { BROWSER_MCP_SERVER_NAME, type RunnerEvent } from "@konteks/remote-agent-runner";
import type { RunnerPort, RunnerSessionCreated, RunnerSessionInput, RunnerSessionLifecycle } from "../runner-port.js";
import type { PendingRequest, SupervisorJournal } from "../state/journal.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { deferredPermissionBody, PermissionBroker, registerDeferral, sanitizeElicitationRequest, sanitizePermissionRequest, type PendingHumanRequest, type SanitizedElicitation, type SanitizedPermission } from "./permissions.js";
import type { CapabilityTokenIssue, DeferredPermissionBody } from "../core/client.js";
import type { AdmittedMcpTool, PolicyDecision, PolicyResponder } from "./policy-responder.js";
import type { PreparedSessionInputs } from "../skills/session-inputs.js";
import { McpCapabilityFacade, type McpLocalTransportIdentity } from "../mcp/capability-facade.js";
import { PREVIEW_WORK_KINDS, PreviewMcpServer, type SessionPreviewAccess } from "../preview/mcp-server.js";
import { PreviewBrowserGateway } from "../preview/browser-gateway.js";
import {
  canonicalizeAcpToolActivity,
  continuesAtBoundary,
  contractIssue,
  endsInsidePath,
  omitPrivateAcpToolPayload,
  redactSessionMessage,
  type CanonicalAcpToolIdentity,
} from "./activity.js";
import { NativeExecutionGate, type NativeExecutionGateOptions } from "../native/execution-gate.js";
import { continuedSession, isDirectAssignment, isNativeTurn } from "../work/continued-session.js";
import { hostToolGovernance, type HostToolBypass, type HostToolGovernance } from "./host-tool-governance.js";
import { McpToolCallLedger } from "./permission-tool-identity.js";
import { antigravityKonteksToolsLine, antigravityResultToolReference } from "./antigravity-prompt.js";
import { openCodeKonteksToolsLine, openCodeResultToolReference } from "./opencode-prompt.js";
import { compileResultSchema as compileTurnValidator, StructuredResultToolServer, toolInputSchema } from "../structured-result/result-tool-server.js";
import {
  findStructuredContract,
  followUpRequestId,
  MAX_STRUCTURED_TURN_TEXT,
  parseFencedResult,
  resultFollowUp,
  resultToolLine,
  resultToolLineWithSchema,
  rewriteStructuredPrompt,
  sumPromptUsage,
  type PromptBlock,
  type StructuredTurnState,
} from "../structured-result/structured-turn.js";

/**
 * One relayed ACP session: bootstrapped by the supervisor as a
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
  /**
   * MCP tools of servers other than the session's own that an integration
   * binding admitted into this assignment (a seam no production caller sets
   * today). Absent or empty: every other server's tool is refused.
   */
  admittedMcpTools?: (assignment: RemoteWorkAssignment) => readonly AdmittedMcpTool[];
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
  /** Retained local address/header for the same provider thread, never Core delegation. */
  mcpLocalTransport?: McpLocalTransportIdentity;
  mcpLocalTransportReference?: string;
  /** Persist the local transport identity before the provider sees its MCP config. */
  recordMcpLocalTransport?: (identity: McpLocalTransportIdentity) => Promise<void>;
  /** Legacy first load only: the owner must prove this reference absent. */
  assertLegacyCodexThreadUnloaded?: (reference: string) => Promise<boolean>;
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
  /** A turn started or ended: the computer's busy state changed. */
  onTurnActivity?: () => void;
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
  /** Rebuilds a host agent's permission requests and trips on an unapproved tool (host-tool-governance.ts: DeepSeek Harness, OpenCode). */
  private readonly toolGovernance: HostToolGovernance | null;
  /** The MCP servers this session gave its agent (the only Code Mode namespaces an OpenCode block may call, the only servers Antigravity may reach). */
  private sessionServers: ReadonlySet<string> = new Set();
  /** Codex's announced MCP calls: its approvals name only the tool call id. */
  private readonly mcpCalls: McpToolCallLedger | null;
  /** A governed permission request's tool call and options, until Konteks answers it. */
  private readonly governedPermissions = new Map<string, { toolCallId: string; options: RequestPermissionRequest["options"] }>();
  /** An OpenCode or Antigravity session is told once how Konteks runs its tools (in its first prompt). */
  private toolFormTold = false;
  private readonly logger: Logger;
  private preparedInputs: PreparedSessionInputs | null = null;
  private readonly executionGate: NativeExecutionGate | null;
  /** Durable key of the last prompt admitted on this session (see promptBusy). */
  private promptReservation: string | null = null;
  private lastPromptCompletion: { usage: AgentTurnUsageObservation | null } = { usage: null };
  private deliveryAcceptance: RemoteDeliveryAcceptanceReceipt | null = null;
  private mcpFacade: McpCapabilityFacade | null = null;
  private previewTools: PreviewMcpServer | null = null;
  /** The session's `submit_result` tool (every session has one; it is generic until a turn asks for a result). */
  private resultTools: StructuredResultToolServer | null = null;
  /** The turn that asked for a structured result, while it (or its one follow-up) runs. */
  private structuredTurn: StructuredTurnState | null = null;
  /** The QA browser's gateway (validation, QA, delivery and conversation sessions of any agent) and its output folder. */
  private browserGateway: PreviewBrowserGateway | null = null;
  private browserOutputDir: string | null = null;
  /** The logical session whose preview this session's agent drives. */
  private previewSessionId: string | null = null;
  readonly counters = { unknownCompletions: 0, malformedResponses: 0 };

  constructor(readonly assignment: RemoteWorkAssignment, private readonly deps: RelayedSessionDeps) {
    this.toolGovernance = hostToolGovernance(assignment.agentRoute.agentId);
    this.mcpCalls = assignment.agentRoute.agentId === "codex" ? new McpToolCallLedger() : null;
    // Bound only after input preparation proves Core's claim-bound session.
    this.boundChannelId = null;
    this.logger = deps.logger ?? createLogger({ name: "relayed-session" });
    this.executionGate = isNativeTurn(assignment) && deps.executionAuthority
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
      // A non-Konteks error was logged as `recovery_required`, which hid
      // where the stop failed. The orchestrator retries it.
      this.logger.warn({ event: "execution.recovery_stop_unconfirmed", assignmentId: this.assignment.id,
        attempt: this.assignment.attempt, code: error instanceof RemoteInstanceError ? error.code : "unexpected_error",
        ...(error instanceof RemoteInstanceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}), err: error },
      "Execution remains fenced; recovery settlement is unconfirmed");
      throw error;
    }
  }

  /** Bootstrap: initialize is runner-local; token → mcpServers; load/resume when proven; else session/new. */
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
      // One line per finished stage, so a slow bootstrap says where.
      this.logger.info({ event: "native.bootstrap.stage", assignmentId: this.assignment.id, attempt: this.assignment.attempt,
        stage, durationMs: Date.now() - startedAt }, "native session bootstrap stage finished");
      return result;
    } catch (error) {
      this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage, ...stageFailure(error) },
        "native session bootstrap stage failed");
      throw error;
    }
  }

  private async bootstrapImpl(): Promise<{ acpSessionRef: string; resumed: boolean }> {
    const { prepared, binding } = await this.prepareSessionInputs();
    const mcpServers: SessionMcpServer[] = [];
    // A direct session is the person's own agent with nothing of Konteks in
    // it: no platform tools even when a capability is named, no preview or
    // browser (not a preview kind), no result tool.
    const direct = isDirectAssignment(this.assignment);
    await this.startCapabilityFacade(binding.sessionId, direct, mcpServers);
    const browser = await this.startPreviewTools(binding.sessionId, prepared.cwd, mcpServers);
    // The turn result tool: every Konteks session gets it, so a turn that asks
    // for a structured result can be answered through a validated tool call.
    // A direct turn asks for none: it ends on the agent's own end_turn.
    if (!direct) await this.startResultTool(mcpServers);
    await this.awaitToolWiring();
    const activation = await this.activate();
    const references = await this.chosenReferences(activation);
    const reserved: { ref?: string } = {};
    const lifecycle = this.sessionLifecycle(reserved);
    // The browser is a stdio server the runner adds; OpenCode's Code Mode
    // gate and its tools line need its name too.
    this.sessionServers = new Set([...mcpServers.map(server => server.name), ...(browser ? [BROWSER_MCP_SERVER_NAME] : [])]);
    const created = await this.bootstrapStage("acp_session_bootstrap", () => this.deps.runner.createSession(
      this.sessionRequest(prepared.cwd, mcpServers, references, browser), lifecycle));
    await this.adoptCreated(created, lifecycle !== undefined, reserved);
    const readyProjection = await this.registerReadiness(created);
    await this.announceReady(created, readyProjection);
    return { acpSessionRef: created.acpSessionRef, resumed: created.resumed };
  }

  /** Core's claim-bound local inputs, verified against this assignment; binds the session channel. */
  private async prepareSessionInputs(): Promise<{ prepared: PreparedSessionInputs; binding: RemoteTransferBinding }> {
    this.deps.assertExecutionOwned?.();
    if (this.closed) throw sessionClosed();
    let prepared: PreparedSessionInputs;
    try { prepared = await this.bootstrapStage("input_preparation", () => this.deps.prepareInputs(this.assignment)); }
    catch { throw new RemoteInstanceError("capability_unavailable", "Required local session inputs are unavailable."); }
    this.deps.assertExecutionOwned?.();
    const binding = this.verifiedBinding(prepared);
    this.preparedInputs = prepared;
    // Input preparation verifies Core's claim-bound selection. Use its logical
    // session identity, never a bridge ref or an assignment-local random ID.
    this.boundChannelId = `session:${binding.sessionId}`;
    if (this.closed) throw sessionClosed();
    return { prepared, binding };
  }

  private verifiedBinding(prepared: PreparedSessionInputs): RemoteTransferBinding {
    const parsed = RemoteTransferBindingSchema.safeParse(prepared.binding);
    if (!parsed.success || !this.bindingMatches(parsed.data, prepared.cwd)) {
      throw new RemoteInstanceError("workspace_binding_invalid", "Prepared local inputs do not match the assignment.");
    }
    return parsed.data;
  }

  /** The binding is this assignment's (and this computer's), in its continued session, with a plain absolute working copy. */
  private bindingMatches(binding: RemoteTransferBinding, cwd: string): boolean {
    const continued = continuedSession(this.assignment.source);
    return allEqual([
      [binding.workspaceId, this.assignment.workspaceId], [binding.assignmentId, this.assignment.id], [binding.attempt, this.assignment.attempt],
      [binding.instanceId, this.assignment.instanceId], [binding.instanceId, this.deps.instanceId],
    ]) && (continued === null || binding.sessionId === continued.sessionId) && isAbsolute(cwd) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(cwd);
  }

  /** The platform tools, through a session-scoped loopback facade that holds Core's bearer. */
  private async startCapabilityFacade(sessionId: string, direct: boolean, mcpServers: SessionMcpServer[]): Promise<void> {
    if (!this.assignment.agentRoute.mcpCapabilityTokenRef || direct) return;
    const issue = await this.bootstrapStage("capability_redemption", () => this.deps.redeemCapabilityToken(this.assignment));
    this.deps.assertExecutionOwned?.();
    const facade = new McpCapabilityFacade({
      initial: issue,
      ...(this.deps.mcpLocalTransport ? { localTransport: this.deps.mcpLocalTransport } : {}),
      initiallyInactive: true,
      renew: () => {
        this.deps.assertExecutionOwned?.();
        if (this.closed) throw new RemoteInstanceError("execution_fenced", "The execution session is closed.");
        return this.deps.redeemCapabilityToken(this.assignment);
      },
      onUnavailable: () => this.close("agent_exited"),
      // Core's answer to environment_open is the only thing that widens
      // this session's browser, and only to what Core named.
      onBrowserAccess: grant => { this.browserGateway?.grant(grant.origins, grant.kind); },
      context: {
        assignmentId: this.assignment.id,
        attempt: this.assignment.attempt,
        sessionId,
      },
      logger: this.logger,
      now: () => this.deps.clock.coreNow(),
    });
    this.mcpFacade = facade;
    mcpServers.push({ type: "http", ...await this.bootstrapStage("facade", () => facade.start()) });
  }

  /** The preview tools (and the browser, when this computer has one) for a kind of work that runs a preview. */
  private async startPreviewTools(sessionId: string, cwd: string, mcpServers: SessionMcpServer[]): Promise<SessionBrowser | undefined> {
    const preview = this.deps.preview;
    if (!preview || !PREVIEW_WORK_KINDS.has(this.assignment.kind)) return undefined;
    const browser = await this.startBrowserGateway(preview, sessionId);
    const tools = new PreviewMcpServer({
      start: () => preview.start(sessionId, cwd),
      stop: () => preview.stop(sessionId, "agent"),
      status: () => preview.status(sessionId),
    }, { logger: this.logger, context: { assignmentId: this.assignment.id, attempt: this.assignment.attempt }, browser: browser !== undefined });
    this.previewTools = tools;
    this.previewSessionId = sessionId;
    // A viewer may start this worktree's preview too (the same process
    // manager and inference as preview_start).
    preview.permit?.(sessionId, cwd);
    mcpServers.push({ type: "http", ...await this.bootstrapStage("preview_tools", () => tools.start()) });
    return browser;
  }

  /**
   * The session's browser: the connector's, for every agent when the
   * connector has one (Claude Code and Codex run their own package's,
   * DeepSeek Harness and OpenCode the connector's), reaching only this
   * session's running preview through its own gateway.
   */
  private async startBrowserGateway(preview: SessionPreviewAccess, sessionId: string): Promise<SessionBrowser | undefined> {
    const browserVersion = this.deps.runner.browserVersion?.() ?? null;
    if (browserVersion === null || !preview.origin || !preview.browsersPath) return undefined;
    const origin = preview.origin.bind(preview);
    const gateway = new PreviewBrowserGateway({
      target: () => origin(sessionId),
      onActivity: () => preview.touch(sessionId),
      logger: this.logger,
      context: { assignmentId: this.assignment.id, attempt: this.assignment.attempt },
    });
    this.browserGateway = gateway;
    const proxyUrl = await this.bootstrapStage("browser_gateway", () => gateway.start());
    this.browserOutputDir = await mkdtemp(join(tmpdir(), "konteks-browser-"));
    return { proxyUrl, outputDir: this.browserOutputDir, browsersPath: preview.browsersPath };
  }

  private async startResultTool(mcpServers: SessionMcpServer[]): Promise<void> {
    const resultTools = new StructuredResultToolServer({ logger: this.logger, context: { assignmentId: this.assignment.id, attempt: this.assignment.attempt } });
    this.resultTools = resultTools;
    mcpServers.push({ type: "http", ...await this.bootstrapStage("result_tool", () => resultTools.start()) });
  }

  /**
   * Optional tool wiring (Graft) ran alongside redemption and the facade.
   * The agent must find it in place, and the ownership commit below must
   * stay a short step from runner adoption, so settle it here. It never
   * rejects: a failed wiring is logged and the delivery continues.
   */
  private async awaitToolWiring(): Promise<void> {
    if (!this.preparedInputs?.toolWiring) return;
    await this.bootstrapStage("tool_wiring_wait", () => this.preparedInputs!.toolWiring!);
    this.deps.assertExecutionOwned?.();
    if (this.closed) throw sessionClosed();
  }

  /**
   * Keep every fallible cloud/file input ahead of the local ownership
   * commit. Once activation succeeds, only local channel reservation and
   * runner adoption stand between the old and new ACP generations.
   */
  private async activate(): Promise<ExecutionActivation | undefined> {
    const activation = this.deps.activateExecution
      ? await this.bootstrapStage("activation", () => this.deps.activateExecution!())
      : undefined;
    this.deps.assertExecutionOwned?.();
    if (this.closed) throw sessionClosed();
    await this.recordTransportIdentity();
    if (this.boundChannelId !== null && this.deps.reserveChannel) {
      this.releaseChannel = this.deps.reserveChannel(this.boundChannelId, this);
    }
    return activation;
  }

  private async recordTransportIdentity(): Promise<void> {
    if (!this.mcpFacade || !this.deps.recordMcpLocalTransport) return;
    await this.bootstrapStage("mcp_transport_identity", () => this.deps.recordMcpLocalTransport!(this.mcpFacade!.localTransportIdentity()));
    this.deps.assertExecutionOwned?.();
  }

  /** The provider session to continue or restore, checked against the retained transport; then the facade opens. */
  private async chosenReferences(activation: ExecutionActivation | undefined): Promise<SessionReferences> {
    const references = this.referencesFor(activation);
    this.assertTransportReference(references);
    await this.assertLegacyCodexThread(references);
    this.mcpFacade?.enable();
    if (this.closed) throw sessionClosed();
    this.deps.assertExecutionOwned?.();
    return references;
  }

  /**
   * A live in-process owner is strictly stronger than Core's restart-only
   * restore fallback. Passing both references is ambiguous and rejected by
   * the native runner; once live continuation wins, suppress the fallback.
   */
  private referencesFor(activation: ExecutionActivation | undefined): SessionReferences {
    const priorRef = activation?.continueReference ?? this.deps.continueReference;
    const restoreRef = priorRef === undefined ? activation?.restoreReference ?? this.deps.restoreReference : undefined;
    return { priorRef, restoreRef };
  }

  private assertTransportReference({ priorRef, restoreRef }: SessionReferences): void {
    const retained = this.deps.mcpLocalTransportReference;
    if (retained && priorRef !== retained && restoreRef !== retained) {
      throw new RemoteInstanceError("recovery_required", "The retained MCP transport does not belong to the chosen provider session.",
        { diagnostic: "mcp_transport_reference_mismatch" });
    }
  }

  /** A Codex thread from before the retained local transport must not be loaded while its MCP transport is refreshed. */
  private async assertLegacyCodexThread({ priorRef, restoreRef }: SessionReferences): Promise<void> {
    if (!this.legacyCodexTransport(priorRef || restoreRef)) return;
    const legacyReference = priorRef ?? restoreRef!;
    const unloaded = await this.deps.assertLegacyCodexThreadUnloaded?.(legacyReference).catch(() => false);
    if (!unloaded) throw new RemoteInstanceError("recovery_required", "The retained Codex thread cannot safely refresh its local MCP transport.",
      { diagnostic: "legacy_mcp_thread_loaded_or_unverified" });
  }

  private legacyCodexTransport(reference: string | undefined): boolean {
    return this.assignment.agentRoute.agentId === "codex" && Boolean(this.assignment.agentRoute.mcpCapabilityTokenRef) &&
      Boolean(reference) && !this.deps.mcpLocalTransport;
  }

  /** Durable reference and process ownership around the runner's session creation. */
  private sessionLifecycle(reserved: { ref?: string }): RunnerSessionLifecycle | undefined {
    if (!this.deps.reserveExecutionReference) return undefined;
    return {
      beforeCreate: async (ref: string) => {
        await this.deps.reserveExecutionReference!(ref);
        reserved.ref = ref;
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
      assertCurrent: () => this.assertLifecycleCurrent(),
    };
  }

  /**
   * The runner's recovery stop asserts this fence first. The fence is this
   * session's own recovery mark, not a stale owner, so answer with admission
   * ownership for that one settlement operation only.
   */
  private assertLifecycleCurrent(): void {
    if (this.recoverySettlementInProgress) return void this.assertRecoveryOwned();
    if (this.closed && !this.completedSettlementInProgress) {
      throw new RemoteInstanceError("recovery_required", "Session generation is fenced.", { diagnostic: "session_generation_fenced" });
    }
    this.deps.assertExecutionOwned?.();
  }

  private sessionRequest(cwd: string, mcpServers: SessionMcpServer[], { priorRef, restoreRef }: SessionReferences, browser: SessionBrowser | undefined): RunnerSessionInput {
    return {
      context: { instanceId: this.deps.instanceId, assignmentId: this.assignment.id, attempt: this.assignment.attempt, agentId: this.assignment.agentRoute.agentId },
      readinessDeadlineAt: new Date(Date.now() + Math.max(0, Date.parse(this.assignment.expiresAt) - this.deps.clock.coreNow())).toISOString(),
      cwd,
      mcpServers,
      ...(this.assignment.agentRoute.sessionConfig ? { sessionConfig: this.assignment.agentRoute.sessionConfig } : {}),
      ...(priorRef ? { acpSessionRef: priorRef } : {}),
      ...this.restoreOptions(restoreRef),
      ...this.titleOptions(),
      ...(browser ? { browser } : {}),
    };
  }

  /**
   * A conversation's context is Konteks's to restage; a direct session's is
   * only the agent's own transcript, so that one is loaded.
   */
  private restoreOptions(restoreRef: string | undefined): Partial<RunnerSessionInput> {
    if (!restoreRef) return {};
    const fresh = this.assignment.source.kind === "conversation" && this.assignment.agentRoute.agentId === "claude-code";
    return { restoreAcpSessionRef: restoreRef, ...(fresh ? { freshProviderSessionOnRestore: true } : {}) };
  }

  /** A person's direct session keeps the agent's own title behind "[konteks] "; engineering work is named from Core's label. */
  private titleOptions(): Partial<RunnerSessionInput> {
    if (isDirectAssignment(this.assignment)) return { agentTitled: true as const };
    return this.assignment.sessionLabel ? { sessionLabel: this.assignment.sessionLabel } : {};
  }

  /** The runner created the session: it must keep the reserved reference, and a session closed meanwhile is closed again. */
  private async adoptCreated(created: RunnerSessionCreated, reserving: boolean, reserved: { ref?: string }): Promise<void> {
    this.creationReturned = true;
    if (reserving && reserved.ref !== created.acpSessionRef) throw new RemoteInstanceError("recovery_required", "Runner did not preserve durable reference ownership.");
    this.acpSessionRef = created.acpSessionRef;
    this.deps.assertExecutionOwned?.();
    if (this.closed) {
      await this.abandonCreated(created.acpSessionRef);
      throw sessionClosed();
    }
  }

  /** Cancel and close a session this bootstrap created but cannot keep (unless recovery owns stopping it). */
  private async abandonCreated(ref: string): Promise<void> {
    if (this.recoveryStopping) return;
    await this.cancelAndClose(ref);
  }

  private async cancelAndClose(ref: string): Promise<void> {
    await this.deps.runner.cancel(ref).catch(() => undefined);
    this.deps.assertExecutionOwned?.();
    await this.deps.runner.closeSession(ref).catch(() => undefined);
    this.deps.assertExecutionOwned?.();
  }

  /** Core registers the created session as ready, for exactly the prepared binding and channel. */
  private async registerReadiness(created: RunnerSessionCreated): Promise<ReadyProjection> {
    try {
      const binding = this.preparedInputs!.binding;
      const ready = RemoteExecutionReadyResultSchema.parse(await this.bootstrapStage("readiness", () =>
        this.deps.registerReady(this.assignment, binding, created.acpSessionRef)));
      this.deps.assertExecutionOwned?.();
      if (!this.readyMatches(ready, binding, created.acpSessionRef)) {
        throw new RemoteInstanceError("workspace_binding_invalid", "Core readiness does not match the prepared local session.");
      }
      if (this.closed) throw sessionClosed();
      return { attempt: ready.attempt, recoveryEpoch: ready.recoveryEpoch, readyRevision: ready.readyRevision };
    } catch (error) {
      this.deps.assertExecutionOwned?.();
      await this.abandonCreated(created.acpSessionRef);
      throw error;
    }
  }

  private readyMatches(ready: RemoteExecutionReadyResult, binding: RemoteTransferBinding, acpSessionRef: string): boolean {
    return allEqual([
      [ready.workspaceId, binding.workspaceId], [ready.instanceId, binding.instanceId], [ready.sessionId, binding.sessionId],
      [ready.assignmentId, binding.assignmentId], [ready.attempt, binding.attempt], [ready.agentId, this.assignment.agentRoute.agentId],
      [ready.acpSessionRef, acpSessionRef], [ready.channelId, this.boundChannelId],
    ]);
  }

  /** Open the session channel and announce `session_ready`; a delivery resumes any durable output it left. */
  private async announceReady(created: RunnerSessionCreated, readyProjection: ReadyProjection): Promise<void> {
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
      if (!receivedDeliveryPrompt(pending)) continue;
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
      this.assertDeliveryLive();
      const authority = this.deliveryAuthority(requestId);
      try {
        await this.transferDeliveryOutput(requestId, authority, completion, resumeOnly);
        return;
      } catch (error) {
        this.deps.assertExecutionOwned?.();
        if (this.deps.clock.coreNow() >= this.liveUntil()) throw error;
        attempt += 1;
        this.logDeliveryRetry(error, attempt);
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(5_000, 250 * 2 ** Math.min(attempt, 5))));
      }
    }
  }

  private assertDeliveryLive(): void {
    this.deps.assertExecutionOwned?.();
    if (this.deps.clock.coreNow() >= this.liveUntil()) throw new RemoteInstanceError("execution_fenced", "Delivery output authority expired before acceptance.");
  }

  /** One attempt to hand the frozen output to Core, then complete the prompt it answers. */
  private async transferDeliveryOutput(requestId: string, authority: ReturnType<RelayedSession["deliveryAuthority"]>, completion: SessionToCoreMessage | undefined, resumeOnly: boolean): Promise<void> {
    const result = resumeOnly
      ? await this.preparedInputs!.resumeDeliveryOutput!(authority)
      : { receipt: await this.preparedInputs!.acceptDeliveryOutput!({ ...authority, completion: completion! }), completion: completion! };
    if (!result) return;
    this.deps.assertExecutionOwned?.();
    this.deliveryAcceptance = result.receipt;
    const parsed = promptCompletion(result.completion, requestId);
    const accepted = await this.completeReceived(requestId, "session/prompt", parsed);
    if (accepted && (parsed.result as { stopReason?: string }).stopReason === "end_turn") await this.close("completed");
  }

  /** Name the refusal: without it a Core 422 repeated 120+ times read as a transport stall. Codes and statuses only, never messages. */
  private logDeliveryRetry(error: unknown, attempt: number): void {
    if (attempt !== 1 && attempt % 12 !== 0) return;
    const status = httpStatus(error);
    this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, transferAttempt: attempt,
      ...errorCode(error, "delivery_output_transfer_failed"), ...(status === undefined ? {} : { status }) }, "durable delivery output retained for retry");
  }

  /** The assignment's lifetime, or the later one Core renewed a delivery turn to. */
  private liveUntil(): number {
    return this.executionGate?.liveUntil() ?? Date.parse(this.assignment.expiresAt);
  }

  private async sendToCore(message: SessionToCoreMessage): Promise<void> {
    const channelId = this.outboundChannel();
    if (channelId === null) return;
    // Canonicalize while the bridge's private metadata is still present. The
    // strict relay schema deliberately discards `_meta`; doing this after its
    // first parse would permanently lose Claude's safe Agent/ToolSearch name.
    const { canonicalMessage, canonicalIdentity } = this.canonicalized(message);
    const parsed = SessionToCoreMessageSchema.safeParse(canonicalMessage);
    if (!parsed.success) return this.rejectMalformed(message, canonicalMessage, canonicalIdentity, parsed.error.issues);
    const body = this.outboundBody(parsed.data, canonicalIdentity);
    if (body === null) return;
    const sourceSequence = await this.deps.beforeSendToCore?.(body);
    this.deps.assertExecutionOwned?.();
    this.deps.transport.send({ channel: "session", channelId, body, ...(sourceSequence === undefined ? {} : { sourceSequence }) });
  }

  /** The open session channel to send on; null while recovery stops the session or before the channel opened. */
  private outboundChannel(): string | null {
    if (this.recoveryStopping) return null;
    this.deps.assertExecutionOwned?.();
    const channelId = this.boundChannelId;
    return channelId === null || !this.channelOpened ? null : channelId;
  }

  private canonicalized(message: SessionToCoreMessage): { canonicalMessage: unknown; canonicalIdentity: CanonicalIdentity | undefined } {
    if (message.kind !== "acp" || message.method !== "session/update") return { canonicalMessage: message, canonicalIdentity: undefined };
    const rawUpdate = message.params.update as unknown as Record<string, unknown>;
    const toolCallId = typeof rawUpdate.toolCallId === "string" ? rawUpdate.toolCallId : undefined;
    const canonicalUpdate = canonicalizeAcpToolActivity(
      rawUpdate,
      this.assignment.agentRoute.agentId,
      toolCallId === undefined ? undefined : this.toolActivityIdentity.get(toolCallId),
    ) as Record<string, unknown>;
    return {
      canonicalMessage: { ...message, params: { ...message.params, update: omitPrivateAcpToolPayload(canonicalUpdate) } },
      canonicalIdentity: toolCallId === undefined ? undefined : toolIdentity(toolCallId, canonicalUpdate),
    };
  }

  /** A bridge payload that fails the vendored ACP schema is converted, never forwarded. */
  private async rejectMalformed(message: SessionToCoreMessage, canonicalMessage: unknown, canonicalIdentity: CanonicalIdentity | undefined, issues: Parameters<typeof contractIssue>[0]): Promise<void> {
    this.counters.malformedResponses += 1;
    this.logger.warn({
      event: "session.acp_message_rejected",
      assignmentId: this.assignment.id,
      acpSessionRef: this.acpSessionRef,
      toolCallId: canonicalIdentity?.toolCallId,
      stage: "wire_schema",
      ...sessionUpdateKind(canonicalMessage),
      ...contractIssue(issues),
    }, "Native session update did not match the relay contract");
    if ("id" in message && typeof message.id === "string" && "method" in message && message.kind !== "acp") {
      await this.sendToCore({ kind: "acp_error", id: message.id, method: message.method as "session/prompt", error: malformed() });
    }
  }

  /** The frame to send: a session update only for this session, without thought chunks, redacted; null to drop it. */
  private outboundBody(body: SessionToCoreMessage, canonicalIdentity: CanonicalIdentity | undefined): SessionToCoreMessage | null {
    if (body.kind !== "acp" || body.method !== "session/update") return body;
    if (body.params.sessionId !== this.acpSessionRef) {
      this.counters.malformedResponses += 1;
      return null;
    }
    if (body.params.update.sessionUpdate === "agent_thought_chunk") return null;
    if (canonicalIdentity) this.rememberToolIdentity(canonicalIdentity);
    return this.redactedUpdate(body, canonicalIdentity);
  }

  private rememberToolIdentity({ toolCallId, identity, terminal }: CanonicalIdentity): void {
    if (terminal) this.toolActivityIdentity.delete(toolCallId);
    else if (Object.keys(identity).length > 0) this.toolActivityIdentity.set(toolCallId, identity);
  }

  private redactedUpdate(body: SessionToCoreMessage, canonicalIdentity: CanonicalIdentity | undefined): SessionToCoreMessage | null {
    const update = (body as { params: { update: { sessionUpdate: string; content?: { type?: string; text?: unknown } } } }).params.update;
    const chunk = this.chunkContext(update);
    const safe = SessionToCoreMessageSchema.safeParse(redactSessionMessage(body, this.sessionCwd(), chunk));
    if (safe.success) return safe.data;
    this.counters.malformedResponses += 1;
    this.logger.warn({
      event: "session.acp_message_rejected",
      assignmentId: this.assignment.id,
      acpSessionRef: this.acpSessionRef,
      toolCallId: canonicalIdentity?.toolCallId,
      stage: "redacted_schema",
      sessionUpdate: update.sessionUpdate,
      ...contractIssue(safe.error.issues),
    }, "Redacted native session update did not match the relay contract");
    return null;
  }

  /**
   * Streamed text is split at arbitrary points; judge a chunk's first
   * character against the previous chunk of the same stream.
   */
  private chunkContext(update: { sessionUpdate: string; content?: { type?: string; text?: unknown } }): { startsAtBoundary: boolean; continuesPath: boolean } {
    const chunkText = streamedText(update);
    const previous = chunkText === undefined ? undefined : this.lastChunkText.get(update.sessionUpdate);
    const startsAtBoundary = continuesAtBoundary(previous?.text);
    const continuesPath = previous?.inPath ?? false;
    if (chunkText === undefined) this.lastChunkText.clear();
    else this.lastChunkText.set(update.sessionUpdate, { text: chunkText, inPath: endsInsidePath(chunkText, continuesPath, startsAtBoundary) });
    return { startsAtBoundary, continuesPath };
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
    const ref = this.openSessionRef();
    if (ref === null) return;
    this.deps.assertExecutionOwned?.();
    if (isNativeTurn(this.assignment)) {
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
    if (message.kind === "acp") return this.onHolderRequest(ref, message);
    return this.onIssuedCompletion(ref, message);
  }

  /** The session reference while the session is open with its channel, else null. */
  private openSessionRef(): string | null {
    if (this.closed || this.boundChannelId === null || !this.channelOpened) return null;
    return this.acpSessionRef;
  }

  private async onHolderRequest(ref: string, message: Extract<SessionToRuntimeMessage, { kind: "acp" }>): Promise<void> {
    if (message.params.sessionId !== ref) {
      if ("id" in message) await this.sendToCore({ kind: "acp_error", id: message.id, method: message.method, error: { code: -32602, class: "invalid_params", message: "request session does not match the channel", retryable: false } });
      return;
    }
    if (message.method === "session/cancel") {
      await this.deps.runner.cancel(ref).catch(() => undefined);
      return;
    }
    if (!HOLDER_REQUEST_METHODS.has(message.method)) return;
    const request = message as HolderRequest;
    // A terminal planning directive fences the input lane before this prompt
    // can create any durable request or outbound transcript fact. Keep the
    // later check as well to close a race while input preparation awaits I/O.
    if (request.method === "session/prompt") this.deps.assertPromptAllowed?.();
    if (!await this.journalReceived(ref, request)) return;
    await this.dispatchHolderRequest(ref, request);
  }

  /** Journal a holder's request; false for a duplicate id (answered with an error) or a session closed meanwhile. */
  private async journalReceived(ref: string, request: HolderRequest): Promise<boolean> {
    const existing = this.deps.journal.pendingRequests.get(`${ref}:received:${request.id}`);
    if (existing) {
      this.counters.unknownCompletions += 1;
      await this.sendToCore({ kind: "acp_error", id: request.id, method: request.method as "session/prompt", error: { code: -32600, class: "unknown_request", message: "duplicate request id", retryable: false } });
      return false;
    }
    await this.deps.journal.pendingRequests.put({ acpSessionRef: ref, id: request.id, method: request.method as "session/prompt", direction: "received", openedAt: this.deps.clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
    if (this.closed) return false;
    this.deps.assertExecutionOwned?.();
    return true;
  }

  private async dispatchHolderRequest(ref: string, request: HolderRequest): Promise<void> {
    try {
      if (request.method === "session/prompt") await this.promptFromHolder(ref, request);
      else if (request.method === "session/set_mode") await this.deps.runner.setMode(ref, request.id, request.params);
      else await this.deps.runner.setConfigOption(ref, request.id, request.params);
    } catch (error) {
      await this.completeReceived(request.id, request.method as "session/prompt", { kind: "acp_error", id: request.id, method: request.method as "session/prompt", error: classify(error) });
    }
  }

  private async promptFromHolder(ref: string, request: HolderRequest): Promise<void> {
    this.deps.assertPromptAllowed?.();
    if (this.preparedInputs) await this.runBeforePrompt();
    if (this.closed) throw sessionClosed();
    this.deps.assertExecutionOwned?.();
    this.deps.assertPromptAllowed?.();
    if (this.previewSessionId !== null) this.deps.preview?.touch(this.previewSessionId);
    await this.promptRunner(ref, request.id, this.withInstructions(request.params as PromptParams));
  }

  private async runBeforePrompt(): Promise<void> {
    try { await this.preparedInputs?.beforePrompt(); }
    catch { throw new RemoteInstanceError("capability_unavailable", "Required local session inputs are unavailable."); }
  }

  /** The staged skills line goes in front of the person's text. */
  private withInstructions<P extends PromptParams>(params: P): P {
    const instructions = this.promptInstructions();
    return instructions ? { ...params, prompt: [{ type: "text" as const, text: instructions }, ...params.prompt] } : params;
  }

  private async promptRunner(ref: string, requestId: string, params: PromptParams): Promise<void> {
    const prompt = await this.prepareAgentPrompt(requestId, params.prompt);
    try { await this.deps.runner.prompt(ref, requestId, { ...params, prompt }); }
    catch (error) { this.endStructuredTurn(requestId); throw error; }
    this.deps.onTurnActivity?.();
  }

  /** Completions of OUR issued requests (permission / elicitation answers). */
  private async onIssuedCompletion(ref: string, message: Exclude<SessionToRuntimeMessage, { kind: "acp" }>): Promise<void> {
    const journaled = this.deps.journal.pendingRequests.get(`${ref}:issued:${message.id}`);
    if (!journaled || journaled.closedAt !== null || journaled.method !== message.method) {
      this.counters.unknownCompletions += 1;
      this.logger.warn({ id: message.id }, "rejected a completion for an unknown, closed, or mismatched request");
      return;
    }
    const verdict = this.deps.broker.answer(ref, message.id, issuedAnswer(message, journaled.method));
    if (!verdict.ok) {
      this.logger.warn({ id: message.id, reason: verdict.reason }, "answer rejected");
      return;
    }
    await this.deps.journal.pendingRequests.put({ ...journaled, closedAt: this.deps.clock.nowIso() });
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    await this.deps.runner.answer(ref, message.id, issuedAnswer(message, journaled.method));
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
    if (isPromptMessage(message)) {
      // Check and reserve with no await between them: exactly one prompt may
      // be admitted or running on this ACP session at a time.
      if (this.promptBusy(operation.key)) return this.refuseConcurrentPrompt(gate, operation.key, message.id);
      this.promptReservation = operation.key;
    }
    const begun = await this.beginAuthorized(gate, operation, assertDeliveryCurrent);
    if (!begun.started) return;
    // Do not convert a bridge transport exception into proof of completion.
    return this.dispatchAuthorized({ gate, operation, ref }, begun.params);
  }

  /** Prepare a prompt's inputs and start the operation; a proven pre-dispatch refusal becomes a replayable rejection. */
  private async beginAuthorized(gate: NativeExecutionGate, operation: AuthorizedOperation, assertDeliveryCurrent: () => void): Promise<{ started: boolean; params: unknown }> {
    const message = operation.envelope.message;
    let params: unknown = message.kind === "acp" ? message.params : null;
    try {
      if (isPromptMessage(message)) params = await this.authorizedPromptParams(message.params);
      if (this.closed) throw new RemoteInstanceError("execution_fenced", "The execution session is closed.");
      if (!(await gate.begin(operation))) return { started: false, params };
      assertDeliveryCurrent();
      return { started: true, params };
    } catch (error) {
      await this.refuseBeforeDispatch(gate, operation, error);
      return { started: false, params };
    }
  }

  private async authorizedPromptParams(params: PromptParams): Promise<PromptParams> {
    this.deps.assertPromptAllowed?.();
    await this.runBeforePrompt();
    this.deps.assertPromptAllowed?.();
    return this.withInstructions(params);
  }

  /**
   * Only a proven pre-dispatch refusal can become a replayable rejection. A
   * started operation remains unresolved for explicit recovery.
   */
  private async refuseBeforeDispatch(gate: NativeExecutionGate, operation: AuthorizedOperation, error: unknown): Promise<void> {
    const state = this.deps.journal.pendingRequests.get(operation.key)?.authorization?.state;
    if (state !== "admitted" && state !== "denied") throw error;
    const message = operation.envelope.message;
    const completion = deniedCompletion(message, error);
    await gate.denyBeforeDispatch(operation.key, completion);
    await this.reportDenied(completion, this.terminalTurnFailure(message, completion));
  }

  private terminalTurnFailure(message: AuthorizedMessage, completion: SessionToCoreMessage | undefined): boolean {
    return isNativeTurn(this.assignment) && isPromptMessage(message) && completion?.kind === "acp_error";
  }

  private async reportDenied(completion: SessionToCoreMessage | undefined, terminalTurnFailure: boolean): Promise<void> {
    try {
      if (completion && !this.closed) await this.sendToCore(completion);
    } finally {
      // No runner prompt exists to produce a later terminal event. Close the
      // failed turn locally so its durable assignment report and capacity
      // release do not depend on a best-effort cloud cancellation round trip.
      if (terminalTurnFailure && !this.closed) await this.close("agent_exited");
    }
  }

  private async dispatchAuthorized(context: { gate: NativeExecutionGate; operation: AuthorizedOperation; ref: string }, params: unknown): Promise<void> {
    const message = context.operation.envelope.message;
    if (message.kind !== "acp") return this.answerAuthorized(context, message);
    if (message.method === "session/prompt") return this.promptAuthorized(context, message.id, params as PromptParams);
    if (message.method === "session/set_mode") return void await this.deps.runner.setMode(context.ref, message.id, params);
    if (message.method === "session/set_config_option") return void await this.deps.runner.setConfigOption(context.ref, message.id, params);
    return this.cancelAuthorized(context);
  }

  private async promptAuthorized({ gate, operation, ref }: { gate: NativeExecutionGate; operation: AuthorizedOperation; ref: string }, id: string, params: PromptParams): Promise<void> {
    try {
      const prompt = await this.prepareAgentPrompt(id, params.prompt);
      await this.deps.runner.prompt(ref, id, { ...params, prompt });
      this.deps.onTurnActivity?.();
    } catch (error) {
      this.endStructuredTurn(id);
      // The runner's backstop: it refused because a prompt already runs
      // on this session. Nothing reached the agent, so this is a known
      // denial and the running turn is left alone.
      if (!(error instanceof RemoteInstanceError) || error.code !== "operation_conflict") throw error;
      const completion = concurrentPromptError(id);
      await gate.refuseAtDispatch(operation.key, completion);
      this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage: "prompt_dispatch",
        outcome: "denied_concurrent_prompt", source: "runner" }, "runner refused a second prompt on a busy session");
      if (!this.closed) await this.sendToCore(completion);
    }
  }

  /**
   * Harness owns whether its delivery invocation can proceed. An exact
   * Core-permitted cancellation (including before the first prompt) closes
   * this assignment through the normal local terminal-report path so a stale
   * claim cannot consume native runtime capacity.
   */
  private async cancelAuthorized({ gate, operation, ref }: { gate: NativeExecutionGate; operation: AuthorizedOperation; ref: string }): Promise<void> {
    if (this.assignment.source.kind === "harness_delivery") {
      await gate.complete(operation.key);
      await this.close("cancelled");
      return;
    }
    await this.deps.runner.cancel(ref);
    await gate.complete(operation.key);
  }

  private async answerAuthorized({ gate, operation, ref }: { gate: NativeExecutionGate; operation: AuthorizedOperation; ref: string }, message: Exclude<AuthorizedMessage, { kind: "acp" }>): Promise<void> {
    const answer = issuedAnswer(message, message.method);
    const verdict = this.deps.broker.answer(ref, message.id, answer);
    if (!verdict.ok) throw new RemoteInstanceError("operation_conflict", "The pending human answer is no longer admissible.");
    this.notePermissionAnswer(message.id, answer);
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
    await this.closeReceived(`${ref}:received:${id}`, journaled, completion);
    this.deps.assertExecutionOwned?.();
    await this.sendToCore(completion);
    return true;
  }

  /** An authorized operation completes through its gate; any other request just closes. */
  private async closeReceived(key: string, journaled: PendingRequest, completion: SessionToCoreMessage): Promise<void> {
    if (journaled.authorization && this.executionGate) await this.executionGate.complete(key, completion);
    else await this.deps.journal.pendingRequests.put({ ...journaled, closedAt: this.deps.clock.nowIso() });
  }

  /** Runner events for this session. */
  onRunnerEvent(event: RunnerEvent): Promise<void> { return this.track(() => this.onRunnerEventImpl(event)); }

  private async onRunnerEventImpl(event: RunnerEvent): Promise<void> {
    if (this.closed || this.acpSessionRef === null || !("acpSessionRef" in event) || event.acpSessionRef !== this.acpSessionRef) return;
    this.deps.assertExecutionOwned?.();
    await this.runnerEventHandlers.get(event.kind)?.(event);
  }

  /** What each runner event does to this session; other events are ignored. */
  private readonly runnerEventHandlers: ReadonlyMap<string, (event: RunnerEvent) => Promise<void>> = new Map<string, (event: RunnerEvent) => Promise<void>>([
    ["session_update", event => this.onSessionUpdate(event as RunnerEventOf<"session_update">)],
    ["prompt_result", event => this.onPromptCompletion(event as RunnerEventOf<"prompt_result">)],
    ["set_mode_result", async event => {
      const { requestId, result } = event as RunnerEventOf<"set_mode_result">;
      await this.completeReceived(requestId, "session/set_mode", { kind: "acp_result", id: requestId, method: "session/set_mode", result: result as never });
    }],
    ["set_config_option_result", async event => {
      const { requestId, result } = event as RunnerEventOf<"set_config_option_result">;
      await this.completeReceived(requestId, "session/set_config_option", { kind: "acp_result", id: requestId, method: "session/set_config_option", result: result as never });
    }],
    ["request_error", event => this.onRequestError(event as RunnerEventOf<"request_error">)],
    ["usage_observation", async event => {
      const { observation } = event as RunnerEventOf<"usage_observation">;
      this.lastPromptCompletion = { usage: observation };
      await this.deps.onUsage(observation);
    }],
    ["permission_request", async event => {
      const { requestId, params } = event as RunnerEventOf<"permission_request">;
      await this.onPermissionRequest(requestId, params as RequestPermissionRequest);
    }],
    ["elicitation_request", async event => {
      const { requestId, params } = event as RunnerEventOf<"elicitation_request">;
      await this.onElicitationRequest(requestId, params as CreateElicitationRequest);
    }],
    ["elicitation_complete", async event => {
      await this.sendToCore({ kind: "acp", method: "elicitation/complete", params: (event as RunnerEventOf<"elicitation_complete">).params as never });
    }],
    ["session_exited", async event => {
      await this.close((event as RunnerEventOf<"session_exited">).reason === "agent_exited" ? "agent_exited" : "completed");
    }],
  ]);

  private async onSessionUpdate(event: RunnerEventOf<"session_update">): Promise<void> {
    const update = (event.params as { update?: unknown } | null)?.update;
    // A working agent keeps its preview from stopping as idle.
    if (this.previewSessionId !== null) this.deps.preview?.touch(this.previewSessionId);
    this.observeStructuredText(update);
    this.mcpCalls?.observe(update);
    const bypass = this.toolGovernance?.observe(update, this.sessionCwd()) ?? null;
    await this.sendToCore({ kind: "acp", method: "session/update", params: event.params as never });
    if (bypass) await this.onToolGovernanceBypass(bypass);
  }

  private async onPromptCompletion(event: RunnerEventOf<"prompt_result">): Promise<void> {
    const settled = await this.settleStructuredTurn(event.requestId, event.result as Record<string, unknown>);
    if (settled === null) return;
    await this.onPromptResult(settled.requestId, settled.result);
  }

  private async onRequestError(event: RunnerEventOf<"request_error">): Promise<void> {
    if (event.method === "session/prompt" && await this.settledPromptError(event.requestId)) return;
    const accepted = await this.completeReceived(event.requestId, event.method, { kind: "acp_error", id: event.requestId, method: event.method, error: { code: event.code, class: event.class, message: event.message, retryable: event.retryable } });
    if (accepted && event.method === "session/prompt" && isNativeTurn(this.assignment)) {
      // Say why before the close: its SIGTERM on the bridge was the only
      // trace of a Codex sign-in that could not refresh.
      this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, code: event.code, errorClass: event.class, retryable: event.retryable },
        "native turn failed with a request error; closing the assignment as an agent exit");
      await this.close("agent_exited");
    }
  }

  /** A failed prompt that a structured follow-up settles (or that is its follow-up still running); false for an ordinary failure. */
  private async settledPromptError(requestId: string): Promise<boolean> {
    const settled = await this.settleStructuredTurnError(requestId);
    if (settled === null) return true;
    if (settled !== undefined) {
      await this.onPromptResult(settled.requestId, settled.result);
      return true;
    }
    this.deps.onTurnActivity?.();
    return false;
  }

  /** A prompt's completion (with any structured result already attached) goes to its holder. */
  private async onPromptResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    this.deps.onTurnActivity?.();
    if (this.assignment.kind === "delivery" && this.assignment.source.kind === "harness_delivery") return this.deliverPromptResult(requestId, result);
    const accepted = await this.completeReceived(requestId, "session/prompt", { kind: "acp_result", id: requestId, method: "session/prompt", result: result as never });
    if (accepted && isNativeTurn(this.assignment)) await this.closeEndedTurn((result as { stopReason?: string })?.stopReason);
  }

  private async deliverPromptResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    if (!this.preparedInputs?.acceptDeliveryOutput) {
      throw new RemoteInstanceError("capability_unavailable", "Generated delivery output cannot be accepted without current delivery authority.");
    }
    await this.completeDeliveryOutput(requestId, { kind: "acp_result", id: requestId, method: "session/prompt", result: result as never });
  }

  /**
   * Assistant admission creates one assignment per turn. A persistent native
   * Codex thread does not exit when its turn ends, so waiting for
   * session_exited leaks a claimed assignment and blocks the next turn. Close
   * this assignment, not the shared native server or its history.
   */
  private async closeEndedTurn(stopReason: string | undefined): Promise<void> {
    if (stopReason === "end_turn") return this.close("completed");
    if (typeof stopReason !== "string" || this.closed) return;
    // A turn that ends any other way has still ENDED: a rejected tool
    // interrupts Claude Code's turn as `cancelled`, a refusal or token cap
    // ends it likewise. Left open, the claimed assignment kept heartbeating
    // until the harness deadline. Close it so a terminal reaches Core now.
    this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stopReason },
      "native turn ended without end_turn; closing the assignment as an agent exit");
    await this.close("agent_exited");
  }

  /**
   * A prompt that ends with the structured-output contract: bind its schema
   * to the result tool and give the agent the tool line instead of the
   * contract. Any other prompt (or a second one while a structured turn still
   * runs, which the runner refuses anyway) passes unchanged. A schema the
   * tool cannot compile leaves the contract in place: the fenced answer still
   * works.
   */
  private async prepareStructuredPrompt<B extends PromptBlock>(requestId: string, prompt: B[]): Promise<B[]> {
    const tools = this.resultTools;
    if (!tools || this.structuredTurn !== null) return prompt;
    const contract = findStructuredContract(prompt);
    if (!contract) return prompt;
    let definition: Awaited<ReturnType<StructuredResultToolServer["bind"]>>;
    try { definition = await tools.bind(contract.schema); }
    catch {
      this.logger.warn({ event: "structured_result.schema_unusable", assignmentId: this.assignment.id, attempt: this.assignment.attempt },
        "turn result schema cannot be compiled; the agent answers with the fenced block");
      return prompt;
    }
    this.structuredTurn = { requestId, validate: compileTurnValidator(contract.schema), definition, text: "", followUp: null };
    const call = this.resultToolCall();
    const line = definition === "schema" ? resultToolLine(call) : resultToolLineWithSchema(contract.schema, toolInputSchema(contract.schema).wrapped, call);
    return rewriteStructuredPrompt(prompt, contract, line);
  }

  /**
   * The prompt the agent receives: the structured-result rewrite, and for an
   * OpenCode or Google Antigravity session's first prompt, the one line
   * saying how Konteks runs its tools (OpenCode's Code Mode,
   * opencode-code-mode.ts; Antigravity's `call_mcp_tool`, antigravity-prompt.ts).
   */
  private async prepareAgentPrompt<B extends PromptBlock>(requestId: string, prompt: B[]): Promise<B[]> {
    const prepared = await this.prepareStructuredPrompt(requestId, prompt);
    const agentId = this.assignment.agentRoute.agentId;
    // A direct session has no Konteks tools to tell its agent about.
    if ((agentId !== "opencode" && agentId !== "antigravity") || this.toolFormTold || isDirectAssignment(this.assignment)) return prepared;
    this.toolFormTold = true;
    const line = agentId === "opencode" ? openCodeKonteksToolsLine(this.sessionServers) : antigravityKonteksToolsLine(this.sessionServers);
    return [{ type: "text", text: line } as unknown as B, ...prepared];
  }

  /** How this session's agent is told to call the result tool; undefined for the plain tool name. */
  private resultToolCall(): string | undefined {
    const agentId = this.assignment.agentRoute.agentId;
    if (agentId === "antigravity") return antigravityResultToolReference;
    return agentId === "opencode" ? `\`${openCodeResultToolReference}\`` : undefined;
  }

  /** The turn never reached the agent (or was refused): forget it and put the tool back. */
  private endStructuredTurn(requestId: string): void {
    const turn = this.structuredTurn;
    if (!turn || (turn.requestId !== requestId && turn.followUp?.requestId !== requestId)) return;
    this.structuredTurn = null;
    this.resultTools?.unbind();
  }

  /** The agent's own message text during a structured turn, for the fenced fallback. */
  private observeStructuredText(update: unknown): void {
    const turn = this.structuredTurn;
    const text = turn ? agentMessageText(update) : undefined;
    if (!turn || text === undefined) return;
    if (turn.text.length < MAX_STRUCTURED_TURN_TEXT) turn.text += text;
  }

  /**
   * A prompt ended. For a structured turn: the tool's recorded value, else a
   * valid fenced result in the agent's text, else ONE follow-up prompt in
   * this same ACP session asking for the tool call (its completion settles
   * the original request). Returns the completion to report, or null while
   * the follow-up runs.
   */
  private async settleStructuredTurn(requestId: string, result: Record<string, unknown>): Promise<{ requestId: string; result: Record<string, unknown> } | null> {
    const turn = this.structuredTurn;
    if (!turn) return { requestId, result };
    if (turn.followUp && requestId === turn.followUp.requestId) return this.settleFollowUp(turn, turn.followUp, result);
    if (requestId !== turn.requestId) return { requestId, result };
    const found = this.structuredResult(turn);
    const ref = this.followUpRef(found, result);
    if (ref === null) return this.settleTurn(requestId, result, found);
    return this.askFollowUp(turn, ref, requestId, result);
  }

  private settleFollowUp(turn: StructuredTurnState, followUp: NonNullable<StructuredTurnState["followUp"]>, result: Record<string, unknown>): { requestId: string; result: Record<string, unknown> } {
    const original = followUp.original;
    const found = this.resultTools?.result() ?? parseFencedResult(turn.text, turn.validate);
    this.endStructuredTurn(followUp.requestId);
    this.logger.info({ event: "structured_result.settled", assignmentId: this.assignment.id, attempt: this.assignment.attempt, source: found ? "follow_up" : "none" }, "structured turn settled after its follow-up");
    const usage = sumPromptUsage(original.usage as Record<string, unknown> | null | undefined, result.usage as Record<string, unknown> | null | undefined);
    return { requestId: turn.requestId, result: { ...original, ...(usage ? { usage } : {}), ...(found ? { structuredOutput: { source: "follow_up", value: found.value } } : {}) } };
  }

  /** The tool's recorded value, else a valid fenced result in the agent's text. */
  private structuredResult(turn: StructuredTurnState): { source: "tool" | "fence"; value: unknown } | null {
    const recorded = this.resultTools?.result();
    if (recorded) return { source: "tool", value: recorded.value };
    const fenced = parseFencedResult(turn.text, turn.validate);
    return fenced ? { source: "fence", value: fenced.value } : null;
  }

  /** The session to ask the follow-up in: only when the turn ended normally without a result and the session is still open. */
  private followUpRef(found: unknown, result: Record<string, unknown>): string | null {
    if (found || result.stopReason !== "end_turn" || this.closed) return null;
    return this.acpSessionRef || null;
  }

  private settleTurn(requestId: string, result: Record<string, unknown>, found: { source: "tool" | "fence"; value: unknown } | null): { requestId: string; result: Record<string, unknown> } {
    this.endStructuredTurn(requestId);
    this.logger.info({ event: "structured_result.settled", assignmentId: this.assignment.id, attempt: this.assignment.attempt, source: found?.source ?? "none", stopReason: result.stopReason }, "structured turn settled");
    return { requestId, result: found ? { ...result, structuredOutput: found } : result };
  }

  /** Neither a valid call nor a valid fenced result: ask once, in the same session. */
  private async askFollowUp(turn: StructuredTurnState, ref: string, requestId: string, result: Record<string, unknown>): Promise<{ requestId: string; result: Record<string, unknown> } | null> {
    const followUpId = followUpRequestId(requestId);
    turn.followUp = { requestId: followUpId, original: result };
    turn.text = "";
    this.logger.info({ event: "structured_result.follow_up", assignmentId: this.assignment.id, attempt: this.assignment.attempt }, "structured turn ended without a result; asking once more");
    try {
      await this.deps.runner.prompt(ref, followUpId, { prompt: [{ type: "text", text: resultFollowUp(this.resultToolCall()) }] });
    } catch {
      this.endStructuredTurn(followUpId);
      return { requestId, result };
    }
    return null;
  }

  /**
   * A prompt failed. The follow-up failing settles the original request with
   * its own completion (undefined = not ours, null = nothing to report); the
   * original failing just ends the structured turn.
   */
  private async settleStructuredTurnError(requestId: string): Promise<{ requestId: string; result: Record<string, unknown> } | null | undefined> {
    const turn = this.structuredTurn;
    if (!turn) return undefined;
    if (turn.followUp && requestId === turn.followUp.requestId) {
      const original = turn.followUp.original;
      this.endStructuredTurn(requestId);
      this.logger.warn({ event: "structured_result.follow_up_failed", assignmentId: this.assignment.id, attempt: this.assignment.attempt }, "the structured follow-up prompt failed; reporting the turn without a result");
      return { requestId: turn.requestId, result: original };
    }
    if (requestId === turn.requestId) this.endStructuredTurn(requestId);
    return undefined;
  }

  /** Policy first; defer to a human via the relay when policy allows; fail closed at the deadline. */
  private async onPermissionRequest(requestId: string, params: RequestPermissionRequest): Promise<void> {
    const ref = this.acpSessionRef;
    if (ref === null) return;
    const request = this.toolGovernance ? await this.governPermission(ref, requestId, params, this.toolGovernance) : params;
    if (request === null) return;
    const decision = await this.deps.policy.evaluatePermission(request, this.permissionContext());
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    if (decision.kind === "allow") return void (await this.answerPermission(ref, requestId, selectedOption(decision.optionId)));
    this.logPolicyRefusal(request, decision);
    if (decision.kind === "deny") return this.denyByPolicy(ref, requestId, request, decision);
    return this.deferPermission(ref, requestId, request, decision);
  }

  /**
   * A host agent is never answered "always", by policy or by a person:
   * OpenCode would store it and stop asking; Antigravity would stop asking
   * for that command in this workspace. Its request is judged by the call it
   * names, or refused. Returns the request for policy to judge, or null once
   * it is answered here.
   */
  private async governPermission(ref: string, requestId: string, params: RequestPermissionRequest, governance: HostToolGovernance): Promise<RequestPermissionRequest | null> {
    const request = { ...params, options: params.options.filter(option => option.kind !== "allow_always") };
    this.governedPermissions.set(requestId, { toolCallId: request.toolCall.toolCallId, options: request.options });
    const verdict = governance.decide(request, { cwd: this.sessionCwd(), servers: this.sessionServers, browserTools: this.browserGateway !== null });
    if (verdict.kind === "evaluate") return verdict.request;
    if (this.closed) return null;
    this.deps.assertExecutionOwned?.();
    await this.answerGoverned(ref, requestId, request, verdict, governance);
    return null;
  }

  private async answerGoverned(ref: string, requestId: string, request: RequestPermissionRequest, verdict: Exclude<ReturnType<HostToolGovernance["decide"]>, { kind: "evaluate" }>, governance: HostToolGovernance): Promise<void> {
    const wanted = verdict.kind === "allow" ? "allow_once" : "reject_once";
    const optionId = request.options.find(option => option.kind === wanted)?.optionId;
    if (verdict.kind === "deny") {
      this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, toolCallId: request.toolCall.toolCallId, reason: verdict.reason.slice(0, 512) },
        `${governance.agentName} tool call refused by policy`);
    }
    await this.answerPermission(ref, requestId, optionId === undefined ? cancelledPermission() : selectedOption(optionId));
  }

  private permissionContext(): Parameters<PolicyResponder["evaluatePermission"]>[1] {
    return { assignmentId: this.assignment.id, agentId: this.assignment.agentRoute.agentId, workspaceRoot: this.policyRoot(),
      cwd: this.sessionCwd(), browserTools: this.browserGateway !== null, sessionServers: this.sessionServers, ...(this.mcpCalls ? { ledger: this.mcpCalls } : {}),
      admittedMcpTools: this.deps.admittedMcpTools?.(this.assignment) ?? [] };
  }

  /**
   * A refused tool ends the agent's turn on Claude Code and Codex; without a
   * log line a turn that stopped at a build command read as a hung agent, and
   * a refused "Edit files" call never said which path was wrong. Bounded,
   * sanitized title, and the refusal's reason with each refused path
   * workspace-relative (never a host path).
   */
  private logPolicyRefusal(request: RequestPermissionRequest, decision: Exclude<PolicyDecision, { kind: "allow" }>): void {
    this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, toolCallId: request.toolCall.toolCallId,
      title: sanitizePermissionRequest(request).params.title, decision: decision.kind,
      ...(decision.kind === "deny" && decision.refusal ? { refusal: decision.refusal } : {}),
      humanDeferralAllowed: this.assignment.policy.humanDeferralAllowed }, "tool permission not allowed by policy");
  }

  /**
   * The refused call carries the note before it is answered, so it reaches
   * Konteks inside this turn: the person sees why, and Harness repeats it to
   * the agent when it continues the stopped turn.
   */
  private async denyByPolicy(ref: string, requestId: string, request: RequestPermissionRequest, decision: Extract<PolicyDecision, { kind: "deny" }>): Promise<void> {
    if (decision.message && decision.refusal?.reason === "outside_workspace") {
      await this.noteRefusedToolCall(ref, request.toolCall.toolCallId, decision.message);
    }
    await this.answerPermission(ref, requestId, decision.optionId === null ? cancelledPermission() : selectedOption(decision.optionId));
  }

  /** Ask a person through Konteks, when the assignment allows it; an integration gate's question is answered once, never "always". */
  private async deferPermission(ref: string, requestId: string, request: RequestPermissionRequest, decision: Extract<PolicyDecision, { kind: "defer" }>): Promise<void> {
    if (!this.assignment.policy.humanDeferralAllowed) return void (await this.answerPermission(ref, requestId, cancelledPermission()));
    const asked = decision.allowOnceOnly ? { ...request, options: request.options.filter(option => option.kind !== "allow_always") } : request;
    const sanitized = sanitizePermissionRequest(asked);
    const pending = await this.deferToHuman(ref, requestId, "session/request_permission", sanitized);
    if (!pending) return void (await this.answerPermission(ref, requestId, cancelledPermission()));
    await this.sendToCore({ kind: "acp", method: "session/request_permission", id: requestId, params: { sessionId: ref, toolCall: { toolCallId: asked.toolCall.toolCallId, title: sanitized.params.title, ...(sanitized.params.toolKind ? { kind: sanitized.params.toolKind } : {}) }, options: sanitized.params.options } as never });
  }

  /** Put the policy's note on a refused tool call (an ACP `tool_call_update` carrying only content). */
  private async noteRefusedToolCall(ref: string, toolCallId: string, message: string): Promise<void> {
    // Like every update, it is redacted on the way out: the working copy's
    // path reads `[workspace]`.
    await this.sendToCore({ kind: "acp", method: "session/update", params: { sessionId: ref, update: {
      sessionUpdate: "tool_call_update", toolCallId, content: [{ type: "content", content: { type: "text", text: message } }],
    } } as never });
  }

  /** Answer a permission request, telling a host agent's governance what was decided (Antigravity pairs its own reports with it). */
  private async answerPermission(ref: string, requestId: string, response: { outcome: { outcome: string; optionId?: string } }): Promise<void> {
    this.notePermissionAnswer(requestId, response);
    await this.deps.runner.answer(ref, requestId, response);
  }

  private notePermissionAnswer(requestId: string, response: unknown): void {
    const governed = this.governedPermissions.get(requestId);
    if (!governed) return;
    this.governedPermissions.delete(requestId);
    const outcome = (response as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome;
    const option = outcome?.outcome === "selected" ? governed.options.find(candidate => candidate.optionId === outcome.optionId) : undefined;
    this.toolGovernance?.answered?.(governed.toolCallId, option?.kind === "allow_once");
  }

  /** The working copy the session's agent runs in. */
  /**
   * The folder the tool policy judges file changes against: the runner's
   * workspace, except for a direct session, whose agent may change files only
   * in its own private session folder, never another session's (runtime-view
   * R13). Kept to direct sessions: Konteks's own kinds are proven against the
   * workspace root today, and their tighter root is a change of its own.
   */
  private policyRoot(): string {
    return isDirectAssignment(this.assignment) ? this.sessionCwd() : this.deps.workspaceRoot;
  }

  /** What goes in front of the person's text: the staged skills line; nothing for a direct session, so a leading `/command` stays first (R11). */
  private promptInstructions(): string | undefined {
    return isDirectAssignment(this.assignment) ? undefined : this.preparedInputs?.skillInstructions || undefined;
  }

  private sessionCwd(): string {
    return this.preparedInputs?.cwd ?? `${this.deps.workspaceRoot}/${this.assignment.id}`;
  }

  /**
   * A host agent ran a gated tool without Konteks' approval (dsh's ask hook
   * did not run; OpenCode ran a call it never asked for, or a Code Mode call
   * nobody approved): stop the turn and take the agent out of service until
   * the connector restarts, so at most one call ever runs unjudged. The
   * other agents keep running.
   */
  private async onToolGovernanceBypass(bypass: HostToolBypass): Promise<void> {
    const governance = this.toolGovernance!;
    const ref = this.acpSessionRef;
    this.logger.error({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, toolCallId: bypass.toolCallId, tool: bypass.title.slice(0, 128), diagnostic: governance.bypassDiagnostic },
      `${governance.agentName} ran a gated tool without approval; stopping the turn and taking it out of service`);
    const message = await this.quarantineMessage(governance, bypass);
    if (ref !== null) await this.deps.runner.cancel(ref).catch(error => this.logger.warn({ err: error }, "cancel after a governance bypass failed"));
    await this.deps.runner.quarantine?.(message)
      .catch(error => this.logger.warn({ err: error }, "quarantine after a governance bypass failed"));
    await this.close("agent_exited");
  }

  /**
   * The line names what to fix: for Antigravity on Gemini Enterprise, a
   * command that never asked is the organisation's admin setting. The
   * connector lists the credential in use first.
   */
  private async quarantineMessage(governance: HostToolGovernance, bypass: HostToolBypass): Promise<string> {
    let credentialMethod: string | undefined;
    if (governance.quarantineMessageFor) {
      try { credentialMethod = (await this.deps.runner.readiness()).agent.credentials?.[0]?.method; }
      catch { credentialMethod = undefined; }
    }
    return governance.quarantineMessageFor?.(bypass, credentialMethod) ?? governance.quarantineMessage;
  }

  private async onElicitationRequest(requestId: string, params: CreateElicitationRequest): Promise<void> {
    const ref = this.acpSessionRef;
    if (ref === null) return;
    const sanitized = sanitizeElicitationRequest(params);
    const decision = await this.deps.policy.evaluateElicitation(params);
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    if (decision.kind === "decline" || sanitized.isSignIn || !this.assignment.policy.humanDeferralAllowed) return this.declineElicitation(ref, requestId, sanitized.isSignIn);
    const pending = await this.deferToHuman(ref, requestId, "elicitation/create", sanitized);
    if (!pending) return void (await this.deps.runner.answer(ref, requestId, { action: "decline" }));
    await this.sendToCore({ kind: "acp", method: "elicitation/create", id: requestId, params: { mode: "form", message: sanitized.params.message, requestedSchema: sanitized.params.requestedSchema } as never });
  }

  /** Sign-in elicitations are surfaced to the operator, never automated or remotely answered; a headless run fails closed. */
  private async declineElicitation(ref: string, requestId: string, signIn: boolean): Promise<void> {
    if (signIn) this.logger.warn({ assignmentId: this.assignment.id }, "agent asked for a sign-in; failing closed with agent_auth_required");
    await this.deps.runner.answer(ref, requestId, { action: "decline" });
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
    const registered = await this.registeredDeferral(args);
    if (registered === null) return null;
    const pending = this.deps.broker.defer(args, registered?.deadlineAt);
    await this.deps.journal.pendingRequests.put({ acpSessionRef: ref, id: requestId, method, direction: "issued", openedAt: pending.raisedAt, closedAt: null,
      deadlineAt: pending.deadlineAt, requestDigest: registered?.requestDigest ?? sanitized.requestDigest });
    return pending;
  }

  /**
   * Core's registration of a deferred request: undefined when this connector
   * registers nothing, null when Core never confirmed it (or the session
   * closed meanwhile). Core threads a request onto the assignment's own
   * session: the conversation, a native delivery's execution session, else
   * the assignment.
   */
  private async registeredDeferral(args: Omit<Parameters<typeof deferredPermissionBody>[0], "sessionId">): Promise<PendingPermissionView | null | undefined> {
    if (!this.deps.registerDeferral) return undefined;
    const source = this.assignment.source;
    const sessionId = continuedSession(source)?.sessionId
      ?? (source.kind === "harness_delivery" ? source.executionSessionId : this.assignment.id);
    const registered = await registerDeferral(this.deps.registerDeferral, deferredPermissionBody({ ...args, sessionId }), { logger: this.logger });
    if (!registered || this.closed) return null;
    this.deps.assertExecutionOwned?.();
    return registered;
  }

  /** Deadline reached with no authorized answer: fail closed. */
  onDeadline(request: PendingHumanRequest): Promise<void> { return this.track(() => this.onDeadlineImpl(request)); }

  private async onDeadlineImpl(request: PendingHumanRequest): Promise<void> {
    const ref = this.acpSessionRef;
    if (this.closed || ref === null || request.acpSessionRef !== ref) return;
    await this.closeIssued(ref, request.requestId);
    if (this.closed) return;
    this.deps.assertExecutionOwned?.();
    await this.deps.runner.answer(ref, request.requestId, cancelAnswer(request)).catch(() => undefined);
  }

  private async closeIssued(ref: string, requestId: string): Promise<void> {
    const journaled = this.deps.journal.pendingRequests.get(`${ref}:issued:${requestId}`);
    if (journaled && journaled.closedAt === null) await this.deps.journal.pendingRequests.put({ ...journaled, closedAt: this.deps.clock.nowIso() });
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
      if (this.acpSessionRef !== null) await this.cancelAndClose(this.acpSessionRef);
      // A post-ready journal failure must also close the advertised session.
      // No readiness announcement means there is no remote session to close.
      if (this.channelOpened) await this.sendToCore({ kind: "session_closed", assignmentId: this.assignment.id, reason: "agent_exited" });
    } finally {
      this.releaseUnlessRecovering();
    }
  }

  /** Recovery keeps the channel; any other end releases it. */
  private releaseUnlessRecovering(): void {
    if (this.recoveryStopping) return;
    this.deps.assertExecutionOwned?.();
    this.releaseChannel?.();
    this.releaseChannel = null;
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
    const settlement = { recorded: false };
    try {
      if (nativeCompletion && this.acpSessionRef === null) throw new RemoteInstanceError("recovery_required", "Native completed closure requires its exact session reference.");
      if (this.acpSessionRef !== null) await this.settleClosedRef(this.acpSessionRef, reason, settlement);
      await this.announceClosed(reason);
      // Native assignment closure is not logical-session channel retirement:
      // its final frame, replay buffer and sequence space stay for the next turn.
      if (!this.recoveryStopping) await this.deps.onClosed(this, reason);
      this.deps.assertExecutionOwned?.();
    } catch (error) {
      if (nativeCompletion) this.logUnconfirmedCompletion(settlement.recorded);
      throw error;
    } finally {
      await this.afterClose(reason, nativeCompletion);
    }
  }

  private logUnconfirmedCompletion(recorded: boolean): void {
    this.logger.warn({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, stage: "completed_turn_settlement", outcome: recorded ? "report_failed" : "unconfirmed", code: "recovery_required" }, "native completed closure remains unconfirmed");
  }

  /**
   * Defensive cancellation of this exact retained reference remains possible
   * after lease loss; it is not qualified stop or release. Pending human
   * requests are cancelled; a completed turn records its native settlement.
   */
  private async settleClosedRef(ref: string, reason: SessionClosedReason, settlement: { recorded: boolean }): Promise<void> {
    if (CANCELLING_CLOSE_REASONS.has(reason)) await this.deps.runner.cancel(ref).catch(() => undefined);
    this.deps.assertExecutionOwned?.();
    await this.cancelPendingHumanRequests(ref);
    this.deps.assertExecutionOwned?.();
    if (reason === "completed") await this.recordCompletedSettlement(ref, settlement);
    else await this.deps.runner.closeSession(ref).catch(() => undefined);
    this.deps.assertExecutionOwned?.();
  }

  private async cancelPendingHumanRequests(ref: string): Promise<void> {
    for (const pending of this.deps.broker.cancelSession(ref)) {
      this.deps.assertExecutionOwned?.();
      await this.deps.runner.answer(ref, pending.requestId, cancelAnswer(pending)).catch(() => undefined);
      this.deps.assertExecutionOwned?.();
    }
  }

  private async recordCompletedSettlement(ref: string, settlement: { recorded: boolean }): Promise<void> {
    const receipt = await this.deps.runner.closeSession(ref, { completed: true });
    if (!continuationReady(receipt) || !this.deps.recordCompletedSettlement) {
      throw new RemoteInstanceError("recovery_required", "Native completed-turn settlement is unavailable.");
    }
    this.deps.assertExecutionOwned?.();
    await this.deps.recordCompletedSettlement(ref);
    settlement.recorded = true;
    this.logger.info({ assignmentId: this.assignment.id, attempt: this.assignment.attempt, acpSessionRef: ref, stage: "completed_turn_settlement", outcome: "recorded" }, "native ACP settlement recorded; generation ownership retained");
  }

  /**
   * A broken transcript channel must not suppress the independent durable
   * terminal report. Ownership and native completion checks still apply.
   */
  private async announceClosed(reason: SessionClosedReason): Promise<void> {
    try {
      await this.sendToCore({ kind: "session_closed", assignmentId: this.assignment.id, reason });
    } catch (error) {
      this.deps.assertExecutionOwned?.();
      this.logger.warn({ event: "session.close.relay_unavailable", assignmentId: this.assignment.id,
        attempt: this.assignment.attempt, channelId: this.boundChannelId, reason,
        stage: "terminal_report", code: error instanceof RemoteInstanceError ? error.code : "transport_failed" },
        "session closure could not use relay; continuing durable terminal reporting");
    }
  }

  /**
   * The completed receipt is not qualified handoff: a completed turn keeps
   * its preview and the channel's retry owner even after its terminal report
   * has been persisted.
   */
  private async afterClose(reason: SessionClosedReason, nativeCompletion: boolean): Promise<void> {
    await this.closeMcpFacade();
    if (!nativeCompletion) this.stopPreview(reason);
    this.completedSettlementInProgress = false;
    if (!nativeCompletion) this.releaseUnlessRecovering();
  }

  private async closeMcpFacade(): Promise<void> {
    const facade = this.mcpFacade;
    this.mcpFacade = null;
    const tools = this.previewTools;
    this.previewTools = null;
    const resultTools = this.resultTools;
    this.resultTools = null;
    this.structuredTurn = null;
    const gateway = this.browserGateway;
    this.browserGateway = null;
    const outputDir = this.browserOutputDir;
    this.browserOutputDir = null;
    await Promise.all([facade?.close(), tools?.close(), resultTools?.close(), gateway?.close(),
      outputDir ? rm(outputDir, { recursive: true, force: true }).catch(() => undefined) : undefined]);
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
   * claim. Only then may the next turn take the channel, always
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

/** Close reasons that cancel the agent's running turn first. */
const CANCELLING_CLOSE_REASONS: ReadonlySet<string> = new Set(["relay_replay_gap", "lease_lost", "drain", "cancelled"]);

function cancelledPermission(): { outcome: { outcome: string; optionId?: string } } {
  return { outcome: { outcome: "cancelled" } };
}

function selectedOption(optionId: string): { outcome: { outcome: string; optionId?: string } } {
  return { outcome: { outcome: "selected", optionId } };
}

/** The fail-closed answer to a pending human request, in its own shape. */
function cancelAnswer(pending: { sanitized: { kind: string } }): unknown {
  return pending.sanitized.kind === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" };
}

function continuationReady(receipt: unknown): boolean {
  return Boolean(receipt) && typeof receipt === "object" && "completion" in (receipt as object) && (receipt as { completion?: unknown }).completion === "native_continuation_ready";
}

type RunnerEventOf<K extends RunnerEvent["kind"]> = Extract<RunnerEvent, { kind: K }>;

/** The text of an agent message chunk, if that is what the update is. */
function agentMessageText(update: unknown): string | undefined {
  if (update === null || typeof update !== "object") return undefined;
  const value = update as { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } };
  return value.sessionUpdate === "agent_message_chunk" && value.content?.type === "text" && typeof value.content.text === "string" ? value.content.text : undefined;
}

type AuthorizedOperation = Awaited<ReturnType<NativeExecutionGate["admit"]>>;
type AuthorizedMessage = AuthorizedOperation["envelope"]["message"];
type HolderRequest = Extract<SessionToRuntimeMessage, { kind: "acp"; id: string }>;
type PromptParams = { prompt: PromptBlock[] } & Record<string, unknown>;

function isPromptMessage(message: AuthorizedMessage): message is Extract<AuthorizedMessage, { kind: "acp"; method: "session/prompt" }> {
  return message.kind === "acp" && message.method === "session/prompt";
}

/** The answer an issued request gets: the person's result, else a cancellation in that request's own shape. */
function issuedAnswer(message: { kind: string; result?: unknown }, method: string): unknown {
  if (message.kind === "acp_result") return message.result;
  return method === "elicitation/create" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } };
}

function deniedCompletion(message: AuthorizedMessage, error: unknown): SessionToCoreMessage | undefined {
  if (message.kind !== "acp" || !("id" in message)) return undefined;
  return { kind: "acp_error", id: message.id, method: message.method, error: classify(error) } as SessionToCoreMessage;
}

type CanonicalIdentity = { toolCallId: string; identity: CanonicalAcpToolIdentity; terminal: boolean };
const TERMINAL_TOOL_STATUSES: ReadonlySet<unknown> = new Set(["completed", "failed", "cancelled"]);

/** The safe tool identity a canonical update carries, kept for its later sparse updates. */
function toolIdentity(toolCallId: string, update: Record<string, unknown>): CanonicalIdentity {
  const identity: CanonicalAcpToolIdentity = {
    ...(typeof update.name === "string" ? { name: update.name } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(typeof update.title === "string" ? { title: update.title } : {}),
  };
  return { toolCallId, identity, terminal: TERMINAL_TOOL_STATUSES.has(update.status) };
}

/** The text of an agent or user message chunk, if that is what the update is. */
function streamedText(update: { sessionUpdate: string; content?: { type?: string; text?: unknown } }): string | undefined {
  const message = update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk";
  return message && update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : undefined;
}

/** A received prompt that carries delivery authority (its output goes through the durable delivery path). */
function receivedDeliveryPrompt(pending: { direction: string; method: string; authorization?: { claims?: object } | undefined }): boolean {
  return pending.direction === "received" && pending.method === "session/prompt" && "deliveryIdentity" in (pending.authorization?.claims ?? {});
}

/** The durable completion must be this prompt's result. */
function promptCompletion(completion: unknown, requestId: string): Extract<SessionToCoreMessage, { kind: "acp_result" }> {
  const parsed = SessionToCoreMessageSchema.parse(completion);
  if (parsed.kind !== "acp_result" || parsed.method !== "session/prompt" || parsed.id !== requestId) throw new RemoteInstanceError("capability_unavailable", "Durable delivery output completion does not match its prompt.");
  return parsed;
}

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

/** An error's stable code (and diagnostic) for a log line, never its message. */
function errorCode(error: unknown, fallback: string): { code: string; diagnostic?: string } {
  if (!(error instanceof RemoteInstanceError)) return { code: fallback };
  return { code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}

type SessionMcpServer = { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };
type SessionBrowser = { proxyUrl: string; outputDir: string; browsersPath: string };
type SessionReferences = { priorRef: string | undefined; restoreRef: string | undefined };
type ExecutionActivation = Awaited<ReturnType<NonNullable<RelayedSessionDeps["activateExecution"]>>>;
type ReadyProjection = Pick<RemoteExecutionReadyResult, "attempt" | "recoveryEpoch" | "readyRevision">;

function sessionClosed(): RemoteInstanceError {
  return new RemoteInstanceError("assignment_conflict", "The assignment session is closed.");
}

/**
 * Why a bootstrap stage failed, without copying provider/Core error messages
 * into logs: the stable code and retryability, and for an unknown error its
 * class and, for an agent's JSON-RPC refusal, its numeric code.
 */
function stageFailure(error: unknown): Record<string, unknown> {
  if (error instanceof RemoteInstanceError) return { code: error.code, retryable: error.retryable, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
  const rpcCode = (error as { code?: unknown } | null)?.code;
  return { code: "unexpected_error", retryable: false, ...(error instanceof Error ? { errorName: error.name } : {}), ...(typeof rpcCode === "number" ? { rpcCode } : {}) };
}

/** A refused session update's kind for the log, only when it reads as an ACP update name. */
function sessionUpdateKind(message: unknown): { sessionUpdate?: string } {
  const kind = (message as { params?: { update?: { sessionUpdate?: unknown } } } | null)?.params?.update?.sessionUpdate;
  return typeof kind === "string" && /^[a-z_]{1,64}$/.test(kind) ? { sessionUpdate: kind } : {};
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
