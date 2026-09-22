import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { HostOs } from "../paths.js";

export interface NativePlatform {
  os: HostOs;
  architecture: "amd64" | "arm64";
  containerBackend: "none";
  deploymentKind: "native_connector";
}

export function nativePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): NativePlatform {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported native architecture ${arch}`);
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "debian" : null;
  if (!os) throw new Error(`unsupported native platform ${platform}`);
  return { os, architecture: arch === "x64" ? "amd64" : "arm64", containerBackend: "none", deploymentKind: "native_connector" };
}

/** Separate from appliance volumes: no database, domain runtime, browser, or gateway. */
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
  install: NativeServiceCommand[];
  start: NativeServiceCommand;
  stop: NativeServiceCommand;
  remove: NativeServiceCommand[];
  status: NativeServiceCommand;
  /** Reads how often the OS has started the service and how it last exited (`parseServiceExits`); absent where the OS does not say. */
  exits?: NativeServiceCommand;
  /** User services on Linux need linger to survive logout/reboot without a login. */
  requiresLinger: boolean;
}

/** Definitions contain only a fixed serve command and non-secret install paths. */
export function nativeServiceDefinition(input: {
  os: HostOs; home: string; root: string; executable: string; uid?: number | undefined; userId?: string;
}): NativeServiceDefinition {
  for (const value of [input.home, input.root, input.executable]) assertPath(value, input.os);
  const path = input.os === "windows" ? win32 : posix;
  const normalizedRoot = path.normalize(input.root);
  const label = `dev.konteks.remote.${createHash("sha256").update(input.os === "windows" ? normalizedRoot.toLowerCase() : normalizedRoot).digest("hex").slice(0, 12)}`;
  const args = ["serve", "--root", normalizedRoot];
  if (input.os === "macos") {
    if (!Number.isSafeInteger(input.uid) || input.uid! < 1) throw new Error("a non-root user uid is required for the native launch agent");
    const file = path.join(input.home, "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${input.uid}`;
    return {
      label, path: file, requiresLinger: false,
      contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${[input.executable, ...args].map(arg => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n`,
      install: [],
      start: { command: "launchctl", args: ["bootstrap", domain, file] },
      stop: { command: "launchctl", args: ["bootout", `${domain}/${label}`] },
      remove: [],
      status: { command: "launchctl", args: ["print", `${domain}/${label}`] },
      exits: { command: "launchctl", args: ["print", `${domain}/${label}`] },
    };
  }
  if (input.os === "debian") {
    const unit = `${label}.service`;
    return {
      label, path: path.join(input.home, ".config", "systemd", "user", unit), requiresLinger: true,
      contents: `[Unit]\nDescription=Konteks native agent connector\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${[input.executable, ...args].map(systemdArg).join(" ")}\nRestart=always\nRestartSec=5\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
      install: [{ command: "systemctl", args: ["--user", "daemon-reload"] }],
      start: { command: "systemctl", args: ["--user", "enable", "--now", unit] },
      stop: { command: "systemctl", args: ["--user", "stop", unit] },
      remove: [{ command: "systemctl", args: ["--user", "disable", "--now", unit] }],
      status: { command: "systemctl", args: ["--user", "is-active", unit] },
      exits: { command: "systemctl", args: ["--user", "show", unit, "-p", "NRestarts", "-p", "ExecMainStatus"] },
    };
  }
  if (!input.userId || !/^S-1-\d+(?:-\d+)+$/.test(input.userId)) throw new Error("the current Windows user SID is required");
  const file = path.join(normalizedRoot, "service.xml");
  return {
    label, path: file, requiresLinger: false,
    contents: `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${input.userId}</UserId></LogonTrigger></Triggers>\n<Principals><Principal id="Owner"><UserId>${input.userId}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>\n<Actions Context="Owner"><Exec><Command>${xml(input.executable)}</Command><Arguments>${xml(args.map(windowsArg).join(" "))}</Arguments></Exec></Actions>\n</Task>\n`,
    install: [{ command: "schtasks.exe", args: ["/Create", "/TN", label, "/XML", file, "/F"] }],
    start: { command: "schtasks.exe", args: ["/Run", "/TN", label] },
    stop: { command: "schtasks.exe", args: ["/End", "/TN", label] },
    remove: [{ command: "schtasks.exe", args: ["/Delete", "/TN", label, "/F"] }],
    status: { command: "schtasks.exe", args: ["/Query", "/TN", label, "/XML"] },
  };
}

function assertPath(value: string, os: HostOs): void {
  if (!(os === "windows" ? win32 : posix).isAbsolute(value)) throw new Error("native install paths must be absolute");
  // Reject control bytes deliberately; they can inject service-definition lines.
  // eslint-disable-next-line no-control-regex
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
