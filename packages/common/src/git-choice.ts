import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { RemoteInstanceError } from "./errors.js";
import { runCommand, sanitizeInheritedChildProcessEnv } from "./process.js";

/**
 * Which git the connector and the coding agents it starts run.
 *
 * On a Mac whose Xcode license is not accepted yet, `/usr/bin/git` (Xcode's
 * shim) refuses every command. The Command Line Tools' git needs no license,
 * and `DEVELOPER_DIR` points the same shim at it. That fallback is taken only
 * when `git --version` fails with Xcode's license message and the Command
 * Line Tools' git itself runs; any other git failure is left to surface
 * exactly as before. Linux and Windows are never probed.
 */

/** Where the Command Line Tools install, and the `DEVELOPER_DIR` that selects them. */
export const COMMAND_LINE_TOOLS_DIR = "/Library/Developer/CommandLineTools";

export const GIT_XCODE_LICENSE_PENDING = "git_xcode_license_pending";
export const GIT_XCODE_LICENSE_MESSAGE = "Git on this Mac needs the Xcode license accepted. Run: sudo xcodebuild -license accept";

const XCODE_LICENSE = /agreed to the xcode license|xcodebuild -license/i;

export interface GitChoice {
  /** `command_line_tools` while Xcode's license is pending; `default` otherwise. */
  git: "default" | "command_line_tools";
  /** The git that runs, or null when none is found on PATH. */
  path: string | null;
  reason: "default" | "xcode_license_pending";
  /** Added to every connector git call's and every coding agent's environment. */
  env: Readonly<Record<string, string>>;
  /** Xcode's license gate with no Command Line Tools to fall back on: git cannot run until it is accepted. */
  blocked?: { code: typeof GIT_XCODE_LICENSE_PENDING; message: string };
}

export interface ResolveGitOptions {
  platform?: NodeJS.Platform;
  /** What git is run as: `git` on PATH, or an installer-selected executable. */
  command?: string;
  /** The environment the connector runs git with. */
  env?: NodeJS.ProcessEnv;
  /** The Command Line Tools folder; injected in tests. */
  commandLineTools?: string;
  run?: typeof runCommand;
  isFile?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Probe once: `git --version`, and on Xcode's license refusal the Command Line Tools' git. */
export async function resolveGit(options: ResolveGitOptions = {}): Promise<GitChoice> {
  const { platform, command, env, exists, run, tools } = settings(options);
  const standard: GitChoice = { git: "default", path: gitOnPath(command, env, platform, exists), reason: "default", env: {} };
  if (platform !== "darwin") return standard;
  const probe = versionProbe(command, run);
  if (!licenseRefused(await probe(env))) return standard;
  const toolsGit = join(tools, "usr", "bin", "git");
  if (exists(toolsGit) && succeeded(await probe({ ...env, DEVELOPER_DIR: tools }))) {
    return { git: "command_line_tools", path: toolsGit, reason: "xcode_license_pending", env: { DEVELOPER_DIR: tools } };
  }
  return { ...standard, reason: "xcode_license_pending", blocked: { code: GIT_XCODE_LICENSE_PENDING, message: GIT_XCODE_LICENSE_MESSAGE } };
}

function settings(options: ResolveGitOptions) {
  return {
    platform: options.platform ?? process.platform,
    command: options.command ?? "git",
    env: options.env ?? sanitizeInheritedChildProcessEnv({ env: process.env }),
    exists: options.isFile ?? isFile,
    run: options.run ?? runCommand,
    tools: options.commandLineTools ?? COMMAND_LINE_TOOLS_DIR,
  };
}

type VersionResult = Awaited<ReturnType<typeof runCommand>> | null;

/** `git --version` with an environment; null when git could not be started at all. */
function versionProbe(command: string, run: typeof runCommand): (env: NodeJS.ProcessEnv) => Promise<VersionResult> {
  return env => run({ command, args: ["--version"], env, timeoutMs: 10_000 }).catch(() => null);
}

function succeeded(result: VersionResult): boolean {
  return result !== null && result.code === 0;
}

/** Failed with Xcode's license message: the one failure the fallback answers. */
function licenseRefused(result: VersionResult): boolean {
  return result !== null && result.code !== 0 && XCODE_LICENSE.test(`${result.stdout}\n${result.stderr}`);
}

/** An absolute command as given; otherwise the first match on PATH. */
function gitOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (path: string) => boolean): string | null {
  if (isAbsolute(command)) return command;
  const windows = platform === "win32";
  const names = windows ? [`${command}.exe`, `${command}.cmd`] : [command];
  const directories = (env.PATH ?? env.Path ?? "").split(windows ? ";" : delimiter).filter(directory => isAbsolute(directory));
  for (const directory of directories) {
    const found = names.map(name => join(directory, name)).find(exists);
    if (found) return found;
  }
  return null;
}

const chosen = new Map<string, Promise<GitChoice>>();
const settled = new Map<string, GitChoice>();

/** This process's choice for `command`, probed once with the connector's own environment (`options`: tests). */
export function connectorGit(command = "git", options: Omit<ResolveGitOptions, "command"> = {}): Promise<GitChoice> {
  let choice = chosen.get(command);
  if (!choice) {
    choice = resolveGit({ ...options, command }).then(value => { settled.set(command, value); return value; });
    chosen.set(command, choice);
  }
  return choice;
}

/**
 * What every git call and every coding agent adds to its environment, from
 * the choices made so far (the supervisor makes them at startup). Empty
 * unless a probe chose the Command Line Tools.
 */
export function connectorGitEnv(): Record<string, string> {
  return Object.assign({}, ...[...settled.values()].map(choice => choice.env)) as Record<string, string>;
}

/** Refuses with the plain license finding when git cannot run until Xcode's license is accepted. */
export async function requireConnectorGit(command = "git"): Promise<GitChoice> {
  const choice = await connectorGit(command);
  if (choice.blocked) throw gitXcodeLicenseError();
  return choice;
}

export function gitXcodeLicenseError(): RemoteInstanceError {
  return new RemoteInstanceError("prerequisite_missing", GIT_XCODE_LICENSE_MESSAGE, { diagnostic: GIT_XCODE_LICENSE_PENDING });
}

export function isGitXcodeLicenseError(error: unknown): error is RemoteInstanceError {
  return error instanceof RemoteInstanceError && error.diagnostic === GIT_XCODE_LICENSE_PENDING;
}

/** The choice as `status`, `doctor` and the log show it: the home folder as `~`. */
export function gitChoiceReport(choice: GitChoice): { git: GitChoice["git"]; path: string | null; reason: GitChoice["reason"]; blocked: string | null } {
  const home = homedir();
  const path = choice.path && home && choice.path.startsWith(home) ? `~${choice.path.slice(home.length)}` : choice.path;
  return { git: choice.git, path, reason: choice.reason, blocked: choice.blocked?.message ?? null };
}
