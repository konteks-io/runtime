import { beforeEach, expect, it, vi } from "vitest";
import { syncPersonalSkills } from "../native/personal-skill-sync.js";
import {
  discoverLocalSkills,
  exportLocalSkill,
  findLocalSkillPath,
} from "../skills/local-skills.js";

vi.mock("../skills/local-skills.js", () => ({
  discoverLocalSkills: vi.fn(),
  exportLocalSkill: vi.fn(),
  findLocalSkillPath: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

it("automatically creates a private publication for a new local Skill", async () => {
  const f = fixture();
  vi.mocked(discoverLocalSkills).mockResolvedValue([f.local] as never);
  vi.mocked(findLocalSkillPath).mockResolvedValue("/home/alice/.codex/skills/review");
  vi.mocked(exportLocalSkill).mockResolvedValue(f.tree as never);
  f.client.prepare.mockResolvedValue({ catalog: { skills: [] } } as never);
  f.client.share.mockResolvedValue(f.result as never);

  await syncPersonalSkills(f.options as never, new AbortController().signal);

  expect(f.client.share).toHaveBeenCalledWith(
    expect.objectContaining({
      audience: { kind: "personal" },
      context: { kind: "global" },
      localId: f.local.localId,
      treeDigest: f.local.treeDigest,
      tree: f.tree,
    }),
    expect.any(AbortSignal),
  );
  const selection = f.client.share.mock.calls[0][0] as Record<string, unknown>;
  expect(selection).not.toHaveProperty("confirmation");
  expect(f.store.save).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimeId: "runtime-a",
      sourcePath: "/home/alice/.codex/skills/review",
      selection: expect.objectContaining({
        skillId: f.skillId,
        expectedRevision: f.receipt.revisionId,
      }),
      receipt: f.receipt,
    }),
  );
});

it("reuses the owner's personal Skill identity and observed revision on another runtime", async () => {
  const f = fixture();
  const baseRevisionId = "22222222-2222-4222-8222-222222222222";
  vi.mocked(discoverLocalSkills).mockResolvedValue([f.local] as never);
  vi.mocked(findLocalSkillPath).mockResolvedValue("/home/alice/.codex/skills/review");
  vi.mocked(exportLocalSkill).mockResolvedValue(f.tree as never);
  f.client.prepare.mockResolvedValue({
    catalog: {
      skills: [
        {
          skillId: f.skillId,
          revisionId: baseRevisionId,
          version: "1.0.0",
          name: f.local.name,
          description: "private skill",
          treeDigest: "sha256:" + "b".repeat(64),
          sizeBytes: 1,
          fileCount: 1,
          scope: {
            tenantId: "tenant-a",
            audience: { kind: "personal", ownerUserRef: "prn_alice" },
            context: { kind: "global" },
          },
        },
      ],
    },
  } as never);
  f.client.share.mockResolvedValue(f.result as never);

  await syncPersonalSkills(f.options as never, new AbortController().signal);

  expect(f.client.share).toHaveBeenCalledWith(
    expect.objectContaining({
      audience: { kind: "personal" },
      skillId: f.skillId,
      expectedRevision: baseRevisionId,
    }),
    expect.any(AbortSignal),
  );
});

it("does not re-publish a source that already has a personal or shared publication record", async () => {
  const f = fixture();
  f.store.list.mockResolvedValue([{ selection: { localId: f.local.localId } }] as never);
  vi.mocked(discoverLocalSkills).mockResolvedValue([f.local] as never);

  await syncPersonalSkills(f.options as never, new AbortController().signal);

  expect(f.client.prepare).not.toHaveBeenCalled();
  expect(f.client.share).not.toHaveBeenCalled();
});

it("fails closed when the owner catalog contains duplicate personal names", async () => {
  const f = fixture();
  vi.mocked(discoverLocalSkills).mockResolvedValue([f.local] as never);
  const item = {
    skillId: f.skillId,
    revisionId: f.receipt.revisionId,
    name: f.local.name,
    treeDigest: f.receipt.treeDigest,
    scope: {
      tenantId: "tenant-a",
      audience: { kind: "personal", ownerUserRef: "prn_alice" },
      context: { kind: "global" },
    },
  };
  f.client.prepare.mockResolvedValue({
    catalog: { skills: [item, { ...item, skillId: "33333333-3333-4333-8333-333333333333" }] },
  } as never);

  await expect(
    syncPersonalSkills(f.options as never, new AbortController().signal),
  ).rejects.toThrow("One or more personal Skills");
  expect(f.client.share).not.toHaveBeenCalled();
});

function fixture() {
  const digest = "sha256:" + "a".repeat(64);
  const skillId = "11111111-1111-4111-8111-111111111111";
  const local = {
    localId: "a".repeat(64),
    name: "review",
    treeDigest: digest,
    fileCount: 1,
    sizeBytes: 1,
  };
  const tree = { format: "konteks-file-tree-v1", treeDigest: digest, entries: [] };
  const receipt = {
    publicationId: skillId,
    revisionId: "22222222-2222-4222-8222-222222222222",
    acceptedSequence: 1,
    treeDigest: digest,
  };
  const result = {
    id: skillId,
    tenantId: "tenant-a",
    type: "skill",
    metadata: { runtimePromotionKey: `runtime-a:${local.localId}:${digest}` },
    runtimePublication: receipt,
  };
  const store = { list: vi.fn(async () => []), save: vi.fn(async () => undefined) };
  const client = {
    prepare: vi.fn(async () => ({ catalog: { skills: [] } })),
    share: vi.fn(async () => result),
  };
  const options = {
    store,
    client,
    homes: ["/home/alice/.codex"],
    tenantId: "tenant-a",
    runtimeId: "runtime-a",
    assertReady: vi.fn(),
  };
  return { local, tree, receipt, result, skillId, store, client, options };
}
