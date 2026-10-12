import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { RemoteInstanceError, sha256Hex, isFsErrorWithCode } from "@konteks/remote-common";
import { privateWorkspaceDirectory, readWorkspaceControlFile } from "./workspace-storage.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const WorkspaceGitControlSchema = z.object({ gitDir: z.string().min(1), commonDir: z.string().min(1),
  pointerDigest: digest.nullable(), configDigest: digest }).strict();
export type WorkspaceGitControl = z.infer<typeof WorkspaceGitControlSchema>;
export type WorkspaceGitScope = { cwd: string; ownerRoot?: string; repositoryCacheRoot?: string | undefined };
const unavailable = () => new RemoteInstanceError("capability_unavailable", "The workspace's original Git control state is unavailable. Its checkout was kept.");

/** Capture paths and control bytes only inside connector-owned roots. No
 * source Git command runs before these boundaries have been verified. */
export async function inspectWorkspaceGitControl(scope: WorkspaceGitScope): Promise<WorkspaceGitControl> {
  const root = await realpath(scope.ownerRoot ?? scope.cwd);
  await privateWorkspaceDirectory(root);
  const roots = [root];
  if (scope.repositoryCacheRoot) {
    // Restored repositories contain their own Git control state. A fresh
    // runtime need not have fetched an object cache yet; absent caches grant
    // no path authority to a linked worktree or its common directory.
    const cache = await realpath(scope.repositoryCacheRoot).catch(error => {
      if (isFsErrorWithCode(error, "ENOENT")) return null;
      throw error;
    });
    if (cache) { await privateWorkspaceDirectory(cache); roots.push(cache); }
  }
  const cwd = await realpath(scope.cwd);
  assertInside(cwd, [root], true);
  const { gitDir, pointerDigest } = await inspectPointer(cwd, roots);
  const commonDir = await inspectCommonDirectory(gitDir, roots);
  const config = await requiredControlFile(join(commonDir, "config"));
  return WorkspaceGitControlSchema.parse({ gitDir, commonDir, pointerDigest,
    configDigest: `sha256:${sha256Hex(config)}` });
}

async function inspectPointer(cwd: string, roots: string[]) {
  const pointer = join(cwd, ".git");
  const info = await lstat(pointer);
  if (info.isSymbolicLink()) throw unavailable();
  const bytes = info.isDirectory() ? null : await requiredControlFile(pointer);
  const gitDir = await verifiedDirectory(bytes ? gitDirectoryPointer(bytes, cwd) : pointer, roots);
  return { gitDir, pointerDigest: bytes ? `sha256:${sha256Hex(bytes)}` : null };
}

async function inspectCommonDirectory(gitDir: string, roots: string[]): Promise<string> {
  const bytes = await readWorkspaceControlFile(join(gitDir, "commondir"));
  return bytes ? verifiedDirectory(resolve(gitDir, controlPath(bytes)), roots) : gitDir;
}

async function requiredControlFile(path: string): Promise<Buffer> {
  const bytes = await readWorkspaceControlFile(path);
  if (!bytes) throw unavailable();
  return bytes;
}

function controlPath(bytes: Buffer): string {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/u, "");
  if (!value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw unavailable();
  return value;
}

function gitDirectoryPointer(bytes: Buffer, cwd: string): string {
  const value = controlPath(bytes);
  if (!value.startsWith("gitdir: ")) throw unavailable();
  return resolve(cwd, value.slice(8));
}

function assertInside(path: string, roots: string[], allowRoot = false): void {
  if (!roots.some(root => inside(path, root, allowRoot))) throw unavailable();
}

function inside(path: string, root: string, allowRoot: boolean): boolean {
  const part = relative(root, path);
  return (Boolean(part) || allowRoot) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part);
}

async function verifiedDirectory(path: string, roots: string[]): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
  const canonical = await realpath(path);
  assertInside(canonical, roots);
  return canonical;
}
