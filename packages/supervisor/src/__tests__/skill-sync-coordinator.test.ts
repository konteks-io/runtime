import { expect, it, vi } from "vitest";
import { SkillSyncCoordinator } from "../skills/sync-coordinator.js";
it("coalesces startup/manual requests and retains successful inventory after failure", async () => {
  let finish!: (value: string[]) => void;
  const refresh = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
  const sync = new SkillSyncCoordinator(refresh, () => 1000);
  const first = sync.sync(); expect(sync.sync()).toBe(first);
  await Promise.resolve(); finish(["org-a"]); await first;
  expect(refresh).toHaveBeenCalledTimes(1);
  refresh.mockRejectedValueOnce(new Error("offline"));
  await expect(sync.sync()).rejects.toThrow("offline");
  expect(sync.status()).toEqual({ syncing: false, lastSuccess: { syncedAt: new Date(1000).toISOString(), inventory: ["org-a"] } });
});
it("refuses completion after shutdown", async () => {
  let finish!: (value: string[]) => void;
  const sync = new SkillSyncCoordinator(() => new Promise<string[]>(resolve => { finish = resolve; }));
  const pending = sync.sync(); await Promise.resolve(); sync.stop(); finish([]);
  await expect(pending).rejects.toThrow("stopped"); expect(sync.status().lastSuccess).toBeUndefined();
  await expect(sync.sync()).rejects.toThrow("stopped");
});

it("restores historical success and commits persistence before reporting new success", async () => {
  const historical = { syncedAt: new Date(1000).toISOString(), inventory: ["old"] };
  const persist = vi.fn(async () => { throw new Error("disk unavailable"); });
  const sync = new SkillSyncCoordinator(async () => ["new"], () => 2000, { initialSuccess: historical, persistSuccess: persist });
  expect(sync.status().lastSuccess).toEqual(historical);
  await expect(sync.sync()).rejects.toThrow("disk unavailable");
  expect(sync.status().lastSuccess).toEqual(historical);
  persist.mockResolvedValueOnce(); await sync.sync();
  expect(sync.status().lastSuccess).toEqual({ syncedAt: new Date(2000).toISOString(), inventory: ["new"] });
});

it("periodically reconciles only while ready and stops its fallback timer", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => ["latest"]), failure = vi.fn();
  let ready = false;
  const sync = new SkillSyncCoordinator(refresh);
  try {
    sync.startPeriodic(() => ready, failure, 1000);
    sync.startPeriodic(() => ready, failure, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(failure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(3);
    sync.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally { sync.stop(); vi.useRealTimers(); }
});

it("waits for an aborted refresh to finish before shutdown can release ownership", async () => {
  let finish!: (value: string[]) => void;
  const refresh = vi.fn((signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    return new Promise<string[]>(resolve => { finish = resolve; });
  });
  const sync = new SkillSyncCoordinator(refresh);
  const pending = sync.sync();
  await Promise.resolve();
  sync.stop();
  let settled = false;
  const shutdown = sync.settle().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish(["late"]);
  await expect(pending).rejects.toThrow("stopped");
  await shutdown;
  expect(settled).toBe(true);
  expect(sync.status().lastSuccess).toBeUndefined();
});
