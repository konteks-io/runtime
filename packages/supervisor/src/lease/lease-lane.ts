/**
 * Core lease acquisition and adoption run one at a time, in order: a
 * heartbeat's renewal and a reconnect's re-establishment must never adopt
 * leases out of order.
 *
 * An operation holds the lane for at most `holdMs`. On 10-09 (production, a
 * host starved of memory) one lease operation never settled: every later
 * heartbeat waited behind it and was abandoned at its own deadline (stage
 * "lease"), the lease lapsed, the relay refused the connector and the
 * computer stayed "not connected" until the process was restarted. The
 * heartbeat's deadline freed only its caller, never the lane.
 *
 * Past `holdMs` the lane moves on and its generation advances: the operation
 * that overstayed still runs, but a fence captured during its turn now fails,
 * so it can no longer adopt a lease behind a newer one.
 */
export interface LeaseLaneOptions {
  holdMs: number;
  onOverrun: (detail: { operation: string; heldMs: number }) => void;
}

export class LeaseLane {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly options: LeaseLaneOptions) {}

  /** Advances whenever an operation is released for overstaying its turn. */
  current(): number {
    return this.generation;
  }

  run<T>(operation: () => Promise<T>, name: string): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = next;
    return previous.then(() => {
      const startedAt = Date.now();
      const overrun = setTimeout(() => {
        this.generation += 1;
        this.options.onOverrun({ operation: name, heldMs: Date.now() - startedAt });
        release();
      }, this.options.holdMs);
      overrun.unref?.();
      const turn = Promise.resolve().then(operation);
      const settled = () => { clearTimeout(overrun); release(); };
      turn.then(settled, settled);
      return turn;
    });
  }

  /** Settles once every operation queued so far has had its turn. */
  idle(): Promise<void> {
    return this.tail;
  }
}
