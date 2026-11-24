import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLocalSkills, exportLocalSkill } from "../skills/local-skills.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "konteks-skill-"));
  temporary.push(home);
  const directory = join(home, "skills", "sample");
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: sample\ndescription: local test\n---\n");
  const asset = join(directory, "assets", "binary");
  await writeFile(asset, Buffer.from([0, 255, 129]));
  await chmod(asset, 0o700);
  return { home, directory, asset };
}

describe("local Skill export", () => {
  it("lists metadata only, exports the bounded tree, and refuses a stale selection", async () => {
    const { home, asset } = await fixture();
    const [selection] = await discoverLocalSkills([home, home]);
    expect(selection).toEqual({
      localId: expect.stringMatching(/^[a-f0-9]{64}$/),
      name: "sample",
      treeDigest: expect.stringMatching(/^sha256:/),
      fileCount: 2,
      sizeBytes: expect.any(Number),
    });
    const tree = await exportLocalSkill([home], selection!);
    expect(tree.treeDigest).toBe(selection!.treeDigest);
    expect(tree.entries).toContainEqual(expect.objectContaining({
      path: "assets/binary",
      contentBase64: "AP+B",
      ...(process.platform === "win32" ? {} : { mode: 0o700 }),
    }));
    await writeFile(asset, Buffer.from([1, 255, 129]));
    await expect(exportLocalSkill([home], selection!)).rejects.toThrow("unavailable or has changed");
  });

  it.skipIf(process.platform === "win32")("rejects discovered symlinks and hard-linked files", async () => {
    const { home, directory, asset } = await fixture();
    await symlink(directory, join(home, "skills", "managed"));
    expect((await discoverLocalSkills([home])).map(skill => skill.name)).toEqual(["sample"]);
    await link(asset, join(home, "outside-link"));
    await expect(discoverLocalSkills([home])).resolves.toEqual([]);
  });
});
