import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeSecretFile } from "@konteks/remote-common";

const iso = z.string().datetime({ offset: true });
export const NativeUpdateAttemptSchema = z.object({
  id: z.string().min(1).max(128),
  bundleVersion: z.string().min(1).max(128),
  manifestDigest: z.string().min(1).max(128),
  releaseId: z.string().min(1).max(128).nullable(),
  reason: z.string().min(1).max(64),
  startedAt: iso,
  finishedAt: iso.nullable(),
  /** `in_progress` is a live transaction; every other outcome is terminal for that attempt. */
  outcome: z.enum(["in_progress", "applied", "rolled_back", "failed"]),
  detail: z.string().max(1_024).nullable(),
}).strict();
export type NativeUpdateAttempt = z.infer<typeof NativeUpdateAttemptSchema>;

/**
 * Durable memory of update attempts, written by the launcher transaction and
 * read by the supervisor before launching another. It survives the process
 * restart every update implies, so a release that keeps rolling back is
 * retried a bounded number of times instead of forever.
 */
export const NativeUpdateLedgerSchema = z.object({ schemaVersion: z.literal(1), attempts: z.array(NativeUpdateAttemptSchema).max(50) }).strict();
export type NativeUpdateLedger = z.infer<typeof NativeUpdateLedgerSchema>;

export const NATIVE_UPDATE_LEDGER_FILE = "update-ledger.json";
const MAX_ATTEMPTS = 50;

export async function readNativeUpdateLedger(root: string): Promise<NativeUpdateLedger> {
  const path = join(resolve(root), NATIVE_UPDATE_LEDGER_FILE);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return { schemaVersion: 1, attempts: [] };
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("native update ledger is not a readable file");
  return NativeUpdateLedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Upsert one attempt by id; the ledger keeps the most recent attempts only. */
export async function recordNativeUpdateAttempt(root: string, attempt: NativeUpdateAttempt): Promise<NativeUpdateLedger> {
  const ledger = await readNativeUpdateLedger(root);
  const attempts = ledger.attempts.filter(existing => existing.id !== attempt.id);
  attempts.push(NativeUpdateAttemptSchema.parse(attempt));
  const next = NativeUpdateLedgerSchema.parse({ schemaVersion: 1, attempts: attempts.slice(-MAX_ATTEMPTS) });
  await writeSecretFile(join(resolve(root), NATIVE_UPDATE_LEDGER_FILE), JSON.stringify(next));
  return next;
}
