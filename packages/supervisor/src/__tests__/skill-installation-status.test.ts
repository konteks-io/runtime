import { expect, it, vi } from "vitest";
vi.mock("../skills/home-sync.js", () => ({ verifyAgentHomeSkillInstallation: vi.fn() }));
import { verifyAgentHomeSkillInstallation } from "../skills/home-sync.js";
import { inspectSkillInstallation } from "../native/skill-installation-status.js";
const owner = { workspaceId: "tenant-a", instanceId: "runtime-a" };
const skill = {
  skillId: "one",
  version: "1",
  name: "one",
  description: "",
  directory: "/cache",
  skillFile: "/cache/SKILL.md",
  treeDigest: "digest",
  fileModes: {},
};
const snapshot = { owner, staged: { root: "/cache", catalogDigest: "catalog-a", skills: [skill] } };
it("requires current ownership and catalog before checking local installation", async () => {
  vi.mocked(verifyAgentHomeSkillInstallation).mockClear();
  const input = { owner, catalogDigest: "catalog-a", home: "/profile" };
  expect(await inspectSkillInstallation(input)).toBe("unknown");
  expect(
    await inspectSkillInstallation({
      ...input,
      snapshot,
      owner: { ...owner, workspaceId: "other" },
    }),
  ).toBe("unknown");
  expect(await inspectSkillInstallation({ ...input, snapshot, catalogDigest: "catalog-b" })).toBe(
    "stale",
  );
  expect(verifyAgentHomeSkillInstallation).not.toHaveBeenCalled();
});
it("rechecks complete tree integrity on every observation without asserting agent load", async () => {
  vi.mocked(verifyAgentHomeSkillInstallation)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const input = { owner, snapshot, catalogDigest: "catalog-a", home: "/profile" };
  expect(await inspectSkillInstallation(input)).toBe("verified");
  expect(await inspectSkillInstallation(input)).toBe("stale");
  expect(verifyAgentHomeSkillInstallation).toHaveBeenLastCalledWith({
    owner,
    home: "/profile",
    skill,
  });
});
