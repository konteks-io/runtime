import { appendFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkAssignment } from "@konteks/remote-common";
import { testGitCommand, testGitTool } from "./native-git-fixture.js";

/** Real Git everywhere, except the one call a test makes fail the way a busy computer would. */
const gitFault = vi.hoisted(() => ({ current: null as null | ((args: readonly string[]) => Error | null) }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, args: readonly string[], options: unknown, callback?: (error: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
    const fault = gitFault.current?.(args) ?? null;
    if (!fault || !callback) return actual.execFile(file, args, options as never, callback as never);
    return actual.execFile("/usr/bin/true", [], () => callback(fault, Buffer.alloc(0), Buffer.alloc(0)));
  }) as unknown as typeof actual.execFile;
  // The test's own Git fixture awaits the promisified form, which stays real.
  const custom = promisify.custom as unknown as keyof typeof execFile;
  return { ...actual, execFile: Object.assign(execFile, { [custom]: actual.execFile[custom] }) };
});

const { captureWorkspaceCheckpoint } = await import("../native/workspace-checkpoint.js");
const { NativeWorkspaceCheckpointStore } = await import("../native/workspace-preservation.js");
const { checkpointCause, checkpointFailure } = await import("../native/workspace-checkpoint-failure.js");
const { RemoteWorkspaceBeginRequestSchema } = await import("@konteks/remote-common");

let root = ""; let cwd = ""; let baseline = "";
let tool: Awaited<ReturnType<typeof testGitTool>>;
const capture = "workspace_capture";
const operation = { stage: capture, code: "checkpoint_capture_failed" };

beforeEach(async () => {
  gitFault.current = null;
  root = await mkdtemp(join(tmpdir(), "kr-checkpoint-diag-")); cwd = join(root, "source"); await mkdir(cwd, { mode: 0o700 });
  tool = await testGitTool();
  await testGitCommand(tool, cwd, ["init", "-q"]);
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n"); await writeFile(join(cwd, "file.txt"), "base");
  await testGitCommand(tool, cwd, ["add", "."]);
  await testGitCommand(tool, cwd, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base"]);
  baseline = (await testGitCommand(tool, cwd, ["rev-parse", "HEAD"])).trim();
});
afterEach(async () => { gitFault.current = null; await rm(root, { recursive: true, force: true }); });

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  return error as Error & { code?: string; diagnostic?: string; facts?: Record<string, unknown> };
}

const captured = () => captureWorkspaceCheckpoint({ cwd, baselineCommit: baseline, tool });

describe("named recovery checkpoint refusals", () => {
  it("names an ignored file hard-linked from outside the workspace", async () => {
    await mkdir(join(cwd, "node_modules")); await writeFile(join(root, "store-file"), "shared");
    await link(join(root, "store-file"), join(cwd, "node_modules", "package.js"));
    const error = await refusal(captured());
    expect(error).toMatchObject({ code: "recovery_required", diagnostic: "file_hardlinked" });
    expect(error.message).toBe("The unfinished workspace bytes could not be preserved or verified. Existing work was kept.");
    expect(checkpointFailure(error, operation)).toEqual({ phase: "checkpoint", stage: "workspace_capture_file_hardlinked",
      code: "checkpoint_capture_failed", evidence: { kind: "runtime_condition" } });
  });

  it("names a custom ignore line in the repository's own exclude file", async () => {
    await appendFile(join(cwd, ".git", "info", "exclude"), "private-notes/\n");
    const error = await refusal(captured());
    expect(error).toMatchObject({ code: "capability_unavailable", diagnostic: "git_info_exclude_custom" });
    expect(error.message).toBe("The unfinished workspace could not be preserved or verified. The original workspace was kept.");
  });

  it("names a stash the checkpoint cannot carry", async () => {
    await writeFile(join(cwd, "file.txt"), "stashed edit");
    await testGitCommand(tool, cwd, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "stash", "-q"]);
    expect(await refusal(captured())).toMatchObject({ code: "capability_unavailable", diagnostic: "stash_present" });
  });

  it("names a workspace past the file-count limit", async () => {
    const folder = join(cwd, "node_modules"); await mkdir(folder);
    for (let start = 0; start <= 10_000; start += 500) {
      await Promise.all(Array.from({ length: 500 }, (_, n) => writeFile(join(folder, `f${start + n}`), "")));
    }
    expect(await refusal(captured())).toMatchObject({ code: "capability_unavailable", diagnostic: "limit_files_exceeded" });
  });

  it("names a Git call that exits nonzero, with its step and exit code as process evidence", async () => {
    baseline = "0".repeat(40);
    const error = await refusal(captured());
    expect(error).toMatchObject({ diagnostic: "git_failed", facts: { gitStep: "cat_file", exitCode: 128 } });
    expect(checkpointFailure(error, operation)).toEqual({ phase: "checkpoint", stage: "workspace_capture_git_failed_cat_file",
      code: "checkpoint_capture_failed", evidence: { kind: "process_exit", exitCode: 128 } });
  });

  it("names a Git call killed at its timeout, and which call it was", async () => {
    gitFault.current = args => args.includes("ls-files")
      ? Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }) : null;
    const error = await refusal(captured());
    expect(error).toMatchObject({ diagnostic: "git_timeout", facts: { gitStep: "ls_files_stage" } });
    expect(checkpointFailure(error, operation).stage).toBe("workspace_capture_git_timeout_ls_files_stage");
  });

  it("names an OS error by syscall and errno, never its path", () => {
    const denied = Object.assign(new Error("EACCES: permission denied, lstat '/private/source'"), { code: "EACCES", syscall: "lstat" });
    expect(checkpointCause(denied)).toBe("fs_lstat_eacces");
    expect(checkpointFailure(denied, operation)).toEqual({ phase: "checkpoint", stage: "workspace_capture_fs_lstat_eacces",
      code: "checkpoint_capture_failed", evidence: { kind: "runtime_exception", errno: "EACCES" } });
    expect(checkpointFailure(new Error("private text"), operation)).toEqual({ phase: "checkpoint", stage: capture,
      code: "checkpoint_capture_failed", evidence: { kind: "runtime_exception" } });
  });
});

it("reports the refusal behind a failed seal as its stage and keeps the edits", async () => {
  const api = { workspace: vi.fn(async (_assignment: unknown, _operation: string, raw: unknown) =>
    ({ checkpointId: RemoteWorkspaceBeginRequestSchema.parse(raw).checkpointId, state: "writing" })) };
  const onRuntimeFailure = vi.fn();
  const store = new NativeWorkspaceCheckpointStore({ root, client: () => api as never, onRuntimeFailure });
  const assignment: RemoteWorkAssignment = { id: "assignment", instanceId: "old", workspaceId: "tenant", attempt: 1, kind: "assistant_execution", placementId: "placement",
    taskId: "task", correlationId: "correlation", expiresAt: "2026-10-13T02:00:00Z", requiredCapabilities: [], agentRoute: { agentId: "codex", requiredRole: "assistant" },
    source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: "turn" },
    policy: { maxDurationSeconds: 600, maxArtifactBytes: 1024, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
      latestResumeAt: "2026-10-13T02:00:00Z", permissionResponderDeadlineSeconds: 30, humanDeferralAllowed: false } };
  await store.begin({ assignment, claimId: "claim", selectionDigest: `sha256:${"a".repeat(64)}`, cwd, baselineCommit: baseline, tool });
  await writeFile(join(cwd, "file.txt"), "unfinished edits");
  await mkdir(join(cwd, "node_modules")); await writeFile(join(root, "store-file"), "shared");
  await link(join(root, "store-file"), join(cwd, "node_modules", "package.js"));

  await expect(store.seal({ assignmentId: "assignment", attempt: 1, claimId: "claim" }, () => undefined))
    .rejects.toMatchObject({ code: "recovery_required", diagnostic: "file_hardlinked" });
  expect(onRuntimeFailure).toHaveBeenCalledExactlyOnceWith({ phase: "checkpoint", stage: "workspace_capture_file_hardlinked",
    code: "checkpoint_capture_failed", evidence: { kind: "runtime_condition" } }, { assignmentId: "assignment", attempt: 1 });
  expect(JSON.stringify(onRuntimeFailure.mock.calls)).not.toContain(root);
  expect(api.workspace).toHaveBeenCalledTimes(1);
});
