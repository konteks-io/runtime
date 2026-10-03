import { expect, it, vi } from "vitest";
import { admitSkillSyncRequest } from "../skills/sync-request.js";
const request = { type: "runtime_skill_sync_request", workspaceId: "tenant-a", instanceId: "machine-a", requestId: "request-a", issuedAt: "2026-10-03T00:00:00Z", expiresAt: "2026-10-03T00:01:00Z", signature: "c2lnbmVk" };
const now = Date.parse("2026-10-03T00:00:01Z");
it("checks crypto, current owner and time before reserving a request", async () => {
  const reserve = vi.fn(async () => true), sync = vi.fn(async () => {});
  for (const [candidate, time, verified] of [[{ ...request, workspaceId: "tenant-b" }, now, true], [request, now + 60000, true], [request, Number.NaN, true], [request, now, false]] as const) {
    await expect(admitSkillSyncRequest(candidate, { verify: () => verified, owner: () => ({ workspaceId: "tenant-a", instanceId: "machine-a", active: true }), now: () => time, reserve, sync })).rejects.toThrow();
  }
  expect(reserve).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
});
it("does not execute a duplicate and rechecks lifecycle after durable reservation", async () => {
  let active = true;
  const sync = vi.fn(async () => {});
  const deps = { verify: () => true, owner: () => ({ workspaceId: "tenant-a", instanceId: "machine-a", active }), now: () => now, reserve: async () => false, sync };
  expect(await admitSkillSyncRequest(request, deps)).toBe("duplicate");
  await expect(admitSkillSyncRequest(request, { ...deps, reserve: async () => { active = false; return true; } })).rejects.toThrow();
  expect(sync).not.toHaveBeenCalled();
});
