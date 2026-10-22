import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  });

  it("moves a session to the worktree its newest bootstrap prepared, and keeps it across a restart (D96)", async () => {
    const data = await mkdtemp(join(tmpdir(), "permits-")); dirs.push(data);
    const first = join(data, "worktree-cycle-1"); await mkdir(first);
    const second = join(data, "worktree-cycle-2"); await mkdir(second);
    const file = join(data, "preview-worktrees.json");
    const permits = new PreviewWorktreePermits(file);
    permits.set("qa-session", first);
    permits.set("qa-session", second);
    permits.set("generator-session", first);

    const afterRestart = new PreviewWorktreePermits(file);
    expect(afterRestart.get("qa-session")).toBe(second);
    expect(afterRestart.get("generator-session")).toBe(first);
  });

  it("retains managed repository policy after restart and clears it on a new ordinary bootstrap", async () => {
    const data = await mkdtemp(join(tmpdir(), "permits-")); dirs.push(data);
    const cwd = join(data, "qa"); await mkdir(cwd);
    const file = join(data, "permits.json");
    new PreviewWorktreePermits(file).set("qa", cwd, true);
    const restored = new PreviewWorktreePermits(file);
    expect(restored.get("qa")).toBe(cwd);
    expect(restored.managedRepository("qa")).toBe(true);
    restored.set("qa", cwd);
    expect(new PreviewWorktreePermits(file).managedRepository("qa")).toBeUndefined();
  });

  it("reads legacy entries without promoting them to managed repository authority", async () => {
    const data = await mkdtemp(join(tmpdir(), "permits-")); dirs.push(data);
    const cwd = join(data, "ordinary"); await mkdir(cwd);
    const file = join(data, "permits.json");
    await writeFile(file, JSON.stringify({ legacy: cwd, invalid: { cwd, managedRepository: "true" } }));
    const permits = new PreviewWorktreePermits(file);
    expect(permits.get("legacy")).toBe(cwd);
    expect(permits.managedRepository("legacy")).toBeUndefined();
    expect(permits.get("invalid")).toBeUndefined();
  });

  it("starts empty when nothing was kept", async () => {
    const data = await mkdtemp(join(tmpdir(), "permits-")); dirs.push(data);
    expect(new PreviewWorktreePermits(join(data, "none.json")).get("x")).toBeUndefined();
  });
});
