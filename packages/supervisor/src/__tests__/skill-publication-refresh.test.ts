import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { refreshSkillPublications } from "../native/skill-publication-refresh.js";
import {
  discoverLocalSkills,
  exportLocalSkill,
  inspectLocalSkillPath,
} from "../skills/local-skills.js";
vi.mock("../skills/local-skills.js", () => ({
  discoverLocalSkills: vi.fn(),
  exportLocalSkill: vi.fn(),
  inspectLocalSkillPath: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
it("publishes other consented Skills after one source fails and reports partial failure", async () => {
  const f = fixture();
  const second = { ...f.record, selection: { ...f.record.selection, localId: "local-b" } };
  f.store.list.mockResolvedValue([f.record, second]);
  vi.mocked(discoverLocalSkills).mockResolvedValue([
    { localId: "local-a", treeDigest: "new" },
    { localId: "local-b", treeDigest: "new" },
  ] as never);
  vi.mocked(exportLocalSkill)
    .mockRejectedValueOnce(new Error("invalid first source"))
    .mockResolvedValueOnce({ treeDigest: "new" } as never);
  await expect(
    refreshSkillPublications(f.options as never, new AbortController().signal),
  ).rejects.toThrow("One or more Skill publications failed");
  expect(f.client.share).toHaveBeenCalledTimes(1);
  expect(f.store.save).toHaveBeenCalledWith(
    expect.objectContaining({
      selection: expect.objectContaining({ localId: "local-b" }),
    }),
  );
});
function fixture() {
  const record = {
    version: 1,
    tenantId: "tenant-a",
    runtimeId: "runtime-a",
    selection: {
      skillId: "11111111-1111-4111-8111-111111111111",
      localId: "local-a",
      treeDigest: "old",
      audience: { kind: "organization" },
      context: { kind: "global" },
      confirmation: { ongoingPublication: true },
    },
    receipt: { revisionId: "accepted-base", treeDigest: "old" },
  };
  const store = { list: vi.fn(async () => [record]), save: vi.fn() };
  const receipt = { revisionId: "new-revision", treeDigest: "new" };
  const client = { share: vi.fn(async () => ({ runtimePublication: receipt })) };
  vi.mocked(discoverLocalSkills).mockResolvedValue([
    { localId: "local-a", treeDigest: "new" },
  ] as never);
  vi.mocked(exportLocalSkill).mockResolvedValue({ treeDigest: "new" } as never);
  const options = {
    store,
    client,
    tenantId: "tenant-a",
    runtimeId: "runtime-a",
    homes: [],
    assertReady: vi.fn(),
  };
  return { record, store, client, receipt, options };
}
it("publishes changed consented content against the accepted base and retains the receipt", async () => {
  const f = fixture();
  await refreshSkillPublications(f.options as never, new AbortController().signal);
  expect(f.store.list).toHaveBeenCalledWith("tenant-a", "runtime-a");
  expect(f.client.share).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: "accepted-base",
      skillId: f.record.selection.skillId,
      audience: f.record.selection.audience,
      treeDigest: "new",
      requestId: expect.any(String),
    }),
    expect.any(AbortSignal),
  );
  expect(f.store.save).toHaveBeenCalledWith(expect.objectContaining({ receipt: f.receipt }));
});
it.each(["unchanged", "missing"])("does not publish or delete a %s source", async (kind) => {
  const f = fixture();
  vi.mocked(discoverLocalSkills).mockResolvedValue(
    (kind === "missing" ? [] : [{ localId: "local-a", treeDigest: "old" }]) as never,
  );
  await refreshSkillPublications(f.options as never, new AbortController().signal);
  expect(f.client.share).not.toHaveBeenCalled();
  expect(f.store.save).not.toHaveBeenCalled();
});
it("does not save an unacknowledged update or retry uncertain transport", async () => {
  const f = fixture();
  f.client.share.mockRejectedValue(new Error("unavailable"));
  await expect(
    refreshSkillPublications(f.options as never, new AbortController().signal),
  ).rejects.toThrow("One or more Skill publications failed");
  expect(f.client.share).toHaveBeenCalledTimes(1);
  expect(f.store.save).not.toHaveBeenCalled();
});

it("does not publish when authority changes while exporting the source", async () => {
  const f = fixture();
  f.store.list.mockResolvedValue([f.record, f.record]);
  vi.mocked(exportLocalSkill).mockImplementation(async () => {
    f.options.assertReady.mockImplementation(() => {
      throw new Error("identity changed");
    });
    return { treeDigest: "new" } as never;
  });
  await expect(
    refreshSkillPublications(f.options as never, new AbortController().signal),
  ).rejects.toThrow("identity changed");
  expect(f.client.share).not.toHaveBeenCalled();
  expect(f.store.save).not.toHaveBeenCalled();
  expect(exportLocalSkill).toHaveBeenCalledTimes(1);
});

it("does not persist acceptance after the sync has been cancelled", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.client.share.mockImplementation(async () => {
    controller.abort();
    return { runtimePublication: f.receipt };
  });
  await expect(refreshSkillPublications(f.options as never, controller.signal)).rejects.toThrow();
  expect(f.store.save).not.toHaveBeenCalled();
});

it("retains shared publication when its explicit source folder has been removed", async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "kr-missing-publication-"));
  try {
    Object.assign(f.record, { sourcePath: join(root, "removed-skill") });
    vi.mocked(inspectLocalSkillPath).mockRejectedValue(
      Object.assign(new Error("source removed"), { code: "ENOENT" }),
    );
    await refreshSkillPublications(f.options as never, new AbortController().signal);
    expect(f.client.share).not.toHaveBeenCalled();
    expect(f.store.save).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an incomplete existing source instead of treating it as removed", async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "kr-incomplete-publication-"));
  try {
    Object.assign(f.record, { sourcePath: root });
    vi.mocked(inspectLocalSkillPath).mockRejectedValue(
      Object.assign(new Error("incomplete Skill tree"), { code: "ENOENT" }),
    );
    await expect(
      refreshSkillPublications(f.options as never, new AbortController().signal),
    ).rejects.toThrow("One or more Skill publications failed");
    expect(f.client.share).not.toHaveBeenCalled();
    expect(f.store.save).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
