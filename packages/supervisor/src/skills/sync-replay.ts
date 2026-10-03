import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RuntimeSkillSyncRequestSchema, runtimeSkillSyncRequestSigningBytes } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { isFsErrorWithCode, sha256Hex, writeSecretFile } from "@konteks/remote-common";
import { acquireNativeRootLock } from "../native/root-lock.js";
const LedgerSchema = z.object({
  version: z.literal(1), workspaceId: z.string().min(1).max(512), instanceId: z.string().min(1).max(512),
  requests: z.array(z.object({ id: z.string().min(1).max(512), digest: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime({ offset: true }) }).strict()).max(128),
}).strict();
const unavailable = () => new Error("Skill sync replay reservation is unavailable");
async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw unavailable();
}

/** Written before execution; an uncertain result never re-executes the same request. */
export async function reserveSkillSyncRequest(root: string, candidate: unknown, digest: string, now: number): Promise<boolean> {
  const request = RuntimeSkillSyncRequestSchema.parse(candidate);
  if (!Number.isFinite(now) || Date.parse(request.expiresAt) <= now || Date.parse(request.issuedAt) > now + 1000 || digest !== sha256Hex(runtimeSkillSyncRequestSigningBytes(request))) throw unavailable();
  await directory(root);
  const folder = join(root, "skill-sync-requests");
  await mkdir(folder, { recursive: true, mode: 0o700 }); await directory(folder);
  const lock = acquireNativeRootLock(folder), path = join(folder, "ledger.json");
  try {
    let ledger: z.infer<typeof LedgerSchema> = { version: 1, workspaceId: request.workspaceId, instanceId: request.instanceId, requests: [] };
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw unavailable();
      const bytes = Buffer.alloc(stat.size + 1); let count = 0;
      while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      if (count !== stat.size) throw unavailable();
      ledger = LedgerSchema.parse(JSON.parse(bytes.subarray(0, count).toString("utf8")));
    } catch (error) { if (!isFsErrorWithCode(error, "ENOENT")) throw error; }
    finally { await handle?.close(); }
    if (ledger.workspaceId !== request.workspaceId || ledger.instanceId !== request.instanceId) throw unavailable();
    const previous = ledger.requests.find(row => row.id === request.requestId);
    if (previous) { if (previous.digest !== digest) throw unavailable(); return false; }
    ledger.requests = ledger.requests.filter(row => Date.parse(row.expiresAt) > now);
    if (ledger.requests.length >= 128) throw unavailable();
    ledger.requests.push({ id: request.requestId, digest, expiresAt: request.expiresAt });
    const bytes = JSON.stringify(LedgerSchema.parse(ledger));
    if (Buffer.byteLength(bytes) > 65536) throw unavailable();
    lock.assertOwned(); await directory(root); await directory(folder);
    await writeSecretFile(path, bytes); lock.assertOwned();
    return true;
  } finally { lock.release(); }
}
