import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RemoteInstanceError } from "@konteks/remote-common";
const unavailable = () => new RemoteInstanceError("recovery_required", "Private workspace recovery storage is unavailable.");

export async function privateWorkspaceDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw unavailable();
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
    if (!sameFile(info, actual)) throw unavailable();
    const bytes = await handle.readFile();
    if (!sameFile(info, await handle.stat()) || bytes.length !== info.size) throw unavailable();
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writePrivateWorkspaceJson(folder: string, path: string, value: unknown): Promise<void> {
  await privateWorkspaceDirectory(folder);
  const temporary = join(folder, `.pending-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    await syncDirectory(folder);
  } finally { await rm(temporary, { force: true }); }
}


function assertWorkspaceFile(info: Stats, maxBytes: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw unavailable();
}

function assertWorkspaceFileOwner(info: Stats, privateMode: boolean): void {
  if (process.platform === "win32") return;
  if (info.uid !== ownerUid() || (privateMode && (info.mode & 0o077) !== 0)) throw unavailable();
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function ownerUid(): number | undefined { return process.getuid?.(); }
