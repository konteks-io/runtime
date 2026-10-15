import type { Logger } from "@konteks/remote-common";
import { lastSlowJournalWork } from "./state/slow-work.js";

const TICK_MS = 1_000;
/** A held loop delays heartbeats and relay frames; two seconds is already visible to the person. */
const STALL_MS = 2_000;

/**
 * Diagnostic only (D175): logs when the connector's event loop was held, for
 * how long, and the last slow journal work before it. Never acts on a stall.
 */
export class EventLoopWatch {
  private timer: NodeJS.Timeout | null = null;
  private expected = 0;

  constructor(private readonly logger: Logger, private readonly options: { tickMs?: number; stallMs?: number; now?: () => number } = {}) {}

  start(): void {
    if (this.timer) return;
    const tickMs = this.options.tickMs ?? TICK_MS;
    this.expected = this.now() + tickMs;
    this.timer = setInterval(() => this.tick(tickMs), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: one interval firing. */
  tick(tickMs: number): void {
    const now = this.now();
    const stalledMs = now - this.expected;
    this.expected = now + tickMs;
    if (stalledMs < (this.options.stallMs ?? STALL_MS)) return;
    this.logger.warn({ event: "native.event_loop.stalled", stalledMs, lastSlowJournalWork: lastSlowJournalWork() ?? null },
      "the connector's event loop was held");
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
