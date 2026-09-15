import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeRemoteDeliveryOutputDigest } from "@konteks/remote-common";
import { captureNativeDeliveryOutput } from "../native/output-capture.js";

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
      ["generated/ignored.txt", "ignored but required\n", 0o600], ["kept.txt", "after\n", 0o600], ["new.sh", "#!/bin/sh\nexit 0\n", 0o700],
    ]);
    const { resultDigest: _, ...digestBody } = result;
    expect(result.resultDigest).toBe(computeRemoteDeliveryOutputDigest(digestBody));
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
