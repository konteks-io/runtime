import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewWorktreePermits } from "../preview/worktree-permits.js";

describe("the worktrees a viewer may preview (09-30)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it("keeps a delivered session's worktree across a restart, and drops one that is gone", async () => {
    const data = await mkdtemp(join(tmpdir(), "permits-")); dirs.push(data);
    const kept = join(data, "worktree-a"); await mkdir(kept);
    const gone = join(data, "worktree-b"); await mkdir(gone);
    const file = join(data, "preview-worktrees.json");
    const first = new PreviewWorktreePermits(file);
    first.set("delivery-1", kept);
    first.set("delivery-2", gone);
    await rm(gone, { recursive: true });

    const afterRestart = new PreviewWorktreePermits(file);
    expect(afterRestart.get("delivery-1")).toBe(kept);
    expect(afterRestart.get("delivery-2")).toBeUndefined();

    afterRestart.delete("delivery-1");
    expect(new PreviewWorktreePermits(file).get("delivery-1")).toBeUndefined();
  });

  it("starts empty when nothing was kept", async () => {
    const data = await mkdtemp(join(tmpdir(), "permits-")); dirs.push(data);
    expect(new PreviewWorktreePermits(join(data, "none.json")).get("x")).toBeUndefined();
  });
});
