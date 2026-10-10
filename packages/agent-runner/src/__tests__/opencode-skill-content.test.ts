import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeSkillContent } from "../host/opencode-skill-content.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(content: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-content-"))); roots.push(root);
  await writeFile(join(root, "SKILL.md"), content, { mode: 0o600 });
  return root;
}

it("renders the pinned native attachment format with parsed YAML and sorted supporting files", async () => {
  const root = await fixture('---\nname: "Review: code"\n---\n\nRead carefully.\n');
  await writeFile(join(root, "z.txt"), "z");
  await writeFile(join(root, "a.txt"), "a");
  expect(await openCodeSkillContent([root])).toEqual([
    `<skill_content name="Review: code">\n# Skill: Review: code\n\nRead carefully.\n\nBase directory for this skill: ${root}\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file>${join(root, "a.txt")}</file>\n<file>${join(root, "z.txt")}</file>\n</skill_files>\n</skill_content>`,
  ]);
});

it("refuses executable JavaScript frontmatter instead of evaluating it", async () => {
  const root = await fixture('---javascript\n({ name: "Executable" })\n---\nBody');
  await expect(openCodeSkillContent([root])).rejects.toThrow(/Executable Skill frontmatter/);
});
