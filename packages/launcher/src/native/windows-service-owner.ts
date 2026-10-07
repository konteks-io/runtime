import { win32 } from "node:path";
import { RemoteInstanceError, runCommand, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";
import { setupDuration, setupLine } from "../setup-locale.js";
import { nativeConnectorFileNames } from "@konteks/remote-release";
import { serviceRun, type NativeServiceDefinition, type NativeServiceExecute } from "./service.js";

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
 * The background host's state does not describe surviving child processes. */
export async function captureWindowsServiceOwner(root: string, deps: WindowsServiceOwnerDeps = { read: readWindowsServiceProcesses, terminate: terminateWindowsServiceProcesses }): Promise<NativeServiceProcessOwner | null> {
  const initial = await deps.read();
  const leader = serviceLeader(root, initial);
  if (!leader) return null;
  return new WindowsServiceOwner(root, leader, deps, initial);
}

function serviceLeader(root: string, processes: WindowsServiceProcess[]): WindowsServiceProcess | null {
  const candidates = processes.filter(process => belongsToService(process, root));
  if (candidates.length > 1) throw uncertain("More than one connector serves this native root; refusing an ambiguous process stop.");
  return candidates[0] ?? null;
}

class WindowsServiceOwner implements NativeServiceProcessOwner {
  readonly pid: number;
  private readonly callerPid: number;
  private excludePid: number | null = null;
  private readonly owned = new Map<number, WindowsServiceProcess>();

  constructor(private readonly root: string, private readonly leader: WindowsServiceProcess, private readonly deps: WindowsServiceOwnerDeps, initial: WindowsServiceProcess[]) {
    this.pid = leader.pid;
    this.callerPid = deps.excludePid ?? process.pid;
    if (leader.pid === this.callerPid) throw uncertain("A connector cannot terminate its own service process through this command.");
    if (!validStartToken(leader.startToken)) throw uncertain("The connector's creation identity cannot be verified; refusing an unproven process stop.");
    this.owned.set(leader.pid, leader);
    this.observe(initial);
  }

  async alive(): Promise<boolean> {
    return this.observe(await this.deps.read()).length > 0;
  }

  async terminate(): Promise<void> {
    const live = this.observe(await this.deps.read());
    // Children first; captured identities survive an exited leader.
    await this.deps.terminate(live.reverse());
    if (this.observe(await this.deps.read()).length) throw uncertain("The connector's process-tree exit remains unconfirmed.");
  }

  private observe(processes: WindowsServiceProcess[]): WindowsServiceProcess[] {
    const byPid = new Map(processes.map(process => [process.pid, process]));
    this.learnCallerBranch(processes);
    this.assertIdentities(byPid);
    this.assertSameService(processes);
    this.adoptDescendants(processes, byPid, excludedBranch(this.excludePid, processes, byPid));
    return [...this.owned.values()].filter(process => byPid.has(process.pid));
  }

  private learnCallerBranch(processes: WindowsServiceProcess[]): void {
    if (this.excludePid === null && descendantOf(this.callerPid, this.leader, processes)) this.excludePid = this.callerPid;
  }

  private assertIdentities(byPid: Map<number, WindowsServiceProcess>): void {
    for (const expected of this.owned.values()) {
      const current = byPid.get(expected.pid);
      if (current && !sameIdentity(expected, current)) throw uncertain("The connector process identity changed; refusing to terminate a reused PID.");
    }
  }

  private assertSameService(processes: WindowsServiceProcess[]): void {
    if (processes.some(process => process.pid !== this.pid && belongsToService(process, this.root))) throw uncertain("Another connector began serving this native root during shutdown; its stop remains unconfirmed.");
  }

  private adoptDescendants(processes: WindowsServiceProcess[], byPid: Map<number, WindowsServiceProcess>, excluded: Set<number>): void {
    let changed: boolean;
    do {
      changed = false;
      for (const process of processes) if (this.adopt(process, byPid, excluded)) changed = true;
    } while (changed);
  }

  private adopt(process: WindowsServiceProcess, byPid: Map<number, WindowsServiceProcess>, excluded: Set<number>): boolean {
    if (excluded.has(process.pid) || this.owned.has(process.pid)) return false;
    const parent = this.matchingParent(process.parentPid, byPid);
    if (!parent) return false;
    if (process.pid === this.callerPid) throw uncertain("The updater's process ancestry cannot be verified; refusing to terminate its own transaction.");
    if (!verifiedDescendant(process, parent)) return false;
    this.owned.set(process.pid, process);
    return true;
  }

  private matchingParent(pid: number, byPid: Map<number, WindowsServiceProcess>): WindowsServiceProcess | null {
    const parent = this.owned.get(pid);
    const current = byPid.get(pid);
    if (!parent || !current || !sameIdentity(parent, current)) return null;
    return parent;
  }
}

function validStartToken(value: string): boolean { return /^\d+$/.test(value) && BigInt(value) > 0n; }

function descendantOf(pid: number, leader: WindowsServiceProcess, processes: WindowsServiceProcess[]): boolean {
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const seen = new Set<number>();
  let child = byPid.get(pid);
  while (child && !seen.has(child.pid)) {
    seen.add(child.pid);
    const parent = byPid.get(child.parentPid);
    if (!validParent(child, parent)) return false;
    if (sameIdentity(parent!, leader)) return true;
    child = parent;
  }
  return false;
}

function validParent(child: WindowsServiceProcess, parent: WindowsServiceProcess | undefined): boolean {
  if (!parent) return false;
  return validStartToken(child.startToken) && validStartToken(parent.startToken) && BigInt(child.startToken) >= BigInt(parent.startToken);
}

function verifiedDescendant(child: WindowsServiceProcess, parent: WindowsServiceProcess): boolean {
  if (!validStartToken(child.startToken) || !child.executable || !child.command) throw uncertain("A connector descendant cannot be identified safely; its stop remains unconfirmed.");
  return BigInt(child.startToken) >= BigInt(parent.startToken);
}

function excludedBranch(pid: number | null, processes: WindowsServiceProcess[], byPid: Map<number, WindowsServiceProcess>): Set<number> {
  const excluded = new Set<number>(pid === null ? [] : [pid]);
  let changed: boolean;
  do { changed = addExcludedChildren(excluded, processes, byPid); } while (changed);
  return excluded;
}

function addExcludedChildren(excluded: Set<number>, processes: WindowsServiceProcess[], byPid: Map<number, WindowsServiceProcess>): boolean {
  let changed = false;
  for (const child of processes) {
    if (excluded.has(child.pid) || !excluded.has(child.parentPid)) continue;
    const parent = byPid.get(child.parentPid);
    if (predatesParent(child, parent)) continue;
    excluded.add(child.pid);
    changed = true;
  }
  return changed;
}

function predatesParent(child: WindowsServiceProcess, parent: WindowsServiceProcess | undefined): boolean {
  if (!parent) return false;
  if (!validStartToken(child.startToken) || !validStartToken(parent.startToken)) return false;
  return BigInt(child.startToken) < BigInt(parent.startToken);
}

function belongsToService(process: WindowsServiceProcess, root: string): boolean {
  if (!hasServiceCommand(process)) return false;
  return releaseConnector(process.executable, root) && servesRoot(process, root);
}

function hasServiceCommand(process: WindowsServiceProcess): boolean {
  return Number.isSafeInteger(process.pid) && process.pid > 1 && !!process.executable && !!process.command;
}

function releaseConnector(executable: string, root: string): boolean {
  const relative = win32.relative(win32.join(root, "releases"), executable);
  const pieces = relative.split("\\");
  if (pieces.length !== 2 || !pieces[0] || pieces[0] === "." || pieces[0] === "..") return false;
  return nativeConnectorFileNames("windows").some(name => name.toLowerCase() === pieces[1]!.toLowerCase());
}

function servesRoot(process: WindowsServiceProcess, root: string): boolean {
  const args = parseWindowsArguments(process.command);
  return args.length === 4 && samePath(args[0]!, process.executable) && args[1] === "serve" && args[2] === "--root" && samePath(args[3]!, root);
}

/** C runtime quoting, also used by the native executable's argv parser. */
function parseWindowsArguments(command: string): string[] {
  return new WindowsArguments(command).parse();
}

class WindowsArguments {
  private at = 0;
  private value = "";
  private quoted = false;
  constructor(private readonly command: string) {}

  parse(): string[] {
    const result: string[] = [];
    while (this.at < this.command.length) {
      this.skipWhitespace();
      if (this.at === this.command.length) break;
      const argument = this.argument();
      if (argument === null) return [];
      result.push(argument);
    }
    return result;
  }

  private skipWhitespace(): void {
    while (this.at < this.command.length && /\s/.test(this.command[this.at]!)) this.at += 1;
  }

  private argument(): string | null {
    this.value = "";
    this.quoted = false;
    while (this.hasCharacter()) this.character();
    return this.quoted ? null : this.value;
  }

  private hasCharacter(): boolean {
    return this.at < this.command.length && (this.quoted || !/\s/.test(this.command[this.at]!));
  }

  private character(): void {
    let slashes = 0;
    while (this.command[this.at] === "\\") { slashes += 1; this.at += 1; }
    if (this.command[this.at] === '"') return this.quote(slashes);
    this.value += "\\".repeat(slashes);
    if (this.hasCharacter()) { this.value += this.command[this.at]; this.at += 1; }
  }

  private quote(slashes: number): void {
    this.value += "\\".repeat(Math.floor(slashes / 2));
    if (slashes % 2) this.value += '"';
    else if (this.quoted && this.command[this.at + 1] === '"') { this.value += '"'; this.at += 1; }
    else this.quoted = !this.quoted;
    this.at += 1;
  }
}

async function runWindowsScript(script: string): Promise<string> {
  const result = await runCommand({ command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], env: environment(), timeoutMs: 20_000, outputCapBytes: 2 * 1024 * 1024 });
  if (result.code !== 0) throw uncertain("Windows could not verify this connector's process ownership; its stop remains unconfirmed.");
  return result.stdout;
}

/** CIM supplies executable/argv/parent; the kernel's start ticks fence PID reuse. */
async function readWindowsServiceProcesses(): Promise<WindowsServiceProcess[]> {
  const output = await runWindowsScript(windowsServiceProcessQueryScript());
  let processes: unknown;
  try { processes = JSON.parse(output.replace(/^\uFEFF/, "")); } catch { throw uncertain("Windows returned unreadable connector process ownership; its stop remains unconfirmed."); }
  if (!Array.isArray(processes) || processes.some(value => !processRecord(value))) throw uncertain("Windows returned incomplete connector process ownership; its stop remains unconfirmed.");
  return processes as WindowsServiceProcess[];
}

/** Two CIM snapshots retain a replacement's argv while refusing its unverified creation identity. */
export function windowsServiceProcessQueryScript(): string {
  return [
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
    "$stable=@($items | ForEach-Object { $item=$_; $record=$confirmed[$item.pid]; if ($null -ne $record) { if ([string]$record.CreationDate.ToUniversalTime().Ticks -ne $item.creation -or [string]$record.CommandLine -cne $item.command -or [string]$record.ExecutablePath -ne $item.executable) { $item.startToken=''; $item.parentPid=[int]$record.ParentProcessId; $item.executable=[string]$record.ExecutablePath; $item.command=[string]$record.CommandLine }; $item } } | Select-Object pid,parentPid,startToken,executable,command)",
    "$seen=@{}; $items | ForEach-Object { $seen[$_.pid]=$true }; foreach ($record in $confirmed.Values) { if (-not $seen.ContainsKey([int]$record.ProcessId)) { $stable += [pscustomobject]@{pid=[int]$record.ProcessId;parentPid=[int]$record.ParentProcessId;startToken='';executable=[string]$record.ExecutablePath;command=[string]$record.CommandLine} } }",
    "ConvertTo-Json -InputObject @($stable) -Compress",
  ].join("\n");
}

function processRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WindowsServiceProcess>;
  return Number.isSafeInteger(record.pid) && Number.isSafeInteger(record.parentPid) && processRecordText(record);
}

function processRecordText(record: Partial<WindowsServiceProcess>): boolean {
  return typeof record.startToken === "string" && typeof record.executable === "string" && typeof record.command === "string";
}

/** Disable restarts even when the watchdog is between connector runs. */
export async function stopWindowsBackgroundHost(definition: NativeServiceDefinition, execute: NativeServiceExecute): Promise<void> {
  if (serviceRun(await execute(definition.stop)).code !== 0) throw uncertain("Windows could not stop this connector's background host; its processes were preserved.");
}

interface WindowsServiceStopDeps {
  execute: NativeServiceExecute;
  sleep(ms: number): Promise<void>;
  now(): number;
  stopDeadlineMs?: number;
  stopGraceMs?: number;
  pollMs?: number;
  waiting?: () => void;
}

/** Wait for graceful exit, then end only the captured tree after its grace. */
export function waitForWindowsServiceExit(owner: NativeServiceProcessOwner | null, definition: NativeServiceDefinition, deps: WindowsServiceStopDeps, output: { line(text: string): void }): Promise<void> {
  return new WindowsServiceExitWait(owner, definition, deps, output).run();
}

class WindowsServiceExitWait {
  private readonly started: number;
  private readonly deadlineMs: number;
  private readonly graceMs: number;
  private forced = false;
  constructor(private readonly owner: NativeServiceProcessOwner | null, private readonly definition: NativeServiceDefinition, private readonly deps: WindowsServiceStopDeps, private readonly output: { line(text: string): void }) {
    this.started = deps.now();
    this.deadlineMs = deps.stopDeadlineMs ?? 90_000;
    this.graceMs = Math.min(deps.stopGraceMs ?? 30_000, this.deadlineMs);
  }

  async run(): Promise<void> {
    for (;;) {
      if (await this.exited()) return;
      if (await this.forceAfterGrace()) continue;
      if (this.deps.now() >= this.started + this.deadlineMs) throw uncertain("The native runtime did not finish stopping in time; its installation was not changed.");
      this.deps.waiting?.();
      await this.deps.sleep(Math.min(this.deps.pollMs ?? 1_000, 1_000));
    }
  }

  private async exited(): Promise<boolean> {
    if (this.owner && await this.owner.alive()) return false;
    await stopWindowsBackgroundHost(this.definition, this.deps.execute);
    return serviceRun(await this.deps.execute(this.definition.status)).code === 1;
  }

  private async forceAfterGrace(): Promise<boolean> {
    if (this.forced || this.deps.now() - this.started < this.graceMs) return false;
    setupLine(this.output, "updateForceStop", { duration: setupDuration(this.output, this.graceMs) });
    await stopWindowsBackgroundHost(this.definition, this.deps.execute);
    await this.owner?.terminate();
    this.forced = true;
    return true;
  }
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
