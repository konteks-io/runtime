import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The connector's own log in `<root>/logs`, where the OS keeps none (macOS); the supervisor keeps it small. */
export const CONNECTOR_LOG_FILE = "connector.log";
/** The host operating systems a native connector runs on. */
export type HostOs = "macos" | "windows" | "debian";

export interface NativePlatform {
  os: HostOs;
  architecture: "amd64" | "arm64";
  containerBackend: "none";
  deploymentKind: "native_connector";
}

const HOST_OS: Partial<Record<NodeJS.Platform, HostOs>> = { darwin: "macos", win32: "windows", linux: "debian" };

export function nativePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): NativePlatform {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported native architecture ${arch}`);
  const os = HOST_OS[platform];
  if (!os) throw new Error(`unsupported native platform ${platform}`);
  return { os, architecture: arch === "x64" ? "amd64" : "arm64", containerBackend: "none", deploymentKind: "native_connector" };
}

/** The connector's private folder: no database, domain runtime, browser, or gateway. */
export function nativePaths(input: { os: HostOs; home?: string; root?: string }) {
  const path = input.os === "windows" ? win32 : posix;
  const home = input.home ?? homedir();
  const root = input.root ?? (input.os === "macos"
    ? path.join(home, "Library", "Application Support", "konteks-remote")
    : input.os === "windows" ? path.join(home, "AppData", "Local", "konteks-remote")
      : path.join(home, ".local", "share", "konteks-remote"));
  assertPath(root, input.os);
  return {
    root,
    supervisorData: path.join(root, "supervisor"),
    releases: path.join(root, "releases"),
    bin: path.join(root, "bin"),
    logs: path.join(root, "logs"),
    scratch: path.join(root, "scratch"),
    installState: path.join(root, "native-install.json"),
    credentials(agentId: string) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) throw new Error("invalid agent id");
      return path.join(root, "credentials", agentId);
    },
  };
}

export interface NativeServiceCommand { command: string; args: string[] }
export interface NativeServiceDefinition {
  label: string;
  path: string;
  contents: string;
  /** Windows Task Scheduler imports UTF-16LE XML; other managers use UTF-8. */
  fileEncoding?: "utf16le";
  /** Private launch helpers, written before the service is registered. */
  supportFiles?: readonly { path: string; contents: string }[];
  install: NativeServiceCommand[];
  start: NativeServiceCommand;
  stop: NativeServiceCommand;
  remove: NativeServiceCommand[];
  /**
   * Exits 0 only while the service is RUNNING, never merely registered:
   * `start` returns early on it, and the update transaction waits on it for a
   * stopped service to exit.
   */
  status: NativeServiceCommand;
  /** Exits 0 while the service is registered, running or not; only where `status` cannot say it (Windows), so `serve` can register a missing task. */
  registered?: NativeServiceCommand;
  /** Reads how often the OS has started the service and how it last exited (`parseServiceExits`); absent where the OS does not say. */
  exits?: NativeServiceCommand;
  /** User services on Linux need linger to survive logout/reboot without a login. */
  requiresLinger: boolean;
  /** Reads the definition the service manager has loaded and the pid it runs (`parseLoadedService`); absent where the OS does not say. */
  inspect?: NativeServiceCommand;
  /** What the loaded definition must name to be this one. */
  expected?: { program: string; logFile: string | null };
  /** Makes the service manager load this definition and restart the service onto it; absent where it applies only from the next start. */
  reload?: NativeServiceReload;
}

/**
 * A service manager reads a definition only when it loads it: launchd at
 * `bootstrap` (a KeepAlive respawn and `kickstart -k` reuse the loaded copy),
 * systemd at `daemon-reload`. Rewriting the file while the service runs
 * changes nothing until it is loaded again (RCA 2026-10-01: an updated
 * connector ran with stdout on /dev/null after the update, because the
 * install launcher had loaded a plist without the log file).
 */
export type NativeServiceReload =
  /** Run here in order; the service manager then restarts the service, this process included. */
  | { kind: "inline"; commands: NativeServiceCommand[] }
  /** Stops this very process with the service, so it runs in a session of its own with its output appended to `logFile`. */
  | { kind: "detached"; command: NativeServiceCommand; logFile: string };

/**
 * Bootout, wait until launchd has let go of the job, bootstrap again. `$1` is
 * the job, `$2` its domain, `$3` the plist: paths are arguments, never part of
 * the script. Lines are pino-shaped so the connector log stays one format.
 */
const LAUNCHD_RELOAD_SCRIPT = [
  "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
  "say() { printf '{\"level\":%s,\"time\":%s000,\"msg\":\"%s\"}\\n' \"$1\" \"$(date +%s)\" \"$2\"; }",
  "say 30 \"reloading the launch agent so launchd runs this release's definition\"",
  "launchctl bootout \"$1\"",
  "n=0; while launchctl print \"$1\" >/dev/null 2>&1; do n=$((n+1)); [ \"$n\" -ge 120 ] && break; sleep 1; done",
  "n=0; until launchctl bootstrap \"$2\" \"$3\"; do n=$((n+1)); if [ \"$n\" -ge 60 ]; then say 50 \"launchd did not load the launch agent again; konteks-remote start starts it\"; exit 1; fi; sleep 2; done",
  "say 30 \"launch agent reloaded\"",
].join("\n");

/** Seconds launchd waits after SIGTERM before SIGKILL; above the connector's 15 s shutdown watchdog. */
const LAUNCHD_EXIT_TIMEOUT_SECONDS = 30;

/**
 * The bytes of a definition file, the one encoding every writer uses: Task
 * Scheduler reads UTF-16LE with a byte-order mark, the others UTF-8. A task
 * file in any other encoding is refused by `schtasks /Create` with "unable to
 * switch the encoding" (D129: 0.10.9 and older wrote UTF-8, and a failed
 * refresh put a decoded copy back re-encoded under its old declaration).
 */
export function encodeServiceDefinition(definition: Pick<NativeServiceDefinition, "contents" | "fileEncoding">): Buffer {
  return definition.fileEncoding === "utf16le"
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(definition.contents, "utf16le")])
    : Buffer.from(definition.contents, "utf8");
}

/** How a service command ended, with what it printed, so a failure can say why. */
export interface NativeServiceRun { code: number | null; stdout?: string; stderr?: string; error?: string; timedOut?: boolean }
/** A service command runner: a bare exit code, or the whole outcome. */
export type NativeServiceExecute = (command: NativeServiceCommand) => Promise<number | null | NativeServiceRun>;
type NativeServiceStep = "status" | "write" | "register" | "start" | "stop";

export function serviceRun(value: number | null | NativeServiceRun): NativeServiceRun {
  return value !== null && typeof value === "object" ? value : { code: value };
}

const EXCERPT_LIMIT = 300;

/** The service manager's own words, bounded: stderr first, stdout when stderr is empty. */
function serviceOutputExcerpt(run: NativeServiceRun): string {
  const text = (run.stderr?.trim() || run.stdout?.trim() || "").replace(/\s+/g, " ");
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT - 1)}…` : text;
}

/** `schtasks.exe /Create`, `launchctl bootstrap`, `systemctl enable`: the command and its verb, never its paths. */
function serviceCommandName(command: NativeServiceCommand): string {
  const verb = command.args.find(arg => /^\/?[A-Za-z][A-Za-z-]*$/.test(arg) && !arg.startsWith("-"));
  return verb ? `${command.command} ${verb}` : command.command;
}

/**
 * A service command that failed, or a definition file that could not be
 * written: which one, how it ended and what it printed (D129). The message
 * never carries a secret: the commands are fixed and take only paths and the
 * task label.
 */
export class NativeServiceCommandError extends Error {
  readonly excerpt: string;
  constructor(
    readonly step: NativeServiceStep,
    readonly command: NativeServiceCommand | null,
    readonly run: NativeServiceRun,
    readonly path?: string,
  ) {
    const excerpt = serviceOutputExcerpt(run);
    const name = command ? serviceCommandName(command) : `writing ${path ?? "the service definition"}`;
    super(`${name} ${serviceRunEnding(run, command !== null)}${excerpt && !run.error ? `: ${excerpt}` : ""}`);
    this.name = "NativeServiceCommandError";
    this.excerpt = excerpt;
  }
}

function serviceRunEnding(run: NativeServiceRun, ran: boolean): string {
  if (run.error) return `${ran ? "could not be run" : "failed"}: ${run.error}`;
  if (run.timedOut) return "did not finish in time";
  return run.code === null ? "ended without an exit code" : `exited ${run.code}`;
}

/** A failed service step in plain words, with the one next step where it can be known. */
export function describeServiceFailure(os: HostOs, error: NativeServiceCommandError): string {
  const output = `${error.run.stderr ?? ""}\n${error.run.stdout ?? ""}`;
  const what = error.step === "write"
    ? `The service definition could not be written to ${error.path ?? "its folder"} (${error.run.error ?? "unknown error"}).`
    : `${serviceStepWords(os, error.step)} (${error.message}).`;
  return `${what} ${serviceNextStep(os, error, output)}`;
}

/** What a failed step means on each service manager; `status` is the fallback for any other step. */
const SERVICE_STEP_WORDS: Readonly<Record<HostOs, Partial<Record<NativeServiceStep, string>> & { status: string }>> = {
  windows: {
    register: "Windows refused to create the Konteks task",
    start: "Windows did not run the Konteks task",
    stop: "Windows did not end the Konteks task",
    status: "Windows could not say whether the Konteks task is running",
  },
  macos: {
    register: "macOS did not load the Konteks launch agent",
    start: "macOS did not load the Konteks launch agent",
    stop: "macOS did not unload the Konteks launch agent",
    status: "macOS could not say whether the Konteks launch agent is running",
  },
  debian: {
    register: "systemd did not reload its user services",
    start: "systemd did not start the Konteks user service",
    stop: "systemd did not stop the Konteks user service",
    status: "systemd could not say whether the Konteks user service is running",
  },
};

function serviceStepWords(os: HostOs, step: NativeServiceStep): string {
  const words = SERVICE_STEP_WORDS[os];
  return words[step] ?? words.status;
}

/** What the service manager printed, read for the one next step it points to. */
const SERVICE_REMEDIES: ReadonlyArray<{ os: HostOs; output: RegExp; next: string }> = [
  { os: "windows", output: /access is denied/i, next: "Run konteks-remote start once from an administrator PowerShell (right-click PowerShell, Run as administrator); Konteks still runs as you." },
  { os: "windows", output: /malformed|incorrectly formatted|out of range|switch the encoding/i, next: "This copy of konteks-remote wrote a task Windows does not accept; run konteks-remote update, then konteks-remote start. If it stays, send konteks-remote support to Konteks support." },
  { os: "windows", output: /service is not available|not running|0x80041315/i, next: "Start the Task Scheduler service (services.msc), then run konteks-remote start again." },
  { os: "macos", output: /Input\/output error|already loaded|service already/i, next: "Run konteks-remote stop, then konteks-remote start." },
];

function serviceNextStep(os: HostOs, error: NativeServiceCommandError, output: string): string {
  if (error.run.timedOut) return "Run konteks-remote start again; if it keeps timing out, restart the computer.";
  const remedy = SERVICE_REMEDIES.find(entry => entry.os === os && entry.output.test(output));
  if (remedy) return remedy.next;
  if (error.step === "write") return "Check that this folder is yours and the disk has space, then run konteks-remote start again.";
  return "To see every step, run konteks-remote --verbose start.";
}

/**
 * Register and start the service from its definition unless it is already
 * running. The definition is rewritten and re-registered every time (the
 * install commands replace an existing registration), so a start after an
 * update or rollback runs the release the record now names.
 */
export async function startNativeServiceDefinition(
  definition: NativeServiceDefinition,
  deps: { execute: NativeServiceExecute; write: (path: string, contents: string | Uint8Array) => Promise<void> },
): Promise<"already_running" | "started"> {
  if (serviceRun(await deps.execute(definition.status)).code === 0) return "already_running";
  const write = async (path: string, contents: string | Uint8Array) => {
    try { await deps.write(path, contents); }
    catch (error) { throw new NativeServiceCommandError("write", null, { code: null, error: error instanceof Error ? error.message : String(error) }, path); }
  };
  for (const file of definition.supportFiles ?? []) await write(file.path, file.contents);
  await write(definition.path, encodeServiceDefinition(definition));
  for (const [step, command] of [...definition.install.map(command => ["register", command] as const), ["start", definition.start] as const]) {
    const run = serviceRun(await deps.execute(command));
    if (run.code !== 0) throw new NativeServiceCommandError(step, command, run);
  }
  return "started";
}

/** Definitions contain only a fixed serve command and non-secret install paths. */
export function nativeServiceDefinition(input: {
  os: HostOs; home: string; root: string; executable: string; uid?: number | undefined; userId?: string;
}): NativeServiceDefinition {
  for (const value of [input.home, input.root, input.executable]) assertPath(value, input.os);
  const path = input.os === "windows" ? win32 : posix;
  const normalizedRoot = path.normalize(input.root);
  const label = `dev.konteks.remote.${createHash("sha256").update(input.os === "windows" ? normalizedRoot.toLowerCase() : normalizedRoot).digest("hex").slice(0, 12)}`;
  return SERVICE_DEFINITIONS[input.os]({ input, path, normalizedRoot, label, args: ["serve", "--root", normalizedRoot] });
}

interface ServiceDefinitionInput {
  input: { os: HostOs; home: string; root: string; executable: string; uid?: number | undefined; userId?: string };
  path: typeof posix;
  normalizedRoot: string;
  label: string;
  args: string[];
}

/** One definition per service manager: launchd, systemd's user manager, Task Scheduler. */
const SERVICE_DEFINITIONS: Readonly<Record<HostOs, (spec: ServiceDefinitionInput) => NativeServiceDefinition>> = {
  macos: launchAgentDefinition,
  debian: systemdUserDefinition,
  windows: scheduledTaskDefinition,
};

function launchAgentDefinition({ input, path, normalizedRoot, label, args }: ServiceDefinitionInput): NativeServiceDefinition {
  if (!Number.isSafeInteger(input.uid) || input.uid! < 1) throw new Error("a non-root user uid is required for the native launch agent");
  const file = path.join(input.home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${input.uid}`;
  // launchd keeps nothing a service prints: without a file the connector's
  // log, which doctor points to, did not exist (WS1-163). The connector
  // keeps the file small itself (connector-log.ts).
  // The home it was started from, as the service's own: launchd otherwise
  // hands a service the login's home, so a connector installed for another
  // home (a second person on this Mac, a stand-in laptop) read the wrong
  // agents' sign-ins and installs (09-30).
  const logFile = path.join(normalizedRoot, "logs", CONNECTOR_LOG_FILE);
  // launchd SIGKILLs a booted-out job 5 s after SIGTERM by default (measured
  // 2026-10-02, D113b): an idle connector was still stopping its agents, so
  // it never wrote its shutdown receipt and its Codex app-server was left
  // behind. 30 s covers the connector's own 15 s shutdown watchdog.
  return {
    label, path: file, requiresLinger: false,
    contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${[input.executable, ...args].map(arg => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(logFile)}</string>\n<key>StandardErrorPath</key><string>${xml(logFile)}</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(input.home)}</string></dict>\n</dict></plist>\n`,
    install: [],
    start: { command: "launchctl", args: ["bootstrap", domain, file] },
    stop: { command: "launchctl", args: ["bootout", `${domain}/${label}`] },
    remove: [],
    status: { command: "launchctl", args: ["print", `${domain}/${label}`] },
    exits: { command: "launchctl", args: ["print", `${domain}/${label}`] },
    inspect: { command: "launchctl", args: ["print", `${domain}/${label}`] },
    expected: { program: input.executable, logFile },
    reload: { kind: "detached", logFile, command: { command: "/bin/sh", args: ["-c", LAUNCHD_RELOAD_SCRIPT, "konteks-reload", `${domain}/${label}`, domain, file] } },
  };
}

function systemdUserDefinition({ input, path, label, args }: ServiceDefinitionInput): NativeServiceDefinition {
  const unit = `${label}.service`;
  return {
    label, path: path.join(input.home, ".config", "systemd", "user", unit), requiresLinger: true,
    contents: `[Unit]\nDescription=Konteks native agent connector\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${[input.executable, ...args].map(systemdArg).join(" ")}\nEnvironment=${systemdArg(`HOME=${input.home}`)}\nRestart=always\nRestartSec=5\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
    install: [{ command: "systemctl", args: ["--user", "daemon-reload"] }],
    start: { command: "systemctl", args: ["--user", "enable", "--now", unit] },
    stop: { command: "systemctl", args: ["--user", "stop", unit] },
    remove: [{ command: "systemctl", args: ["--user", "disable", "--now", unit] }],
    status: { command: "systemctl", args: ["--user", "is-active", unit] },
    exits: { command: "systemctl", args: ["--user", "show", unit, "-p", "NRestarts", "-p", "ExecMainStatus"] },
    inspect: { command: "systemctl", args: ["--user", "show", unit, "-p", "MainPID", "-p", "NeedDaemonReload"] },
    expected: { program: input.executable, logFile: null },
    // `--no-block` only queues the restart, so this process can ask for its own.
    reload: { kind: "inline", commands: [{ command: "systemctl", args: ["--user", "daemon-reload"] }, { command: "systemctl", args: ["--user", "--no-block", "restart", unit] }] },
  };
}

function scheduledTaskDefinition({ input, path, normalizedRoot, label }: ServiceDefinitionInput): NativeServiceDefinition {
  if (!input.userId || !/^S-1-\d+(?:-\d+)+$/.test(input.userId)) throw new Error("the current Windows user SID is required");
  const file = path.join(normalizedRoot, "service.xml");
  // Task Scheduler creates a visible console for a console executable even
  // when the task is marked Hidden. wscript is a GUI host: it starts one
  // hidden PowerShell host, waits for the connector and forwards its exit
  // status so the scheduler still tracks the running task and owns restarts.
  // Encode the literal command: WScript.Shell.Run expands %variables%, which
  // must never reinterpret an installation path containing percent signs.
  const helper = path.join(normalizedRoot, "service.js");
  const script = windowsServiceHost({ executable: input.executable, root: normalizedRoot, logFile: path.join(normalizedRoot, "logs", CONNECTOR_LOG_FILE) });
  const host = `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  return {
    label, path: file, requiresLinger: false, fileEncoding: "utf16le",
    supportFiles: [{ path: helper, contents: `var shell = WScript.CreateObject("WScript.Shell");\nWScript.Quit(shell.Run(${JSON.stringify(host)}, 0, true));\n` }],
    contents: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${input.userId}</UserId></LogonTrigger></Triggers>\n<Principals><Principal id="Owner"><UserId>${input.userId}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>${WINDOWS_TASK_RESTART_COUNT}</Count></RestartOnFailure></Settings>\n<Actions Context="Owner"><Exec><Command>%SystemRoot%\\System32\\wscript.exe</Command><Arguments>${xml(["//B", "//NoLogo", "//E:JScript", helper].map(windowsArg).join(" "))}</Arguments></Exec></Actions>\n</Task>\n`,
    install: [{ command: "schtasks.exe", args: ["/Create", "/TN", label, "/XML", file, "/F"] }],
    start: { command: "schtasks.exe", args: ["/Run", "/TN", label] },
    stop: { command: "schtasks.exe", args: ["/End", "/TN", label] },
    remove: [{ command: "schtasks.exe", args: ["/Delete", "/TN", label, "/F"] }],
    // `schtasks /Query` succeeds whenever the task exists, running or not, so
    // updates waited out the stop deadline and `start` never re-created the
    // task for the new release. The task's state enum reads the same in every
    // Windows language, unlike schtasks' text; the label is hex, so it quotes safely.
    status: { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `$task = Get-ScheduledTask -TaskPath '\\' -TaskName '${label}' -ErrorAction SilentlyContinue; if ($task -and $task.State -eq 'Running') { exit 0 }; exit 1`] },
    registered: { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `if (Get-ScheduledTask -TaskPath '\\' -TaskName '${label}' -ErrorAction SilentlyContinue) { exit 0 }; exit 1`] },
  };
}

/**
 * Task Scheduler's published schema types `RestartOnFailure/Count` as an
 * unsignedByte; 999, which its own dialog offers, is out of that range.
 */
const WINDOWS_TASK_RESTART_COUNT = 255;
/** The connector log's limit, as the supervisor keeps it on macOS and Linux (connector-log.ts). */
const WINDOWS_LOG_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The hidden PowerShell host the Windows task runs. Task Scheduler keeps
 * nothing a task prints, so a connector that stopped as it started left no
 * trace (D129); like launchd's StandardOutPath, the connector's stdout and
 * stderr are appended to `<root>\logs\connector.log` from its very first
 * byte. Windows PowerShell's own redirection turns a native program's stderr
 * into error records (and, under `Stop`, ends the pipeline at the first
 * line), so cmd redirects instead. cmd reads the paths from the environment:
 * it expands each `%NAME%` once and never re-reads a value, so a path's own
 * `%`, `&` and `'` stay literal. The log is kept small here, before the
 * connector holds it: cmd's handle does not append, so it cannot be emptied
 * in place while the connector runs. A start that fails before the connector
 * runs writes one line to the same log.
 */
function windowsServiceHost(input: { executable: string; root: string; logFile: string }): string {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  // The connector parses its command line by the C runtime's rules, where
  // backslashes before a closing quote escape it; doubled, they stay a path.
  const rootArgument = input.root.replace(/(\\+)$/, "$1$1");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${literal(input.logFile)}`,
    "try {",
    "  [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($log))",
    "  try {",
    "    $previous = New-Object System.IO.FileInfo -ArgumentList $log",
    `    if ($previous.Exists -and $previous.Length -gt ${WINDOWS_LOG_MAX_BYTES}) {`,
    "      $rotated = $log + '.1'",
    "      [System.IO.File]::Delete($rotated)",
    "      [System.IO.File]::Move($log, $rotated)",
    "    }",
    "  } catch { }",
    `  $env:KONTEKS_SERVICE_PROGRAM = ${literal(input.executable)}`,
    `  $env:KONTEKS_SERVICE_ROOT = ${literal(rootArgument)}`,
    "  $env:KONTEKS_SERVICE_LOG = $log",
    "  $start = New-Object System.Diagnostics.ProcessStartInfo",
    "  $start.FileName = [System.IO.Path]::Combine($env:SystemRoot, 'System32\\cmd.exe')",
    `  $start.Arguments = '/d /v:off /s /c ""%KONTEKS_SERVICE_PROGRAM%" serve --root "%KONTEKS_SERVICE_ROOT%" >> "%KONTEKS_SERVICE_LOG%" 2>&1"'`,
    "  $start.UseShellExecute = $false",
    "  $connector = [System.Diagnostics.Process]::Start($start)",
    "  $connector.WaitForExit()",
    "  exit $connector.ExitCode",
    "} catch {",
    "  $message = 'the Konteks task could not start the connector: ' + $_.Exception.Message",
    "  $line = '{\"level\":50,\"time\":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',\"msg\":' + (ConvertTo-Json -InputObject $message -Compress) + '}'",
    "  try { [System.IO.File]::AppendAllText($log, $line + [Environment]::NewLine) } catch { }",
    "  exit 1",
    "}",
  ].join("\n");
}

function assertPath(value: string, os: HostOs): void {
  if (!(os === "windows" ? win32 : posix).isAbsolute(value)) throw new Error("native install paths must be absolute");
  // Reject control bytes deliberately; they can inject service-definition lines.
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("control characters are not allowed in native install paths");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function systemdArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

function windowsArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/**
 * How often the OS service manager has started the service since it was
 * loaded, and the exit code of its last run (null while it has never exited),
 * from `exits`' output: launchd's `runs` / `last exit code`, systemd's
 * `NRestarts` / `ExecMainStatus`.
 */
export function parseServiceExits(os: HostOs, stdout: string): { runs: number; lastExitCode: number | null } | null {
  if (os === "macos") {
    const runs = stdout.match(/^\s*runs = (\d+)$/m);
    if (!runs) return null;
    const code = stdout.match(/^\s*last exit code = (\d+)/m);
    return { runs: Number(runs[1]), lastExitCode: code ? Number(code[1]) : null };
  }
  if (os === "debian") {
    const restarts = stdout.match(/^NRestarts=(\d+)$/m);
    const status = stdout.match(/^ExecMainStatus=(\d+)$/m);
    if (!restarts) return null;
    return { runs: Number(restarts[1]) + 1, lastExitCode: status && Number(status[1]) !== 0 ? Number(status[1]) : null };
  }
  return null;
}

/**
 * The pid the service manager runs for this service (null when it runs none)
 * and whether the definition it has loaded is this one, from `inspect`'s
 * output: launchd's `pid`, `program` and `stdout path` (a plist loaded without
 * the log file has no `stdout path`, so its output goes to /dev/null), systemd's
 * `MainPID` and `NeedDaemonReload`. Null where the output says neither.
 */
export function parseLoadedService(os: HostOs, stdout: string, expected: { program: string; logFile: string | null }): { pid: number | null; current: boolean } | null {
  if (os === "macos") return parseLaunchdService(stdout, expected);
  return os === "debian" ? parseSystemdService(stdout) : null;
}

function parseLaunchdService(stdout: string, expected: { program: string; logFile: string | null }): { pid: number | null; current: boolean } | null {
  if (!/^\S+ = \{$/m.test(stdout)) return null;
  const pid = stdout.match(/^\s*pid = (\d+)$/m);
  const program = stdout.match(/^\s*program = (.+)$/m)?.[1];
  return { pid: pid ? Number(pid[1]) : null, current: program === expected.program && loggedTo(stdout, expected.logFile) };
}

/** Both of the job's output paths are the connector's log (always, when it keeps none). */
function loggedTo(stdout: string, logFile: string | null): boolean {
  if (logFile === null) return true;
  const out = stdout.match(/^\s*stdout path = (.+)$/m)?.[1];
  const err = stdout.match(/^\s*stderr path = (.+)$/m)?.[1];
  return out === logFile && err === logFile;
}

function parseSystemdService(stdout: string): { pid: number | null; current: boolean } | null {
  const pid = stdout.match(/^MainPID=(\d+)$/m);
  if (!pid) return null;
  return { pid: Number(pid[1]) > 0 ? Number(pid[1]) : null, current: !/^NeedDaemonReload=yes$/m.test(stdout) };
}
