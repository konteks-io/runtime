import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  PromptRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
  Usage,
} from "@agentclientprotocol/sdk";
import { AcpNativeObservationSchema, RemoteInstanceError, type AgentTurnUsageObservation, type Logger, type RetainedProcessOwner, createLogger } from "@konteks/remote-common";
import type { BridgeProcess } from "../bridge/process.js";
import { classifyBridgeError } from "../bridge/process.js";
import type { RunnerEventBus } from "../events.js";
import type { HostPromptPrelude, HostPromptSession, HostTurnError } from "../host/host-agent.js";
import { konteksCodingSessionTitle, konteksSessionMetadata, type KonteksSessionLabel } from "./title.js";
import type { MeasuredTurn } from "./usage-label.js";

/**
 * ACP sessions inside this runner. The supervisor creates them as a
 * consequence of claiming an assignment (D98): `session/new` or a proven
 * `load`/`resume`, with the redeemed platform MCP capability token composed
 * into `mcpServers` in memory. The runner keeps only an opaque `acpSessionRef`
 * per session; the bridge's own session id never leaves this process.
 */
export const SessionContextSchema = z
  .object({
    instanceId: z.string().min(1),
    assignmentId: z.string().min(1),
    attempt: z.number().int().positive(),
    agentId: z.string().min(1),
  })
  .strict();
export type SessionContext = z.infer<typeof SessionContextSchema>;

export interface CreateSessionArgs {
  context: SessionContext;
  /** Absolute outer readiness deadline supplied by the claim owner. */
  readinessDeadlineAt?: string;
  cwd: string;
  mcpServers: McpServer[];
  /** ACP session-config selections from the assignment (`agentRoute.sessionConfig`). */
  sessionConfig?: Record<string, string>;
  /** Opaque ref from a prior turn on this runtime; loaded/resumed only when the bridge proves it. */
  acpSessionRef?: string;
  /** Restart recovery whose durable context was staged outside the provider transcript. */
  freshProviderSessionOnRestore?: boolean;
  /** Display-only naming for the provider session list; never authority. */
  sessionLabel?: KonteksSessionLabel;
  /**
   * An integration task's own session (external-integration CP2): the one
   * personal MCP server (Codex) or the account connectors (Claude) this NEW
   * session admits, sent as `_meta.konteksIntegration` for the bridge patches.
   * Never carried into a continued or restored session.
   */
  integration?: IntegrationSessionAdmission;
  /** Native in-process owner; opaque connector ref, never the bridge session ID. */
  lifecycle?: {
    beforeCreate(opaqueRef: string): Promise<void>;
    recordProcessOwner(owner: RetainedProcessOwner): Promise<void>;
    replaceProcessOwner?(previous: RetainedProcessOwner, replacement: RetainedProcessOwner): Promise<void>;
    assertCurrent(): void;
  };
}

export interface IntegrationSessionAdmission {
  /** Personal (or E2E) MCP servers the Codex bridge leaves enabled for this thread; none otherwise. */
  admittedMcpServerNames: string[];
  /** Claude only: this session may load the account's claude.ai connectors (every call still meets the gate). */
  accountConnectors: boolean;
}

/** The `_meta` an integration session's `session/new` carries, versioned for the bridge patches. */
export function konteksIntegrationMeta(admission: IntegrationSessionAdmission) {
  return { konteksIntegration: { version: 1 as const, admittedMcpServerNames: [...admission.admittedMcpServerNames], accountConnectors: admission.accountConnectors } };
}

export interface CreatedSession {
  acpSessionRef: string;
  resumed: boolean;
  capabilities: { forkSession: boolean; sessionResume: boolean };
}

interface SessionRecord {
  readonly bridge: BridgeProcess;
  acpSessionRef: string;
  bridgeSessionId: string;
  context: SessionContext;
  pendingClientRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  activeTurns: number;
  operations: Set<Promise<void>>;
  operationFailed: boolean;
  completedTurn: boolean;
  continuationSealed: boolean;
  recoveryStopping: boolean;
  recoveryStop: Promise<void> | null;
  completedClose?: Promise<void>;
  assertCurrent?: () => void;
  /** Native turns started by a connector-sent prompt (bounded, oldest evicted). */
  connectorTurns?: Set<string>;
  /** The session's current `model` value, as the agent last reported it. */
  modelValue?: string;
  /** The session's cumulative cost in USD as the agent last reported it (`usage_update.cost`); unknown until reported or a new session. */
  sessionCostUsd?: number;
  /** `sessionCostUsd` when the running turn started; its cost is the difference (O7). */
  turnCostStartUsd?: number;
  /** The agent reported a cost since the last turn ended: without one, a turn's cost is unknown, never zero. */
  costReported?: boolean;
  /** The session's working copy, as the last create or continuation named it. */
  cwd: string;
  /** A failure the agent sent as its reply during the running turn (`agentErrorText`); reported instead of a result. */
  turnError?: HostTurnError;
}

/**
 * How a turn's usage is labelled (O7): a subscription turn, or a pay-per-use
 * turn naming the provider (and model) it reached. Null: not reported at all.
 */
export type TurnUsageLabel =
  | { moneyBasis: "unavailable_local_subscription" }
  | { moneyBasis: "pay_per_use"; provider: string; model?: string };

const MAX_CONNECTOR_TURNS = 256;
const REFUSED_MODEL_MESSAGE = "That model is not available to this agent here. OpenCode Zen's free models are switched off for this computer.";
type AcpNativeObservation = z.infer<typeof AcpNativeObservationSchema>;

export interface SessionManagerOptions {
  bridge: () => BridgeProcess | null;
  /** Native execution allocator; called only after the durable ref reservation. */
  createBridge?: (acpSessionRef: string, lifecycle?: CreateSessionArgs["lifecycle"], cwd?: string) => Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }>;
  /** Bootstrap-only allocator. The previous bridge is already confirmed stopped. */
  replaceBridge?: (acpSessionRef: string, previous: BridgeProcess, bootstrapAttempt: number, lifecycle?: CreateSessionArgs["lifecycle"], cwd?: string) => Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }>;
  /**
   * Before each prompt on a bridge: the agent's own preparation (OpenCode
   * re-checks, and on Windows refreshes, its working copy's instructions).
   * Returns nothing when there is none, so the prompt is sent at once.
   */
  beforePrompt?: (bridge: BridgeProcess) => Promise<void> | undefined;
  events: RunnerEventBus;
  /** Durable map acpSessionRef → bridge session id inside the credential volume (survives restart). */
  refStore: SessionRefStore;
  /** Per-operation deadline for ambiguous, state-changing ACP bootstrap RPCs. */
  bootstrapTimeoutMs?: number;
  bootstrapRetrySleep?: (delayMs: number) => Promise<void>;
  bootstrapRetryRandom?: () => number;
  now?: () => Date;
  logger?: Logger;
  /** Auth failures must invalidate a prior identity probe before new work is admitted. */
  onAuthRequired?: () => void;
  /** Required session selections applied to new, restored and live-continued
   * sessions before any caller selections (Codex: Konteks-governed approval
   * mode). Callers may repeat the same value, but refusedModes prevents them
   * from selecting a mode outside that boundary. */
  defaultSessionConfig?: Readonly<Record<string, string>>;
  /**
   * Session modes this agent must never enter (OpenCode's `plan`): refused on
   * `set_mode`, on `set_config_option` for `mode` and in an admitted session
   * configuration, and dropped from the configuration the agent reports.
   */
  refusedModes?: {
    readonly modeIds: readonly string[];
    /** When set, every mode outside it is refused too (Codex: only "Ask for approval", S0-3). */
    readonly allowedModeIds?: readonly string[];
    readonly message: string;
  };
  /** Slash commands this agent is never sent (Antigravity's `/plan`, `/logout`): such a prompt is refused before it reaches the agent. */
  refusedPromptCommands?: { readonly commands: readonly string[]; readonly message: string };
  /**
   * Whether a model value may be used (OpenCode: Zen's free models only when
   * switched on, O6). A session that would start on a model it may not use is
   * moved to the first one it may, before ready; asking for one is refused.
   */
  modelAllowed?: (value: string) => boolean;
  /** How each turn's usage is labelled from the session's model; absent: every turn is a subscription turn. */
  usageLabel?: (modelValue: string | undefined) => TurnUsageLabel | null;
  /** Extra `_meta` on every `session/new`, `session/load` and `session/resume` (Antigravity's tool filter). */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /** Checks what a new, loaded or resumed session reports before it reads ready; throws on drift. */
  verifySession?: (response: { configOptions?: unknown; modes?: unknown }) => void;
  /** Content put in front of a prompt (Antigravity: the working copy's AGENTS.md, A9). */
  promptPrelude?: (session: HostPromptSession) => Promise<HostPromptPrelude | null>;
  /** A reply text that is really the agent's failure report; never forwarded, reported as the turn's error. */
  agentErrorText?: (text: string) => HostTurnError | null;
  /**
   * A turn measured outside the agent (Antigravity's Gemini API key relay):
   * called as a turn starts on `bridge`; the returned function reads the turn
   * once it ended, or null when it must not be reported (an older Core).
   */
  measureTurn?: (bridge: BridgeProcess) => (() => MeasuredTurn | null) | null;
  /**
   * Every `available_commands_update` of a session (runtime-view R19): the
   * runtime keeps the latest per agent. The update is still forwarded on the
   * session stream unchanged.
   */
  onAvailableCommands?: (update: unknown) => void;
}

/** The current value of a session's `model` select, from any ACP configuration list. */
function currentModel(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((entry: unknown) => (entry as { id?: unknown })?.id === "model" && (entry as { type?: unknown }).type === "select") as { currentValue?: unknown } | undefined;
  return typeof option?.currentValue === "string" ? option.currentValue : undefined;
}

/** Every value of a session's `model` select, grouped or flat, in order. */
function modelValues(configOptions: unknown): string[] {
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.find((entry: unknown) => (entry as { id?: unknown })?.id === "model" && (entry as { type?: unknown }).type === "select") as { options?: unknown } | undefined;
  if (!Array.isArray(option?.options)) return [];
  return (option.options as unknown[]).flatMap(entry => {
    const group = entry as { options?: unknown; value?: unknown };
    const values = Array.isArray(group.options) ? group.options as Array<{ value?: unknown }> : [group];
    return values.map(value => value.value).filter((value): value is string => typeof value === "string");
  });
}

export interface SessionRefStore {
  get(acpSessionRef: string): Promise<string | null>;
  put(acpSessionRef: string, bridgeSessionId: string): Promise<void>;
}

/** A JSON-RPC "invalid params" refusal from the agent (ACP RequestError -32602). */
function isInvalidParams(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === -32602;
}

export class InMemorySessionRefStore implements SessionRefStore {
  private readonly map = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.map.get(ref) ?? null;
  }
  async put(ref: string, id: string): Promise<void> {
    this.map.set(ref, id);
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly byBridgeId = new Map<string, SessionRecord>();
  private readonly creatingRefs = new Set<string>();
  /** Known private bridge IDs with in-flight/uncertain load outcomes. Not an
   * OS stop proof; uncertainty is never cleared just because load rejected. */
  private readonly creatingBridgeIds = new Set<string>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly bootstrapTimeoutMs: number;
  private readonly bootstrapRetrySleep: (delayMs: number) => Promise<void>;
  private readonly bootstrapRetryRandom: () => number;

  constructor(private readonly options: SessionManagerOptions) {
    this.logger = options.logger ?? createLogger({ name: "runner-sessions" });
    this.now = options.now ?? (() => new Date());
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 10_000;
    this.bootstrapRetrySleep = options.bootstrapRetrySleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    this.bootstrapRetryRandom = options.bootstrapRetryRandom ?? Math.random;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  get activeTurns(): number {
    let turns = 0;
    for (const session of this.sessions.values()) turns += session.activeTurns;
    return turns;
  }

  /** Sessions still bound to exactly this process, fenced ones included. A
   * resident process is kept only when this reads zero. */
  sessionsBoundTo(bridge: BridgeProcess): number {
    let bound = 0;
    for (const record of this.sessions.values()) if (record.bridge === bridge) bound += 1;
    return bound;
  }

  private requireBridge(record?: SessionRecord): BridgeProcess {
    const bridge = record ? record.bridge : this.options.bridge();
    if (!bridge || bridge.exited) {
      throw new RemoteInstanceError("agent_unavailable", "bridge is not running", { recoveryActions: [{ kind: "run_doctor" }] });
    }
    return bridge;
  }

  /**
   * ACP session bootstrap calls mutate provider state. A timed-out response has
   * an ambiguous outcome, so it is never safe to repeat the call on the same
   * process. Mirror bb's ACP lifecycle: bound the request, stop that exact
   * bridge, and let the assignment-level retry create a fresh process.
   */
  private async boundedBootstrap<T>(
    stage: "session_new" | "session_resume" | "session_load" | "session_config",
    args: CreateSessionArgs,
    bridge: BridgeProcess,
    operation: Promise<T>,
    bootstrapAttempt: number,
  ): Promise<T> {
    const remainingMs = args.readinessDeadlineAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(args.readinessDeadlineAt) - this.now().getTime();
    if (Number.isNaN(remainingMs) || remainingMs <= 0) {
      throw new RemoteInstanceError("agent_unavailable", "The outer execution readiness deadline expired.", {
        retryable: true, recoveryActions: [{ kind: "retry" }], diagnostic: `acp_${stage}_deadline`,
      });
    }
    const timeoutMs = Math.max(1, Math.min(this.bootstrapTimeoutMs, remainingMs));
    const deadlineMarker = Symbol(stage);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(deadlineMarker), timeoutMs);
      timer.unref();
    });
    // The agent said it cannot go on without the person (a sign-in or licence
    // page it would open): stop waiting, stop that process, say why.
    const failureMarker = Symbol(`${stage}_failure`);
    let failureError: unknown;
    const failed = bridge.failure?.catch((error: unknown) => { failureError = error; throw failureMarker; });
    try {
      return await Promise.race([operation, deadline, ...(failed ? [failed] : [])]);
    } catch (error) {
      if (error === failureMarker) {
        await bridge.stop().catch((stopError: unknown) => this.logger.warn({ stage, err: classifyBridgeError(stopError).class }, "a bridge that needs the person could not be stopped"));
        throw failureError;
      }
      if (error !== deadlineMarker) throw error;

      let bridgeRecycled = false;
      try {
        await bridge.stop();
        bridgeRecycled = true;
      } catch (stopError) {
        this.logger.error({
          stage,
          assignmentId: args.context.assignmentId,
          attempt: args.context.attempt,
          agentId: args.context.agentId,
          timeoutMs,
          bootstrapAttempt,
          bridgeRecycled,
          retryable: true,
          err: classifyBridgeError(stopError).class,
        }, "ACP session bootstrap timed out and exact bridge recycling is unconfirmed");
        throw new RemoteInstanceError("recovery_required", "ACP session bootstrap timed out and the bridge stop could not be confirmed.", {
          recoveryActions: [{ kind: "retry" }, { kind: "run_doctor" }],
          retryable: true,
          cause: stopError,
          diagnostic: `acp_${stage}_deadline_stop_unconfirmed`,
        });
      }

      this.logger.warn({
        stage,
        assignmentId: args.context.assignmentId,
        attempt: args.context.attempt,
        agentId: args.context.agentId,
        timeoutMs,
        bootstrapAttempt,
        bridgeRecycled,
        retryable: true,
      }, "ACP session bootstrap timed out; exact bridge recycled for assignment retry");
      throw new RemoteInstanceError("agent_unavailable", "ACP session bootstrap timed out; retry the assignment on a fresh agent process.", {
        recoveryActions: [{ kind: "retry" }],
        retryable: true,
        diagnostic: `acp_${stage}_deadline`,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  capabilities(): { forkSession: boolean; sessionResume: boolean } {
    return capabilitiesOf(this.options.bridge());
  }

  /** `_meta` for `session/load` and `session/resume`: the agent's own (a persisted tool filter is overridden there). */
  private reopenMeta(): { _meta?: Record<string, unknown> } {
    return this.options.sessionMeta ? { _meta: { ...this.options.sessionMeta } } : {};
  }

  async create(args: CreateSessionArgs): Promise<CreatedSession> {
    this.assertFreshIntegration(args);
    args = this.withDefaultSessionConfig(args);
    const ref = args.acpSessionRef ?? `acp-${randomUUID()}`;
    return this.createOwned(args, ref, args.acpSessionRef);
  }

  /** Restore provider history after process/connector loss under a new local
   * execution reference. The source ref remains fenced to its old generation;
   * only its private provider-session mapping is read. */
  async restore(args: CreateSessionArgs, sourceRef: string): Promise<CreatedSession> {
    this.assertFreshIntegration({ ...args, restoreReference: sourceRef });
    args = this.withDefaultSessionConfig(args);
    return this.createOwned(args, `acp-${randomUUID()}`, sourceRef);
  }

  private async createOwned(args: CreateSessionArgs, ref: string, loadFromRef?: string): Promise<CreatedSession> {
    this.assertAdmittedModes(args.sessionConfig);
    if (this.sessions.has(ref) || this.creatingRefs.has(ref)) throw new RemoteInstanceError("recovery_required", "session reference already has a local owner");
    this.creatingRefs.add(ref);
    try {
      args.lifecycle?.assertCurrent();
      await args.lifecycle?.beforeCreate(ref);
      args.lifecycle?.assertCurrent();
      const initial = this.options.createBridge ? await this.options.createBridge(ref, args.lifecycle, args.cwd) : { bridge: this.requireBridge(), bootstrapAttempt: 1 };
      let bridge = initial.bridge;
      for (let bootstrapAttempt = initial.bootstrapAttempt; bootstrapAttempt <= 4; bootstrapAttempt += 1) {
        let reservedBridgeId: string | null = null;
        const reserveBridgeId = (bridgeId: string) => {
          if (this.byBridgeId.has(bridgeId) || this.creatingBridgeIds.has(bridgeId)) throw new RemoteInstanceError("recovery_required", "bridge session already has a live or uncertain local owner");
          this.creatingBridgeIds.add(bridgeId);
          reservedBridgeId = bridgeId;
        };
        try {
          args.lifecycle?.assertCurrent();
          const created = await this.createImpl(args, ref, reserveBridgeId, bridge, loadFromRef, bootstrapAttempt);
          if (reservedBridgeId !== null) this.creatingBridgeIds.delete(reservedBridgeId);
          return created;
        } catch (error) {
          const retryableDeadline = error instanceof RemoteInstanceError && error.retryable && error.diagnostic?.startsWith("acp_") === true && error.diagnostic.endsWith("_deadline");
          // A confirmed exact-process stop removes all uncertainty introduced
          // by this bootstrap attempt, including config-timeout indexes.
          if (retryableDeadline) {
            const record = this.sessions.get(ref);
            if (record?.bridge === bridge) {
              this.sessions.delete(ref);
              this.byBridgeId.delete(record.bridgeSessionId);
            }
            if (reservedBridgeId !== null) this.creatingBridgeIds.delete(reservedBridgeId);
          }
          if (!retryableDeadline || bootstrapAttempt === 4 || !this.options.replaceBridge) {
            if (retryableDeadline) this.logger.error({
              assignmentId: args.context.assignmentId,
              attempt: args.context.attempt,
              agentId: args.context.agentId,
              bootstrapAttempt,
              maxBootstrapAttempts: 4,
              exhausted: true,
            }, "ACP session bootstrap retry budget exhausted");
            throw error;
          }
          const remainingMs = args.readinessDeadlineAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(args.readinessDeadlineAt) - this.now().getTime();
          if (Number.isNaN(remainingMs) || remainingMs <= 0) throw error;
          const exponentialMs = 500 * (2 ** (bootstrapAttempt - 1));
          const delayMs = Math.min(remainingMs, 2_000, Math.max(1, Math.round(exponentialMs * (0.75 + (this.bootstrapRetryRandom() * 0.5)))));
          this.logger.warn({
            assignmentId: args.context.assignmentId,
            attempt: args.context.attempt,
            agentId: args.context.agentId,
            bootstrapAttempt,
            nextBootstrapAttempt: bootstrapAttempt + 1,
            maxBootstrapAttempts: 4,
            delayMs,
            recovery: "fresh_bridge",
          }, "retrying ACP session bootstrap with exponential backoff");
          await this.bootstrapRetrySleep(delayMs);
          args.lifecycle?.assertCurrent();
          const recoveredFromAttempt = bootstrapAttempt;
          const replacement = await this.options.replaceBridge(ref, bridge, bootstrapAttempt + 1, args.lifecycle, args.cwd);
          bridge = replacement.bridge;
          // Fresh-process initialization failures consume logical attempts too.
          // The loop increment below advances to the attempt returned here.
          bootstrapAttempt = replacement.bootstrapAttempt - 1;
          this.logger.info({
            assignmentId: args.context.assignmentId,
            attempt: args.context.attempt,
            agentId: args.context.agentId,
            bootstrapAttempt: replacement.bootstrapAttempt,
            recoveredFromAttempt,
            recovery: "fresh_bridge",
          }, "ACP session bootstrap acquired a fresh bridge");
        }
      }
      throw new RemoteInstanceError("agent_unavailable", "ACP session bootstrap retry budget exhausted.", { retryable: true });
    } finally {
      this.creatingRefs.delete(ref);
    }
  }

  private async createImpl(args: CreateSessionArgs, acpSessionRef: string, reserveBridgeId: (id: string) => void, bridge: BridgeProcess, loadFromRef: string | undefined, bootstrapAttempt: number): Promise<CreatedSession> {
    if (bridge.exited) throw new RemoteInstanceError("agent_unavailable", "Creating bridge has exited.");
    const caps = bridge.initializeResult.agentCapabilities;
    const capabilities = { forkSession: caps?.sessionCapabilities?.fork != null, sessionResume: caps?.loadSession === true || caps?.sessionCapabilities?.resume != null };
    let bridgeSessionId: string | null = null;
    let resumed = false;
    let bootstrapConfig: unknown;
    let newSession = false;
    // The Claude SDK persists its deferred-tool registry in the provider
    // transcript. Loading that transcript after a process restart can retain a
    // former assignment's smaller or expired MCP view even though ACP receives
    // the current mcpServers. Konteks already stages the durable conversation
    // and tool-call memory into every restarted native turn, so create a fresh
    // provider query for Claude: it preserves logical continuation without
    // replaying a large transcript or inheriting stale authority. Live,
    // same-process continuation still uses continueLive below.
    const loadProviderHistory = loadFromRef !== undefined && args.freshProviderSessionOnRestore !== true;
    if (loadProviderHistory) {
      const prior = await this.options.refStore.get(loadFromRef);
      args.lifecycle?.assertCurrent();
      if (bridge.exited) throw new RemoteInstanceError("agent_unavailable", "Creating bridge exited before session load.");
      if (prior === null || !capabilities.sessionResume) {
        throw new RemoteInstanceError("recovery_required", "agent_session_lost: prior session cannot be loaded on this runtime", {
          recoveryActions: [{ kind: "retry" }],
          diagnostic: "agent_session_lost",
        });
      }
      reserveBridgeId(prior);
      try {
        const agentCaps = bridge.initializeResult.agentCapabilities;
        if (agentCaps?.sessionCapabilities?.resume != null) {
          // Session identity is retained, assignment tool authority is not.
          // Send even an empty list rather than retaining prior MCP bindings.
          bootstrapConfig = (await this.boundedBootstrap("session_resume", args, bridge,
            bridge.connection.resumeSession({ sessionId: prior, cwd: args.cwd, mcpServers: args.mcpServers, ...this.reopenMeta() }), bootstrapAttempt) as { configOptions?: unknown; modes?: unknown } | null);
        } else {
          bootstrapConfig = (await this.boundedBootstrap("session_load", args, bridge,
            bridge.connection.loadSession({ sessionId: prior, cwd: args.cwd, mcpServers: args.mcpServers, ...this.reopenMeta() }), bootstrapAttempt) as { configOptions?: unknown; modes?: unknown } | null);
        }
        bridgeSessionId = prior;
        resumed = true;
      } catch (error) {
        if (error instanceof RemoteInstanceError && (error.retryable || error.code === "agent_auth_required")) throw error;
        this.logger.warn({ err: classifyBridgeError(error).class }, "session load failed; agent_session_lost");
        throw new RemoteInstanceError("recovery_required", "agent_session_lost: bridge refused to load the prior session", {
          recoveryActions: [{ kind: "retry" }],
          diagnostic: "agent_session_lost",
        });
      }
    }
    if (bridgeSessionId === null) {
      let created: { sessionId: string; configOptions?: unknown; modes?: unknown };
      try {
        created = await this.boundedBootstrap("session_new", args, bridge,
          bridge.connection.newSession({ cwd: args.cwd, mcpServers: args.mcpServers, _meta: { ...konteksSessionMetadata(konteksCodingSessionTitle(args.sessionLabel, acpSessionRef.slice(-8)), args.context.agentId), ...this.options.sessionMeta,
            ...(args.integration ? konteksIntegrationMeta(args.integration) : {}) } }), bootstrapAttempt);
      } catch (error) {
        if (error instanceof RemoteInstanceError && error.retryable) throw error;
        const classified = classifyBridgeError(error);
        if (classified.class === "agent_auth_required") this.options.onAuthRequired?.();
        throw new RemoteInstanceError(classified.class === "agent_auth_required" ? "agent_auth_required" : "agent_unavailable", classified.message, {
          recoveryActions: classified.class === "agent_auth_required" ? [{ kind: "login_agent", agentId: args.context.agentId }] : [{ kind: "run_doctor" }],
        });
      }
      bridgeSessionId = created.sessionId;
      reserveBridgeId(bridgeSessionId);
      bootstrapConfig = created;
      newSession = true;
    }
    const bootstrapResponse = (bootstrapConfig ?? {}) as { configOptions?: unknown; modes?: unknown };
    bootstrapConfig = bootstrapResponse.configOptions;
    if (this.sessions.has(acpSessionRef) || this.byBridgeId.has(bridgeSessionId)) throw new RemoteInstanceError("recovery_required", "bridge session already has a local owner");
    // Retain the actual live owner before any fallible persistence/continuation.
    const record: SessionRecord = { bridge, acpSessionRef, bridgeSessionId, context: args.context, cwd: args.cwd, pendingClientRequests: new Map(), activeTurns: 0, operations: new Set(), operationFailed: false, completedTurn: false, continuationSealed: false, recoveryStopping: false, recoveryStop: null, ...(args.lifecycle ? { assertCurrent: args.lifecycle.assertCurrent } : {}),
      ...(currentModel(bootstrapConfig) === undefined ? {} : { modelValue: currentModel(bootstrapConfig)! }),
      // A new session has spent nothing; a resumed one's total is unknown until the agent reports it.
      ...(newSession ? { sessionCostUsd: 0 } : {}) };
    this.sessions.set(acpSessionRef, record);
    this.byBridgeId.set(bridgeSessionId, record);
    this.requireBridge(record);
    args.lifecycle?.assertCurrent();
    await this.options.refStore.put(acpSessionRef, bridgeSessionId);
    this.requireBridge(record);
    args.lifecycle?.assertCurrent();
    // An agent that drifted from what Konteks governs (Antigravity: no model
    // choice, or a mode other than `default`) never reads ready.
    if (this.options.verifySession) {
      try { this.options.verifySession(bootstrapResponse); }
      catch (error) {
        record.recoveryStopping = true;
        record.operationFailed = true;
        throw error;
      }
    }
    // A resumed session can retain stale defaults too. Configuration is an
    // admitted requirement, never a best-effort hint. Do not publish ready
    // until the bridge explicitly echoes each selected value.
    const confirmed = new Map<string, string>();
    const sessionConfig = { ...(args.sessionConfig ?? {}) };
    // A session that would start on a model it may not use (OpenCode Zen's
    // free models switched off) is moved to the first one it may, as an
    // admitted requirement confirmed below; with none, it never becomes ready.
    if (this.options.modelAllowed && sessionConfig.model === undefined && record.modelValue !== undefined && !this.options.modelAllowed(record.modelValue)) {
      const allowed = modelValues(bootstrapConfig).find(value => this.options.modelAllowed!(value));
      if (allowed === undefined) {
        record.recoveryStopping = true;
        record.operationFailed = true;
        throw new RemoteInstanceError("agent_auth_required", "The agent has no model it may use here: sign it in, or switch on its free models.", { recoveryActions: [{ kind: "login_agent", agentId: args.context.agentId }] });
      }
      sessionConfig.model = allowed;
    }
    for (const [configId, value] of Object.entries(sessionConfig)) {
      this.requireBridge(record);
      args.lifecycle?.assertCurrent();
      try {
        const result = await this.boundedBootstrap("session_config", args, bridge,
          bridge.connection.setSessionConfigOption({ sessionId: bridgeSessionId, configId, value }), bootstrapAttempt);
        confirmed.set(configId, value);
        const reportedModel = currentModel(result.configOptions);
        if (reportedModel !== undefined) record.modelValue = reportedModel;
        // ACP returns the full configuration. Later selections must not reset
        // an earlier requirement (for example, changing effort resets model).
        for (const [selectedId, selectedValue] of confirmed) {
          const matches = result.configOptions.filter(option => option.id === selectedId);
          if (matches.length !== 1 || matches[0]?.type !== "select" || matches[0].currentValue !== selectedValue) {
            throw new Error("session configuration acknowledgement mismatch");
          }
        }
      } catch (error) {
        if (error instanceof RemoteInstanceError && error.retryable) throw error;
        // Retain ownership for recovery: an RPC failure does not prove the
        // remote change did not happen, nor that this session has stopped.
        record.recoveryStopping = true;
        record.operationFailed = true;
        this.logger.warn({ assignmentId: args.context.assignmentId, attempt: args.context.attempt,
          code: "session_config_unconfirmed", resumed, err: classifyBridgeError(error).class },
        "admitted session configuration was not confirmed; session fenced");
        throw new RemoteInstanceError("agent_unavailable", "The agent did not confirm the admitted session configuration. Refresh its model capabilities and retry with an available selection.", {
          recoveryActions: [{ kind: "run_doctor" }],
        });
      }
      this.requireBridge(record);
      args.lifecycle?.assertCurrent();
    }
    return { acpSessionRef, resumed, capabilities };
  }

  close(acpSessionRef: string): void {
    const record = this.sessions.get(acpSessionRef);
    if (!record) return;
    if (record.recoveryStopping) return; // Settlement owner survives until qualified finalization.
    for (const pending of record.pendingClientRequests.values()) pending.reject(new Error("session closed"));
    this.sessions.delete(acpSessionRef);
    this.byBridgeId.delete(record.bridgeSessionId);
    this.options.events.publish({ kind: "session_exited", acpSessionRef, reason: "closed" });
  }

  /**
   * Release an idle sealed completion that no successor will continue, like
   * bb's releaseSession: no cancellation and no faked interruption of the
   * settled turn. Anything that is not an idle sealed owner is refused.
   */
  releaseSealed(acpSessionRef: string): void {
    const record = this.sessions.get(acpSessionRef);
    if (!record || !record.continuationSealed || record.recoveryStopping || record.operationFailed || record.activeTurns !== 0 ||
        record.operations.size !== 0 || record.pendingClientRequests.size !== 0) {
      throw new RemoteInstanceError("recovery_required", "Only an idle sealed session can be released.", { diagnostic: "release_not_idle_sealed" });
    }
    record.continuationSealed = false;
    this.sessions.delete(acpSessionRef);
    this.byBridgeId.delete(record.bridgeSessionId);
    this.options.events.publish({ kind: "session_exited", acpSessionRef, reason: "closed" });
  }

  /**
   * Seal a normal `end_turn` for same-process continuation. This is not crash
   * recovery or quiescence: the exact live ACP owner remains resident until a
   * later, durably fenced assignment adopts it or the session is explicitly
   * finalized.
   */
  async sealCompletedTurn(acpSessionRef: string): Promise<void> {
    const record = this.require(acpSessionRef);
    await Promise.all([...record.operations]);
    record.assertCurrent?.();
    this.requireBridge(record);
    if (!record.completedTurn || record.operationFailed || record.activeTurns !== 0 || record.operations.size !== 0 || record.pendingClientRequests.size !== 0) {
      throw new RemoteInstanceError("recovery_required", "Native turn has no continuation-safe ACP settlement.", { diagnostic: "continuation_settlement_missing" });
    }
    record.continuationSealed = true;
  }

  /** Atomically adopt the exact live session after the caller durably moves
   * its generation fence, then refresh ACP MCP/config authority before ready.
   */
  async continueLive(args: CreateSessionArgs): Promise<CreatedSession> {
    this.assertFreshIntegration(args);
    args = this.withDefaultSessionConfig(args);
    const ref = args.acpSessionRef;
    if (!ref) throw new RemoteInstanceError("recovery_required", "Live continuation requires its predecessor session reference.", { diagnostic: "continuation_reference_missing" });
    const record = this.sessions.get(ref);
    if (!record || !record.continuationSealed || record.recoveryStopping || record.operationFailed || record.activeTurns !== 0 || record.operations.size !== 0 || record.pendingClientRequests.size !== 0 ||
        record.context.instanceId !== args.context.instanceId || record.context.agentId !== args.context.agentId) {
      throw new RemoteInstanceError("recovery_required", "Live continuation predecessor is unavailable.", { diagnostic: "continuation_predecessor_unavailable" });
    }
    const bridge = this.requireBridge(record);
    // The predecessor's own fence is deliberately NOT asserted here: a sealed
    // completion belongs to a turn whose owner has closed and settled, so its
    // fence rejects by design (exactly as releaseSealed must not depend on
    // it). The successor's fence is installed and asserted below, and the
    // durable generation transfer in beforeCreate is what actually fences
    // the reference.
    this.assertAdmittedModes(args.sessionConfig);
    await args.lifecycle?.beforeCreate(ref);
    // beforeCreate fsyncs the generation transfer. Install the successor fence
    // synchronously before the first provider-facing continuation operation.
    record.context = args.context;
    record.cwd = args.cwd;
    if (args.lifecycle) record.assertCurrent = args.lifecycle.assertCurrent;
    else delete record.assertCurrent;
    record.completedTurn = false;
    record.continuationSealed = false;
    record.assertCurrent?.();
    try {
      const caps = bridge.initializeResult.agentCapabilities;
      let refreshed: { configOptions?: unknown; modes?: unknown } | null | undefined;
      if (caps?.sessionCapabilities?.resume != null) {
        const resume = () => bridge.connection.resumeSession({ sessionId: record.bridgeSessionId, cwd: args.cwd, mcpServers: args.mcpServers, ...this.reopenMeta() });
        try {
          refreshed = await resume();
        } catch (error) {
          // An agent that will not resume a session it still holds open
          // (DeepSeek Harness: "session is already active", -32602) is closed
          // and resumed from its own saved conversation: nothing is lost and
          // the new turn's tools still apply (WS1-168). Every second prompt
          // in a direct session failed before this.
          if (!(isInvalidParams(error) && caps.sessionCapabilities.close != null)) throw error;
          this.logger.info({ agentId: record.context.agentId }, "agent keeps its open session; closing and resuming it to continue");
          await bridge.connection.closeSession({ sessionId: record.bridgeSessionId });
          record.assertCurrent?.();
          refreshed = await resume();
        }
      } else if (caps?.loadSession === true) {
        refreshed = await bridge.connection.loadSession({ sessionId: record.bridgeSessionId, cwd: args.cwd, mcpServers: args.mcpServers, ...this.reopenMeta() });
      } else {
        throw new RemoteInstanceError("recovery_required", "Agent cannot refresh a live session's authority.", { diagnostic: "agent_cannot_refresh_authority" });
      }
      this.options.verifySession?.(refreshed ?? {});
      record.assertCurrent?.();
      for (const [configId, value] of Object.entries(args.sessionConfig ?? {})) {
        const result = await bridge.connection.setSessionConfigOption({ sessionId: record.bridgeSessionId, configId, value });
        const matches = result.configOptions.filter(option => option.id === configId);
        if (matches.length !== 1 || matches[0]?.type !== "select" || matches[0].currentValue !== value) throw new Error("session configuration acknowledgement mismatch");
        record.assertCurrent?.();
      }
      return { acpSessionRef: ref, resumed: true, capabilities: capabilitiesOf(bridge) };
    } catch (error) {
      record.operationFailed = true;
      record.recoveryStopping = true;
      throw error;
    }
  }

  /** Complete only our ACP turn, never cancel user work or certify host quiescence.
   * On uncertainty retain the fenced owner; durable generation release is separate.
   */
  async closeCompleted(acpSessionRef: string): Promise<void> {
    const retained = this.sessions.get(acpSessionRef);
    retained?.assertCurrent?.();
    if (retained?.completedClose) return retained.completedClose;
    const record = this.require(acpSessionRef);
    record.recoveryStopping = true;
    record.completedClose = this.settleCompleted(record);
    return record.completedClose;
  }

  private async settleCompleted(record: SessionRecord): Promise<void> {
    const bridge = this.requireBridge(record);
    let timer: NodeJS.Timeout | undefined;
    try {
      const completion = (async () => {
        await Promise.all([...record.operations]);
        const assertSettled = () => {
          record.assertCurrent?.();
          if (!record.completedTurn || record.operationFailed || record.activeTurns !== 0 || record.operations.size !== 0 || record.pendingClientRequests.size !== 0 || bridge.exited) {
            throw new RemoteInstanceError("recovery_required", "Native completed turn has no confirmed ACP settlement.");
          }
        };
        assertSettled();
        if (bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close != null) {
          await bridge.connection.closeSession({ sessionId: record.bridgeSessionId });
          assertSettled();
        }
      })();
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RemoteInstanceError("recovery_required", "Native completed-turn settlement deadline elapsed.")), 15_000);
        timer.unref();
      });
      await Promise.race([completion, deadline]);
      // Keep both owner indexes and the exact settled result for a failed
      // supervisor persistence retry. ACP completion is not finalization.
    } finally { if (timer) clearTimeout(timer); }
  }

  closeAll(reason: "agent_exited" | "closed", bridge?: BridgeProcess): void {
    for (const ref of [...this.sessions.keys()]) {
      const record = this.sessions.get(ref);
      if (!record || bridge && record.bridge !== bridge) continue;
      for (const pending of record.pendingClientRequests.values()) pending.reject(new Error(reason));
      if (record.recoveryStopping || this.creatingRefs.has(ref)) { record.operationFailed = true; continue; }
      this.sessions.delete(ref);
      this.byBridgeId.delete(record.bridgeSessionId);
      this.options.events.publish({ kind: "session_exited", acpSessionRef: ref, reason });
    }
  }

  private require(acpSessionRef: string): SessionRecord {
    const record = this.sessions.get(acpSessionRef);
    if (!record) throw new RemoteInstanceError("recovery_required", "unknown acpSessionRef");
    if (record.recoveryStopping) throw new RemoteInstanceError("recovery_required", "session is fenced for recovery");
    this.requireBridge(record);
    record.assertCurrent?.();
    return record;
  }

  private track(record: SessionRecord, operation: Promise<void>): void {
    record.operations.add(operation);
    // Rejections are retained as uncertainty, not hidden by the event publisher.
    void operation.then(() => record.operations.delete(operation), () => { record.operationFailed = true; record.operations.delete(operation); });
  }

  /** Settle only this session's tracked ACP operations and retain its owner.
   * This never proves background-tool quiescence or authorizes finalization.
   */
  async stopForRecovery(acpSessionRef: string): Promise<void> {
    const record = this.sessions.get(acpSessionRef);
    if (!record) throw new RemoteInstanceError("recovery_required", "unknown acpSessionRef cannot prove recovery stop");
    record.assertCurrent?.();
    // Reuse this exact owner's completed ACP outcome, including a retained
    // failure. Do not cancel the user's thread again after normal completion.
    // This remains ACP settlement only, never background-work quiescence.
    if (record.completedClose) return record.completedClose;
    if (record.recoveryStop) return record.recoveryStop;
    record.recoveryStopping = true;
    record.recoveryStop = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const completion = (async () => {
          const bridge = this.requireBridge(record);
          const outstanding = [...record.operations];
          for (const pending of record.pendingClientRequests.values()) pending.reject(new Error("session recovery stop"));
          record.pendingClientRequests.clear();
          await bridge.connection.cancel({ sessionId: record.bridgeSessionId });
          await Promise.all(outstanding);
          if (record.operationFailed || record.activeTurns !== 0 || record.operations.size !== 0 || bridge.exited) throw new RemoteInstanceError("recovery_required", "agent completion does not prove recovery stop");
          if (bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close != null) {
            // The pinned Codex bridge closes its ACP/thread subscription here.
            // Acceptance is not a background-work drain receipt. Retain this
            // fenced owner until independently qualified finalization.
            await bridge.connection.closeSession({ sessionId: record.bridgeSessionId });
            if (bridge.exited || record.operationFailed) throw new RemoteInstanceError("recovery_required", "bridge ownership was lost during session close");
          }
        })();
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RemoteInstanceError("recovery_required", "agent recovery stop deadline elapsed")), 15_000);
          timer.unref();
        });
        await Promise.race([completion, deadline]);
        // ACP settlement is stage one only. Keep the exact fenced owner so a
        // failed supervisor journal write can retry without reopening work.
      } finally { if (timer) clearTimeout(timer); }
    })();
    return record.recoveryStop;
  }

  /** Issues `session/prompt`; completion is published as prompt_result/request_error with the caller's request id. */
  prompt(acpSessionRef: string, requestId: string, params: Omit<PromptRequest, "sessionId">): void {
    const record = this.require(acpSessionRef);
    const bridge = this.requireBridge(record);
    // One ACP session runs one turn at a time. A second prompt would share the
    // agent's context with the first and one of them would end `interrupted`
    // with no one having asked for it. Refuse it before it reaches the bridge;
    // the supervisor settles it as a known pre-dispatch denial.
    if (record.activeTurns > 0) {
      throw new RemoteInstanceError("operation_conflict", "Another prompt is already running on this session.");
    }
    const command = this.refusedPromptCommand(params.prompt);
    if (command !== undefined) {
      this.logger.warn({ assignmentId: record.context.assignmentId, attempt: record.context.attempt, command }, "refused a prompt that starts with one of the agent's own commands");
      this.track(record, Promise.resolve().then(() => this.options.events.publish({
        kind: "request_error", acpSessionRef, requestId, method: "session/prompt", code: -32602, class: "invalid_params", message: this.options.refusedPromptCommands!.message, retryable: false,
      })));
      return;
    }
    record.completedTurn = false;
    record.activeTurns += 1;
    // The last turn's end is this turn's start, so a cost the agent reports
    // after a turn's response is counted with the next turn, never lost.
    if (record.turnCostStartUsd === undefined && record.sessionCostUsd !== undefined) record.turnCostStartUsd = record.sessionCostUsd;
    delete record.turnError;
    // Tokens counted outside the agent (a relay): the span starts now.
    const measured = this.options.measureTurn?.(bridge) ?? null;
    const publishMeasured = () => {
      const turn = measured?.();
      if (turn) this.publishMeasuredUsage(record, turn);
    };
    const send = async () => {
      // The agent's own preparation of this prompt (Antigravity: its working
      // copy's AGENTS.md, which its server never loads, A9).
      const prelude = this.options.promptPrelude ? await this.options.promptPrelude({ cwd: record.cwd, sessionKey: record.bridgeSessionId }) : null;
      const answer = bridge.connection.prompt({ ...params, ...(prelude ? { prompt: [...prelude.blocks, ...params.prompt] } : {}), sessionId: record.bridgeSessionId });
      let result: Awaited<typeof answer>;
      if (bridge.failure) {
        // The agent cannot finish without the person (a sign-in page it would
        // open): end the turn now and say why, instead of waiting on it.
        const failed = bridge.failure.catch((error: unknown) => {
          void bridge.connection.cancel({ sessionId: record.bridgeSessionId }).catch(() => undefined);
          throw error;
        });
        result = await Promise.race([answer, failed]);
      } else {
        result = await answer;
      }
      if (prelude) await prelude.delivered().catch((error: unknown) => this.logger.warn({ err: error instanceof Error ? error.message : "write_failed" }, "what the session was given could not be remembered"));
      return result;
    };
    const prepared = this.options.beforePrompt?.(bridge);
    const operation = (prepared ? prepared.then(send) : send())
      .then((result) => {
        const turnError = record.turnError;
        delete record.turnError;
        if (turnError) {
          // The agent reported a failure as its reply (quota, a model it may
          // not use): a failed turn, in plain words, never a result.
          record.completedTurn = false;
          if (turnError.class === "agent_auth_required") this.options.onAuthRequired?.();
          // What the key paid for is reported even when the turn failed.
          publishMeasured();
          this.options.events.publish({ kind: "request_error", acpSessionRef, requestId, method: "session/prompt", code: -32603, ...turnError });
          return;
        }
        record.completedTurn = result.stopReason === "end_turn";
        if (result.usage) this.publishUsage(record, result.usage, true);
        else publishMeasured();
        this.options.events.publish({ kind: "prompt_result", acpSessionRef, requestId, result });
      })
      .catch((error: unknown) => {
        const classified = classifyBridgeError(error);
        if (classified.class === "agent_auth_required") this.options.onAuthRequired?.();
        publishMeasured();
        this.options.events.publish({ kind: "request_error", acpSessionRef, requestId, method: "session/prompt", ...classified });
        throw error;
      })
      .finally(() => {
        record.activeTurns = Math.max(0, record.activeTurns - 1);
      });
    this.track(record, operation);
  }

  cancel(acpSessionRef: string): void {
    const record = this.require(acpSessionRef);
    void this.requireBridge(record).connection.cancel({ sessionId: record.bridgeSessionId });
  }

  setMode(acpSessionRef: string, requestId: string, params: Omit<SetSessionModeRequest, "sessionId">): void {
    const record = this.require(acpSessionRef);
    if (this.refusesMode(params.modeId)) return this.refuseMode(record, acpSessionRef, requestId, "session/set_mode");
    const operation = this.requireBridge(record)
      .connection.setSessionMode({ ...params, sessionId: record.bridgeSessionId })
      .then((result) => this.options.events.publish({ kind: "set_mode_result", acpSessionRef, requestId, result }))
      .catch((error: unknown) => {
        this.options.events.publish({ kind: "request_error", acpSessionRef, requestId, method: "session/set_mode", ...classifyBridgeError(error) });
        throw error;
      });
    this.track(record, operation);
  }

  setConfigOption(acpSessionRef: string, requestId: string, params: Omit<SetSessionConfigOptionRequest, "sessionId">): void {
    const record = this.require(acpSessionRef);
    if (params.configId === "mode" && this.refusesMode((params as { value?: unknown }).value)) {
      return this.refuseMode(record, acpSessionRef, requestId, "session/set_config_option");
    }
    if (params.configId === "model" && this.refusesModel((params as { value?: unknown }).value)) {
      return this.refuseMode(record, acpSessionRef, requestId, "session/set_config_option", REFUSED_MODEL_MESSAGE);
    }
    const operation = this.requireBridge(record)
      .connection.setSessionConfigOption({ ...params, sessionId: record.bridgeSessionId } as SetSessionConfigOptionRequest)
      .then((result) => {
        const reportedModel = currentModel(result.configOptions);
        if (reportedModel !== undefined) record.modelValue = reportedModel;
        this.options.events.publish({ kind: "set_config_option_result", acpSessionRef, requestId,
          result: { ...result, configOptions: this.withoutRefusedModes(result.configOptions) } });
      })
      .catch((error: unknown) => {
        this.options.events.publish({ kind: "request_error", acpSessionRef, requestId, method: "session/set_config_option", ...classifyBridgeError(error) });
        throw error;
      });
    this.track(record, operation);
  }

  /**
   * The refused slash command a prompt starts with, if any: any text block, or
   * the text blocks joined (the server reads `/logout` from the whole prompt).
   */
  private refusedPromptCommand(prompt: readonly unknown[]): string | undefined {
    const commands = this.options.refusedPromptCommands?.commands;
    if (!commands || commands.length === 0) return undefined;
    const texts = prompt.flatMap(block => {
      const value = block as { type?: unknown; text?: unknown } | null;
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
    });
    for (const candidate of [...texts, texts.join("")]) {
      const match = /^\/([A-Za-z][\w-]*)(?=\s|$)/.exec(candidate.trimStart());
      if (match && commands.includes(match[1]!.toLowerCase())) return match[1]!.toLowerCase();
    }
    return undefined;
  }

  private refusesMode(modeId: unknown): boolean {
    const refused = this.options.refusedModes;
    if (typeof modeId !== "string" || !refused) return false;
    return refused.modeIds.includes(modeId) || (refused.allowedModeIds !== undefined && !refused.allowedModeIds.includes(modeId));
  }

  /** One immutable policy baseline for every provider-session entry path. */
  private withDefaultSessionConfig(args: CreateSessionArgs): CreateSessionArgs {
    const sessionConfig = { ...(this.options.defaultSessionConfig ?? {}), ...(args.sessionConfig ?? {}) };
    return { ...args, ...(Object.keys(sessionConfig).length ? { sessionConfig } : {}) };
  }

  /** A mode this agent must never enter was named in an admitted session configuration. */
  /** An integration admission belongs to exactly one new session. */
  private assertFreshIntegration(args: CreateSessionArgs & { restoreReference?: string }): void {
    if (args.integration && (args.acpSessionRef !== undefined || args.restoreReference !== undefined)) {
      throw new RemoteInstanceError("schema_invalid", "An integration session is always new.");
    }
  }

  private assertAdmittedModes(sessionConfig: Record<string, string> | undefined): void {
    if (sessionConfig && this.refusesMode(sessionConfig.mode)) {
      throw new RemoteInstanceError("permission_denied", this.options.refusedModes!.message);
    }
    if (sessionConfig?.model !== undefined && this.refusesModel(sessionConfig.model)) {
      throw new RemoteInstanceError("permission_denied", REFUSED_MODEL_MESSAGE);
    }
  }

  private refusesModel(value: unknown): boolean {
    return typeof value === "string" && this.options.modelAllowed !== undefined && !this.options.modelAllowed(value);
  }

  /** Refuse a mode change before it reaches the agent; answered like the agent's own invalid-params error. */
  private refuseMode(record: SessionRecord, acpSessionRef: string, requestId: string, method: "session/set_mode" | "session/set_config_option", refusal?: string): void {
    this.logger.warn({ assignmentId: record.context.assignmentId, attempt: record.context.attempt, method }, refusal ? "refused a model this agent may not use here" : "refused a session mode this agent never runs in");
    const message = refusal ?? this.options.refusedModes!.message;
    this.track(record, Promise.resolve().then(() => this.options.events.publish({
      kind: "request_error", acpSessionRef, requestId, method, code: -32602, class: "invalid_params", message, retryable: false,
    })));
  }

  /** The agent's configuration as Konteks reports it: a refused mode is never offered. */
  private withoutRefusedModes<T>(configOptions: T): T {
    if (!this.options.refusedModes || !Array.isArray(configOptions)) return configOptions;
    return configOptions.map((option: unknown) => {
      const value = option as { id?: unknown; type?: unknown; options?: unknown };
      if (value?.id !== "mode" || value.type !== "select" || !Array.isArray(value.options)) return option;
      const keep = (entry: unknown) => !this.refusesMode((entry as { value?: unknown })?.value);
      const options = (value.options as unknown[]).flatMap((entry) => {
        const group = entry as { options?: unknown };
        if (Array.isArray(group?.options)) return [{ ...group, options: group.options.filter(keep) }];
        return keep(entry) ? [entry] : [];
      });
      return { ...value, options };
    }) as T;
  }

  /** Bridge → supervisor: session/update notifications keyed by our opaque ref. */
  onSessionUpdate(params: SessionNotification, bridge = this.options.bridge()): void {
    // The agent's commands are the agent's, not one session's: OpenCode
    // announces them while it is still creating the session, before its reply
    // registers the session here, and dropping that left OpenCode's commands
    // unknown for good (WS1-176). Learnt from any live bridge of this agent (the session may be on its bootstrap bridge).
    if (params.update.sessionUpdate === "available_commands_update" && bridge && !bridge.exited) {
      try { this.options.onAvailableCommands?.(params.update); } catch { /* never stops the stream */ }
    }
    const record = this.byBridgeId.get(params.sessionId);
    if (!record || record.bridge !== bridge || bridge.exited || record.recoveryStopping) return;
    // Thought chunks are not public activity (A4 D132).
    if (params.update.sessionUpdate === "agent_thought_chunk") return;
    if (params.update.sessionUpdate === "agent_message_chunk" && this.options.agentErrorText && record.activeTurns > 0) {
      const content = (params.update as { content?: { type?: unknown; text?: unknown } }).content;
      const turnError = content?.type === "text" && typeof content.text === "string" ? this.options.agentErrorText(content.text) : null;
      if (turnError) {
        record.turnError = turnError;
        return;
      }
    }
    if (params.update.sessionUpdate === "usage_update") {
      const usage = params.update as unknown as Partial<Usage> & { cost?: { amount?: unknown; currency?: unknown } | null };
      // OpenCode reports the session's running cost here (O7); a turn's is the difference.
      const cost = usage.cost;
      if (cost && cost.currency === "USD" && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0) {
        record.sessionCostUsd = cost.amount;
        record.costReported = true;
      }
      if (typeof usage.totalTokens === "number") this.publishUsage(record, usage as Usage);
    }
    if (params.update.sessionUpdate === "config_option_update") {
      const reportedModel = currentModel((params.update as { configOptions?: unknown }).configOptions);
      if (reportedModel !== undefined) record.modelValue = reportedModel;
    }
    // Never forward a provider-supplied transport field. Only the qualified
    // bridge correlation extension is translated, under this session owner.
    const { nativeObservation: _untrusted, ...reported } = params.update as typeof params.update & { nativeObservation?: unknown };
    const update = reported.sessionUpdate === "config_option_update"
      ? { ...reported, configOptions: this.withoutRefusedModes(reported.configOptions) }
      : reported;
    const native = AcpNativeObservationSchema.safeParse(update._meta?.konteksNativeObservation);
    const messageChunk = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk";
    const observation = messageChunk && native.success ? this.attributeNativeTurn(record, update.sessionUpdate, native.data) : undefined;
    this.options.events.publish({ kind: "session_update", acpSessionRef: record.acpSessionRef, params: {
      ...withoutBridgeSessionId(params), sessionId: record.acpSessionRef,
      update: { ...update, ...(observation ? { nativeObservation: observation } : {}) },
    } });
  }

  /**
   * The Codex bridge marks every agent chunk "unclassified" and leaves the
   * join to its turn: only the user message that opened the turn says whether
   * the connector sent it. Join here, under the session owner, so the reply to
   * a Konteks prompt is the Konteks turn's output. Before this, every Codex
   * reply to a Konteks prompt was treated as someone else's local turn and
   * dropped, so a Codex QA could never return a verdict (WS2-158). A turn the
   * connector did not open stays unclassified.
   */
  private attributeNativeTurn(record: SessionRecord, sessionUpdate: string, observation: AcpNativeObservation): AcpNativeObservation {
    if (sessionUpdate === "user_message_chunk") {
      if (observation.origin === "connector") {
        const turns = record.connectorTurns ??= new Set();
        turns.add(observation.turnId);
        if (turns.size > MAX_CONNECTOR_TURNS) turns.delete(turns.values().next().value!);
      }
      return observation;
    }
    return observation.origin === "unclassified" && record.connectorTurns?.has(observation.turnId)
      ? { ...observation, origin: "connector" }
      : observation;
  }

  /**
   * Bridge → supervisor: permission and elicitation requests. The runner never
   * decides; it forwards to the supervisor (policy first, then a human via the
   * relay, D87) and waits for exactly one answer or a deadline failure.
   */
  onRequestPermission(params: RequestPermissionRequest, bridge = this.options.bridge()): Promise<RequestPermissionResponse> {
    const record = this.byBridgeId.get(params.sessionId);
    if (!record || record.bridge !== bridge || bridge.exited || record.recoveryStopping) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    if (record.continuationSealed) return this.refuseUnownedWork(record, { outcome: { outcome: "cancelled" } });
    const requestId = `perm-${randomUUID()}`;
    return this.awaitAnswer<RequestPermissionResponse>(record, requestId, () =>
      this.options.events.publish({ kind: "permission_request", acpSessionRef: record.acpSessionRef, requestId, params: withoutBridgeSessionId(params) }),
    );
  }

  onCreateElicitation(params: CreateElicitationRequest, bridge = this.options.bridge()): Promise<CreateElicitationResponse> {
    const sessionId = (params as { sessionId?: string }).sessionId;
    const record = sessionId ? this.byBridgeId.get(sessionId) : undefined;
    if (!record || record.bridge !== bridge || bridge.exited || record.recoveryStopping) return Promise.resolve({ action: "cancel" });
    if (record.continuationSealed) return this.refuseUnownedWork(record, { action: "cancel" } as CreateElicitationResponse);
    const requestId = `elic-${randomUUID()}`;
    return this.awaitAnswer<CreateElicitationResponse>(record, requestId, () =>
      this.options.events.publish({ kind: "elicitation_request", acpSessionRef: record.acpSessionRef, requestId, params: withoutBridgeSessionId(params as unknown as Record<string, unknown>) }),
    );
  }

  /**
   * A sealed session has no turn: its last one ended and no assignment owns it
   * until the next adopts it. Work the agent starts on its own in between (a
   * background timer from the last turn firing) has nobody to answer it. A
   * request parked here was never answered and made the next turn refuse the
   * session as busy (WS2-130). Refuse it at once and cancel that stray turn.
   */
  private refuseUnownedWork<T>(record: SessionRecord, refusal: T): Promise<T> {
    const bridge = record.bridge;
    if (bridge && !bridge.exited && record.bridgeSessionId) {
      void bridge.connection.cancel({ sessionId: record.bridgeSessionId }).catch(() => undefined);
    }
    return Promise.resolve(refusal);
  }

  /** Supervisor → bridge: the single authorized answer for a pending request. */
  answer(acpSessionRef: string, requestId: string, response: unknown): boolean {
    const record = this.require(acpSessionRef);
    const pending = record.pendingClientRequests.get(requestId);
    if (!pending) return false;
    record.pendingClientRequests.delete(requestId);
    pending.resolve(response);
    return true;
  }

  private awaitAnswer<T>(record: SessionRecord, requestId: string, publish: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      record.pendingClientRequests.set(requestId, { resolve: (value) => resolve(value as T), reject });
      publish();
    });
  }

  /**
   * A turn measured outside the agent: pay-per-use on the person's own key,
   * with the list-price estimate when every model it used has a price (A8).
   */
  private publishMeasuredUsage(record: SessionRecord, turn: MeasuredTurn): void {
    const observation: AgentTurnUsageObservation = {
      instanceId: record.context.instanceId,
      assignmentId: record.context.assignmentId,
      attempt: record.context.attempt,
      agentId: record.context.agentId,
      totalTokens: turn.totalTokens,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      thoughtTokens: turn.thoughtTokens,
      cacheReadTokens: turn.cacheReadTokens,
      observedAt: this.now().toISOString(),
      moneyBasis: "pay_per_use",
      provider: turn.provider,
      model: turn.model,
      ...(turn.estimate ? { reportedCost: { currency: "USD", amountMicros: turn.estimate.amountMicros }, costSource: "list_price_estimate" as const, pricingSnapshotId: turn.estimate.pricingSnapshotId } : {}),
    };
    this.options.events.publish({ kind: "usage_observation", acpSessionRef: record.acpSessionRef, observation });
  }

  private publishUsage(record: SessionRecord, usage: Usage, turnEnded = false): void {
    const label = this.options.usageLabel ? this.options.usageLabel(record.modelValue) : { moneyBasis: "unavailable_local_subscription" as const };
    // A turn Konteks cannot label honestly (pay-per-use on an older Core, or
    // an unknown provider) is not reported, never reported as a subscription.
    if (label === null) return;
    const base = {
      instanceId: record.context.instanceId,
      assignmentId: record.context.assignmentId,
      attempt: record.context.attempt,
      agentId: record.context.agentId,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      observedAt: this.now().toISOString(),
    };
    let observation: AgentTurnUsageObservation;
    if (label.moneyBasis === "pay_per_use") {
      const start = record.turnCostStartUsd, end = record.sessionCostUsd;
      const micros = turnEnded && record.costReported === true && start !== undefined && end !== undefined && end >= start ? Math.round((end - start) * 1_000_000) : undefined;
      observation = { ...base, moneyBasis: "pay_per_use", provider: label.provider, ...(label.model ? { model: label.model } : {}),
        ...(micros !== undefined && micros <= 1_000_000_000_000 ? { reportedCost: { currency: "USD", amountMicros: micros } } : {}) };
    } else {
      observation = { ...base, moneyBasis: "unavailable_local_subscription" };
    }
    if (turnEnded) {
      if (record.sessionCostUsd !== undefined) record.turnCostStartUsd = record.sessionCostUsd;
      record.costReported = false;
    }
    if (usage.thoughtTokens != null) observation.thoughtTokens = usage.thoughtTokens;
    if (usage.cachedReadTokens != null) observation.cacheReadTokens = usage.cachedReadTokens;
    const cachedWrite = (usage as { cachedWriteTokens?: number | null }).cachedWriteTokens;
    if (cachedWrite != null) observation.cacheWriteTokens = cachedWrite;
    this.options.events.publish({ kind: "usage_observation", acpSessionRef: record.acpSessionRef, observation });
  }
}

function capabilitiesOf(bridge: BridgeProcess | null): { forkSession: boolean; sessionResume: boolean } {
  const caps = bridge?.initializeResult.agentCapabilities;
  return {
    forkSession: caps?.sessionCapabilities?.fork != null,
    sessionResume: caps?.loadSession === true || caps?.sessionCapabilities?.resume != null,
  };
}

/** The bridge session id is runner-local; strip it before anything leaves the runner. */
function withoutBridgeSessionId<T extends object>(params: T): Omit<T, "sessionId"> {
  const { sessionId: _sessionId, ...rest } = params as T & { sessionId?: string };
  return rest;
}
