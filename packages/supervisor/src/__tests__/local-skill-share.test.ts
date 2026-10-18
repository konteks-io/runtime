import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSkillPublicationSchema } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { makeLocalSkillShare, snapshotLocalSkill } from "../skills/local-share.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "konteks-local-skill-share-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("local Skill share snapshot", () => {
  it("captures a validated folder and binds the selected audience", async () => {
    const root = await temporaryRoot();
    const skill = join(root, "codex", "skills", "release-notes");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: release-notes\ndescription: Release notes\n---\nWrite notes.\n");
    await writeFile(join(skill, "references", "format.md"), "Keep it concise.\n");

    const snapshot = await snapshotLocalSkill("release-notes", [
      { profileId: "codex-default", home: join(root, "codex") },
    ]);
    const publication = LocalSkillPublicationSchema.parse({
      audience: { kind: "systems", systemIds: ["system-a", "system-b"] },
      context: { kind: "global" },
      confirmOngoingPublication: true,
    });
    const shared = makeLocalSkillShare(snapshot, "runtime-a", publication);

    expect(snapshot.name).toBe("release-notes");
    expect(shared.localId).toMatch(/^[a-f0-9]{64}$/);
    expect(shared.tree.entries.map(entry => entry.path)).toEqual(["references/format.md", "SKILL.md"]);
    expect(shared.tree.treeDigest).toBe(snapshot.tree.treeDigest);
    expect(shared.publication.audience).toEqual({ kind: "systems", systemIds: ["system-a", "system-b"] });
  });

  it("refuses symlinks inside the selected folder", async () => {
    const root = await temporaryRoot();
    const skill = join(root, "home", "skills", "unsafe");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: unsafe\ndescription: Unsafe\n---\n");
    const outside = join(root, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, join(skill, "linked.md"));

    await expect(snapshotLocalSkill("unsafe", [
      { profileId: "codex-default", home: join(root, "home") },
    ])).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("refuses a name that resolves to different content in configured profiles", async () => {
    const root = await temporaryRoot();
    const homes = [join(root, "one"), join(root, "two")];
    for (const [index, home] of homes.entries()) {
      const skill = join(home, "skills", "same-name");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), `---\nname: same-name\ndescription: Test\n---\nversion ${index}\n`);
    }

    await expect(snapshotLocalSkill("same-name", homes.map((home, index) => ({
      profileId: `agent-${index}`,
      home,
    })))).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});
