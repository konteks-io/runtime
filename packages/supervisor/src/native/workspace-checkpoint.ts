import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalize, RemoteInstanceError, RemoteTransferPathSchema,
  RemoteWorkspaceAnyCheckpointSchema, computeRemoteWorkspaceCheckpointDigest, REMOTE_WORKSPACE_CHECKPOINT_LIMITS, REMOTE_WORKSPACE_CHUNK_LIMITS,
  type RemoteWorkspaceCheckpoint, type RemoteWorkspaceCheckpointV2, type RemoteWorkspaceAnyCheckpoint,
} from "@konteks/remote-common";
import { inspectWorkspaceGitControl, type WorkspaceGitControl, type WorkspaceGitScope } from "./workspace-git-control.js";
import { verifyNativeGitTool, type NativeGitTool } from "./git-workspace.js";

import { readCheckpointBytes, writeCheckpointBytes, workspaceFileUnchanged as unchanged, type WorkspaceChunkCapture, type WorkspaceChunkRead } from "./workspace-checkpoint-bytes.js";

const unavailable = () => new RemoteInstanceError("capability_unavailable", "The unfinished workspace could not be preserved or verified. The original workspace was kept.");
type Entry = RemoteWorkspaceAnyCheckpoint["entries"][number];
type Bytes = RemoteWorkspaceAnyCheckpoint["index"];
type Git = (cwd: string, args: string[], input?: Buffer | string) => Promise<Buffer>;

function gitRunner(tool: NativeGitTool): Git {
  const deadline = Date.now() + 120_000;
  const env = { PATH: dirname(tool.executable), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Konteks recovery checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@invalid",
    GIT_COMMITTER_NAME: "Konteks recovery checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@invalid",
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  return (cwd, args, input) => new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(unavailable()); return; }
    const child = execFile(tool.executable, ["-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fsmonitor=false", "--no-pager", ...args],
      { cwd, env, timeout: Math.min(30_000, remaining), maxBuffer: REMOTE_WORKSPACE_CHECKPOINT_LIMITS.bytes, encoding: "buffer", windowsHide: true },
      (error, output) => error ? reject(unavailable()) : resolve(output));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

async function directory(value: string): Promise<Stats> {
  const stat = await lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return stat;
}

function readOnlyNoFollow(): number { return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0); }

async function readStable(path: string, observed?: Stats): Promise<Buffer> {
  const before = observed ?? await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > REMOTE_WORKSPACE_CHECKPOINT_LIMITS.bytes) throw unavailable();
  const handle = await open(path, readOnlyNoFollow());
  try {
    if (!unchanged(before, await handle.stat())) throw unavailable();
    const value = await handle.readFile();
    if (!unchanged(before, await handle.stat()) || value.length !== before.size) throw unavailable();
    return value;
  } finally { await handle.close(); }
}

function checkSize(count: number, size: number, chunks?: WorkspaceChunkCapture): void {
  const limits = chunks ? REMOTE_WORKSPACE_CHUNK_LIMITS : REMOTE_WORKSPACE_CHECKPOINT_LIMITS;
  if (count > limits.files || size > limits.bytes) throw unavailable();
}

/** Reads links as links, all ignored files and empty directories; never follows a link. */
async function workingFiles(root: string, folder: string, entries: Entry[], chunks?: WorkspaceChunkCapture, budget = { bytes: 0 }): Promise<Entry[]> {
  const before = await directory(folder);
  for (const name of (await readdir(folder)).sort()) {
    if (folder === root && name === ".git") continue;
    const path = relative(root, join(folder, name)).split("\\").join("/");
    RemoteTransferPathSchema.parse(path);
    if (path.split("/").some(part => /^\.git(?:$|[ .~])/i.test(part))) throw unavailable();
    await addWorkingEntry(root, join(folder, name), path, entries, chunks, budget);
    checkSize(entries.length, budget.bytes, chunks);
  }
  if (!unchanged(before, await lstat(folder))) throw unavailable();
  return entries;
}

async function addWorkingEntry(root: string, absolute: string, path: string, entries: Entry[], chunks: WorkspaceChunkCapture | undefined, budget: { bytes: number }): Promise<void> {
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) { entries.push({ path, kind: "symlink", target: await readlink(absolute) }); return; }
  const mode = stat.mode & 0o777;
  if (stat.isDirectory()) {
    entries.push({ path, kind: "directory", mode });
    await workingFiles(root, absolute, entries, chunks, budget);
    return;
  }
  checkSize(entries.length + 1, budget.bytes + stat.size, chunks);
  const data = await readCheckpointBytes(absolute, stat, chunks);
  entries.push({ path, kind: "file", mode, ...data }); budget.bytes += data.sizeBytes;
}

function ascii(value: Buffer): string { return value.toString("utf8").trim(); }

async function gitState(git: Git, cwd: string, linked = false, chunks?: WorkspaceChunkCapture) {
  const headCommit = ascii(await git(cwd, ["rev-parse", "HEAD"]));
  const refValue = ascii(await git(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]));
  const allRefs = ascii(await git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"])).split("\n").filter(Boolean)
    .map(row => { const [name, oid] = row.split(" "); return { name: name!, oid: oid! }; });
  const refs = linked ? allRefs.filter(ref => ref.name === refValue) : allRefs;
  const indexPath = ascii(await git(cwd, ["rev-parse", "--git-path", "index"]));
  const index = await readCheckpointBytes(isAbsolute(indexPath) ? indexPath : join(cwd, indexPath), undefined, chunks);
  const indexEntries = await git(cwd, ["ls-files", "--stage", "-z"]);
  validateIndex(indexEntries);
  return { headCommit, headRef: refValue === "HEAD" ? null : refValue, refs, index, indexEntries };
}

function validateIndex(value: Buffer): void {
  const rows = new TextDecoder("utf-8", { fatal: true }).decode(value).split("\0").filter(Boolean);
  for (const row of rows) {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}) [0-3]\t(.+)$/u.exec(row);
    if (!match) throw unavailable();
    RemoteTransferPathSchema.parse(match[3]);
    if (match[3]!.split("/").some(part => /^\.git(?:$|[ .~])/i.test(part))) throw unavailable();
  }
}

/** A private bare repository with read-only access to source objects. No source refs, index or objects are changed. */
async function bundle(git: Git, cwd: string, temporary: string, state: Awaited<ReturnType<typeof gitState>>, baselineCommit: string, chunks?: WorkspaceChunkCapture): Promise<Bytes> {
  const bare = join(temporary, "git");
  await git(temporary, ["init", "--bare", "--template=", bare]);
  const objectPath = ascii(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]));
  await writePrivate(join(bare, "objects", "info", "alternates"), Buffer.from(objectPath + "\n"));
  for (const ref of state.refs) await git(bare, ["update-ref", ref.name, ref.oid]);
  await git(bare, ["update-ref", "--no-deref", "HEAD", state.headCommit]);
  await retainIndexObjects(git, bare, state.indexEntries, state.headCommit, baselineCommit);
  const path = join(temporary, "checkpoint.bundle");
  await git(bare, ["bundle", "create", path, "--all"]);
  return readCheckpointBytes(path, undefined, chunks);
}

async function retainIndexObjects(git: Git, bare: string, index: Buffer, head: string, baseline: string): Promise<void> {
  const objects = [...new Set(index.toString("utf8").split("\0").filter(Boolean).map(row => row.split(" ")[1]!))];
  const treeInput = objects.map((oid, n) => `100644 blob ${oid}\t${n}\n`).join("");
  const tree = ascii(await git(bare, ["mktree"], treeInput));
  const parents = [...new Set([head, baseline])].flatMap(value => ["-p", value]);
  const commit = ascii(await git(bare, ["commit-tree", tree, ...parents], "Unfinished workspace recovery objects\n"));
  await git(bare, ["update-ref", `refs/konteks-recovery/${randomUUID()}`, commit]);
}

/** Retention after the owning process stops. A snapshot does not establish
 * external tool quiescence or authorize a runtime handoff. */
type CaptureOptions = WorkspaceGitScope & { tool: NativeGitTool; baselineCommit: string; expectedControl?: WorkspaceGitControl };
export function captureWorkspaceCheckpoint(options: CaptureOptions & { chunks: WorkspaceChunkCapture }): Promise<RemoteWorkspaceCheckpointV2>;
export function captureWorkspaceCheckpoint(options: CaptureOptions & { chunks?: undefined }): Promise<RemoteWorkspaceCheckpoint>;
export async function captureWorkspaceCheckpoint(options: CaptureOptions & { chunks?: WorkspaceChunkCapture | undefined }): Promise<RemoteWorkspaceAnyCheckpoint> {
  const tool = await verifyNativeGitTool(options.tool);
  await directory(options.cwd);
  const root = await realpath(options.cwd);
  if (!isAbsolute(options.cwd)) throw unavailable();
  const before = await directory(root);
  const control = await inspectWorkspaceGitControl(options);
  assertGitControl(control, options.expectedControl);
  const run = gitRunner(tool);
  const git: Git = (cwd, args, input) => run(cwd, cwd === root ? ["--git-dir", control.gitDir, "--work-tree", root, ...args] : args, input);
  const linked = control.gitDir !== control.commonDir;
  await assertSupportedGitMetadata(control);
  await git(root, ["cat-file", "-e", `${options.baselineCommit}^{commit}`]);
  const state = await gitState(git, root, linked, options.chunks);
  const entries = await workingFiles(root, root, [], options.chunks);
  const temporary = await mkdtemp(join(dirname(root), ".workspace-checkpoint-"));
  await chmod(temporary, 0o700);
  try {
    const packed = await bundle(git, root, temporary, state, options.baselineCommit, options.chunks);
    assertGitControl(await inspectWorkspaceGitControl(options), control);
    await assertSupportedGitMetadata(control);
    const current = await gitState(git, root, linked, options.chunks);
    if (!sameGitState(state, current) ||
        canonicalize(entries as never) !== canonicalize(await workingFiles(root, root, [], options.chunks) as never) || !unchanged(before, await lstat(root))) throw unavailable();
    const { indexEntries: _entries, ...metadata } = state;
    const body = { format: options.chunks ? "konteks-workspace-checkpoint-v2" as const : "konteks-workspace-checkpoint-v1" as const, baselineCommit: options.baselineCommit, ...metadata, bundle: packed, entries };
    return RemoteWorkspaceAnyCheckpointSchema.parse({ ...body, checkpointDigest: computeRemoteWorkspaceCheckpointDigest(body) });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function sameGitState(left: Awaited<ReturnType<typeof gitState>>, right: Awaited<ReturnType<typeof gitState>>): boolean {
  const { indexEntries: before, ...leftMetadata } = left;
  const { indexEntries: after, ...rightMetadata } = right;
  return before.equals(after) && canonicalize(leftMetadata as never) === canonicalize(rightMetadata as never);
}

async function writePrivate(path: string, value: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}

async function restoreGit(git: Git, cwd: string, checkpoint: RemoteWorkspaceAnyCheckpoint, chunks?: WorkspaceChunkRead): Promise<void> {
  await git(cwd, ["init", "--template=", "--quiet"]);
  await chmod(join(cwd, ".git"), 0o700);
  const bundlePath = join(cwd, ".git", "recovery.bundle");
  await writeCheckpointBytes(bundlePath, checkpoint.bundle, chunks);
  await git(cwd, ["bundle", "verify", bundlePath]);
  await git(cwd, ["-c", "protocol.file.allow=always", "fetch", "--update-head-ok", "--no-tags", bundlePath, "+refs/*:refs/*"]);
  const expected = new Set(checkpoint.refs.map(ref => ref.name));
  const actual = ascii(await git(cwd, ["for-each-ref", "--format=%(refname)"])).split("\n").filter(Boolean);
  for (const ref of actual) if (!expected.has(ref)) await git(cwd, ["update-ref", "-d", ref]);
  for (const ref of checkpoint.refs) await git(cwd, ["update-ref", ref.name, ref.oid]);
  await restoreHead(git, cwd, checkpoint);
  await writeCheckpointBytes(join(cwd, ".git", "index"), checkpoint.index, chunks);
  validateIndex(await git(cwd, ["ls-files", "--stage", "-z"]));
  await git(cwd, ["cat-file", "-e", `${checkpoint.baselineCommit}^{commit}`]);
  await mkdir(join(cwd, ".git", "hooks-disabled"), { mode: 0o700 });
  await git(cwd, ["config", "core.hooksPath", ".git/hooks-disabled"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await git(cwd, ["config", "core.fsmonitor", "false"]);
  await rm(bundlePath);
}

async function restoreHead(git: Git, cwd: string, checkpoint: RemoteWorkspaceAnyCheckpoint): Promise<void> {
  if (checkpoint.headRef) await git(cwd, ["symbolic-ref", "HEAD", checkpoint.headRef]);
  else await git(cwd, ["update-ref", "--no-deref", "HEAD", checkpoint.headCommit]);
  if (ascii(await git(cwd, ["rev-parse", "HEAD"])) !== checkpoint.headCommit) throw unavailable();
}

async function restoreFiles(cwd: string, entries: Entry[], chunks?: WorkspaceChunkRead): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === "symlink") continue;
    const path = join(cwd, entry.path);
    if (entry.kind === "directory") await mkdir(path, { recursive: true, mode: 0o700 });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeCheckpointBytes(path, entry, chunks);
      await chmod(path, entry.mode);
    }
  }
  for (const entry of entries) if (entry.kind === "symlink") {
    await mkdir(dirname(join(cwd, entry.path)), { recursive: true, mode: 0o700 });
    await symlink(entry.target, join(cwd, entry.path));
  }
  for (const entry of [...entries].reverse()) if (entry.kind === "directory") await chmod(join(cwd, entry.path), entry.mode);
}

/** Exact verification before the new runtime acknowledges or receives write access. */
export async function verifyRestoredWorkspaceCheckpoint(options: { cwd: string; tool: NativeGitTool; checkpoint: RemoteWorkspaceAnyCheckpoint }): Promise<void> {
  const tool = await verifyNativeGitTool(options.tool);
  const git = gitRunner(tool);
  const capture = options.checkpoint.format === "konteks-workspace-checkpoint-v2" ? {} : undefined;
  const state = await gitState(git, options.cwd, false, capture);
  const { checkpoint } = options;
  const actual = { headCommit: state.headCommit, headRef: state.headRef, refs: state.refs, index: state.index };
  const expected = { headCommit: checkpoint.headCommit, headRef: checkpoint.headRef, refs: checkpoint.refs, index: checkpoint.index };
  if (canonicalize(actual as never) !== canonicalize(expected as never) ||
      canonicalize(await workingFiles(options.cwd, options.cwd, [], capture) as never) !== canonicalize(checkpoint.entries as never)) throw unavailable();
  await git(options.cwd, ["fsck", "--full", "--strict", "--no-reflogs"]);
}

/** Reserves a new private container, verifies all bytes, then publishes its source directory. Never overwrites an existing workspace. */
export async function restoreWorkspaceCheckpoint(options: { destination: string; tool: NativeGitTool; checkpoint: unknown; chunks?: WorkspaceChunkRead }): Promise<{ cwd: string; baselineCommit: string }> {
  const checkpoint = RemoteWorkspaceAnyCheckpointSchema.parse(options.checkpoint);
  const tool = await verifyNativeGitTool(options.tool);
  if (!isAbsolute(options.destination)) throw unavailable();
  await directory(dirname(options.destination));
  const destination = join(await realpath(dirname(options.destination)), basename(options.destination));
  const parent = await directory(dirname(destination));
  assertPrivateParent(parent);
  await mkdir(destination, { mode: 0o700 });
  const owner = await directory(destination);
  const temporary = await mkdtemp(join(destination, ".restore-"));
  await chmod(temporary, 0o700);
  try {
    await restoreGit(gitRunner(tool), temporary, checkpoint, options.chunks);
    await restoreFiles(temporary, checkpoint.entries, options.chunks);
    const files = await workingFiles(temporary, temporary, [], checkpoint.format === "konteks-workspace-checkpoint-v2" ? {} : undefined);
    if (canonicalize(files as never) !== canonicalize(checkpoint.entries as never)) throw unavailable();
    await writePrivate(join(temporary, ".git", "konteks-checkpoint.json"), Buffer.from(JSON.stringify({ version: 1, checkpointDigest: checkpoint.checkpointDigest, baselineCommit: checkpoint.baselineCommit })));
    await syncRestoredTree(temporary);
    const cwd = join(destination, "source");
    await rename(temporary, cwd);
    await syncRestoredDirectory(destination);
    await syncRestoredDirectory(dirname(destination));
    return { cwd, baselineCommit: checkpoint.baselineCommit };
  } catch (error) {
    const current = await lstat(destination);
    if (sameOwnedDirectory(owner, current)) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function assertPrivateParent(parent: Stats): void {
  if (process.platform !== "win32" && (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)) throw unavailable();
}

function sameOwnedDirectory(owner: Stats, current: Stats): boolean {
  return current.ino === owner.ino && current.dev === owner.dev && current.isDirectory() && !current.isSymbolicLink();
}

/** Checkpoints retain ordinary refs/index/worktree state. Operation journals
 * and split indexes need a different format; never silently omit their work. */
async function assertSupportedGitMetadata(control: WorkspaceGitControl): Promise<void> {
  for (const folder of new Set([control.gitDir, control.commonDir])) {
    await directory(folder);
    const names = await readdir(folder);
    if (names.some(name => /^(?:MERGE_|AUTO_MERGE$|CHERRY_PICK_HEAD$|REVERT_HEAD$|REBASE_HEAD$|SQUASH_MSG$|rebase-|sequencer$|sharedindex\.|shallow$)/u.test(name))) throw unavailable();
    await assertDefaultGitInfo(folder);
  }
}

function assertGitControl(actual: WorkspaceGitControl, expected?: WorkspaceGitControl): void {
  if (expected && canonicalize(actual as never) !== canonicalize(expected as never)) throw unavailable();
}

async function assertDefaultGitInfo(folder: string): Promise<void> {
  const info = join(folder, "info");
  let names: string[];
  try { names = await readdir(info); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.some(name => name !== "exclude")) throw unavailable();
  if (!names.includes("exclude")) return;
  const lines = (await readStable(join(info, "exclude"))).toString("utf8").split("\n");
  if (lines.some(line => line.trim() !== "" && !line.trim().startsWith("#"))) throw unavailable();
}

async function syncRestoredTree(folder: string): Promise<void> {
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await syncRestoredTree(path);
    else { const handle = await open(path, readOnlyNoFollow()); try { await handle.sync(); } finally { await handle.close(); } }
  }
  await syncRestoredDirectory(folder);
}

async function syncRestoredDirectory(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(folder, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
