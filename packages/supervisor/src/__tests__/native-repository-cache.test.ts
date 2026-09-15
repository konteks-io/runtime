import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "@konteks/remote-common";
import { NativeRepositoryCache } from "../native/repository-cache.js";
import { testGitCommand, testGitTool } from "./native-git-fixture.js";

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

describe("native shared repository cache", () => {
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
