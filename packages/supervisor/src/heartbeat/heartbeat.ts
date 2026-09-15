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
}

export class HeartbeatPublisher {
  private timer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;
  private lastRoles: string[] = [];
  private running = false;
  private stopped = false;
  private started: Promise<void> | null = null;
  private inFlight: Promise<HeartbeatMessage> | null = null;
  private pendingFlight = false;

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
    const acquire = this.options.withLeaseAcquisition ?? (operation => operation());
    this.inFlight = acquire(async () => {
      try { return await this.publishImpl(pending); }
      catch (error) {
        if (!this.stopped && (pending || this.running)) await this.options.onFailure(error);
        throw error;
      }
    }).finally(() => {
      this.inFlight = null;
      this.pendingFlight = false;
      if (!pending) this.schedule();
    });
    return this.inFlight;
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
    const result = await this.options.core.heartbeat({ ...message, signature });
    // Preserve ordinary shutdown's no-adoption behavior; a pending refresh must
    // reject rather than let its caller infer that recovery connectivity is ready.
    if (!pending && !this.running) return message;
    assertCurrent();
    await this.options.onResult(result, assertCurrent);
    assertCurrent();
    return message;
  }
}
