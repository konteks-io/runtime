import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { RuntimeFailureObservationSchema, RUNTIME_FAILURE_OBSERVATION_MAX_BYTES, type RuntimeFailureObservation } from "./contracts.js";
import { isFsErrorWithCode, RemoteInstanceError } from "./errors.js";
import { jcsDigest } from "./digest.js";
import type { JsonValue } from "./jcs.js";

const CAPTURE_DIRECTORY = "runtime-failure-captures";
const CAPACITY = 50;
const MAX_BYTES = 2 * RUNTIME_FAILURE_OBSERVATION_MAX_BYTES;
const CaptureSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  observation: RuntimeFailureObservationSchema,
  failureDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict().superRefine((capture, ctx) => {
  if (capture.observation.scope.kind !== "runtime") {
    ctx.addIssue({ code: "custom", path: ["observation", "scope"], message: "Lifecycle capture requires runtime scope." });
  }
  if (capture.failureDigest !== jcsDigest(capture.observation as unknown as JsonValue)) {
    ctx.addIssue({ code: "custom", path: ["failureDigest"], message: "Lifecycle capture digest does not match." });
  }
});

export type RuntimeFailureCapture = z.infer<typeof CaptureSchema>;
export type RuntimeFailureCaptureFile = { path: string; capture: RuntimeFailureCapture; bytes: string; identity: Stats };

/** Freeze the original owner, failure identity, timestamp and canonical bytes once. */
export function createRuntimeFailureCapture(workspaceId: string, observation: RuntimeFailureObservation): RuntimeFailureCapture {
  const capture = CaptureSchema.parse({ schemaVersion: 1, workspaceId, observation,
    failureDigest: jcsDigest(observation as unknown as JsonValue) });
  Object.freeze(capture.observation.scope);
  Object.freeze(capture.observation.evidence);
  Object.freeze(capture.observation);
  return Object.freeze(capture);
}

/** Local handoff only. The owning supervisor's existing queue delivers these facts. */
export async function writeRuntimeFailureCapture(dataDir: string, value: RuntimeFailureCapture): Promise<string> {
  const bytes = captureBytes(value);
  const owner = await ownedDirectory(dataDir);
  const path = join(owner.path, CAPTURE_DIRECTORY);
  await mkdir(path, { mode: 0o700 }).catch(error => { if (!isFsErrorWithCode(error, "EEXIST")) throw error; });
  const directory = await ownedDirectory(path);
  await unchangedDirectory(owner);
  await syncDirectory(owner.path);
  const capture = CaptureSchema.parse(value);
  const name = captureName(capture);
  const target = join(directory.path, name);
  if (await existingCapture(target, bytes)) return target;
  if (!(await pendingPublication(target, bytes)) && (await readdir(directory.path)).length >= CAPACITY) throw unavailable();
  await publishCapture(directory, target, bytes);
  await unchangedDirectory(owner);
  return target;
}

/** Completed captures and pending handoffs have one link after exact publication recovery. */
export async function readRuntimeFailureCapture(path: string): Promise<RuntimeFailureCaptureFile | null> {
  if (!/^[A-Za-z0-9_-]{43}\.json(?:\.pending)?$/.test(basename(path))) throw unavailable();
  const directory = await ownedDirectory(dirname(path));
  if (basename(directory.path) !== CAPTURE_DIRECTORY) throw unavailable();
  const target = join(directory.path, basename(path));
  let before = await optionalStat(target);
  if (!before) return null;
  if (before.nlink === 2) {
    await recoverPublication(directory, target, before);
    before = await lstat(target);
  }
  const result = await readCaptureFile(target, before, 1);
  await unchangedDirectory(directory);
  return result;
}

/** Enumeration and retirement share the producer's private-file boundary. */
export async function listRuntimeFailureCaptures(dataDir: string): Promise<string[]> {
  const owner = await ownedDirectory(dataDir);
  const path = join(owner.path, CAPTURE_DIRECTORY);
  if (!(await optionalStat(path))) return [];
  const directory = await ownedDirectory(path);
  const names = await readdir(directory.path);
  await unchangedDirectory(owner);
  await unchangedDirectory(directory);
  return names.filter(name => /^[A-Za-z0-9_-]{43}\.json(?:\.pending)?$/.test(name)).sort().slice(0, CAPACITY)
    .map(name => join(directory.path, name));
}

/** The sole queue owner retires only the same immutable source after durable admission. */
export async function retireRuntimeFailureCapture(source: RuntimeFailureCaptureFile, assertCurrent: () => void): Promise<void> {
  const current = await readRuntimeFailureCapture(source.path);
  if (!current || !sameVersion(source.identity, current.identity) || source.bytes !== current.bytes) throw unavailable();
  assertCurrent();
  await rm(source.path);
  await syncDirectory(dirname(source.path));
}

function captureName(capture: RuntimeFailureCapture): string {
  return `${jcsDigest([capture.workspaceId, capture.observation.instanceId, capture.observation.failureId])}.json`;
}

function captureBytes(value: RuntimeFailureCapture): string {
  const bytes = JSON.stringify(CaptureSchema.parse(value));
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw unavailable();
  return bytes;
}

type OwnedDirectory = { path: string; identity: Stats };

async function ownedDirectory(path: string): Promise<OwnedDirectory> {
  if (!isAbsolute(path)) throw unavailable();
  const identity = await lstat(resolve(path));
  if (!identity.isDirectory() || !restricted(identity)) throw unavailable();
  const canonical = await realpath(path);
  if (!sameEntry(identity, await lstat(path)) || !sameEntry(identity, await lstat(canonical))) throw unavailable();
  return { path: canonical, identity };
}

async function unchangedDirectory(directory: OwnedDirectory): Promise<void> {
  const current = await lstat(directory.path);
  if (!current.isDirectory() || !restricted(current) || !sameEntry(directory.identity, current)) throw unavailable();
}

async function publishCapture(directory: OwnedDirectory, target: string, bytes: string): Promise<void> {
  const temporary = `${target}.pending`;
  let identity: Stats | null = null;
  try {
    identity = await preparePublication(temporary, bytes);
    await unchangedDirectory(directory);
    await link(temporary, target).catch(async error => {
      if (!isFsErrorWithCode(error, "EEXIST")) throw error;
      if (!(await existingCapture(target, bytes))) throw unavailable();
    });
  } finally {
    if (identity) await removePending(temporary, identity);
  }
  await syncDirectory(directory.path);
  await unchangedDirectory(directory);
}

async function preparePublication(path: string, bytes: string): Promise<Stats> {
  const existing = await retainedPublication(path, bytes);
  if (existing) return existing.identity;
  // A pending name is visible only after its complete immutable bytes were synced and closed.
  const writing = `${path}.writing`;
  let identity: Stats | null = null;
  try {
    identity = await writeCandidate(writing, bytes);
    await link(writing, path).catch(async error => {
      if (!isFsErrorWithCode(error, "EEXIST")) throw error;
      if (!(await retainedPublication(path, bytes))) throw unavailable();
    });
  } finally {
    if (identity) await removePending(writing, identity);
  }
  await syncDirectory(dirname(path));
  const prepared = await retainedPublication(path, bytes);
  if (!prepared) throw unavailable();
  return prepared.identity;
}

async function writeCandidate(path: string, bytes: string): Promise<Stats> {
  const file = await open(path, "wx", 0o600).catch(error => {
    if (isFsErrorWithCode(error, "EEXIST")) return null;
    throw error;
  });
  if (!file) {
    const existing = await readCaptureFile(path, await lstat(path), 1, true);
    if (existing.bytes !== bytes) throw unavailable();
    return existing.identity;
  }
  try { await file.writeFile(bytes); await file.sync(); return await file.stat(); }
  finally { await file.close(); }
}

async function pendingPublication(target: string, bytes: string): Promise<boolean> {
  return (await retainedPublication(`${target}.pending`, bytes)) !== null;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") {
    const parent = await open(path, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

async function existingCapture(path: string, expected: string): Promise<boolean> {
  return (await retainedPublication(path, expected)) !== null;
}

async function retainedPublication(path: string, expected: string): Promise<RuntimeFailureCaptureFile | null> {
  const existing = await readRuntimeFailureCapture(path);
  if (!existing) return null;
  if (existing.bytes !== expected) throw unavailable();
  return existing;
}

async function optionalStat(path: string): Promise<Stats | null> {
  return lstat(path).catch(error => {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
}

async function readCaptureFile(path: string, before: Stats, links: number, sync = false): Promise<RuntimeFailureCaptureFile> {
  if (!privateFile(before, links)) throw unavailable();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameVersion(before, await file.stat())) throw unavailable();
    const bytes = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await file.read(bytes, 0, MAX_BYTES, 0);
    const after = await file.stat();
    const named = await lstat(path);
    if (!unchangedFile(before, after, named, bytesRead, links)) throw unavailable();
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const capture = CaptureSchema.parse(JSON.parse(text));
    if (basename(path).replace(/\.pending(?:\.writing)?$/, "") !== captureName(capture)) throw unavailable();
    if (sync) await file.sync();
    return { path, capture, bytes: text, identity: named };
  } finally { await file.close(); }
}

async function recoverPublication(directory: OwnedDirectory, target: string, before: Stats): Promise<void> {
  const published = await readCaptureFile(target, before, 2);
  const pending = `${target}.${target.endsWith(".pending") ? "writing" : "pending"}`;
  const sibling = await lstat(pending);
  if (!privateFile(sibling, 2) || !sameVersion(published.identity, sibling)) throw unavailable();
  if (!sameVersion(published.identity, await lstat(target))) throw unavailable();
  await removePending(pending, sibling);
  await syncDirectory(directory.path);
}

async function removePending(path: string, identity: Stats): Promise<void> {
  const current = await optionalStat(path);
  if (!current) return;
  if (!sameEntry(identity, current) || !pendingFile(current)) throw unavailable();
  await rm(path);
}

function pendingFile(info: Stats): boolean {
  return (info.nlink === 1 || info.nlink === 2) && privateFile(info, info.nlink);
}

function restricted(info: Stats): boolean {
  return process.platform === "win32" || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.());
}

function privateFile(info: Stats, links: number): boolean {
  return info.isFile() && info.nlink === links && restricted(info) && info.size <= MAX_BYTES;
}

function sameEntry(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function sameVersion(before: Stats, after: Stats): boolean {
  return sameEntry(before, after) && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function unchangedFile(before: Stats, after: Stats, named: Stats, bytesRead: number, links: number): boolean {
  return sameVersion(before, after) && sameVersion(after, named) && privateFile(named, links) && bytesRead === before.size;
}

function unavailable(): RemoteInstanceError {
  return new RemoteInstanceError("local_io_failure", "Runtime failure capture is unavailable.");
}
