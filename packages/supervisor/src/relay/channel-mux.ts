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
 * The typed channel mux (D99/D107/D114/D115/D117):
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
  /** D143 assignment receipts and request ACKs use the durable assignment journal. */
  onAssignmentFrame?: (frame: AssignmentReplyFrame) => Promise<number>;
  onAssignmentRequestAck?: (ack: RelayAck) => Promise<void>;
  /** D143 logical cursors replace generic mux counters in the relay handshake. */
  assignmentCursors?: () => { channelId: string; to_core: number; to_runtime: number } | null;
  onStall: (channelId: string) => void;
  onReset: (channelId: string) => void;
  /** Persist the durable receive cursor (the authoritative cursor for to_runtime, D107). */
  persistCursors: (cursors: Record<string, { to_core: number; to_runtime: number; allocated?: number | undefined }>) => Promise<void>;
  /** Production durability boundary: allocation, replay bytes and cursors in one atomic write. */
  persistRelayState?: (state: RelayDurableState) => Promise<void>;
  logger?: Logger;
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

export interface MuxCounters {
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
      // already-durable duplicate — a fresh session_ready vanished silently
      // (live 2026-09-12). Sequence numbers are never handed out twice.
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

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  channelIds(): string[] {
    return [...this.channels.keys()];
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
          maxAgeMs: channel === "session" ? Number.POSITIVE_INFINITY : this.options.replayBufferAgeMs }),
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

  /** Generic replay cursor persistence excludes D143's independently durable stream. */
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
    for (const channelId of result.reset) {
      const state = this.channels.get(channelId);
      if (!state) continue;
      this.logReset(channelId, state, "peer_reset");
      if (state.channel === "assignment" && this.options.assignmentCursors) {
        this.counters.resets += 1; this.options.onReset(channelId); continue;
      }
      this.counters.resets += 1;
      const replay = state.buffer.after(state.ackedByEndpoint);
      const complete = replay !== null && !state.buffer.needsReset &&
        replay.length === state.nextSeq - 1 - state.ackedByEndpoint;
      if (!complete) {
        // The sender no longer has a contiguous history to rebuild the peer.
        // Retain every remaining byte and fence new sends; clearing while the
        // allocation cursor advances manufactures an unrecoverable seq hole.
        state.stalled = true;
        this.options.onReset(channelId);
        continue;
      }
      // A reset peer is rebuilt from the sender-owned durable replay. This is
      // not an execution reset and does not discard or renumber any frame.
      state.stalled = false;
      state.lastAckAt = this.options.clock.now();
      state.lastInboundAt = this.options.clock.now();
      for (const entry of replay) {
        if (this.recovery.permits(state.channel)) this.options.emit({ ...entry.frame, connectionEpoch: this.epoch });
      }
    }
    for (const [channelId, cursor] of Object.entries(result.resume)) {
      const state = this.channels.get(channelId);
      if (!state || result.reset.includes(channelId)) continue;
      // Assignment replay comes only from the journal-owned sender. Handshake
      // cursors are hints and cannot mutate or replace either durable counter.
      if (state.channel === "assignment" && this.options.assignmentCursors) continue;
      state.stalled = false;
      state.lastAckAt = this.options.clock.now();
      // D117: only a validated source-specific RelayAck frees replay. A peer
      // resume hint cannot stand in for an ACK that we never received.
      const replay = state.buffer.after(state.ackedByEndpoint);
      if (cursor.to_core < state.ackedByEndpoint || cursor.to_core >= state.nextSeq || replay === null ||
          state.buffer.needsReset || replay.length !== state.nextSeq - 1 - state.ackedByEndpoint) {
        const reason = cursor.to_core < state.ackedByEndpoint ? "resume_cursor_regressed"
          : cursor.to_core >= state.nextSeq ? "resume_cursor_ahead"
          : state.buffer.needsReset ? "replay_evicted"
          : replay === null ? "replay_unavailable" : "replay_incomplete";
        this.logReset(channelId, state, reason, { peerToCore: cursor.to_core, peerToRuntime: cursor.to_runtime, replayCount: replay?.length ?? null });
        // Preserve the remaining replay and its allocation. Recovery may use
        // it as evidence; erasing it here would create a new sequence hole.
        state.stalled = true;
        this.counters.resets += 1;
        this.options.onReset(channelId);
        continue;
      }
      for (const entry of replay) {
        if (this.recovery.permits(state.channel)) this.options.emit({ ...entry.frame, connectionEpoch: this.epoch });
      }
    }
    // Take the snapshot when this write executes, after earlier receive commits.
    return this.serialize(() => this.persist(this.durableState()));
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
    const replay = state.buffer.after(state.ackedByEndpoint);
    if (!replay || state.buffer.needsReset) {
      state.stalled = true;
      this.counters.resets += 1;
      this.options.onReset(request.channelId);
      return Promise.resolve();
    }
    state.stalled = false;
    state.lastAckAt = this.options.clock.now();
    state.lastInboundAt = this.options.clock.now();
    for (const entry of replay) {
      if (!this.recovery.permits(state.channel)) break;
      this.options.emit({ ...entry.frame, connectionEpoch: this.epoch });
    }
    return Promise.resolve();
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
      for (const entry of replay) {
        if (!this.recovery.permits(state.channel)) break;
        this.options.emit({ ...entry.frame, connectionEpoch: this.epoch });
      }
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
    // A session may have advanced through the HTTPS carrier before its first
    // relay frame. Its durable source sequence is the authority; a pristine
    // relay-local allocator may join that already-accepted prefix once.
    if (expectedSequence !== undefined && expectedSequence > state.nextSeq && state.nextSeq === 1 && state.ackedByEndpoint === 0) state.nextSeq = expectedSequence;
    const seq = state.nextSeq;
    if (expectedSequence !== undefined && expectedSequence !== seq) throw new RemoteInstanceError("recovery_required", "Durable logical source sequence differs from relay sequence");
    state.nextSeq += 1;
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
    // Allocation and replay bytes become durable before the socket can observe
    // them. A crash before this write emits nothing; a crash after it replays.
    // A handshake that races this durability write owns replay on its new
    // epoch; the original send continuation must not emit the same frame too.
    const sendGeneration = this.generation;
    void this.serialize(async () => {
      await this.persist(this.durableState());
      if (channel === "session" && (body as { kind?: string }).kind === "session_ready") {
        this.logger.info({ event: "relay.session_ready.persisted", channelId, seq, connectionEpoch: this.epoch,
          connected: this.connected, stalled: state.stalled, recoveryPermitted: this.recovery.permits(channel),
          generationChanged: this.generation !== sendGeneration,
          persistenceMs: Math.max(0, this.options.clock.now() - Date.parse(frame.issuedAt)) },
          "session readiness retained for endpoint delivery");
      }
      if (this.generation !== sendGeneration || this.channels.get(channelId) !== state ||
          !state.buffer.snapshot().some(entry => entry.seq === seq)) return;
      if (this.connected && !state.stalled && this.recovery.permits(channel)) this.options.emit({ ...frame, connectionEpoch: this.epoch });
    }).catch(error => {
      this.logger.warn({ err: error, channelId, seq }, "relay outbound durability failed; retaining the frame without emitting");
      this.options.onStall(channelId);
    });
    return seq;
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
    if (ack.success && ack.data.connectionEpoch === this.epoch) this.lastSocketInboundAt = this.options.clock.now();
    if (ack.success) {
      if (this.options.onAssignmentRequestAck && ack.data.channelId.startsWith("assignment:") && ack.data.origin === "core" && ack.data.dataDirection === "to_core") {
        const assertRecovery = this.recovery.capture("assignment");
        return this.receiveAssignmentRequestAck(ack.data, generation, assertRecovery);
      }
      const state = this.channels.get(ack.data.channelId);
      if (!state) return Promise.resolve();
      if (ack.data.connectionEpoch === this.epoch) state.lastInboundAt = this.options.clock.now();
      const highestSent = state.nextSeq - 1;
      const assertRecovery = this.recovery.capture(state.channel);
      return this.serialize(() => this.receiveAck(ack.data, state, generation, highestSent, assertRecovery));
    }
    const assignment = AssignmentReplyFrameSchema.safeParse(envelope);
    if (assignment.success) {
      if (!this.connected || assignment.data.connectionEpoch !== this.epoch) {
        this.counters.epochStale += 1;
        return Promise.resolve();
      }
      const assertRecovery = this.recovery.capture("assignment");
      const prior = this.receiveLanes.get(assignment.data.channelId) ?? Promise.resolve();
      const result = prior.then(() => this.receiveAssignmentFrame(assignment.data, generation, assertRecovery));
      this.receiveLanes.set(assignment.data.channelId, result.then(() => undefined, () => undefined));
      return result;
    }
    const frame = ToRuntimeRelayFrameSchema.safeParse(envelope);
    if (!frame.success) {
      this.counters.invalidFrames += 1;
      this.logger.warn("dropped an envelope that matches no relay schema");
      return Promise.resolve();
    }
    if (frame.data.channel === "assignment" && this.options.onAssignmentFrame) {
      throw new RemoteInstanceError("assignment_channel_invalid", "Bare assignment replies are disabled for the durable assignment carrier.");
    }
    if (!this.connected || frame.data.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1;
      return Promise.resolve();
    }
    // Capture identity before queueing so close/reopen cannot adopt an old frame.
    const assertRecovery = this.recovery.capture(frame.data.channel);
    const state = this.ensure(frame.data.channelId, frame.data.channel);
    // Receipt is liveness even while processing this frame takes a while.
    state.lastInboundAt = this.options.clock.now();
    this.lastSocketInboundAt = state.lastInboundAt;
    const prior = this.receiveLanes.get(frame.data.channelId) ?? Promise.resolve();
    const result = prior.then(() => this.receiveFrame(frame.data, state, generation, assertRecovery));
    this.receiveLanes.set(frame.data.channelId, result.then(() => undefined, () => undefined));
    return result;
  }

  private async receiveAssignmentRequestAck(ack: RelayAck, generation: number, assertRecovery: () => void): Promise<void> {
    if (!this.connected || generation !== this.generation || ack.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1; return;
    }
    assertRecovery();
    if (!this.options.onAssignmentRequestAck) throw new Error("No durable assignment request ACK owner is attached.");
    await this.options.onAssignmentRequestAck(ack);
    assertRecovery();
    if (!this.connected || generation !== this.generation) throw new Error("Assignment request ACK owner changed during persistence.");
  }

  private async receiveAssignmentFrame(frame: AssignmentReplyFrame, generation: number, assertRecovery: () => void): Promise<void> {
    if (!this.connected || generation !== this.generation || frame.connectionEpoch !== this.epoch) {
      this.counters.epochStale += 1; return;
    }
    assertRecovery();
    if (!this.options.onAssignmentFrame) throw new Error("No durable assignment reply owner is attached.");
    const consumed = await this.options.onAssignmentFrame(frame);
    assertRecovery();
    if (!this.connected || generation !== this.generation || !Number.isSafeInteger(consumed) || consumed < frame.seq) {
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
    const origin = state.channel === "session" || state.channel === "preview" ? "grant_holder" : "core";
    if (ack.origin !== origin || ack.cumulativeSeq > highestSent) {
      this.counters.invalidFrames += 1;
      return;
    }
    if (ack.cumulativeSeq > state.ackedByEndpoint) {
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
    for (const [channelId, state] of this.channels) {
      if (!this.recovery.permits(state.channel)) continue;
      if (state.receivedCursor > state.lastEmittedAckCursor) this.emitAck(channelId, state);
      // Session and preview receivers attach independently from the runtime
      // socket. Their absence is normal and D156 asks us to replay as soon as
      // a holder binds; it is not evidence that the shared socket is dead.
      // Rolling that socket only fences unrelated work and cannot make a
      // detached holder appear. Buffer bounds still produce explicit reset if
      // a later replay is no longer complete.
      if (state.channel === "session" || state.channel === "preview") continue;
      const stallDeadlineMs = socketLive ? Math.max(this.stallDeadlineMs(state, intervalMs), STALL_BACKOFF_CEILING_MS) : this.stallDeadlineMs(state, intervalMs);
      // A late acknowledgement from a peer that is still sending on this
      // channel means busy, not dead (bb reconnects on a missed heartbeat,
      // never on late acks). Re-handshake only after the liveness window.
      if (state.buffer.unackedCount > 0 && !state.stalled && now - state.lastAckAt > stallDeadlineMs && now - state.lastInboundAt > CHANNEL_LIVENESS_MS) {
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
    }
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
      replayRetention: state.channel === "session" ? "endpoint_ack_or_byte_limit" : "age_or_byte_limit",
      ...peer }, "channel replay reset");
  }

  /** For the launcher status and the heartbeat. */
  snapshot(): Array<{ channelId: string; channel: RelayChannel; unacked: number; receivedCursor: number; stalled: boolean }> {
    return [...this.channels.entries()].map(([channelId, state]) => ({ channelId, channel: state.channel, unacked: state.buffer.unackedCount, receivedCursor: state.receivedCursor, stalled: state.stalled }));
  }
}
