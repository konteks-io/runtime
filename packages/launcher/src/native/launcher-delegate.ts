import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, win32 } from "node:path";
import { compareAgentVersions, nativeConnectorFileNames } from "@konteks/remote-release";

/**
 * Set on a command the installed `konteks-remote` handed to a release, so the
 * release never hands it on again.
 */
export const LAUNCHER_DELEGATED_ENV = "KONTEKS_REMOTE_VIA_LAUNCHER";

/** The file the Windows installer (MSI) puts on the machine PATH. */
const INSTALLED_LAUNCHER = "konteks-remote.exe";

/**
 * Commands that are the installer's own: they create or delete the per-user
 * root the release lives in. Windows cannot delete a running executable, so
 * an `uninstall` run from `releases\<id>` could never remove its own folder.
 */
const INSTALLER_COMMANDS = new Set(["install", "uninstall", "stage-enrollment"]);

/** As `commitNativeUpdate` accepts it: one path segment, never a separator or a dot-dot. */
const RELEASE_ID = /^release-[A-Za-z0-9_-]+$/;

/** Values the release build's entry fills in itself; each release bakes its own (`build-launcher.mjs`). */
const ENTRY_VALUES = ["KONTEKS_RELEASE_ROOTS_JSON", "KONTEKS_LAUNCHER_VERSION"] as const;

interface InstalledReleaseInput {
  platform: NodeJS.Platform;
  /** This process's executable. */
  execPath: string;
  /** The command line after the executable (`process.argv.slice(2)`). */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The release this executable was built as (`KONTEKS_LAUNCHER_VERSION`, `v` prefix allowed). */
  launcherVersion: string;
  /** The per-user root when no `--root` is given. */
  defaultRoot: () => string;
}

/**
 * The installed release's own `konteks-remote`, when this process is the
 * Windows command the MSI installed and should run that instead. The
 * MSI's copy sits under Program Files, which the running connector cannot
 * replace without elevation, so every command it ran kept the code of the
 * first MSI the person installed whatever release the connector ran. Now it
 * resolves `<root>\native-runtime.json` → `releases\<releaseId>\konteks-connector.exe`
 * (the release's executable is the same program) and runs that.
 *
 * Null, and this process runs its own code, when: another OS (macOS and
 * Linux refresh `<root>/bin/konteks-remote`), not the installed
 * command, already handed on, an installer command, nothing installed yet
 * (first install, onboarding), the record names no release, this copy is
 * newer than the installed release (a person who installs a newer MSI to
 * repair an older release gets the newer code), or the path is anything but
 * a regular file at exactly `<root>\releases\<releaseId>\<name>` after every
 * link is resolved. Nothing outside the per-user root is ever followed.
 */
export async function installedReleaseLauncher(input: InstalledReleaseInput): Promise<{ executable: string; bundleVersion: string } | null> {
  if (!delegationApplies(input)) return null;
  try {
    return await installedReleaseExecutable(input);
  } catch {
    return null;
  }
}

/** Only the installed Windows command, not yet handed on, for anything but an installer command. */
function delegationApplies(input: InstalledReleaseInput): boolean {
  if (input.platform !== "win32" || input.env[LAUNCHER_DELEGATED_ENV]) return false;
  if (win32.basename(input.execPath).toLowerCase() !== INSTALLED_LAUNCHER) return false;
  const { command } = commandLine(input.args);
  return command === null || !INSTALLER_COMMANDS.has(command);
}

async function installedReleaseExecutable(input: InstalledReleaseInput): Promise<{ executable: string; bundleVersion: string } | null> {
  const root = resolve(commandLine(input.args).root ?? input.defaultRoot());
  const record = await readRecord(join(root, "native-runtime.json"));
  if (!record || !ownCodeIsNotNewer(record.bundleVersion, input.launcherVersion)) return null;
  const realRoot = await realpath(root);
  for (const name of nativeConnectorFileNames("windows")) {
    const found = await releaseExecutable({ root, realRoot, record, name, execPath: input.execPath });
    if (found !== "absent") return found;
  }
  return null;
}

/**
 * The release's connector under this name: "absent" when there is none,
 * null when it is not a regular file at exactly its place or is this very
 * executable.
 */
async function releaseExecutable(at: { root: string; realRoot: string; record: { releaseId: string; bundleVersion: string }; name: string; execPath: string }): Promise<{ executable: string; bundleVersion: string } | null | "absent"> {
  const candidate = join(at.root, "releases", at.record.releaseId, at.name);
  const info = await lstat(candidate).catch(() => null);
  if (!info) return "absent";
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const real = await realpath(candidate);
  const expected = join("releases", at.record.releaseId, at.name);
  // Windows paths are case-insensitive; any link or junction on the way makes them differ.
  if (relative(at.realRoot, real).toLowerCase() !== expected.toLowerCase()) return null;
  if (await realpath(at.execPath).then(self => self.toLowerCase() === real.toLowerCase(), () => false)) return null;
  return { executable: candidate, bundleVersion: at.record.bundleVersion };
}

/** The subcommand and the global `--root`, wherever commander would read them. */
function commandLine(args: readonly string[]): { command: string | null; root: string | null } {
  let command: string | null = null;
  let root: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "--root") { root = args[index + 1] ?? null; index += 1; continue; }
    if (arg.startsWith("--root=")) { root = arg.slice("--root=".length); continue; }
    if (arg.startsWith("-")) continue;
    command ??= arg;
  }
  return { command, root };
}

async function readRecord(path: string): Promise<{ releaseId: string; bundleVersion: string } | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return null;
  const value = JSON.parse(await readFile(path, "utf8")) as { releaseId?: unknown; bundleVersion?: unknown };
  if (typeof value.releaseId !== "string" || !RELEASE_ID.test(value.releaseId)) return null;
  if (typeof value.bundleVersion !== "string" || !value.bundleVersion) return null;
  return { releaseId: value.releaseId, bundleVersion: value.bundleVersion };
}

/** True when the installed release is at least this copy's version; an unreadable installed version is never preferred. */
function ownCodeIsNotNewer(installed: string, own: string): boolean {
  try { compareAgentVersions(installed, installed); } catch { return false; }
  try { return compareAgentVersions(installed, own.replace(/^v/, "")) >= 0; } catch { return true; }
}

/**
 * The environment the release runs with: the person's own, without the
 * values this copy's entry filled in (`baked`, plus the roots and version
 * every entry sets), so the release uses its own.
 */
export function launcherChildEnv(env: NodeJS.ProcessEnv, baked: readonly string[]): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const key of [...ENTRY_VALUES, ...baked]) delete child[key];
  child[LAUNCHER_DELEGATED_ENV] = "1";
  return child;
}

/**
 * Run the release with this console: its stdin, stdout and stderr (prompts
 * without echo work), every argument as given and its exit code. Ctrl+C
 * reaches the release through the shared console, so this process only
 * waits for it. Null when it could not be started at all.
 */
export function runInstalledRelease(executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; spawnFn?: typeof spawn }): Promise<number | null> {
  return new Promise(done => {
    const ignore = () => undefined;
    const signals = ["SIGINT", "SIGBREAK", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, ignore);
    const settle = (code: number | null) => {
      for (const signal of signals) process.off(signal, ignore);
      done(code);
    };
    let started = false;
    const child = (options.spawnFn ?? spawn)(executable, [...args], { stdio: "inherit", env: options.env, windowsHide: false });
    child.once("spawn", () => { started = true; });
    child.once("error", () => { if (!started) settle(null); });
    child.once("exit", (code, signal) => settle(code ?? (signal ? 1 : 0)));
  });
}

function verboseRequested(input: InstalledReleaseInput): boolean {
  return input.args.includes("--verbose") || /^(1|true|yes|on)$/i.test(input.env.KONTEKS_REMOTE_VERBOSE ?? "");
}

interface DelegateDeps {
  run?: (executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<number | null>;
}

/**
 * The installed Windows command's first step: run the installed release's
 * own code and return its exit code, or null to run this copy's own (see
 * `installedReleaseLauncher`). A release that cannot be started at all is
 * said once on stderr and this copy runs instead.
 */
export async function delegateToInstalledRelease(
  input: InstalledReleaseInput & { baked?: readonly string[]; stderr?: Pick<NodeJS.WritableStream, "write"> },
  deps: DelegateDeps = {},
): Promise<number | null> {
  const target = await installedReleaseLauncher(input);
  if (!target) return null;
  const stderr = input.stderr ?? process.stderr;
  if (verboseRequested(input)) {
    stderr.write(`[verbose] running the installed release ${target.bundleVersion}: ${target.executable}\n`);
  }
  const code = await (deps.run ?? runInstalledRelease)(target.executable, input.args, { env: launcherChildEnv(input.env, input.baked ?? []) });
  if (code === null) stderr.write(`konteks-remote: could not start the installed release ${target.bundleVersion}; running this installer's own copy instead.\n`);
  return code;
}
