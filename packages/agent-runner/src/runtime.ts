import { mkdir, readFile } from "node:fs/promises";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { join } from "node:path";
import { RemoteInstanceError, createLogger, writeSecretFile, type ConnectedAgentCredential, type ConnectedAgentView, type Logger, type OpenCodeLoginOptionId, type RetainedProcessOwner } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import { fallbackLoginIdentity, probeIdentity, type IdentityProbe } from "./auth/identity.js";
import { runLogout, startLoginFlow, type LoginFlow } from "./auth/login-flow.js";
import { hostAgentRunnerAdapter } from "./host/registry.js";
import { DEFAULT_HOST_AGENT_SETTINGS, type HostAgentRunnerAdapter, type HostAgentSettings, type HostLoginRequest, type HostWorkingCopyBinding } from "./host/host-agent.js";
import { AgentScopeStore, applyIdentityObservation, type AgentScopeState } from "./auth/scope-store.js";
import { classifyBridgeError, spawnBridge, type BridgeProcess, type BridgeStopOwner, type SpawnBridgeOptions } from "./bridge/process.js";
import { discoverBridgeModelCapability, offerableModelCapability, type DiscoveredBridgeModelCapability } from "./bridge/model-capability.js";
import { resolveBridgeSpawnSpec, verifyNativeRunnerPackage, type BridgeSpawnSpec } from "./bridge/spec.js";
import type { RunnerConfig } from "./config.js";
import { RunnerEventBus } from "./events.js";
import { projectReadiness } from "./readiness.js";
import { SessionManager, type SessionRefStore, type TurnUsageLabel } from "./sessions/manager.js";
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
 * The offered models are re-read at least this often (System One §6a, KM6),
 * so a model the agent starts offering shows up without a restart. A sign-in
 * change re-reads at once: the account fingerprint is part of the cache key.
 */
export const DEFAULT_MODEL_CAPABILITY_TTL_MS = 5 * 60_000;

/** A wedged agent process must not outlive the conversation it served. */
export const DEFAULT_IDLE_EXECUTION_BRIDGE_TTL_MS = 30 * 60_000;

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

function sameRetainedOwner(a: RetainedProcessOwner, b: RetainedProcessOwner): boolean {
  return a.version === b.version && a.platform === b.platform && a.pid === b.pid && a.processGroupId === b.processGroupId &&
    a.startToken === b.startToken && a.commandDigest === b.commandDigest;
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
  /** ACP exposes model choices only through session/new. Cache the immutable
   * capability by authenticated identity for this runtime lifetime so status
   * polling cannot create a visible Codex thread on every refresh. */
  private readonly modelCapabilities = new Map<string, { at: number; pending: Promise<DiscoveredBridgeModelCapability> }>();
  private stopping = false;
  /** Set when the agent broke a governance guarantee; no bridge starts again in this process. */
  private quarantined: string | null = null;
  /** A host-installed agent's adapter (DeepSeek Harness, OpenCode); null for a bundled agent. */
  private readonly host: HostAgentRunnerAdapter | null;
  /** Each execution process of this agent serves one working copy and is never reused by another session (OpenCode). */
  private readonly perWorkingCopy: boolean;
  /** What each such process holds on its working copy, released when it exits. */
  private readonly workingCopyBindings = new WeakMap<BridgeProcess, HostWorkingCopyBinding>();
  /** Core's settings for host agents on this computer (free models, route billing). */
  private hostSettings: HostAgentSettings = DEFAULT_HOST_AGENT_SETTINGS;
  /** The credentials the last identity probe read (OpenCode's `auth list`); never a secret. */
  private credentials: ConnectedAgentCredential[] | undefined;
  /** The reviewed sign-ins the site may start here (OpenCode), read once the runtime started. */
  private siteLoginOptionIds: readonly OpenCodeLoginOptionId[] = [];
  /** Stops an idle control process (`processLimits.controlIdleMs`). */
  private controlIdleTimer: NodeJS.Timeout | null = null;
  /** What the control process answered before it was stopped for being idle; readiness keeps reading it. */
  private parkedInitializeResult: InitializeResponse | null = null;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.events = options.events ?? new RunnerEventBus();
    this.logger = options.logger ?? createLogger({ name: `runner-${options.config.RUNNER_AGENT_ID}` });
    this.now = options.now ?? (() => new Date());
    this.spec = resolveBridgeSpawnSpec(options.config);
    this.family = this.spec.family;
    this.host = hostAgentRunnerAdapter(this.family.agentId) ?? null;
    this.perWorkingCopy = this.host?.bindWorkingCopy !== undefined;
    if (this.perWorkingCopy && !options.executionBridgeLimit) {
      // Its control process has no working copy, so it never runs a session.
      throw new RemoteInstanceError("agent_unavailable", `${this.family.displayName} runs every session in a process of its own working copy.`);
    }
    this.scopeStore = new AgentScopeStore(options.config.RUNNER_CREDENTIAL_DIR);
    this.sessions = new SessionManager({
      bridge: () => this.bridge,
      ...(options.executionBridgeLimit ? { createBridge: (ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string) => this.acquireBootstrapExecutionBridge(ref, 1, undefined, lifecycle, cwd) } : {}),
      ...(options.executionBridgeLimit ? { replaceBridge: (ref: string, previous: BridgeProcess, bootstrapAttempt: number, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string) => this.replaceBootstrapExecutionBridge(ref, previous, bootstrapAttempt, lifecycle, cwd) } : {}),
      ...(this.perWorkingCopy ? { beforePrompt: (bridge: BridgeProcess) => this.workingCopyBindings.get(bridge)?.beforePrompt() } : {}),
      ...(this.host?.refusedSessionModes ? { refusedModes: this.host.refusedSessionModes } : {}),
      ...(this.host?.offersModel ? { modelAllowed: (value: string) => this.host!.offersModel!(value, this.hostSettings) } : {}),
      ...(this.host?.sessionMeta ? { sessionMeta: this.host.sessionMeta } : {}),
      ...(this.host?.verifySession ? { verifySession: (response: { configOptions?: unknown; modes?: unknown }) => this.host!.verifySession!(response) } : {}),
      ...(this.host?.promptPrelude ? { promptPrelude: (session: { cwd: string; sessionKey: string }) => this.host!.promptPrelude!(options.config, session) } : {}),
      ...(this.host?.agentErrorText ? { agentErrorText: (text: string) => this.host!.agentErrorText!(text) } : {}),
      usageLabel: modelValue => this.usageLabel(modelValue),
      events: this.events,
      refStore: new FileSessionRefStore(join(options.config.RUNNER_CREDENTIAL_DIR, "session-refs.json")),
      bootstrapTimeoutMs: this.sessionBootstrapTimeoutMs(),
      now: this.now,
      logger: this.logger,
      onAuthRequired: () => {
        this.authRequired = true;
        this.publishReadiness();
      },
    });
  }

  async start(): Promise<void> {
    await mkdir(this.options.config.RUNNER_CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
    await mkdir(this.options.config.RUNNER_WORKSPACE_DIR, { recursive: true });
    this.scope = await this.scopeStore.read();
    await this.ensureBridge();
    await this.probe(false);
    void this.refreshSiteLoginOptions();
  }

  /** The reviewed sign-ins the site may start on this machine (OpenCode); empty for every other agent. */
  siteLoginOptions(): readonly OpenCodeLoginOptionId[] {
    return this.siteLoginOptionIds;
  }

  private async refreshSiteLoginOptions(): Promise<void> {
    if (!this.host?.siteLoginOptions) return;
    try {
      this.siteLoginOptionIds = [...await this.host.siteLoginOptions(this.options.config)];
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
    if (previous.openCodeFreeModels === settings.openCodeFreeModels || !this.host?.offersModel) return;
    this.modelCapabilities.clear();
    if (this.connectionState !== "unavailable" && !this.stopping) await this.probe(false);
  }

  /** How one turn's usage is labelled (O7): sessions/usage-label.ts. */
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

  /** Execution processes that may live at once: the supervisor's ceiling, and the agent's own when lower (Antigravity: two, A12). */
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

  private createExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string): Promise<BridgeProcess> {
    const queueMs = this.host?.processLimits?.queueMs;
    return queueMs === undefined ? this.reserveExecutionBridge(ref, lifecycle, cwd) : this.queueForExecutionBridge(ref, Date.now() + queueMs, lifecycle, cwd);
  }

  /**
   * An agent with its own process ceiling (Antigravity) waits for a free
   * execution process instead of being refused at once: a session finishing
   * or its resident process being taken frees one. Past the wait it is
   * refused plainly; nothing was reserved.
   */
  private async queueForExecutionBridge(ref: string, until: number, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string): Promise<BridgeProcess> {
    for (let logged = false; ; logged = true) {
      const limit = this.executionLimit();
      if (this.stopping || this.authRequired || this.activeLogin !== null || this.executionBridges.has(ref) || typeof limit !== "number" || this.heldExecutionOwners() < limit) {
        return this.reserveExecutionBridge(ref, lifecycle, cwd);
      }
      if (Date.now() >= until) {
        throw new RemoteInstanceError("temporarily_unavailable", `${this.family.displayName} is already running ${limit} sessions on this computer. Try again when one of them finishes.`, { diagnostic: "execution_processes_busy" });
      }
      if (!logged) this.logger.info({ agentId: this.family.agentId, limit }, "a session waits for a free execution process");
      lifecycle?.assertCurrent();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private reserveExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string): Promise<BridgeProcess> {
    const limit = this.executionLimit();
    if (this.authRequired) return Promise.reject(new RemoteInstanceError("agent_auth_required", "Sign in to the selected local agent.", { recoveryActions: [{ kind: "login_agent", agentId: this.family.agentId }] }));
    if (this.activeLogin !== null) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "The local agent is signing in."));
    // Only unfinalized owners hold capacity; retained keys still refuse reuse.
    const held = this.heldExecutionOwners();
    if (this.stopping || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || held >= limit || this.executionBridges.has(ref)) {
      return Promise.reject(new RemoteInstanceError("recovery_required", "Native execution owner capacity is unavailable; retained owners require qualified finalization."));
    }
    const bridge = Promise.resolve().then(async () => {
      this.assertNotQuarantined();
      await this.prepareToSpawn(this.logger);
      if (this.stopping || this.executionBridges.get(ref)!.stopping) throw new RemoteInstanceError("agent_unavailable", "Native execution owner is stopping.");
      // A resident process costs this reference one `session/new`; only when
      // none is idle does it pay the spawn plus ACP `initialize`.
      const idle = this.perWorkingCopy ? null : this.takeIdleExecutionBridge();
      return idle ? this.adoptIdleExecutionBridge(ref, idle, lifecycle) : this.spawnExecutionBridge(ref, lifecycle, cwd);
    });
    // Reserve the bounded owner before any executable await. Even a rejected
    // bootstrap retains its slot; no missing handle is interpreted as stopped.
    this.executionBridges.set(ref, { bridge, process: null, durable: null, live: null, stop: null, stopping: false, finalized: false, retained: false });
    return bridge;
  }

  /**
   * The spawn spec of one execution process: the runtime's own, or for an
   * agent whose process serves one working copy (OpenCode), the environment
   * its adapter prepared for exactly `cwd`, held until that process exits.
   */
  private async executionSpec(cwd: string | undefined): Promise<{ spec: BridgeSpawnSpec; binding: HostWorkingCopyBinding | null }> {
    if (!this.perWorkingCopy) return { spec: this.spec, binding: null };
    if (cwd === undefined) throw new RemoteInstanceError("agent_unavailable", `${this.family.displayName} needs the session's working copy before it starts.`);
    const binding = await this.host!.bindWorkingCopy!(this.options.config, this.family, cwd);
    return { spec: { ...this.spec, env: binding.env }, binding };
  }

  private releaseWorkingCopy(binding: HostWorkingCopyBinding | null): void {
    if (binding) void binding.release().catch(error => this.logger.warn({ agentId: this.family.agentId, err: error }, "working copy preparation could not be removed"));
  }

  private async spawnExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], cwd?: string): Promise<BridgeProcess> {
    const record = this.executionBridges.get(ref)!;
    let owner: BridgeProcess | null = null;
    let exitedDuringStart = false;
    let ownerPersistence: Promise<void> = Promise.resolve();
    const { spec, binding } = await this.executionSpec(cwd);
    const candidate = await (this.options.spawn ?? spawnBridge)({
      spec, initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
      clientVersion: this.options.config.RUNNER_BRIDGE_VERSION, logger: this.logger,
      onProcessOwner: process => {
        record.process = process;
        record.durable = process;
        ownerPersistence = this.persistProcessOwner(process, lifecycle);
        return ownerPersistence;
      },
      ...(this.options.executionSpawnProcess ? { spawnProcess: this.options.executionSpawnProcess } : {}),
      ...(this.host?.stderrFailure ? { stderrFailure: (line: string) => this.host!.stderrFailure!(line) } : {}),
      // Callback authority is the initialized process object, which a later
      // reference reuses as-is: the session manager resolves every update,
      // permission, elicitation and exit to the sessions bound to exactly it.
      handlers: {
        onSessionUpdate: params => this.sessions.onSessionUpdate(params, owner),
        onRequestPermission: params => this.sessions.onRequestPermission(params, owner),
        onCreateElicitation: params => this.sessions.onCreateElicitation(params, owner),
        onExit: () => {
          this.releaseWorkingCopy(binding);
          if (!owner) { exitedDuringStart = true; return; }
          this.sessions.closeAll("agent_exited", owner);
          this.observeExecutionExit(owner);
          // An execution exit does not reset control/login readiness, nor
          // automatically respawn an uncertain execution generation.
        },
      },
    }).catch((error: unknown) => {
      // A process that never started never exits: undo its preparation here.
      this.releaseWorkingCopy(binding);
      throw error;
    });
    if (binding) this.workingCopyBindings.set(candidate, binding);
    await ownerPersistence;
    owner = candidate;
    record.process = candidate;
    record.live = candidate;
    record.durable ??= candidate;
    if (this.stopping || record.stopping || exitedDuringStart || candidate.exited) {
      await candidate.stop();
      throw new RemoteInstanceError("agent_unavailable", "Execution bridge exited during initialization.");
    }
    return candidate;
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
  ): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    return this.acquireBootstrapExecutionBridge(ref, bootstrapAttempt, previous, lifecycle, cwd);
  }

  /** Spawn/initialize belongs to the same four-attempt bootstrap budget as the
   * ACP mutation. Every failed candidate is stopped exactly and its durable
   * owner is advanced before another process is allowed to start. */
  private async acquireBootstrapExecutionBridge(
    ref: string,
    firstAttempt: number,
    previous: BridgeProcess | undefined,
    lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"],
    cwd?: string,
  ): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    let durablePrevious: RetainedProcessOwner | undefined;
    if (previous) {
      const owner = this.executionBridges.get(ref);
      if (!owner || owner.live !== previous || owner.stopping || owner.finalized || !previous.exited || this.sessions.sessionsBoundTo(previous) !== 0) {
        throw new RemoteInstanceError("recovery_required", "Bootstrap bridge replacement did not match one confirmed-stopped pre-ready owner.", {
          diagnostic: "bootstrap_bridge_replacement_invalid",
        });
      }
      durablePrevious = owner.durable?.retainedProcessOwner;
      if (!durablePrevious || !lifecycle?.replaceProcessOwner) {
        throw new RemoteInstanceError("recovery_required", "Durable bootstrap process-owner replacement is unavailable.", {
          diagnostic: "bootstrap_process_owner_replacement_unavailable",
        });
      }
      owner.finalized = true;
      this.executionBridges.delete(ref);
    }

    for (let bootstrapAttempt = firstAttempt; bootstrapAttempt <= 4; bootstrapAttempt += 1) {
      let persistedCandidate: RetainedProcessOwner | undefined;
      const attemptLifecycle = lifecycle ? {
        ...lifecycle,
        recordProcessOwner: async (candidate: RetainedProcessOwner) => {
          if (durablePrevious) {
            if (!lifecycle.replaceProcessOwner) throw new RemoteInstanceError("recovery_required", "Durable bootstrap process-owner replacement is unavailable.");
            await lifecycle.replaceProcessOwner(durablePrevious, candidate);
          } else {
            await lifecycle.recordProcessOwner(candidate);
          }
          persistedCandidate = candidate;
        },
      } : undefined;
      const initializeStartedAt = Date.now();
      try {
        const bridge = await this.createExecutionBridge(ref, attemptLifecycle, cwd);
        this.logger.info({
          agentId: this.family.agentId,
          acpSessionRef: ref,
          bootstrapAttempt,
          bridgeInitializeDurationMs: Date.now() - initializeStartedAt,
        }, bootstrapAttempt === 1 ? "bootstrap bridge initialized" : "fresh bootstrap bridge initialized");
        return { bridge, bootstrapAttempt };
      } catch (error) {
        const failedOwner = this.executionBridges.get(ref);
        // An explicit stop/recovery owns this reference now. Its settlement
        // promise is already waiting for the captured spawn and exact process;
        // bootstrap must neither stop it a second time nor replace its slot.
        if (failedOwner?.stopping) throw error;
        let stopConfirmed = failedOwner?.process === null || failedOwner === undefined;
        if (failedOwner?.process) {
          try {
            await failedOwner.process.stop();
            stopConfirmed = failedOwner.process.exited;
            if (!stopConfirmed) throw new RemoteInstanceError("recovery_required", "Bootstrap candidate stop returned without observed process exit.", {
              diagnostic: "bootstrap_initialize_stop_unconfirmed",
            });
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
        if (persistedCandidate) durablePrevious = persistedCandidate;
        if (failedOwner) failedOwner.finalized = true;
        this.executionBridges.delete(ref);
        const retryable = !(error instanceof RemoteInstanceError) || error.code === "agent_unavailable" || error.retryable;
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
          errorClass: classifyBridgeError(error).class,
          errorCode: error instanceof RemoteInstanceError ? error.code : "bridge_initialize_failed",
          diagnostic: error instanceof RemoteInstanceError ? error.diagnostic : undefined,
        }, "bootstrap bridge initialization failed");
        if (exhausted) throw error;
        const exponentialMs = 500 * (2 ** (bootstrapAttempt - 1));
        const delayMs = Math.min(2_000, Math.max(1, Math.round(exponentialMs * (0.75 + ((this.options.retryRandom ?? Math.random)() * 0.5)))));
        this.logger.warn({ agentId: this.family.agentId, acpSessionRef: ref, bootstrapAttempt,
          nextBootstrapAttempt: bootstrapAttempt + 1, maxBootstrapAttempts: 4, delayMs, recovery: "fresh_bridge" },
        "retrying bootstrap bridge initialization with exponential backoff");
        await (this.options.retrySleep ?? (delay => new Promise(resolve => setTimeout(resolve, delay))))(delayMs);
      }
    }
    throw new RemoteInstanceError("agent_unavailable", "Bootstrap bridge retry budget exhausted.", { retryable: true });
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
   * Qualified finalization of an idle sealed release. The caller has proven
   * (`SessionManager.releaseSealed`) that the session was an idle, settled
   * completion with no turn, operation or pending request, so its healthy
   * process may stay resident for the next reference instead of exiting.
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
    return owner.live !== null && owner.durable !== null && this.parkIdle(owner.live, owner.durable);
  }

  private parkIdle(bridge: BridgeProcess, durable: BridgeStopOwner): boolean {
    // A later reference must record this process's durable owner; without a
    // captured identity there is nothing to record, so the process stops.
    // A process serving one working copy (OpenCode) keeps that copy's
    // instructions and its sessions' MCP servers, so no other session reuses it.
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
    for (const record of this.executionBridges.values()) {
      const identity = record.durable?.retainedProcessOwner;
      if (!identity || record.finalized || record.durable!.exited || !sameRetainedOwner(identity, owner)) continue;
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
      scope: this.authRequired ? { ...this.scope, authIdentityFingerprint: null, scopeAttestedAt: null } : this.scope,
      identity: this.authRequired ? "logged_out" : this.identity,
      ...(this.credentials === undefined ? {} : { credentials: this.authRequired ? this.credentials.map(credential => ({ ...credential, state: "needs_sign_in" as const })) : this.credentials }),
      bridgeVersionCompatible: true,
      ...(this.hostVersion() === undefined ? {} : { hostAgentVersion: this.hostVersion()! }),
      lastProbeAt: this.lastProbeAt,
    });
  }

  utilization(): { activeSessions: number; activeTurns: number } {
    return { activeSessions: this.sessions.activeSessions, activeTurns: this.sessions.activeTurns };
  }

  async discoverModelCapability(configId: string): Promise<DiscoveredBridgeModelCapability> {
    const view = this.readiness();
    if (view.readiness !== "ready" || view.connectionState !== "ready" || view.authIdentityFingerprint === undefined) {
      throw new RemoteInstanceError("agent_auth_required", "Model capability discovery requires the current authenticated agent identity.");
    }
    const cacheKey = `${view.authIdentityFingerprint}\u0000${this.options.config.RUNNER_BRIDGE_VERSION}\u0000${configId}`;
    const nowMs = this.now().getTime();
    const ttlMs = this.options.modelCapabilityTtlMs ?? DEFAULT_MODEL_CAPABILITY_TTL_MS;
    let cached = this.modelCapabilities.get(cacheKey)?.pending;
    if (cached && nowMs - this.modelCapabilities.get(cacheKey)!.at >= ttlMs) {
      this.modelCapabilities.delete(cacheKey);
      cached = undefined;
    }
    if (cached) {
      this.logger.debug({ event: "model_capability.cache_hit", agentId: this.family.agentId, configId },
        "reusing authenticated ACP model capability");
      return structuredClone(await cached);
    }
    await this.prepareToSpawn();
    const discovery = {
      configId,
      workspaceRoot: this.options.config.RUNNER_WORKSPACE_DIR,
      spec: this.spec,
      initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
      sessionTimeoutMs: this.sessionBootstrapTimeoutMs(),
      clientVersion: this.options.config.RUNNER_BRIDGE_VERSION,
      logger: this.logger,
      ...(this.options.retrySleep ? { retrySleep: this.options.retrySleep } : {}),
      ...(this.options.retryRandom ? { retryRandom: this.options.retryRandom } : {}),
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      ...(this.host?.sessionMeta ? { sessionMeta: this.host.sessionMeta } : {}),
      ...(this.host?.stderrFailure ? { stderrFailure: (line: string) => this.host!.stderrFailure!(line) } : {}),
    };
    // The periodic probe used to spawn and initialize its own throwaway
    // process. An idle resident bridge answers the same `session/new` without
    // that cost; it is checked out for the probe so no session can adopt it
    // meanwhile, and returned only when the probe succeeded on it.
    const pending = (async () => {
      this.logger.info({ event: "model_capability.cache_miss", agentId: this.family.agentId, configId },
        "discovering authenticated ACP model capability once");
      const idle = this.takeIdleExecutionBridge();
      if (!idle) return discoverBridgeModelCapability(discovery);
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
    })();
    // The control plane supplies a reviewed config id, but keep the cache
    // bounded if that contract regresses. Oldest insertion is safe to evict.
    if (this.modelCapabilities.size >= 16) {
      const oldest = this.modelCapabilities.keys().next().value as string | undefined;
      if (oldest) this.modelCapabilities.delete(oldest);
    }
    this.modelCapabilities.set(cacheKey, { at: nowMs, pending });
    try {
      const offers = this.host?.offersModel;
      const capability = structuredClone(await pending);
      return offers ? offerableModelCapability(capability, value => offers(value, this.hostSettings), this.family) : capability;
    }
    catch (error) {
      if (this.modelCapabilities.get(cacheKey)?.pending === pending) this.modelCapabilities.delete(cacheKey);
      throw error;
    }
  }

  /** (Re)spawns the bridge and performs the runner-local `initialize`. */
  /**
   * Take this agent out of service for the life of the process: stop every
   * bridge, refuse new ones and read as unavailable. Used when DeepSeek
   * Harness ran a gated tool without asking (dsh-tool-governance.ts).
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
   * on the next spawn instead of leaving it unguarded (CP3 live proof, phase 2).
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

  private async startBridge(): Promise<void> {
    this.clearControlIdleStop();
    // A control process stopped for being idle comes back without the agent reading as unavailable meanwhile.
    const resuming = this.parkedInitializeResult !== null && this.connectionState === "ready";
    if (!resuming) {
      this.connectionState = "starting";
      this.publishReadiness();
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // Callback authority belongs to this spawn, never whichever bridge
      // happens to be current when a deferred callback arrives.
      let owner: BridgeProcess | null = null;
      let provisional: BridgeStopOwner | null = null;
      let exitedDuringStart = false;
      const initializeStartedAt = Date.now();
      try {
        await this.prepareToSpawn(this.logger);
        if (this.stopping) return;
        const candidate = await (this.options.spawn ?? spawnBridge)({
          spec: this.spec,
          initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
          clientVersion: this.options.config.RUNNER_BRIDGE_VERSION,
          logger: this.logger,
          onProcessOwner: process => { provisional = process; },
          handlers: {
            onSessionUpdate: (params) => this.sessions.onSessionUpdate(params, owner),
            onRequestPermission: (params) => this.sessions.onRequestPermission(params, owner),
            onCreateElicitation: (params) => this.sessions.onCreateElicitation(params, owner),
            onExit: (info) => {
              if (!owner) { exitedDuringStart = true; return; }
              this.sessions.closeAll("agent_exited", owner);
              if (this.bridge !== owner) return;
              this.connectionState = "exited";
              this.events.publish({ kind: "bridge_exited", code: info.code, signal: info.signal });
              this.publishReadiness();
              if (!this.stopping) setTimeout(() => void this.ensureBridge().catch(() => undefined), 2_000).unref();
            },
          },
        });
        owner = candidate;
        provisional ??= candidate;
        if (this.stopping || exitedDuringStart || candidate.exited) {
          if (this.stopping) { await candidate.stop(); return; }
          throw new RemoteInstanceError("agent_unavailable", "Bridge exited during initialization.", { retryable: true });
        }
        this.bridge = candidate;
        this.parkedInitializeResult = null;
        this.connectionState = "ready";
        this.logger.info({ agentId: this.family.agentId, attempt,
          bridgeInitializeDurationMs: Date.now() - initializeStartedAt }, "runner control bridge initialized");
        this.publishReadiness();
        this.scheduleControlIdleStop();
        return;
      } catch (error) {
        let stopConfirmed = provisional === null;
        if (provisional) {
          try { await provisional.stop(); stopConfirmed = true; }
          catch (stopError) {
            this.connectionState = "failed";
            this.logger.error({ agentId: this.family.agentId, attempt, stopConfirmed: false,
              errorClass: classifyBridgeError(stopError).class,
              errorCode: stopError instanceof RemoteInstanceError ? stopError.code : "bridge_stop_failed" },
            "runner control bridge startup stop is unconfirmed");
            this.publishReadiness();
            return;
          }
        }
        const classified = classifyBridgeError(error);
        const retryable = !(error instanceof RemoteInstanceError) || error.code === "agent_unavailable" || error.retryable;
        const exhausted = !retryable || attempt === 4;
        this.logger.warn({ agentId: this.family.agentId, attempt, maxAttempts: 4,
          bridgeInitializeDurationMs: Date.now() - initializeStartedAt, stopConfirmed, retryable, exhausted,
          errorClass: classified.class, errorCode: error instanceof RemoteInstanceError ? error.code : "bridge_initialize_failed" },
        "runner control bridge startup attempt failed");
        if (exhausted) break;
        const exponentialMs = 500 * (2 ** (attempt - 1));
        const delayMs = Math.min(2_000, Math.max(1, Math.round(exponentialMs * (0.75 + ((this.options.retryRandom ?? Math.random)() * 0.5)))));
        this.logger.warn({ agentId: this.family.agentId, attempt, nextAttempt: attempt + 1,
          maxAttempts: 4, delayMs, recovery: "fresh_bridge" }, "retrying runner control bridge startup with exponential backoff");
        await (this.options.retrySleep ?? (delay => new Promise(resolve => setTimeout(resolve, delay))))(delayMs);
      }
    }
    this.parkedInitializeResult = null;
    this.connectionState = "failed";
    this.publishReadiness();
  }

  /**
   * Readiness probe: connection state plus the official identity signal.
   * `isLogin` marks the probe that follows `auth login`, which is when the
   * `--organization` attestation may be recorded.
   */
  async probe(isLogin: boolean, organizationAttested = false): Promise<ConnectedAgentView> {
    let result: IdentityProbe;
    try {
      await this.prepareToSpawn();
      result = await (this.options.probe ?? probeIdentity)(this.options.config, this.family, this.spec.env, {}, this.hostSettings);
    } catch (error) {
      this.logger.warn({ err: error }, "identity probe failed");
      result = { kind: "logged_out" };
    }
    this.identity = result.kind;
    if (result.kind !== "no_official_signal" && result.credentials !== undefined) this.credentials = result.credentials;
    if (isLogin && (result.kind === "signal" || result.kind === "no_official_signal")) this.authRequired = false;
    const at = this.now().toISOString();
    this.lastProbeAt = at;
    const fingerprint =
      result.kind === "signal" ? result.fingerprint : result.kind === "no_official_signal" ? (isLogin ? fallbackLoginIdentity() : this.scope.authIdentityFingerprint) : null;
    const transition = applyIdentityObservation(this.scope, { fingerprint, organizationAttested, at, isLogin });
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

  /** Starts the official login flow; completion re-probes readiness and applies the attestation. */
  startLogin(args: { organization: boolean; loginId?: string; personal?: boolean; request?: HostLoginRequest }): LoginFlow {
    // The person asking for their own login on their own machine (the site's
    // Log in, or `konteks-remote auth login` they ran) is not Konteks changing
    // their login behind their back (WS1-115).
    if (!(args.personal && this.personalLogin())) this.assertConnectorOwnedAuthentication();
    if (this.activeLogin) {
      throw new RemoteInstanceError("temporarily_unavailable", "a login is already in progress for this agent");
    }
    if (this.options.afterSuccessfulLogin && this.sessions.activeSessions > 0) {
      throw new RemoteInstanceError("temporarily_unavailable", "Finish or recover active Codex sessions before signing in again.");
    }
    const previousConnectionState = this.connectionState;
    // A host-installed agent may own its sign-in (DeepSeek Harness has no
    // login command: the runtime asks for the API key itself).
    const host = hostAgentRunnerAdapter(this.family.agentId);
    const flow = host?.startLogin
      ? host.startLogin({ config: this.options.config, events: this.events, logger: this.logger,
        ...(args.loginId === undefined ? {} : { loginId: args.loginId }), ...(args.request === undefined ? {} : { request: args.request }) })
      : startLoginFlow({
        config: this.options.config,
        family: this.family,
        env: this.spec.env,
        events: this.events,
        logger: this.logger,
        ...(args.loginId === undefined ? {} : { loginId: args.loginId }),
      });
    this.activeLogin = flow;
    if (this.options.afterSuccessfulLogin) {
      this.connectionState = "starting";
      this.publishReadiness();
    }
    void flow.done.then(async ({ code }) => {
      if (code !== 0) {
        this.activeLogin = null;
        this.connectionState = previousConnectionState;
        this.events.publish({ kind: "login_event", loginId: flow.loginId, event: { type: "failed", code: "agent_auth_required", message: host?.loginFailedMessage ?? "official login tooling did not complete" } });
        await this.probe(false);
        return;
      }
      // A bridge that caches auth at startup must observe the new login.
      this.connectionState = "starting";
      this.publishReadiness();
      await this.stopExecutionForAuthChange();
      await this.bridge?.stop();
      this.bridge = null;
      await this.options.afterSuccessfulLogin?.();
      await this.ensureBridge();
      const view = await this.probe(true, args.organization);
      this.events.publish({ kind: "login_event", loginId: flow.loginId, event: { type: "completed", readiness: view.readiness } });
      this.activeLogin = null;
    }).catch(error => {
      this.activeLogin = null;
      this.connectionState = "failed";
      this.publishReadiness();
      this.logger.warn({ err: error }, "agent authentication transition failed");
      this.events.publish({ kind: "login_event", loginId: flow.loginId, event: { type: "failed", code: "agent_auth_required", message: "the agent login completed, but its local authentication refresh failed" } });
    });
    return flow;
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
      if (host?.logout) await host.logout(this.options.config, request);
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
