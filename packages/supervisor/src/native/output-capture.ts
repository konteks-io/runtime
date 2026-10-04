import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  REMOTE_FILE_TREE_LIMITS,
  RemoteDeliveryResultCandidateSchema,
  RemoteFileTreeSchema,
  RemoteInstanceError,
  canonicalize,
  computeRemoteDeliveryOutputDigest,
  computeRemoteFileTreeDigest,
  createLogger,
  type Logger,
  type RemoteDeliveryResultCandidate,
  type RemoteTransferBinding,
} from "@konteks/remote-common";

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const unavailable = () => new RemoteInstanceError("capability_unavailable", "Generated delivery output is unavailable or changed during capture.");

/**
 * Package-manager caches are never part of a delivered change: an agent that
 * runs `npm install` inside the worktree would otherwise hand the platform a
 * tree of tens of thousands of vendored files, far past the contract's
 * 1000-file / 10 MiB envelope. Repository and connector ignore rules remain authoritative for untracked
 * files. Already tracked files are still captured even if later ignored.
 */
const DEPENDENCY_CACHE_EXCLUSIONS = [
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.venv/**",
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/.pnpm-store/**",
];

/** The captured tree against the transfer contract, before any bytes leave the runtime. */
export function checkOutputTreeLimits(entries: ReadonlyArray<{ sizeBytes: number }>): void {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (entries.length <= REMOTE_FILE_TREE_LIMITS.files && totalBytes <= REMOTE_FILE_TREE_LIMITS.bytes) return;
  throw new RemoteInstanceError("capability_unavailable",
    `Generated delivery output exceeds the transfer contract (${entries.length} files, ${totalBytes} bytes; limits ${REMOTE_FILE_TREE_LIMITS.files} files, ${REMOTE_FILE_TREE_LIMITS.bytes} bytes).`,
    { diagnostic: "output_exceeds_limits" });
}

async function checkedDirectory(value: string): Promise<string> {
  if (!isAbsolute(value) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw unavailable();
  const path = await realpath(value);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return path;
}

function gitEnv(executable: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: dirname(executable), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", ...overrides,
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function runGit(executable: string, cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-c", "core.hooksPath=", "-c", "status.renames=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.eol=lf", "--no-pager", ...args], {
      cwd, env: gitEnv(executable, env), timeout: 30_000, killSignal: "SIGKILL", maxBuffer: MAX_GIT_OUTPUT, encoding: "buffer", windowsHide: true,
    }, (error, stdout) => error ? reject(unavailable()) : resolve(stdout));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

function decodePaths(value: Buffer): string[] {
  return new TextDecoder("utf-8", { fatal: true }).decode(value).split("\0").filter(Boolean).sort();
}

async function captureIndex(executable: string, cwd: string, baselineCommit: string, env: NodeJS.ProcessEnv): Promise<string> {
  await runGit(executable, cwd, ["read-tree", "--reset", baselineCommit], env);
  // A private index captures tracked changes and non-ignored new files.
  // Forcing addition bypasses connector excludes and publishes local tooling.
  await runGit(executable, cwd, ["add", "--no-renormalize", "-A", "--", ".", ...DEPENDENCY_CACHE_EXCLUSIONS], env);
  const tree = (await runGit(executable, cwd, ["write-tree"], env)).toString("ascii").trim();
  if (!oidPattern.test(tree)) throw unavailable();
  return tree;
}

function parseTree(value: Buffer): Map<string, { oid: string; mode: 0o600 | 0o700 }> {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  const entries = new Map<string, { oid: string; mode: 0o600 | 0o700 }>();
  for (const row of decoded.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/u.exec(row);
    if (!match || entries.has(match[3]!)) throw unavailable();
    entries.set(match[3]!, { oid: match[2]!, mode: match[1] === "100755" ? 0o700 : 0o600 });
  }
  return entries;
}

async function readBlobs(executable: string, cwd: string, env: NodeJS.ProcessEnv, oids: string[]): Promise<Buffer[]> {
  if (!oids.length) return [];
  const output = await runGit(executable, cwd, ["cat-file", "--batch"], env, oids.join("\n") + "\n");
  const result: Buffer[] = []; let offset = 0;
  for (const expected of oids) {
    const blob = nextBlob(output, offset, expected);
    result.push(blob.bytes); offset = blob.next;
  }
  if (offset !== output.length) throw unavailable();
  return result;
}

/** The `cat-file --batch` blob at `offset`: exactly the expected object, its stated size, and a closing newline. */
function nextBlob(output: Buffer, offset: number, expected: string): { bytes: Buffer; next: number } {
  const newline = output.indexOf(0x0a, offset);
  if (newline < 0) throw unavailable();
  const header = output.subarray(offset, newline).toString("ascii");
  const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) blob ([0-9]+)$/u.exec(header);
  if (!match || match[1] !== expected) throw unavailable();
  const size = Number(match[2]); const start = newline + 1;
  if (!Number.isSafeInteger(size) || size < 0 || start + size >= output.length || output[start + size] !== 0x0a) throw unavailable();
  return { bytes: Buffer.from(output.subarray(start, start + size)), next: start + size + 1 };
}

/** Capture a repeatable Git tree in an isolated index/object store. This is
 * adapted from bb's temporary-index technique but emits exact bounded bytes,
 * never patches, VCS credentials, or a mutable host path. */
export async function captureNativeDeliveryOutput(options: CaptureOptions): Promise<RemoteDeliveryResultCandidate> {
  const startedAt = Date.now();
  const logger = options.logger ?? createLogger({ name: "native-output-capture" });
  let temporary: string | undefined;
  try {
    const root = await checkedDirectory(options.cwd);
    if (!isAbsolute(options.gitExecutable) || !oidPattern.test(options.baselineCommit)) throw unavailable();
    await runGit(options.gitExecutable, root, ["cat-file", "-e", `${options.baselineCommit}^{commit}`]);
    const objectDirectory = await commonObjectDirectory(options.gitExecutable, root);
    temporary = await mkdtemp(join(dirname(root), ".output-capture-")); await chmod(temporary, 0o700);
    const temporaryObjects = join(temporary, "objects"); await mkdir(temporaryObjects, { mode: 0o700 });
    const env = { GIT_INDEX_FILE: join(temporary, "index"), GIT_OBJECT_DIRECTORY: temporaryObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory };
    const { entries, deletions } = await capturedChanges(options.gitExecutable, root, options.baselineCommit, env);
    const result = deliveryCandidate(options, entries, deletions);
    logger.info({ event: "native.output.capture_completed", correlationId: result.invocationRef, stage: "capture", outcome: "success",
      files: entries.length, bytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0), treeDigest: result.files.treeDigest,
      resultDigest: result.resultDigest, durationMs: Date.now() - startedAt }, "native delivery output capture completed");
    return result;
  } catch (error) {
    logger.warn({ event: "native.output.capture_failed", correlationId: options.invocationRef,
      assignmentId: options.binding.assignmentId, stage: "capture", outcome: "failed",
      errorClass: error instanceof Error ? error.name : "UnknownError", durationMs: Date.now() - startedAt },
      "native delivery output capture failed");
    throw unavailable();
  }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
}

interface CaptureOptions {
  cwd: string; gitExecutable: string; baselineCommit: string; binding: RemoteTransferBinding; claimId: string;
  invocationRef: string; inputSelectionDigest: string; baseRevision: string;
  logger?: Logger;
}

type CapturedEntry = { path: string; mode: 384 | 448; sizeBytes: number; digest: string; contentBase64: string };

/**
 * A linked worktree's absolute git-dir is only its administrative entry
 * (`<common>/worktrees/<id>`). Objects belong to the common directory.
 * Resolve that directory through Git, then independently verify it before
 * exposing it as the read-only alternate object store used for capture.
 */
async function commonObjectDirectory(gitExecutable: string, root: string): Promise<string> {
  const commonDirectory = await checkedDirectory((await runGit(gitExecutable, root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString("utf8").trim());
  return checkedDirectory(join(commonDirectory, "objects"));
}

/** The files written and deleted since the baseline, captured twice into the private index and required to agree. */
async function capturedChanges(gitExecutable: string, root: string, baselineCommit: string, env: NodeJS.ProcessEnv): Promise<{ entries: CapturedEntry[]; deletions: string[] }> {
  const first = await captureIndex(gitExecutable, root, baselineCommit, env);
  const second = await captureIndex(gitExecutable, root, baselineCommit, env);
  if (first !== second) throw unavailable();
  const deletions = decodePaths(await runGit(gitExecutable, root, ["diff", "--cached", "--diff-filter=D", "--name-only", "-z", "--no-renames", baselineCommit, "--"], env));
  const writes = decodePaths(await runGit(gitExecutable, root, ["diff", "--cached", "--diff-filter=ACMRTUXB", "--name-only", "-z", "--no-renames", baselineCommit, "--"], env));
  const tree = parseTree(await runGit(gitExecutable, root, ["ls-tree", "-rz", second], env));
  const selected = writes.map(path => ({ path, item: tree.get(path) }));
  if (selected.some(value => !value.item)) throw unavailable();
  const blobs = await readBlobs(gitExecutable, root, env, selected.map(value => value.item!.oid));
  const entries = selected.map((value, index) => {
    const bytes = blobs[index]!;
    return { path: value.path, mode: value.item!.mode, sizeBytes: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, contentBase64: bytes.toString("base64") };
  });
  checkOutputTreeLimits(entries);
  return { entries, deletions };
}

function deliveryCandidate(options: CaptureOptions, entries: CapturedEntry[], deletions: string[]): RemoteDeliveryResultCandidate {
  const files = RemoteFileTreeSchema.parse({ format: "konteks-file-tree-v1", entries, treeDigest: computeRemoteFileTreeDigest(entries) });
  const identity = { binding: options.binding, claimId: options.claimId, invocationRef: options.invocationRef,
    inputSelectionDigest: options.inputSelectionDigest, baseRevision: options.baseRevision, files, deletions };
  const body = { ...identity, resultId: `result-${createHash("sha256").update("konteks-native-output-id-v1\0").update(canonicalize(identity as never)).digest("hex")}` };
  return RemoteDeliveryResultCandidateSchema.parse({ ...body, resultDigest: computeRemoteDeliveryOutputDigest(body) });
}