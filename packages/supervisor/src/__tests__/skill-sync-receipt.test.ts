import { expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, symlink, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorStore } from "../state/store.js";
it("retains successful sync across restart only for the enrolled owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-sync-receipt-"));
  try {
    const store = new SupervisorStore(root); await store.init();
    const owner = { workspaceId: "tenant-a", instanceId: "machine-a" };
    const success = { syncedAt: new Date(1000).toISOString(), inventory: { skills: [], profiles: [] } };
    await store.saveSkillSyncSuccess(owner, success);
    expect(await new SupervisorStore(root).skillSyncSuccess(owner)).toEqual(success);
    await expect(store.skillSyncSuccess({ ...owner, workspaceId: "tenant-b" })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["symlink", "hardlink", "public-mode", "corrupt", "oversized"])("refuses %s historical receipts without changing their contents", async kind => {
  const root = await mkdtemp(join(tmpdir(), "skill-sync-receipt-"));
  try {
    const store = new SupervisorStore(root); await store.init();
    const owner = { workspaceId: "tenant-a", instanceId: "machine-a" };
    await store.saveSkillSyncSuccess(owner, { syncedAt: new Date(1000).toISOString(), inventory: { skills: [], profiles: [] } });
    const path = join(root, "skill-sync-success.json");
    if (kind === "symlink") {
      const target = join(root, "external-receipt.json");
      await writeFile(target, await readFile(path), { mode: 0o600 });
      await rm(path); await symlink(target, path);
    } else if (kind === "hardlink") await link(path, join(root, "other-receipt.json"));
    else if (kind === "public-mode") await chmod(path, 0o644);
    else if (kind === "corrupt") await writeFile(path, "{invalid");
    else await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
    const before = await readFile(path);
    await expect(store.skillSyncSuccess(owner)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("persists a pending result across restart and fences its enrollment", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-pending-"));
  try {
    const store = new SupervisorStore(root); await store.init();
    const owner = { workspaceId: "tenant-a", instanceId: "machine-a" };
    const result = { requestId: "manual", state: "succeeded" as const };
    await store.savePendingSkillReceipt(owner, result);
    expect(await new SupervisorStore(root).pendingSkillReceipt(owner)).toEqual(result);
    await expect(store.pendingSkillReceipt({ ...owner, workspaceId: "foreign" })).rejects.toThrow();
    await store.savePendingSkillReceipt(owner, null);
    expect(await new SupervisorStore(root).pendingSkillReceipt(owner)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses a linked pending result without following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-pending-link-"));
  try {
    const store = new SupervisorStore(root); await store.init();
    const owner = { workspaceId: "tenant-a", instanceId: "machine-a" };
    await store.savePendingSkillReceipt(owner, { requestId: "manual", state: "failed" });
    const path = join(root, "skill-sync-pending.json"), target = join(root, "external.json");
    await writeFile(target, await readFile(path), { mode: 0o600 });
    await rm(path); await symlink(target, path);
    await expect(store.pendingSkillReceipt(owner)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
