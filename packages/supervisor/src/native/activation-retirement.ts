import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isFsErrorWithCode, RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { NATIVE_ROOT_LOCK_FILE } from "./root-lock.js";

const MARKER = "activation-retirement.json";
const ARCHIVES = "retired-enrollments";
const Name = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).refine(value => value !== "." && value !== "..");
const RetirementSchema = z.object({
  state: z.enum(["archiving", "ready"]), previousActivationId: z.string().min(1).max(256),
  activationId: z.string().min(1).max(256), archiveId: z.string().uuid(),
  keyDigest: z.string().min(1).max(128), entries: z.array(Name).max(128),
}).strict();
type Retirement = z.infer<typeof RetirementSchema>;
type Owner = { assertOwned(): void };

/** Resume the same confirmed retirement after interruption; no remote authority is inferred. */
export async function resumeActivationRetirement(root: string, activationId: string, owner: Owner): Promise<Retirement | null> {
  owner.assertOwned();
  const marker = await readRetirement(root);
  if (!marker) return null;
  if (marker.activationId !== activationId) throw refused("Retry the same replacement command to finish preserving the previous installation.");
  return finishArchive(root, marker, owner);
}

/** Called only after Core fenced the old attempt and the local journal proved it never executed. */
export async function archiveRetiredActivation(root: string, input: { previousActivationId: string; activationId: string; keyDigest: string }, owner: Owner): Promise<void> {
  owner.assertOwned();
  if (await readRetirement(root)) throw refused("An earlier enrollment retirement must finish first.");
  const entries = (await readdir(root)).filter(name => !administrativeEntry(name)).sort();
  const marker = RetirementSchema.parse({ ...input, state: "archiving", archiveId: randomUUID(), entries });
  await checkedDirectory(join(root, ARCHIVES));
  await mkdir(join(root, ARCHIVES, marker.archiveId), { mode: 0o700 });
  await writeSecretFile(join(root, MARKER), JSON.stringify(marker));
  await finishArchive(root, marker, owner);
}

/** The new seed is durable before the transient marker is removed; the archive keeps its receipt. */
export async function completeActivationRetirement(root: string, enrollment: { activationId: string; keyDigest: string }, owner: Owner): Promise<void> {
  const marker = await readRetirement(root);
  if (!marker) return;
  owner.assertOwned();
  if (marker.state !== "ready" || marker.activationId !== enrollment.activationId || marker.keyDigest === enrollment.keyDigest) throw refused("The replacement enrollment is not confirmed.");
  await rm(join(root, MARKER));
}

function administrativeEntry(name: string): boolean {
  return name.startsWith(NATIVE_ROOT_LOCK_FILE) || name === MARKER || name === ARCHIVES;
}

async function readRetirement(root: string): Promise<Retirement | null> {
  return readRetirementFile(join(root, MARKER));
}

async function readRetirementFile(path: string): Promise<Retirement | null> {
  const info = await lstat(path).catch(error => { if (isFsErrorWithCode(error, "ENOENT")) return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1 || info.size > 65_536) throw refused("The enrollment retirement record is unsafe.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw refused("The enrollment retirement record is not private.");
  return RetirementSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function finishArchive(root: string, marker: Retirement, owner: Owner): Promise<Retirement> {
  owner.assertOwned();
  if (marker.state === "ready") { await verifyArchive(root, marker); return marker; }
  await checkedDirectory(join(root, ARCHIVES));
  const archive = join(root, ARCHIVES, marker.archiveId);
  await checkedDirectory(archive);
  const data = join(archive, "data");
  await checkedDirectory(data);
  for (const name of marker.entries) {
    if (administrativeEntry(name)) throw refused("The retirement record names protected administration data.");
    owner.assertOwned();
    await moveEntry(join(root, name), join(data, name));
  }
  owner.assertOwned();
  const ready: Retirement = { ...marker, state: "ready" };
  await writeSecretFile(join(archive, "retirement.json"), JSON.stringify(ready));
  await writeSecretFile(join(root, MARKER), JSON.stringify(ready));
  return ready;
}

async function verifyArchive(root: string, marker: Retirement): Promise<void> {
  const archive = join(root, ARCHIVES, marker.archiveId);
  for (const path of [join(root, ARCHIVES), archive]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused("The previous enrollment archive is unavailable.");
  }
  const receipt = await readRetirementFile(join(archive, "retirement.json"));
  if (JSON.stringify(receipt) !== JSON.stringify(marker)) throw refused("The previous enrollment archive receipt changed.");
  for (const name of marker.entries) {
    const info = await lstat(join(archive, "data", name));
    if (info.isSymbolicLink()) throw refused("The previous enrollment archive was redirected.");
  }
}

async function checkedDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (!isFsErrorWithCode(error, "EEXIST")) throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw refused("The enrollment archive was redirected.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw refused("The enrollment archive is not private.");
}

async function moveEntry(source: string, target: string): Promise<void> {
  const before = await entry(source); const after = await entry(target);
  if (Boolean(before) === Boolean(after)) throw refused("The previous enrollment archive could not be confirmed.");
  if (after?.isSymbolicLink()) throw refused("The previous enrollment archive was redirected.");
  if (!before) return;
  if (before.isSymbolicLink()) throw refused("The previous enrollment contains a redirected entry.");
  await rename(source, target);
}

function entry(path: string) {
  return lstat(path).catch(error => { if (isFsErrorWithCode(error, "ENOENT")) return null; throw error; });
}

function refused(message: string): RemoteInstanceError {
  return new RemoteInstanceError("recovery_required", `${message} Private installation state was preserved.`);
}
