import { win32 } from "node:path";
import type { NativeServiceCommand, NativeServiceDefinition } from "./service.js";

interface BackgroundInput { home: string; root: string; executable: string; label: string; userId: string }
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const argument = (value: string) => `"${value.replace(/(\\+)$/, "$1$1")}"`;
const command = (script: string): NativeServiceCommand => ({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] });

/** A user-login shortcut and a hidden, independently supervised connector. */
export function windowsBackgroundDefinition(input: BackgroundInput): NativeServiceDefinition {
  const helper = win32.join(input.home, "AppData", "Roaming", "Konteks", "background", `${input.label}.js`);
  const shortcut = win32.join(input.home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${input.label}.lnk`);
  const script = backgroundHost(input);
  const host = `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  const contents = `var shell = WScript.CreateObject("WScript.Shell");\nif (WScript.Arguments.length && WScript.Arguments(0) === "--login") shell.Environment("PROCESS")("KONTEKS_BACKGROUND_LOGIN") = "1";\nWScript.Quit(shell.Run(${JSON.stringify(host)}, 0, true));\n`;
  const context = backgroundContext(input, helper, shortcut);
  return {
    label: input.label, path: win32.join(input.root, "service.json"), requiresLinger: false,
    windowsBackground: true, legacyPath: win32.join(input.root, "service.xml"),
    contents: JSON.stringify({ kind: "windows-login-background", version: 1, executable: input.executable, helper, shortcut }) + "\n",
    supportFiles: [{ path: helper, contents }],
    install: [command(context + installStartup())],
    start: command(context + startHost()),
    stop: command(context + stopHost()),
    remove: [command(context + removeStartup())],
    status: command(context + "if (HostRunning) { exit 0 }; exit 1"),
    registered: command(context + "if (StartupCurrent) { exit 0 }; exit 1"),
    handoff: pid => command(context + startHost(pid)),
  };
}

function backgroundContext(input: BackgroundInput, helper: string, shortcut: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$root = ${literal(input.root)}`,
    `$label = ${literal(input.label)}`,
    `$userId = ${literal(input.userId)}`,
    `$helper = ${literal(helper)}`,
    `$shortcut = ${literal(shortcut)}`,
    "$program = Join-Path $env:SystemRoot 'System32\\wscript.exe'",
    `$arguments = ${literal(`//B //NoLogo //E:JScript ${argument(helper)}`)}`,
    "$loginArguments = $arguments + ' --login'",
    `$legacyArguments = ${literal(`//B //NoLogo //E:JScript ${argument(win32.join(input.root, "service.js"))}`)}`,
    "$state = Join-Path $root 'supervisor\\background-host.json'",
    "$stop = Join-Path $root 'supervisor\\background-stop'",
    "function HostRunning {",
    "  if (-not [IO.File]::Exists($state)) { return $false }",
    "  try { $owner = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json } catch { return $false }",
    "  try { $process = [Diagnostics.Process]::GetProcessById([int]$owner.pid) } catch [ArgumentException] { return $false }",
    "  try { return $process.StartTime.ToUniversalTime().Ticks.ToString() -ceq $owner.started } catch [InvalidOperationException] { return $false }",
    "}",
    "function StartupCurrent {",
    "  if (-not [IO.File]::Exists($shortcut)) { return $false }",
    "  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)",
    "  return $link.TargetPath -ieq $program -and $link.Arguments -ceq $loginArguments",
    "}",
    legacyTaskProbe(),
    "",
  ].join("\n");
}

/** Migration touches only the hashed task whose principal and action match this root. */
function legacyTaskProbe(): string {
  return [
    "function LegacyTask {",
    "  if (-not [IO.File]::Exists((Join-Path $root 'service.xml'))) { return $null }",
    "  try { $task = Get-ScheduledTask -TaskPath '\\' -TaskName $label -ErrorAction Stop } catch {",
    "    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return $null }; throw",
    "  }",
    "  $sid = $task.Principal.UserId",
    "  if ($sid -notlike 'S-1-*') { $sid = (New-Object Security.Principal.NTAccount($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }",
    "  if ($sid -ne $userId) { throw 'The legacy Konteks task belongs to another Windows user.' }",
    "  $actions = @($task.Actions)",
    "  if ($actions.Count -ne 1) { throw 'The legacy Konteks task has an unexpected action.' }",
    "  $action = $actions[0]",
    "  $exe = $action.Execute",
    "  $isHelper = [Environment]::ExpandEnvironmentVariables($exe) -ieq $program -and $action.Arguments -ceq $legacyArguments",
    "  $isConnector = $exe.StartsWith(($root.TrimEnd('\\') + '\\releases\\'), [StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($exe) -in @('connector.exe','konteks-connector.exe'))",
    "  $quotedRoot = [string][char]34 + $root + [char]34",
    "  $isRoot = $action.Arguments -ieq ('serve --root ' + $quotedRoot) -or $action.Arguments -ieq ('serve --root ' + $root)",
    "  if (-not ($isHelper -or ($isConnector -and $isRoot))) { throw 'The legacy task does not launch this Konteks root; it was preserved.' }",
    "  return $task",
    "}",
  ].join("\n");
}

function installStartup(): string {
  return [
    "$legacy = LegacyTask",
    "if ([IO.File]::Exists($shortcut) -and -not (StartupCurrent)) { throw 'The login shortcut belongs to another program; it was preserved.' }",
    "$previous = if ([IO.File]::Exists($shortcut)) { [IO.File]::ReadAllBytes($shortcut) } else { $null }",
    "try {",
    "  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($shortcut))",
    "  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)",
    "  $link.TargetPath = $program; $link.Arguments = $loginArguments; $link.WorkingDirectory = [IO.Path]::GetDirectoryName($helper); $link.Save()",
    "  if ($legacy) { Unregister-ScheduledTask -InputObject $legacy -Confirm:$false -ErrorAction Stop }",
    "  try { [IO.File]::Delete((Join-Path $root 'service.xml')) } catch { Write-Warning 'Legacy task removed; its metadata could not be cleaned up.' }",
    "} catch {",
    "  if ($null -ne $previous) { [IO.File]::WriteAllBytes($shortcut, $previous) } else { [IO.File]::Delete($shortcut) }",
    "  throw",
    "}",
  ].join("\n");
}

function startHost(waitPid?: number): string {
  const defer = waitPid === undefined ? [] : [
    `$waiting = [Diagnostics.Process]::GetProcessById(${waitPid})`,
    "$env:KONTEKS_BACKGROUND_WAIT_PID = $waiting.Id.ToString()",
    "$env:KONTEKS_BACKGROUND_WAIT_STARTED = $waiting.StartTime.ToUniversalTime().Ticks.ToString()",
  ];
  return [
    "if (HostRunning) { exit 0 }",
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stop))",
    "[IO.File]::Delete($stop)",
    ...defer,
    "$start = New-Object Diagnostics.ProcessStartInfo",
    "$start.FileName = $program; $start.Arguments = $arguments; $start.UseShellExecute = $false; $start.CreateNoWindow = $true",
    "[void][Diagnostics.Process]::Start($start)",
    "$deadline = [DateTime]::UtcNow.AddSeconds(20)",
    "do { if (HostRunning) { exit 0 }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)",
    "throw 'The hidden Konteks background host did not become ready.'",
  ].join("\n");
}

function stopHost(): string {
  return [
    "$legacy = LegacyTask",
    "if ($legacy) { Disable-ScheduledTask -InputObject $legacy -ErrorAction Stop | Out-Null }",
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stop))",
    "[IO.File]::WriteAllText($stop, 'stop')",
  ].join("\n");
}

function removeStartup(): string {
  return [
    "if ([IO.File]::Exists($shortcut) -and -not (StartupCurrent)) { throw 'The login shortcut belongs to another program; it was preserved.' }",
    "$legacy = LegacyTask",
    "if ($legacy) { Unregister-ScheduledTask -InputObject $legacy -Confirm:$false -ErrorAction Stop }",
    "if ([IO.File]::Exists($shortcut)) { [IO.File]::Delete($shortcut) }",
    "if ([IO.File]::Exists($helper)) { [IO.File]::Delete($helper) }",
  ].join("\n");
}

/** File ownership prevents duplicate watchdogs across login sessions. */
function backgroundHost(input: BackgroundInput): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$root = ${literal(input.root)}`,
    `$env:KONTEKS_SERVICE_PROGRAM = ${literal(input.executable)}`,
    `$env:KONTEKS_SERVICE_ROOT = ${literal(input.root.replace(/(\\+)$/, "$1$1"))}`,
    "$log = Join-Path $root 'logs\\connector.log'",
    "$env:KONTEKS_SERVICE_LOG = $log",
    "$state = Join-Path $root 'supervisor\\background-host.json'",
    "$stop = Join-Path $root 'supervisor\\background-stop'",
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($state))",
    "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($log))",
    "try { $lock = [IO.File]::Open((Join-Path $root 'supervisor\\background-host.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch [IO.IOException] { exit 0 }",
    "$owner = @{ pid = $PID; started = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString() }",
    "[IO.File]::WriteAllText($state, ($owner | ConvertTo-Json -Compress))",
    "if ($env:KONTEKS_BACKGROUND_LOGIN -eq '1') { [IO.File]::Delete($stop) }",
    "Remove-Item Env:KONTEKS_BACKGROUND_LOGIN -ErrorAction SilentlyContinue",
    "try {",
    waitForPrevious(),
    connectorLoop(),
    "} finally { [IO.File]::Delete($state); $lock.Dispose() }",
  ].join("\n");
}

function waitForPrevious(): string {
  return [
    "  if ($env:KONTEKS_BACKGROUND_WAIT_PID) {",
    "    try {",
    "      $previous = [Diagnostics.Process]::GetProcessById([int]$env:KONTEKS_BACKGROUND_WAIT_PID)",
    "      if ($previous.StartTime.ToUniversalTime().Ticks.ToString() -ceq $env:KONTEKS_BACKGROUND_WAIT_STARTED) {",
    "        while (-not $previous.WaitForExit(200)) { if ([IO.File]::Exists($stop)) { exit 0 } }",
    "      }",
    "    } catch [ArgumentException] { } catch [InvalidOperationException] { }",
    "  }",
    "  Remove-Item Env:KONTEKS_BACKGROUND_WAIT_PID, Env:KONTEKS_BACKGROUND_WAIT_STARTED -ErrorAction SilentlyContinue",
  ].join("\n");
}

function connectorLoop(): string {
  return [
    "  $delay = 1",
    "  while (-not [IO.File]::Exists($stop)) {",
    "    $started = [DateTime]::UtcNow",
    "    try {",
    "      if ([IO.File]::Exists($log) -and (New-Object IO.FileInfo($log)).Length -gt 20971520) { [IO.File]::Delete($log + '.1'); [IO.File]::Move($log, $log + '.1') }",
    "      $start = New-Object Diagnostics.ProcessStartInfo",
    "      $start.FileName = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    "      $start.Arguments = '/d /v:off /s /c \"\"%KONTEKS_SERVICE_PROGRAM%\" serve --root \"%KONTEKS_SERVICE_ROOT%\" >> \"%KONTEKS_SERVICE_LOG%\" 2>&1\"'",
    "      $start.UseShellExecute = $false; $start.CreateNoWindow = $true",
    "      $child = [Diagnostics.Process]::Start($start)",
    "      $child.WaitForExit()",
    "      if ($child.ExitCode -eq 0) { break }",
    "    } catch {",
    "      $entry = @{ level = 50; time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); msg = 'Konteks background launch failed: ' + $_.Exception.Message } | ConvertTo-Json -Compress",
    "      [IO.File]::AppendAllText($log, $entry + [Environment]::NewLine)",
    "    }",
    "    if (([DateTime]::UtcNow - $started).TotalSeconds -ge 60) { $delay = 1 }",
    "    $retryAt = [DateTime]::UtcNow.AddSeconds($delay)",
    "    while ([DateTime]::UtcNow -lt $retryAt -and -not [IO.File]::Exists($stop)) { Start-Sleep -Milliseconds 100 }",
    "    $delay = [Math]::Min(60, $delay * 2)",
    "  }",
  ].join("\n");
}
