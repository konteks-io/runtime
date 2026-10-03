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
  const sqlite = sqliteModule();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dataDir);
  if (!directory.isDirectory() || !restricted(directory)) throw unsafe();
  const canonicalRoot = realpathSync(dataDir);
  const path = join(canonicalRoot, NATIVE_ROOT_LOCK_FILE);
  const original = lockFile(path);
  const db = exclusiveTransaction(sqlite, path);
  return new HeldRootLock({ path, original, canonicalRoot, directory, db }, options).start();
}

function sqliteModule(): typeof import("node:sqlite") {
  try {
    return loadSqlite();
  } catch {
    throw new RemoteInstanceError("prerequisite_missing", "Native ownership requires the bundled Node runtime with SQLite support.");
  }
}

/** The lock file, created once and never replaced: a single private link of bounded size. */
function lockFile(path: string): Stats {
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if (!isFsErrorWithCode(error, "EEXIST")) throw unsafe(); }
  const original = lstatSync(path);
  if (!original.isFile() || original.nlink !== 1 || !restricted(original) || original.size > 65_536) throw unsafe();
  return original;
}

/**
 * Loaded only for native mode. Distribution must supply the tested Node
 * runtime with node:sqlite; an unavailable module is a preflight failure.
 */
function exclusiveTransaction(sqlite: typeof import("node:sqlite"), path: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
    return db;
  } catch (error) {
    db?.close();
    if (sqliteBusy(error)) throw new RemoteInstanceError("temporarily_unavailable", "Another connector owns this native data directory.");
    throw unsafe();
  }
}

/** SQLITE_BUSY or SQLITE_LOCKED: another process holds the exclusive transaction. */
function sqliteBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errcode" in error && (error.errcode === 5 || error.errcode === 6);
}

interface HeldLock {
  path: string;
  original: Stats;
  canonicalRoot: string;
  directory: Stats;
  db: DatabaseSync;
}

/** An acquired lock, checked every interval; once lost it is never reacquired. */
class HeldRootLock {
  private released = false;
  private lost = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly held: HeldLock, private readonly options: { onLost?: () => void; checkIntervalMs?: number }) {}

  start(): NativeRootLock {
    try { this.assertOwned(); }
    catch (error) { this.held.db.close(); throw error; }
    this.timer = setInterval(() => { try { this.assertOwned(); } catch { /* The owner is notified once; never reacquire. */ } }, this.options.checkIntervalMs ?? 1_000);
    this.timer.unref();
    return { assertOwned: () => this.assertOwned(), release: () => this.release() };
  }

  private assertOwned(): void {
    if (this.released || this.lost) throw unsafe();
    try {
      if (!this.stillHeld()) throw unsafe();
    } catch {
      this.lost = true;
      if (this.timer) clearInterval(this.timer);
      this.options.onLost?.();
      throw unsafe();
    }
  }

  /** The same private lock file in the same private root directory. */
  private stillHeld(): boolean {
    const current = lstatSync(this.held.path);
    const root = lstatSync(this.held.canonicalRoot);
    const { original, directory } = this.held;
    return current.isFile() && sameEntry(current, original) && current.nlink === 1 && restricted(current) &&
      root.isDirectory() && sameEntry(root, directory) && restricted(root);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    this.held.db.close();
  }
}

function sameEntry(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
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

/** Whether an error is this lock refusing because another connector holds the data directory. */
export function ownedByAnotherConnector(error: unknown): boolean {
  return error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" && /owns this native data directory/.test(error.message);
}
