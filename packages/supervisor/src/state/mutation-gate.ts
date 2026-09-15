import { RemoteInstanceError } from "@konteks/remote-common";

export type StateMutation = <T>(operation: () => Promise<T>) => Promise<T>;
export const unrestrictedStateMutation: StateMutation = operation => operation();

/** Fence late callbacks and settle accepted filesystem work before unlocking. */
export class StateMutationGate {
  private accepting = true;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly assertOwned: () => void) {}

  readonly run: StateMutation = operation => {
    if (!this.accepting) return Promise.reject(new RemoteInstanceError("temporarily_unavailable", "Native state owner has stopped."));
    const task = Promise.resolve().then(() => { this.assertOwned(); return operation(); });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  };

  async close(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled([...this.pending]);
  }
}
