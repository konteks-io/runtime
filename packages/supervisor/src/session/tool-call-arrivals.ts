import { plainRecord } from "@konteks/remote-common";

/** How long a host agent's permission request waits for the tool call it names. */
export const TOOL_CALL_ARRIVAL_MS = 10_000;

/**
 * A host agent's permission request names a tool call it announced first
 * (dsh drains its updates before it asks), but the connector handles runner
 * events concurrently: the request's handler can reach the governance before
 * the announcement's handler has recorded the call. Without this wait dsh's
 * genuine calls were refused as uncorrelated (515 on one computer, 11-02 to
 * 11-05). A request whose call never arrives is still refused after the bound.
 */
export class ToolCallArrivals {
  private readonly waiting = new Map<string, Set<(arrived: boolean) => void>>();

  constructor(private readonly boundMs = TOOL_CALL_ARRIVAL_MS) {}

  /** A session update; wakes the requests waiting for the call it announces. */
  observe(update: unknown): void {
    const value = plainRecord(update);
    if (value?.sessionUpdate !== "tool_call" || typeof value.toolCallId !== "string") return;
    for (const settle of [...this.waiting.get(value.toolCallId) ?? []]) settle(true);
  }

  /** The session ended: nothing more will arrive, so no request waits on. */
  release(): void {
    for (const wakers of [...this.waiting.values()]) for (const settle of [...wakers]) settle(false);
  }

  /** True once the call is announced, false when the bound passes or the session ends first. */
  wait(toolCallId: string): Promise<boolean> {
    return new Promise(resolve => {
      const wakers = this.waiting.get(toolCallId) ?? new Set<(arrived: boolean) => void>();
      const settle = (arrived: boolean) => {
        clearTimeout(timer);
        wakers.delete(settle);
        if (wakers.size === 0) this.waiting.delete(toolCallId);
        resolve(arrived);
      };
      const timer = setTimeout(() => settle(false), this.boundMs);
      timer.unref?.();
      wakers.add(settle);
      this.waiting.set(toolCallId, wakers);
    });
  }
}
