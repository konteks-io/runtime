import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isFsErrorWithCode, RemoteInstanceError } from "@konteks/remote-common";

export const NATIVE_ROOT_LOCK_FILE = "connector-owner.sqlite";
export interface NativeRootLock {
  assertOwned(): void;
  release(): void;
}

/**
 * Unlike bb's time-expiring lock/reacquire loop, a kernel-backed exclusive
 * transaction survives sleep or SIGSTOP and is released on process death.
 * This file contains no domain data, credentials or ownership TTL. Never unlink
 * it during normal release: all contenders must lock the same inode.
 */
export function acquireNativeRootLock(dataDir: string, options: { onLost?: () => void; checkIntervalMs?: number } = {}): NativeRootLock {
  if (!isAbsolute(dataDir)) throw new RemoteInstanceError("install_state_corrupt", "Native state requires an absolute private directory.");
  let sqlite: typeof import("node:sqlite");
  try { sqlite = loadSqlite(); }
  catch { throw new RemoteInstanceError("prerequisite_missing", "Native ownership requires the bundled Node runtime with SQLite support."); }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dataDir);
  if (!directory.isDirectory() || !restricted(directory)) throw unsafe();
  const canonicalRoot = realpathSync(dataDir);
  const path = join(canonicalRoot, NATIVE_ROOT_LOCK_FILE);
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if (!isFsErrorWithCode(error, "EEXIST")) throw unsafe(); }
  const original = lstatSync(path);
  if (!original.isFile() || original.nlink !== 1 || !restricted(original) || original.size > 65_536) throw unsafe();
  let db: DatabaseSync | undefined;
  try {
    // Loaded only for native mode. Distribution must supply the tested Node
    // runtime with node:sqlite; an unavailable module is a preflight failure.
    db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    db?.close();
    if (typeof error === "object" && error !== null && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) {
      throw new RemoteInstanceError("temporarily_unavailable", "Another connector owns this native data directory.");
    }
    throw unsafe();
  }
  let released = false;
  let lost = false;
  let timer: NodeJS.Timeout | null = null;
  const assertOwned = (): void => {
    if (released || lost) throw unsafe();
    try {
      const current = lstatSync(path);
      const root = lstatSync(canonicalRoot);
      if (!current.isFile() || current.ino !== original.ino || current.dev !== original.dev || current.nlink !== 1 || !restricted(current) || !root.isDirectory() || root.ino !== directory.ino || root.dev !== directory.dev || !restricted(root)) throw unsafe();
    } catch {
      lost = true;
      if (timer) clearInterval(timer);
      options.onLost?.();
      throw unsafe();
    }
  };
  try { assertOwned(); }
  catch (error) { db.close(); throw error; }
  timer = setInterval(() => { try { assertOwned(); } catch { /* The owner is notified once; never reacquire. */ } }, options.checkIntervalMs ?? 1_000);
  timer.unref();
  return {
    assertOwned,
    release() {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      db.close();
    },
  };
}

function restricted(stat: Stats): boolean {
  return process.platform === "win32" || ((Number(stat.mode) & 0o077) === 0 && Number(stat.uid) === process.getuid?.());
}
function unsafe(): RemoteInstanceError {
  return new RemoteInstanceError("install_state_corrupt", "Native state ownership is unavailable or unsafe; stop the connector and check its private data directory and supported runtime.");
}

/**
 * `process.getBuiltinModule` resolves builtins the same way in ESM, in the
 * bundled CommonJS of the single-executable connector and under vitest;
 * `createRequire(import.meta.url)` has no URL inside that executable, which
 * once made every native command fail with prerequisite_missing.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const builtin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite");
  if (builtin) return builtin as typeof import("node:sqlite");
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}
