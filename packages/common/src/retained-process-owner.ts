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

export function captureRetainedProcessOwner(pid: number, options: CaptureOptions = {}): RetainedProcessOwner {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new RemoteInstanceError("recovery_required", `Durable execution-process rehydration is not available on ${platform}.`);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw invalidOwner("Bridge PID is invalid.");
  const identity = (options.readIdentity ?? identityReader(platform))(pid);
  if (!identity) throw invalidOwner("Bridge process identity cannot be captured.");
  if (identity.pid !== pid || identity.processGroupId !== pid) throw invalidOwner("Bridge is not its exact process-group leader.");
  return { version: 1, platform, ...identity };
}

export async function stopRetainedProcessOwner(owner: RetainedProcessOwner, options: StopOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if ((platform !== "darwin" && platform !== "linux" && platform !== "win32") || owner.platform !== platform) throw invalidOwner(`Durable execution-process rehydration is not available on ${platform}.`);
  const read = options.readIdentity ?? identityReader(platform);
  if (platform === "win32") return stopWindowsProcessOwner(owner, read, options);
  const observed = read(owner.pid);
  const signal = options.signal ?? ((pid, value) => process.kill(pid, value));
  const groupAlive = options.groupAlive ?? ((pgid) => {
    try { process.kill(-pgid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  });
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!observed) {
    // The leader is gone. That alone is not stop proof — a descendant could
    // have survived it — so require the same evidence the stop wait accepts:
    // the whole process group is absent. A reused PID is refused below.
    if (groupAlive(owner.processGroupId)) throw invalidOwner("Retained bridge leader is absent while its process group survives; absence is not stop proof.");
    return;
  }
  if (!sameIdentity(owner, observed)) throw invalidOwner("Retained bridge identity changed; refusing to signal a reused process identity.");
  signal(owner.pid, "SIGTERM");
  if (await waitUntilStopped(owner, read, groupAlive, pause, options.termTimeoutMs ?? 5_000)) return;
  // The group signal is authorized only after the exact leader identity was
  // positively matched above. It does not rely on a PID file or root lock.
  try { signal(-owner.processGroupId, "SIGKILL"); } catch { /* verified below */ }
  if (await waitUntilStopped(owner, read, groupAlive, pause, options.killTimeoutMs ?? 2_000)) return;
  throw invalidOwner("Retained bridge process-group exit remains unconfirmed.");
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
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const statPath = `/proc/${pid}/stat`;
  const first = parseLinuxStat(readFile(statPath), pid);
  if (!first) return null;
  const command = readFile(`/proc/${pid}/cmdline`);
  const bootId = readFile("/proc/sys/kernel/random/boot_id")?.toString("utf8").trim();
  const second = parseLinuxStat(readFile(statPath), pid);
  if (!command?.length || !bootId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(bootId) ||
      !second || first.processGroupId !== second.processGroupId || first.startTicks !== second.startTicks) return null;
  return { pid, processGroupId: first.processGroupId, startToken: `${bootId}:${first.startTicks}`,
    commandDigest: createHash("sha256").update(command).digest("base64url") };
}

/** Windows has no POSIX process groups. A detached bridge is fenced by the
 * kernel-reported creation instant plus its executable identity, and
 * is stopped with taskkill's descendant-tree semantics. Reading twice keeps a
 * PID replacement from mixing fields across two processes. */
export function readWindowsProcessIdentity(
  pid: number,
  query?: (pid: number) => WindowsProcessRecord | null,
): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const [first, second] = query ? [query(pid), query(pid)] : queryWindowsProcessPair(pid);
  if (!first) return null;
  if (!second || first.ProcessId !== pid || second.ProcessId !== pid ||
      first.CreationDate !== second.CreationDate || first.CommandLine !== second.CommandLine ||
      first.ExecutablePath !== second.ExecutablePath) return null;
  if (!first.CreationDate.trim()) return null;
  // Windows may withhold Path for a same-user process. Unlike POSIX it cannot
  // replace a running process image with exec(), so PID + kernel creation time
  // remains the authoritative identity; the path is additional evidence only.
  const command = `${first.ExecutablePath ?? ""}\0${first.CommandLine ?? ""}\0${first.CreationDate}`;
  return { pid, processGroupId: pid, startToken: first.CreationDate,
    commandDigest: createHash("sha256").update(command).digest("base64url") };
}

function queryWindowsProcessPair(pid: number): [WindowsProcessRecord | null, WindowsProcessRecord | null] {
  if (process.platform !== "win32") return [null, null];
  // One PowerShell host takes both observations. Get-Process reads the kernel
  // creation time directly; Get-CimInstance has a multi-second cold start and
  // made the first bridge race its owner-capture timeout on healthy machines.
  const script = `$items=@(); for($i=0;$i -lt 2;$i++){ $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -ne $p){ $items += [pscustomobject]@{ProcessId=[int]$p.Id;ParentProcessId=0;CreationDate=[string]$p.StartTime.ToUniversalTime().Ticks;CommandLine='';ExecutablePath=[string]$p.Path} } }; ConvertTo-Json -InputObject @($items) -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) return [null, null];
  try {
    const values = JSON.parse(result.stdout) as Array<Partial<WindowsProcessRecord>>;
    if (!Array.isArray(values) || values.length !== 2 || values.some(value =>
      !Number.isSafeInteger(value.ProcessId) || !Number.isSafeInteger(value.ParentProcessId) ||
      typeof value.CreationDate !== "string" || typeof value.CommandLine !== "string" || typeof value.ExecutablePath !== "string")) return [null, null];
    return values as [WindowsProcessRecord, WindowsProcessRecord];
  } catch { return [null, null]; }
}

async function stopWindowsProcessOwner(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, options: StopOptions): Promise<void> {
  const observed = read(owner.pid);
  const treeAlive = options.treeAlive ?? windowsProcessTreeAlive;
  if (!observed) {
    if (treeAlive(owner.pid)) throw invalidOwner("Retained bridge leader is absent while its process tree survives; absence is not stop proof.");
    return;
  }
  if (!sameIdentity(owner, observed)) throw invalidOwner("Retained bridge identity changed; refusing to terminate a reused process identity.");
  const terminate = options.terminateTree ?? terminateWindowsProcessTree;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  terminate(owner.pid, false);
  if (await waitUntilWindowsTreeStopped(owner, read, treeAlive, pause, options.termTimeoutMs ?? 5_000)) return;
  terminate(owner.pid, true);
  if (await waitUntilWindowsTreeStopped(owner, read, treeAlive, pause, options.killTimeoutMs ?? 2_000)) return;
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

async function waitUntilWindowsTreeStopped(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, treeAlive: (pid: number) => boolean, pause: (ms: number) => Promise<void>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = read(owner.pid);
    if (current && !sameIdentity(owner, current)) throw invalidOwner("Retained bridge identity changed while stopping.");
    if (!current && !treeAlive(owner.pid)) return true;
    await pause(Math.min(50, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

function parseLinuxStat(bytes: Buffer | null, pid: number): { processGroupId: number; startTicks: string } | null {
  if (!bytes) return null;
  const stat = bytes.toString("utf8");
  if (!stat.startsWith(`${pid} (`)) return null;
  const end = stat.lastIndexOf(") ");
  if (end < 0) return null;
  // After comm: state (field 3), ppid (4), pgrp (5), ... starttime (22).
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  const startTicks = fields[19];
  if (fields.length < 20 || fields[0] === "Z" || fields[0] === "X" ||
      !Number.isSafeInteger(processGroupId) || processGroupId <= 1 ||
      !startTicks || !/^\d+$/.test(startTicks) || BigInt(startTicks) === 0n) return null;
  return { processGroupId, startTicks };
}

async function waitUntilStopped(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, groupAlive: (pgid: number) => boolean, pause: (ms: number) => Promise<void>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = read(owner.pid);
    if (current && !sameIdentity(owner, current)) throw invalidOwner("Retained bridge identity changed while stopping.");
    if (!current && !groupAlive(owner.processGroupId)) return true;
    await pause(Math.min(50, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.processGroupId === b.processGroupId && a.startToken === b.startToken && a.commandDigest === b.commandDigest;
}
function invalidOwner(message: string): RemoteInstanceError { return new RemoteInstanceError("recovery_required", message); }
