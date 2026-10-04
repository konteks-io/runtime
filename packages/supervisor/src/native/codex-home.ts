import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { plainAbsolutePath } from "./host-files.js";

/** Operator process configuration only. Never take a profile path from Core or ACP. */
export async function resolveNativeCodexHome(env: NodeJS.ProcessEnv = process.env, operatorHome = homedir()): Promise<string> {
  const path = env.CODEX_HOME ?? join(operatorHome, ".codex");
  const invalid = () => new RemoteInstanceError("prerequisite_missing", "Open your local Codex once, then restart the connector with the same user-owned CODEX_HOME. The profile must be an absolute, non-linked directory, not writable by other users.");
  if (!acceptablePath(path, operatorHome)) throw invalid();
  const canonical = await stablePrivateDirectory(path);
  if (canonical === null) throw invalid();
  return canonical;
}

/** The directory's real path when it is private and was not replaced while it was resolved; null otherwise. */
async function stablePrivateDirectory(path: string): Promise<string | null> {
  try {
    const before = await lstat(path);
    if (!privateDirectory(before)) return null;
    const canonical = await realpath(path);
    const after = await lstat(path);
    return after.isDirectory() && sameEntry(before, after) ? canonical : null;
  } catch {
    return null;
  }
}

/** An absolute path without control characters that is neither a filesystem root nor the home folder itself. */
function acceptablePath(path: string, operatorHome: string): boolean {
  return plainAbsolutePath(path) && resolve(path) !== parse(path).root && resolve(path) !== resolve(operatorHome);
}

/** A directory that, outside Windows, this user owns and nobody else can write. */
function privateDirectory(info: Stats): boolean {
  if (!info.isDirectory()) return false;
  return process.platform === "win32" || (info.uid === process.getuid?.() && (info.mode & 0o022) === 0);
}

/** The same directory entry, unchanged, on both reads. */
function sameEntry(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid;
}