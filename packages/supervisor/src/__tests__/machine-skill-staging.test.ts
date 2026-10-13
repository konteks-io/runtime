import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRemoteFileTreeDigest, computeRuntimeSkillSyncCatalogDigest } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { stageMachineOrganizationSkills } from "../skills/staging.js";
function fixture(root: string) {
  const content = Buffer.from("# Skill");
  const entries = [{ path: "SKILL.md", mode: 0o600 as const, sizeBytes: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") }];
  const tree = { format: "konteks-file-tree-v1", entries, treeDigest: computeRemoteFileTreeDigest(entries) };
  const skills = [{ skillId: "11111111-1111-4111-8111-111111111111", name: "org-example", description: "Example", version: "1.0.0", treeDigest: tree.treeDigest, sizeBytes: content.length, fileCount: 1 }];
  const catalog = { version: 1, complete: true, binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills };
  const envelope = { type: "runtime_skill_sync", instanceId: "machine-a", catalog, catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), signature: "c2lnbmVk" };
  return { scratchRoot: root, envelope, owner: { workspaceId: "tenant-a", instanceId: "machine-a" }, assertAuthorized: vi.fn(async () => {}), fetchTree: vi.fn(async () => tree), now: Date.now };
}
it("stages complete immutable trees and refuses tampered cache without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-skills-"));
  try {
    const f = fixture(root); const staged = await stageMachineOrganizationSkills(f);
    expect(await readFile(staged.skills[0]!.skillFile, "utf8")).toBe("# Skill");
    expect(await stageMachineOrganizationSkills(f)).toEqual(staged); expect(f.fetchTree).toHaveBeenCalledTimes(1);
    await writeFile(staged.skills[0]!.skillFile, "Changed");
    await expect(stageMachineOrganizationSkills(f)).rejects.toThrow();
    expect(await readFile(staged.skills[0]!.skillFile, "utf8")).toBe("Changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("denies foreign enrollment and late live-authorization failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-skills-"));
  try {
    const f = fixture(root);
    await expect(stageMachineOrganizationSkills({ ...f, owner: { ...f.owner, workspaceId: "tenant-b" } })).rejects.toThrow();
    expect(f.fetchTree).not.toHaveBeenCalled();
    f.assertAuthorized.mockImplementation(async () => { if (f.fetchTree.mock.calls.length) throw new Error("revoked"); });
    await expect(stageMachineOrganizationSkills(f)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([
  { audience: { kind: "systems", systemRefs: ["system-a"] }, context: { kind: "global" } },
  { audience: { kind: "organization" }, context: { kind: "initiatives", initiativeRefs: ["initiative-a"] } },
  { audience: { kind: "personal", ownerUserRef: "owner-a" }, context: { kind: "global" } },
])("never stages restricted or owner-unproven Skills for general discovery: %j", async scope => {
  const root = await mkdtemp(join(tmpdir(), "machine-scoped-skills-"));
  try {
    const f = fixture(root);
    Object.assign(f.envelope.catalog.skills[0]!, { scope: { tenantId: "tenant-a", ...scope } });
    f.envelope.catalogDigest = computeRuntimeSkillSyncCatalogDigest(f.envelope.catalog);
    await expect(stageMachineOrganizationSkills(f)).rejects.toThrow();
    expect(f.fetchTree).not.toHaveBeenCalled();
    expect(f.assertAuthorized).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("stages explicitly organization-wide global Skills in the bound tenant", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-global-skills-"));
  try {
    const f = fixture(root);
    Object.assign(f.envelope.catalog.skills[0]!, { scope: { tenantId: "tenant-a", audience: { kind: "organization" }, context: { kind: "global" } } });
    f.envelope.catalogDigest = computeRuntimeSkillSyncCatalogDigest(f.envelope.catalog);
    expect((await stageMachineOrganizationSkills(f)).skills).toHaveLength(1);
    expect(f.fetchTree).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
