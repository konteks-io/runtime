import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  PromptRequest,
  PromptResponse,
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
import { konteksAgentTitledMetadata, konteksCodingSessionTitle, konteksSessionMetadata, type KonteksSessionLabel } from "./title.js";
import type { MeasuredTurn } from "./usage-label.js";
import {
  assertConfirmedDirectModelSelection,
  prepareDirectModelSelection,
} from "./model-selection.js";
import type { DirectModelSelection, DirectModelSelectionPolicy } from "@konteks/remote-common";

/**
 * ACP sessions inside this runner. The supervisor creates them as a
 * consequence of claiming an assignment: `session/new` or a proven
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
type SessionContext = z.infer<typeof SessionContextSchema>;

interface CreateSessionArgs {
  context: SessionContext;
  /** Absolute outer readiness deadline supplied by the claim owner. */
  readinessDeadlineAt?: string;
  cwd: string;
  readOnlyRoots?: readonly string[];
  mcpServers: McpServer[];
  /** ACP session-config selections from the assignment (`agentRoute.sessionConfig`). */
  sessionConfig?: Record<string, string>;
  modelSelectionPolicy?: DirectModelSelectionPolicy;
  modelSelection?: DirectModelSelection;
  /** Opaque ref from a prior turn on this runtime; loaded/resumed only when the bridge proves it. */
  acpSessionRef?: string;
  /** Restart recovery whose durable context was staged outside the provider transcript. */
  freshProviderSessionOnRestore?: boolean;
  /** Display-only naming for the provider session list; never authority. */
  sessionLabel?: KonteksSessionLabel;
  /**
   * An integration task's own session: the one
   * personal MCP server (Codex) or the account connectors (Claude) this NEW
   * session admits, sent as `_meta.konteksIntegration` for the bridge patches.
   * Never carried into a continued or restored session.
   */
  integration?: IntegrationSessionAdmission;
  /** A person's direct session: the agent titles it; Konteks asks only for the `[konteks]` prefix. */
  agentTitled?: boolean;
  /** Native in-process owner; opaque connector ref, never the bridge session ID. */
  lifecycle?: {
    beforeCreate(opaqueRef: string): Promise<void>;
    recordProcessOwner(owner: RetainedProcessOwner): Promise<void>;
    replaceProcessOwner?(previous: RetainedProcessOwner, replacement: RetainedProcessOwner): Promise<void>;
    assertCurrent(): void;
  };
}

interface IntegrationSessionAdmission {
  /** Personal (or E2E) MCP servers the Codex bridge leaves enabled for this thread; none otherwise. */
  admittedMcpServerNames: string[];
  /** Claude only: this session may load the account's claude.ai connectors (every call still meets the gate). */
  accountConnectors: boolean;
}

/** The `_meta` an integration session's `session/new` carries, versioned for the bridge patches. */
function konteksIntegrationMeta(admission: IntegrationSessionAdmission) {
  return { konteksIntegration: { version: 1 as const, admittedMcpServerNames: [...admission.admittedMcpServerNames], accountConnectors: admission.accountConnectors } };
}

export interface CreatedSession {
  acpSessionRef: string;
  resumed: boolean;
  capabilities: { forkSession: boolean; sessionResume: boolean };
  modelSelection?: DirectModelSelection;
}

interface SessionRecord {
  bridge: BridgeProcess;
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
  /** `sessionCostUsd` when the running turn started; its cost is the difference. */
  turnCostStartUsd?: number;
  /** The agent reported a cost since the last turn ended: without one, a turn's cost is unknown, never zero. */
  costReported?: boolean;
  /** The session's working copy, as the last create or continuation named it. */
  cwd: string;
  /** A failure the agent sent as its reply during the running turn (`agentErrorText`); reported instead of a result. */
  turnError?: HostTurnError;
}

/**
 * How a turn's usage is labelled: a subscription turn, or a pay-per-use
 * turn naming the provider (and model) it reached. Null: not reported at all.
 */
export type TurnUsageLabel =
  | { moneyBasis: "unavailable_local_subscription" }
  | { moneyBasis: "pay_per_use"; provider: string; model?: string };

const MAX_CONNECTOR_TURNS = 256;
/** How long a released session's ACP `session/close` may take before its process is stopped instead of kept. */
const RELEASE_CLOSE_DEADLINE_MS = 15_000;
const REFUSED_MODEL_MESSAGE = "That model is not available to this agent here. OpenCode Zen's free models are switched off for this computer.";
type AcpNativeObservation = z.infer<typeof AcpNativeObservationSchema>;

export interface SessionManagerOptions {
  /** The signed bridge's raw-list marker, required rather than trusting an injected current menu value. */
  requireRawModelOffer?: true;
  bridge: () => BridgeProcess | null;
  /** Native execution allocator; called only after the durable ref reservation. */
  createBridge?: (acpSessionRef: string, lifecycle?: CreateSessionArgs["lifecycle"], cwd?: string, readOnlyRoots?: readonly string[]) => Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }>;
  /** Bootstrap-only allocator. The previous bridge is already confirmed stopped. */
  replaceBridge?: (acpSessionRef: string, previous: BridgeProcess, bootstrapAttempt: number, lifecycle?: CreateSessionArgs["lifecycle"], cwd?: string, readOnlyRoots?: readonly string[]) => Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }>;
  /** A sealed continuation may need a clean child before refreshing provider authority. */
  rebindBridge?: (acpSessionRef: string, previous: BridgeProcess, lifecycle: CreateSessionArgs["lifecycle"] | undefined, cwd: string, readOnlyRoots: readonly string[], retirePrevious: () => Promise<void>) => Promise<BridgeProcess>;
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
    /** When set, every mode outside it is refused too (Codex: only "Ask for approval"). */
    readonly allowedModeIds?: readonly string[];
    readonly message: string;
  };
  /** Slash commands this agent is never sent (Antigravity's `/plan`, `/logout`): such a prompt is refused before it reaches the agent. */
  refusedPromptCommands?: { readonly commands: readonly string[]; readonly message: string };
  /**
   * Whether a model value may be used (OpenCode: Zen's free models only when
   * switched on). A session that would start on a model it may not use is
   * moved to the first one it may, before ready; asking for one is refused.
   */
  modelAllowed?: (value: string) => boolean;
  /** How each turn's usage is labelled from the session's model; absent: every turn is a subscription turn. */
  usageLabel?: (modelValue: string | undefined) => TurnUsageLabel | null;
  /** Extra `_meta` on every `session/new`, `session/load` and `session/resume` (Antigravity's tool filter). */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /** Checks what a new, loaded or resumed session reports before it reads ready; throws on drift. */
  verifySession?: (response: { configOptions?: unknown; modes?: unknown }) => void;
  /** Content put in front of a prompt (Antigravity: the working copy's AGENTS.md). */
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
   * Every `available_commands_update` of a session: the
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
  return (option.options as unknown[]).flatMap((entry) => {
    const group = entry as { options?: unknown; value?: unknown };
    const values = Array.isArray(group.options) ? (group.options as Array<{ value?: unknown }>)
      : [group];
    return values.map(value => value.value).filter((value): value is string => typeof value === "string");
  });
}

export interface SessionRefStore {
  get(acpSessionRef: string): Promise<string | null>;
  put(acpSessionRef: string, bridgeSessionId: string): Promise<void>;
}

/** A JSON-RPC "invalid params" refusal from the agent (ACP RequestError -32602). */
function isInvalidParams(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === -32602
  );
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
  /** Only an idle sealed continuation may deliberately retire its old child. */
  private readonly rebindingBridges = new Set<BridgeProcess>();
  /** Known private bridge IDs with in-flight/uncertain load outcomes. Not an
   * OS stop proof; uncertainty is never cleared just because load rejected. */
  private readonly creatingBridgeIds = new Set<string>();
  /**
   * ACP sessions whose record was dropped while their process lived on and
   * that the agent was never confirmed to close (a pending, failed or
   * unsupported `session/close`). The agent still holds each one (Claude
   * Code keeps a `claude` child per session), so such a process must never
   * be kept resident for another session.
   */
  private readonly unclosedSessions = new WeakMap<BridgeProcess, number>();
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

  /** Sessions still bound to exactly this process, fenced ones included,
   * plus every dropped session the agent was not confirmed to close. A
   * resident process is kept only when this reads zero. */
  sessionsBoundTo(bridge: BridgeProcess): number {
    let bound = this.unclosedSessions.get(bridge) ?? 0;
    for (const record of this.sessions.values()) if (record.bridge === bridge) bound += 1;
    return bound;
  }

  /** A dropped record's ACP session is still open on its live process. */
  private markUnclosed(bridge: BridgeProcess, delta: 1 | -1): void {
    if (bridge.exited && delta > 0) return;
    this.unclosedSessions.set(bridge, Math.max(0, (this.unclosedSessions.get(bridge) ?? 0) + delta));
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
    stage: BootstrapStage,
    args: CreateSessionArgs,
    bridge: BridgeProcess,
    operation: Promise<T>,
    bootstrapAttempt: number,
  ): Promise<T> {
    const timeoutMs = Math.max(1, Math.min(this.bootstrapTimeoutMs, this.readinessLeftMs(stage, args)));
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
      return await this.recycleAfterDeadline({ stage, args, bridge, timeoutMs, bootstrapAttempt });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private readinessLeftMs(stage: BootstrapStage, args: CreateSessionArgs): number {
    const remainingMs = remainingReadinessMs(args, this.now());
    if (Number.isNaN(remainingMs) || remainingMs <= 0) {
      throw new RemoteInstanceError("agent_unavailable", "The outer execution readiness deadline expired.", {
        retryable: true, recoveryActions: [{ kind: "retry" }], diagnostic: `acp_${stage}_deadline`,
      });
    }
    return remainingMs;
  }

  /** A timed-out bootstrap call stops its exact bridge; the assignment retries on a fresh process. */
  private async recycleAfterDeadline(timedOut: { stage: BootstrapStage; args: CreateSessionArgs; bridge: BridgeProcess; timeoutMs: number; bootstrapAttempt: number }): Promise<never> {
    const { stage, args, timeoutMs, bootstrapAttempt } = timedOut;
    const log = { stage, assignmentId: args.context.assignmentId, attempt: args.context.attempt, agentId: args.context.agentId, timeoutMs, bootstrapAttempt };
    try {
      await timedOut.bridge.stop();
    } catch (stopError) {
      this.logger.error({ ...log, bridgeRecycled: false, retryable: true, err: classifyBridgeError(stopError).class },
        "ACP session bootstrap timed out and exact bridge recycling is unconfirmed");
      throw new RemoteInstanceError("recovery_required", "ACP session bootstrap timed out and the bridge stop could not be confirmed.", {
        recoveryActions: [{ kind: "retry" }, { kind: "run_doctor" }],
        retryable: true,
        cause: stopError,
        diagnostic: `acp_${stage}_deadline_stop_unconfirmed`,
      });
    }
    this.logger.warn({ ...log, bridgeRecycled: true, retryable: true }, "ACP session bootstrap timed out; exact bridge recycled for assignment retry");
    throw new RemoteInstanceError("agent_unavailable", "ACP session bootstrap timed out; retry the assignment on a fresh agent process.", {
      recoveryActions: [{ kind: "retry" }],
      retryable: true,
      diagnostic: `acp_${stage}_deadline`,
    });
  }

  /** `_meta` for `session/load` and `session/resume`: the agent's own (a persisted tool filter is overridden there). */
  private reopenMeta(args?: Pick<CreateSessionArgs, "agentTitled">): { _meta?: Record<string, unknown> } {
    // A reopened direct session the agent has not titled yet still gets the prefix when it does.
    const naming = args?.agentTitled ? { konteksSession: konteksAgentTitledMetadata().konteksSession } : {};
    const meta = { ...naming, ...this.options.sessionMeta };
    return Object.keys(meta).length ? { _meta: meta } : {};
  }

  private newSessionMeta(args: CreateSessionArgs, acpSessionRef: string): Record<string, unknown> {
    const naming = args.agentTitled ? konteksAgentTitledMetadata(args.context.agentId)
      : konteksSessionMetadata(konteksCodingSessionTitle(args.sessionLabel, acpSessionRef.slice(-8)), args.context.agentId);
    return { ...naming, ...this.options.sessionMeta, ...(args.integration ? konteksIntegrationMeta(args.integration) : {}) };
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
      const initial = await this.firstBootstrapBridge(args, ref);
      let bridge = initial.bridge;
      for (let bootstrapAttempt = initial.bootstrapAttempt; bootstrapAttempt <= 4; bootstrapAttempt += 1) {
        const reserved: { bridgeId: string | null } = { bridgeId: null };
        try {
          args.lifecycle?.assertCurrent();
          const created = await this.createImpl(args, ref, bridgeId => this.reserveBridgeId(bridgeId, reserved), bridge, loadFromRef, bootstrapAttempt);
          if (reserved.bridgeId !== null) this.creatingBridgeIds.delete(reserved.bridgeId);
          return created;
        } catch (error) {
          const replacement = await this.afterBootstrapFailure(error, { args, ref, bridge, bootstrapAttempt, reservedBridgeId: reserved.bridgeId });
          bridge = replacement.bridge;
          // Fresh-process initialization failures consume logical attempts too.
          // The loop increment below advances to the attempt returned here.
          bootstrapAttempt = replacement.bootstrapAttempt - 1;
        }
      }
      throw new RemoteInstanceError("agent_unavailable", "ACP session bootstrap retry budget exhausted.", { retryable: true });
    } finally {
      this.creatingRefs.delete(ref);
    }
  }

  /** After the caller's durable `beforeCreate`: an execution process of this reference's own, or the shared bridge. */
  private async firstBootstrapBridge(args: CreateSessionArgs, ref: string): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    args.lifecycle?.assertCurrent();
    await args.lifecycle?.beforeCreate(ref);
    args.lifecycle?.assertCurrent();
    if (this.options.createBridge) return this.options.createBridge(ref, args.lifecycle, args.cwd, args.readOnlyRoots);
    return { bridge: this.requireBridge(), bootstrapAttempt: 1 };
  }

  private reserveBridgeId(bridgeId: string, reserved: { bridgeId: string | null }): void {
    if (this.byBridgeId.has(bridgeId) || this.creatingBridgeIds.has(bridgeId)) throw new RemoteInstanceError("recovery_required", "bridge session already has a live or uncertain local owner");
    this.creatingBridgeIds.add(bridgeId);
    reserved.bridgeId = bridgeId;
  }

  /**
   * After a failed bootstrap attempt: a bootstrap deadline whose exact
   * process stop was confirmed gets a fresh bridge (within the readiness
   * deadline and the four-attempt budget); anything else is rethrown.
   */
  private async afterBootstrapFailure(error: unknown, attempt: { args: CreateSessionArgs; ref: string; bridge: BridgeProcess; bootstrapAttempt: number; reservedBridgeId: string | null }): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    const { args, ref, bridge, bootstrapAttempt } = attempt;
    const retryableDeadline = isRetryableBootstrapDeadline(error);
    // A confirmed exact-process stop removes all uncertainty introduced
    // by this bootstrap attempt, including config-timeout indexes.
    if (retryableDeadline) this.forgetTimedOutAttempt(ref, bridge, attempt.reservedBridgeId);
    if (!retryableDeadline || bootstrapAttempt === 4 || !this.options.replaceBridge) {
      if (retryableDeadline) this.logger.error({ ...contextLog(args), bootstrapAttempt, maxBootstrapAttempts: 4, exhausted: true }, "ACP session bootstrap retry budget exhausted");
      throw error;
    }
    const remainingMs = remainingReadinessMs(args, this.now());
    if (Number.isNaN(remainingMs) || remainingMs <= 0) throw error;
    await this.bootstrapBackoff(args, bootstrapAttempt, remainingMs);
    const replacement = await this.options.replaceBridge(ref, bridge, bootstrapAttempt + 1, args.lifecycle, args.cwd, args.readOnlyRoots);
    this.logger.info({ ...contextLog(args), bootstrapAttempt: replacement.bootstrapAttempt, recoveredFromAttempt: bootstrapAttempt, recovery: "fresh_bridge" },
      "ACP session bootstrap acquired a fresh bridge");
    return replacement;
  }

  /** Exponential backoff with jitter, never past the readiness deadline. */
  private async bootstrapBackoff(args: CreateSessionArgs, bootstrapAttempt: number, remainingMs: number,
  ): Promise<void> {
    const exponentialMs = 500 * 2 ** (bootstrapAttempt - 1);
    const delayMs = Math.min(remainingMs, 2_000, Math.max(1, Math.round(exponentialMs * (0.75 + this.bootstrapRetryRandom() * 0.5))),
    );
    this.logger.warn({ ...contextLog(args), bootstrapAttempt, nextBootstrapAttempt: bootstrapAttempt + 1, maxBootstrapAttempts: 4, delayMs, recovery: "fresh_bridge" },
      "retrying ACP session bootstrap with exponential backoff");
    await this.bootstrapRetrySleep(delayMs);
    args.lifecycle?.assertCurrent();
  }

  private forgetTimedOutAttempt(ref: string, bridge: BridgeProcess, reservedBridgeId: string | null): void {
    const record = this.sessions.get(ref);
    if (record?.bridge === bridge) {
      this.sessions.delete(ref);
      this.byBridgeId.delete(record.bridgeSessionId);
    }
    if (reservedBridgeId !== null) this.creatingBridgeIds.delete(reservedBridgeId);
  }

  private async createImpl(args: CreateSessionArgs, acpSessionRef: string, reserveBridgeId: (id: string) => void, bridge: BridgeProcess, loadFromRef: string | undefined, bootstrapAttempt: number,
  ): Promise<CreatedSession> {
    if (bridge.exited) throw new RemoteInstanceError("agent_unavailable", "Creating bridge has exited.");
    const capabilities = capabilitiesOf(bridge);
    // The Claude SDK persists its deferred-tool registry in the provider
    // transcript. Loading that transcript after a process restart can retain a
    // former assignment's smaller or expired MCP view even though ACP receives
    // the current mcpServers. Konteks already stages the durable conversation
    // and tool-call memory into every restarted native turn, so create a fresh
    // provider query for Claude: it preserves logical continuation without
    // replaying a large transcript or inheriting stale authority. Live,
    // same-process continuation still uses continueLive below.
    const loadProviderHistory = loadFromRef !== undefined && args.freshProviderSessionOnRestore !== true;
    const opened = loadProviderHistory
      ? await this.loadPriorSession(args, bridge, loadFromRef, capabilities.sessionResume, reserveBridgeId, bootstrapAttempt)
      : await this.newBridgeSession(args, bridge, acpSessionRef, reserveBridgeId, bootstrapAttempt);
    const record = await this.ownCreatedSession(args, acpSessionRef, bridge, opened);
    // An agent that drifted from what Konteks governs (Antigravity: no model
    // choice, or a mode other than `default`) never reads ready.
    if (this.options.verifySession) {
      try { this.options.verifySession(opened.response); }
      catch (error) { throw fenceRecord(record, error); }
    }
    const modelSelection = await this.applySessionConfig(args, record, opened.response.configOptions, opened.resumed, bootstrapAttempt);
    return { acpSessionRef, resumed: opened.resumed, capabilities,
      ...(modelSelection ? { modelSelection } : {}),
    };
  }

  /** The prior provider session, resumed (or loaded) with this assignment's tools: identity is kept, tool authority is not. */
  private async loadPriorSession(args: CreateSessionArgs, bridge: BridgeProcess, loadFromRef: string, sessionResume: boolean, reserveBridgeId: (id: string) => void, bootstrapAttempt: number): Promise<OpenedSession> {
    const prior = await this.options.refStore.get(loadFromRef);
    args.lifecycle?.assertCurrent();
    if (bridge.exited) throw new RemoteInstanceError("agent_unavailable", "Creating bridge exited before session load.");
    if (prior === null || !sessionResume) {
      throw new RemoteInstanceError("recovery_required", "agent_session_lost: prior session cannot be loaded on this runtime", {
        recoveryActions: [{ kind: "retry" }],
        diagnostic: "agent_session_lost",
      });
    }
    reserveBridgeId(prior);
    try {
      const response = await this.reopenPrior(args, bridge, prior, bootstrapAttempt);
      return { bridgeSessionId: prior, response: (response ?? {}) as BootstrapResponse, resumed: true, newSession: false };
    } catch (error) {
      throw this.sessionLost(error);
    }
  }

  /** A retryable or sign-in failure stays itself; anything else means the prior session is lost. */
  private sessionLost(error: unknown): unknown {
    if (error instanceof RemoteInstanceError && (error.retryable || error.code === "agent_auth_required")) return error;
    this.logger.warn({ err: classifyBridgeError(error).class }, "session load failed; agent_session_lost");
    return new RemoteInstanceError("recovery_required", "agent_session_lost: bridge refused to load the prior session", {
      recoveryActions: [{ kind: "retry" }],
      diagnostic: "agent_session_lost",
    });
  }

  /** Send even an empty list rather than retaining prior MCP bindings. */
  private reopenPrior(args: CreateSessionArgs, bridge: BridgeProcess, prior: string, bootstrapAttempt: number): Promise<unknown> {
    const request = { sessionId: prior, cwd: args.cwd, mcpServers: args.mcpServers, ...this.reopenMeta(args) };
    return bridge.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null
      ? this.boundedBootstrap("session_resume", args, bridge, bridge.connection.resumeSession(request), bootstrapAttempt)
      : this.boundedBootstrap("session_load", args, bridge, bridge.connection.loadSession(request), bootstrapAttempt);
  }

  private async newBridgeSession(args: CreateSessionArgs, bridge: BridgeProcess, acpSessionRef: string, reserveBridgeId: (id: string) => void, bootstrapAttempt: number): Promise<OpenedSession> {
    let created: { sessionId: string; configOptions?: unknown; modes?: unknown };
    try {
      created = await this.boundedBootstrap("session_new", args, bridge,
        bridge.connection.newSession({ cwd: args.cwd, mcpServers: args.mcpServers, _meta: this.newSessionMeta(args, acpSessionRef) }), bootstrapAttempt);
    } catch (error) {
      if (error instanceof RemoteInstanceError && error.retryable) throw error;
      throw this.newSessionRefusal(error, args.context.agentId);
    }
    reserveBridgeId(created.sessionId);
    return { bridgeSessionId: created.sessionId, response: created, resumed: false, newSession: true };
  }

  private newSessionRefusal(error: unknown, agentId: string): RemoteInstanceError {
    const classified = classifyBridgeError(error);
    if (classified.class !== "agent_auth_required") return new RemoteInstanceError("agent_unavailable", classified.message, { recoveryActions: [{ kind: "run_doctor" }] });
    this.options.onAuthRequired?.();
    return new RemoteInstanceError("agent_auth_required", classified.message, { recoveryActions: [{ kind: "login_agent", agentId }] });
  }

  /** Retain the actual live owner before any fallible persistence/continuation. */
  private async ownCreatedSession(args: CreateSessionArgs, acpSessionRef: string, bridge: BridgeProcess, opened: OpenedSession): Promise<SessionRecord> {
    const { bridgeSessionId } = opened;
    if (this.sessions.has(acpSessionRef) || this.byBridgeId.has(bridgeSessionId)) throw new RemoteInstanceError("recovery_required", "bridge session already has a local owner");
    const modelValue = currentModel(opened.response.configOptions);
    const record: SessionRecord = { bridge, acpSessionRef, bridgeSessionId, context: args.context, cwd: args.cwd, pendingClientRequests: new Map(), activeTurns: 0, operations: new Set(), operationFailed: false, completedTurn: false, continuationSealed: false, recoveryStopping: false, recoveryStop: null, ...(args.lifecycle ? { assertCurrent: args.lifecycle.assertCurrent } : {}),
      ...(modelValue === undefined ? {} : { modelValue }),
      // A new session has spent nothing; a resumed one's total is unknown until the agent reports it.
      ...(opened.newSession ? { sessionCostUsd: 0 } : {}) };
    this.sessions.set(acpSessionRef, record);
    this.byBridgeId.set(bridgeSessionId, record);
    this.requireBridge(record);
    args.lifecycle?.assertCurrent();
    await this.options.refStore.put(acpSessionRef, bridgeSessionId);
    this.requireBridge(record);
    args.lifecycle?.assertCurrent();
    return record;
  }

  /**
   * A resumed session can retain stale defaults too. Configuration is an
   * admitted requirement, never a best-effort hint. Do not publish ready
   * until the bridge explicitly echoes each selected value.
   */
  private async applySessionConfig(args: CreateSessionArgs, record: SessionRecord, configOptions: unknown, resumed: boolean, bootstrapAttempt: number,
  ): Promise<DirectModelSelection | undefined> {
    const confirmed = new Map<string, string>();
    const sessionConfig = { ...(args.sessionConfig ?? {}) };
    const modelSelection = this.directModelConfig(args, record, sessionConfig, configOptions);
    const model = this.substituteModel(args, record, sessionConfig, configOptions);
    if (model !== undefined) sessionConfig.model = model;
    for (const [configId, value] of Object.entries(sessionConfig)) {
      this.requireBridge(record);
      args.lifecycle?.assertCurrent();
      try {
        const result = await this.boundedBootstrap("session_config", args, record.bridge,
          record.bridge.connection.setSessionConfigOption({ sessionId: record.bridgeSessionId, configId, value }), bootstrapAttempt);
        confirmed.set(configId, value);
        const reportedModel = currentModel(result.configOptions);
        if (reportedModel !== undefined) record.modelValue = reportedModel;
        // ACP returns the full configuration. Later selections must not reset
        // an earlier requirement (for example, changing effort resets model).
        assertSelections(result.configOptions, confirmed);
        assertConfirmedDirectModelSelection(
          modelSelection,
          result.configOptions,
          confirmed,
          this.options.requireRawModelOffer === true,
        );
      } catch (error) {
        throw this.unconfirmedConfig(error, args, record, resumed);
      }
      this.requireBridge(record);
      args.lifecycle?.assertCurrent();
    }
    return modelSelection;
  }

  private directModelConfig(
    args: CreateSessionArgs,
    record: SessionRecord,
    config: Record<string, string>,
    options: unknown,
  ): DirectModelSelection | undefined {
    try {
      const selection = prepareDirectModelSelection(
        args,
        options,
        this.options.requireRawModelOffer === true,
      );
      if (selection) config[selection.configId] = selection.effectiveValue;
      this.assertAdmittedModes(config);
      return selection;
    } catch (error) {
      throw fenceRecord(record, error);
    }
  }

  /**
   * Retain ownership for recovery: an RPC failure does not prove the remote
   * change did not happen, nor that this session has stopped.
   */
  private unconfirmedConfig(error: unknown, args: CreateSessionArgs, record: SessionRecord, resumed: boolean): unknown {
    if (error instanceof RemoteInstanceError && error.retryable) return error;
    fenceRecord(record);
    this.logger.warn({ assignmentId: args.context.assignmentId, attempt: args.context.attempt,
      code: "session_config_unconfirmed", resumed, err: classifyBridgeError(error).class },
    "admitted session configuration was not confirmed; session fenced");
    return new RemoteInstanceError("agent_unavailable", "The agent did not confirm the admitted session configuration. Refresh its model capabilities and retry with an available selection.", {
      recoveryActions: [{ kind: "run_doctor" }],
    });
  }

  /**
   * A session that would start on a model it may not use (OpenCode Zen's
   * free models switched off) is moved to the first one it may, as an
   * admitted requirement confirmed afterwards; with none, it never becomes
   * ready. Undefined: no substitution.
   */
  private substituteModel(args: CreateSessionArgs, record: SessionRecord, sessionConfig: Record<string, string>, configOptions: unknown): string | undefined {
    const modelAllowed = this.options.modelAllowed;
    if (!modelAllowed || sessionConfig.model !== undefined || record.modelValue === undefined || modelAllowed(record.modelValue)) return undefined;
    const allowed = modelValues(configOptions).find(value => modelAllowed(value));
    if (allowed !== undefined) return allowed;
    throw fenceRecord(record, new RemoteInstanceError("agent_auth_required", "The agent has no model it may use here: sign it in, or switch on its free models.", { recoveryActions: [{ kind: "login_agent", agentId: args.context.agentId }] }));
  }

  close(acpSessionRef: string): void {
    const record = this.sessions.get(acpSessionRef);
    if (!record) return;
    if (record.recoveryStopping) return; // Settlement owner survives until qualified finalization.
    for (const pending of record.pendingClientRequests.values()) pending.reject(new Error("session closed"));
    this.sessions.delete(acpSessionRef);
    this.byBridgeId.delete(record.bridgeSessionId);
    // No ACP close is sent here (the caller stops the process next), so the
    // agent still holds the session: its process must not be kept resident.
    this.markUnclosed(record.bridge, 1);
    this.options.events.publish({ kind: "session_exited", acpSessionRef, reason: "closed" });
  }

  /**
   * Release an idle sealed completion that no successor will continue, like
   * bb's releaseSession: no cancellation and no faked interruption of the
   * settled turn. Anything that is not an idle sealed owner is refused, and
   * refused synchronously, before anything changes.
   *
   * The released session is then closed on the agent (`session/close`): the
   * process may stay resident for the next session, and an ACP adapter keeps
   * every session it was never told to close alive (Claude Code: one
   * `claude` child each, which piled up on a reused process).
   * The returned promise settles once that close is confirmed, failed or past
   * its deadline; anything but a confirmed close leaves the session counted
   * by `sessionsBoundTo`, so the runtime stops the process instead of
   * keeping it. It never rejects.
   */
  releaseSealed(acpSessionRef: string): Promise<void> {
    const record = this.sessions.get(acpSessionRef);
    if (!record || !idleSealed(record)) {
      throw new RemoteInstanceError("recovery_required", "Only an idle sealed session can be released.", { diagnostic: "release_not_idle_sealed" });
    }
    record.continuationSealed = false;
    this.sessions.delete(acpSessionRef);
    this.byBridgeId.delete(record.bridgeSessionId);
    // Counted before any await: until the agent confirms the close, nothing
    // may park this process (its own session is still open there).
    this.markUnclosed(record.bridge, 1);
    this.options.events.publish({ kind: "session_exited", acpSessionRef, reason: "closed" });
    return this.closeReleased(record);
  }

  private async closeReleased(record: SessionRecord): Promise<void> {
    const bridge = record.bridge;
    if (bridge.exited) return;
    const log = { agentId: record.context.agentId, assignmentId: record.context.assignmentId, attempt: record.context.attempt };
    if (bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close == null) {
      this.logger.info({ ...log, outcome: "close_unsupported" }, "the agent cannot close a released session; its process will be stopped");
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RemoteInstanceError("agent_unavailable", "Released session close deadline elapsed.")), RELEASE_CLOSE_DEADLINE_MS);
        timer.unref();
      });
      await Promise.race([bridge.connection.closeSession({ sessionId: record.bridgeSessionId }), deadline]);
      if (bridge.exited) return;
      this.markUnclosed(bridge, -1);
    } catch (error) {
      this.logger.warn({ ...log, outcome: "close_unconfirmed", err: classifyBridgeError(error).class },
        "the agent did not confirm closing a released session; its process will be stopped");
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    const { ref, record } = this.livePredecessor(args);
    const bridge = this.requireBridge(record);
    // The predecessor's own fence is deliberately NOT asserted here: a sealed
    // completion belongs to a turn whose owner has closed and settled, so its
    // fence rejects by design (exactly as releaseSealed must not depend on
    // it). The successor's fence is installed and asserted below, and the
    // durable generation transfer in beforeCreate is what actually fences
    // the reference.
    this.assertAdmittedModes(args.sessionConfig);
    await args.lifecycle?.beforeCreate(ref);
    try {
      // The supervisor has already durably transferred this sealed reference.
      // A different fixed file authority needs a verified old-group stop and
      // a fresh bound child before any provider load or resume.
      const continuedBridge = await this.rebindContinuation(args, record, bridge);
      record.bridge = continuedBridge;
      adoptSuccessor(record, args);
      record.assertCurrent?.();
      const refreshed = await this.refreshReboundAuthority(continuedBridge, bridge, record, args);
      const modelSelection = await this.confirmContinuation(args, record, refreshed);
      return { acpSessionRef: ref, resumed: true, capabilities: capabilitiesOf(continuedBridge),
        ...(modelSelection ? { modelSelection } : {}),
      };
    } catch (error) {
      throw fenceRecord(record, error);
    }
  }

  private async rebindContinuation(args: CreateSessionArgs, record: SessionRecord, bridge: BridgeProcess): Promise<BridgeProcess> {
    if (!this.options.rebindBridge) return bridge;
    this.rebindingBridges.add(bridge);
    try {
      return await this.options.rebindBridge(record.acpSessionRef, bridge, args.lifecycle, args.cwd, args.readOnlyRoots ?? [], () => this.closeContinuationForRebind(args, record, bridge));
    } finally { this.rebindingBridges.delete(bridge); }
  }

  /** Persist the completed native history before its immutable child is retired. */
  private async closeContinuationForRebind(args: CreateSessionArgs, record: SessionRecord, bridge: BridgeProcess): Promise<void> {
    if (bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close == null) {
      throw new RemoteInstanceError("recovery_required", "Agent cannot close its fixed-authority session before rebinding.");
    }
    const timeoutMs = Math.min(RELEASE_CLOSE_DEADLINE_MS, remainingReadinessMs(args, this.now()));
    if (!(timeoutMs > 0)) throw new RemoteInstanceError("agent_unavailable", "The outer execution readiness deadline expired.", { retryable: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RemoteInstanceError("recovery_required", "Authority rebind session-close deadline elapsed.")), timeoutMs);
        timer.unref();
      });
      await Promise.race([bridge.connection.closeSession({ sessionId: record.bridgeSessionId }), deadline]);
      args.lifecycle?.assertCurrent();
    } finally { if (timer) clearTimeout(timer); }
  }

  private async refreshReboundAuthority(bridge: BridgeProcess, previous: BridgeProcess, record: SessionRecord, args: CreateSessionArgs): Promise<BootstrapResponse | null | undefined> {
    try { return await this.refreshLiveAuthority(bridge, record, args); }
    catch (error) {
      if (bridge !== previous) throw this.sessionLost(error);
      throw error;
    }
  }

  private async confirmContinuation(
    args: CreateSessionArgs,
    record: SessionRecord,
    refreshed: BootstrapResponse | null | undefined,
  ): Promise<DirectModelSelection | undefined> {
    this.options.verifySession?.(refreshed ?? {});
      record.assertCurrent?.();
    const config = { ...(args.sessionConfig ?? {}) };
    const modelSelection = this.directModelConfig(args, record, config, refreshed?.configOptions);
    await confirmLiveConfig(
      record.bridge,
      record,
      config,
      modelSelection,
      this.options.requireRawModelOffer === true,
    );
      return modelSelection;
  }

  /** The idle sealed session of the same instance and agent that a live continuation adopts. */
  private livePredecessor(args: CreateSessionArgs): { ref: string; record: SessionRecord } {
    const ref = args.acpSessionRef;
    if (!ref) throw new RemoteInstanceError("recovery_required", "Live continuation requires its predecessor session reference.", { diagnostic: "continuation_reference_missing" });
    const record = this.sessions.get(ref);
    if (!record || !idleSealed(record) || !sameAgent(record.context, args.context)) {
      throw new RemoteInstanceError("recovery_required", "Live continuation predecessor is unavailable.", { diagnostic: "continuation_predecessor_unavailable" });
    }
    return { ref, record };
  }

  /** The live session reopened with the successor's tools and working copy: resumed, else loaded. */
  private async refreshLiveAuthority(bridge: BridgeProcess, record: SessionRecord, args: CreateSessionArgs): Promise<BootstrapResponse | null | undefined> {
    const caps = bridge.initializeResult.agentCapabilities;
    const request = () => ({ sessionId: record.bridgeSessionId, cwd: args.cwd, mcpServers: args.mcpServers, ...this.reopenMeta(args) });
    if (caps?.sessionCapabilities?.resume != null) return this.resumeLive(bridge, record, () => bridge.connection.resumeSession(request()), caps.sessionCapabilities.close != null);
    if (caps?.loadSession === true) return bridge.connection.loadSession(request());
    throw new RemoteInstanceError("recovery_required", "Agent cannot refresh a live session's authority.", { diagnostic: "agent_cannot_refresh_authority" });
  }

  /**
   * An agent that will not resume a session it still holds open (DeepSeek
   * Harness: "session is already active", -32602) is closed and resumed from
   * its own saved conversation: nothing is lost and the new turn's tools
   * still apply. Every second prompt in a direct session failed before this.
   */
  private async resumeLive(bridge: BridgeProcess, record: SessionRecord, resume: () => Promise<BootstrapResponse | null | undefined>, canClose: boolean): Promise<BootstrapResponse | null | undefined> {
    try {
      return await resume();
    } catch (error) {
      if (!(isInvalidParams(error) && canClose)) throw error;
      this.logger.info({ agentId: record.context.agentId }, "agent keeps its open session; closing and resuming it to continue");
      await bridge.connection.closeSession({ sessionId: record.bridgeSessionId });
      record.assertCurrent?.();
      return resume();
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

  private retainExitingRecord(record: SessionRecord, ref: string): boolean {
    if (this.rebindingBridges.has(record.bridge)) return true;
    if (record.recoveryStopping || this.creatingRefs.has(ref)) { record.operationFailed = true; return true; }
    return false;
  }

  closeAll(reason: "agent_exited" | "closed", bridge?: BridgeProcess): void {
    for (const ref of [...this.sessions.keys()]) {
      const record = this.sessions.get(ref);
      if (!record || (bridge && record.bridge !== bridge)) continue;
      for (const pending of record.pendingClientRequests.values()) pending.reject(new Error(reason));
      if (this.retainExitingRecord(record, ref)) continue;
      this.sessions.delete(ref);
      this.byBridgeId.delete(record.bridgeSessionId);
      this.markUnclosed(record.bridge, 1);
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
        const completion = this.cancelForRecovery(record);
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

  /** Cancel the turn and settle this session's ACP operations, then close it on the agent when it can. */
  private async cancelForRecovery(record: SessionRecord): Promise<void> {
    const bridge = this.requireBridge(record);
    const outstanding = [...record.operations];
    for (const pending of record.pendingClientRequests.values()) pending.reject(new Error("session recovery stop"));
    record.pendingClientRequests.clear();
    await bridge.connection.cancel({ sessionId: record.bridgeSessionId });
    await Promise.all(outstanding);
    if (!settledOn(record, bridge)) throw new RemoteInstanceError("recovery_required", "agent completion does not prove recovery stop");
    if (bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close == null) return;
    // The pinned Codex bridge closes its ACP/thread subscription here.
    // Acceptance is not a background-work drain receipt. Retain this
    // fenced owner until independently qualified finalization.
    await bridge.connection.closeSession({ sessionId: record.bridgeSessionId });
    if (bridge.exited || record.operationFailed) throw new RemoteInstanceError("recovery_required", "bridge ownership was lost during session close");
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
    if (this.refusedPrompt(record, requestId, params.prompt)) return;
    const publishMeasured = this.beginTurn(record, bridge);
    const send = () => this.sendPrompt(record, bridge, params);
    const prepared = this.options.beforePrompt?.(bridge);
    const operation = (prepared ? prepared.then(send) : send())
      .then(result => this.settlePrompt(record, requestId, result, publishMeasured))
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

  /** Counts the turn in, and returns what publishes its measured usage (tokens counted outside the agent, a relay, from now). */
  private beginTurn(record: SessionRecord, bridge: BridgeProcess): () => void {
    record.completedTurn = false;
    record.activeTurns += 1;
    // The last turn's end is this turn's start, so a cost the agent reports
    // after a turn's response is counted with the next turn, never lost.
    if (record.turnCostStartUsd === undefined && record.sessionCostUsd !== undefined) record.turnCostStartUsd = record.sessionCostUsd;
    delete record.turnError;
    const measured = this.options.measureTurn?.(bridge) ?? null;
    return () => {
      const turn = measured?.();
      if (turn) this.publishMeasuredUsage(record, turn);
    };
  }

  /** A prompt that starts with one of the agent's own refused commands is answered as invalid params and never sent. */
  private refusedPrompt(record: SessionRecord, requestId: string, prompt: readonly unknown[]): boolean {
    const command = this.refusedPromptCommand(prompt);
    if (command === undefined) return false;
    this.logger.warn({ assignmentId: record.context.assignmentId, attempt: record.context.attempt, command }, "refused a prompt that starts with one of the agent's own commands");
    this.track(record, Promise.resolve().then(() => this.options.events.publish({
      kind: "request_error", acpSessionRef: record.acpSessionRef, requestId, method: "session/prompt", code: -32602, class: "invalid_params", message: this.options.refusedPromptCommands!.message, retryable: false,
    })));
    return true;
  }

  private async sendPrompt(record: SessionRecord, bridge: BridgeProcess, params: Omit<PromptRequest, "sessionId">): Promise<PromptResponse> {
    // The agent's own preparation of this prompt (Antigravity: its working
    // copy's AGENTS.md, which its server never loads).
    const prelude = this.options.promptPrelude ? await this.options.promptPrelude({ cwd: record.cwd, sessionKey: record.bridgeSessionId }) : null;
    const answer = bridge.connection.prompt({ ...params, ...(prelude ? { prompt: [...prelude.blocks, ...params.prompt] } : {}), sessionId: record.bridgeSessionId });
    const result = bridge.failure ? await Promise.race([answer, cancelOnFailure(bridge, record.bridgeSessionId, bridge.failure)]) : await answer;
    if (prelude) await prelude.delivered().catch((error: unknown) => this.logger.warn({ err: error instanceof Error ? error.message : "write_failed" }, "what the session was given could not be remembered"));
    return result;
  }

  private settlePrompt(record: SessionRecord, requestId: string, result: PromptResponse, publishMeasured: () => void): void {
    const turnError = record.turnError;
    delete record.turnError;
    if (turnError) {
      // The agent reported a failure as its reply (quota, a model it may
      // not use): a failed turn, in plain words, never a result.
      record.completedTurn = false;
      if (turnError.class === "agent_auth_required") this.options.onAuthRequired?.();
      // What the key paid for is reported even when the turn failed.
      publishMeasured();
      this.options.events.publish({ kind: "request_error", acpSessionRef: record.acpSessionRef, requestId, method: "session/prompt", code: -32603, ...turnError });
      return;
    }
    record.completedTurn = result.stopReason === "end_turn";
    if (result.usage) this.publishUsage(record, result.usage, true);
    else publishMeasured();
    this.options.events.publish({ kind: "prompt_result", acpSessionRef: record.acpSessionRef, requestId, result });
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
    return (
      refused.modeIds.includes(modeId) || (refused.allowedModeIds !== undefined && !refused.allowedModeIds.includes(modeId)));
  }

  /** One immutable policy baseline for every provider-session entry path. */
  private withDefaultSessionConfig(args: CreateSessionArgs): CreateSessionArgs {
    const sessionConfig = { ...(this.options.defaultSessionConfig ?? {}), ...(args.sessionConfig ?? {}) };
    return { ...args, readOnlyRoots: Object.freeze([...(args.readOnlyRoots ?? [])]), ...(Object.keys(sessionConfig).length ? { sessionConfig } : {}) };
  }

  /** An integration admission belongs to exactly one new session. */
  private assertFreshIntegration(args: CreateSessionArgs & { restoreReference?: string }): void {
    if (args.integration && (args.acpSessionRef !== undefined || args.restoreReference !== undefined)) {
      throw new RemoteInstanceError("schema_invalid", "An integration session is always new.");
    }
  }

  /** A mode this agent must never enter, or a model it may not use, was named in an admitted session configuration. */
  private assertAdmittedModes(sessionConfig: Record<string, string> | undefined): void {
    if (sessionConfig && this.refusesMode(sessionConfig.mode)) {
      throw new RemoteInstanceError("permission_denied", this.options.refusedModes!.message);
    }
    if (sessionConfig?.model !== undefined && this.refusesModel(sessionConfig.model)) {
      throw new RemoteInstanceError("permission_denied", REFUSED_MODEL_MESSAGE);
    }
  }

  private refusesModel(value: unknown): boolean {
    return (
      typeof value === "string" && this.options.modelAllowed !== undefined && !this.options.modelAllowed(value)
    );
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
    this.learnAvailableCommands(params, bridge);
    const record = this.liveRecord(params.sessionId, bridge);
    if (!record) return;
    // Thought chunks are not public activity.
    if (params.update.sessionUpdate === "agent_thought_chunk") return;
    if (this.capturedTurnError(record, params.update)) return;
    if (params.update.sessionUpdate === "usage_update") this.noteUsageUpdate(record, params.update);
    if (params.update.sessionUpdate === "config_option_update") {
      const reportedModel = currentModel((params.update as { configOptions?: unknown }).configOptions);
      if (reportedModel !== undefined) record.modelValue = reportedModel;
    }
    this.forwardUpdate(record, params);
  }

  /** The session bound to exactly this live bridge and not fenced, else undefined. */
  private liveRecord(sessionId: string | undefined, bridge: BridgeProcess | null): SessionRecord | undefined {
    const record = sessionId ? this.byBridgeId.get(sessionId) : undefined;
    if (!record || record.bridge !== bridge || !bridge || bridge.exited || record.recoveryStopping) return undefined;
    return record;
  }

  /**
   * The agent's commands are the agent's, not one session's: OpenCode
   * announces them while it is still creating the session, before its reply
   * registers the session here, and dropping that left OpenCode's commands
   * unknown for good. Learnt from any live bridge of this agent (the session
   * may be on its bootstrap bridge).
   */
  private learnAvailableCommands(params: SessionNotification, bridge: BridgeProcess | null): void {
    if (params.update.sessionUpdate !== "available_commands_update" || !bridge || bridge.exited) return;
    try { this.options.onAvailableCommands?.(params.update); } catch { /* never stops the stream */ }
  }

  /** A reply chunk that is really the agent's failure report is kept as the turn's error, never forwarded. */
  private capturedTurnError(record: SessionRecord, update: SessionNotification["update"]): boolean {
    if (update.sessionUpdate !== "agent_message_chunk" || !this.options.agentErrorText || record.activeTurns === 0) return false;
    const content = (update as { content?: { type?: unknown; text?: unknown } }).content;
    const turnError = content?.type === "text" && typeof content.text === "string" ? this.options.agentErrorText(content.text) : null;
    if (!turnError) return false;
    record.turnError = turnError;
    return true;
  }

  /** OpenCode reports the session's running cost here; a turn's is the difference. */
  private noteUsageUpdate(record: SessionRecord, update: SessionNotification["update"]): void {
    const usage = update as unknown as Partial<Usage> & { cost?: { amount?: unknown; currency?: unknown } | null };
    const amount = usdAmount(usage.cost);
    if (amount !== undefined) {
      record.sessionCostUsd = amount;
      record.costReported = true;
    }
    if (typeof usage.totalTokens === "number") this.publishUsage(record, usage as Usage);
  }

  /**
   * Never forward a provider-supplied transport field. Only the qualified
   * bridge correlation extension is translated, under this session owner.
   */
  private forwardUpdate(record: SessionRecord, params: SessionNotification): void {
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
   * dropped, so a Codex QA could never return a verdict. A turn the
   * connector did not open stays unclassified.
   */
  private attributeNativeTurn(record: SessionRecord, sessionUpdate: string, observation: AcpNativeObservation,
  ): AcpNativeObservation {
    if (sessionUpdate === "user_message_chunk") {
      if (observation.origin === "connector") {
        const turns = (record.connectorTurns ??= new Set());
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
   * relay) and waits for exactly one answer or a deadline failure.
   */
  onRequestPermission(params: RequestPermissionRequest, bridge = this.options.bridge()): Promise<RequestPermissionResponse> {
    const record = this.liveRecord(params.sessionId, bridge);
    if (!record) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    if (record.continuationSealed) return this.refuseUnownedWork(record, { outcome: { outcome: "cancelled" } });
    const requestId = `perm-${randomUUID()}`;
    return this.awaitAnswer<RequestPermissionResponse>(record, requestId, () =>
      this.options.events.publish({ kind: "permission_request", acpSessionRef: record.acpSessionRef, requestId, params: withoutBridgeSessionId(params) }),
    );
  }

  onCreateElicitation(params: CreateElicitationRequest, bridge = this.options.bridge()): Promise<CreateElicitationResponse> {
    const record = this.liveRecord((params as { sessionId?: string }).sessionId, bridge);
    if (!record) return Promise.resolve({ action: "cancel" });
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
   * session as busy. Refuse it at once and cancel that stray turn.
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
   * with the list-price estimate when every model it used has a price.
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
    const observation: AgentTurnUsageObservation = label.moneyBasis === "pay_per_use"
      ? { ...base, moneyBasis: "pay_per_use", provider: label.provider, ...(label.model ? { model: label.model } : {}), ...reportedTurnCost(record, turnEnded) }
      : { ...base, moneyBasis: "unavailable_local_subscription" };
    if (turnEnded) {
      if (record.sessionCostUsd !== undefined) record.turnCostStartUsd = record.sessionCostUsd;
      record.costReported = false;
    }
    Object.assign(observation, optionalTokenCounts(usage));
    this.options.events.publish({ kind: "usage_observation", acpSessionRef: record.acpSessionRef, observation });
  }
}

/** The turn's cost from the running session cost the agent reported, once the turn ended. */
function reportedTurnCost(record: SessionRecord, turnEnded: boolean): { reportedCost?: { currency: "USD"; amountMicros: number } } {
  const start = record.turnCostStartUsd, end = record.sessionCostUsd;
  if (!turnEnded || record.costReported !== true || start === undefined || end === undefined || end < start) return {};
  const micros = Math.round((end - start) * 1_000_000);
  return micros <= 1_000_000_000_000 ? { reportedCost: { currency: "USD", amountMicros: micros } } : {};
}

function optionalTokenCounts(usage: Usage): Pick<AgentTurnUsageObservation, "thoughtTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
  const cachedWrite = (usage as { cachedWriteTokens?: number | null }).cachedWriteTokens;
  return {
    ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(cachedWrite != null ? { cacheWriteTokens: cachedWrite } : {}),
  };
}

/** A non-negative USD amount, else undefined. */
function usdAmount(cost: { amount?: unknown; currency?: unknown } | null | undefined): number | undefined {
  if (!cost || cost.currency !== "USD" || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0) return undefined;
  return cost.amount;
}

/** The agent cannot finish without the person (a sign-in page it would open): end the turn now and say why, instead of waiting on it. */
function cancelOnFailure(bridge: BridgeProcess, sessionId: string, failure: Promise<never>): Promise<never> {
  return failure.catch((error: unknown) => {
    void bridge.connection.cancel({ sessionId }).catch(() => undefined);
    throw error;
  });
}

type BootstrapStage = "session_new" | "session_resume" | "session_load" | "session_config";
type BootstrapResponse = { configOptions?: unknown; modes?: unknown };
type OpenedSession = { bridgeSessionId: string; response: BootstrapResponse; resumed: boolean; newSession: boolean };

/** What is left of the outer execution readiness deadline; unbounded without one, NaN when it is unreadable. */
function remainingReadinessMs(args: CreateSessionArgs, now: Date): number {
  return args.readinessDeadlineAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(args.readinessDeadlineAt) - now.getTime();
}

function isRetryableBootstrapDeadline(error: unknown): boolean {
  return (
    error instanceof RemoteInstanceError && error.retryable && error.diagnostic?.startsWith("acp_") === true && error.diagnostic.endsWith("_deadline")
  );
}

function contextLog(args: CreateSessionArgs): { assignmentId: string; attempt: number; agentId: string } {
  return { assignmentId: args.context.assignmentId, attempt: args.context.attempt, agentId: args.context.agentId };
}

/** Fence the record for recovery (its ownership is retained); returns `error` for a throw. */
function fenceRecord<E>(record: SessionRecord, error?: E): E | undefined {
  record.recoveryStopping = true;
  record.operationFailed = true;
  return error;
}

/** Every selected value is echoed as the single current value of its select option. */
function assertSelections(configOptions: ReadonlyArray<{ id: string; type: string; currentValue?: unknown }>, selections: ReadonlyMap<string, string>): void {
  for (const [selectedId, selectedValue] of selections) {
    const matches = configOptions.filter(option => option.id === selectedId);
    if (matches.length !== 1 || matches[0]?.type !== "select" || matches[0].currentValue !== selectedValue) {
      throw new Error("session configuration acknowledgement mismatch");
    }
  }
}

/** Each admitted selection, set and echoed back one at a time on the live session. */
async function confirmLiveConfig(bridge: BridgeProcess, record: SessionRecord, sessionConfig: Readonly<Record<string, string>>,
  modelSelection: DirectModelSelection | undefined,
  requireRaw: boolean,
): Promise<void> {
  const confirmed = new Map<string, string>();
  for (const [configId, value] of Object.entries(sessionConfig)) {
    const result = await bridge.connection.setSessionConfigOption({ sessionId: record.bridgeSessionId, configId, value });
    confirmed.set(configId, value);
    assertSelections(result.configOptions, confirmed);
    assertConfirmedDirectModelSelection(
      modelSelection,
      result.configOptions,
      confirmed,
      requireRaw,
    );
    record.assertCurrent?.();
  }
}

/** No failed, running or outstanding work on the record, and its bridge still lives. */
function settledOn(record: SessionRecord, bridge: BridgeProcess): boolean {
  return (
    !record.operationFailed && record.activeTurns === 0 && record.operations.size === 0 && !bridge.exited
  );
}

/** A sealed completion with no turn, operation or pending request, not fenced. */
function idleSealed(record: SessionRecord): boolean {
  return (
    record.continuationSealed && !record.recoveryStopping && !record.operationFailed && record.activeTurns === 0 &&
    record.operations.size === 0 && record.pendingClientRequests.size === 0
  );
}

function sameAgent(a: CreateSessionArgs["context"], b: CreateSessionArgs["context"]): boolean {
  return a.instanceId === b.instanceId && a.agentId === b.agentId;
}

/** The successor's fence, context and working copy, installed before any provider-facing call. */
function adoptSuccessor(record: SessionRecord, args: CreateSessionArgs): void {
  record.context = args.context;
  record.cwd = args.cwd;
  if (args.lifecycle) record.assertCurrent = args.lifecycle.assertCurrent;
  else delete record.assertCurrent;
  record.completedTurn = false;
  record.continuationSealed = false;
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
