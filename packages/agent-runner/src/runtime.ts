import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteInstanceError, createLogger, writeSecretFile, type ConnectedAgentView, type Logger, type RetainedProcessOwner } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import { fallbackLoginIdentity, probeIdentity, type IdentityProbe } from "./auth/identity.js";
import { runLogout, startLoginFlow, type LoginFlow } from "./auth/login-flow.js";
import { AgentScopeStore, applyIdentityObservation, type AgentScopeState } from "./auth/scope-store.js";
import { classifyBridgeError, spawnBridge, type BridgeProcess, type BridgeStopOwner, type SpawnBridgeOptions } from "./bridge/process.js";
import { discoverBridgeModelCapability, type DiscoveredBridgeModelCapability } from "./bridge/model-capability.js";
import { resolveBridgeSpawnSpec, verifyNativeRunnerPackage, type BridgeSpawnSpec } from "./bridge/spec.js";
import type { RunnerConfig } from "./config.js";
import { RunnerEventBus } from "./events.js";
import { projectReadiness } from "./readiness.js";
import { SessionManager, type SessionRefStore } from "./sessions/manager.js";

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
}

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
  /** ACP exposes model choices only through session/new. Cache the immutable
   * capability by authenticated identity for this runtime lifetime so status
   * polling cannot create a visible Codex thread on every refresh. */
  private readonly modelCapabilities = new Map<string, Promise<DiscoveredBridgeModelCapability>>();
  private stopping = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.events = options.events ?? new RunnerEventBus();
    this.logger = options.logger ?? createLogger({ name: `runner-${options.config.RUNNER_AGENT_ID}` });
    this.now = options.now ?? (() => new Date());
    this.spec = resolveBridgeSpawnSpec(options.config);
    this.family = this.spec.family;
    this.scopeStore = new AgentScopeStore(options.config.RUNNER_CREDENTIAL_DIR);
    this.sessions = new SessionManager({
      bridge: () => this.bridge,
      ...(options.executionBridgeLimit ? { createBridge: (ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"]) => this.acquireBootstrapExecutionBridge(ref, 1, undefined, lifecycle) } : {}),
      ...(options.executionBridgeLimit ? { replaceBridge: (ref: string, previous: BridgeProcess, bootstrapAttempt: number, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"]) => this.replaceBootstrapExecutionBridge(ref, previous, bootstrapAttempt, lifecycle) } : {}),
      events: this.events,
      refStore: new FileSessionRefStore(join(options.config.RUNNER_CREDENTIAL_DIR, "session-refs.json")),
      bootstrapTimeoutMs: options.config.RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS,
      now: this.now,
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    await mkdir(this.options.config.RUNNER_CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
    await mkdir(this.options.config.RUNNER_WORKSPACE_DIR, { recursive: true });
    this.scope = await this.scopeStore.read();
    await this.ensureBridge();
    await this.probe(false);
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
    await this.bridge?.stop();
    this.bridge = null;
    this.connectionState = "exited";
    if (errors.length) throw new AggregateError(errors, "Native execution owners could not all be stopped.");
  }

  private createExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"]): Promise<BridgeProcess> {
    const limit = this.options.executionBridgeLimit?.();
    // Only unfinalized owners hold capacity; retained keys still refuse reuse.
    let held = 0;
    for (const owner of this.executionBridges.values()) if (!owner.finalized) held += 1;
    if (this.stopping || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || held >= limit || this.executionBridges.has(ref)) {
      return Promise.reject(new RemoteInstanceError("recovery_required", "Native execution owner capacity is unavailable; retained owners require qualified finalization."));
    }
    const bridge = Promise.resolve().then(async () => {
      await verifyNativeRunnerPackage(this.options.config);
      if (this.stopping || this.executionBridges.get(ref)!.stopping) throw new RemoteInstanceError("agent_unavailable", "Native execution owner is stopping.");
      // A resident process costs this reference one `session/new`; only when
      // none is idle does it pay the spawn plus ACP `initialize`.
      const idle = this.takeIdleExecutionBridge();
      return idle ? this.adoptIdleExecutionBridge(ref, idle, lifecycle) : this.spawnExecutionBridge(ref, lifecycle);
    });
    // Reserve the bounded owner before any executable await. Even a rejected
    // bootstrap retains its slot; no missing handle is interpreted as stopped.
    this.executionBridges.set(ref, { bridge, process: null, durable: null, live: null, stop: null, stopping: false, finalized: false, retained: false });
    return bridge;
  }

  private async spawnExecutionBridge(ref: string, lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"]): Promise<BridgeProcess> {
    const record = this.executionBridges.get(ref)!;
    let owner: BridgeProcess | null = null;
    let exitedDuringStart = false;
    let ownerPersistence: Promise<void> = Promise.resolve();
    const candidate = await (this.options.spawn ?? spawnBridge)({
      spec: this.spec, initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
      clientVersion: this.options.config.RUNNER_BRIDGE_VERSION, logger: this.logger,
      onProcessOwner: process => {
        record.process = process;
        record.durable = process;
        ownerPersistence = this.persistProcessOwner(process, lifecycle);
        return ownerPersistence;
      },
      ...(this.options.executionSpawnProcess ? { spawnProcess: this.options.executionSpawnProcess } : {}),
      // Callback authority is the initialized process object, which a later
      // reference reuses as-is: the session manager resolves every update,
      // permission, elicitation and exit to the sessions bound to exactly it.
      handlers: {
        onSessionUpdate: params => this.sessions.onSessionUpdate(params, owner),
        onRequestPermission: params => this.sessions.onRequestPermission(params, owner),
        onCreateElicitation: params => this.sessions.onCreateElicitation(params, owner),
        onExit: () => {
          if (!owner) { exitedDuringStart = true; return; }
          this.sessions.closeAll("agent_exited", owner);
          this.observeExecutionExit(owner);
          // An execution exit does not reset control/login readiness, nor
          // automatically respawn an uncertain execution generation.
        },
      },
    });
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
  ): Promise<{ bridge: BridgeProcess; bootstrapAttempt: number }> {
    return this.acquireBootstrapExecutionBridge(ref, bootstrapAttempt, previous, lifecycle);
  }

  /** Spawn/initialize belongs to the same four-attempt bootstrap budget as the
   * ACP mutation. Every failed candidate is stopped exactly and its durable
   * owner is advanced before another process is allowed to start. */
  private async acquireBootstrapExecutionBridge(
    ref: string,
    firstAttempt: number,
    previous: BridgeProcess | undefined,
    lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"],
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
        const bridge = await this.createExecutionBridge(ref, attemptLifecycle);
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
    if (this.stopping || bridge.exited || durable.retainedProcessOwner === undefined || this.idleExecutionBridge !== null || this.sessions.sessionsBoundTo(bridge) !== 0) return false;
    const entry: IdleExecutionBridge = { bridge, durable, authEpoch: this.authEpoch, expiry: setTimeout(() => void this.expireIdleExecutionBridge(entry), this.idleExecutionBridgeTtlMs()) };
    entry.expiry.unref();
    this.idleExecutionBridge = entry;
    this.logger.info({ agentId: this.family.agentId }, "retained the idle execution bridge for the next session");
    return true;
  }

  private idleExecutionBridgeTtlMs(): number {
    const configured = this.options.idleExecutionBridgeTtlMs;
    return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_EXECUTION_BRIDGE_TTL_MS;
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
      initializeResult: this.bridge?.initializeResult ?? null,
      scope: this.scope,
      identity: this.identity,
      bridgeVersionCompatible: true,
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
    const cached = this.modelCapabilities.get(cacheKey);
    if (cached) {
      this.logger.debug({ event: "model_capability.cache_hit", agentId: this.family.agentId, configId },
        "reusing authenticated ACP model capability");
      return structuredClone(await cached);
    }
    await verifyNativeRunnerPackage(this.options.config);
    const discovery = {
      configId,
      workspaceRoot: this.options.config.RUNNER_WORKSPACE_DIR,
      spec: this.spec,
      initializeTimeoutMs: this.options.config.RUNNER_INITIALIZE_TIMEOUT_MS,
      sessionTimeoutMs: this.options.config.RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS,
      clientVersion: this.options.config.RUNNER_BRIDGE_VERSION,
      logger: this.logger,
      ...(this.options.retrySleep ? { retrySleep: this.options.retrySleep } : {}),
      ...(this.options.retryRandom ? { retryRandom: this.options.retryRandom } : {}),
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
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
    this.modelCapabilities.set(cacheKey, pending);
    try { return structuredClone(await pending); }
    catch (error) {
      if (this.modelCapabilities.get(cacheKey) === pending) this.modelCapabilities.delete(cacheKey);
      throw error;
    }
  }

  /** (Re)spawns the bridge and performs the runner-local `initialize`. */
  async ensureBridge(): Promise<void> {
    if (this.stopping) return;
    if (this.bridgeStart) return this.bridgeStart;
    if (this.bridge && !this.bridge.exited) return;
    const starting = this.startBridge();
    this.bridgeStart = starting;
    try { await starting; }
    finally { if (this.bridgeStart === starting) this.bridgeStart = null; }
  }

  private async startBridge(): Promise<void> {
    this.connectionState = "starting";
    this.publishReadiness();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // Callback authority belongs to this spawn, never whichever bridge
      // happens to be current when a deferred callback arrives.
      let owner: BridgeProcess | null = null;
      let provisional: BridgeStopOwner | null = null;
      let exitedDuringStart = false;
      const initializeStartedAt = Date.now();
      try {
        await verifyNativeRunnerPackage(this.options.config);
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
        this.connectionState = "ready";
        this.logger.info({ agentId: this.family.agentId, attempt,
          bridgeInitializeDurationMs: Date.now() - initializeStartedAt }, "runner control bridge initialized");
        this.publishReadiness();
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
      await verifyNativeRunnerPackage(this.options.config);
      result = await (this.options.probe ?? probeIdentity)(this.options.config, this.family, this.spec.env);
    } catch (error) {
      this.logger.warn({ err: error }, "identity probe failed");
      result = { kind: "logged_out" };
    }
    this.identity = result.kind;
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
  startLogin(args: { organization: boolean; loginId?: string }): LoginFlow {
    this.assertConnectorOwnedAuthentication();
    if (this.activeLogin) {
      throw new RemoteInstanceError("temporarily_unavailable", "a login is already in progress for this agent");
    }
    const flow = startLoginFlow({
      config: this.options.config,
      family: this.family,
      env: this.spec.env,
      events: this.events,
      logger: this.logger,
      ...(args.loginId === undefined ? {} : { loginId: args.loginId }),
    });
    this.activeLogin = flow;
    void flow.done.then(async ({ code }) => {
      if (code !== 0) {
        this.activeLogin = null;
        this.events.publish({ kind: "login_event", loginId: flow.loginId, event: { type: "failed", code: "agent_auth_required", message: "official login tooling did not complete" } });
        await this.probe(false);
        return;
      }
      // A bridge that caches auth at startup must observe the new login.
      this.connectionState = "starting";
      this.publishReadiness();
      await this.stopExecutionForAuthChange();
      await this.bridge?.stop();
      this.bridge = null;
      await this.ensureBridge();
      const view = await this.probe(true, args.organization);
      this.events.publish({ kind: "login_event", loginId: flow.loginId, event: { type: "completed", readiness: view.readiness } });
      this.activeLogin = null;
    }).catch(error => {
      this.activeLogin = null;
      this.connectionState = "failed";
      this.publishReadiness();
      this.logger.warn({ err: error }, "agent authentication transition failed");
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

  async logout(): Promise<ConnectedAgentView> {
    this.assertConnectorOwnedAuthentication();
    this.connectionState = "starting";
    this.publishReadiness();
    const stopping = this.stopExecutionForAuthChange().then(() => null, error => error);
    await runLogout({ config: this.options.config, family: this.family, env: this.spec.env });
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
    return view;
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
