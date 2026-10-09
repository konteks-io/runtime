import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLocalSkills, exportLocalSkill } from "../skills/local-skills.js";
describe("personal Skill discovery and explicit export", () => {
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
