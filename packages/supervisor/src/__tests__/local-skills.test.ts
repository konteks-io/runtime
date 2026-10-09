import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverLocalSkills,
  exportLocalSkill,
  inspectLocalSkill,
  inspectLocalSkillPath,
} from "../skills/local-skills.js";
describe("personal Skill discovery and explicit export", () => {
  it("exports an explicitly selected folder and refuses substitutions, edits and linked sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-path-"));
    const source = join(root, "example"),
      other = join(root, "other");
    try {
      for (const folder of [source, other]) {
        await mkdir(folder);
        await writeFile(join(folder, "SKILL.md"), "Example");
      }
      const selection = await inspectLocalSkillPath(source);
      expect(JSON.stringify(selection)).not.toContain(root);
      expect((await exportLocalSkill([], selection, source)).entries).toHaveLength(1);
      await expect(exportLocalSkill([], selection, other)).rejects.toThrow();
      await expect(inspectLocalSkillPath("./example")).rejects.toThrow();
      await symlink(source, join(root, "linked"), "junction");
      await expect(inspectLocalSkillPath(join(root, "linked"))).rejects.toThrow();
      await writeFile(join(source, "SKILL.md"), "Changed");
      await expect(exportLocalSkill([], selection, source)).rejects.toThrow();
      await symlink(join(other, "SKILL.md"), join(source, "secret"));
      await expect(inspectLocalSkillPath(source)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses ambiguous names across agent profiles and deduplicates the same source", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-selection-"));
    const homes = [join(root, "agent-a"), join(root, "agent-b")];
    try {
      for (const home of homes) {
        await mkdir(join(home, "skills", "example"), { recursive: true });
        await writeFile(join(home, "skills", "example", "SKILL.md"), "Example");
      }
      await expect(inspectLocalSkill(homes, "example")).rejects.toThrow("ambiguous");
      await expect(inspectLocalSkill(homes, "missing")).rejects.toThrow("unavailable");
      const selected = await inspectLocalSkill([homes[0]!, homes[0]!], "example");
      expect(selected.name).toBe("example");
      expect(JSON.stringify(selected)).not.toContain(root);
      expect((await exportLocalSkill(homes, selected)).treeDigest).toBe(selected.treeDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exports the selected immutable complete tree without managed links or machine paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "local-skills-"));
    try {
      await mkdir(join(home, "skills", "personal", "assets"), { recursive: true });
      await writeFile(
        join(home, "skills", "personal", "SKILL.md"),
        "---\nname: personal\ndescription: Personal skill\n---\nUse this skill.",
      );
      await writeFile(
        join(home, "skills", "personal", "assets", "image.bin"),
        Buffer.from([0, 255]),
      );
      await symlink(join(home, "skills", "personal"), join(home, "skills", "managed"));
      const skills = await discoverLocalSkills([home]);
      expect(skills).toHaveLength(1);
      expect(JSON.stringify(skills)).not.toContain(home);
      const tree = await exportLocalSkill([home], skills[0]!);
      expect(tree.entries.find((entry) => entry.path === "assets/image.bin")?.contentBase64).toBe(
        "AP8=",
      );
      await writeFile(join(home, "skills", "personal", "SKILL.md"), "changed");
      await expect(exportLocalSkill([home], skills[0]!)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("refuses a Skill containing a link to an unrelated file", async () => {
    const home = await mkdtemp(join(tmpdir(), "local-skills-"));
    try {
      await mkdir(join(home, "skills", "personal"), { recursive: true });
      await writeFile(join(home, "skills", "personal", "SKILL.md"), "local");
      await symlink("/etc/passwd", join(home, "skills", "personal", "secret"));
      expect(await discoverLocalSkills([home])).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
