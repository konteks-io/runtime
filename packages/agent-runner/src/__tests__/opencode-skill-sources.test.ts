import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeSkillSources } from "../host/opencode-skill-sources.js";
it("exposes only closed selected Skill snapshots and rejects unexpected sibling Skills", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-skill-source-")));
  try {
    const skill = join(root, "review");
    await mkdir(skill, { mode: 0o700 });
    await writeFile(join(skill, "SKILL.md"), "# Review", { mode: 0o600 });
    await writeFile(join(root, ".catalog.json"), "{}", { mode: 0o600 });
    expect(await openCodeSkillSources([skill])).toEqual([root]);
    await mkdir(join(root, "unauthorized"), { mode: 0o700 });
    await expect(openCodeSkillSources([skill])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects linked roots and does not invent a source for an empty selection", async () => {
  expect(await openCodeSkillSources([])).toEqual([]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-skill-links-")));
  try {
    await mkdir(join(root, "target"), { mode: 0o700 });
    await symlink(join(root, "target"), join(root, "alias"));
    await expect(openCodeSkillSources([join(root, "alias")])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects ambiguous folder-derived Skill IDs across snapshots", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-skill-collision-")));
  try {
    const selected: string[] = [];
    for (const name of ["first", "second"]) {
      const parent = join(root, name);
      await mkdir(parent, { mode: 0o700 });
      const skill = join(parent, "review");
      await mkdir(skill, { mode: 0o700 });
      await writeFile(join(skill, "SKILL.md"), "# Review", { mode: 0o600 });
      await writeFile(join(parent, ".catalog.json"), "{}", { mode: 0o600 });
      selected.push(skill);
    }
    await expect(openCodeSkillSources(selected)).rejects.toThrow();
    expect(await openCodeSkillSources([selected[0]!, selected[0]!])).toEqual([join(root, "first")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects supporting folders that OpenCode would discover as additional Skills", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-nested-skill-")));
  try {
    const skill = join(root, "review");
    await mkdir(skill, { mode: 0o700 });
    await writeFile(join(root, ".catalog.json"), "{}", { mode: 0o600 });
    await writeFile(join(skill, "SKILL.md"), "# Review", { mode: 0o600 });
    await mkdir(join(skill, "references"), { mode: 0o700 });
    await writeFile(join(skill, "references", "guide.md"), "Support", { mode: 0o600 });
    expect(await openCodeSkillSources([skill])).toEqual([root]);
    await writeFile(join(skill, "references", "SKILL.md"), "# Unexpected Skill", { mode: 0o600 });
    await expect(openCodeSkillSources([skill])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
