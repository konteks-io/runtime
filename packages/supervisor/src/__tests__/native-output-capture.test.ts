import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRemoteDeliveryOutputDigest, computeRemoteFileTreeDigest } from "@konteks/remote-common";
import { captureNativeDeliveryOutput, checkOutputTreeLimits, staleCheckoutVerdict } from "../native/output-capture.js";

let dir = "";
let linked = "";
const run = promisify(execFile);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-output-"));
  await run("git", ["init", "-q", dir]);
  await writeFile(join(dir, "kept.txt"), "before\n");
  await writeFile(join(dir, "deleted.txt"), "delete me\n");
  await writeFile(join(dir, ".gitignore"), "generated/\n");
  await run("git", ["-C", dir, "add", "."]);
  await run("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base"]);
});
afterEach(async () => {
  if (linked) await rm(linked, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  linked = "";
});

describe("native delivery output capture", () => {
  async function outputOptions() {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    return { cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(),
      binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "invocation", inputSelectionDigest: "sha256:" + "a".repeat(64), baseRevision: stdout.trim() };
  }

  async function writeFixtureFiles(paths: string[]) {
    for (const file of paths) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), "fixture content\n");
    }
  }

  it("excludes internal Graft output without wiring while retaining project Graft files", async () => {
    const options = await outputOptions();
    const index = await readFile(join(dir, ".git", "index"));
    await writeFixtureFiles(["graft/.cache/session/s.json", "graft/.cache/stats.json", "graft/.graph/index.db",
      "graft/INDEX.md", "graft/config.json", "src/graft/.cache/source.ts"]);
    const result = await captureNativeDeliveryOutput(options);
    expect(result.files.entries.map(entry => entry.path)).toEqual(["graft/INDEX.md", "graft/config.json", "src/graft/.cache/source.ts"]);
    expect(result.deletions).toEqual([]);
    expect(await readFile(join(dir, ".git", "index"))).toEqual(index);
    const { resultDigest: _digest, ...body } = result;
    expect(result.resultDigest).toBe(computeRemoteDeliveryOutputDigest(body));
  });

  it("keeps tracked and pre-staged internal cache changes out without altering the real index or HEAD", async () => {
    await writeFixtureFiles(["graft/.cache/tracked.json", "graft/.graph/base.db"]);
    await run("git", ["-C", dir, "add", "--force", "graft"]);
    await run("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "tracked fixtures"]);
    const options = await outputOptions();
    await writeFile(join(dir, "graft", ".cache", "tracked.json"), "changed cache\n");
    await unlink(join(dir, "graft", ".graph", "base.db"));
    await writeFixtureFiles(["graft/.cache/pre-staged.json"]);
    await writeFile(join(dir, "kept.txt"), "real project change\n");
    await run("git", ["-C", dir, "add", "-A"]);
    const index = await readFile(join(dir, ".git", "index"));
    const result = await captureNativeDeliveryOutput(options);
    expect(result.files.entries.map(entry => entry.path)).toEqual(["kept.txt"]);
    expect(result.deletions).toEqual([]);
    expect(await readFile(join(dir, ".git", "index"))).toEqual(index);
    expect((await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim()).toBe(options.baselineCommit);
  });

  it("does not force legacy accepted cache paths back into a correction or its deletions", async () => {
    const options = await outputOptions();
    const bytes = Buffer.from("legacy cache fixture\n");
    const entry = { path: "graft/.cache/session/legacy.json", mode: 384 as const,
      sizeBytes: bytes.length, contentBase64: bytes.toString("base64"),
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    await writeFixtureFiles([entry.path]);
    await writeFile(join(dir, ".git", "info", "exclude"), "graft/\n");
    await writeFile(join(dir, "kept.txt"), "real correction\n");
    const previousOutput = { files: { format: "konteks-file-tree-v1" as const, entries: [entry],
      treeDigest: computeRemoteFileTreeDigest([entry]) }, deletions: ["graft/.graph/removed.db"] };
    const result = await captureNativeDeliveryOutput({ ...options, previousOutput });
    expect(result.files.entries.map(file => file.path)).toEqual(["kept.txt"]);
    expect(result.deletions).toEqual([]);
  });

  it("does not count only internal cache activity as project output or unsaved source", async () => {
    const options = await outputOptions();
    await writeFixtureFiles(["graft/.cache/stats.json", "graft/.graph/index.db"]);
    const result = await captureNativeDeliveryOutput(options);
    expect(result.files.entries).toEqual([]);
    expect(result.deletions).toEqual([]);
    await expect(staleCheckoutVerdict({ ...options, publishedCommit: options.baselineCommit })).resolves.toBe("clean");
    expect(await readFile(join(dir, "graft", ".cache", "stats.json"), "utf8")).toBe("fixture content\n");
  });

  it("captures exact changed/untracked bytes and explicit deletions against the pinned base", async () => {
    await writeFile(join(dir, "kept.txt"), "after\n");
    await writeFile(join(dir, "new.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "new.sh"), 0o700);
    await mkdir(join(dir, "generated"));
    await writeFile(join(dir, "generated", "ignored.txt"), "ignored but required\n");
    await unlink(join(dir, "deleted.txt"));
    const binding = { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" };
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const result = await captureNativeDeliveryOutput({ cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(), binding,
      claimId: "claim", invocationRef: "invocation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: "revision" });
    expect(result.deletions).toEqual(["deleted.txt"]);
    expect(result.files.entries.map(entry => [entry.path, Buffer.from(entry.contentBase64, "base64").toString(), entry.mode])).toEqual([
      ["kept.txt", "after\n", 0o600], ["new.sh", "#!/bin/sh\nexit 0\n", 0o700],
    ]);
    const { resultDigest: _, ...digestBody } = result;
    expect(result.resultDigest).toBe(computeRemoteDeliveryOutputDigest(digestBody));
  });

  it("keeps corrections against the previous accepted output across turns", async () => {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const options = { cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(),
      binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "first", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: stdout.trim() };
    await writeFile(join(dir, "added.txt"), "unwanted change\n");
    await writeFile(join(dir, "kept.txt"), "changed\n");
    await unlink(join(dir, "deleted.txt"));
    const first = await captureNativeDeliveryOutput(options);
    await unlink(join(dir, "added.txt"));
    await writeFile(join(dir, "kept.txt"), "before\n");
    await writeFile(join(dir, "deleted.txt"), "delete me\n");
    const second = await captureNativeDeliveryOutput({ ...options, invocationRef: "second", previousOutput: first });
    expect(second.deletions).toEqual(["added.txt"]);
    expect(second.files.entries.map(entry => [entry.path, Buffer.from(entry.contentBase64, "base64").toString()])).toEqual([
      ["deleted.txt", "delete me\n"], ["kept.txt", "before\n"],
    ]);
    const third = await captureNativeDeliveryOutput({ ...options, invocationRef: "third", previousOutput: second });
    expect(third.files).toEqual(second.files);
    expect(third.deletions).toEqual(second.deletions);
    const accepted = { treeDigest: second.files.treeDigest, files: second.files, deletions: second.deletions };
    await expect(staleCheckoutVerdict({ ...options, publishedCommit: stdout.trim(), accepted })).resolves.toBe("accepted");
    await writeFile(join(dir, "kept.txt"), "unaccepted work\n");
    await expect(staleCheckoutVerdict({ ...options, publishedCommit: stdout.trim(), accepted })).resolves.toBe("unsaved");
  });

  it("retains previously accepted files when later ignored without capturing new ignored files", async () => {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const options = { cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(),
      binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "first", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: stdout.trim() };
    await writeFile(join(dir, "accepted.txt"), "accepted\n");
    const first = await captureNativeDeliveryOutput(options);
    await writeFile(join(dir, ".git", "info", "exclude"), "accepted.txt\nprivate.txt\n");
    await writeFile(join(dir, "accepted.txt"), "corrected\n");
    await writeFile(join(dir, "private.txt"), "never accepted\n");
    const second = await captureNativeDeliveryOutput({ ...options, invocationRef: "second", previousOutput: first });
    expect(second.files.entries.map(entry => entry.path)).toEqual(["accepted.txt"]);
    expect(Buffer.from(second.files.entries[0]!.contentBase64, "base64").toString()).toBe("corrected\n");
  });

  it("honors connector exclude rules without suppressing tracked project changes", async () => {
    await writeFile(join(dir, ".git", "info", "exclude"), "graft/\n.mcp.json\nkept.txt\n");
    await mkdir(join(dir, "graft"));
    await writeFile(join(dir, "graft", "INDEX.md"), "connector metadata");
    await writeFile(join(dir, ".mcp.json"), "connector config");
    await writeFile(join(dir, "kept.txt"), "project change");
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const result = await captureNativeDeliveryOutput({ cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(),
      binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "invocation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: stdout.trim() });
    expect(result.files.entries.map(entry => entry.path)).toEqual(["kept.txt"]);
  });

  it("emits bounded diagnostic-correlated capture telemetry without output content or paths", async () => {
    await writeFile(join(dir, "secret-path.txt"), "payload-canary-secret\n");
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const info = vi.fn();
    const result = await captureNativeDeliveryOutput({ cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(),
      binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "c01-correlation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: "revision",
      logger: { info } as never });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "native.output.capture_completed", correlationId: "c01-correlation",
      stage: "capture", outcome: "success", bytes: result.files.entries[0]?.sizeBytes, resultDigest: result.resultDigest, durationMs: expect.any(Number) }), expect.any(String));
    expect(JSON.stringify(info.mock.calls)).not.toContain("payload-canary-secret");
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-path.txt");
  });

  it("never captures a package-manager cache, even when nothing ignores it", async () => {
    await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.js"), "// app\n");
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const result = await captureNativeDeliveryOutput({ cwd: dir, gitExecutable: "/usr/bin/git", baselineCommit: stdout.trim(),
      binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "invocation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: stdout.trim() });
    expect(result.files.entries.map(entry => entry.path)).toEqual(["src/app.js"]);
  });

  it("refuses a tree past the transfer contract before it leaves the runtime", () => {
    expect(() => checkOutputTreeLimits(Array.from({ length: 1001 }, () => ({ sizeBytes: 1 }))))
      .toThrow(/exceeds the transfer contract \(1001 files/);
    expect(() => checkOutputTreeLimits([{ sizeBytes: 10 * 1024 * 1024 + 1 }])).toThrow(/exceeds the transfer contract/);
    expect(() => checkOutputTreeLimits([{ sizeBytes: 10 }])).not.toThrow();
  });

  it("fails closed if the pinned base moved", async () => {
    await expect(captureNativeDeliveryOutput({ cwd: dir, gitExecutable: "/usr/bin/git",
      baselineCommit: "0".repeat(40), binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "invocation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: "not-the-local-base" })).rejects.toThrow();
  });

  it("captures output from a linked worktree through its verified common object store", async () => {
    linked = join(dirname(dir), `${basename(dir)}-linked`);
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    await run("git", ["-C", dir, "worktree", "add", "--detach", linked, stdout.trim()]);
    await writeFile(join(linked, "kept.txt"), "linked change\n");
    const result = await captureNativeDeliveryOutput({ cwd: linked, gitExecutable: "/usr/bin/git",
      baselineCommit: stdout.trim(), binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
      claimId: "claim", invocationRef: "invocation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: stdout.trim() });
    expect(result.files.entries.map(entry => entry.path)).toEqual(["kept.txt"]);
  });
});
