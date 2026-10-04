import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { RemoteInstanceError } from "./errors.js";

export interface ProcessIdentity {
  pid: number;
  processGroupId: number;
  startToken: string;
  commandDigest: string;
}

/** Durable handle for one process-group leader. It is stop evidence only and
 * never establishes tool/MCP quiescence or permits execution-slot release. */
export interface RetainedProcessOwner extends ProcessIdentity {
  version: 1;
  platform: "darwin" | "linux" | "win32";
}

interface CaptureOptions {
  platform?: NodeJS.Platform;
  readIdentity?: (pid: number) => ProcessIdentity | null;
}

interface StopOptions extends CaptureOptions {
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  groupAlive?: (processGroupId: number) => boolean;
  pause?: (ms: number) => Promise<void>;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  terminateTree?: (pid: number, force: boolean) => void;
  treeAlive?: (pid: number) => boolean;
}

interface WindowsProcessRecord {
  ProcessId: number;
  ParentProcessId: number;
  CreationDate: string;
  CommandLine: string | null;
  ExecutablePath: string | null;
}

type OwnerPlatform = RetainedProcessOwner["platform"];

function isOwnerPlatform(platform: NodeJS.Platform): platform is OwnerPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function isBridgePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1;
}

export function captureRetainedProcessOwner(pid: number, options: CaptureOptions = {}): RetainedProcessOwner {
  const platform = options.platform ?? process.platform;
  if (!isOwnerPlatform(platform)) throw invalidOwner(`Durable execution-process rehydration is not available on ${platform}.`);
  if (!isBridgePid(pid)) throw invalidOwner("Bridge PID is invalid.");
  const identity = readerFor(options, platform)(pid);
  if (!identity) throw invalidOwner("Bridge process identity cannot be captured.");
  if (identity.pid !== pid || identity.processGroupId !== pid) throw invalidOwner("Bridge is not its exact process-group leader.");
  return { version: 1, platform, ...identity };
}

export async function stopRetainedProcessOwner(owner: RetainedProcessOwner, options: StopOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (!isOwnerPlatform(platform) || owner.platform !== platform) throw invalidOwner(`Durable execution-process rehydration is not available on ${platform}.`);
  const read = readerFor(options, platform);
  if (platform === "win32") return stopWindowsProcessOwner(owner, read, options);
  return stopPosixProcessOwner(owner, read, options);
}

const pauseFor = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function processGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function posixStopDeps(options: StopOptions) {
  return {
    signal: options.signal ?? ((pid: number, value: NodeJS.Signals) => process.kill(pid, value)),
    groupAlive: options.groupAlive ?? processGroupAlive,
    pause: options.pause ?? pauseFor,
  };
}

/**
 * Whether the retained leader is still the exact process to stop. An absent
 * leader is not stop proof by itself (a descendant could have survived it),
 * so it counts as stopped only when nothing it started survives; a reused
 * identity is refused.
 */
function leaderToStop(owner: RetainedProcessOwner, observed: ProcessIdentity | null, survivors: () => boolean, kind: "group" | "tree"): boolean {
  if (!observed) {
    if (survivors()) throw invalidOwner(kind === "group"
      ? "Retained bridge leader is absent while its process group survives; absence is not stop proof."
      : "Retained bridge leader is absent while its process tree survives; absence is not stop proof.");
    return false;
  }
  if (!sameIdentity(owner, observed)) throw invalidOwner(kind === "group"
    ? "Retained bridge identity changed; refusing to signal a reused process identity."
    : "Retained bridge identity changed; refusing to terminate a reused process identity.");
  return true;
}

async function stopPosixProcessOwner(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, options: StopOptions): Promise<void> {
  const { signal, groupAlive, pause } = posixStopDeps(options);
  const survivors = () => groupAlive(owner.processGroupId);
  if (!leaderToStop(owner, read(owner.pid), survivors, "group")) return;
  signal(owner.pid, "SIGTERM");
  if (await waitUntilStopped(owner, read, survivors, pause, options.termTimeoutMs ?? 5_000)) return;
  // The group signal is authorized only after the exact leader identity was
  // positively matched above. It does not rely on a PID file or root lock.
  try { signal(-owner.processGroupId, "SIGKILL"); } catch { /* verified below */ }
  if (await waitUntilStopped(owner, read, survivors, pause, options.killTimeoutMs ?? 2_000)) return;
  throw invalidOwner("Retained bridge process-group exit remains unconfirmed.");
}

function readerFor(options: CaptureOptions, platform: OwnerPlatform): (pid: number) => ProcessIdentity | null {
  return options.readIdentity ?? identityReader(platform);
}

function identityReader(platform: "darwin" | "linux" | "win32"): (pid: number) => ProcessIdentity | null {
  return platform === "darwin" ? readDarwinProcessIdentity : platform === "linux" ? readLinuxProcessIdentity : readWindowsProcessIdentity;
}

export function readDarwinProcessIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "state=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]+)$/);
  if (!match) return null;
  const [, pidText, groupText, state, startToken, command] = match;
  if (state!.startsWith("Z")) return null;
  return { pid: Number(pidText), processGroupId: Number(groupText), startToken: startToken!, commandDigest: createHash("sha256").update(command!).digest("base64url") };
}

/** Linux PID reuse is fenced by the kernel's start ticks and boot identity.
 * Read stat twice around cmdline so an exec or PID replacement cannot mix two
 * different process identities into one durable owner. */
export function readLinuxProcessIdentity(
  pid: number,
  readFile: (path: string) => Buffer | null = path => { try { return readFileSync(path); } catch { return null; } },
): ProcessIdentity | null {
  if (!isBridgePid(pid)) return null;
  const statPath = `/proc/${pid}/stat`;
  const first = parseLinuxStat(readFile(statPath), pid);
  if (!first) return null;
  const command = readFile(`/proc/${pid}/cmdline`);
  const bootId = readBootId(readFile);
  const second = parseLinuxStat(readFile(statPath), pid);
  if (!command?.length || !bootId || !sameLinuxStat(first, second)) return null;
  return { pid, processGroupId: first.processGroupId, startToken: `${bootId}:${first.startTicks}`,
    commandDigest: createHash("sha256").update(command).digest("base64url") };
}

function readBootId(readFile: (path: string) => Buffer | null): string | null {
  const bootId = readFile("/proc/sys/kernel/random/boot_id")?.toString("utf8").trim();
  return bootId && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(bootId) ? bootId : null;
}

type LinuxStat = { processGroupId: number; startTicks: string };

function sameLinuxStat(first: LinuxStat, second: LinuxStat | null): boolean {
  return second !== null && first.processGroupId === second.processGroupId && first.startTicks === second.startTicks;
}

/** Windows has no POSIX process groups. A detached bridge is fenced by the
 * kernel-reported creation instant plus its executable identity, and
 * is stopped with taskkill's descendant-tree semantics. Reading twice keeps a
 * PID replacement from mixing fields across two processes. */
export function readWindowsProcessIdentity(
  pid: number,
  query?: (pid: number) => WindowsProcessRecord | null,
): ProcessIdentity | null {
  if (!isBridgePid(pid)) return null;
  const [first, second] = query ? [query(pid), query(pid)] : queryWindowsProcessPair(pid);
  if (!first || !second || !sameWindowsProcess(pid, first, second) || !first.CreationDate.trim()) return null;
  // Windows may reveal Path/CommandLine only after the process has started.
  // Unlike POSIX it cannot replace a running process image with exec(), so PID
  // + kernel creation time is the stable authority. Optional process details
  // may disprove a capture when both reads expose conflicting values, but must
  // not make a durable owner change merely because they become visible later.
  const command = `${pid}\0${first.CreationDate}`;
  return { pid, processGroupId: pid, startToken: first.CreationDate,
    commandDigest: createHash("sha256").update(command).digest("base64url") };
}

/** Both reads name the same process: its PID and creation instant, and no conflicting optional detail. */
function sameWindowsProcess(pid: number, first: WindowsProcessRecord, second: WindowsProcessRecord): boolean {
  return first.ProcessId === pid && second.ProcessId === pid && first.CreationDate === second.CreationDate &&
    !conflicting(first.CommandLine, second.CommandLine) && !conflicting(first.ExecutablePath, second.ExecutablePath);
}

function conflicting(first: string | null, second: string | null): boolean {
  return Boolean(first && second && first !== second);
}

function queryWindowsProcessPair(pid: number): [WindowsProcessRecord | null, WindowsProcessRecord | null] {
  if (process.platform !== "win32") return [null, null];
  // One PowerShell host takes both observations. Get-Process reads the kernel
  // creation time directly; Get-CimInstance has a multi-second cold start and
  // made the first bridge race its owner-capture timeout on healthy machines.
  const script = `$items=@(); for($i=0;$i -lt 2;$i++){ $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -ne $p){ $items += [pscustomobject]@{ProcessId=[int]$p.Id;ParentProcessId=0;CreationDate=[string]$p.StartTime.ToUniversalTime().Ticks;CommandLine='';ExecutablePath=[string]$p.Path} } }; ConvertTo-Json -InputObject @($items) -Compress`;
  // On Windows ARM running an x64 Node bridge, the native PowerShell host can
  // take over ten seconds to initialize even while the bridge stays healthy.
  // Timeout must cover that cold start; a miss cannot be treated as ownership.
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) return [null, null];
  try {
    const values = JSON.parse(result.stdout) as Array<Partial<WindowsProcessRecord>>;
    if (!Array.isArray(values) || values.length !== 2 || values.some(value =>
      !Number.isSafeInteger(value.ProcessId) || !Number.isSafeInteger(value.ParentProcessId) ||
      typeof value.CreationDate !== "string" || typeof value.CommandLine !== "string" || typeof value.ExecutablePath !== "string")) return [null, null];
    return values as [WindowsProcessRecord, WindowsProcessRecord];
  } catch { return [null, null]; }
}

function windowsStopDeps(options: StopOptions) {
  return {
    treeAlive: options.treeAlive ?? windowsProcessTreeAlive,
    terminate: options.terminateTree ?? terminateWindowsProcessTree,
    pause: options.pause ?? pauseFor,
  };
}

async function stopWindowsProcessOwner(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, options: StopOptions): Promise<void> {
  const { treeAlive, terminate, pause } = windowsStopDeps(options);
  const survivors = () => treeAlive(owner.pid);
  if (!leaderToStop(owner, read(owner.pid), survivors, "tree")) return;
  terminate(owner.pid, false);
  if (await waitUntilStopped(owner, read, survivors, pause, options.termTimeoutMs ?? 5_000)) return;
  terminate(owner.pid, true);
  if (await waitUntilStopped(owner, read, survivors, pause, options.killTimeoutMs ?? 2_000)) return;
  throw invalidOwner("Retained bridge process-tree exit remains unconfirmed.");
}

function terminateWindowsProcessTree(pid: number, force: boolean): void {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
    { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
  // A raced exit is accepted only by the independent observation below.
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ESRCH") throw result.error;
}

function windowsProcessTreeAlive(pid: number): boolean {
  if (process.platform !== "win32") return false;
  const script = `$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $seen=@(${pid}); do { $before=$seen.Count; $seen += @($all | Where-Object { $seen -contains $_.ParentProcessId } | ForEach-Object ProcessId); $seen=@($seen | Select-Object -Unique) } while ($seen.Count -gt $before); if ($seen.Count -gt 1 -or ($all | Where-Object ProcessId -eq ${pid})) { exit 0 } else { exit 1 }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 3_000, stdio: "ignore" });
  return result.status === 0;
}

function parseLinuxStat(bytes: Buffer | null, pid: number): LinuxStat | null {
  const fields = linuxStatFields(bytes, pid);
  if (!fields || fields.length < 20 || fields[0] === "Z" || fields[0] === "X") return null;
  const processGroupId = Number(fields[2]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1 || !validStartTicks(startTicks)) return null;
  return { processGroupId, startTicks };
}

/** The fields after `comm`: state (field 3), ppid (4), pgrp (5), ... starttime (22). */
function linuxStatFields(bytes: Buffer | null, pid: number): string[] | null {
  if (!bytes) return null;
  const stat = bytes.toString("utf8");
  if (!stat.startsWith(`${pid} (`)) return null;
  const end = stat.lastIndexOf(") ");
  return end < 0 ? null : stat.slice(end + 2).trim().split(/\s+/);
}

function validStartTicks(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value) && BigInt(value) !== 0n;
}

async function waitUntilStopped(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, survivors: () => boolean, pause: (ms: number) => Promise<void>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = read(owner.pid);
    if (current && !sameIdentity(owner, current)) throw invalidOwner("Retained bridge identity changed while stopping.");
    if (!current && !survivors()) return true;
    await pause(Math.min(50, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.processGroupId === b.processGroupId && a.startToken === b.startToken && a.commandDigest === b.commandDigest;
}
function invalidOwner(message: string): RemoteInstanceError { return new RemoteInstanceError("recovery_required", message); }
