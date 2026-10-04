import { win32 } from "node:path";
import { RemoteInstanceError, runCommand, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";
import { nativeConnectorFileNames } from "@konteks/remote-release";

/** Captured before shutdown, so a task host disappearing is never exit proof. */
export interface NativeServiceProcessOwner {
  pid: number;
  alive(): Promise<boolean>;
  terminate(): Promise<void>;
}

export interface WindowsServiceProcess {
  pid: number;
  parentPid: number;
  startToken: string;
  executable: string;
  command: string;
}

interface WindowsServiceOwnerDeps {
  read(): Promise<WindowsServiceProcess[]>;
  terminate(processes: WindowsServiceProcess[]): Promise<void>;
  /** An unattended updater is itself a connector child; never end its branch. */
  excludePid?: number;
}

const environment = () => sanitizeInheritedChildProcessEnv({ env: process.env });
const samePath = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const sameIdentity = (a: WindowsServiceProcess, b: WindowsServiceProcess) => a.pid === b.pid && a.startToken === b.startToken && samePath(a.executable, b.executable) && a.command === b.command;
const uncertain = (message: string) => new RemoteInstanceError("temporarily_unavailable", message);

/** Find only a release connector whose complete parsed argv serves this root.
 * Task Scheduler's Ready state does not describe surviving child processes. */
export async function captureWindowsServiceOwner(root: string, deps: WindowsServiceOwnerDeps = { read: readWindowsServiceProcesses, terminate: terminateWindowsServiceProcesses }): Promise<NativeServiceProcessOwner | null> {
  const initial = await deps.read();
  const candidates = initial.filter(process => belongsToService(process, root));
  if (candidates.length > 1) throw uncertain("More than one connector serves this native root; refusing an ambiguous process stop.");
  const leader = candidates[0];
  if (!leader) return null;
  const callerPid = deps.excludePid ?? process.pid;
  if (leader.pid === callerPid) throw uncertain("A connector cannot terminate its own service process through this command.");
  if (!validStartToken(leader.startToken)) throw uncertain("The connector's creation identity cannot be verified; refusing an unproven process stop.");
  let excludePid = descendantOf(callerPid, leader, initial) ? callerPid : null;
  const owned = new Map<number, WindowsServiceProcess>([[leader.pid, leader]]);
  const observe = async (processes: WindowsServiceProcess[]) => {
    const byPid = new Map(processes.map(process => [process.pid, process]));
    if (excludePid === null && descendantOf(callerPid, leader, processes)) excludePid = callerPid;
    const excluded = new Set<number>(excludePid === null ? [] : [excludePid]);
    let excluding: boolean;
    do {
      excluding = false;
      for (const process of processes) {
        if (excluded.has(process.pid) || !excluded.has(process.parentPid)) continue;
        const parent = byPid.get(process.parentPid);
        if (parent && validStartToken(parent.startToken) && validStartToken(process.startToken) && BigInt(process.startToken) < BigInt(parent.startToken)) continue;
        excluded.add(process.pid);
        excluding = true;
      }
    } while (excluding);
    for (const expected of owned.values()) {
      const current = byPid.get(expected.pid);
      if (current && !sameIdentity(expected, current)) throw uncertain("The connector process identity changed; refusing to terminate a reused PID.");
    }
    if (processes.some(process => process.pid !== leader.pid && belongsToService(process, root))) throw uncertain("Another connector began serving this native root during shutdown; its stop remains unconfirmed.");
    // Include new descendants only below a positively matched owned parent.
    // After that parent disappears, keep the captured children individually.
    let changed: boolean;
    do {
      changed = false;
      for (const process of processes) {
        const parent = owned.get(process.parentPid);
        const observedParent = byPid.get(process.parentPid);
        if (excluded.has(process.pid) || owned.has(process.pid) || !parent || !observedParent || !sameIdentity(parent, observedParent)) continue;
        if (process.pid === callerPid) throw uncertain("The updater's process ancestry cannot be verified; refusing to terminate its own transaction.");
        if (!validStartToken(process.startToken) || !process.executable || !process.command) throw uncertain("A connector descendant cannot be identified safely; its stop remains unconfirmed.");
        // Windows retains numeric ParentProcessId after a parent has exited.
        // A child older than this matched parent belongs to a former PID owner.
        if (BigInt(process.startToken) < BigInt(parent.startToken)) continue;
        owned.set(process.pid, process);
        changed = true;
      }
    } while (changed);
    return [...owned.values()].filter(process => byPid.has(process.pid));
  };
  await observe(initial);
  return {
    pid: leader.pid,
    alive: async () => (await observe(await deps.read())).length > 0,
    terminate: async () => {
      const live = await observe(await deps.read());
      // Children first; their exact identities remain provable if the leader
      // exits, unlike taskkill /T rediscovering a tree below a reused PID.
      await deps.terminate(live.reverse());
      if ((await observe(await deps.read())).length) throw uncertain("The connector's process-tree exit remains unconfirmed.");
    },
  };
}

function validStartToken(value: string): boolean { return /^\d+$/.test(value) && BigInt(value) > 0n; }

function descendantOf(pid: number, leader: WindowsServiceProcess, processes: WindowsServiceProcess[]): boolean {
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const seen = new Set<number>();
  let child = byPid.get(pid);
  while (child && !seen.has(child.pid)) {
    seen.add(child.pid);
    const parent = byPid.get(child.parentPid);
    if (!parent || !validStartToken(child.startToken) || !validStartToken(parent.startToken) || BigInt(child.startToken) < BigInt(parent.startToken)) return false;
    if (sameIdentity(parent, leader)) return true;
    child = parent;
  }
  return false;
}

function belongsToService(process: WindowsServiceProcess, root: string): boolean {
  if (!Number.isSafeInteger(process.pid) || process.pid <= 1 || !process.executable || !process.command) return false;
  const relative = win32.relative(win32.join(root, "releases"), process.executable);
  const pieces = relative.split("\\");
  if (pieces.length !== 2 || !pieces[0] || pieces[0] === "." || pieces[0] === ".." || !nativeConnectorFileNames("windows").some(name => name.toLowerCase() === pieces[1]?.toLowerCase())) return false;
  const args = parseWindowsArguments(process.command);
  return args.length === 4 && samePath(args[0]!, process.executable) && args[1] === "serve" && args[2] === "--root" && samePath(args[3]!, root);
}

/** C runtime quoting, also used by the native executable's argv parser. */
function parseWindowsArguments(command: string): string[] {
  const result: string[] = [];
  let at = 0;
  while (at < command.length) {
    while (/\s/.test(command[at] ?? "") && at < command.length) at += 1;
    if (at === command.length) break;
    let value = "", quoted = false;
    while (at < command.length && (quoted || !/\s/.test(command[at]!))) {
      let slashes = 0;
      while (command[at] === "\\") { slashes += 1; at += 1; }
      if (command[at] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else if (quoted && command[at + 1] === '"') { value += '"'; at += 1; }
        else quoted = !quoted;
        at += 1;
      } else {
        value += "\\".repeat(slashes);
        if (at < command.length && (quoted || !/\s/.test(command[at]!))) { value += command[at]; at += 1; }
      }
    }
    if (quoted) return [];
    result.push(value);
  }
  return result;
}

async function runWindowsScript(script: string): Promise<string> {
  const result = await runCommand({ command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], env: environment(), timeoutMs: 20_000, outputCapBytes: 2 * 1024 * 1024 });
  if (result.code !== 0) throw uncertain("Windows could not verify this connector's process ownership; its stop remains unconfirmed.");
  return result.stdout;
}

/** CIM supplies executable/argv/parent; the kernel's start ticks fence PID reuse. */
async function readWindowsServiceProcesses(): Promise<WindowsServiceProcess[]> {
  const output = await runWindowsScript([
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
    "$records=@(Get-CimInstance Win32_Process)",
    "$items=@($records | ForEach-Object {",
    "  $record=$_; $process=Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue",
    "  $start=''; $path=[string]$record.ExecutablePath",
    "  if ($null -ne $process) { try { if ([string]$process.Path -eq $path) { $start=[string]$process.StartTime.ToUniversalTime().Ticks } } catch { } }",
    "  [pscustomobject]@{pid=[int]$record.ProcessId;parentPid=[int]$record.ParentProcessId;startToken=$start;executable=$path;command=[string]$record.CommandLine;creation=[string]$record.CreationDate.ToUniversalTime().Ticks}",
    "})",
    "$confirmed=@{}; Get-CimInstance Win32_Process | ForEach-Object { $confirmed[[int]$_.ProcessId]=$_ }",
    "$stable=@($items | ForEach-Object { $item=$_; $record=$confirmed[$item.pid]; if ($null -ne $record) { if ([string]$record.CreationDate.ToUniversalTime().Ticks -ne $item.creation -or [string]$record.CommandLine -cne $item.command -or [string]$record.ExecutablePath -ne $item.executable) { $item.startToken='' }; $item } } | Select-Object pid,parentPid,startToken,executable,command)",
    "$seen=@{}; $items | ForEach-Object { $seen[$_.pid]=$true }; foreach ($record in $confirmed.Values) { if (-not $seen.ContainsKey([int]$record.ProcessId)) { $stable += [pscustomobject]@{pid=[int]$record.ProcessId;parentPid=[int]$record.ParentProcessId;startToken='';executable=[string]$record.ExecutablePath;command=[string]$record.CommandLine} } }",
    "ConvertTo-Json -InputObject @($stable) -Compress",
  ].join("\n"));
  let processes: unknown;
  try { processes = JSON.parse(output.replace(/^\uFEFF/, "")); } catch { throw uncertain("Windows returned unreadable connector process ownership; its stop remains unconfirmed."); }
  if (!Array.isArray(processes) || processes.some(value => !value || typeof value !== "object" || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.parentPid) || typeof value.startToken !== "string" || typeof value.executable !== "string" || typeof value.command !== "string")) throw uncertain("Windows returned incomplete connector process ownership; its stop remains unconfirmed.");
  return processes as WindowsServiceProcess[];
}

async function terminateWindowsServiceProcesses(processes: WindowsServiceProcess[]): Promise<void> {
  if (!processes.length) return;
  await runWindowsScript(windowsServiceTerminationScript(processes));
}

/** Keep the Process object's original kernel handle through checks and Kill. */
export function windowsServiceTerminationScript(processes: WindowsServiceProcess[]): string {
  const encoded = Buffer.from(JSON.stringify(processes), "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    `$owners=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`,
    "foreach ($owner in $owners) {",
    "  $process=Get-Process -Id $owner.pid -ErrorAction SilentlyContinue",
    "  if ($null -eq $process) { continue }",
    "  try {",
    "  $handle=$process.Handle",
    "  $start=[string]$process.StartTime.ToUniversalTime().Ticks",
    "  $path=[string]$process.Path",
    "  $record=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner.pid)",
    "  if ($null -eq $record) { continue }",
    "  if ($start -ne $owner.startToken -or $path -ne $owner.executable -or $record.CommandLine -cne $owner.command) { throw 'process identity changed' }",
    // On Windows PowerShell/.NET Framework StartTime's temporary handle is
    // released. Accessing Handle explicitly caches it: Kill uses that pinned
    // kernel process, rather than reopening a possibly reused numeric PID.
    "  try { $process.Kill(); $process.WaitForExit(5000) | Out-Null } catch { if (-not $process.HasExited) { throw } }",
    "  } finally { $process.Dispose() }",
    "}",
  ].join("\n");
}
