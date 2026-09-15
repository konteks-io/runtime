import { HeartbeatMessageSchema, REMOTE_INSTANCE_PROOF_AUDIENCE, RemoteInstanceError, signInstanceProof, type AgentModelOfferedValuesSnapshot, type Clock, type HeartbeatMessage, type HeartbeatResult, type InstanceKeyPair, type JsonValue, type Logger, createLogger } from "@konteks/remote-common";
import type { InventoryCollector } from "../inventory/collector.js";
import { computeUtilization, deriveAdvertisedRoles, type RoleBinding } from "../inventory/roles.js";
import type { SupervisorStore } from "../state/store.js";
import type { CoreClient } from "../core/client.js";
import type { LeaseAcquisition } from "../lease/lease.js";

/**
 * Durable monotonic heartbeat. The sequence is persisted before each send so
 * a restart never reuses a value Core would reject as replay. Inventory,
 * roles, and utilization are collected fresh; active assignment IDs come from
 * the journal.
 */
export interface HeartbeatOptions {
  store: SupervisorStore;
  clock: Clock;
  key: () => InstanceKeyPair;
  instanceId: () => string;
  runnerIncarnation: () => string;
  /** Lease renewal stays on signed HTTPS until a relay lease-result is contracted. */
  core: Pick<CoreClient, "heartbeat">;
  onResult: (result: HeartbeatResult, assertCurrent: () => void) => Promise<void>;
  captureLeaseFence?: () => () => void;
  withLeaseAcquisition?: LeaseAcquisition;
  onFailure: (error: unknown) => Promise<void>;
  inventory: Pick<InventoryCollector, "collect">;
  onInventory?: (agents: HeartbeatMessage["agents"]) => void;
  roleBindings: () => RoleBinding[];
  activeAssignmentIds: () => string[];
  modelCapabilitySnapshots?: () => readonly AgentModelOfferedValuesSnapshot[];
  configRevision: () => number;
  bundleVersion: string;
  softMaxConcurrent: () => number | undefined;
  acceptingWork: () => boolean;
  intervalSeconds: () => number;
  renewalDelayMs: () => number;
  logger?: Logger;
  /** Test override for the flight deadline; production derives it from the interval. */
  settleDeadlineMs?: number;
}

export type HeartbeatStage = "collect" | "sequence" | "request" | "adopt";
export interface HeartbeatLiveness {
  running: boolean;
  pendingFlight: boolean;
  stage: HeartbeatStage | null;
  inFlightSince: number | null;
  lastAttemptAt: number | null;
  lastSettledAt: number | null;
}

const MIN_SETTLE_DEADLINE_MS = 60_000;
const MAX_SETTLE_DEADLINE_MS = 10 * 60_000;

export class HeartbeatPublisher {
  private timer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;
  private lastRoles: string[] = [];
  private running = false;
  private stopped = false;
  private started: Promise<void> | null = null;
  private inFlight: Promise<HeartbeatMessage> | null = null;
  private pendingFlight = false;
  private stage: HeartbeatStage | null = null;
  private inFlightSince: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastSettledAt: number | null = null;

  constructor(private readonly options: HeartbeatOptions) {
    this.logger = options.logger ?? createLogger({ name: "heartbeat" });
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "Heartbeat publisher is stopped."));
    if (this.pendingFlight) return Promise.reject(new RemoteInstanceError("recovery_required", "A pending recovery heartbeat must settle before normal scheduling starts."));
    this.started ??= this.startImpl();
    return this.started;
  }

  private async startImpl(): Promise<void> {
    await this.options.store.heartbeatSequence();
    if (this.stopped) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Shutdown waits for state writes before releasing exclusive root ownership. */
  async settle(): Promise<void> {
    await this.started?.catch(() => undefined);
    await this.inFlight?.catch(() => undefined);
  }

  roles(): string[] {
    return [...this.lastRoles];
  }

  /** What a watchdog needs to tell a quiet publisher from a stuck one. */
  liveness(): HeartbeatLiveness {
    return { running: this.running, pendingFlight: this.pendingFlight, stage: this.stage, inFlightSince: this.inFlightSince,
      lastAttemptAt: this.lastAttemptAt, lastSettledAt: this.lastSettledAt };
  }

  /** How long a healthy publisher can go without a new attempt: a few
   * intervals plus one abandoned flight. */
  livenessBudgetMs(): number {
    return 4 * Math.max(1000, this.options.intervalSeconds() * 1000) + this.settleDeadlineMs();
  }

  private settleDeadlineMs(): number {
    return this.options.settleDeadlineMs ?? Math.min(MAX_SETTLE_DEADLINE_MS, Math.max(MIN_SETTLE_DEADLINE_MS, 2 * this.options.intervalSeconds() * 1000));
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    // One timer, bounded retry floor, and never postpone the lease deadline
    // behind a slower configured inventory cadence.
    const delay = Math.max(1000, Math.min(this.options.intervalSeconds() * 1000, this.options.renewalDelayMs(), 3_600_000));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish()
        .catch(() => this.logger.warn("heartbeat failed; retrying on the next bounded interval"));
    }, delay);
    this.timer.unref();
  }

  publish(): Promise<HeartbeatMessage> {
    if (!this.running) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "Heartbeat publisher is not running."));
    if (this.inFlight) return this.inFlight;
    return this.beginPublish(false);
  }

  /** Startup-only refresh after Core establishment/floor adoption. It neither
   * starts normal scheduling nor enables admission, even if acceptingWork is true.
   * Parent owns bounded retries and calls outside the lease-acquisition lane.
   */
  publishPending(): Promise<HeartbeatMessage> {
    if (this.stopped) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "Heartbeat publisher is stopped."));
    if (this.running || this.started) return Promise.reject(new RemoteInstanceError("recovery_required", "Pending heartbeat is only available before normal scheduling starts."));
    if (!this.options.captureLeaseFence || !this.options.withLeaseAcquisition) return Promise.reject(new RemoteInstanceError("recovery_required", "Pending heartbeat requires the current lease owner and acquisition lane."));
    if (this.inFlight) return this.inFlight;
    return this.beginPublish(true);
  }

  private beginPublish(pending: boolean): Promise<HeartbeatMessage> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingFlight = pending;
    const startedAt = Date.now();
    this.inFlightSince = startedAt;
    this.lastAttemptAt = startedAt;
    this.stage = null;
    const acquire = this.options.withLeaseAcquisition ?? (operation => operation());
    const flight = acquire(async () => {
      try { return await this.publishImpl(pending); }
      catch (error) {
        if (!this.stopped && (pending || this.running)) await this.options.onFailure(error);
        throw error;
      }
    });
    flight.catch(() => undefined);
    // A flight that never settled once held the recovery cycle, shutdown and
    // the lease lane hostage: the process stayed alive with no timers and no
    // log line for an hour. The flight now loses to a deadline that names the
    // stage it was in; the caller sees a retryable failure and the abandoned
    // flight can no longer block anyone.
    const deadlineMs = this.settleDeadlineMs();
    let deadlineTimer: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        this.logger.error({ pending, stage: this.stage ?? "lease", deadlineMs, elapsedMs: Date.now() - startedAt }, "heartbeat did not settle within its deadline; abandoning it");
        reject(new RemoteInstanceError("temporarily_unavailable", `Heartbeat did not settle within ${deadlineMs} ms (stage ${this.stage ?? "lease"}).`, { retryable: true }));
      }, deadlineMs);
      deadlineTimer.unref();
    });
    const settled: Promise<HeartbeatMessage> = Promise.race([flight, deadline]).finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (this.inFlight !== settled) return;
      this.inFlight = null;
      this.pendingFlight = false;
      this.stage = null;
      this.inFlightSince = null;
      this.lastSettledAt = Date.now();
      if (!pending) this.schedule();
    });
    this.inFlight = settled;
    return settled;
  }

  private async publishImpl(pending: boolean): Promise<HeartbeatMessage> {
    const assertLease = this.options.captureLeaseFence?.() ?? (() => undefined);
    const instanceId = this.options.instanceId();
    const runnerIncarnation = this.options.runnerIncarnation();
    const assertCurrent = () => {
      assertLease();
      if (this.stopped || (!pending && !this.running)) throw new RemoteInstanceError("temporarily_unavailable", "Heartbeat publisher is stopped.");
      if (this.options.instanceId() !== instanceId || this.options.runnerIncarnation() !== runnerIncarnation) throw new RemoteInstanceError("recovery_required", "Heartbeat process identity changed.");
    };
    assertCurrent();
    this.stage = "collect";
    const snapshot = await this.options.inventory.collect();
    assertCurrent();
    this.options.onInventory?.(snapshot.agents);
    const roles = deriveAdvertisedRoles(this.options.roleBindings(), snapshot.agents, { browserToolAvailable: snapshot.browserToolAvailable, gitVersion: snapshot.gitVersion });
    this.lastRoles = roles;
    const requiredHealthy = snapshot.components.every((component) => component.healthStatus === "healthy" || component.healthStatus === "degraded");
    const utilization = computeUtilization({
      hostPressure: snapshot.hostPressure,
      activeSessions: snapshot.activeSessions,
      activeTurns: snapshot.activeTurns,
      ...(this.options.softMaxConcurrent() === undefined ? {} : { softMaxConcurrent: this.options.softMaxConcurrent() as number }),
      acceptingWork: !pending && this.options.acceptingWork() && requiredHealthy,
    });
    this.stage = "sequence";
    const sequence = await this.options.store.allocateHeartbeatSequence();
    assertCurrent();
    const message: HeartbeatMessage = HeartbeatMessageSchema.parse({
      instanceId,
      runnerIncarnation,
      sequence,
      observedAt: this.options.clock.nowIso(),
      components: snapshot.components,
      agents: snapshot.agents,
      roles,
      roleBindings: this.options.roleBindings(),
      utilization,
      activeAssignmentIds: this.options.activeAssignmentIds().slice(0, 256),
      configRevision: this.options.configRevision(),
      bundleVersion: this.options.bundleVersion,
      ...(this.options.modelCapabilitySnapshots ? { modelCapabilitySnapshots: this.options.modelCapabilitySnapshots() } : {}),
    });
    // The wire carries a top-level `signature` and no `proof` envelope, but the
    // bytes signed are the instance proof's: binding the audience, the
    // operation and the body keeps a heartbeat signature from being replayed
    // at another endpoint. Core derives the same nonce from the sequence.
    const { signature } = signInstanceProof(
      this.options.key(),
      { method: "heartbeat", audience: REMOTE_INSTANCE_PROOF_AUDIENCE, subject: message.instanceId, body: message as unknown as { [key: string]: JsonValue } },
      `seq:${message.sequence}`,
    );
    this.stage = "request";
    const result = await this.options.core.heartbeat({ ...message, signature });
    // Preserve ordinary shutdown's no-adoption behavior; a pending refresh must
    // reject rather than let its caller infer that recovery connectivity is ready.
    if (!pending && !this.running) return message;
    assertCurrent();
    this.stage = "adopt";
    await this.options.onResult(result, assertCurrent);
    assertCurrent();
    return message;
  }
}
