/** One organization refresh at a time; failed refreshes retain last successful inventory. */
export class SkillSyncCoordinator<T> {
  private pending: Promise<T> | undefined;
  private closed = false;
  private controller: AbortController | undefined;
  private lastSuccess: { syncedAt: string; inventory: T } | undefined;
  constructor(private readonly refresh: (signal: AbortSignal) => Promise<T>, private readonly now = Date.now,
    private readonly persistence?: { initialSuccess?: { syncedAt: string; inventory: T }; persistSuccess?: (success: { syncedAt: string; inventory: T }) => Promise<void> }) {
    this.lastSuccess = persistence?.initialSuccess ? structuredClone(persistence.initialSuccess) : undefined;
  }
  status(): { syncing: boolean; lastSuccess?: { syncedAt: string; inventory: T } } {
    return structuredClone({ syncing: !!this.pending, ...(this.lastSuccess ? { lastSuccess: this.lastSuccess } : {}) });
  }
  sync(): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Skill synchronization is stopped"));
    if (this.pending) return this.pending;
    const controller = new AbortController(); this.controller = controller;
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Skill synchronization is stopped");
      return this.refresh(controller.signal);
    }).then(async inventory => {
      if (controller.signal.aborted) throw new Error("Skill synchronization is stopped");
      const success = { syncedAt: new Date(this.now()).toISOString(), inventory: structuredClone(inventory) };
      await this.persistence?.persistSuccess?.(structuredClone(success));
      if (controller.signal.aborted) throw new Error("Skill synchronization is stopped");
      this.lastSuccess = success;
      return inventory;
    }).finally(() => { if (this.pending === pending) { this.pending = undefined; this.controller = undefined; } });
    this.pending = pending; return pending;
  }
  stop(): void { this.closed = true; this.controller?.abort(); }
}
