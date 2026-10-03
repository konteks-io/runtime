import {
  RelayAckSchema,
  RemoteInstanceError,
  AssignmentReplyFrameSchema,
  AssignmentRequestFrameSchema,
  ToRuntimeRelayFrameSchema,
  signRelayAck,
  type Clock,
  type InstanceKeyPair,
  type Logger,
  type RelayAck,
  type AssignmentRequestFrame,
  type AssignmentReplyFrame,
  type LogicalAssignmentRequestFrame,
  type RelayChannel,
  type RelayHandshakeResult,
  type RelayReplayRequest,
  type ToCoreRelayFrame,
  type ToRuntimeRelayFrame,
} from "@konteks/remote-common";
import { createLogger } from "@konteks/remote-common";
import { ReplayBuffer } from "./replay-buffer.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";

/**
 * The typed channel mux:
 *  - per `(channelId, to_core)` monotonic `seq` and a sender-owned replay buffer;
 *  - per `(channelId, to_runtime)` durable receive cursor with dedup;
 *  - explicit supervisor-signed `RelayAck`s at the configured cadence and
 *    immediately when a sender's buffer crosses half its bound;
 *  - `connectionEpoch` fencing: a frame or ack under another epoch is dropped
 *    and counted (`relay_epoch_stale`);
 *  - stall detection: no ack within 2 × ackIntervalSeconds ⇒ stop sending and
 *    ask the client to re-handshake; unacked frames are never discarded.
 * It knows nothing about sockets: `emit` sends bytes, `onFrame` delivers
 * validated to_runtime bodies to the supervisor.
 */
export type OutboundBody = Extract<ToCoreRelayFrame, { channel: RelayChannel }>["body"];

export interface RelayDurableState {
  cursors: Record<string, { to_core: number; to_runtime: number; allocated: number }>;
  outbound: Record<string, Array<{ frame: ToCoreRelayFrame; bytes: number; enqueuedAt: number }>>;
}

export interface MuxOptions {
  /** Exact accepted-generation identity; null/omitted keeps work traffic gated. */
  recoveryAuthority?: () => string | null;
  clock: Clock;
  key: () => InstanceKeyPair;
  ackIntervalSeconds: number;
  ackEveryFrames: number;
  replayBufferBytes: number;
  replayBufferAgeMs: number;
  /** Serialize + send on the current socket. Returns false when the socket cannot accept. */
  emit: (envelope: ToCoreRelayFrame | AssignmentRequestFrame | RelayAck) => boolean;
  /** Resolve only after durable acceptance, not completion of the agent turn. */
  onFrame: (frame: ToRuntimeRelayFrame) => void | Promise<void>;
  /** Assignment receipts and request ACKs use the durable assignment journal. */
  onAssignmentFrame?: (frame: AssignmentReplyFrame) => Promise<number>;
  onAssignmentRequestAck?: (ack: RelayAck) => Promise<void>;
  /** Assignment logical cursors replace generic mux counters in the relay handshake. */
  assignmentCursors?: () => { channelId: string; to_core: number; to_runtime: number } | null;
  onStall: (channelId: string) => void;
  onReset: (channelId: string) => void;
  /** Persist the durable receive cursor (the authoritative cursor for to_runtime). */
  persistCursors: (cursors: Record<string, { to_core: number; to_runtime: number; allocated?: number | undefined }>) => Promise<void>;
  /** Production durability boundary: allocation, replay bytes and cursors in one atomic write. */
  persistRelayState?: (state: RelayDurableState) => Promise<void>;
  logger?: Logger;
}

/**
 * Channels whose to_core data a grant holder (a viewer), not Core, receives
 * and acknowledges: `session:<id>` and `preview:<id>`. Their replay is kept
 * until that endpoint acknowledges it, and a quiet one is never a stall.
 */
function holderBound(channel: RelayChannel): boolean {
  return channel === "session" || channel === "preview";
}

/** Upper bound for repeated stalls of one unacknowledged channel. */
const STALL_BACKOFF_CEILING_MS = 5 * 60_000;
/** Silence on a channel with unacknowledged frames before its peer is presumed dead. */
export const CHANNEL_LIVENESS_MS = 60_000;

interface ChannelState {
  channel: RelayChannel;
  nextSeq: number;
  buffer: ReplayBuffer<ToCoreRelayFrame>;
  receivedCursor: number; // highest to_runtime seq durably received (our ack cursor)
  ackedByEndpoint: number; // highest to_core seq Core acked
  lastAckAt: number; // pending batch start or most recent validated ACK/replay
  lastEmittedAckCursor: number;
  framesSinceAck: number;
  stalled: boolean;
  /** Consecutive stalls with no acknowledgement progress, for stall backoff. */
  stallStreak: number;
  stallCursor: number;
  /** Last inbound frame or acknowledgement on this channel: evidence the peer is alive. */
  lastInboundAt: number;
}

type ReplayFrames = NonNullable<ReturnType<ChannelState["buffer"]["after"]>>;

/** The whole unacknowledged history, contiguous to the last allocated sequence; null when any of it is gone. */
function completeReplay(state: ChannelState): ReplayFrames | null {
  const replay = state.buffer.after(state.ackedByEndpoint);
  return replay !== null && !state.buffer.needsReset && replay.length === state.nextSeq - 1 - state.ackedByEndpoint ? replay : null;
}

/** Why a peer's resume cursor cannot be served from the retained replay; null when it can. */
function resumeRefusal(cursor: { to_core: number }, state: ChannelState, replay: ReplayFrames | null): string | null {
  if (cursor.to_core < state.ackedByEndpoint) return "resume_cursor_regressed";
  if (cursor.to_core >= state.nextSeq) return "resume_cursor_ahead";
  if (state.buffer.needsReset) return "replay_evicted";
  if (replay === null) return "replay_unavailable";
  return replay.length !== state.nextSeq - 1 - state.ackedByEndpoint ? "replay_incomplete" : null;
}

/**
 * A session may have advanced through the HTTPS carrier before its first
 * relay frame. Its durable source sequence is the authority; a pristine
 * relay-local allocator may join that already-accepted prefix once.
 */
function allocateSequence(state: ChannelState, expectedSequence: number | undefined): number {
  if (expectedSequence !== undefined && expectedSequence > state.nextSeq && state.nextSeq === 1 && state.ackedByEndpoint === 0) state.nextSeq = expectedSequence;
  const seq = state.nextSeq;
  if (expectedSequence !== undefined && expectedSequence !== seq) throw new RemoteInstanceError("recovery_required", "Durable logical source sequence differs from relay sequence");
  state.nextSeq += 1;
  return seq;
}

/** Unacknowledged sends past both the stall deadline and the liveness window, not already stalled. */
function overdue(state: ChannelState, now: number, stallDeadlineMs: number): boolean {
  return state.buffer.unackedCount > 0 && !state.stalled && now - state.lastAckAt > stallDeadlineMs && now - state.lastInboundAt > CHANNEL_LIVENESS_MS;
}

interface PendingSend {
  channelId: string;
  channel: RelayChannel;
  state: ChannelState;
  frame: ToCoreRelayFrame;
  seq: number;
  generation: number;
}

interface MuxCounters {
  epochStale: number;
  invalidFrames: number;
  duplicates: number;
  resets: number;
  stalls: number;
}

export class ChannelMux {
  private readonly channels = new Map<string, ChannelState>();
  private epoch = 0;
  private connected = false;
  private generation = 0;
  private readonly receiveLanes = new Map<string, Promise<void>>();
  /** Only cursor snapshot/persist/publish holds this shared mutation lane. */
  private pending: Promise<void> = Promise.resolve();
  /**
   * Sent frames waiting for the durability write that has not started yet
   * (group commit). Every frame queued while an earlier write runs
   * joins this one batch; the batch closes when its own write starts.
   */
  private openSendBatch: PendingSend[] | null = null;
  private readonly logger: Logger;
  private readonly recovery: RecoveryAuthority;
  readonly counters: MuxCounters = { epochStale: 0, invalidFrames: 0, duplicates: 0, resets: 0, stalls: 0 };

  constructor(private readonly options: MuxOptions) {
    this.logger = options.logger ?? createLogger({ name: "relay-mux" });
    this.recovery = new RecoveryAuthority(options.recoveryAuthority);
    this.lastSocketInboundAt = options.clock.now();
  }

  get connectionEpoch(): number {
    return this.epoch;
  }

  /** Restore durable cursors on start (before any handshake). */
  restoreCursors(cursors: Record<string, { to_core: number; to_runtime: number; allocated?: number | undefined }>, channelOf: (channelId: string) => RelayChannel | null): void {
    for (const [channelId, cursor] of Object.entries(cursors)) {
      const channel = channelOf(channelId);
      if (!channel) continue;
      if (channel === "assignment" && this.options.assignmentCursors) continue;
      const state = this.ensure(channelId, channel);
      state.receivedCursor = cursor.to_runtime;
      state.ackedByEndpoint = cursor.to_core;
      // The allocation cursor is durable independently of the ACK cursor. A
      // frame allocated before a restart but never acknowledged here may still
      // have reached the holder durably (its ACK was in flight); reusing that
      // sequence after the restart made the holder drop the new frame as an
      // already-durable duplicate — a fresh session_ready would vanish silently. Sequence numbers are never handed out twice.
      state.nextSeq = Math.max(state.nextSeq, cursor.to_core + 1, (cursor.allocated ?? 0) + 1);
      state.buffer.ackUpTo(cursor.to_core);
    }
  }

  /** Restore allocation and unacknowledged bytes before opening the relay. */
  restoreDurableState(durable: RelayDurableState, channelOf: (channelId: string) => RelayChannel | null): void {
    this.restoreCursors(durable.cursors, channelOf);
    for (const [channelId, entries] of Object.entries(durable.outbound)) {
      const channel = channelOf(channelId);
      if (!channel || channel === "assignment" && this.options.assignmentCursors) continue;
      const state = this.ensure(channelId, channel);
      const valid = entries.filter(entry => entry.frame.channelId === channelId && entry.frame.channel === channel && entry.frame.direction === "to_core")
        .sort((a, b) => a.frame.seq - b.frame.seq);
      state.buffer.restore(valid.map(entry => ({ seq: entry.frame.seq, frame: entry.frame, bytes: entry.bytes, enqueuedAt: entry.enqueuedAt })), state.ackedByEndpoint, this.options.clock.now());
      const highest = valid.at(-1)?.frame.seq ?? 0;
      state.nextSeq = Math.max(state.nextSeq, highest + 1);
    }
  }

  openChannel(channelId: string, channel: RelayChannel): void {
    this.ensure(channelId, channel);
  }

  closeChannel(channelId: string): void {
    if (!this.channels.delete(channelId)) return;
    this.receiveLanes.delete(channelId);
    // Closing a channel is a durable lifecycle transition. Leaving its cursor
    // behind resurrects a terminal stream on restart, after its bounded replay
    // has expired, so every later handshake reports the same impossible gap.
    // The in-memory delete fences queued receives immediately; persistence is
    // serialized behind any earlier frame/ACK commit.
    void this.serialize(() => this.persist(this.durableState())).catch(error => {
      this.logger.warn({ err: error, channelId }, "closed relay channel state could not be retired durably");
    });
  }

  private ensure(channelId: string, channel: RelayChannel): ChannelState {
    let state = this.channels.get(channelId);
    if (!state) {
      state = {
        channel,
        nextSeq: 1,
        // Logical sessions survive idle time between assignments. Expiring an
        // unacknowledged final frame here would poison the next ready frame.
        // Keep endpoint-ACK ownership and the byte bound, including on restore.
        buffer: new ReplayBuffer<ToCoreRelayFrame>({ maxBytes: this.options.replayBufferBytes,
          maxAgeMs: holderBound(channel) ? Number.POSITIVE_INFINITY : this.options.replayBufferAgeMs }),
        receivedCursor: 0,
        ackedByEndpoint: 0,
        lastAckAt: this.options.clock.now(),
        lastEmittedAckCursor: 0,
        framesSinceAck: 0,
        stalled: false,
        stallStreak: 0,
        stallCursor: 0,
        lastInboundAt: this.options.clock.now(),
      };
      this.channels.set(channelId, state);
    }
    return state;
  }

  /** The caller's own cursors for `RelayHandshakeRequest.lastAckedSeq`. */
  handshakeCursors(): Record<string, { to_core: number; to_runtime: number }> {
    // Wire shape only: the allocation cursor is local durable state, never a handshake field.
    const out: Record<string, { to_core: number; to_runtime: number }> = {};
    for (const [channelId, cursor] of Object.entries(this.genericCursors())) out[channelId] = { to_core: cursor.to_core, to_runtime: cursor.to_runtime };
    const assignment = this.options.assignmentCursors?.();
    if (assignment) out[assignment.channelId] = { to_core: assignment.to_core, to_runtime: assignment.to_runtime };
    return out;
  }

  /** Generic replay cursor persistence excludes the assignment's independently durable stream. */
  private genericCursors(): Record<string, { to_core: number; to_runtime: number; allocated: number }> {
    const out: Record<string, { to_core: number; to_runtime: number; allocated: number }> = {};
    for (const [channelId, state] of this.channels) {
      if (state.channel === "assignment" && this.options.assignmentCursors) continue;
      out[channelId] = { to_core: state.ackedByEndpoint, to_runtime: state.receivedCursor, allocated: state.nextSeq - 1 };
    }
    return out;
  }

  private durableState(cursors = this.genericCursors(), ack?: { channelId: string; cumulativeSeq: number }): RelayDurableState {
    const outbound: RelayDurableState["outbound"] = {};
    for (const [channelId, state] of this.channels) {
      if (state.channel === "assignment" && this.options.assignmentCursors) continue;
      outbound[channelId] = state.buffer.snapshot()
        .filter(entry => channelId !== ack?.channelId || entry.seq > ack.cumulativeSeq)
        .map(entry => ({ frame: entry.frame, bytes: entry.bytes, enqueuedAt: entry.enqueuedAt }));
    }
    return { cursors, outbound };
  }

  private persist(durable: RelayDurableState): Promise<void> {
    return this.options.persistRelayState?.(durable) ?? this.options.persistCursors(durable.cursors);
  }

  /** Adopt the epoch and replay locally unacknowledged frames; handshake cursors are not ACKs. */
  applyHandshake(result: RelayHandshakeResult): Promise<void> {
    this.generation += 1;
    this.epoch = result.connectionEpoch;
    this.connected = true;
    this.lastSocketInboundAt = this.options.clock.now();
    for (const channelId of result.reset) this.peerReset(channelId);
    for (const [channelId, cursor] of Object.entries(result.resume)) {
      if (!result.reset.includes(channelId)) this.resumeChannel(channelId, cursor);
    }
    // Take the snapshot when this write executes, after earlier receive commits.
    return this.serialize(() => this.persist(this.durableState()));
  }

  /** The peer lost this channel: rebuild it from the sender-owned replay, or fence it when that is incomplete. */
  private peerReset(channelId: string): void {
    const state = this.channels.get(channelId);
    if (!state) return;
    this.logReset(channelId, state, "peer_reset");
    this.counters.resets += 1;
    if (state.channel === "assignment" && this.options.assignmentCursors) {
      this.options.onReset(channelId);
      return;
    }
    const replay = completeReplay(state);
    if (replay === null) {
      // The sender no longer has a contiguous history to rebuild the peer.
      // Retain every remaining byte and fence new sends; clearing while the
      // allocation cursor advances manufactures an unrecoverable seq hole.
      state.stalled = true;
      this.options.onReset(channelId);
      return;
    }
    // A reset peer is rebuilt from the sender-owned durable replay. This is
    // not an execution reset and does not discard or renumber any frame.
    state.stalled = false;
    state.lastAckAt = this.options.clock.now();
    state.lastInboundAt = this.options.clock.now();
    this.emitPermitted(state, replay);
  }

  /**
   * The peer resumes a channel at its cursor. Assignment replay comes only
   * from the journal-owned sender: handshake cursors are hints and cannot
   * mutate or replace either durable counter.
   */
  private resumeChannel(channelId: string, cursor: { to_core: number; to_runtime: number }): void {
    const state = this.channels.get(channelId);
    if (!state || (state.channel === "assignment" && this.options.assignmentCursors)) return;
    state.stalled = false;
    state.lastAckAt = this.options.clock.now();
    // Only a validated source-specific RelayAck frees replay. A peer resume
    // hint cannot stand in for an ACK that we never received.
    const replay = state.buffer.after(state.ackedByEndpoint);
    const refusal = resumeRefusal(cursor, state, replay);
    if (refusal !== null || replay === null) return this.resumeRefused(channelId, state, refusal ?? "replay_unavailable", cursor, replay);
    this.emitPermitted(state, replay);
  }

  /**
   * Preserve the remaining replay and its allocation. Recovery may use it as
   * evidence; erasing it here would create a new sequence hole.
   */
  private resumeRefused(channelId: string, state: ChannelState, reason: string, cursor: { to_core: number; to_runtime: number }, replay: ReplayFrames | null): void {
    this.logReset(channelId, state, reason, { peerToCore: cursor.to_core, peerToRuntime: cursor.to_runtime, replayCount: replay?.length ?? null });
    state.stalled = true;
    this.counters.resets += 1;
    this.options.onReset(channelId);
  }

  /** Re-emit retained frames on this epoch, each only while recovery permits the channel. */
  private emitPermitted(state: ChannelState, replay: ReplayFrames): void {
    for (const entry of replay) {
      if (this.recovery.permits(state.channel)) this.options.emit({ ...entry.frame, connectionEpoch: this.epoch });
    }
  }

  /** Re-emit retained frames on this epoch until recovery no longer permits the channel. */
  private emitUntilRefused(state: ChannelState, replay: ReplayFrames): void {
    for (const entry of replay) {
      if (!this.recovery.permits(state.channel)) break;
      this.options.emit({ ...entry.frame, connectionEpoch: this.epoch });
    }
  }

  /**
   * Prompt replay after the relay observes that a holder has attached. This
   * hint is not an acknowledgement: replay always starts at the locally
   * validated ACK cursor and the retained buffer remains intact.
   */
  requestReplay(request: RelayReplayRequest): Promise<void> {
    if (!this.connected || request.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1;
      return Promise.resolve();
    }
    const state = this.channels.get(request.channelId);
    if (!state || state.channel === "assignment" || !this.recovery.permits(state.channel)) return Promise.resolve();
    this.replayFromAck(request.channelId, state);
    return Promise.resolve();
  }

  private replayFromAck(channelId: string, state: ChannelState): void {
    const replay = state.buffer.after(state.ackedByEndpoint);
    if (!replay || state.buffer.needsReset) {
      state.stalled = true;
      this.counters.resets += 1;
      this.options.onReset(channelId);
      return;
    }
    state.stalled = false;
    state.lastAckAt = this.options.clock.now();
    state.lastInboundAt = this.options.clock.now();
    this.emitUntilRefused(state, replay);
  }

  disconnected(): void {
    this.connected = false;
    this.generation += 1;
  }

  /** Release retained outbound frames after the owner durably accepts recovery.
   * No cursor or epoch is invented, and this cannot free a replay buffer.
   */
  resumeAfterRecovery(): void {
    if (!this.connected) return;
    for (const state of this.channels.values()) {
      if (!this.recovery.permits(state.channel) || state.stalled) continue;
      const replay = state.buffer.after(state.ackedByEndpoint);
      if (!replay || state.buffer.needsReset) continue;
      state.lastAckAt = this.options.clock.now();
      this.emitUntilRefused(state, replay);
    }
  }

  /** Send a to_core frame; the frame is buffered before any transmission attempt. */
  send(channelId: string, channel: RelayChannel, body: OutboundBody, signature?: string, expectedSequence?: number): number {
    if (channel === "assignment" && this.options.assignmentCursors) {
      throw new RemoteInstanceError("assignment_channel_invalid", "D143 assignments require their retained logical frame owner.");
    }
    const state = this.ensure(channelId, channel);
    if (state.buffer.needsReset) {
      throw new RemoteInstanceError("recovery_required", "The channel replay history is incomplete.");
    }
    const seq = allocateSequence(state, expectedSequence);
    const frame = {
      channel,
      direction: "to_core",
      channelId,
      connectionEpoch: this.epoch,
      seq,
      issuedAt: this.options.clock.nowIso(),
      body,
      ...(signature === undefined ? {} : { signature }),
    } as ToCoreRelayFrame;
    this.retain(channelId, state, seq, frame);
    // Allocation and replay bytes become durable before the socket can observe
    // them. A crash before this write emits nothing; a crash after it replays.
    // A handshake that races this durability write owns replay on its new
    // epoch; the original send continuation must not emit the same frame too.
    this.commitSend({ channelId, channel, state, frame, seq, generation: this.generation });
    return seq;
  }

  /** Buffers the frame for replay; a buffer that had to evict fences the channel for reset. */
  private retain(channelId: string, state: ChannelState, seq: number, frame: ToCoreRelayFrame): void {
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    // Idle time is not ACK wait time. Start the deadline only for a new
    // pending batch; later sends cannot keep an unacknowledged batch alive.
    if (state.buffer.unackedCount === 0 && !state.buffer.needsReset && !state.stalled) {
      state.lastAckAt = this.options.clock.now();
    }
    state.buffer.push(seq, frame, bytes, this.options.clock.now());
    if (state.buffer.needsReset) {
      this.logReset(channelId, state, "send_replay_evicted");
      this.counters.resets += 1;
      state.stalled = true;
      this.options.onReset(channelId);
    }
  }

  /**
   * Group commit: one durability write covers every frame sent
   * while the previous write ran, instead of one full relay-state write per
   * frame. Each frame is still emitted only after a write that contains it.
   */
  private commitSend(send: PendingSend): void {
    if (this.openSendBatch) {
      this.openSendBatch.push(send);
      return;
    }
    const batch = [send];
    this.openSendBatch = batch;
    void this.serialize(async () => {
      // Close the batch as its write starts: the snapshot below holds every
      // frame in it, and later frames wait for the next write.
      if (this.openSendBatch === batch) this.openSendBatch = null;
      const startedAt = this.options.clock.now();
      await this.persist(this.durableState());
      const persistenceMs = Math.max(0, this.options.clock.now() - startedAt);
      for (const send of batch) {
        this.logSessionReady(send, persistenceMs, batch.length);
        if (this.emittable(send)) this.options.emit({ ...send.frame, connectionEpoch: this.epoch });
      }
    }).catch(error => this.sendBatchFailed(batch, error));
  }

  /** A committed frame is emitted only on the generation it was sent in, while still retained and the channel is open. */
  private emittable(send: PendingSend): boolean {
    return this.generation === send.generation && this.channels.get(send.channelId) === send.state && send.state.buffer.holds(send.seq) &&
      this.connected && !send.state.stalled && this.recovery.permits(send.channel);
  }

  private logSessionReady(send: PendingSend, persistenceMs: number, batchFrames: number): void {
    if (send.channel !== "session" || (send.frame.body as { kind?: string }).kind !== "session_ready") return;
    this.logger.info({ event: "relay.session_ready.persisted", channelId: send.channelId, seq: send.seq, connectionEpoch: this.epoch,
      connected: this.connected, stalled: send.state.stalled, recoveryPermitted: this.recovery.permits(send.channel),
      generationChanged: this.generation !== send.generation, persistenceMs, batchFrames },
    "session readiness retained for endpoint delivery");
  }

  private sendBatchFailed(batch: PendingSend[], error: unknown): void {
    if (this.openSendBatch === batch) this.openSendBatch = null;
    const stalled = new Set<string>();
    for (const { channelId, seq } of batch) {
      this.logger.warn({ err: error, channelId, seq }, "relay outbound durability failed; retaining the frame without emitting");
      if (!stalled.has(channelId)) { stalled.add(channelId); this.options.onStall(channelId); }
    }
  }

  /** Emit the journal-owned assignment identity with only this socket's epoch added. */
  sendAssignment(logical: LogicalAssignmentRequestFrame): boolean {
    const frame = AssignmentRequestFrameSchema.parse({ ...logical, connectionEpoch: this.epoch });
    this.ensure(frame.channelId, "assignment");
    if (!this.connected || !this.recovery.permits("assignment")) return false;
    return this.options.emit(frame);
  }

  /** Inbound envelope from the socket (already JSON-parsed). */
  async receive(envelope: unknown): Promise<void> {
    const generation = this.generation;
    const ack = RelayAckSchema.safeParse(envelope);
    if (ack.success) return this.receiveAckEnvelope(ack.data, generation);
    const assignment = AssignmentReplyFrameSchema.safeParse(envelope);
    if (assignment.success) return this.receiveAssignmentEnvelope(assignment.data, generation);
    const frame = ToRuntimeRelayFrameSchema.safeParse(envelope);
    if (!frame.success) {
      this.counters.invalidFrames += 1;
      this.logger.warn("dropped an envelope that matches no relay schema");
      return;
    }
    return this.receiveFrameEnvelope(frame.data, generation);
  }

  private receiveAckEnvelope(ack: RelayAck, generation: number): Promise<void> {
    if (ack.connectionEpoch === this.epoch) this.lastSocketInboundAt = this.options.clock.now();
    if (this.assignmentRequestAck(ack)) return this.receiveAssignmentRequestAck(ack, generation, this.recovery.capture("assignment"));
    const state = this.channels.get(ack.channelId);
    if (!state) return Promise.resolve();
    if (ack.connectionEpoch === this.epoch) state.lastInboundAt = this.options.clock.now();
    const highestSent = state.nextSeq - 1;
    const assertRecovery = this.recovery.capture(state.channel);
    return this.serialize(() => this.receiveAck(ack, state, generation, highestSent, assertRecovery));
  }

  /** Core's ACK of a journal-owned assignment request, which only that owner may record. */
  private assignmentRequestAck(ack: RelayAck): boolean {
    return this.options.onAssignmentRequestAck !== undefined && ack.channelId.startsWith("assignment:") && ack.origin === "core" && ack.dataDirection === "to_core";
  }

  private receiveAssignmentEnvelope(frame: AssignmentReplyFrame, generation: number): Promise<void> {
    if (!this.connected || frame.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1;
      return Promise.resolve();
    }
    const assertRecovery = this.recovery.capture("assignment");
    return this.inLane(frame.channelId, () => this.receiveAssignmentFrame(frame, generation, assertRecovery));
  }

  private receiveFrameEnvelope(frame: ToRuntimeRelayFrame, generation: number): Promise<void> {
    if (frame.channel === "assignment" && this.options.onAssignmentFrame) {
      throw new RemoteInstanceError("assignment_channel_invalid", "Bare assignment replies are disabled for the durable assignment carrier.");
    }
    if (!this.connected || frame.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1;
      return Promise.resolve();
    }
    // Capture identity before queueing so close/reopen cannot adopt an old frame.
    const assertRecovery = this.recovery.capture(frame.channel);
    const state = this.ensure(frame.channelId, frame.channel);
    // Receipt is liveness even while processing this frame takes a while.
    state.lastInboundAt = this.options.clock.now();
    this.lastSocketInboundAt = state.lastInboundAt;
    return this.inLane(frame.channelId, () => this.receiveFrame(frame, state, generation, assertRecovery));
  }

  /** Frames of one channel are handled in arrival order; a failure does not block the lane. */
  private inLane(channelId: string, work: () => Promise<void>): Promise<void> {
    const prior = this.receiveLanes.get(channelId) ?? Promise.resolve();
    const result = prior.then(work);
    this.receiveLanes.set(channelId, result.then(() => undefined, () => undefined));
    return result;
  }

  /** Still the connection (socket generation) this work was received on. */
  private sameConnection(generation: number): boolean {
    return this.connected && generation === this.generation;
  }

  private async receiveAssignmentRequestAck(ack: RelayAck, generation: number, assertRecovery: () => void): Promise<void> {
    if (!this.sameConnection(generation) || ack.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1; return;
    }
    assertRecovery();
    if (!this.options.onAssignmentRequestAck) throw new Error("No durable assignment request ACK owner is attached.");
    await this.options.onAssignmentRequestAck(ack);
    assertRecovery();
    if (!this.connected || generation !== this.generation) throw new Error("Assignment request ACK owner changed during persistence.");
  }

  private async receiveAssignmentFrame(frame: AssignmentReplyFrame, generation: number, assertRecovery: () => void): Promise<void> {
    if (!this.sameConnection(generation) || frame.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1; return;
    }
    assertRecovery();
    if (!this.options.onAssignmentFrame) throw new Error("No durable assignment reply owner is attached.");
    const consumed = await this.options.onAssignmentFrame(frame);
    assertRecovery();
    if (!this.sameConnection(generation) || !Number.isSafeInteger(consumed) || consumed < frame.seq) {
      throw new Error("Assignment reply was not durably consumed by the current owner.");
    }
    const issuedAt = this.options.clock.nowIso();
    const ack: RelayAck = { kind: "ack", channelId: frame.channelId, cumulativeSeq: consumed, connectionEpoch: this.epoch,
      issuedAt, dataDirection: "to_runtime", origin: "supervisor",
      signature: signRelayAck(this.options.key(), { channelId: frame.channelId, dataDirection: "to_runtime", cumulativeSeq: consumed, issuedAt }) };
    this.options.emit(ack);
  }

  private async receiveAck(ack: RelayAck, state: ChannelState, generation: number, highestSent: number, assertRecovery: () => void): Promise<void> {
    if (!this.current(ack.channelId, state, generation) || ack.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1;
      return;
    }
    if (ack.dataDirection !== "to_core") return;
    assertRecovery();
    const origin = holderBound(state.channel) ? "grant_holder" : "core";
    if (ack.origin !== origin || ack.cumulativeSeq > highestSent) {
      this.counters.invalidFrames += 1;
      return;
    }
    if (ack.cumulativeSeq > state.ackedByEndpoint) await this.advanceAck(ack, state, generation, assertRecovery);
  }

  /** The endpoint acknowledged more: persist the cursor first, then free the replay it covers. */
  private async advanceAck(ack: RelayAck, state: ChannelState, generation: number, assertRecovery: () => void): Promise<void> {
    const cursors = this.genericCursors();
    cursors[ack.channelId] = { to_core: ack.cumulativeSeq, to_runtime: state.receivedCursor, allocated: state.nextSeq - 1 };
    await this.persist(this.durableState(cursors, { channelId: ack.channelId, cumulativeSeq: ack.cumulativeSeq }));
    assertRecovery();
    if (!this.current(ack.channelId, state, generation)) return;
    state.ackedByEndpoint = ack.cumulativeSeq;
    state.buffer.ackUpTo(ack.cumulativeSeq);
    state.lastAckAt = this.options.clock.now();
    state.stalled = false;
  }

  private async receiveFrame(frame: ToRuntimeRelayFrame, state: ChannelState, generation: number, assertRecovery: () => void): Promise<void> {
    if (!this.current(frame.channelId, state, generation)) {
      this.counters.epochStale += 1;
      return;
    }
    // Reject rather than successfully return: the socket owner disconnects and
    // the sender retains this unacknowledged frame for replay after recovery.
    assertRecovery();
    if (frame.seq <= state.receivedCursor) {
      this.counters.duplicates += 1;
      this.maybeAck(frame.channelId, state, true);
      return;
    }
    if (frame.seq !== state.receivedCursor + 1) {
      // A gap on the receive side means the relay lost frames we never acked;
      // the sender will replay from our cursor after a re-handshake.
      this.logger.warn({ channelId: frame.channelId, expected: state.receivedCursor + 1, got: frame.seq }, "to_runtime sequence gap; requesting re-handshake");
      this.counters.stalls += 1;
      this.options.onStall(frame.channelId);
      return;
    }
    await this.options.onFrame(frame);
    assertRecovery();
    await this.serialize(async () => {
      if (!this.current(frame.channelId, state, generation)) return;
      assertRecovery();
      const cursors = this.genericCursors();
      cursors[frame.channelId] = { to_core: state.ackedByEndpoint, to_runtime: frame.seq, allocated: state.nextSeq - 1 };
      await this.persist(this.durableState(cursors));
      assertRecovery();
      if (!this.current(frame.channelId, state, generation)) return;
      state.receivedCursor = frame.seq;
      state.framesSinceAck += 1;
      this.maybeAck(frame.channelId, state, false);
    });
  }

  private current(channelId: string, state: ChannelState, generation: number): boolean {
    return this.connected && generation === this.generation && this.channels.get(channelId) === state;
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    // Keep the lane usable after a failed delivery; the returned promise still
    // rejects to the socket owner, which must disconnect and retain replay.
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Cadence: every ackEveryFrames, every ackIntervalSeconds (tick), or on duplicate delivery. */
  private maybeAck(channelId: string, state: ChannelState, force: boolean): void {
    // A forced ack (duplicate delivery) answers immediately but leaves the
    // frame cadence alone, so the next cadence ack still lands on schedule.
    if (force) this.emitAck(channelId, state, false);
    else if (state.framesSinceAck >= this.options.ackEveryFrames) this.emitAck(channelId, state);
  }

  private emitAck(channelId: string, state: ChannelState, resetCadence = true): void {
    if (!this.connected || !this.recovery.permits(state.channel)) return;
    const issuedAt = this.options.clock.nowIso();
    const ack: RelayAck = {
      kind: "ack",
      channelId,
      cumulativeSeq: state.receivedCursor,
      connectionEpoch: this.epoch,
      issuedAt,
      dataDirection: "to_runtime",
      origin: "supervisor",
      signature: signRelayAck(this.options.key(), { channelId, dataDirection: "to_runtime", cumulativeSeq: state.receivedCursor, issuedAt }),
    };
    if (this.options.emit(ack)) {
      if (resetCadence) state.framesSinceAck = 0;
      state.lastEmittedAckCursor = state.receivedCursor;
    }
  }

  /** Periodic tick: interval acks, half-buffer acks, and stall detection. */
  /**
   * Socket-level liveness: any current-epoch frame or ack on any channel. The
   * relay parks frames for a holder that is not attached and delivers them
   * when it binds, so a quiet channel on a live socket is waiting for its
   * holder, not lost. Like bb (reconnect only on missed heartbeat acks), a
   * live socket re-handshakes for one channel only at the backoff ceiling.
   */
  private lastSocketInboundAt: number;

  tick(): void {
    if (!this.connected) return;
    const now = this.options.clock.now();
    const intervalMs = this.options.ackIntervalSeconds * 1_000;
    const socketLive = now - this.lastSocketInboundAt <= CHANNEL_LIVENESS_MS;
    for (const [channelId, state] of this.channels) this.tickChannel(channelId, state, { now, intervalMs, socketLive });
  }

  private tickChannel(channelId: string, state: ChannelState, tick: { now: number; intervalMs: number; socketLive: boolean }): void {
    if (!this.recovery.permits(state.channel)) return;
    if (state.receivedCursor > state.lastEmittedAckCursor) this.emitAck(channelId, state);
    // Session and preview receivers attach independently from the runtime
    // socket. Their absence is normal and the relay replays as soon as a
    // holder binds; it is not evidence that the shared socket is dead.
    // Rolling that socket only fences unrelated work and cannot make a
    // detached holder appear. Buffer bounds still produce explicit reset if
    // a later replay is no longer complete.
    if (holderBound(state.channel)) return;
    const stallDeadlineMs = tick.socketLive ? Math.max(this.stallDeadlineMs(state, tick.intervalMs), STALL_BACKOFF_CEILING_MS) : this.stallDeadlineMs(state, tick.intervalMs);
    // A late acknowledgement from a peer that is still sending on this
    // channel means busy, not dead (bb reconnects on a missed heartbeat,
    // never on late acks). Re-handshake only after the liveness window.
    if (overdue(state, tick.now, stallDeadlineMs)) this.markStalled(channelId, state, tick.now, stallDeadlineMs);
  }

  private markStalled(channelId: string, state: ChannelState, now: number, stallDeadlineMs: number): void {
    state.stalled = true;
    state.stallStreak = state.ackedByEndpoint > state.stallCursor ? 1 : state.stallStreak + 1;
    state.stallCursor = state.ackedByEndpoint;
    this.counters.stalls += 1;
    this.logger.warn({ event: "relay.channel.stalled", channelId, channel: state.channel, connectionEpoch: this.epoch,
      nextSeq: state.nextSeq, ackedByEndpoint: state.ackedByEndpoint, receivedCursor: state.receivedCursor,
      unackedCount: state.buffer.unackedCount, unackedBytes: state.buffer.unackedBytes,
      ackWaitMs: now - state.lastAckAt, ackDeadlineMs: stallDeadlineMs, stallStreak: state.stallStreak }, "channel stalled: no ack within its stall deadline; re-handshaking");
    this.options.onStall(channelId);
  }

  /**
   * A channel whose peer never returns must not re-handshake the shared socket
   * every deadline forever: each reconnect changes the runtime's connection
   * authority, which refuses unrelated assignments mid-preparation. Backoff
   * doubles per stall with no acknowledgement progress and resets as soon as
   * the endpoint acknowledges anything.
   */
  private stallDeadlineMs(state: ChannelState, intervalMs: number): number {
    const base = 2 * intervalMs;
    if (state.ackedByEndpoint > state.stallCursor) return base;
    return Math.min(base * 2 ** Math.min(state.stallStreak, 5), STALL_BACKOFF_CEILING_MS);
  }

  /** Only bounded protocol metadata; never bodies, signatures, or credentials. */
  private logReset(channelId: string, state: ChannelState, reason: string, peer?: { peerToCore: number; peerToRuntime: number; replayCount: number | null }): void {
    this.logger.warn({ event: "relay.channel.reset", channelId, channel: state.channel, connectionEpoch: this.epoch,
      reason, nextSeq: state.nextSeq, ackedByEndpoint: state.ackedByEndpoint, receivedCursor: state.receivedCursor,
      unackedCount: state.buffer.unackedCount, unackedBytes: state.buffer.unackedBytes,
      oldestUnackedAgeMs: state.buffer.snapshot()[0] ? Math.max(0, this.options.clock.now() - state.buffer.snapshot()[0]!.enqueuedAt) : null,
      replayMaxBytes: this.options.replayBufferBytes,
      replayRetention: holderBound(state.channel) ? "endpoint_ack_or_byte_limit" : "age_or_byte_limit",
      ...peer }, "channel replay reset");
  }

  /**
   * Bytes sent on a channel and not yet acknowledged by its endpoint. The
   * preview forwarder reads it as its flow-control window so a large response
   * never outruns the viewer's acknowledgements into a replay reset.
   */
  unackedBytes(channelId: string): number {
    return this.channels.get(channelId)?.buffer.unackedBytes ?? 0;
  }

  /** For the launcher status and the heartbeat. */
  snapshot(): Array<{ channelId: string; channel: RelayChannel; unacked: number; receivedCursor: number; stalled: boolean }> {
    return [...this.channels.entries()].map(([channelId, state]) => ({ channelId, channel: state.channel, unacked: state.buffer.unackedCount, receivedCursor: state.receivedCursor, stalled: state.stalled }));
  }
}
