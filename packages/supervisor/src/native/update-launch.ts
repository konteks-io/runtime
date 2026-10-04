import { spawn, type StdioOptions } from "node:child_process";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { NATIVE_UPDATE_TARGET_ENV, NativeUpdateTargetSchema, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";
import type { NativeUpdateTarget } from "./update.js";

interface NativeUpdateLaunchOptions {
  root: string;
  /** The installed connector executable of the release currently serving. */
  executable: string;
  os: "macos" | "windows" | "debian";
  /** Where the detached transaction writes its own output; never the supervisor's stdio. */
  logPath?: string;
  spawnFn?: typeof spawn;
  target?: NativeUpdateTarget;
  /** The signed delivery still owns its lease and socket immediately before spawn. */
  assertCurrent?: () => void;
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

interface NativeUpdateLaunch {
  pid: number | null;
  command: string;
  args: string[];
  /** Fires when the spawned transaction exits while this service is still alive (a refusal or early failure); a successful update stops this service first. */
  onExit: (listener: (code: number | null) => void) => void;
}

export async function launchNativeUpdater(options: NativeUpdateLaunchOptions): Promise<NativeUpdateLaunch> {
  if (!isAbsolute(options.root) || !isAbsolute(options.executable)) throw new Error("native update launch paths must be absolute");
  const env = sanitizeInheritedChildProcessEnv({ env: process.env, allow: UPDATER_ENV_ALLOWLIST });
  if (options.target) env[NATIVE_UPDATE_TARGET_ENV] = JSON.stringify(NativeUpdateTargetSchema.parse(options.target));
  const updateArgs = ["--root", options.root, "--json", "update", "--unattended"];
  if (options.os === "debian") return launchDebianUpdater(options, env, updateArgs);
  const logPath = options.logPath ?? join(options.root, "logs", "update.log");
  const log = await open(logPath, "a", 0o600);
  try {
    return await launchProcess(options, options.executable, updateArgs, env, ["ignore", log.fd, log.fd]);
  } finally {
    await log.close();
  }
}

function launchDebianUpdater(options: NativeUpdateLaunchOptions, env: NodeJS.ProcessEnv, updateArgs: string[]): Promise<NativeUpdateLaunch> {
  const unit = `konteks-remote-update-${Date.now()}`;
  // A transient service inherits the user manager's environment. --setenv
  // without a value explicitly copies these names from the client process,
  // keeping the fixed target and per-process network trust without exposing
  // proxy credentials in command arguments.
  const forwarded = [...UPDATER_ENV_ALLOWLIST, NATIVE_UPDATE_TARGET_ENV].filter(name => env[name] !== undefined).map(name => `--setenv=${name}`);
  const args = ["--user", "--collect", "--quiet", `--unit=${unit}`, "--property=KillMode=process", ...forwarded, options.executable, ...updateArgs];
  return launchProcess(options, "systemd-run", args, env, "ignore");
}

async function launchProcess(options: NativeUpdateLaunchOptions, command: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions): Promise<NativeUpdateLaunch> {
  const spawnFn = options.spawnFn ?? spawn;
  options.assertCurrent?.();
  const child = spawnFn(command, args, { env, stdio, detached: true, windowsHide: true });
  let exitCode: number | null | undefined;
  let exitListener: ((code: number | null) => void) | undefined;
  child.once("exit", code => { exitCode = code; exitListener?.(code); });
  await new Promise<void>((resolve, reject) => {
    // Retain the listener after spawn, so a later child error cannot end the
    // serving connector. Before spawn it rejects admission without unref.
    child.on("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return { pid: child.pid ?? null, command, args, onExit: listener => {
    if (exitCode !== undefined) listener(exitCode);
    else exitListener = listener;
  } };
}
