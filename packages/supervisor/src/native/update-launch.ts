import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";

export interface NativeUpdateLaunchOptions {
  root: string;
  /** The installed connector executable of the release currently serving. */
  executable: string;
  os: "macos" | "windows" | "debian";
  /** Where the detached transaction writes its own output; never the supervisor's stdio. */
  logPath?: string;
  spawnFn?: typeof spawn;
}

/**
 * Start the launcher's transactional `update` outside the service process
 * group. The transaction stops this very service before committing, so it
 * must not die with it: launchd and Task Scheduler leave a detached session
 * alone, while a systemd user service kills its whole cgroup, so there the
 * updater runs as its own transient unit.
 */
/** Network trust and channel settings the service itself was started with; the transaction needs the same ones. */
const UPDATER_ENV_ALLOWLIST = ["NODE_EXTRA_CA_CERTS", "KONTEKS_RELEASE_MANIFEST_URL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"] as const;

export interface NativeUpdateLaunch {
  pid: number | null;
  command: string;
  args: string[];
  /** Fires when the spawned transaction exits while this service is still alive (a refusal or early failure); a successful update stops this service first. */
  onExit: (listener: (code: number | null) => void) => void;
}

export async function launchNativeUpdater(options: NativeUpdateLaunchOptions): Promise<NativeUpdateLaunch> {
  if (!isAbsolute(options.root) || !isAbsolute(options.executable)) throw new Error("native update launch paths must be absolute");
  const env = sanitizeInheritedChildProcessEnv({ env: process.env, allow: UPDATER_ENV_ALLOWLIST });
  const updateArgs = ["--root", options.root, "--json", "update", "--unattended"];
  const spawnFn = options.spawnFn ?? spawn;
  if (options.os === "debian") {
    const unit = `konteks-remote-update-${Date.now()}`;
    const args = ["--user", "--collect", "--quiet", `--unit=${unit}`, "--property=KillMode=process", options.executable, ...updateArgs];
    const child = spawnFn("systemd-run", args, { env, stdio: "ignore", detached: true });
    child.unref();
    return { pid: child.pid ?? null, command: "systemd-run", args, onExit: listener => child.once("exit", code => listener(code)) };
  }
  const logPath = options.logPath ?? join(options.root, "logs", "update.log");
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawnFn(options.executable, updateArgs, { env, stdio: ["ignore", log.fd, log.fd], detached: true, windowsHide: true });
    child.unref();
    return { pid: child.pid ?? null, command: options.executable, args: updateArgs, onExit: listener => child.once("exit", code => listener(code)) };
  } finally {
    await log.close();
  }
}
