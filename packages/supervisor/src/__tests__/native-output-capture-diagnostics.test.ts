import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Real Git everywhere, except the one call a test makes fail the way a busy computer would. */
const gitFault = vi.hoisted(() => ({
  current: null as null | ((args: readonly string[]) => { error: Error } | { stdout: Buffer } | null),
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, args: readonly string[], options: unknown, callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
    const fault = gitFault.current?.(args) ?? null;
    if (!fault) return actual.execFile(file, args, options as never, callback as never);
    const child = actual.execFile("/usr/bin/true", [], () => {
      if ("error" in fault) callback(fault.error, Buffer.alloc(0), Buffer.alloc(0));
      else callback(null, fault.stdout, Buffer.alloc(0));
    });
    return child;
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile };
});

const { captureNativeDeliveryOutput } = await import("../native/output-capture.js");
const { OutputCaptureRefusal, deliveryOutputFailure, deliveryStep } = await import("../native/delivery-output-failure.js");
const { RemoteInstanceError } = await import("@konteks/remote-common");

let dir = "";
let scripts = "";
beforeEach(async () => {
  gitFault.current = null;
  dir = await mkdtemp(join(tmpdir(), "kr-output-diag-"));
  scripts = await mkdtemp(join(tmpdir(), "kr-output-git-"));
  execFileSync("git", ["init", "-q", dir]);
  await writeFile(join(dir, "kept.txt"), "before\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base"]);
  await writeFile(join(dir, "kept.txt"), "after\n");
});
afterEach(async () => {
  gitFault.current = null;
  await rm(dir, { recursive: true, force: true });
  await rm(scripts, { recursive: true, force: true });
});

function options(gitExecutable = "/usr/bin/git", warn = vi.fn()) {
  const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
  return { cwd: dir, gitExecutable, baselineCommit: base,
    binding: { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" },
    claimId: "claim", invocationRef: "invocation", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: base,
    logger: { warn, info: vi.fn() } as never };
}

async function refusalOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(OutputCaptureRefusal);
  return error as InstanceType<typeof OutputCaptureRefusal>;
}

describe("named delivery output capture refusals", () => {
  it("names a Git call killed at the timeout, and which call it was", async () => {
    gitFault.current = args => args.includes("ls-files") && args.includes("--others")
      ? { error: Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", code: null }) } : null;
    const warn = vi.fn();
    const refusal = await refusalOf(captureNativeDeliveryOutput(options("/usr/bin/git", warn)));
    expect(refusal).toMatchObject({ code: "capability_unavailable", diagnostic: "git_timeout", facts: { gitStep: "ls_files" } });
    expect(refusal.message).toBe("Generated delivery output is unavailable or changed during capture.");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "native.output.capture_failed", diagnostic: "git_timeout", gitStep: "ls_files" }), expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(dir);
  });

  it("names Git output past the capture's buffer", async () => {
    // A real overflow: this Git prints 17 MiB for `write-tree`, past the 16 MiB cap.
    const git = join(scripts, "git");
    await writeFile(git, `#!/bin/sh\ncase " $* " in *" write-tree "*) /usr/bin/head -c 17825792 /dev/zero; exit 0;; esac\nexec /usr/bin/git "$@"\n`);
    await chmod(git, 0o755);
    const refusal = await refusalOf(captureNativeDeliveryOutput(options(git)));
    expect(refusal).toMatchObject({ diagnostic: "git_output_too_large", facts: { gitStep: "write_tree" } });
  });

  it("names a Git call that exits nonzero, with its exit code", async () => {
    gitFault.current = args => args.includes("read-tree")
      ? { error: Object.assign(new Error("Command failed"), { killed: false, signal: null, code: 128 }) } : null;
    const refusal = await refusalOf(captureNativeDeliveryOutput(options()));
    expect(refusal).toMatchObject({ diagnostic: "git_failed", facts: { gitStep: "read_tree", exitCode: 128 } });
  });

  it("names a tree that changed between the two captures", async () => {
    let writes = 0;
    gitFault.current = args => args.includes("write-tree") && ++writes === 2 ? { stdout: Buffer.from(`${"b".repeat(40)}\n`) } : null;
    const refusal = await refusalOf(captureNativeDeliveryOutput(options()));
    expect(refusal.diagnostic).toBe("tree_unstable");
    expect(refusal.facts).toEqual({});
  });

  it("names an invalid baseline and an invalid worktree before running Git", async () => {
    await expect(captureNativeDeliveryOutput({ ...options(), baselineCommit: "not-a-commit" })).rejects.toMatchObject({ diagnostic: "baseline_invalid" });
    await expect(captureNativeDeliveryOutput({ ...options(), cwd: "relative/path" })).rejects.toMatchObject({ diagnostic: "worktree_invalid" });
  });
});

describe("a retained delivery output retry as a runtime failure", () => {
  it("names the innermost step and keeps the error itself unchanged", async () => {
    const refusal = new OutputCaptureRefusal("git_failed", { gitStep: "write_tree", exitCode: 128 });
    const thrown = await deliveryStep("output_accept", () => deliveryStep("output_capture", () => Promise.reject(refusal))).catch((error: unknown) => error);
    expect(thrown).toBe(refusal);
    expect(deliveryOutputFailure(thrown)).toEqual({ phase: "turn", stage: "delivery_output_capture_git_write_tree", code: "git_failed",
      evidence: { kind: "process_exit", exitCode: 128 }, retryable: true });
  });

  it("carries an OS errno, and falls back to the error code for an unnamed refusal", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied, open '/private/path'"), { code: "EACCES", syscall: "open" });
    const thrown = await deliveryStep("output_record_read", () => { throw denied; }).catch((error: unknown) => error);
    expect(deliveryOutputFailure(thrown)).toEqual({ phase: "turn", stage: "delivery_output_record_read", code: "filesystem_error",
      evidence: { kind: "runtime_exception", errno: "EACCES" }, retryable: true });
    expect(JSON.stringify(deliveryOutputFailure(thrown))).not.toContain("private");
    const core = new RemoteInstanceError("capability_unavailable", "refused", { diagnostic: "Not An Identifier" });
    expect(deliveryOutputFailure(core)).toEqual({ phase: "turn", stage: "delivery_output_transfer", code: "capability_unavailable",
      evidence: { kind: "runtime_condition" }, retryable: true });
  });
});
