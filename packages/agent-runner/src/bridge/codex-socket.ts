import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export type CodexSocketEntry =
  | { kind: "none" }
  /** A socket at the path, or reached through this user's link into a private directory of this user. */
  | { kind: "socket"; target: string; info: Pick<Stats, "mode" | "uid" | "dev" | "ino"> }
  /** This user's link whose socket is gone. */
  | { kind: "dangling" }
  | { kind: "foreign" };

/**
 * What is at the shared socket path. Codex 0.159 and later bind the socket
 * under a private per-user directory of their own (`/tmp/codex-daemon-<uid>/`)
 * and leave a symlink at the `--listen unix://PATH` they were given (RCA
 * 2026-10-01: the connector looked for a socket at PATH itself, never saw one,
 * and Codex never started on 0.10.3). A link counts only when this user owns
 * it and its socket sits, owned by this user, in a directory only this user
 * can enter; anything else is foreign and never touched.
 */
export async function resolveCodexSocket(socketPath: string, entry?: Pick<Stats, "mode" | "uid" | "dev" | "ino" | "isSocket" | "isSymbolicLink">): Promise<CodexSocketEntry> {
  const own = entry ?? await lstat(socketPath).catch(() => null);
  if (!own) return { kind: "none" };
  if (own.isSocket()) return { kind: "socket", target: socketPath, info: own };
  if (!own.isSymbolicLink() || own.uid !== process.getuid?.()) return { kind: "foreign" };
  const target = await realpath(socketPath).catch(() => null);
  if (!target) return { kind: "dangling" };
  const [info, directory] = await Promise.all([lstat(target).catch(() => null), lstat(dirname(target)).catch(() => null)]);
  if (!info?.isSocket() || info.uid !== process.getuid?.() || !directory?.isDirectory() || !privateOwner(directory)) return { kind: "foreign" };
  return { kind: "socket", target, info };
}

function privateOwner(info: { mode: number; uid: number }): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}
