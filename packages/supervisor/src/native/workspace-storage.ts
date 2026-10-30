import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NamedRefusal } from "./named-refusal.js";
const unavailable = (diagnostic: string) => new NamedRefusal("recovery_required", "Private workspace recovery storage is unavailable.", diagnostic);

export async function privateWorkspaceDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("storage_not_directory");
  if (process.platform === "win32") return;
  if (stat.uid !== process.getuid?.()) throw unavailable("storage_not_owned");
  if ((stat.mode & 0o077) !== 0) throw unavailable("storage_not_private");
}

export function readPrivateWorkspaceFile(path: string, maxBytes: number): Promise<Buffer | null> {
  return readWorkspaceFile(path, maxBytes, true);
}

export function readWorkspaceControlFile(path: string): Promise<Buffer | null> {
  return readWorkspaceFile(path, 16 * 1024, false);
}

async function readWorkspaceFile(path: string, maxBytes: number, privateMode: boolean): Promise<Buffer | null> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  assertWorkspaceFile(info, maxBytes);
  assertWorkspaceFileOwner(info, privateMode);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!sameFile(info, actual)) throw unavailable("storage_file_changed");
    const bytes = await handle.readFile();
    if (!sameFile(info, await handle.stat()) || bytes.length !== info.size) throw unavailable("storage_file_changed");
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export function writePrivateWorkspaceJson(folder: string, path: string, value: unknown): Promise<void> {
  return writePrivateWorkspaceBytes(folder, path, Buffer.from(JSON.stringify(value)));
}

export async function writePrivateWorkspaceBytes(folder: string, path: string, value: Buffer): Promise<void> {
  await privateWorkspaceDirectory(folder);
  const temporary = join(folder, `.pending-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    await syncDirectory(folder);
  } finally { await rm(temporary, { force: true }); }
}


function assertWorkspaceFile(info: Stats, maxBytes: number): void {
  if (!info.isFile() || info.isSymbolicLink()) throw unavailable("storage_not_a_file");
  if (info.nlink !== 1) throw unavailable("storage_file_hardlinked");
  if (info.size > maxBytes) throw unavailable("storage_file_too_large");
}

function assertWorkspaceFileOwner(info: Stats, privateMode: boolean): void {
  if (process.platform === "win32") return;
  if (info.uid !== ownerUid()) throw unavailable("storage_file_not_owned");
  if (privateMode && (info.mode & 0o077) !== 0) throw unavailable("storage_file_not_private");
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function ownerUid(): number | undefined { return process.getuid?.(); }
