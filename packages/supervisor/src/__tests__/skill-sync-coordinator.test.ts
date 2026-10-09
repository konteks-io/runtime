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
