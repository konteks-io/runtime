import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isFsErrorWithCode, RemoteInstanceError } from "./errors.js";

/**
 * Restricted-mode secret files (adapted from bb `packages/secret-storage`).
 * Files are created `0600` with `wx` so a concurrent creator loses the race
 * cleanly, written through a temp file plus rename so a crash never leaves a
 * half-written key, and re-verified on every start.
 */
interface ReadOrCreateSecretFileArgs {
  bytes: number;
  dataDir: string;
  encoding: BufferEncoding;
  fileName: string;
}

export async function readOrCreateSecretFile(args: ReadOrCreateSecretFileArgs): Promise<string> {
  await mkdir(args.dataDir, { recursive: true, mode: 0o700 });
  const secretPath = join(args.dataDir, args.fileName);

  try {
    const existing = (await readFile(secretPath, "utf8")).trim();
    if (existing.length > 0) {
      await assertRestrictedMode(secretPath);
      return existing;
    }
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) throw error;
  }

  const generated = randomBytes(args.bytes).toString(args.encoding);
  try {
    await writeFile(secretPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!isFsErrorWithCode(error, "EEXIST")) throw error;
  }

  const raced = (await readFile(secretPath, "utf8")).trim();
  if (raced.length === 0) {
    throw new RemoteInstanceError("local_io_failure", "failed to initialize a secret file");
  }
  return raced;
}

export async function writeSecretFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const file = await open(tempPath, "wx", 0o600);
    try { await file.writeFile(value, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(tempPath, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function deleteSecretFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Verified on every start: a secret-bearing file that became group- or
 * world-readable is repaired when we own it and refused when we cannot.
 */
export async function assertRestrictedMode(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path);
  const mode = info.mode & 0o777;
  if (mode & 0o077) {
    try {
      await chmod(path, 0o600);
    } catch (error) {
      throw new RemoteInstanceError(
        "local_io_failure",
        `secret file has permissive mode ${mode.toString(8)} and could not be repaired`,
        { cause: error, recoveryActions: [{ kind: "run_doctor" }] },
      );
    }
  }
}

export async function readSecretFileIfPresent(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  }
}
