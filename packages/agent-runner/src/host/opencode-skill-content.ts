import matter from "gray-matter";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

function refuseExecutableFrontmatter(): never { throw new Error("Executable Skill frontmatter is unsupported"); }

/** Mirrors the pinned OpenCode Skill.prepare output for the authorized local snapshot. */
export async function openCodeSkillContent(roots: readonly string[]): Promise<string[]> {
  return Promise.all(roots.map(async directory => {
    const parsed = matter(await readFile(join(directory, "SKILL.md"), "utf8"), { engines: { javascript: refuseExecutableFrontmatter, js: refuseExecutableFrontmatter } });
    const name: unknown = parsed.data.name ?? basename(directory);
    if (typeof name !== "string") throw new Error("Unsupported OpenCode Skill name");
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && entry.name !== "SKILL.md")
      .map(entry => join(entry.parentPath, entry.name)).sort().slice(0, 10);
    return [
      `<skill_content name="${name}">`, `# Skill: ${name}`, "", parsed.content.trim(), "",
      `Base directory for this skill: ${directory}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.", "", "<skill_files>",
      ...files.map(file => `<file>${file}</file>`), "</skill_files>", "</skill_content>",
    ].join("\n");
  }));
}
