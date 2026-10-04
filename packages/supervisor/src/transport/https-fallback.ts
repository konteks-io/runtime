import { RemoteInstanceError, allEqual, createLogger, type Logger } from "@konteks/remote-common";
import type { AssignmentSender } from "../work/assignment-sender.js";
import type { CoreClient } from "../core/client.js";
import type { ControlPlaneTransport, InboundHandler, OutboundMessage } from "./transport.js";
import { RecoveryAuthority } from "./recovery-authority.js";

/**
 * HTTPS-only fallback with identical semantics: heartbeat, pull/claim/report,
 * observations, and control acks are POSTed to Core's private endpoints;
 * `to_runtime` messages (work available, claim/report acks, directives,
 * session frames) are polled. Idempotency keys are the same as on the relay,
 * so a message duplicated across a transport switch converges.
 */
interface HttpsFallbackOptions {
  /** Exact accepted-generation identity; null/omitted keeps work traffic gated. */
  recoveryAuthority?: () => string | null;
  core: CoreClient;
  /**
   * The durable logical sender. Present exactly where the incompatible 2.0
   * protocol is active: it retains each request's frame and sequence before the
   * first send, so an uncertain outcome replays the same bytes. Absent, this
   * transport keeps the 1.0 bare routes, which Core refuses under 2.0 — the
   * cutover is a composition choice, never a heuristic on the reply shape.
   */
  sender?: AssignmentSender;
  /** Native sessions use durable relay replay; Core has no legacy session polling routes. */
  relayOnlySessions?: boolean;
  instanceId: () => string;
  pollIntervalMs: number;
  /** A heartbeat response may carry the renewed lease (there is no separate renewal route). */
  onLease?: (lease: string) => Promise<void>;
  logger?: Logger;
}

type InboundBody = Parameters<InboundHandler>[0]["body"];
type AssignmentRequest = NonNullable<OutboundMessage["assignmentRequest"]>;
type Eligible = { message: OutboundMessage; index: number };

/** What one delivery checks between its steps, and how it hands Core's reply to the domain. */
interface DeliveryContext {
  assertRecovery: () => void;
  deliverResponse: (body: InboundBody) => Promise<void>;
}

const MAX_DELIVERIES_PER_DRAIN = 8;

function sameAssignmentRequest(existing: OutboundMessage, channelId: string, reference: AssignmentRequest): boolean {
  const other = existing.assignmentRequest;
  return existing.channelId === channelId && other !== undefined && allEqual([
    [other.requestSequence, reference.requestSequence], [other.requestDigest, reference.requestDigest], [other.requestKind, reference.requestKind],
  ]);
}

/** An assignment message already queued with the same report or claim id. */
function queuedAssignment(pending: readonly OutboundMessage[], field: "reportId" | "claimId", value: string | undefined): boolean {
  return Boolean(value) && pending.some(existing => existing.channel === "assignment" && (existing.body as Record<string, unknown>)[field] === value);
}

export class HttpsFallbackTransport implements ControlPlaneTransport {
  readonly kind = "https" as const;
  private handler: InboundHandler | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollFlight: Promise<void> | null = null;
  private running = false;
  private readonly logger: Logger;
  private readonly pending: OutboundMessage[] = [];
  private draining = false;
  private readonly recovery: RecoveryAuthority;
  private preparedRetryTimer: NodeJS.Timeout | null = null;
  private deliveryRetryTimer: NodeJS.Timeout | null = null;
  private preparedStopped = false;
  private preparedEpoch = 0;
  private preparedRetryBlocked = false;
  private assignmentHousekeepingNeeded = true;
  private assignmentHousekeepingFlight: Promise<void> | null = null;
  available = true;

  constructor(private readonly options: HttpsFallbackOptions) {
    this.logger = options.logger ?? createLogger({ name: "https-fallback" });
    this.recovery = new RecoveryAuthority(options.recoveryAuthority);
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  openChannel(): void {
    // Channels are implicit over HTTPS; session channels are polled by channelId.
  }

  closeChannel(): void {}

  start(): void {
    if (this.running) return;
    this.startPreparedAssignments();
    this.running = true;
    void this.housekeepAssignments();
    void this.runPollCycle();
  }

  stop(): void {
    this.pauseOrdinaryPolling();
    this.preparedStopped = true; this.preparedEpoch++;
    if (this.preparedRetryTimer) clearTimeout(this.preparedRetryTimer);
    if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
    this.preparedRetryTimer = null;
    this.deliveryRetryTimer = null;
  }

  pauseOrdinaryPolling(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  send(message: OutboundMessage): void {
    if (this.options.relayOnlySessions && message.channel === "session") {
      throw new RemoteInstanceError("protocol_incompatible", "Native session frames require durable relay replay.");
    }
    if (this.alreadyQueued(message)) return;
    this.pending.push(message);
    void this.drain();
  }

  private alreadyQueued(message: OutboundMessage): boolean {
    const reference = message.assignmentRequest;
    if (reference) return this.pending.some(existing => sameAssignmentRequest(existing, message.channelId, reference));
    if (message.channel !== "assignment") return false;
    const identity = message.body as { reportId?: string; claimId?: string };
    return queuedAssignment(this.pending, "reportId", identity.reportId) || queuedAssignment(this.pending, "claimId", identity.claimId);
  }

  /** Owner calls only after durable receipt acceptance; the predicate is rechecked. */
  resumeAfterRecovery(): void { this.preparedRetryBlocked = false; void this.drain(); }

  startPreparedAssignments(): void { this.preparedStopped = false; this.resumePreparedAssignments(); }
  resumePreparedAssignments(): void {
    this.preparedRetryBlocked = false;
    if (!this.preparedStopped) void this.drain(true);
  }

  private schedulePreparedRetry(): void {
    if (this.preparedStopped || this.preparedRetryBlocked || this.preparedRetryTimer || !this.recovery.permits("assignment") ||
      !this.pending.some(message => message.assignmentRequest)) return;
    this.preparedRetryTimer = setTimeout(() => { this.preparedRetryTimer = null; void this.drain(true); }, this.retryDelay());
    this.preparedRetryTimer.unref();
  }

  private scheduleDeliveryRetry(): void {
    if (this.preparedStopped || this.deliveryRetryTimer || this.pending.length === 0) return;
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = null;
      void this.drain();
    }, this.retryDelay());
    this.deliveryRetryTimer.unref();
  }

  /** The poll interval, kept between 250 ms and 30 s. */
  private retryDelay(): number {
    const configured = this.options.pollIntervalMs;
    return Number.isFinite(configured) ? Math.min(30_000, Math.max(250, configured)) : 5_000;
  }

  private async drain(preparedOnly = false): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const attempted = new Set<OutboundMessage>();
    try {
      for (let deliveries = 0; this.pending.length > 0 && deliveries < MAX_DELIVERIES_PER_DRAIN; deliveries += 1) {
        const next = this.nextDelivery(preparedOnly, attempted);
        if (next === undefined) break;
        attempted.add(next.message);
        const delivered = await this.deliver(next.message);
        this.available = delivered;
        if (delivered) this.pending.splice(next.index, 1);
      }
    } finally {
      this.draining = false;
      this.schedulePreparedRetry();
      this.scheduleDeliveryRetry();
    }
  }

  /**
   * A blocked work item must not prevent bounded control/heartbeat recovery.
   * Prepared frames retain their original sequence lane. Protocol-1 messages
   * have no such cross-request ordering and may be prioritized: fresh
   * pull/claim work must never expire behind stale report retries.
   */
  private nextDelivery(preparedOnly: boolean, attempted: ReadonlySet<OutboundMessage>): Eligible | undefined {
    const eligible = this.pending.map((message, index) => ({ message, index }))
      .filter(({ message }) => (!preparedOnly || message.assignmentRequest) && !attempted.has(message) && this.preparedOpen(message) && this.recovery.permits(message.channel));
    return this.options.sender ? eligible[0] : this.firstByPriority(eligible);
  }

  private preparedOpen(message: OutboundMessage): boolean {
    return !message.assignmentRequest || (!this.preparedStopped && !this.preparedRetryBlocked);
  }

  private firstByPriority(eligible: Eligible[]): Eligible | undefined {
    return eligible.reduce<Eligible | undefined>((best, candidate) => {
      if (!best) return candidate;
      return this.deliveryPriority(candidate.message) < this.deliveryPriority(best.message) ? candidate : best;
    }, undefined);
  }

  private deliveryPriority(message: OutboundMessage): number {
    if (message.channel === "heartbeat" || message.channel === "control") return 0;
    if (message.channel !== "assignment") return message.channel === "session" ? 3 : 5;
    const body = message.body as { claimId?: string; reportId?: string; maxItems?: number };
    if (body.claimId !== undefined && body.reportId === undefined) return 1;
    if (body.maxItems !== undefined) return 2;
    return 4;
  }

  private async deliver(message: OutboundMessage): Promise<boolean> {
    const instanceId = this.options.instanceId();
    try {
      await this.deliverOn(message, instanceId, this.deliveryContext(message));
      return true;
    } catch (error) {
      if (message.assignmentRequest && error instanceof RemoteInstanceError && !error.retryable) this.preparedRetryBlocked = true;
      this.logger.warn({ channel: message.channel, err: error }, "https fallback delivery failed; will retry");
      return false;
    }
  }

  private deliveryContext(message: OutboundMessage): DeliveryContext {
    const recovery = this.recovery.capture(message.channel), preparedEpoch = this.preparedEpoch;
    const assertRecovery = () => {
      recovery();
      if (message.assignmentRequest && (this.preparedStopped || preparedEpoch !== this.preparedEpoch)) {
        throw new RemoteInstanceError("recovery_required", "Prepared assignment carrier stopped during delivery.");
      }
    };
    const deliverResponse = async (body: InboundBody): Promise<void> => {
      assertRecovery();
      if (!this.handler) throw new RemoteInstanceError("recovery_required", "No domain reply consumer is attached.");
      await this.handler({ channel: message.channel, channelId: message.channelId, body,
        ...(message.assignmentRequest ? { assignmentRequest: message.assignmentRequest } : {}) } as Parameters<InboundHandler>[0]);
      assertRecovery();
    };
    return { assertRecovery, deliverResponse };
  }

  private async deliverOn(message: OutboundMessage, instanceId: string, context: DeliveryContext): Promise<void> {
    switch (message.channel) {
      case "heartbeat":
        return this.deliverHeartbeat(message);
      case "assignment":
        return this.deliverAssignment(message, instanceId, context);
      case "observation":
        await this.options.core.observations(instanceId, [message.body]);
        context.assertRecovery();
        return;
      case "control":
        await this.options.core.controlAck(instanceId, { ...(message.body as object), signature: message.signature });
        return;
      case "session":
        return this.deliverSession(message, instanceId, context);
      default:
        // Support is a relay-only stream; over HTTPS-only it stays closed.
        return;
    }
  }

  private async deliverHeartbeat(message: OutboundMessage): Promise<void> {
    const result = await this.options.core.heartbeat({ ...(message.body as Omit<Parameters<typeof this.options.core.heartbeat>[0], "signature">), signature: message.signature ?? "" });
    if (result.lease && this.options.onLease) await this.options.onLease(result.lease);
  }

  private async deliverAssignment(message: OutboundMessage, instanceId: string, context: DeliveryContext): Promise<void> {
    const sender = this.options.sender;
    if (sender) return this.deliverAllocated(sender, message, instanceId, context);
    const body = message.body as { assignmentId?: string; claimId?: string; reportId?: string; maxItems?: number };
    if (body.reportId !== undefined) {
      await context.deliverResponse(await this.options.core.report(instanceId, message.body as never));
    } else if (body.claimId !== undefined) {
      // A claim's admission is the allocator's authority, not this
      // transport's: only the admission owner may allocate its frame.
      await context.deliverResponse(await this.options.core.claim(instanceId, message.body as never));
    } else {
      await context.deliverResponse(await this.options.core.pull(message.body as never));
    }
  }

  private async deliverAllocated(sender: AssignmentSender, message: OutboundMessage, instanceId: string, context: DeliveryContext): Promise<void> {
    if (!message.assignmentRequest || message.channelId !== `assignment:${instanceId}`) throw new RemoteInstanceError("assignment_channel_invalid", "Prepared canonical D143 allocation is required before carrier selection.");
    await sender.deliverAllocated(message.assignmentRequest, async result => {
      context.assertRecovery(); await context.deliverResponse(result as InboundBody);
    }, context.assertRecovery);
    // The reply/effect is already durable. Cursor retirement is
    // housekeeping: failure retains history and retries independently,
    // rather than replaying an applied domain effect through this queue.
    this.assignmentHousekeepingNeeded = true;
    await this.housekeepAssignments();
  }

  /**
   * A policy-deferred permission/elicitation is registered with Core
   * (`permissions/deferred`) by the session BEFORE this frame exists, so Core
   * already holds its pending view and notice; the frame itself has nothing
   * further to deliver over HTTPS. Every other session frame rides the
   * session path in core/client.ts.
   */
  private async deliverSession(message: OutboundMessage, instanceId: string, context: DeliveryContext): Promise<void> {
    const body = message.body as { kind?: string; method?: string };
    if (body.kind === "acp" && (body.method === "session/request_permission" || body.method === "elicitation/create")) {
      context.assertRecovery();
      return;
    }
    await this.options.core.sessionOutbound(instanceId, [{ channelId: message.channelId, ...(message.sourceSequence === undefined ? {} : { sourceSequence: message.sourceSequence }), body: message.body }]);
    context.assertRecovery();
  }

  /** Coalesces direct wakeups and scheduled polls onto one in-flight cycle. */
  private poll(): Promise<void> {
    if (this.pollFlight) return this.pollFlight;
    const flight = this.pollOnce().finally(() => {
      if (this.pollFlight === flight) this.pollFlight = null;
    });
    this.pollFlight = flight;
    return flight;
  }

  private async runPollCycle(): Promise<void> {
    await this.poll();
    if (!this.running || this.pollTimer) return;
    const configured = this.options.pollIntervalMs;
    const delay = Number.isFinite(configured) ? Math.max(1, configured) : 5_000;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.runPollCycle();
    }, delay);
    this.pollTimer.unref();
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    await this.housekeepAssignments();
    if (this.options.relayOnlySessions) return;
    const instanceId = this.options.instanceId();
    try {
      await this.pollControl(instanceId);
      if (!this.running || !this.recovery.permits("session")) return;
      await this.pollSessions(instanceId);
      this.available = true;
    } catch (error) {
      this.available = false;
      this.logger.debug({ err: error }, "https fallback poll failed");
    }
  }

  private async pollControl(instanceId: string): Promise<void> {
    const frames = await this.options.core.controlPoll(instanceId);
    for (const frame of frames) {
      const assertRecovery = this.recovery.capture(frame.channel);
      await this.handler?.({ channel: frame.channel, channelId: frame.channelId, body: frame.body });
      assertRecovery();
    }
  }

  private async pollSessions(instanceId: string): Promise<void> {
    const assertRecovery = this.recovery.capture("session");
    const session = await this.options.core.sessionInbound(instanceId);
    assertRecovery();
    for (const frame of session) {
      assertRecovery();
      await this.handler?.({ channel: frame.channel, channelId: frame.channelId, body: frame.body });
      assertRecovery();
    }
  }

  /**
   * HTTPS has no socket ACK callback, so it must explicitly publish the two
   * durable cursors. One startup attempt recovers a previous process's pending
   * retirement without manufacturing a request; later attempts are dirtied by
   * accepted replies and coalesced so polling never overlaps ACK writes.
   */
  private housekeepAssignments(): Promise<void> {
    const sender = this.options.sender;
    if (!sender || !this.assignmentHousekeepingNeeded || this.preparedStopped || !this.recovery.permits("assignment")) return Promise.resolve();
    if (this.assignmentHousekeepingFlight) return this.assignmentHousekeepingFlight;
    this.assignmentHousekeepingNeeded = false;
    let failed = false;
    const flight = sender.acknowledge().catch(error => {
      failed = true;
      this.assignmentHousekeepingNeeded = true;
      this.logger.debug({ err: error }, "assignment cursor housekeeping failed; retaining history for retry");
    }).finally(() => {
      if (this.assignmentHousekeepingFlight === flight) {
        this.assignmentHousekeepingFlight = null;
        // A reply may have committed while the startup/previous ACK was in
        // flight. Drain that newly dirtied cursor immediately, not one poll
        // interval later.
        if (!failed && this.assignmentHousekeepingNeeded) void this.housekeepAssignments();
      }
    });
    this.assignmentHousekeepingFlight = flight;
    return flight;
  }
}
