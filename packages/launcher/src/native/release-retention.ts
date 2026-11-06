import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { runCommand, writeSecretFile } from "@konteks/remote-common";
import { readNativeUpdateLedger, SupervisorStore, type NativeUpdateAttempt } from "@konteks/remote-supervisor";
import { z } from "zod";
import { verbose } from "../verbose.js";
import type { NativePlatform } from "./service.js";

const releaseId = z.string().regex(/^release-[A-Za-z0-9_-]+$/);
const reference = z.object({ releaseId: releaseId.optional() }).passthrough();
const OUTPUT_CAP = 2 * 1024 * 1024;
export type ReleaseReferences = (root: string, platform: NativePlatform) => Promise<readonly string[]>;
interface RetentionInput { root: string; instanceId: string; workspaceId: string; keep: readonly string[]; platform: NativePlatform; assertOwned(): void; references?: ReleaseReferences }
type ServingHistory = NonNullable<Awaited<ReturnType<SupervisorStore["servingReleaseHistory"]>>>;
interface CleanupReport { removed: string[]; deferred: string[]; state: "checked" | "deferred" }

/** Installer and supervisor locks must both stay owned throughout this stopped-state maintenance. */
export async function pruneCompletedNativeReleases(input: RetentionInput): Promise<void> {
  const report: CleanupReport = { removed: [], deferred: [], state: "checked" };
  try { await prune(input, report); }
  catch { report.state = "deferred"; }
  input.assertOwned();
  // No process commands, keys, identity or user files enter this receipt.
  await writeReceipt(input, report).catch(() => undefined);
  verbose(`release cleanup: ${report.removed.length} obsolete folders removed, ${report.deferred.length} deferred (${report.state})`);
}

async function prune(input: RetentionInput, report: CleanupReport): Promise<void> {
  const ledger = await readNativeUpdateLedger(input.root);
  const keep = await retainedReleases(input, ledger.attempts);
  const candidates = [...new Set(ledger.attempts.filter(attempt => attempt.outcome !== "in_progress").map(attempt => attempt.releaseId))]
    .filter((id): id is string => id !== null && releaseId.safeParse(id).success && !keep.has(id));
  if (candidates.length === 0) return;
  report.deferred.push(...candidates);
  const directory = await ownedDirectory(input.root, "releases");
  const references = await (input.references ?? nativeReleaseReferences)(input.root, input.platform);
  report.deferred.length = 0;
  for (const id of candidates) await pruneOne(input, directory, id, references, report);
}

async function retainedReleases(input: RetentionInput, attempts: readonly NativeUpdateAttempt[]): Promise<Set<string>> {
  const keep = new Set(input.keep);
  // Keep the last two installed releases as well as the candidate:
  // a failed successor must not consume the current release's own rollback.
  const applied = [...new Set([...attempts].reverse().filter(attempt => attempt.outcome === "applied").map(attempt => attempt.releaseId))];
  for (const id of applied.slice(0, 2)) if (id) keep.add(id);
  for (const attempt of attempts) if (attempt.outcome === "in_progress" && attempt.releaseId) keep.add(attempt.releaseId);
  await keepConfirmedServing(input, keep);
  await keepReference(join(input.root, "native-enrollment.json"), keep);
  await keepRetired(input.root, keep);
  return keep;
}

async function keepRetired(root: string, keep: Set<string>): Promise<void> {
  const path = join(root, "retired");
  const info = await optionalInfo(path);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unverified retired directory");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unverified retired entry");
    await keepReference(join(path, entry.name, "native-runtime.json"), keep, true);
    await keepRetiredServing(join(path, entry.name, "supervisor"), keep);
  }
}

async function keepConfirmedServing(input: RetentionInput, keep: Set<string>): Promise<void> {
  const supervisor = await ownedDirectory(input.root, "supervisor");
  const history = await new SupervisorStore(supervisor).servingReleaseHistory();
  assertConfirmedHistory(history, input);
  addServingReferences(history, keep);
}

function assertConfirmedHistory(history: ServingHistory | null, input: RetentionInput): asserts history is ServingHistory {
  if (!history || !history.previous) throw new Error("Core rollback history is not yet known");
  if (history.instanceId !== input.instanceId || history.workspaceId !== input.workspaceId) throw new Error("Core serving history belongs to another runtime");
}

async function keepRetiredServing(path: string, keep: Set<string>): Promise<void> {
  const info = await optionalInfo(path);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("retired serving history is linked");
  const history = await new SupervisorStore(path).servingReleaseHistory();
  if (history) addServingReferences(history, keep);
}

function addServingReferences(history: ServingHistory, keep: Set<string>): void {
  keep.add(history.current.releaseId);
  if (history.previous) keep.add(history.previous.releaseId);
}

async function keepReference(path: string, keep: Set<string>, required = false): Promise<void> {
  const info = await optionalInfo(path);
  if (!info) { if (required) throw new Error("retired release reference is missing"); return; }
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error("unverified release reference");
  const record = reference.parse(JSON.parse(await readFile(path, "utf8")));
  if (record.releaseId) keep.add(record.releaseId);
}

function optionalInfo(path: string): Promise<Stats | null> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
}

async function pruneOne(input: RetentionInput, directory: string, id: string, references: readonly string[], report: CleanupReport): Promise<void> {
  const path = join(directory, id);
  const info = await optionalInfo(path);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || releaseInUse(input, id, path, references)) { report.deferred.push(id); return; }
  input.assertOwned();
  try { await rm(path, { recursive: true }); report.removed.push(id); }
  catch { report.deferred.push(id); }
}

function releaseInUse(input: RetentionInput, id: string, path: string, references: readonly string[]): boolean {
  return referenced(path, references, input.platform.os) || referenced(join(input.root, "releases", id), references, input.platform.os);
}

function referenced(path: string, references: readonly string[], os: NativePlatform["os"]): boolean {
  const normalize = (value: string) => os === "windows" ? value.toLowerCase().replaceAll("/", "\\") : value;
  const target = normalize(path);
  return references.some(value => normalize(value).includes(target));
}

async function nativeReleaseReferences(root: string, platform: NativePlatform): Promise<readonly string[]> {
  if (platform.os === "windows") return windowsReferences();
  const processes = await checkedOutput("/bin/ps", ["-axo", "command="]);
  // Open files and cwd also protect a process launched with a relative path.
  const lsof = platform.os === "macos" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
  const files = await checkedOutput(lsof, ["-nP", "+D", join(root, "releases"), "-Fn"], true);
  return [processes, files];
}

async function windowsReferences(): Promise<readonly string[]> {
  const script = "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object CommandLine,ExecutablePath) -Compress";
  const output = await checkedOutput("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  const row = z.object({ CommandLine: z.string().nullable(), ExecutablePath: z.string().nullable() }).strict();
  const records = z.array(row).nonempty().parse(JSON.parse(output.trim().replace(/^\uFEFF/, "")));
  return records.flatMap(record => [record.CommandLine ?? "", record.ExecutablePath ?? ""]);
}

async function checkedOutput(command: string, args: string[], emptyAllowed = false): Promise<string> {
  const result = await runCommand({ command, args, timeoutMs: 15_000, outputCapBytes: OUTPUT_CAP });
  if (emptyAllowed && noOpenFiles(result)) return "";
  if (!completeOutput(result)) throw new Error("process usage is unverified");
  if (!emptyAllowed && !result.stdout.trim()) throw new Error("process usage is empty");
  return result.stdout;
}

function noOpenFiles(result: Awaited<ReturnType<typeof runCommand>>): boolean {
  return result.code === 1 && !result.stdout.trim() && !result.stderr.trim();
}

function completeOutput(result: Awaited<ReturnType<typeof runCommand>>): boolean {
  return result.code === 0 && !result.stderr.trim() && Buffer.byteLength(result.stdout) < OUTPUT_CAP;
}

async function ownedDirectory(root: string, name: string): Promise<string> {
  const expected = join(await realpath(root), name);
  if (await realpath(join(root, name)) !== expected) throw new Error("installation directory is linked");
  return expected;
}

async function writeReceipt(input: RetentionInput, report: CleanupReport): Promise<void> {
  const logs = await ownedDirectory(input.root, "logs");
  input.assertOwned();
  await writeSecretFile(join(logs, "release-cleanup.json"), JSON.stringify({ ...report, checkedAt: new Date().toISOString() }));
}
