import { mkdir, readFile } from "node:fs/promises";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { join, resolve } from "node:path";
import { RemoteInstanceError, createLogger, stopRetainedProcessOwner, withoutUndefined, writeSecretFile, type AgentLoginOptionId, type ConnectedAgentCredential, type ConnectedAgentView, type Logger, type RetainedProcessOwner } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import { fallbackLoginIdentity, probeIdentity, type IdentityProbe } from "./auth/identity.js";
import { runLogout, startLoginFlow, type LoginFailureReason, type LoginFlow } from "./auth/login-flow.js";
import { hostAgentRunnerAdapter } from "./host/registry.js";
import { DEFAULT_HOST_AGENT_SETTINGS, type HostAgentRunnerAdapter, type HostAgentSettings, type HostLoginRequest, type HostSpawn, type HostFileAuthority, type HostWorkingCopyBinding } from "./host/host-agent.js";
import { AgentScopeStore, applyIdentityObservation, type AgentScopeState } from "./auth/scope-store.js";
import { classifyBridgeError, spawnBridge, type BridgeClientHandlers, type BridgeProcess, type BridgeStopOwner, type SpawnBridgeOptions } from "./bridge/process.js";
import { MODEL_DISCOVERY_MIN_SESSION_TIMEOUT_MS, definiteModelDiscoveryFailure, discoverBridgeModelCapability, offerableModelCapability, type DiscoveredBridgeModelCapability } from "./bridge/model-capability.js";
import { resolveBridgeSpawnSpec, verifyNativeRunnerPackage, type BridgeSpawnSpec } from "./bridge/spec.js";
import type { RunnerConfig } from "./config.js";
import { RunnerEventBus } from "./events.js";
import { projectReadiness } from "./readiness.js";
import { SessionManager, type SessionManagerOptions, type SessionRefStore, type TurnUsageLabel } from "./sessions/manager.js";
import { AVAILABLE_COMMANDS_FILE, AvailableCommandsStore } from "./sessions/available-commands.js";
import { turnUsageLabel } from "./sessions/usage-label.js";

/**
 * The runner's lifecycle owner: a control/login bridge, optional bounded native
 * execution bridges, readiness, per-agent scope state and one session/ref store.
 */
export interface AgentRuntimeOptions {
  config: RunnerConfig;
  events?: RunnerEventBus;
  now?: () => Date;
  logger?: Logger;
  spawn?: typeof spawnBridge;
  probe?: typeof probeIdentity;
  /** Native-only bounded allocation, including retained uncertain owners. */
  executionBridgeLimit?: () => number;
  /** Selected only for execution bridges; control/login keep their own owner. */
  executionSpawnProcess?: SpawnBridgeOptions["spawnProcess"];
  /** Idle lifetime of a resident execution process kept for the next session. */
  idleExecutionBridgeTtlMs?: number;
  /** Deterministic test seams for bounded exponential retry timing. */
  retrySleep?: (delayMs: number) => Promise<void>;
  retryRandom?: () => number;
  /** How long one authenticated discovery of the agent's offered models is reused. */
  modelCapabilityTtlMs?: number;
  /** Native supervisor-owned provider process must reload a completed official login. */
  afterSuccessfulLogin?: () => Promise<void>;
}

/**
 * The offered models are re-read at least this often ,
 * so a model the agent starts offering shows up without a restart. A sign-in
 * change re-reads at once: the account fingerprint is part of the cache key.
 */
const DEFAULT_MODEL_CAPABILITY_TTL_MS = 5 * 60_000;

/** A wedged agent process must not outlive the conversation it served. */
const DEFAULT_IDLE_EXECUTION_BRIDGE_TTL_MS = 30 * 60_000;

// `finalized` separates the two questions this record answers. A key is kept
// forever so a reference is never reused, but a finalized owner no longer
// occupies a capacity slot: its session is definitively gone and its process
// was either stop-proven or, for an idle sealed release, handed to the
// runtime's idle slot. Without that split the bounded allocation is spent once
// per process and the connector refuses all later work permanently.
interface ExecutionOwner {
  bridge: Promise<BridgeProcess>;
  /** The exact stop target: the spawn-time handle first, the initialized bridge after. */
  process: BridgeStopOwner | null;
  /** The spawn-time handle, which carries the retained process identity. */
  durable: BridgeStopOwner | null;
  /** The initialized ACP connection owned by this reference. */
  live: BridgeProcess | null;
  stop: Promise<void> | null;
  stopping: boolean;
  finalized: boolean;
  /** Finalized by an idle release whose process stayed resident instead of exiting. */
  retained: boolean;
}

/**
 * One already-initialized execution process nobody owns. Every ACP session
 * used to cost a process spawn plus `initialize` (tens of seconds for the
 * pinned Claude bridge) because each session reference got its own process
 * and qualified finalization killed it. ACP is multi-session per connection,
 * so the next reference can `session/new` on this process instead.
 */
interface IdleExecutionBridge {
  bridge: BridgeProcess;
  durable: BridgeStopOwner;
  /** Bumped by every authentication change; an older resident is stale. */
  authEpoch: number;
  expiry: NodeJS.Timeout;
}

/** One authenticated identity, bridge version and config id's offered models. */
interface ModelCapabilityEntry {
  /** The last answer the agent actually gave under this key, and when (runtime clock). */
  good: { capability: DiscoveredBridgeModelCapability; at: number } | null;
  /** The discovery running now, shared by every caller. */
  refresh: Promise<DiscoveredBridgeModelCapability> | null;
}

function sameRetainedOwner(a: RetainedProcessOwner, b: RetainedProcessOwner): boolean {
  return (
    a.version === b.version && a.platform === b.platform && a.pid === b.pid && a.processGroupId === b.processGroupId &&
    a.startToken === b.startToken && a.commandDigest === b.commandDigest
  );
}

class FileSessionRefStore implements SessionRefStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  async get(ref: string): Promise<string | null> {
    await this.writes;
    return (await this.load())[ref] ?? null;
  }

  put(ref: string, id: string): Promise<void> {
    const write = this.writes.then(async () => {
      const all = await this.load();
      all[ref] = id;
      await writeSecretFile(this.path, `${JSON.stringify(all)}\n`);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}


/**
 * Every Codex session on Konteks runs in codex-acp's "Ask for approval" mode
 * (`read-only`: approvalPolicy on-request, approvalsReviewer user), so each
 * escalation reaches Konteks's permission callback rather than Codex's own
 * auto-reviewer ("Approve for me", `agent`). It is applied before ready on
 * new, restored and live-continued sessions, and every other mode is refused,
 * including one a later codex-acp adds (external-integration Stage 0).
 */
export const CODEX_SESSION_GOVERNANCE = {
  defaultSessionConfig: { mode: "read-only" },
  refusedModes: {
    modeIds: ["agent", "agent-full-access"],
    allowedModeIds: ["read-only"],
    message: "Codex runs in Ask for approval mode on Konteks so workspace policy decides every sensitive action.",
  },
} as const;

/** Codex sessions are pinned to Ask for approval; a host agent refuses its own unsafe modes. */
function sessionGovernance(agentId: string, host: HostAgentRunnerAdapter | null,
): Pick<SessionManagerOptions, "defaultSessionConfig" | "refusedModes" | "requireRawModelOffer"> {
  if (agentId === "codex") return { defaultSessionConfig: CODEX_SESSION_GOVERNANCE.defaultSessionConfig, refusedModes: CODEX_SESSION_GOVERNANCE.refusedModes,
      requireRawModelOffer: true,
    };
  return host?.refusedSessionModes ? { refusedModes: host.refusedSessionModes } : {};
}

/** What a host agent's adapter adds to its sessions: refused commands, offered models, session checks and prompt preludes. */
function hostSessionHooks(host: HostAgentRunnerAdapter, config: RunnerConfig, settings: () => HostAgentSettings): Partial<SessionManagerOptions> {
  return {
    ...(host.refusedPromptCommands ? { refusedPromptCommands: host.refusedPromptCommands } : {}),
    ...(host.offersModel ? { modelAllowed: (value: string) => host.offersModel!(value, settings()) } : {}),
    ...(host.sessionMeta ? { sessionMeta: host.sessionMeta } : {}),
    ...(host.verifySession ? { verifySession: (response: { configOptions?: unknown; modes?: unknown }) => host.verifySession!(response) } : {}),
    ...(host.promptPrelude ? { promptPrelude: (session: { cwd: string; sessionKey: string }) => host.promptPrelude!(config, session) } : {}),
    ...(host.agentErrorText ? { agentErrorText: (text: string) => host.agentErrorText!(text) } : {}),
    ...measuredTurns(host, settings),
  };
}

/** A turn measured outside the agent is pay-per-use: only a Core that takes it gets it. */
function measuredTurns(host: HostAgentRunnerAdapter, settings: () => HostAgentSettings): Partial<SessionManagerOptions> {
  if (!host.measureTurn) return {};
  return { measureTurn: (bridge: BridgeProcess) => {
    const read = host.measureTurn!(bridge);
    return read ? () => (settings().coreAcceptsRouteBilling ? read() : null) : null;
  } };
}

function signalTokenUsage(result: IdentityProbe): boolean | undefined {
  return result.kind === "signal" ? result.tokenUsageObservable : undefined;
}

/** The record holds `owner`'s exact live process. */
function liveOwnerOf(record: ExecutionOwner, owner: RetainedProcessOwner): boolean {
  const identity = record.durable?.retainedProcessOwner;
  return (
    identity !== undefined && !record.finalized && !record.durable!.exited && sameRetainedOwner(identity, owner)
  );
}

/** A process that failed to start is worth a fresh one unless the failure was a definite refusal. */
function startupRetryable(error: unknown): boolean {
  return (
    !(error instanceof RemoteInstanceError) || error.code === "agent_unavailable" || error.retryable
  );
}

function startupErrorFields(error: unknown): { errorClass: string; errorCode: string; diagnostic: string | undefined } {
  return {
    errorClass: classifyBridgeError(error).class,
    errorCode: error instanceof RemoteInstanceError ? error.code : "bridge_initialize_failed",
    diagnostic: error instanceof RemoteInstanceError ? error.diagnostic : undefined,
  };
}

/** Exponential backoff with jitter, at most 2 s, before a fresh process. */
function freshProcessDelayMs(attempt: number, random: () => number): number {
  const exponentialMs = 500 * 2 ** (attempt - 1);
  return Math.min(2_000, Math.max(1, Math.round(exponentialMs * (0.75 + random() * 0.5))));
}

function runtimeDefaults(options: AgentRuntimeOptions): { events: RunnerEventBus; logger: Logger; now: () => Date } {
  return {
    events: options.events ?? new RunnerEventBus(),
    logger: options.logger ?? createLogger({ name: `runner-${options.config.RUNNER_AGENT_ID}` }),
    now: options.now ?? (() => new Date()),
  };
}

/** How every process of this agent is spawned: the runtime's own, or its adapter's around it (Antigravity's key relay). */
function runtimeSpawn(host: HostAgentRunnerAdapter | null, options: AgentRuntimeOptions): HostSpawn {
  const spawn = options.spawn ?? spawnBridge;
  return host?.wrapSpawn ? host.wrapSpawn(options.config, spawn) : spawn;
}

function refusedCommandNames(host: HostAgentRunnerAdapter | null): readonly string[] {
  return host?.refusedPromptCommands?.commands ?? [];
}

type SessionLifecycle = NonNullable<Parameters<SessionManager["create"]>[0]["lifecycle"]>;

/**
 * The attempt's lifecycle: a candidate's durable owner replaces the previous
 * candidate's (or is recorded first), and is remembered for the next attempt.
 */
function bootstrapLifecycle(lifecycle: SessionLifecycle | undefined, owners: { durablePrevious: RetainedProcessOwner | undefined }, persisted: { candidate?: RetainedProcessOwner }): SessionLifecycle | undefined {
  if (!lifecycle) return undefined;
  return {
    ...lifecycle,
    recordProcessOwner: async (candidate: RetainedProcessOwner) => {
      if (owners.durablePrevious) {
        if (!lifecycle.replaceProcessOwner) throw new RemoteInstanceError("recovery_required", "Durable bootstrap process-owner replacement is unavailable.");
        await lifecycle.replaceProcessOwner(owners.durablePrevious, candidate);
      } else {
        await lifecycle.recordProcessOwner(candidate);
      }
      persisted.candidate = candidate;
    },
  };
}

/** The same local authority may be represented by reordered or duplicate roots. */
function sameFileAuthority(authority: HostFileAuthority, cwd: string, readOnlyRoots: readonly string[]): boolean {
  const roots = (values: readonly string[]) => [...new Set(values.map(value => resolve(value)))].sort();
  return resolve(authority.cwd) === resolve(cwd) && JSON.stringify(roots(authority.readOnlyRoots)) === JSON.stringify(roots(readOnlyRoots));
}

/** Windows tree stop precedes leader cleanup; POSIX group stop gets an independent absence check. */
async function stopBoundProcess(owner: BridgeStopOwner, stop: () => Promise<void>): Promise<void> {
  const retained = owner.retainedProcessOwner;
  if (!retained) throw new RemoteInstanceError("recovery_required", "Bound execution process ownership is unavailable.");
  if (process.platform === "win32") await stopRetainedProcessOwner(retained);
  await stop();
  if (process.platform !== "win32") await stopRetainedProcessOwner(retained);
}

/** Profile ownership outlives a leader exit: release only after exact group stop. */
function boundStopOwner(process: BridgeStopOwner, binding: HostWorkingCopyBinding | null): BridgeStopOwner {
  if (!binding?.authority) return process;
  const stop = process.stop.bind(process);
  let stopping: Promise<void> | undefined;
  let stopConfirmed = false;
  return {
    get exited() { return process.exited; },
    ...(process.retainedProcessOwner ? { retainedProcessOwner: process.retainedProcessOwner } : {}),
    stop: () => {
      if (stopping) return stopping;
      const attempt = Promise.resolve().then(async () => {
        if (!stopConfirmed) { await stopBoundProcess(process, stop); stopConfirmed = true; }
        await binding.release();
      });
      stopping = attempt;
      void attempt.catch(() => { if (stopping === attempt) stopping = undefined; });
      return attempt;
    },
  };
}

export class AgentRuntime {
  readonly events: RunnerEventBus;
  readonly sessions: SessionManager;
  readonly family: AgentBridgeFamily;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly scopeStore: AgentScopeStore;
  private readonly spec: BridgeSpawnSpec;
  private bridge: BridgeProcess | null = null;
  private bridgeStart: Promise<void> | null = null;
  private readonly executionBridges = new Map<string, ExecutionOwner>();
  private idleExecutionBridge: IdleExecutionBridge | null = null;
  private authEpoch = 0;
  private connectionState: ConnectedAgentView["connectionState"] = "unavailable";
  private identity: "signal" | "logged_out" | "no_official_signal" | "unknown" = "unknown";
  private scope: AgentScopeState = { accountScope: "personal", authIdentityFingerprint: null, scopeAttestedAt: null, lastLoginAt: null };
  private lastProbeAt: string | null = null;
  private activeLogin: LoginFlow | null = null;
  private authRequired = false;
  /** The provider's admin keeps Konteks tools out (the last identity probe said so). */
  private providerAdminBlocked = false;
  /** ACP exposes model choices only through session/new. Cache the
   * capability by authenticated identity and bridge version so status
   * polling cannot create a visible Codex thread on every refresh, and keep
   * the last good answer while it is read again (`discoverModelCapability`). */
  private readonly modelCapabilities = new Map<string, ModelCapabilityEntry>();
  private stopping = false;
  private readonly backgroundProbes = new Set<Promise<void>>();
  /** Set when the agent broke a governance guarantee; no bridge starts again in this process. */
  private quarantined: string | null = null;
  /** A host-installed agent's adapter (DeepSeek Harness, OpenCode); null for a bundled agent. */
  private readonly host: HostAgentRunnerAdapter | null;
  /** Each execution child serves one working copy or fixed read authority; another session never reuses it. */
  private readonly perWorkingCopy: boolean;
  /** Process-local preparations; fixed read authority lasts through qualified owned group/tree cleanup. */
  private readonly workingCopyBindings = new WeakMap<BridgeProcess, HostWorkingCopyBinding>();
  /** Core's settings for host agents on this computer (free models, route billing). */
  private hostSettings: HostAgentSettings = DEFAULT_HOST_AGENT_SETTINGS;
  /** The credentials the last identity probe read (OpenCode's `auth list`); never a secret. */
  private credentials: ConnectedAgentCredential[] | undefined;
  /** The reviewed sign-ins the site may start here (OpenCode), read once the runtime started. */
  private siteLoginOptionIds: readonly AgentLoginOptionId[] = [];
  /** Whether turns report billing usage under the current sign-in, when the agent's identity says (Antigravity's key relay). */
  private tokenUsageObservable: boolean | undefined;
  /** How every process of this agent is spawned: the runtime's own, or its adapter's around it (Antigravity's key relay). */
  private readonly spawnProcess: HostSpawn;
  /** Stops an idle control process (`processLimits.controlIdleMs`). */
  private controlIdleTimer: NodeJS.Timeout | null = null;
  /** What the control process answered before it was stopped for being idle; readiness keeps reading it. */
  private parkedInitializeResult: InitializeResponse | null = null;
  /** The slash commands this agent announced on this computer, kept across restarts. */
  private readonly availableCommands: AvailableCommandsStore;

  constructor(private readonly options: AgentRuntimeOptions) {
    const defaults = runtimeDefaults(options);
    this.events = defaults.events;
    this.logger = defaults.logger;
    this.now = defaults.now;
    this.spec = resolveBridgeSpawnSpec(options.config);
    this.family = this.spec.family;
    this.host = hostAgentRunnerAdapter(this.family.agentId) ?? null;
    this.perWorkingCopy = this.host?.bindWorkingCopy !== undefined;
    this.spawnProcess = runtimeSpawn(this.host, options);
    if (this.perWorkingCopy && !options.executionBridgeLimit) {
      // Its control process has no working copy, so it never runs a session.
      throw new RemoteInstanceError("agent_unavailable", `${this.family.displayName} runs every session in a process of its own working copy.`);
    }
    this.scopeStore = new AgentScopeStore(options.config.RUNNER_CREDENTIAL_DIR);
    this.availableCommands = new AvailableCommandsStore(join(options.config.RUNNER_CREDENTIAL_DIR, AVAILABLE_COMMANDS_FILE), refusedCommandNames(this.host), this.logger);
    this.sessions = new SessionManager(this.sessionManagerOptions());
  }

  private sessionManagerOptions(): SessionManagerOptions {
    const { options } = this;
    return {
      bridge: () => this.bridge,
      ...this.executionBridgeHooks(),
      ...(this.perWorkingCopy ? {
        beforePrompt: (bridge, turn) => this.workingCopyBindings.get(bridge)?.beforePrompt(turn),
        afterPrompt: (bridge, turn) => this.workingCopyBindings.get(bridge)?.afterPrompt?.(turn),
      } : {}),
      ...sessionGovernance(this.family.agentId, this.host),
      ...(this.host ? hostSessionHooks(this.host, options.config, () => this.hostSettings) : {}),
      usageLabel: modelValue => this.usageLabel(modelValue),
      onAvailableCommands: update => this.availableCommands.learn(update, this.now()),
      events: this.events,
      refStore: new FileSessionRefStore(join(options.config.RUNNER_CREDENTIAL_DIR, "session-refs.json")),
      bootstrapTimeoutMs: this.sessionBootstrapTimeoutMs(),
      now: this.now,
      logger: this.logger,
      onAuthRequired: () => {
        this.authRequired = true;
        this.publishReadiness();
        // A host agent's credentials may now say why (Antigravity: no licence found).
        if (this.host?.identity && !this.stopping) this.probeInBackground();
      },
    };
  }

  /** With execution processes, every session gets one of its own (and a fresh one when bootstrap must retry). */
  private executionBridgeHooks(): Pick<SessionManagerOptions, "createBridge" | "replaceBridge" | "rebindBridge"> {
    if (!this.options.executionBridgeLimit) return {};
    return {
      createBridge: (ref, lifecycle, cwd, roots) => this.acquireBootstrapExecutionBridge(ref, 1, undefined, lifecycle, cwd, roots),
      replaceBridge: (ref, previous, bootstrapAttempt, lifecycle, cwd, roots) => this.replaceBootstrapExecutionBridge(ref, previous, bootstrapAttempt, lifecycle, cwd, roots),
      ...(this.perWorkingCopy ? { rebindBridge: (ref: string, previous: BridgeProcess, lifecycle: SessionLifecycle | undefined, cwd: string, roots: readonly string[], retirePrevious: () => Promise<void>) => this.rebindExecutionBridge(ref, previous, lifecycle, cwd, roots, retirePrevious) } : {}),
    };
  }

  async start(): Promise<void> {
    await mkdir(this.options.config.RUNNER_CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
    await mkdir(this.options.config.RUNNER_WORKSPACE_DIR, { recursive: true });
    this.scope = await this.scopeStore.read();
    await this.availableCommands.load();
    await this.ensureBridge();
    await this.probe(false);
    void this.refreshSiteLoginOptions();
  }

  /** The reviewed sign-ins the site may start on this machine (OpenCode); empty for every other agent. */
  siteLoginOptions(): readonly AgentLoginOptionId[] {
    return this.siteLoginOptionIds;
  }

  private async refreshSiteLoginOptions(): Promise<void> {
    if (!this.host?.siteLoginOptions) return;
    try {
      this.siteLoginOptionIds = [...(await this.host.siteLoginOptions(this.options.config))];
    } catch (error) {
      this.logger.warn({ errorCode: error instanceof RemoteInstanceError ? error.code : "sign_in_options_failed" }, "the agent's sign-in options could not be read");
    }
  }

  /**
   * Core's settings for host agents on this computer, from each applied
   * desired configuration. Switching OpenCode's free models changes what it
   * offers and, with nothing signed in, whether it is ready: re-probe.
   */
  async applyHostSettings(settings: HostAgentSettings): Promise<void> {
    const previous = this.hostSettings;
    this.hostSettings = Object.freeze({ ...settings });
    const freeModelsChanged = previous.openCodeFreeModels !== settings.openCodeFreeModels && this.host?.offersModel !== undefined;
    if (!freeModelsChanged && !this.coreBillingChanged(previous, settings)) return;
    if (freeModelsChanged) this.modelCapabilities.clear();
    if (this.connectionState !== "unavailable" && !this.stopping) await this.probe(false);
  }

  /** What a host agent's credentials say depends on what Core takes (Antigravity's no-licence reason). */
  private coreBillingChanged(previous: HostAgentSettings, settings: HostAgentSettings): boolean {
    return (
      previous.coreAcceptsRouteBilling !== settings.coreAcceptsRouteBilling && this.host?.identity !== undefined
    );
  }

  /** How one turn's usage is labelled: sessions/usage-label.ts. */
  private usageLabel(modelValue: string | undefined): TurnUsageLabel | null {
    return turnUsageLabel({ agentId: this.family.agentId, modelValue, credentials: this.credentials, coreAcceptsRouteBilling: this.hostSettings.coreAcceptsRouteBilling });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.activeLogin?.cancel();
    await this.bridgeStart;
    const errors: unknown[] = [];
    for (const ref of this.executionBridges.keys()) {
      try { await this.stopExecutionBridge(ref); } catch (error) { errors.push(error); }
    }
    // A finalized reference no longer owns its process; the idle slot does.
    try { await this.discardIdleExecutionBridge("runtime_stop"); } catch (error) { errors.push(error); }
    this.sessions.closeAll("closed");
    this.clearControlIdleStop();
    await this.bridge?.stop();
    this.bridge = null;
    this.connectionState = "exited";
    // A background identity read started before the stop writes the scope file.
    await Promise.all([...this.backgroundProbes]);
    await this.sweepLeftovers();
    if (errors.length) throw new AggregateError(errors, "Native execution owners could not all be stopped.");
  }

  /** The runner's session bootstrap deadline, or the agent's own when longer (Antigravity on Gemini Enterprise). */
  private sessionBootstrapTimeoutMs(): number {
    return Math.max(this.options.config.RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS, this.host?.sessionBootstrapTimeoutMs ?? 0);
  }

  /** After every process of this runner stopped: what a host agent's programs left behind (Antigravity's harness). */
  private async sweepLeftovers(): Promise<void> {
    if (!this.host?.sweepLeftovers) return;
    try { await this.host.sweepLeftovers(this.options.config); }
    catch (error) { this.logger.warn({ agentId: this.family.agentId, errorCode: error instanceof RemoteInstanceError ? error.code : "sweep_failed" }, "processes the agent left behind could not all be stopped"); }
  }

  /** Execution processes that may live at once: the supervisor's ceiling, and the agent's own when lower (Antigravity: two). */
  private executionLimit(): number | undefined {
    const limit = this.options.executionBridgeLimit?.();
    const own = this.host?.processLimits?.executionProcesses;
    return typeof limit === "number" && typeof own === "number" ? Math.min(limit, own) : limit;
  }

  private heldExecutionOwners(): number {
    let held = 0;
    for (const owner of this.executionBridges.values()) if (!owner.finalized) held += 1;
    return held;
  }

  private createExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string, readOnlyRoots: readonly string[] = []): Promise<BridgeProcess> {
    const queueMs = this.host?.processLimits?.queueMs;
    return queueMs === undefined ? this.reserveExecutionBridge(ref, lifecycle, cwd, readOnlyRoots) : this.queueForExecutionBridge(ref, Date.now() + queueMs, lifecycle, cwd, readOnlyRoots);
  }

  /**
   * An agent with its own process ceiling (Antigravity) waits for a free
   * execution process instead of being refused at once: a session finishing
   * or its resident process being taken frees one. Past the wait it is
   * refused plainly; nothing was reserved.
   */
  private async queueForExecutionBridge(ref: string, until: number, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string, readOnlyRoots: readonly string[] = []): Promise<BridgeProcess> {
    for (let logged = false; ; logged = true) {
      const limit = this.executionLimit();
      if (!this.waitsForCapacity(ref, limit)) return this.reserveExecutionBridge(ref, lifecycle, cwd, readOnlyRoots);
      if (Date.now() >= until) {
        throw new RemoteInstanceError("temporarily_unavailable", `${this.family.displayName} is already running ${limit} sessions on this computer. Try again when one of them finishes.`, { diagnostic: "execution_processes_busy" });
      }
      if (!logged) this.logger.info({ agentId: this.family.agentId, limit }, "a session waits for a free execution process");
      lifecycle?.assertCurrent();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /**
   * Only a full ceiling waits; anything else (stopping, signed out, signing
   * in, a reference already reserved, no ceiling) goes straight to the
   * reservation, which reserves or refuses it.
   */
  private waitsForCapacity(ref: string, limit: number | undefined): boolean {
    if (this.stopping || this.authRequired || this.activeLogin !== null || this.executionBridges.has(ref)) return false;
    return typeof limit === "number" && this.heldExecutionOwners() >= limit;
  }

  /** Why no execution owner may be reserved for `ref` now, or null. */
  private reservationRefusal(ref: string): RemoteInstanceError | null {
    const limit = this.executionLimit();
    if (this.authRequired) return new RemoteInstanceError("agent_auth_required", "Sign in to the selected local agent.", { recoveryActions: [{ kind: "login_agent", agentId: this.family.agentId }] });
    if (this.activeLogin !== null) return new RemoteInstanceError("temporarily_unavailable", "The local agent is signing in.");
    if (this.stopping || !this.capacityFree(limit) || this.executionBridges.has(ref)) {
      return new RemoteInstanceError("recovery_required", "Native execution owner capacity is unavailable; retained owners require qualified finalization.");
    }
    return null;
  }

  /** Only unfinalized owners hold capacity; retained keys still refuse reuse. */
  private capacityFree(limit: number | undefined): boolean {
    return (
      typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && this.heldExecutionOwners() < limit
    );
  }

  private reserveExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string, readOnlyRoots: readonly string[] = []): Promise<BridgeProcess> {
    const refusal = this.reservationRefusal(ref);
    if (refusal) return Promise.reject(refusal);
    const bridge = Promise.resolve().then(async () => {
      this.assertNotQuarantined();
      await this.prepareToSpawn(this.logger);
      if (this.stopping || this.executionBridges.get(ref)!.stopping) throw new RemoteInstanceError("agent_unavailable", "Native execution owner is stopping.");
      // A resident process costs this reference one `session/new`; only when
      // none is idle does it pay the spawn plus ACP `initialize`.
      const idle = this.perWorkingCopy ? null : this.takeIdleExecutionBridge();
      return idle ? this.adoptIdleExecutionBridge(ref, idle, lifecycle) : this.spawnExecutionBridge(ref, lifecycle, cwd, readOnlyRoots);
    });
    // Reserve the bounded owner before any executable await. Even a rejected
    // bootstrap retains its slot; no missing handle is interpreted as stopped.
    this.executionBridges.set(ref, { bridge, process: null, durable: null, live: null, stop: null, stopping: false, finalized: false, retained: false });
    return bridge;
  }

  /**
   * The spawn spec of one execution process: the runtime's own, or the
   * adapter's immutable working-copy profile, arguments, environment and cwd.
   * Fixed read authority is held until qualified process-group/tree cleanup.
   */
  private async executionSpec(cwd: string | undefined, readOnlyRoots: readonly string[]): Promise<{ spec: BridgeSpawnSpec; binding: HostWorkingCopyBinding | null }> {
    if (!this.perWorkingCopy) return { spec: this.spec, binding: null };
    if (cwd === undefined) throw new RemoteInstanceError("agent_unavailable", `${this.family.displayName} needs the session's working copy before it starts.`);
    const binding = await this.host!.bindWorkingCopy!(this.options.config, this.family, cwd, readOnlyRoots, this.spec.env);
    return { spec: { ...this.spec, env: binding.env, args: binding.args === undefined ? this.spec.args : [...binding.args], cwd: binding.cwd ?? this.spec.cwd }, binding };
  }

  private releaseWorkingCopy(binding: HostWorkingCopyBinding | null): void {
    if (binding) void binding.release().catch(error => this.logger.warn({ agentId: this.family.agentId, err: error }, "working copy preparation could not be removed"));
  }

  private async spawnExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string, readOnlyRoots: readonly string[] = []): Promise<BridgeProcess> {
    const record = this.executionBridges.get(ref)!;
    const start: { owner: BridgeProcess | null; processOwner?: BridgeStopOwner; exitedDuringStart: boolean; ownerPersistence: Promise<void> } = { owner: null, exitedDuringStart: false, ownerPersistence: Promise.resolve() };
    const { spec, binding } = await this.executionSpec(cwd, readOnlyRoots);
    const candidate = await this.spawnProcess({
      spec, initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
      clientVersion: this.options.config.RUNNER_BRIDGE_VERSION, logger: this.logger,
      onProcessOwner: process => {
        const owned = boundStopOwner(process, binding);
        start.processOwner = owned;
        record.process = owned;
        record.durable = owned;
        start.ownerPersistence = this.persistProcessOwner(owned, lifecycle);
        return start.ownerPersistence;
      },
      ...this.executionSpawnHooks(),
      handlers: this.executionHandlers(start, binding, record),
    }).catch(async (error: unknown) => {
      await this.releaseFailedPreparation(record, binding);
      throw error;
    });
    if (start.processOwner) candidate.stop = start.processOwner.stop;
    if (binding) this.workingCopyBindings.set(candidate, binding);
    await start.ownerPersistence;
    start.owner = candidate;
    return this.finishExecutionStart(record, candidate, start.exitedDuringStart);
  }

  /** Install the initialized owner and reject any exit or stop seen during startup. */
  private async finishExecutionStart(record: ExecutionOwner, candidate: BridgeProcess, exitedDuringStart: boolean): Promise<BridgeProcess> {
    record.process = candidate;
    record.live = candidate;
    record.durable ??= candidate;
    if (this.stopping || record.stopping || exitedDuringStart || candidate.exited) {
      await candidate.stop();
      throw new RemoteInstanceError("agent_unavailable", "Execution bridge exited during initialization.");
    }
    return candidate;
  }

  private async releaseFailedPreparation(record: ExecutionOwner, binding: HostWorkingCopyBinding | null): Promise<void> {
    if (!binding?.authority) { this.releaseWorkingCopy(binding); return; }
    try {
      if (record.process) return await record.process.stop();
      throw new RemoteInstanceError("recovery_required", "Execution process ownership is uncertain.", { diagnostic: "execution_process_owner_unconfirmed" });
    } catch (stopError) {
      record.stopping = true;
      throw new RemoteInstanceError("recovery_required", "Execution preparation is retained until owned cleanup is confirmed.", { cause: stopError, diagnostic: "execution_preparation_stop_unconfirmed" });
    }
  }

  private executionSpawnHooks(): Pick<SpawnBridgeOptions, "spawnProcess" | "stderrFailure"> {
    return {
      ...(this.options.executionSpawnProcess ? { spawnProcess: this.options.executionSpawnProcess } : {}),
      ...(this.host?.stderrFailure ? { stderrFailure: (line: string) => this.readStderrFailure(line) } : {}),
    };
  }

  /**
   * Callback authority is the initialized process object, which a later
   * reference reuses as-is: the session manager resolves every update,
   * permission, elicitation and exit to the sessions bound to exactly it.
   */
  private executionHandlers(start: { owner: BridgeProcess | null; processOwner?: BridgeStopOwner; exitedDuringStart: boolean }, binding: HostWorkingCopyBinding | null, record: ExecutionOwner): BridgeClientHandlers {
    return {
      onSessionUpdate: params => this.sessions.onSessionUpdate(params, start.owner),
      onRequestPermission: params => this.sessions.onRequestPermission(params, start.owner),
      onCreateElicitation: params => this.sessions.onCreateElicitation(params, start.owner),
      onExit: () => {
        if (binding?.authority) {
          void start.processOwner?.stop().catch(error => {
            record.stopping = true;
            this.logger.warn({ agentId: this.family.agentId, err: error }, "exited execution group cleanup remains unconfirmed");
          });
        } else this.releaseWorkingCopy(binding);
        if (!start.owner) { start.exitedDuringStart = true; return; }
        this.sessions.closeAll("agent_exited", start.owner);
        this.observeExecutionExit(start.owner);
        // An execution exit does not reset control/login readiness, nor
        // automatically respawn an uncertain execution generation.
      },
    };
  }

  /**
   * Replace only a pre-ready bootstrap process whose exact stop already
   * completed. This is deliberately separate from recovery/finalization: no
   * prompt has crossed the bridge and the same assignment/reference retains
   * authority while its durable process owner is atomically replaced.
   */
  private replaceBootstrapExecutionBridge(
    ref: string,
    previous: BridgeProcess,
    bootstrapAttempt: number,
    lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"],
    cwd?: string,
    readOnlyRoots: readonly string[] = [],
  ): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    return this.acquireBootstrapExecutionBridge(ref, bootstrapAttempt, previous, lifecycle, cwd, readOnlyRoots);
  }

  /** Spawn/initialize belongs to the same four-attempt bootstrap budget as the
   * ACP mutation. Every failed candidate is stopped exactly and its durable
   * owner is advanced before another process is allowed to start. */
  private async acquireBootstrapExecutionBridge(
    ref: string,
    firstAttempt: number,
    previous: BridgeProcess | undefined,
    lifecycle?: SessionLifecycle,
    cwd?: string,
    readOnlyRoots: readonly string[] = [],
  ): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    const owners: { durablePrevious: RetainedProcessOwner | undefined } = { durablePrevious: previous ? this.retireBootstrapOwner(ref, previous, lifecycle) : undefined };
    return this.acquireOwnedBootstrapBridge(ref, firstAttempt, owners, lifecycle, cwd, readOnlyRoots);
  }

  private async acquireOwnedBootstrapBridge(ref: string, firstAttempt: number, owners: { durablePrevious: RetainedProcessOwner | undefined }, lifecycle: SessionLifecycle | undefined, cwd: string | undefined, readOnlyRoots: readonly string[]): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    for (let bootstrapAttempt = firstAttempt; bootstrapAttempt <= 4; bootstrapAttempt += 1) {
      const bridge = await this.bootstrapAttempt(ref, bootstrapAttempt, owners, lifecycle, cwd, readOnlyRoots);
      if (bridge) return { bridge, bootstrapAttempt };
      await this.bootstrapPause(ref, bootstrapAttempt);
    }
    throw new RemoteInstanceError("agent_unavailable", "Bootstrap bridge retry budget exhausted.", { retryable: true });
  }

  /** Fixed-authority children are replaced before the provider resumes with new roots. */
  private async rebindExecutionBridge(ref: string, previous: BridgeProcess, lifecycle: SessionLifecycle | undefined, cwd: string, readOnlyRoots: readonly string[], retirePrevious: () => Promise<void>): Promise<BridgeProcess> {
    const authority = this.workingCopyBindings.get(previous)?.authority;
    if (!authority) return previous;
    if (sameFileAuthority(authority, cwd, readOnlyRoots)) return previous;
    const owner = this.continuationOwner(ref, previous);
    const durablePrevious = this.continuationProcessOwner(owner, lifecycle);
    owner.stopping = true;
    try {
      try { await retirePrevious(); }
      finally { await previous.stop(); }
    }
    catch (error) {
      throw new RemoteInstanceError("recovery_required", "Previous file-authority process stop is unconfirmed.", { cause: error, diagnostic: "file_authority_rebind_stop_unconfirmed" });
    }
    lifecycle?.assertCurrent();
    owner.finalized = true;
    this.executionBridges.delete(ref);
    const replacement = await this.acquireOwnedBootstrapBridge(ref, 1, { durablePrevious }, lifecycle, cwd, readOnlyRoots);
    return replacement.bridge;
  }

  private continuationOwner(ref: string, previous: BridgeProcess): ExecutionOwner {
    const owner = this.executionBridges.get(ref);
    if (!owner || owner.live !== previous || owner.stopping || owner.finalized) {
      throw new RemoteInstanceError("recovery_required", "Continuation has no matching execution process owner.");
    }
    return owner;
  }

  private continuationProcessOwner(owner: ExecutionOwner, lifecycle: SessionLifecycle | undefined): RetainedProcessOwner {
    const durablePrevious = owner.durable?.retainedProcessOwner;
    if (!durablePrevious || !lifecycle?.replaceProcessOwner) {
      throw new RemoteInstanceError("recovery_required", "Durable continuation process-owner replacement is unavailable.");
    }
    return durablePrevious;
  }

  /** The confirmed-stopped pre-ready owner a replacement takes over; its durable owner is what the next candidate replaces. */
  private retireBootstrapOwner(ref: string, previous: BridgeProcess, lifecycle: SessionLifecycle | undefined): RetainedProcessOwner {
    const owner = this.executionBridges.get(ref);
    if (!owner || !this.stoppedPreReadyOwner(owner, previous)) {
      throw new RemoteInstanceError("recovery_required", "Bootstrap bridge replacement did not match one confirmed-stopped pre-ready owner.", {
        diagnostic: "bootstrap_bridge_replacement_invalid",
      });
    }
    const durablePrevious = owner.durable?.retainedProcessOwner;
    if (!durablePrevious || !lifecycle?.replaceProcessOwner) {
      throw new RemoteInstanceError("recovery_required", "Durable bootstrap process-owner replacement is unavailable.", {
        diagnostic: "bootstrap_process_owner_replacement_unavailable",
      });
    }
    owner.finalized = true;
    this.executionBridges.delete(ref);
    return durablePrevious;
  }

  private stoppedPreReadyOwner(owner: ExecutionOwner, previous: BridgeProcess): boolean {
    return (
      owner.live === previous && !owner.stopping && !owner.finalized && previous.exited && this.sessions.sessionsBoundTo(previous) === 0
    );
  }

  /** The initialized candidate, or null when this attempt failed in a way worth a fresh one (its process already stopped). */
  private async bootstrapAttempt(ref: string, bootstrapAttempt: number, owners: { durablePrevious: RetainedProcessOwner | undefined }, lifecycle: SessionLifecycle | undefined, cwd: string | undefined, readOnlyRoots: readonly string[]): Promise<BridgeProcess | null> {
    const persisted: { candidate?: RetainedProcessOwner } = {};
    const initializeStartedAt = Date.now();
    try {
      const bridge = await this.createExecutionBridge(ref, bootstrapLifecycle(lifecycle, owners, persisted), cwd, readOnlyRoots);
      this.logger.info({
        agentId: this.family.agentId,
        acpSessionRef: ref,
        bootstrapAttempt,
        bridgeInitializeDurationMs: Date.now() - initializeStartedAt,
      }, bootstrapAttempt === 1 ? "bootstrap bridge initialized" : "fresh bootstrap bridge initialized");
      return bridge;
    } catch (error) {
      const failedOwner = this.executionBridges.get(ref);
      // An explicit stop/recovery owns this reference now. Its settlement
      // promise is already waiting for the captured spawn and exact process;
      // bootstrap must neither stop it a second time nor replace its slot.
      if (failedOwner?.stopping) throw error;
      const stopConfirmed = await this.stopFailedBootstrapCandidate(failedOwner, ref, bootstrapAttempt, initializeStartedAt);
      if (persisted.candidate) owners.durablePrevious = persisted.candidate;
      this.finalizeFailedBootstrap(ref, failedOwner);
      const retryable = startupRetryable(error);
      const exhausted = !retryable || bootstrapAttempt === 4;
      this.logger.warn({
        agentId: this.family.agentId,
        acpSessionRef: ref,
        bootstrapAttempt,
        maxBootstrapAttempts: 4,
        bridgeInitializeDurationMs: Date.now() - initializeStartedAt,
        stopConfirmed,
        retryable,
        exhausted,
        ...startupErrorFields(error),
      }, "bootstrap bridge initialization failed");
      if (exhausted) throw error;
      return null;
    }
  }

  private finalizeFailedBootstrap(ref: string, failedOwner: ExecutionOwner | undefined): void {
    if (failedOwner) failedOwner.finalized = true;
    this.executionBridges.delete(ref);
  }

  /** Whether the failed candidate is known stopped; an unconfirmed stop needs recovery. */
  private async stopFailedBootstrapCandidate(failedOwner: ExecutionOwner | undefined, ref: string, bootstrapAttempt: number, initializeStartedAt: number): Promise<boolean> {
    if (!failedOwner?.process) return failedOwner === undefined || failedOwner.process === null;
    try {
      await failedOwner.process.stop();
      if (!failedOwner.process.exited) throw new RemoteInstanceError("recovery_required", "Bootstrap candidate stop returned without observed process exit.", {
        diagnostic: "bootstrap_initialize_stop_unconfirmed",
      });
      return true;
    } catch (stopError) {
      this.logger.error({ agentId: this.family.agentId, acpSessionRef: ref, bootstrapAttempt,
        bridgeInitializeDurationMs: Date.now() - initializeStartedAt, stopConfirmed: false,
        errorClass: classifyBridgeError(stopError).class,
        errorCode: stopError instanceof RemoteInstanceError ? stopError.code : "bridge_stop_failed",
        diagnostic: stopError instanceof RemoteInstanceError ? stopError.diagnostic : undefined },
      "bootstrap bridge initialize failed and exact candidate stop is unconfirmed");
      throw new RemoteInstanceError("recovery_required", "Bootstrap bridge initialization failed and its process stop is unconfirmed.", {
        cause: stopError, diagnostic: "bootstrap_initialize_stop_unconfirmed",
      });
    }
  }

  /** Exponential backoff with jitter before a fresh bootstrap bridge. */
  private async bootstrapPause(ref: string, bootstrapAttempt: number): Promise<void> {
    const delayMs = freshProcessDelayMs(bootstrapAttempt, this.options.retryRandom ?? Math.random);
    this.logger.warn({ agentId: this.family.agentId, acpSessionRef: ref, bootstrapAttempt,
      nextBootstrapAttempt: bootstrapAttempt + 1, maxBootstrapAttempts: 4, delayMs, recovery: "fresh_bridge" },
    "retrying bootstrap bridge initialization with exponential backoff");
    await this.retrySleep(delayMs);
  }

  private retrySleep(delayMs: number): Promise<void> {
    return (this.options.retrySleep ?? (delay => new Promise(resolve => setTimeout(resolve, delay))))(delayMs);
  }

  /** Same durable owner record per reference whether the process is new or resident. */
  private persistProcessOwner(process: BridgeStopOwner, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"]): Promise<void> {
    if (!lifecycle) return Promise.resolve();
    const persistence = process.retainedProcessOwner
      ? lifecycle.recordProcessOwner(process.retainedProcessOwner).then(() => lifecycle.assertCurrent())
      : Promise.reject(new RemoteInstanceError("recovery_required", "This platform has no durable execution-process owner adapter."));
    // A test/different adapter may not await this callback. Retain the
    // rejection for the create continuation without leaking it globally.
    void persistence.catch(() => undefined);
    return persistence;
  }

  private async adoptIdleExecutionBridge(ref: string, idle: IdleExecutionBridge, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"]): Promise<BridgeProcess> {
    const record = this.executionBridges.get(ref)!;
    // Register the exact stop target before any await, exactly as a spawn
    // does through `onProcessOwner`, so a concurrent stop of this reference
    // reaches this process.
    record.process = idle.durable;
    record.durable = idle.durable;
    record.live = idle.bridge;
    try {
      await this.persistProcessOwner(idle.durable, lifecycle);
    } catch (error) {
      // Mirror the spawn path: an unrecorded owner is never left running. The
      // stop is settled here, so the bootstrap failure path must not stop the
      // same process a second time or demand a further exit observation.
      await idle.durable.stop();
      record.process = null;
      throw error;
    }
    if (this.stopping || record.stopping || idle.bridge.exited) {
      await idle.bridge.stop();
      throw new RemoteInstanceError("agent_unavailable", "Execution bridge exited before reuse.");
    }
    this.logger.info({ agentId: this.family.agentId }, "reused the resident execution bridge for a new session");
    return idle.bridge;
  }

  /**
   * `finalize` is the qualified finalization the capacity refusal names. Pass
   * it only where the session is definitively gone — an idle sealed completion
   * that was released, or a closed non-completed session — never for a recovery
   * stop, whose quiescence is unproven and whose slot must stay held.
   */
  async stopExecutionBridge(ref: string, options?: { finalize?: boolean }): Promise<void> {
    await this.settleExecutionBridge(ref, { finalize: options?.finalize === true, retainIdle: false });
  }

  /**
   * A recovery-stopped reference the supervisor is finished with (Core
   * settled its turn, its exact process group is proven gone, and its session
   * record was forgotten) returns its capacity slot: its process exited. The
   * key stays, so the reference is never reused. Without this every forced
   * stop held a slot until the connector restarted.
   */
  finalizeRecoveredExecution(ref: string): boolean {
    const owner = this.executionBridges.get(ref);
    if (!owner || owner.finalized || !owner.stopping || owner.live?.exited !== true) return false;
    owner.finalized = true;
    return true;
  }

  /**
   * Qualified finalization of an idle sealed release. The caller has proven
   * (`SessionManager.releaseSealed`) that the session was an idle, settled
   * completion with no turn, operation or pending request, and awaited the
   * agent's close of it, so its healthy process may stay resident for the
   * next reference instead of exiting. A process still holding any session
   * the agent did not confirm closed (`sessionsBoundTo`) is stopped instead.
   * `retained` tells the caller whether it did; a stop proven earlier for the
   * same reference, a stopping runtime or an occupied idle slot all yield
   * `false` with the process stopped as before.
   */
  async releaseExecutionBridge(ref: string): Promise<{ retained: boolean }> {
    return this.settleExecutionBridge(ref, { finalize: true, retainIdle: true });
  }

  private async settleExecutionBridge(ref: string, options: { finalize: boolean; retainIdle: boolean }): Promise<{ retained: boolean }> {
    const owner = this.executionBridges.get(ref);
    if (!owner) throw new RemoteInstanceError("recovery_required", "Unknown native execution bridge owner.");
    owner.stopping = true;
    // Initialization may still be pending. Use the exact captured process now;
    // the stopping fence rejects any later successful initialization response.
    owner.stop ??= (owner.process ? Promise.resolve(owner.process) : owner.bridge).catch(error => {
      // A failed post-spawn continuation must not lose its actual stop owner.
      if (owner.process) return owner.process;
      throw error;
    }).then(async bridge => {
      if (options.retainIdle && this.parkIdleExecutionBridge(owner)) { owner.retained = true; return; }
      await bridge.stop();
    });
    const attempt = owner.stop;
    try {
      await attempt;
    } catch (error) {
      // Retain the owner and fence, but allow recovery to retry a failed stop.
      // An observer of an older attempt must not clear a newer in-flight one.
      if (owner.stop === attempt) owner.stop = null;
      throw error;
    }
    // Retain ownership. Process exit is not a qualified profile receipt, and
    // this method never authorizes reference reuse. Capacity is returned only
    // on an explicit qualified finalization, whose caller has already proven
    // the session is gone; a bare stop still holds its slot.
    if (options.finalize) owner.finalized = true;
    return { retained: owner.retained };
  }

  private async stopExecutionForAuthChange(): Promise<void> {
    const refs = [...this.executionBridges.keys()];
    // Start every synchronous session fence before awaiting any bridge. Failed
    // ACP settlement remains uncertain, but cannot prevent an exact-owner stop.
    await Promise.all(refs.map(ref => this.sessions.stopForRecovery(ref).catch(() => undefined)));
    const errors: unknown[] = [];
    try {
      for (const ref of refs) {
        try { await this.stopExecutionBridge(ref); } catch (error) { errors.push(error); }
      }
      try { await this.discardIdleExecutionBridge("auth_change"); } catch (error) { errors.push(error); }
    } finally {
      // Anything parked before this point was started under the old login. A
      // release that slipped past the drain still carries the old epoch, so
      // the next take discards it instead of serving a stale-auth process.
      this.authEpoch += 1;
    }
    if (errors.length) throw new AggregateError(errors, "Execution stop is uncertain after authentication change.");
  }

  /** Parks a healthy, unowned process in the single idle slot; `false` means stop it as before. */
  private parkIdleExecutionBridge(owner: ExecutionOwner): boolean {
    return (
      owner.live !== null && owner.durable !== null && this.parkIdle(owner.live, owner.durable)
    );
  }

  private parkIdle(bridge: BridgeProcess, durable: BridgeStopOwner): boolean {
    // A later reference must record this process's durable owner; without a
    // captured identity there is nothing to record, so the process stops.
    // A process bound to one working copy or fixed read authority keeps that
    // profile for its lifetime, so no other session reuses it.
    if (this.perWorkingCopy) return false;
    if (this.stopping || bridge.exited || durable.retainedProcessOwner === undefined || this.idleExecutionBridge !== null || this.sessions.sessionsBoundTo(bridge) !== 0) return false;
    const entry: IdleExecutionBridge = { bridge, durable, authEpoch: this.authEpoch, expiry: setTimeout(() => void this.expireIdleExecutionBridge(entry), this.idleExecutionBridgeTtlMs()) };
    entry.expiry.unref();
    this.idleExecutionBridge = entry;
    this.logger.info({ agentId: this.family.agentId }, "retained the idle execution bridge for the next session");
    return true;
  }

  private idleExecutionBridgeTtlMs(): number {
    const configured = this.options.idleExecutionBridgeTtlMs;
    const ttl = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_EXECUTION_BRIDGE_TTL_MS;
    // A heavy agent (Antigravity, about 350 MB a process) keeps its resident process for less.
    const own = this.host?.processLimits?.idleExecutionMs;
    return typeof own === "number" ? Math.min(ttl, own) : ttl;
  }

  /** Cheap liveness: our own child's observed exit and the login it was started under. */
  private takeIdleExecutionBridge(): IdleExecutionBridge | null {
    const entry = this.idleExecutionBridge;
    if (!entry) return null;
    this.idleExecutionBridge = null;
    clearTimeout(entry.expiry);
    if (this.stopping || entry.bridge.exited || entry.authEpoch !== this.authEpoch) {
      void entry.bridge.stop().catch(error => this.logger.warn({ err: error }, "stale idle execution bridge could not be stopped"));
      return null;
    }
    return entry;
  }

  private async discardIdleExecutionBridge(reason: string): Promise<void> {
    const entry = this.idleExecutionBridge;
    if (!entry) return;
    this.idleExecutionBridge = null;
    clearTimeout(entry.expiry);
    this.logger.info({ agentId: this.family.agentId, reason }, "stopping the idle execution bridge");
    await entry.bridge.stop();
  }

  private async expireIdleExecutionBridge(entry: IdleExecutionBridge): Promise<void> {
    if (this.idleExecutionBridge !== entry) return;
    try { await this.discardIdleExecutionBridge("idle_expired"); }
    catch (error) { this.logger.warn({ err: error }, "expired idle execution bridge could not be stopped"); }
  }

  private observeExecutionExit(bridge: BridgeProcess): void {
    const entry = this.idleExecutionBridge;
    if (!entry || entry.bridge !== bridge) return;
    this.idleExecutionBridge = null;
    clearTimeout(entry.expiry);
    this.logger.info({ agentId: this.family.agentId }, "idle execution bridge exited; dropped from the idle slot");
  }

  /**
   * A retained-owner stop is restart-only evidence: it signals a process by
   * durable identity, outside any live ownership. After an idle release that
   * identity may still be alive in this runtime — resident in the idle slot or
   * already serving a later reference — so signalling it would kill another
   * session's process. An idle match is stopped here first (the caller's
   * signal then proves it gone); a match under a live owner is refused.
   */
  async yieldRetainedProcess(owner: RetainedProcessOwner): Promise<void> {
    for (const [ref, record] of this.executionBridges) {
      if (!liveOwnerOf(record, owner)) continue;
      // Its own reference was already being stopped (a recovery stop whose
      // process stop did not finish on a loaded computer): nothing else owns
      // this process, so retry that exact stop rather than refuse for good.
      if (record.stopping && !record.retained) {
        this.logger.warn({ agentId: this.family.agentId, acpSessionRef: ref }, "retrying the unfinished stop of a fenced execution process");
        await this.stopExecutionBridge(ref);
        continue;
      }
      throw new RemoteInstanceError("recovery_required", "The retained execution process is live under a current local owner; a restart-only stop cannot signal it.");
    }
    const idle = this.idleExecutionBridge;
    if (idle?.durable.retainedProcessOwner && sameRetainedOwner(idle.durable.retainedProcessOwner, owner)) await this.discardIdleExecutionBridge("retained_stop");
  }

  readiness(): ConnectedAgentView {
    return projectReadiness({
      family: this.family,
      authMode: this.options.config.RUNNER_AUTH_MODE,
      connectionState: this.connectionState,
      initializeResult: this.bridge?.initializeResult ?? this.parkedInitializeResult,
      ...this.signInReadiness(),
      bridgeVersionCompatible: true,
      ...withoutUndefined({ hostAgentVersion: this.hostVersion(), tokenUsageObservable: this.tokenUsageObservable }),
      ...(this.providerAdminBlocked && !this.authRequired ? { providerAdminBlocked: true } : {}),
      ...this.readinessCommands(),
      lastProbeAt: this.lastProbeAt,
    });
  }

  /** A lost sign-in reads as signed out: no identity, and every credential needing a sign-in. */
  private signInReadiness(): Pick<Parameters<typeof projectReadiness>[0], "scope" | "identity" | "credentials"> {
    if (!this.authRequired) return { scope: this.scope, identity: this.identity, ...withoutUndefined({ credentials: this.credentials }) };
    return {
      scope: { ...this.scope, authIdentityFingerprint: null, scopeAttestedAt: null },
      identity: "logged_out",
      ...(this.credentials === undefined ? {} : { credentials: this.credentials.map(credential => ({ ...credential, state: "needs_sign_in" as const })) }),
    };
  }

  /** Only to a Core that takes 7.1 fields: an older Core's heartbeat is strict. */
  private readinessCommands(): { availableCommands?: NonNullable<ReturnType<AvailableCommandsStore["current"]>> } {
    const current = this.availableCommands.current();
    return this.hostSettings.coreAcceptsRouteBilling && current ? { availableCommands: current } : {};
  }

  /**
   * Whether this agent was signed in and the sign-in no longer works: a turn
   * failed on it, or a credential it holds needs signing in again (`sign_in_expired`,
   * as opposed to never signed in).
   */
  signInLost(): boolean {
    return (
      this.authRequired || (this.credentials?.some(credential => credential.state === "needs_sign_in") ?? false)
    );
  }

  utilization(): { activeSessions: number; activeTurns: number } {
    return { activeSessions: this.sessions.activeSessions, activeTurns: this.sessions.activeTurns };
  }

  /**
   * A host agent's stderr line that ends a session or a discovery at once (a
   * sign-in it needs, an admin setting that keeps Konteks tools out): the
   * identity is read again so readiness says so, not just the one failure.
   */
  private readStderrFailure(line: string): RemoteInstanceError | null {
    const failure = this.host!.stderrFailure!(line, this.options.config);
    if (failure && this.host?.identity && !this.stopping) this.probeInBackground();
    return failure;
  }

  /**
   * A discovery that failed for good may mean the agent's sign-in went away
   * outside Konteks (its home cleared, a token revoked): read the identity
   * again, so readiness stops saying ready while nothing can run.
   */
  private afterDiscoveryFailure(error: unknown): void {
    if (this.stopping) return;
    if (classifyBridgeError(error).class === "agent_auth_required") {
      this.authRequired = true;
      this.publishReadiness();
    }
    this.probeInBackground({ fresh: true });
  }

  /** An identity read nobody waits for; `stop()` still does, so none writes after it. */
  private probeInBackground(options: { fresh?: boolean } = {}): void {
    const probe = this.probe(false, false, options).then(() => undefined, () => undefined);
    this.backgroundProbes.add(probe);
    void probe.finally(() => this.backgroundProbes.delete(probe));
  }

  /**
   * The agent's offered models, read with one non-executing `session/new` at
   * most every TTL. Stale-while-revalidate: past the TTL the last good answer
   * for the same sign-in and bridge version is served at once (with how old
   * it is, `observedAgoMs`) while one shared refresh runs, and it is kept
   * when that refresh fails for a transient reason (a deadline on a loaded
   * computer, an internal error). A sign-in failure, a definite refusal or a
   * malformed answer drops it; a sign-in or version change is a new key.
   * Without that, one slow refresh would leave Core no offered models and every
   * delivery placement would fail.
   */
  async discoverModelCapability(configId: string): Promise<DiscoveredBridgeModelCapability> {
    const view = this.readiness();
    if (view.readiness !== "ready" || view.connectionState !== "ready" || view.authIdentityFingerprint === undefined) {
      throw new RemoteInstanceError("agent_auth_required", "Model capability discovery requires the current authenticated agent identity.");
    }
    const cacheKey = `${view.authIdentityFingerprint}\u0000${this.options.config.RUNNER_BRIDGE_VERSION}\u0000${configId}`;
    const entry = this.modelCapabilityEntry(cacheKey);
    const answer = entry.good ? this.cachedModelCapability(cacheKey, entry, entry.good, configId)
      : { capability: await (entry.refresh ?? this.refreshModelCapability(cacheKey, entry, configId)), at: this.now().getTime() };
    const offered = this.offerable(structuredClone(answer.capability));
    const ageMs = Math.max(0, this.now().getTime() - answer.at);
    return ageMs > 0 ? { ...offered, observedAgoMs: ageMs } : offered;
  }

  /** What may be offered under the host agent's settings (OpenCode's free models); everything for other agents. */
  private offerable(capability: DiscoveredBridgeModelCapability): DiscoveredBridgeModelCapability {
    const host = this.host;
    if (!host?.offersModel) return capability;
    return offerableModelCapability(capability, value => host.offersModel!(value, this.hostSettings), this.family);
  }

  /**
   * The cache entry for one sign-in, bridge version and config id. The
   * control plane supplies a reviewed config id, but keep the cache bounded
   * if that contract regresses. Oldest insertion is safe to evict.
   */
  private modelCapabilityEntry(cacheKey: string): ModelCapabilityEntry {
    const known = this.modelCapabilities.get(cacheKey);
    if (known) return known;
    if (this.modelCapabilities.size >= 16) {
      const oldest = this.modelCapabilities.keys().next().value as string | undefined;
      if (oldest) this.modelCapabilities.delete(oldest);
    }
    const entry: ModelCapabilityEntry = { good: null, refresh: null };
    this.modelCapabilities.set(cacheKey, entry);
    return entry;
  }

  /** The last good answer: fresh within the TTL, else served while one shared refresh reads it again. */
  private cachedModelCapability(cacheKey: string, entry: ModelCapabilityEntry, good: { capability: DiscoveredBridgeModelCapability; at: number }, configId: string): { capability: DiscoveredBridgeModelCapability; at: number } {
    const nowMs = this.now().getTime();
    if (nowMs - good.at < (this.options.modelCapabilityTtlMs ?? DEFAULT_MODEL_CAPABILITY_TTL_MS)) {
      this.logger.debug({ event: "model_capability.cache_hit", agentId: this.family.agentId, configId },
        "reusing authenticated ACP model capability");
      return good;
    }
    if (!entry.refresh) {
      this.logger.info({ event: "model_capability.revalidate", agentId: this.family.agentId, configId, ageMs: nowMs - good.at },
        "serving the last offered models while they are read again");
      void this.refreshModelCapability(cacheKey, entry, configId).catch(() => undefined);
    }
    return good;
  }

  private discoveryOptions(configId: string): Parameters<typeof discoverBridgeModelCapability>[0] {
    return {
      configId,
      workspaceRoot: this.options.config.RUNNER_WORKSPACE_DIR,
      spec: this.spec,
      initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
      // A background check, not a turn: never the 10 s session bootstrap deadline.
      sessionTimeoutMs: Math.max(this.sessionBootstrapTimeoutMs(), MODEL_DISCOVERY_MIN_SESSION_TIMEOUT_MS),
      clientVersion: this.options.config.RUNNER_BRIDGE_VERSION,
      logger: this.logger,
      ...withoutUndefined({ retrySleep: this.options.retrySleep, retryRandom: this.options.retryRandom }),
      spawn: this.spawnProcess,
      ...(this.host?.sessionMeta ? { sessionMeta: this.host.sessionMeta } : {}),
      ...(this.host?.stderrFailure ? { stderrFailure: (line: string) => this.readStderrFailure(line) } : {}),
    };
  }

  /** The discovery on a checked-out idle resident bridge, parked again only when it succeeded there. */
  private async discoverOnIdleBridge(discovery: Parameters<typeof discoverBridgeModelCapability>[0], idle: IdleExecutionBridge): Promise<DiscoveredBridgeModelCapability> {
    let succeeded = false;
    try {
      const result = await discoverBridgeModelCapability({ ...discovery, bridge: idle.bridge });
      succeeded = true;
      return result;
    } finally {
      if (!succeeded || !this.parkIdle(idle.bridge, idle.durable)) {
        await idle.bridge.stop().catch(error => this.logger.warn({
          errorClass: classifyBridgeError(error).class,
          errorCode: error instanceof RemoteInstanceError ? error.code : "bridge_stop_failed",
        }, "idle execution bridge could not be stopped after model capability discovery"));
      }
    }
  }

  /** One shared discovery for `entry`; settles the entry itself (see `discoverModelCapability`). */
  private refreshModelCapability(cacheKey: string, entry: ModelCapabilityEntry, configId: string): Promise<DiscoveredBridgeModelCapability> {
    // The periodic probe used to spawn and initialize its own throwaway
    // process. An idle resident bridge answers the same `session/new` without
    // that cost; it is checked out for the probe so no session can adopt it
    // meanwhile, and returned only when the probe succeeded on it. Only a
    // bridge that can close the probe's session is lent: one that cannot
    // would keep it open for good.
    const task = (async () => {
      await this.prepareToSpawn();
      const discovery = this.discoveryOptions(configId);
      this.logger.info({ event: "model_capability.cache_miss", agentId: this.family.agentId, configId },
        "discovering authenticated ACP model capability once");
      const closes = this.idleExecutionBridge?.bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close != null;
      const idle = closes ? this.takeIdleExecutionBridge() : null;
      return idle ? this.discoverOnIdleBridge(discovery, idle) : discoverBridgeModelCapability(discovery);
    })();
    entry.refresh = task;
    // Registered before any caller awaits `task`, so the entry is settled
    // (its answer kept, the refresh slot free) before any caller resumes.
    void task.then(capability => {
      if (entry.refresh === task) entry.refresh = null;
      if (this.modelCapabilities.get(cacheKey) === entry) entry.good = { capability, at: this.now().getTime() };
    }, (error: unknown) => {
      if (entry.refresh === task) entry.refresh = null;
      if (this.modelCapabilities.get(cacheKey) !== entry) return;
      if (entry.good && !definiteModelDiscoveryFailure(error)) {
        this.logger.warn({ event: "model_capability.kept", agentId: this.family.agentId, configId,
          ageMs: this.now().getTime() - entry.good.at, errorClass: classifyBridgeError(error).class,
          errorCode: error instanceof RemoteInstanceError ? error.code : "model_discovery_failed" },
        "reading the offered models again failed for a transient reason; keeping the last ones");
      } else {
        this.modelCapabilities.delete(cacheKey);
      }
      this.afterDiscoveryFailure(error);
    }).catch(() => undefined);
    return task;
  }

  /** Why this agent was taken out of service (the tripwire's line), or null (doctor). */
  quarantineReason(): string | null {
    return this.quarantined;
  }

  /**
   * Take this agent out of service for the life of the process: stop every
   * bridge, refuse new ones and read as unavailable. Used when a host agent
   * ran a gated tool without asking (its tool governance tripwire).
   */
  async quarantine(reason: string): Promise<void> {
    this.quarantined = reason;
    this.logger.error({ event: "agent.quarantined", agentId: this.family.agentId }, "agent taken out of service");
    this.connectionState = "failed";
    this.publishReadiness();
    const errors: unknown[] = [];
    for (const ref of this.executionBridges.keys()) {
      try { await this.stopExecutionBridge(ref); } catch (error) { errors.push(error); }
    }
    try { await this.discardIdleExecutionBridge("runtime_stop"); } catch (error) { errors.push(error); }
    this.clearControlIdleStop();
    await this.bridge?.stop();
    this.bridge = null;
    await this.sweepLeftovers();
    if (errors.length) this.logger.warn({ errors: errors.length }, "some bridges did not stop cleanly during quarantine");
  }

  /**
   * Before any bridge process starts: re-verify a bundled package, or let a
   * host-installed agent's adapter write the Konteks overlay or config it boots
   * from. Every dsh process reads those files at boot, so a changed copy heals
   * on the next spawn instead of leaving it unguarded.
   */
  private async prepareToSpawn(logger?: Pick<Logger, "info">): Promise<void> {
    await verifyNativeRunnerPackage(this.options.config, logger);
    await this.host?.prepareToSpawn(this.options.config);
  }

  /** The verified installed version of a host-installed agent, when known. */
  private hostVersion(): string | undefined {
    return hostAgentRunnerAdapter(this.family.agentId)?.hostVersion(this.options.config);
  }

  private assertNotQuarantined(): void {
    if (this.quarantined !== null) throw new RemoteInstanceError("agent_unavailable", this.quarantined);
  }

  /**
   * An agent with its own process limits (Antigravity) stops its control
   * process after `controlIdleMs` with nothing to do: it serves readiness and
   * sign-in only, sessions run in execution processes, and one costs about
   * 350 MB. Readiness keeps the `initialize` it answered; the next sign-in or
   * sign-out starts it again.
   */
  private scheduleControlIdleStop(): void {
    const idleMs = this.host?.processLimits?.controlIdleMs;
    this.clearControlIdleStop();
    if (idleMs === undefined || this.stopping) return;
    this.controlIdleTimer = setTimeout(() => void this.parkControlBridge().catch(error => this.logger.warn({ agentId: this.family.agentId, err: error }, "the idle control process could not be stopped")), idleMs);
    this.controlIdleTimer.unref();
  }

  private clearControlIdleStop(): void {
    if (this.controlIdleTimer) clearTimeout(this.controlIdleTimer);
    this.controlIdleTimer = null;
  }

  private async parkControlBridge(): Promise<void> {
    this.controlIdleTimer = null;
    const bridge = this.bridge;
    if (!bridge || bridge.exited || this.stopping || this.activeLogin !== null || this.bridgeStart !== null || this.connectionState !== "ready") return;
    this.parkedInitializeResult = bridge.initializeResult;
    // Detach first: its exit is then not read as the agent going away.
    this.bridge = null;
    this.logger.info({ agentId: this.family.agentId }, "stopping the idle control process");
    await bridge.stop();
  }

  async ensureBridge(): Promise<void> {
    this.assertNotQuarantined();
    if (this.stopping) return;
    if (this.bridgeStart) return this.bridgeStart;
    if (this.bridge && !this.bridge.exited) return;
    const starting = this.startBridge();
    this.bridgeStart = starting;
    try { await starting; }
    finally { if (this.bridgeStart === starting) this.bridgeStart = null; }
  }

  /** (Re)spawns the control bridge and performs the runner-local `initialize`, with up to four fresh attempts. */
  private async startBridge(): Promise<void> {
    this.clearControlIdleStop();
    // A control process stopped for being idle comes back without the agent reading as unavailable meanwhile.
    const resuming = this.parkedInitializeResult !== null && this.connectionState === "ready";
    if (!resuming) {
      this.connectionState = "starting";
      this.publishReadiness();
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const outcome = await this.controlBridgeAttempt(attempt);
      if (outcome === "done") return;
      if (outcome === "exhausted") break;
      await this.retrySleep(this.controlRetryDelay(attempt));
    }
    this.parkedInitializeResult = null;
    this.connectionState = "failed";
    this.publishReadiness();
  }

  /** "done" (started, stopping, or failed with its stop unconfirmed), "retry" or "exhausted". */
  private async controlBridgeAttempt(attempt: number): Promise<"done" | "retry" | "exhausted"> {
    // Callback authority belongs to this spawn, never whichever bridge
    // happens to be current when a deferred callback arrives.
    const start: { owner: BridgeProcess | null; provisional: BridgeStopOwner | null; exitedDuringStart: boolean } = { owner: null, provisional: null, exitedDuringStart: false };
    const initializeStartedAt = Date.now();
    try {
      await this.prepareToSpawn(this.logger);
      if (this.stopping) return "done";
      const candidate = await this.spawnProcess({
        spec: this.spec,
        initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
        clientVersion: this.options.config.RUNNER_BRIDGE_VERSION,
        logger: this.logger,
        onProcessOwner: process => { start.provisional = process; },
        handlers: this.controlHandlers(start),
      });
      start.owner = candidate;
      start.provisional ??= candidate;
      if (this.stopping) { await candidate.stop(); return "done"; }
      if (start.exitedDuringStart || candidate.exited) throw new RemoteInstanceError("agent_unavailable", "Bridge exited during initialization.", { retryable: true });
      this.adoptControlBridge(candidate, attempt, initializeStartedAt);
      return "done";
    } catch (error) {
      return this.failedControlAttempt(error, start.provisional, attempt, initializeStartedAt);
    }
  }

  private controlHandlers(start: { owner: BridgeProcess | null; exitedDuringStart: boolean }): BridgeClientHandlers {
    return {
      onSessionUpdate: (params) => this.sessions.onSessionUpdate(params, start.owner),
      onRequestPermission: (params) => this.sessions.onRequestPermission(params, start.owner),
      onCreateElicitation: (params) => this.sessions.onCreateElicitation(params, start.owner),
      onExit: (info) => {
        if (!start.owner) { start.exitedDuringStart = true; return; }
        this.sessions.closeAll("agent_exited", start.owner);
        if (this.bridge !== start.owner) return;
        this.connectionState = "exited";
        this.events.publish({ kind: "bridge_exited", code: info.code, signal: info.signal });
        this.publishReadiness();
        if (!this.stopping) setTimeout(() => void this.ensureBridge().catch(() => undefined), 2_000).unref();
      },
    };
  }

  private adoptControlBridge(candidate: BridgeProcess, attempt: number, initializeStartedAt: number): void {
    this.bridge = candidate;
    this.parkedInitializeResult = null;
    this.connectionState = "ready";
    this.logger.info({ agentId: this.family.agentId, attempt,
      bridgeInitializeDurationMs: Date.now() - initializeStartedAt }, "runner control bridge initialized");
    this.publishReadiness();
    this.scheduleControlIdleStop();
  }

  /** Stops the failed candidate first; a stop that cannot be confirmed leaves the agent failed. */
  private async failedControlAttempt(error: unknown, provisional: BridgeStopOwner | null, attempt: number, initializeStartedAt: number): Promise<"done" | "retry" | "exhausted"> {
    if (provisional) {
      try { await provisional.stop(); }
      catch (stopError) {
        this.connectionState = "failed";
        this.logger.error({ agentId: this.family.agentId, attempt, stopConfirmed: false,
          errorClass: classifyBridgeError(stopError).class,
          errorCode: stopError instanceof RemoteInstanceError ? stopError.code : "bridge_stop_failed" },
        "runner control bridge startup stop is unconfirmed");
        this.publishReadiness();
        return "done";
      }
    }
    const retryable = startupRetryable(error);
    const exhausted = !retryable || attempt === 4;
    this.logger.warn({ agentId: this.family.agentId, attempt, maxAttempts: 4,
      bridgeInitializeDurationMs: Date.now() - initializeStartedAt, stopConfirmed: true, retryable, exhausted,
      ...startupErrorFields(error) },
    "runner control bridge startup attempt failed");
    return exhausted ? "exhausted" : "retry";
  }

  private controlRetryDelay(attempt: number): number {
    const delayMs = freshProcessDelayMs(attempt, this.options.retryRandom ?? Math.random);
    this.logger.warn({ agentId: this.family.agentId, attempt, nextAttempt: attempt + 1,
      maxAttempts: 4, delayMs, recovery: "fresh_bridge" }, "retrying runner control bridge startup with exponential backoff");
    return delayMs;
  }

  /**
   * Readiness probe: connection state plus the official identity signal.
   * `isLogin` marks the probe that follows `auth login`, which is when the
   * `--organization` attestation may be recorded.
   */
  async probe(isLogin: boolean, organizationAttested = false, options: { fresh?: boolean } = {}): Promise<ConnectedAgentView> {
    const result = await this.readIdentity(options.fresh === true);
    this.noteIdentity(result, isLogin);
    const at = this.now().toISOString();
    this.lastProbeAt = at;
    const transition = applyIdentityObservation(this.scope, { fingerprint: this.observedFingerprint(result, isLogin), organizationAttested, at, isLogin });
    this.scope = transition.state;
    await this.scopeStore.write(this.scope);
    if (transition.kind === "reset") {
      this.events.publish({ kind: "agent_scope_reset", agentId: this.family.agentId, previousScope: transition.previousScope });
    } else if (transition.kind === "attested") {
      this.events.publish({ kind: "agent_scope_attested", agentId: this.family.agentId });
    }
    const view = this.readiness();
    this.events.publish({ kind: "readiness_changed", agent: view });
    return view;
  }

  /**
   * The official identity signal; a failed read is signed out. `fresh` reads
   * the sign-in through a process of its own, not the shared Codex
   * app-server, which keeps the sign-in it loaded at its start even after the
   * files under it are gone.
   */
  private async readIdentity(fresh: boolean): Promise<IdentityProbe> {
    try {
      await this.prepareToSpawn();
      const { RUNNER_NATIVE_CODEX_SOCKET: _shared, ...unshared } = this.options.config;
      return await (this.options.probe ?? probeIdentity)(fresh ? unshared : this.options.config, this.family, this.spec.env, {}, this.hostSettings);
    } catch (error) {
      this.logger.warn({ err: error }, "identity probe failed");
      return { kind: "logged_out" };
    }
  }

  private noteIdentity(result: IdentityProbe, isLogin: boolean): void {
    this.identity = result.kind;
    if (result.kind !== "no_official_signal" && result.credentials !== undefined) this.credentials = result.credentials;
    if (this.host?.identity) this.tokenUsageObservable = signalTokenUsage(result);
    this.providerAdminBlocked = result.kind === "signal" && result.providerAdminBlocked === true;
    if (isLogin && result.kind !== "logged_out") this.authRequired = false;
  }

  /** Without an official signal, a login is a new identity and anything else keeps the last one. */
  private observedFingerprint(result: IdentityProbe, isLogin: boolean): string | null {
    if (result.kind === "signal") return result.fingerprint;
    if (result.kind !== "no_official_signal") return null;
    return isLogin ? fallbackLoginIdentity() : this.scope.authIdentityFingerprint;
  }

  /** Starts the official login flow; completion re-probes readiness and applies the attestation. */
  startLogin(args: { organization: boolean; loginId?: string; personal?: boolean; request?: HostLoginRequest }): LoginFlow {
    // The person asking for their own login on their own machine (the site's
    // Log in, or `konteks-remote auth login` they ran) is not Konteks changing
    // their login behind their back.
    if (!(args.personal && this.personalLogin())) this.assertConnectorOwnedAuthentication();
    this.assertLoginMayStart();
    const previousConnectionState = this.connectionState;
    const host = hostAgentRunnerAdapter(this.family.agentId);
    const flow = this.loginFlow(host, args);
    this.activeLogin = flow;
    if (this.options.afterSuccessfulLogin) {
      this.connectionState = "starting";
      this.publishReadiness();
    }
    void flow.done.then(async ({ code, reason }) => {
      if (code !== 0) return this.afterFailedLogin(flow.loginId, previousConnectionState, host?.loginFailedMessage, reason);
      await this.afterSuccessfulLogin(flow.loginId, args.organization);
    }).catch(error => {
      this.activeLogin = null;
      this.connectionState = "failed";
      this.publishReadiness();
      this.logger.warn({ err: error }, "agent authentication transition failed");
      this.events.publish({ kind: "login_event", loginId: flow.loginId, event: { type: "failed", code: "agent_auth_required", message: "the agent login completed, but its local authentication refresh failed" } });
    });
    return flow;
  }

  private assertLoginMayStart(): void {
    if (this.activeLogin) {
      throw new RemoteInstanceError("temporarily_unavailable", "a login is already in progress for this agent");
    }
    if (this.options.afterSuccessfulLogin && this.sessions.activeSessions > 0) {
      throw new RemoteInstanceError("temporarily_unavailable", "Finish or recover active Codex sessions before signing in again.");
    }
  }

  /**
   * The official login tooling, or a host-installed agent's own sign-in
   * (DeepSeek Harness has no login command: the runtime asks for the API key
   * itself).
   */
  private loginFlow(host: HostAgentRunnerAdapter | undefined, args: { loginId?: string; request?: HostLoginRequest }): LoginFlow {
    const loginId = withoutUndefined({ loginId: args.loginId });
    if (host?.startLogin) {
      return host.startLogin({ config: this.options.config, events: this.events, logger: this.logger, spawn: this.options.spawn ?? spawnBridge,
        ...loginId, ...withoutUndefined({ request: args.request }) });
    }
    return startLoginFlow({ config: this.options.config, family: this.family, env: this.spec.env, events: this.events, logger: this.logger, ...loginId });
  }

  private async afterFailedLogin(loginId: string, previousConnectionState: ConnectedAgentView["connectionState"], message: string | undefined, reason: LoginFailureReason | undefined): Promise<void> {
    this.activeLogin = null;
    this.connectionState = previousConnectionState;
    this.events.publish({ kind: "login_event", loginId, event: { type: "failed", code: "agent_auth_required", message: message ?? "official login tooling did not complete", ...(reason ? { reason } : {}) } });
    await this.probe(false);
  }

  /** A bridge that caches auth at startup must observe the new login. */
  private async afterSuccessfulLogin(loginId: string, organization: boolean): Promise<void> {
    this.connectionState = "starting";
    this.publishReadiness();
    await this.stopExecutionForAuthChange();
    await this.bridge?.stop();
    this.bridge = null;
    await this.options.afterSuccessfulLogin?.();
    await this.ensureBridge();
    const view = await this.probe(true, organization);
    if (view.readiness === "ready") {
      this.events.publish({ kind: "login_event", loginId, event: { type: "completed", readiness: view.readiness } });
    } else {
      this.events.publish({ kind: "login_event", loginId, event: { type: "failed", code: "agent_auth_required", message: "official login returned without an authenticated local account; retry sign-in on this machine" } });
    }
    this.activeLogin = null;
  }

  loginInput(loginId: string, text: string): boolean {
    if (!this.activeLogin || this.activeLogin.loginId !== loginId) return false;
    this.activeLogin.input(text);
    return true;
  }

  async loginCancel(loginId: string): Promise<boolean> {
    if (!this.activeLogin || this.activeLogin.loginId !== loginId) return false;
    await this.activeLogin.cancel();
    return true;
  }

  async logout(request?: HostLoginRequest): Promise<ConnectedAgentView> {
    this.assertConnectorOwnedAuthentication();
    this.connectionState = "starting";
    this.publishReadiness();
    const stopping = this.stopExecutionForAuthChange().then(() => null, error => error);
    const host = hostAgentRunnerAdapter(this.family.agentId);
    // A refused sign-out (OpenCode: not signed in to that provider) still
    // brings the agent back before the refusal is returned.
    let logoutError: unknown = null;
    try {
      if (host?.logout) await host.logout(this.options.config, request, this.options.spawn ?? spawnBridge);
      else await runLogout({ config: this.options.config, family: this.family, env: this.spec.env });
    } catch (error) {
      logoutError = error;
    }
    const stopError = await stopping;
    await this.bridge?.stop();
    this.bridge = null;
    if (stopError) {
      this.connectionState = "failed";
      this.publishReadiness();
      throw stopError;
    }
    await this.ensureBridge();
    const view = await this.probe(false);
    if (logoutError !== null) throw logoutError;
    return view;
  }

  /** A native install signs in with the agent's own login in the person's own profile. */
  private personalLogin(): boolean {
    if (this.family.agentId === "codex") return this.options.config.RUNNER_NATIVE_CODEX_HOME !== undefined;
    if (this.family.agentId === "claude-code") return this.options.config.RUNNER_NATIVE_CLAUDE_EXECUTABLE !== undefined;
    return false;
  }

  private assertConnectorOwnedAuthentication(): void {
    if (this.options.config.RUNNER_NATIVE_CODEX_HOME) {
      throw new RemoteInstanceError("prerequisite_missing", "This runtime uses your normal local Codex profile. Manage login or logout in local Codex, then refresh runtime readiness. Konteks will not change your personal login.");
    }
    if (this.options.config.RUNNER_NATIVE_CLAUDE_EXECUTABLE) {
      throw new RemoteInstanceError("prerequisite_missing", "This runtime uses your installed Claude Code and its login. Run `claude auth login` or `claude auth logout` yourself, then refresh runtime readiness. Konteks will not change your personal login.");
    }
  }

  private publishReadiness(): void {
    try {
      this.events.publish({ kind: "readiness_changed", agent: this.readiness() });
    } catch (error) {
      this.logger.warn({ err: error }, "readiness projection failed");
    }
  }
}
