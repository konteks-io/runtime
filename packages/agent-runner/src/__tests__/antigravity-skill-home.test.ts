import { expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityRuntimePaths, prepareAntigravityHome } from "../host/antigravity.js";

it("retains connector Skills through preparation while removing hooks and trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-skill-home-"));
  try {
    const paths = antigravityRuntimePaths(root);
    const skillHome = join(paths.geminiHome, "konteks-skills");
    await mkdir(join(skillHome, "skills", "example"), { recursive: true, mode: 0o700 });
    await writeFile(join(skillHome, "skills", "example", "SKILL.md"), "# Approved organization Skill", { mode: 0o600 });
    await mkdir(join(paths.geminiHome, "config"), { recursive: true });
    await writeFile(join(paths.geminiHome, "config", "hooks.json"), "untrusted hook");
    await mkdir(join(paths.geminiHome, "antigravity-acp"), { recursive: true });
    await writeFile(paths.trustFile, "untrusted workspace");
    for (let attempt = 0; attempt < 2; attempt++) {
      await prepareAntigravityHome(root);
      for (const location of [join(paths.geminiHome, "config", "skills"), join(paths.geminiHome, "antigravity-cli", "skills")]) {
        expect(await readFile(join(location, "example", "SKILL.md"), "utf8")).toBe("# Approved organization Skill");
      }
      await expect(readFile(paths.trustFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(paths.geminiHome, "config", "hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses a substituted managed Skill home without modifying its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-skill-home-"));
  try {
    const paths = antigravityRuntimePaths(root), outside = join(root, "outside");
    await mkdir(paths.geminiHome, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "sentinel"), "keep");
    await symlink(outside, join(paths.geminiHome, "konteks-skills"));
    await expect(prepareAntigravityHome(root)).rejects.toThrow();
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});
