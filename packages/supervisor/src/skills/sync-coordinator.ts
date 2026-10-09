/** One organization refresh at a time; failed refreshes retain last successful inventory. */
export class SkillSyncCoordinator<T> {
  private pending: Promise<T> | undefined;
  private refreshAgain = false;
  private closed = false;
  private periodic: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private lastSuccess: { syncedAt: string; inventory: T } | undefined;
  constructor(private readonly refresh: (signal: AbortSignal) => Promise<T>, private readonly now = Date.now,
    private readonly persistence?: { initialSuccess?: { syncedAt: string; inventory: T }; persistSuccess?: (success: { syncedAt: string; inventory: T }) => Promise<void> }) {
    this.lastSuccess = persistence?.initialSuccess ? structuredClone(persistence.initialSuccess) : undefined;
  }
  status(): { syncing: boolean; lastSuccess?: { syncedAt: string; inventory: T } } {
    return structuredClone({ syncing: !!this.pending, ...(this.lastSuccess ? { lastSuccess: this.lastSuccess } : {}) });
  }
  sync(reconcileAfterPending = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Skill synchronization is stopped"));
    if (this.pending) {
      this.refreshAgain ||= reconcileAfterPending;
      return this.pending;
    }
    const controller = new AbortController(); this.controller = controller;
    const pending = Promise.resolve().then(() => this.reconcile(controller.signal))
      .finally(() => { if (this.pending === pending) { this.pending = undefined; this.controller = undefined; } });
    this.pending = pending; return pending;
  }
  private async reconcile(signal: AbortSignal): Promise<T> {
    do {
      this.refreshAgain = false;
      try {
        const inventory = await this.refreshAndRecord(signal);
        if (!this.refreshAgain) return inventory;
      } catch (error) {
        if (signal.aborted || !this.refreshAgain) throw error;
      }
    } while (!signal.aborted);
    throw new Error("Skill synchronization is stopped");
  }
  private async refreshAndRecord(signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error("Skill synchronization is stopped");
    const inventory = await this.refresh(signal);
    if (signal.aborted) throw new Error("Skill synchronization is stopped");
    const success = { syncedAt: new Date(this.now()).toISOString(), inventory: structuredClone(inventory) };
    await this.persistence?.persistSuccess?.(structuredClone(success));
    if (signal.aborted) throw new Error("Skill synchronization is stopped");
    this.lastSuccess = success;
    return inventory;
  }
  startPeriodic(ready: () => boolean, onFailure: () => void, intervalMs = 60_000): void {
    if (this.closed || this.periodic) return;
    this.periodic = setInterval(() => {
      if (ready()) void this.sync().catch(() => onFailure());
    }, intervalMs);
    this.periodic.unref();
  }
  async settle(): Promise<void> {
    await this.pending?.catch(() => undefined);
  }
  stop(): void {
    this.closed = true;
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = undefined;
    this.controller?.abort();
  }
}
