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

  it("moves a checkout holding unsaved changes aside, intact, and continues on a fresh one", async () => {
    const f = await fixture();
    const old = await f.cache.prepare({ ...session, revision: f.first, agentWorkspaceRoot: f.claudeRoot, staleCheckout: none });
    await writeFile(join(old.cwd, "unsaved.txt"), "only here\n");
    const second = await published(f, "two\n");
    const fresh = await f.cache.prepare({ ...session, revision: second, agentWorkspaceRoot: f.claudeRoot, staleCheckout: none });
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
