import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RemoteFileTreeSchema, computeRemoteFileTreeDigest } from "@konteks/remote-common";
import {
  RuntimeSkillSyncEnvelopeSchema,
  computeRuntimeSkillSyncCatalogDigest,
  type RuntimeSkillSyncOwnerPublishResponse,
  type RuntimeSkillSyncEnvelope,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { ManualRuntimeSkillSync } from "../skills/manual-sync.js";
import { LocalSkillPublicationStore } from "../skills/local-publications.js";

const workspaceId = "workspace-a";
const instanceId = "instance-a";
const skillId = "04c6eb8c-244b-4f73-92cc-2f1956be4995";
const personalSkillId = "14c6eb8c-244b-4f73-92cc-2f1956be4995";
const systemSkillId = "24c6eb8c-244b-4f73-92cc-2f1956be4995";
const initiativeSkillId = "34c6eb8c-244b-4f73-92cc-2f1956be4995";
const unscopedSkillId = "44c6eb8c-244b-4f73-92cc-2f1956be4995";

function fixture(now = Date.now(), includeRestrictedScopes = false) {
  const content = Buffer.from("---\nname: fixture\ndescription: fixture\n---\n");
  const entries = [
    {
      path: "SKILL.md",
      mode: 0o600 as const,
      sizeBytes: content.length,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      contentBase64: content.toString("base64"),
    },
  ];
  const tree = RemoteFileTreeSchema.parse({
    format: "konteks-file-tree-v1",
    treeDigest: computeRemoteFileTreeDigest(entries),
    entries,
  });
  const binding = { workspaceId, instanceId, syncId: "sync-a" };
  const baseSkill = {
    version: "1.0.0",
    description: "fixture skill",
    treeDigest: tree.treeDigest,
    sizeBytes: content.length,
    fileCount: 1,
  };
  const globalOrganizationSkill = {
    ...baseSkill,
    skillId,
    name: "fixture",
    scope: { tenantId: workspaceId, audience: { kind: "organization" as const }, context: { kind: "global" as const } },
  };
  const catalog = {
    version: 1 as const,
    complete: true as const,
    binding,
    catalogRevision: `sha256:${"a".repeat(64)}`,
    skills: [globalOrganizationSkill, ...(includeRestrictedScopes ? [
      { ...baseSkill, skillId: personalSkillId, name: "personal", scope: { tenantId: workspaceId, audience: { kind: "personal" as const, ownerUserRef: "user-a" }, context: { kind: "global" as const } } },
      { ...baseSkill, skillId: unscopedSkillId, name: "unscoped" },
    ] : [])].sort((left, right) => left.skillId.localeCompare(right.skillId)),
    ...(includeRestrictedScopes ? {
      inventory: [
        { skillId: systemSkillId, version: "1.0.0", name: "system", description: "fixture skill", scope: { tenantId: workspaceId, audience: { kind: "systems" as const, systemIds: ["system-a"] }, context: { kind: "global" as const } } },
        { skillId: initiativeSkillId, version: "1.0.0", name: "initiative", description: "fixture skill", scope: { tenantId: workspaceId, audience: { kind: "organization" as const }, context: { kind: "initiatives" as const, initiativeIds: ["initiative-a"] } } },
      ],
    } : {}),
  };
  const unsigned = {
    type: "runtime_skill_sync" as const,
    instanceId,
    catalog,
    catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const envelope = RuntimeSkillSyncEnvelopeSchema.parse({
    ...unsigned,
    signature: Buffer.alloc(64).toString("base64url"),
  });
  const prepare = vi.fn(async (): Promise<RuntimeSkillSyncEnvelope> => envelope);
  const read = vi.fn(async () => tree);
  const authorize = vi.fn(async () => undefined);
  return {
    now,
    tree,
    envelope,
    core: {
      prepareRuntimeSkillSync: prepare,
      readRuntimeSkillSync: read,
      authorizeRuntimeSkillSync: authorize,
      shareRuntimeSkillSync: vi.fn(async (): Promise<RuntimeSkillSyncOwnerPublishResponse> => ({ id: skillId, name: "org-personal" })),
      unshareRuntimeSkillSync: vi.fn(async () => ({ unshared: true })),
    },
  };
}

describe("manual runtime Skill synchronization", () => {
  it("reconciles a shared discovery home once while reporting every coding-agent profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-shared-home-sync-"));
    try {
      const home = join(root, "shared");
      await mkdir(home, { recursive: true });
      const f = fixture();
      const primary = { profileId: "codex:primary", agentId: "codex", home };
      const create = (profiles: typeof primary[]) => new ManualRuntimeSkillSync({
        core: f.core, verifyEnvelope: () => true, instanceId, workspaceId, profiles,
        scratchRoot: join(root, "staging"), now: () => f.now,
      });
      await create([primary]).sync();
      f.core.authorizeRuntimeSkillSync.mockClear();
      await create([primary]).sync();
      const checksForOneHome = f.core.authorizeRuntimeSkillSync.mock.calls.length;
      expect(checksForOneHome).toBeGreaterThanOrEqual(3);
      f.core.authorizeRuntimeSkillSync.mockClear();
      const result = await create([primary, { profileId: "opencode:primary", agentId: "opencode", home }]).sync();
      expect(result.profiles).toEqual([
        expect.objectContaining({ agentId: "codex", status: "synchronized", loadedStatus: "unknown" }),
        expect.objectContaining({ agentId: "opencode", status: "synchronized", loadedStatus: "unknown" }),
      ]);
      expect(f.core.authorizeRuntimeSkillSync).toHaveBeenCalledTimes(checksForOneHome);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("automatically publishes, updates and removes owner-private Skills while keeping repeated sync idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-personal-skill-sync-"));
    try {
      const home = join(root, ".codex");
      const skillPath = join(home, "skills", "my-skill");
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, "SKILL.md"), "---\nname: my-skill\ndescription: private\n---\nVersion one.\n");
      const publications = new LocalSkillPublicationStore(join(root, "publications.json"));
      const f = fixture();
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications,
      });

      await expect(sync.syncPersonal()).resolves.toMatchObject({ created: 1, updated: 0, unchanged: 0, deleted: 0, failures: [] });
      const record = (await publications.list())[0]!;
      expect(record.publication).toEqual({ audience: { kind: "personal" }, context: { kind: "global" } });
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledWith(instanceId, expect.objectContaining({
        localId: record.localId,
        publication: { audience: { kind: "personal" }, context: { kind: "global" } },
      }));
      await expect(sync.syncPersonal()).resolves.toMatchObject({ created: 0, unchanged: 1, failures: [] });
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledTimes(1);

      await writeFile(join(skillPath, "SKILL.md"), "---\nname: my-skill\ndescription: private\n---\nVersion two.\n");
      await expect(sync.syncPersonal()).resolves.toMatchObject({ updated: 1, failures: [] });
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledTimes(2);

      await rm(skillPath, { recursive: true, force: true });
      await expect(sync.syncPersonal()).resolves.toMatchObject({ deleted: 1, failures: [] });
      expect(f.core.unshareRuntimeSkillSync).toHaveBeenCalledWith(instanceId, {
        localId: record.localId,
        confirm: true,
        removePersonal: true,
      });
      expect(await publications.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains personal copies when the configured source inventory cannot be read completely", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-personal-skill-incomplete-"));
    try {
      const home = join(root, "blocked-home");
      await writeFile(home, "not a directory");
      const publications = new LocalSkillPublicationStore(join(root, "publications.json"));
      const localId = "c".repeat(64);
      await publications.save({
        binding: { workspaceId, instanceId },
        localId,
        skill: "my-skill",
        identity: "codex:primary:skills/my-skill",
        treeDigest: `sha256:${"d".repeat(64)}`,
        publication: { audience: { kind: "personal" }, context: { kind: "global" } },
      });
      const f = fixture();
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications,
      });
      await expect(sync.syncPersonal()).resolves.toMatchObject({ deleted: 0, failures: [] });
      expect((await publications.list()).map(item => item.localId)).toEqual([localId]);
      expect(f.core.unshareRuntimeSkillSync).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("confirms unsharing, then keeps owner-private sync tracking for the local Skill source", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-unshare-"));
    try {
      const publications = new LocalSkillPublicationStore(join(root, "publications.json"));
      const localId = "a".repeat(64);
      await publications.save({
        binding: { workspaceId, instanceId },
        localId,
        skill: "./my-skill",
        identity: "skill-identity",
        treeDigest: `sha256:${"b".repeat(64)}`,
        publication: {
          audience: { kind: "organization" },
          context: { kind: "global" },
          confirmOngoingPublication: true,
        },
      });
      const f = fixture();
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications,
      });

      f.core.unshareRuntimeSkillSync.mockRejectedValueOnce(new Error("temporarily unavailable"));
      await expect(sync.unshare("./my-skill")).rejects.toThrow("temporarily unavailable");
      expect((await publications.list())[0]?.revoking).toBe(true);
      await expect(sync.syncPublished()).resolves.toMatchObject({ ignored: 1, scanned: 0 });
      expect(f.core.shareRuntimeSkillSync).not.toHaveBeenCalled();

      await expect(sync.unshare("./my-skill")).resolves.toEqual({ skill: "./my-skill", unshared: true });
      expect(f.core.unshareRuntimeSkillSync).toHaveBeenCalledWith(instanceId, { localId, confirm: true });
      expect(await publications.list()).toMatchObject([{
        localId,
        revoking: false,
        publication: { audience: { kind: "personal" }, context: { kind: "global" } },
      }]);
      await expect(sync.unshare("./my-skill")).rejects.toThrow("Personal Skills sync automatically");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs only globally discoverable Skills and reports restricted scopes as isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-sync-"));
    try {
      const home = join(root, ".codex-profile");
      await mkdir(home);
      const f = fixture(Date.now(), true);
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
      });

      const result = await sync.sync();
      expect(result.status).toBe("succeeded");
      expect(result.catalogRevision).toBe(f.envelope.catalog.catalogRevision);
      expect(result.catalogRevision).not.toBe(f.envelope.catalogDigest);
      expect(result.profiles).toMatchObject([
        {
          profileId: "codex:primary",
          agentId: "codex",
          status: "synchronized",
          installedSkills: 2,
        },
      ]);
      expect(f.core.authorizeRuntimeSkillSync).toHaveBeenCalled();
      const link = join(
        home,
        "skills",
        `konteks-${createHash("sha256").update(skillId).digest("hex")}`,
      );
      expect(await readlink(link)).toContain(".konteks-skill-sync/trees");
      for (const restrictedId of [systemSkillId, initiativeSkillId, unscopedSkillId]) {
        const restrictedLink = join(
          home,
          "skills",
          `konteks-${createHash("sha256").update(restrictedId).digest("hex")}`,
        );
        await expect(readlink(restrictedLink)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const listing = await sync.list();
      expect(listing.catalogRevision).toBe(f.envelope.catalog.catalogRevision);
      const listedById = new Map(listing.profiles[0]?.skills.map(skill => [skill.skillId, skill]));
      expect(listedById.get(skillId)).toMatchObject({
        audience: { kind: "organization" },
        initiativeIds: [],
        installedVersion: "1.0.0",
        installedStatus: "current",
        loadedVersion: null,
        loadedStatus: "unknown",
      });
      expect(listedById.get(personalSkillId)).toMatchObject({ installedStatus: "current" });
      expect(listedById.get(systemSkillId)).toMatchObject({ installedVersion: null, installedStatus: "restricted" });
      expect(listedById.get(initiativeSkillId)).toMatchObject({ installedVersion: null, installedStatus: "restricted" });
      expect(listedById.get(unscopedSkillId)).toMatchObject({ installedVersion: null, installedStatus: "unknown" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an unsigned or expired catalog before reading or publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-sync-invalid-"));
    try {
      const home = join(root, ".codex-profile");
      await mkdir(home);
      const f = fixture();
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => false,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
      });
      await expect(sync.sync()).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(f.core.readRuntimeSkillSync).not.toHaveBeenCalled();
      expect(f.core.authorizeRuntimeSkillSync).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists confirmed shares and republishes only changed content from the confirmed source", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-publication-"));
    try {
      const home = join(root, ".codex-profile");
      const source = join(home, "skills", "personal");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: personal\ndescription: Personal skill\n---\nVersion one.\n");
      const f = fixture();
      const store = new LocalSkillPublicationStore(join(root, "state", "runtime-skill-publications.json"));
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications: store,
      });

      const first = await sync.share({ skill: "personal", audience: { level: "organization" } });
      expect(first.id).toBe(skillId);
      expect(await store.list()).toMatchObject([{ skill: "personal", treeDigest: first.treeDigest }]);
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledTimes(1);

      await writeFile(join(source, "SKILL.md"), "---\nname: personal\ndescription: Personal skill\n---\nVersion two.\n");
      f.core.shareRuntimeSkillSync.mockResolvedValueOnce({
        id: skillId,
        name: "org-personal",
        acceptedVersion: "1.0.3",
        replacedConcurrentVersion: "1.0.2",
      });
      await expect(sync.syncPublished()).resolves.toMatchObject({
        scanned: 1,
        updated: 1,
        unchanged: 0,
        failures: [],
        concurrentReplacements: [{
          skill: "org-personal",
          replacedConcurrentVersion: "1.0.2",
          acceptedVersion: "1.0.3",
        }],
      });
      const published = f.core.shareRuntimeSkillSync.mock.calls[1]?.[1];
      expect(published?.tree.treeDigest).not.toBe(first.treeDigest);
      expect((await store.list())[0]?.treeDigest).toBe(published?.tree.treeDigest);

      await expect(sync.syncPublished()).resolves.toMatchObject({ scanned: 1, updated: 0, unchanged: 1, failures: [] });
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an accepted shared publication when its local source disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-publication-missing-"));
    try {
      const home = join(root, ".codex-profile");
      const source = join(home, "skills", "personal");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: personal\ndescription: Personal skill\n---\nVersion one.\n");
      const f = fixture();
      const store = new LocalSkillPublicationStore(join(root, "state", "runtime-skill-publications.json"));
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications: store,
      });
      await sync.share({ skill: "personal", audience: { level: "organization" } });
      await rm(source, { recursive: true, force: true });

      await expect(sync.syncPublished()).resolves.toMatchObject({
        scanned: 1, updated: 0, unchanged: 0, failures: [{ localId: expect.any(String) }],
      });
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledTimes(1);
      expect(await store.list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not carry an automatic publication into another tenant or runtime binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-publication-rebind-"));
    try {
      const home = join(root, ".codex-profile");
      const source = join(home, "skills", "personal");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: personal\ndescription: Personal skill\n---\nVersion one.\n");
      const f = fixture();
      const store = new LocalSkillPublicationStore(join(root, "state", "runtime-skill-publications.json"));
      const profiles = [{ profileId: "codex:primary", agentId: "codex", home }];
      const original = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles,
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications: store,
      });
      await original.share({ skill: "personal", audience: { level: "organization" } });
      const transferred = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId: "instance-b",
        workspaceId: "workspace-b",
        profiles,
        scratchRoot: join(root, "staging"),
        now: () => f.now,
        publications: store,
      });

      await expect(transferred.syncPublished()).resolves.toMatchObject({
        configured: true, scanned: 0, ignored: 1, updated: 0, failures: [],
      });
      expect(f.core.shareRuntimeSkillSync).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unavailable profile as failed with an unknown installation count", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-skill-sync-profile-"));
    try {
      const f = fixture();
      const sync = new ManualRuntimeSkillSync({
        core: f.core,
        verifyEnvelope: () => true,
        instanceId,
        workspaceId,
        profiles: [{ profileId: "codex:primary", agentId: "codex", home: homedir() }],
        scratchRoot: join(root, "staging"),
        now: () => f.now,
      });
      const result = await sync.sync();
      expect(result.status).toBe("failed");
      expect(result.profiles).toMatchObject([{ status: "failed", installedSkills: null }]);
      const listing = await sync.list();
      expect(listing.profiles).toMatchObject([
        {
          profileState: "unavailable",
          reason: "local_io_failure",
          skills: [{ installedStatus: "unknown" }],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the same private Skill identity across runtime homes for the same owner profile", async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), "native-personal-skill-runtime-a-")),
      mkdtemp(join(tmpdir(), "native-personal-skill-runtime-b-")),
    ]);
    try {
      const localIds: string[] = [];
      for (const [index, root] of roots.entries()) {
        const home = join(root, ".codex");
        const skillPath = join(home, "skills", "my-skill");
        await mkdir(skillPath, { recursive: true });
        await writeFile(join(skillPath, "SKILL.md"), "---\nname: my-skill\ndescription: private\n---\nSame owner Skill.\n");
        const publications = new LocalSkillPublicationStore(join(root, "publications.json"));
        const f = fixture();
        const sync = new ManualRuntimeSkillSync({
          core: f.core,
          verifyEnvelope: () => true,
          instanceId: `instance-${index}`,
          workspaceId,
          profiles: [{ profileId: "codex:primary", agentId: "codex", home }],
          scratchRoot: join(root, "staging"),
          now: () => f.now,
          publications,
        });
        await expect(sync.syncPersonal()).resolves.toMatchObject({ created: 1, failures: [] });
        localIds.push((await publications.list())[0]!.localId);
      }
      expect(localIds[0]).toBe(localIds[1]);
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });
});
