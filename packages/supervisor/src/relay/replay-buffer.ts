/**
 * Sender-owned bounded replay buffer for one `(channelId, direction)` (D99).
 * Frames stay here until a validated, epoch-matching `RelayAck` covers them.
 * Bounds are bytes and age from Core configuration; once a frame the buffer
 * no longer holds would be needed for replay, the channel must `reset`.
 */
export interface BufferedFrame<T> {
  seq: number;
  frame: T;
  bytes: number;
  enqueuedAt: number;
}

export interface ReplayBufferOptions {
  maxBytes: number;
  maxAgeMs: number;
}

export class ReplayBuffer<T> {
  private readonly frames: BufferedFrame<T>[] = [];
  private bytes = 0;
  private acked = 0;
  private lowestHeld = 1;
  private overflowed = false;

  constructor(private readonly options: ReplayBufferOptions) {}

  get unackedCount(): number {
    return this.frames.length;
  }

  get unackedBytes(): number {
    return this.bytes;
  }

  get cumulativeAcked(): number {
    return this.acked;
  }

  /** True once a frame that is still unacked has been evicted for size/age. */
  get needsReset(): boolean {
    return this.overflowed;
  }

  push(seq: number, frame: T, bytes: number, now: number): void {
    this.frames.push({ seq, frame, bytes, enqueuedAt: now });
    this.bytes += bytes;
    this.evict(now);
  }

  /** Restore already-durable frames without changing their original age. */
  restore(entries: readonly BufferedFrame<T>[], cumulativeAcked: number, now: number): void {
    this.frames.length = 0;
    this.bytes = 0;
    this.acked = cumulativeAcked;
    this.lowestHeld = cumulativeAcked + 1;
    this.overflowed = false;
    for (const entry of entries) {
      if (entry.seq <= cumulativeAcked) continue;
      this.frames.push({ ...entry });
      this.bytes += entry.bytes;
    }
    this.evict(now);
  }

  /** Whether the frame with this sequence is still held (unacknowledged). */
  holds(seq: number): boolean {
    return this.frames.some(entry => entry.seq === seq);
  }

  snapshot(): BufferedFrame<T>[] {
    return this.frames.map(entry => ({ ...entry }));
  }

  /** Cumulative ack: everything ≤ seq is durably received by the endpoint. */
  ackUpTo(seq: number): number {
    if (seq <= this.acked) return 0;
    let freed = 0;
    while (this.frames.length > 0 && (this.frames[0]?.seq ?? Number.POSITIVE_INFINITY) <= seq) {
      const head = this.frames.shift();
      if (head) {
        this.bytes -= head.bytes;
        freed += 1;
      }
    }
    this.acked = seq;
    this.lowestHeld = Math.max(this.lowestHeld, seq + 1);
    return freed;
  }

  /** Frames after `cursor` for replay on resume; null when a needed frame is gone. */
  after(cursor: number): BufferedFrame<T>[] | null {
    if (cursor + 1 < this.lowestHeld && this.frames.length > 0) return null;
    if (cursor + 1 < this.lowestHeld && cursor < this.acked && this.overflowed) return null;
    return this.frames.filter((entry) => entry.seq > cursor);
  }

  halfFull(): boolean {
    return this.bytes * 2 >= this.options.maxBytes;
  }

  private evict(now: number): void {
    while (this.frames.length > 0) {
      const head = this.frames[0];
      if (!head) break;
      const tooOld = now - head.enqueuedAt > this.options.maxAgeMs;
      const tooBig = this.bytes > this.options.maxBytes;
      if (!tooOld && !tooBig) break;
      this.frames.shift();
      this.bytes -= head.bytes;
      this.lowestHeld = head.seq + 1;
      this.overflowed = true;
    }
  }
}
