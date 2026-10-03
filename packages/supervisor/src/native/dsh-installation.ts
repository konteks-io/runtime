import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { absolutePathEntries, plainAbsolutePath, safelyOwned } from "./host-files.js";
import { compareAgentVersions, hostAgentFamily, hostAgentVersionSupported, type HostAgentFamily } from "@konteks/remote-release";

/** The person's own installed DeepSeek Harness, as the runtime will launch it. */
export interface NativeDshInstallation {
  /** Canonical package root (`…/node_modules/@deepseek-ai/dsh`). */
  root: string;
  /** Canonical `bin.dsh` entry inside the root; the runtime's bundled Node runs it. */
  entry: string;
  version: string;
}

type Refusal = { diagnostic: "dsh_not_found" | "dsh_unsupported_version" | "dsh_unsafe_install" | "dsh_node_unsupported"; message: string };
const PRIORITY: Record<Refusal["diagnostic"], number> = { dsh_not_found: 0, dsh_unsafe_install: 1, dsh_unsupported_version: 2, dsh_node_unsupported: 3 };

const family = (): HostAgentFamily => hostAgentFamily("dsh");

function refuse(refusal: Refusal): RemoteInstanceError {
  return new RemoteInstanceError("prerequisite_missing", refusal.message, { diagnostic: refusal.diagnostic, recoveryActions: [{ kind: "install_backend", agentId: "dsh" }] });
}

function notFound(): Refusal {
  const { hostInstall } = family();
  return { diagnostic: "dsh_not_found", message: `DeepSeek Harness is not installed for this user. Install it with \`${hostInstall.installCommand}\`, then retry.` };
}

/**
 * Locate the person's own installed DeepSeek Harness without executing
 * anything: an absolute operator override, `dsh` on PATH (every PATHEXT name
 * on Windows), then the npm global package roots. A candidate resolves to its
 * package root by following symlinks to the package's own `package.json`, or,
 * for a shim (Windows `.cmd`, a POSIX wrapper script), by the npm layout beside
 * it; a shim is never parsed or run. Managers with other layouts (pnpm, volta,
 * yarn global) are reached through DSH_EXECUTABLE. Last comes npm's npx cache
 * (`<npm cache>/_npx/<hash>/node_modules/@deepseek-ai/dsh`), where the
 * homepage's `npx @deepseek-ai/dsh web` leaves it; there the newest supported
 * copy wins. Otherwise the first supported, safely owned package wins. Operator process configuration only; never take
 * this path from Core or ACP.
 */
export function resolveNativeDshInstallation(env: NodeJS.ProcessEnv = process.env, operatorHome = homedir(), platform: NodeJS.Platform = process.platform): Promise<NativeDshInstallation> {
  return locateDsh(env, operatorHome, platform);
}

async function locateDsh(env: NodeJS.ProcessEnv, operatorHome: string, platform: NodeJS.Platform): Promise<NativeDshInstallation> {
  const override = env.DSH_EXECUTABLE;
  if (override !== undefined && !plainAbsolutePath(override)) throw refuse({ diagnostic: "dsh_not_found", message: "DSH_EXECUTABLE must be an absolute path to the installed @deepseek-ai/dsh package or its launcher." });
  const search = new DshSearch(platform);
  const found = override !== undefined ? await search.fromLaunchers([override]) : await search.anywhere(env, operatorHome);
  if (found) return found;
  throw refuse(search.best);
}

/** `dsh` on PATH: every PATHEXT name on Windows. */
function pathLaunchers(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const bin = family().hostInstall.bin;
  const names = platform === "win32"
    ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => `${bin}${ext.toLowerCase()}`), `${bin}.ps1`, bin]
    : [bin];
  return absolutePathEntries(env.PATH, platform === "win32" ? ";" : ":").flatMap(directory => names.map(name => join(directory, name)));
}

/** One search for an installed DeepSeek Harness, remembering the most telling refusal along the way. */
class DshSearch {
  best: Refusal = notFound();

  constructor(private readonly platform: NodeJS.Platform) {}

  /** PATH, then the npm global package roots, then the newest supported copy in npm's npx cache. */
  async anywhere(env: NodeJS.ProcessEnv, operatorHome: string): Promise<NativeDshInstallation | null> {
    return (await this.fromLaunchers(pathLaunchers(env, this.platform)))
      ?? (await this.first(globalPackageRoots(env, operatorHome, this.platform)))
      ?? (await this.newest(await npxPackageRoots(env, operatorHome, this.platform)));
  }

  async fromLaunchers(candidates: readonly string[]): Promise<NativeDshInstallation | null> {
    for (const candidate of candidates) {
      const found = await this.first(await packageRootsFor(candidate));
      if (found) return found;
    }
    return null;
  }

  /** The first supported, safely owned package. */
  async first(packageRoots: readonly string[]): Promise<NativeDshInstallation | null> {
    for (const packageRoot of packageRoots) {
      const outcome = await inspect(packageRoot, this.platform);
      if ("root" in outcome) return outcome;
      this.consider(outcome);
    }
    return null;
  }

  async newest(packageRoots: readonly string[]): Promise<NativeDshInstallation | null> {
    let newest: NativeDshInstallation | null = null;
    for (const packageRoot of packageRoots) {
      const outcome = await inspect(packageRoot, this.platform);
      if (!("root" in outcome)) this.consider(outcome);
      else if (!newest || compareAgentVersions(outcome.version, newest.version) > 0) newest = outcome;
    }
    return newest;
  }

  private consider(refusal: Refusal): void {
    if (PRIORITY[refusal.diagnostic] > PRIORITY[this.best.diagnostic]) this.best = refusal;
  }
}
/** Re-verify a recorded package root before every start. */
export async function verifyNativeDshRoot(root: string, platform: NodeJS.Platform = process.platform): Promise<NativeDshInstallation> {
  if (!plainAbsolutePath(root)) throw refuse(notFound());
  const outcome = await inspect(root, platform);
  if ("root" in outcome) return outcome;
  throw refuse(outcome);
}

/** Package roots a PATH or override candidate may belong to, in trust order. */
async function packageRootsFor(candidate: string): Promise<string[]> {
  const exists = await lstat(candidate).then(() => true, () => false);
  if (!exists) return [];
  const roots: string[] = [];
  try {
    const canonical = await realpath(candidate);
    const info = await stat(canonical);
    if (info.isDirectory()) roots.push(canonical);
    else {
      // npm links `<prefix>/bin/dsh` to `…/@deepseek-ai/dsh/lib/bin.js`: climb to
      // the nearest package.json and stop there, whatever it names.
      let directory = dirname(canonical);
      for (let depth = 0; depth < 4; depth += 1) {
        if (await stat(join(directory, "package.json")).then(file => file.isFile(), () => false)) { roots.push(directory); break; }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  } catch { /* unreadable candidate: fall through to the layout beside it */ }
  const beside = dirname(candidate);
  roots.push(join(beside, "node_modules", "@deepseek-ai", "dsh"), resolve(beside, "..", "lib", "node_modules", "@deepseek-ai", "dsh"));
  return [...new Set(roots)];
}

function globalPackageRoots(env: NodeJS.ProcessEnv, operatorHome: string, platform: NodeJS.Platform): string[] {
  const perUser = process.getuid?.() !== 0; // root must not inherit a user-writable per-user install
  if (platform === "win32") {
    const prefixes = [env.npm_config_prefix, env.APPDATA ? join(env.APPDATA, "npm") : undefined];
    return prefixes.filter((prefix): prefix is string => Boolean(prefix && isAbsolute(prefix))).map(prefix => join(prefix, "node_modules", "@deepseek-ai", "dsh"));
  }
  const prefixes = [env.npm_config_prefix, ...(perUser ? [join(operatorHome, ".npm-global"), join(operatorHome, ".local")] : []), "/opt/homebrew", "/usr/local", "/usr"];
  return prefixes.filter((prefix): prefix is string => Boolean(prefix && isAbsolute(prefix))).map(prefix => join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh"));
}

/** Copies `npx` left in npm's cache: `npm_config_cache`, else `~/.npm` (`%LOCALAPPDATA%\npm-cache` on Windows). */
async function npxPackageRoots(env: NodeJS.ProcessEnv, operatorHome: string, platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== "win32" && process.getuid?.() === 0) return []; // root must not inherit a user-writable cache
  const cache = npmCacheFolder(env, operatorHome, platform);
  if (!cache) return [];
  const entries = await readdir(join(cache, "_npx"), { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    .map(name => join(cache, "_npx", name, "node_modules", "@deepseek-ai", "dsh"));
}

function npmCacheFolder(env: NodeJS.ProcessEnv, operatorHome: string, platform: NodeJS.Platform): string | undefined {
  if (env.npm_config_cache && isAbsolute(env.npm_config_cache)) return env.npm_config_cache;
  if (platform !== "win32") return join(operatorHome, ".npm");
  return env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? join(env.LOCALAPPDATA, "npm-cache") : undefined;
}
async function inspect(candidateRoot: string, platform: NodeJS.Platform): Promise<NativeDshInstallation | Refusal> {
  const dsh = family();
  const found = await readPackage(candidateRoot);
  const version = found?.manifest.version;
  if (!found || found.manifest.name !== dsh.package || typeof version !== "string") return notFound();
  const entry = await binEntry(found.root, declaredBin(found.manifest.bin, dsh.hostInstall.bin));
  if (!entry) return notFound();
  if (!hostAgentVersionSupported(dsh, version)) {
    return {
      diagnostic: "dsh_unsupported_version",
      message: `DeepSeek Harness ${version} is not a version Konteks supports (${dsh.hostInstall.versions.min} up to, but not including, ${dsh.hostInstall.versions.belowCore}). Install it with \`${dsh.hostInstall.installCommand}\`, then retry.`,
    };
  }
  return (await unsafeInstall(found.root, entry, platform)) ?? { root: found.root, entry, version };
}

/** The package's real root and its bounded `package.json`; null when either cannot be read. */
async function readPackage(candidateRoot: string): Promise<{ root: string; manifest: { name?: unknown; version?: unknown; bin?: unknown } } | null> {
  try {
    const root = await realpath(candidateRoot);
    const file = join(root, "package.json");
    const info = await stat(file);
    if (!info.isFile() || info.size > 256 * 1024) return null;
    return { root, manifest: JSON.parse(await readFile(file, "utf8")) as { name?: unknown; version?: unknown; bin?: unknown } };
  } catch {
    return null;
  }
}

/** The relative path a package's `bin` declares for `name`. */
function declaredBin(bin: unknown, name: string): unknown {
  if (typeof bin === "string") return bin;
  return bin && typeof bin === "object" ? (bin as Record<string, unknown>)[name] : undefined;
}

/** The real entry file a relative bin path names, only when it stays inside the package root. */
async function binEntry(root: string, binPath: unknown): Promise<string | null> {
  if (typeof binPath !== "string" || binPath.length === 0 || isAbsolute(binPath)) return null;
  const entry = await realFile(resolve(root, binPath));
  if (!entry) return null;
  const inside = relative(root, entry);
  return inside.startsWith("..") || isAbsolute(inside) ? null : entry;
}

async function realFile(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Outside Windows, a root, manifest or entry other users can change refuses the install. */
async function unsafeInstall(root: string, entry: string, platform: NodeJS.Platform): Promise<Refusal | null> {
  if (platform === "win32" || process.platform === "win32") return null;
  for (const path of [root, join(root, "package.json"), entry]) {
    if (!safelyOwned(await stat(path))) {
      return { diagnostic: "dsh_unsafe_install", message: `The DeepSeek Harness installation at ${root} can be changed by other users; reinstall it for this user only, then retry.` };
    }
  }
  return null;
}
/**
 * The Node that runs the person's DeepSeek Harness. The connector is a Node
 * single-executable app and cannot run another script, so dsh runs on the
 * person's own Node, normally the one it was installed with: an absolute
 * DSH_NODE override, the Node of the npm prefix holding dsh, PATH, then the
 * usual install locations. It must satisfy dsh's engines (^22.19.0 || >=24).
 * Running `node --version` is the only execution, of the binary that will run
 * dsh anyway.
 */
export async function resolveNativeDshNode(
  installation: NativeDshInstallation,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: { version?: (node: string) => Promise<string | null> } = {},
): Promise<string> {
  const found = await locatePersonNode(dshNodeCandidates(installation, env, platform), nodeSupported, platform, deps);
  if (found.node !== null) return found.node;
  throw refuse(nodeUnsupported(found.seen));
}

function dshNodeCandidates(installation: NativeDshInstallation, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (env.DSH_NODE !== undefined) {
    if (!plainAbsolutePath(env.DSH_NODE)) throw refuse(nodeUnsupported(null));
    return [env.DSH_NODE];
  }
  const binary = platform === "win32" ? "node.exe" : "node";
  // <prefix>/lib/node_modules/@deepseek-ai/dsh -> <prefix>/bin/node (npm, nvm, Homebrew);
  // <nodejs>\node_modules\@deepseek-ai\dsh -> <nodejs>\node.exe (Windows installer prefix).
  return [platform === "win32" ? resolve(installation.root, "..", "..", "..", binary) : resolve(installation.root, "..", "..", "..", "..", "bin", binary),
    ...personNodeCandidates(env, platform)];
}
/** Where a person's own Node usually is: every PATH folder, then the usual install locations. */
export function personNodeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const binary = platform === "win32" ? "node.exe" : "node";
  const onPath = absolutePathEntries(env.PATH, platform === "win32" ? ";" : ":").map(directory => join(directory, binary));
  return [...onPath, ...usualNodeLocations(env, platform, binary)];
}

function usualNodeLocations(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, binary: string): string[] {
  if (platform !== "win32") return ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  return [env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((programs): programs is string => Boolean(programs && isAbsolute(programs)))
    .map(programs => join(programs, "nodejs", binary));
}
/**
 * The first candidate that is a safely owned executable (the person's or
 * root's, not group or world writable) reporting a version `supported`
 * accepts; `seen` is the first version reported by one that did not qualify.
 * `node --version` is the only thing run. Shared by DeepSeek Harness and the
 * connector's QA browser.
 */
export function locatePersonNode(
  candidates: readonly string[],
  supported: (reported: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  deps: { version?: (node: string) => Promise<string | null> } = {},
): Promise<{ node: string; version: string } | { node: null; seen: string | null }> {
  return firstSupportedNode([...new Set(candidates)], supported, platform, deps.version ?? nodeVersion);
}

async function firstSupportedNode(
  candidates: readonly string[],
  supported: (reported: string) => boolean,
  platform: NodeJS.Platform,
  version: (node: string) => Promise<string | null>,
): Promise<{ node: string; version: string } | { node: null; seen: string | null }> {
  let seen: string | null = null;
  for (const candidate of candidates) {
    const node = await runnableNode(candidate, platform);
    if (node === null) continue;
    const reported = await version(node).catch(() => null);
    if (reported !== null && supported(reported)) return { node, version: reported.trim() };
    seen ??= reported;
  }
  return { node: null, seen };
}

/** The candidate's real path when it is a file, and outside Windows a safely owned executable. */
async function runnableNode(candidate: string, platform: NodeJS.Platform): Promise<string | null> {
  try {
    const node = await realpath(candidate);
    const info = await stat(node);
    if (!info.isFile()) return null;
    if (platform !== "win32" && process.platform !== "win32") {
      if (!safelyOwned(info)) return null;
      await access(node, constants.X_OK);
    }
    return node;
  } catch {
    return null;
  }
}
function nodeSupported(reported: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(reported.trim());
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}

function nodeUnsupported(seen: string | null): Refusal {
  return {
    diagnostic: "dsh_node_unsupported",
    message: `DeepSeek Harness needs Node 22.19 or newer in the 22 line, or Node 24 or newer${seen ? ` (found ${seen.trim().slice(0, 32)})` : ""}. Install it from https://nodejs.org, then retry.`,
  };
}

function nodeVersion(node: string): Promise<string | null> {
  return new Promise(resolveVersion => {
    execFile(node, ["--version"], { timeout: 5_000, windowsHide: true, env: { PATH: process.env.PATH ?? "" } }, (error, stdout) => resolveVersion(error ? null : String(stdout).trim()));
  });
}

/** What an install record keeps for the person's DeepSeek Harness: its package and the Node that runs it. */
export async function locateNativeDsh(env: NodeJS.ProcessEnv = process.env): Promise<{ dshRoot: string; dshNode: string }> {
  const installation = await resolveNativeDshInstallation(env);
  return { dshRoot: installation.root, dshNode: await resolveNativeDshNode(installation, env) };
}
