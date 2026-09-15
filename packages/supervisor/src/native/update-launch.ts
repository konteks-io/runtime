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
export async function launchNativeUpdater(options: NativeUpdateLaunchOptions): Promise<{ pid: number | null; command: string; args: string[] }> {
  if (!isAbsolute(options.root) || !isAbsolute(options.executable)) throw new Error("native update launch paths must be absolute");
  const env = sanitizeInheritedChildProcessEnv({ env: process.env });
  const updateArgs = ["--root", options.root, "--json", "update", "--unattended"];
  const spawnFn = options.spawnFn ?? spawn;
  if (options.os === "debian") {
    const unit = `konteks-remote-update-${Date.now()}`;
    const args = ["--user", "--collect", "--quiet", `--unit=${unit}`, "--property=KillMode=process", options.executable, ...updateArgs];
    const child = spawnFn("systemd-run", args, { env, stdio: "ignore", detached: true });
    child.unref();
    return { pid: child.pid ?? null, command: "systemd-run", args };
  }
  const logPath = options.logPath ?? join(options.root, "logs", "update.log");
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawnFn(options.executable, updateArgs, { env, stdio: ["ignore", log.fd, log.fd], detached: true, windowsHide: true });
    child.unref();
    return { pid: child.pid ?? null, command: options.executable, args: updateArgs };
  } finally {
    await log.close();
  }
}
