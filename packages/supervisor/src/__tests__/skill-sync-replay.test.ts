import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeSkillSyncRequestSigningBytes } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { sha256Hex } from "@konteks/remote-common";
import { reserveSkillSyncRequest } from "../skills/sync-replay.js";
it("persists replay reservations and refuses a foreign machine owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-sync-replay-"));
  const request = { type: "runtime_skill_sync_request", workspaceId: "tenant-a", instanceId: "machine-a", requestId: "request-a", issuedAt: "2026-10-03T00:00:00Z", expiresAt: "2026-10-03T00:01:00Z", signature: "c2lnbmVk" };
  const digest = sha256Hex(runtimeSkillSyncRequestSigningBytes(request)), now = Date.parse(request.issuedAt) + 1000;
  try {
    expect(await reserveSkillSyncRequest(root, request, digest, now)).toBe(true);
    expect(await reserveSkillSyncRequest(root, structuredClone(request), digest, now)).toBe(false);
    const foreign = { ...request, workspaceId: "tenant-b", requestId: "request-b" };
    await expect(reserveSkillSyncRequest(root, foreign, sha256Hex(runtimeSkillSyncRequestSigningBytes(foreign)), now)).rejects.toThrow();
    const changed = { ...request, expiresAt: "2026-10-03T00:00:59Z" };
    await expect(reserveSkillSyncRequest(root, changed, sha256Hex(runtimeSkillSyncRequestSigningBytes(changed)), now)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
