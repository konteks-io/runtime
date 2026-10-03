/** Preserve reconnect intent and retry a failed automatic refresh without
 * bypassing the supervisor's current lease, identity, or publication checks. */
export class SkillRefreshScheduler {
  private running = false;
  private queued = false;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly delays = [5_000, 15_000, 30_000, 60_000] as const;
  constructor(private readonly options: {
    refresh: () => Promise<unknown>;
    active: () => boolean;
    failed: () => void;
  }) {}
  request(): void {
    if (this.closed || !this.options.active()) return;
    this.retry = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) { this.queued = true; return; }
    this.run();
  }
  stop(): void {
    this.closed = true;
    this.queued = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private run(): void {
    if (this.closed || !this.options.active()) return;
    this.running = true;
    void this.options.refresh().then(() => {
      this.retry = 0;
    }, () => {
      this.options.failed();
      const delay = this.delays[this.retry++];
      if (!this.closed && !this.queued && this.options.active() && delay !== undefined) {
        this.timer = setTimeout(() => { this.timer = undefined; this.run(); }, delay);
        this.timer.unref();
      }
    }).finally(() => {
      this.running = false;
      if (this.queued && !this.closed) { this.queued = false; this.run(); }
    });
  }
}
