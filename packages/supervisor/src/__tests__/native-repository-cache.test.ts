import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { canonicalize, sha256Hex } from "@konteks/remote-common";
import { NativeRepositoryCache } from "../native/repository-cache.js";
import { testGitCommand, testGitTool } from "./native-git-fixture.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "konteks-repository-cache-"));
  roots.push(root);
  const tool = await testGitTool();
  const origin = join(root, "origin.git"),
    seed = join(root, "seed");
  await mkdir(seed, { mode: 0o700 });
  await testGitCommand(tool, seed, ["init", "--initial-branch=main"]);
  await writeFile(join(seed, "app.txt"), "one\n");
  await testGitCommand(tool, seed, ["add", "app.txt"]);
  await testGitCommand(tool, seed, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "-m",
    "one",
  ]);
  const first = (await testGitCommand(tool, seed, ["rev-parse", "HEAD"])).trim();
  await promisify(execFile)(tool.executable, ["clone", "--bare", seed, origin], {
    env: {
      PATH: dirname(tool.executable),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  const cacheRoot = join(root, "repositories"),
    claudeRoot = join(root, "agents", "claude"),
    codexRoot = join(root, "agents", "codex");
  for (const path of [cacheRoot, claudeRoot, codexRoot])
    await mkdir(path, { recursive: true, mode: 0o700 });
  let fetches = 0;
  const cache = new NativeRepositoryCache({
    root: cacheRoot,
    tool,
    fetchRevision: async ({ gitDir, revision }) => {
      fetches += 1;
      await promisify(execFile)(
        tool.executable,
        [
          "--git-dir",
          gitDir,
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          origin,
          `+${revision}:refs/konteks/fetched/${revision}`,
        ],
        {
          env: {
            PATH: dirname(tool.executable),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
    },
  });
  return {
    root,
    tool,
    origin,
    seed,
    first,
    cacheRoot,
    claudeRoot,
    codexRoot,
    cache,
    fetches: () => fetches,
  };
}


async function legacyWorkspace() {
    const f = await fixture();
    const repositoryId = "repository:online-store";
    // Populate a real canonical source store, then construct the deployed linked layout.
    await f.cache.prepare({ repositoryId, revision: f.first, agentWorkspaceRoot: f.codexRoot, worktreeId: "bootstrap" });
    const agentRoot = await realpath(f.claudeRoot);
    const repositoryDigest = `sha256:${sha256Hex(canonicalize({ repositoryId }))}`;
    const worktreeDigest = sha256Hex(canonicalize({ repositoryDigest, worktreeId: "old-layout" }));
    const receiptDigest = sha256Hex(canonicalize({ worktreeDigest, agentRoot }));
    const shared = join(await realpath(f.cacheRoot), `${repositoryDigest.slice(7)}.git`);
    const cwd = join(agentRoot, `worktree-${worktreeDigest}`);
    await testGitCommand(f.tool, f.seed, ["--git-dir", shared, "worktree", "add", "--detach", cwd, f.first]);
    await chmod(cwd, 0o700);
    const receiptPath = join(f.cacheRoot, `.worktree-${receiptDigest}.konteks-worktree.json`);
    await writeFile(receiptPath, JSON.stringify({
      format: "konteks-native-worktree-v1", repositoryDigest, baselineCommit: f.first,
      worktreePathDigest: `sha256:${sha256Hex(canonicalize({ path: cwd }))}`,
      commonDirectoryDigest: `sha256:${sha256Hex(canonicalize({ path: shared }))}`,
    }), { mode: 0o600 });
    await testGitCommand(f.tool, cwd, ["checkout", "-b", "retained-session-branch"]);
    await writeFile(join(cwd, "committed.txt"), "unpublished commit\n");
    await testGitCommand(f.tool, cwd, ["add", "committed.txt"]);
    await testGitCommand(f.tool, cwd, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "local work"]);
    await testGitCommand(f.tool, cwd, ["rm", "app.txt"]);
    await writeFile(join(cwd, "correction.txt"), "staged\n");
    await testGitCommand(f.tool, cwd, ["add", "correction.txt"]);
    await writeFile(join(cwd, "correction.txt"), "unstaged\n");
    await writeFile(join(cwd, "untracked.txt"), "keep\n");
    return { f, repositoryId, cwd, shared, receiptPath,
      target: join(await realpath(f.cacheRoot), `.workspace-${receiptDigest}.git`),
      request: { repositoryId, revision: f.first, agentWorkspaceRoot: f.claudeRoot, worktreeId: "old-layout" } };
}

describe("native shared repository cache", () => {
  it("preserves staged, unstaged, untracked and deleted work after reopening the cache", async () => {
    const f = await fixture();
    const input = { repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.codexRoot, worktreeId: "engineering-restart" };
    const work = await f.cache.prepare(input);
    await writeFile(join(work.cwd, "correction.txt"), "staged correction\n");
    await testGitCommand(f.tool, work.cwd, ["add", "correction.txt"]);
    await writeFile(join(work.cwd, "correction.txt"), "unstaged follow-up\n");
    await testGitCommand(f.tool, work.cwd, ["rm", "app.txt"]);
    await writeFile(join(work.cwd, "notes.txt"), "untracked notes\n");
    const before = await testGitCommand(f.tool, work.cwd, ["status", "--porcelain"]);
    expect(before).toContain("AM correction.txt");
    expect(before).toContain("D  app.txt");
    expect(before).toContain("?? notes.txt");
    const staged = await testGitCommand(f.tool, work.cwd, ["diff", "--cached", "--binary"]);
    const unstaged = await testGitCommand(f.tool, work.cwd, ["diff", "--binary"]);
    const reopened = new NativeRepositoryCache({ root: f.cacheRoot, tool: f.tool,
      fetchRevision: async () => { throw new Error("cached revision must not be fetched again"); } });
    const qa = await reopened.prepare({ ...input, worktreeId: "qa-restart", mode: "reset_to_revision" });
    expect((await testGitCommand(f.tool, qa.cwd, ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(qa.cwd, "app.txt"), "utf8")).toBe("one\n");
    const resumed = await reopened.prepare(input);
    expect(resumed.cwd).toBe(work.cwd);
    expect(await testGitCommand(f.tool, resumed.cwd, ["status", "--porcelain"])).toBe(before);
    expect(await testGitCommand(f.tool, resumed.cwd, ["diff", "--cached", "--binary"])).toBe(staged);
    expect(await testGitCommand(f.tool, resumed.cwd, ["diff", "--binary"])).toBe(unstaged);
    expect(await readFile(join(resumed.cwd, "notes.txt"), "utf8")).toBe("untracked notes\n");
    await resumed.verify();
  });

  it("isolates QA hook installation from the shared cache and a dirty engineering session", async () => {
    const f = await fixture();
    const input = { repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.codexRoot, worktreeId: "engineering" };
    const engineering = await f.cache.prepare(input);
    await writeFile(join(engineering.cwd, "app.txt"), "unpublished correction\n");
    await writeFile(join(engineering.cwd, "new.txt"), "untracked work\n");
    const qa = await f.cache.prepare({ ...input, worktreeId: "qa", mode: "reset_to_revision" });
    const engineeringCommon = (await testGitCommand(f.tool, engineering.cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const qaCommon = (await testGitCommand(f.tool, qa.cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    // This is the exact Git mutation issued by Husky's prepare lifecycle.
    await testGitCommand(f.tool, qa.cwd, ["config", "core.hooksPath", ".husky/_"]);
    await engineering.verify();
    const resumed = await f.cache.prepare(input);
    expect(resumed.cwd).toBe(engineering.cwd);
    expect(await readFile(join(resumed.cwd, "app.txt"), "utf8")).toBe("unpublished correction\n");
    expect(await readFile(join(resumed.cwd, "new.txt"), "utf8")).toBe("untracked work\n");
    expect(qaCommon).not.toBe(engineeringCommon);
    await expect(readFile(join(engineeringCommon, "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
    const next = await f.cache.prepare({ ...input, worktreeId: "new-engineering" });
    await next.verify();
    expect(await readFile(join(next.cwd, "app.txt"), "utf8")).toBe("one\n");
    expect(f.fetches()).toBe(1);
    await expect(qa.verify()).rejects.toMatchObject({ code: "capability_unavailable", diagnostic: "workspace_policy_invalid" });
  });

  it("isolates mutable branch refs and refuses another session's Git pointer", async () => {
    const f = await fixture();
    const request = { repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.codexRoot };
    const first = await f.cache.prepare({ ...request, worktreeId: "session-a" });
    const second = await f.cache.prepare({ ...request, worktreeId: "session-b" });
    await testGitCommand(f.tool, first.cwd, ["branch", "only-session-a"]);
    expect((await testGitCommand(f.tool, first.cwd, ["branch", "--list", "only-session-a"])).trim()).toBe("only-session-a");
    expect((await testGitCommand(f.tool, second.cwd, ["branch", "--list", "only-session-a"])).trim()).toBe("");
    const pointer = await readFile(join(first.cwd, ".git"), "utf8");
    await writeFile(join(first.cwd, ".git"), await readFile(join(second.cwd, ".git")));
    await expect(first.verify()).rejects.toMatchObject({ code: "capability_unavailable" });
    await writeFile(join(first.cwd, ".git"), pointer);
    await first.verify();
    await second.verify();
  });

  it("fetches a canonical repository once and gives different agents isolated worktrees", async () => {
    const f = await fixture();
    const claude = await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.claudeRoot,
      worktreeId: "delivery-one",
    });
    const codex = await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.codexRoot,
      worktreeId: "review-one",
    });

    expect(f.fetches()).toBe(1);
    expect(claude.cwd).not.toBe(codex.cwd);
    expect(await readFile(join(claude.cwd, "app.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(codex.cwd, "app.txt"), "utf8")).toBe("one\n");
    expect(await readdir(claude.cwd)).not.toContain(".konteks-worktree.json");
    expect((await testGitCommand(f.tool, claude.cwd, ["status", "--porcelain"])).trim()).toBe("");
    const receipts = (await readdir(f.cacheRoot)).filter(name => name.startsWith(".worktree-") && name.endsWith(".konteks-worktree.json"));
    expect(receipts).toHaveLength(2);
    expect((await readdir(f.cacheRoot)).filter((name) => !name.startsWith("."))).toHaveLength(1);
    expect(await testGitCommand(f.tool, claude.cwd, ["rev-parse", "--git-common-dir"])).toContain(
      f.cacheRoot,
    );
    await claude.verify();
    await codex.verify();
  });

  it("performs one serialized incremental fetch for a new revision", async () => {
    const f = await fixture();
    await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.claudeRoot,
      worktreeId: "first",
    });
    await writeFile(join(f.seed, "app.txt"), "two\n");
    await testGitCommand(f.tool, f.seed, ["add", "app.txt"]);
    await testGitCommand(f.tool, f.seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@invalid",
      "commit",
      "-m",
      "two",
    ]);
    const second = (await testGitCommand(f.tool, f.seed, ["rev-parse", "HEAD"])).trim();
    await testGitCommand(f.tool, f.seed, ["push", f.origin, `HEAD:refs/heads/main`]);

    const [a, b] = await Promise.all([
      f.cache.prepare({
        repositoryId: "repository:online-store",
        revision: second,
        agentWorkspaceRoot: f.claudeRoot,
        worktreeId: "second-a",
      }),
      f.cache.prepare({
        repositoryId: "repository:online-store",
        revision: second,
        agentWorkspaceRoot: f.codexRoot,
        worktreeId: "second-b",
      }),
    ]);
    expect(f.fetches()).toBe(2);
    expect(await readFile(join(a.cwd, "app.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(b.cwd, "app.txt"), "utf8")).toBe("two\n");
  });

  it("resumes a completed worktree without fetching or discarding local work", async () => {
    const f = await fixture();
    const first = await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.claudeRoot,
      worktreeId: "delivery",
    });
    await writeFile(join(first.cwd, "local.txt"), "unfinished\n");
    const resumed = await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.claudeRoot,
      worktreeId: "delivery",
    });
    expect(resumed.cwd).toBe(first.cwd);
    expect(f.fetches()).toBe(1);
    expect(await readFile(join(resumed.cwd, "local.txt"), "utf8")).toBe("unfinished\n");
    await resumed.verify();
  });

  it("preserves generator branches and refreshes only QA worktrees to the signed head", async () => {
    const f = await fixture();
    const generator = await f.cache.prepare({ repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.claudeRoot, worktreeId: "generator-session", mode: "preserve" });
    const qa = await f.cache.prepare({ repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.codexRoot, worktreeId: "qa-session", mode: "reset_to_revision" });
    await writeFile(join(generator.cwd, "generator-only.txt"), "keep\n");
    await writeFile(join(qa.cwd, "stale.txt"), "discard\n");
    await writeFile(join(f.seed, "app.txt"), "two\n");
    await testGitCommand(f.tool, f.seed, ["add", "app.txt"]);
    await testGitCommand(f.tool, f.seed, ["-c", "user.name=Test", "-c", "user.email=test@invalid",
      "commit", "-m", "two"]);
    const second = (await testGitCommand(f.tool, f.seed, ["rev-parse", "HEAD"])).trim();
    await testGitCommand(f.tool, f.seed, ["push", f.origin, "HEAD:refs/heads/main"]);

    await expect(f.cache.prepare({ repositoryId: "repository:online-store", revision: second,
      agentWorkspaceRoot: f.claudeRoot, worktreeId: "generator-session", mode: "preserve" })).rejects.toThrow();
    expect(await readFile(join(generator.cwd, "generator-only.txt"), "utf8")).toBe("keep\n");
    const refreshed = await f.cache.prepare({ repositoryId: "repository:online-store", revision: second,
      agentWorkspaceRoot: f.codexRoot, worktreeId: "qa-session", mode: "reset_to_revision" });
    expect(await readFile(join(refreshed.cwd, "app.txt"), "utf8")).toBe("two\n");
    await expect(readFile(join(refreshed.cwd, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await testGitCommand(f.tool, refreshed.cwd, ["rev-parse", "HEAD"])).trim()).toBe(second);
  });

  it("isolates a completed shared-store workspace without losing its dirty index", async () => {
    const { f, repositoryId, cwd, shared } = await legacyWorkspace();
    const before = await testGitCommand(f.tool, cwd, ["status", "--porcelain"]);
    const index = await testGitCommand(f.tool, cwd, ["diff", "--cached", "--binary"]);
    const resumed = await f.cache.prepare({ repositoryId, revision: f.first,
      agentWorkspaceRoot: f.claudeRoot, worktreeId: "old-layout" });
    expect(resumed.cwd).toBe(cwd);
    expect(await testGitCommand(f.tool, cwd, ["status", "--porcelain"])).toBe(before);
    expect(await testGitCommand(f.tool, cwd, ["diff", "--cached", "--binary"])).toBe(index);
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(cwd, "committed.txt"), "utf8")).toBe("unpublished commit\n");
    expect((await testGitCommand(f.tool, cwd, ["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/retained-session-branch");
    expect((await testGitCommand(f.tool, cwd, ["rev-parse", "HEAD"])).trim()).not.toBe(f.first);
    expect((await testGitCommand(f.tool, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()).not.toBe(shared);
    await resumed.verify();
  });

  it.each(["target", "pointer", "receipt"] as const)("resumes isolation after interruption following %s publication", async phase => {
    const { f, cwd, receiptPath, target, request } = await legacyWorkspace();
    const status = await testGitCommand(f.tool, cwd, ["status", "--porcelain"]);
    const staged = await testGitCommand(f.tool, cwd, ["diff", "--cached", "--binary"]);
    const destination = phase === "target" ? target : phase === "pointer" ? join(cwd, ".git") : receiptPath;
    const rename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
    let injected = false;
    const spy = vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!injected && String(to) === destination) { injected = true; throw new Error("simulated process interruption"); }
    });
    try { await expect(f.cache.prepare(request)).rejects.toThrow("simulated process interruption"); }
    finally { spy.mockImplementation(rename); }
    expect(injected).toBe(true);
    const restarted = new NativeRepositoryCache({ root: f.cacheRoot, tool: f.tool,
      fetchRevision: async () => { throw new Error("migration must not fetch source again"); } });
    const resumed = await restarted.prepare(request);
    expect(await testGitCommand(f.tool, cwd, ["status", "--porcelain"])).toBe(status);
    expect(await testGitCommand(f.tool, cwd, ["diff", "--cached", "--binary"])).toBe(staged);
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("keep\n");
    await expect(readFile(`${receiptPath}.isolation-migration.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await resumed.verify();
  });

  it("rejects a substituted migration journal and resumes only after the exact journal is restored", async () => {
    const { f, cwd, request, receiptPath } = await legacyWorkspace();
    const rename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
    let injected = false;
    const spy = vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!injected && String(to) === join(cwd, ".git")) { injected = true; throw new Error("interrupted publication"); }
    });
    try { await expect(f.cache.prepare(request)).rejects.toThrow("interrupted publication"); }
    finally { spy.mockImplementation(rename); }
    const marker = `${receiptPath}.isolation-migration.json`;
    const original = await readFile(marker, "utf8");
    const changed = JSON.parse(original);
    changed.after.repositoryDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(marker, JSON.stringify(changed));
    await expect(f.cache.prepare(request)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("keep\n");
    await writeFile(marker, original);
    await (await f.cache.prepare(request)).verify();
  });

  it.skipIf(process.platform === "win32")("rejects a symlink in source administration without switching the checkout", async () => {
    const { f, cwd, request } = await legacyWorkspace();
    const pointer = await readFile(join(cwd, ".git"), "utf8");
    const admin = (await testGitCommand(f.tool, cwd, ["rev-parse", "--absolute-git-dir"])).trim();
    await fsPromises.symlink(join(f.root, "origin.git"), join(admin, "foreign"));
    await expect(f.cache.prepare(request)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readFile(join(cwd, ".git"), "utf8")).toBe(pointer);
  });

  it("refuses to migrate a source administration with a live Git lock", async () => {
    const { f, cwd, request } = await legacyWorkspace();
    const pointer = await readFile(join(cwd, ".git"), "utf8");
    const admin = (await testGitCommand(f.tool, cwd, ["rev-parse", "--absolute-git-dir"])).trim();
    await writeFile(join(admin, "index.lock"), "busy");
    await expect(f.cache.prepare(request)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readFile(join(cwd, ".git"), "utf8")).toBe(pointer);
    expect(await readFile(join(cwd, "correction.txt"), "utf8")).toBe("unstaged\n");
  });

  it("refuses a drifted source config instead of normalizing it during migration", async () => {
    const { f, cwd, request } = await legacyWorkspace();
    const pointer = await readFile(join(cwd, ".git"), "utf8");
    await testGitCommand(f.tool, cwd, ["config", "core.hooksPath", ".husky/_"]);
    await expect(f.cache.prepare(request)).rejects.toMatchObject({ code: "capability_unavailable", diagnostic: "workspace_policy_invalid" });
    expect(await readFile(join(cwd, ".git"), "utf8")).toBe(pointer);
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("keep\n");
  });

  it.each([false, true])("isolates a first-format shared checkout with existing external receipt=%s", async existing => {
    const { f, cwd, request, receiptPath } = await legacyWorkspace();
    const status = await testGitCommand(f.tool, cwd, ["status", "--porcelain"]);
    const prior = JSON.parse(await readFile(receiptPath, "utf8"));
    const legacyPath = join(cwd, ".konteks-worktree.json");
    await writeFile(legacyPath, JSON.stringify({ format: prior.format,
      repositoryDigest: prior.repositoryDigest, baselineCommit: prior.baselineCommit }), { mode: 0o600 });
    if (!existing) await rm(receiptPath);
    const resumed = await f.cache.prepare(request);
    expect(await testGitCommand(f.tool, cwd, ["status", "--porcelain"])).toBe(status);
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await resumed.verify();
  });

  it("migrates the legacy in-worktree receipt without resetting dirty work", async () => {
    const f = await fixture();
    const first = await f.cache.prepare({
      repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.claudeRoot, worktreeId: "legacy",
    });
    const receiptName = (await readdir(f.cacheRoot)).find(name =>
      name.startsWith(".worktree-") && name.endsWith(".konteks-worktree.json"))!;
    const receiptPath = join(f.cacheRoot, receiptName);
    const current = JSON.parse(await readFile(receiptPath, "utf8"));
    const legacyPath = join(first.cwd, ".konteks-worktree.json");
    await writeFile(legacyPath, JSON.stringify({ format: current.format,
      repositoryDigest: current.repositoryDigest, baselineCommit: current.baselineCommit }), { mode: 0o600 });
    await rm(receiptPath);
    await writeFile(join(first.cwd, "unfinished.txt"), "keep me\n");

    const resumed = await f.cache.prepare({
      repositoryId: "repository:online-store", revision: f.first,
      agentWorkspaceRoot: f.claudeRoot, worktreeId: "legacy",
    });
    expect(await readFile(join(resumed.cwd, "unfinished.txt"), "utf8")).toBe("keep me\n");
    await expect(readFile(legacyPath, "utf8")).rejects.toThrow();
    expect(await readFile(receiptPath, "utf8")).toContain('"commonDirectoryDigest"');
  });

  it("recovers an interrupted pre-publication worktree idempotently", async () => {
    const f = await fixture();
    const repositoryDigest = `sha256:${sha256Hex(
      canonicalize({ repositoryId: "repository:online-store" }),
    )}`;
    const worktreeDigest = sha256Hex(canonicalize({ repositoryDigest, worktreeId: "delivery" }));
    const cwd = join(await realpath(f.claudeRoot), `worktree-${worktreeDigest}`);
    const gitDir = join(await realpath(f.cacheRoot), `${repositoryDigest.slice(7)}.git`);
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(cwd, "partial"), "not published", { mode: 0o600 });
    await writeFile(
      join(f.claudeRoot, `.worktree-${worktreeDigest}.konteks-worktree-intent.json`),
      JSON.stringify({
        format: "konteks-native-worktree-v1",
        repositoryDigest,
        baselineCommit: f.first,
        worktreePathDigest: `sha256:${sha256Hex(canonicalize({ path: cwd }))}`,
        commonDirectoryDigest: `sha256:${sha256Hex(canonicalize({ path: gitDir }))}`,
      }),
      { mode: 0o600 },
    );
    const recovered = await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.claudeRoot,
      worktreeId: "delivery",
    });
    expect(await readFile(join(recovered.cwd, "app.txt"), "utf8")).toBe("one\n");
    await expect(readFile(join(recovered.cwd, "partial"), "utf8")).rejects.toThrow();
    const kept = (await readdir(f.claudeRoot)).filter(name => name.includes(".kept-preparation-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(f.claudeRoot, kept[0]!, "partial"), "utf8")).toBe("not published");
  });

  it("never persists a remote URL or credential in the shared repository", async () => {
    const f = await fixture();
    await f.cache.prepare({
      repositoryId: "repository:online-store",
      revision: f.first,
      agentWorkspaceRoot: f.claudeRoot,
      worktreeId: "delivery",
    });
    const repository = join(
      f.cacheRoot,
      (await readdir(f.cacheRoot)).find((name) => !name.startsWith("."))!,
    );
    const config = await readFile(join(repository, "config"), "utf8");
    expect(config).not.toContain(f.origin);
    expect(config).not.toMatch(/remote |url\s*=|credential/i);
    expect((await testGitCommand(f.tool, repository, ["remote"])).trim()).toBe("");
    await chmod(repository, 0o700);
  });
});

// D105: a delivery session comes back to this computer after running
// elsewhere. Its old checkout started at another commit; Core now publishes a
// newer one. The computer continues instead of waiting forever, and never
// throws away anything that exists nowhere else.
describe("a delivery session returning to a computer with its old checkout", () => {
  const session = { repositoryId: "repository:online-store", worktreeId: "generator-session", mode: "preserve" as const };
  async function published(f: Awaited<ReturnType<typeof fixture>>, content: string, file = "app.txt") {
    await writeFile(join(f.seed, file), content);
    await testGitCommand(f.tool, f.seed, ["add", file]);
    await testGitCommand(f.tool, f.seed, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", content.trim()]);
    const revision = (await testGitCommand(f.tool, f.seed, ["rev-parse", "HEAD"])).trim();
    await testGitCommand(f.tool, f.seed, ["push", f.origin, "HEAD:refs/heads/main"]);
    return revision;
  }
  const none = { accepted: async () => null };

  it("replaces a checkout with no edits, one whose edits are all published, or one holding its accepted output", async () => {
    const f = await fixture();
    const old = await f.cache.prepare({ ...session, revision: f.first, agentWorkspaceRoot: f.claudeRoot, staleCheckout: none });
    // No edits: an older checkout simply moves to the published commit.
    const second = await published(f, "two\n");
    const clean = await f.cache.prepare({ ...session, revision: second, agentWorkspaceRoot: f.claudeRoot, staleCheckout: none });
    expect(clean.cwd).toBe(old.cwd);
    expect(clean.baselineCommit).toBe(second);
    expect(await readFile(join(clean.cwd, "app.txt"), "utf8")).toBe("two\n");
    // Its edit is exactly what the delivery branch now holds.
    await writeFile(join(clean.cwd, "app.txt"), "three\n");
    const third = await published(f, "three\n");
    const onBranch = await f.cache.prepare({ ...session, revision: third, agentWorkspaceRoot: f.claudeRoot, staleCheckout: none });
    expect(await readFile(join(onBranch.cwd, "app.txt"), "utf8")).toBe("three\n");
    expect((await testGitCommand(f.tool, onBranch.cwd, ["status", "--porcelain"])).trim()).toBe("");
    // Its edit is the output this computer's last accepted turn produced.
    await writeFile(join(onBranch.cwd, "accepted.txt"), "accepted\n");
    const content = Buffer.from("accepted\n");
    const { computeRemoteFileTreeDigest } = await import("@konteks/remote-common");
    const { createHash } = await import("node:crypto");
    const treeDigest = computeRemoteFileTreeDigest([{ path: "accepted.txt", mode: 384, sizeBytes: content.byteLength,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") }]);
    const fourth = await published(f, "four\n", "other.txt");
    const accepted = await f.cache.prepare({ ...session, revision: fourth, agentWorkspaceRoot: f.claudeRoot,
      staleCheckout: { accepted: async () => ({ treeDigest, deletions: [] }) } });
    expect(await readFile(join(accepted.cwd, "other.txt"), "utf8")).toBe("four\n");
    expect((await readdir(f.claudeRoot)).filter(name => name.includes(".kept-"))).toEqual([]);
  });

  it("keeps review corrections in the same Engineering checkout while QA refreshes to the corrected published revision", async () => {
    const f = await fixture();
    const engineeringInput = { ...session, revision: f.first, agentWorkspaceRoot: f.codexRoot };
    const engineering = await f.cache.prepare(engineeringInput);
    await writeFile(join(engineering.cwd, "app.txt"), "published A\n");
    await writeFile(join(engineering.cwd, "obsolete.txt"), "remove after review\n");
    await published(f, "published A\n");
    const revisionA = await published(f, "remove after review\n", "obsolete.txt");
    const qaInput = { ...engineeringInput, worktreeId: "review-correction-qa", mode: "reset_to_revision" as const };
    const qaA = await f.cache.prepare({ ...qaInput, revision: revisionA });
    expect(await readFile(join(qaA.cwd, "obsolete.txt"), "utf8")).toBe("remove after review\n");

    const continuation = await f.cache.prepare(engineeringInput);
    expect(continuation.cwd).toBe(engineering.cwd);
    await writeFile(join(continuation.cwd, "app.txt"), "corrected B\n");
    await writeFile(join(continuation.cwd, "added.txt"), "review addition\n");
    await testGitCommand(f.tool, continuation.cwd, ["add", "added.txt"]);
    await rm(join(continuation.cwd, "obsolete.txt"));
    const correctionState = await testGitCommand(f.tool, continuation.cwd, ["status", "--porcelain"]);
    const retry = await f.cache.prepare(engineeringInput);
    expect(retry.cwd).toBe(engineering.cwd);
    expect(await testGitCommand(f.tool, retry.cwd, ["status", "--porcelain"])).toBe(correctionState);
    expect(await readFile(join(qaA.cwd, "app.txt"), "utf8")).toBe("published A\n");

    // Model the publication boundary with actual commits in the fixture's source repository.
    await testGitCommand(f.tool, f.seed, ["rm", "obsolete.txt"]);
    await published(f, "corrected B\n");
    const revisionB = await published(f, "review addition\n", "added.txt");
    expect(revisionB).not.toBe(revisionA);
    const qaB = await f.cache.prepare({ ...qaInput, revision: revisionB });
    expect(qaB.cwd).toBe(qaA.cwd);
    expect(qaB.baselineCommit).toBe(revisionB);
    expect(await readFile(join(qaB.cwd, "app.txt"), "utf8")).toBe("corrected B\n");
    expect(await readFile(join(qaB.cwd, "added.txt"), "utf8")).toBe("review addition\n");
    await expect(readFile(join(qaB.cwd, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await testGitCommand(f.tool, retry.cwd, ["status", "--porcelain"])).toBe(correctionState);
    await retry.verify();
    await qaB.verify();
  });

  it("moves a checkout holding unsaved changes aside, intact, and continues on a fresh one", async () => {
    const f = await fixture();
    const old = await f.cache.prepare({ ...session, revision: f.first, agentWorkspaceRoot: f.claudeRoot, staleCheckout: none });
    await writeFile(join(old.cwd, "unsaved.txt"), "only here\n");
    const second = await published(f, "two\n");
    const reported: Array<{ keptBaselineCommit: string; publishedRevision: string }> = [];
    const fresh = await f.cache.prepare({ ...session, revision: second, agentWorkspaceRoot: f.claudeRoot,
      staleCheckout: { ...none, keptAside: async kept => { reported.push(kept); throw new Error("Core unreachable"); } } });
    // The delivery is told once, and a failed report never fails the turn.
    expect(reported).toEqual([{ keptBaselineCommit: f.first, publishedRevision: second }]);
    expect(fresh.baselineCommit).toBe(second);
    await expect(readFile(join(fresh.cwd, "unsaved.txt"), "utf8")).rejects.toThrow();
    const kept = (await readdir(f.claudeRoot)).filter(name => name.includes(".kept-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(f.claudeRoot, kept[0]!, "unsaved.txt"), "utf8")).toBe("only here\n");
    await fresh.verify();
  });

  it("still refuses to move any other preserved checkout", async () => {
    const f = await fixture();
    await f.cache.prepare({ ...session, revision: f.first, agentWorkspaceRoot: f.claudeRoot });
    const second = await published(f, "two\n");
    await expect(f.cache.prepare({ ...session, revision: second, agentWorkspaceRoot: f.claudeRoot })).rejects.toThrow();
  });
});
