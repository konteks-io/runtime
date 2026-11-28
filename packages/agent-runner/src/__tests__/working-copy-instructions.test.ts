import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { instructionsInside } from "../host/working-copy-instructions.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workingCopy(): Promise<{ root: string; copy: string }> {
  const root = await mkdtemp(join(tmpdir(), "konteks-working-copy-"));
  roots.push(root);
  const copy = join(root, "repo");
  await mkdir(copy, { recursive: true });
  return { root, copy };
}

describe("host agents take AGENTS.md only from the working copy", () => {
  it("returns the working copy's own regular AGENTS.md and nothing when it is absent", async () => {
    const { copy } = await workingCopy();
    expect(await instructionsInside(copy)).toBeNull();
    await writeFile(join(copy, "AGENTS.md"), "# project rules\n");
    expect(await instructionsInside(copy)).toBe(await realpath(join(copy, "AGENTS.md")));
  });

  it("never hands over an AGENTS.md whose real path leaves the working copy", async () => {
    const { root, copy } = await workingCopy();
    await writeFile(join(root, "operator-private.md"), "# the operator's own rules\n");
    await symlink(join(root, "operator-private.md"), join(copy, "AGENTS.md"));
    expect(await instructionsInside(copy)).toBeNull();
  });

  it("accepts a link that stays inside the working copy and refuses the copy root itself", async () => {
    const { copy } = await workingCopy();
    await mkdir(join(copy, "docs"));
    await writeFile(join(copy, "docs", "rules.md"), "# rules\n");
    await symlink(join(copy, "docs", "rules.md"), join(copy, "AGENTS.md"));
    expect(await instructionsInside(copy)).toBe(await realpath(join(copy, "docs", "rules.md")));
    await rm(join(copy, "AGENTS.md"));
    await symlink(copy, join(copy, "AGENTS.md"));
    expect(await instructionsInside(copy)).toBeNull();
  });
});
