import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { openCodeScratchEnvironment } from "@konteks/remote-agent-runner";
import { hostAgentFamily, hostAgentVersionSupported, hostInstallCommand, type HostAgentFamily } from "@konteks/remote-release";

/** The person's own installed OpenCode 2, as the runtime will launch it. */
export interface NativeOpenCodeInstallation {
  /** Canonical path of the native executable (never a shim). */
  binary: string;
  version: string;
}

type Diagnostic = "opencode_not_found" | "opencode_unsupported_version" | "opencode_unsafe_install";
type Refusal = { diagnostic: Diagnostic; message: string };
const PRIORITY: Record<Diagnostic, number> = { opencode_not_found: 0, opencode_unsafe_install: 1, opencode_unsupported_version: 2 };

/** OpenCode ships a ~180 MB native executable; anything this small is a shim (scoop, choco, a script). */
export const OPENCODE_MIN_BINARY_BYTES = 1024 * 1024;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;
/** npm packages whose `bin/opencode.exe` is OpenCode: 2.x, and 1.x (named so it can be refused by name). */
const NPM_PACKAGES = ["@opencode/cli", "opencode-ai"] as const;

export interface OpenCodeLocatorDeps {
  /** Runs `<binary> --version` (scrubbed environment, throwaway home); replaced only in tests. */
  versionOutput?: (binary: string) => Promise<string | null>;
}

const family = (): HostAgentFamily => hostAgentFamily("opencode");

function refuse(refusal: Refusal): RemoteInstanceError {
  return new RemoteInstanceError("prerequisite_missing", refusal.message, { diagnostic: refusal.diagnostic, recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] });
}

function notFound(platform: NodeJS.Platform): Refusal {
  return { diagnostic: "opencode_not_found", message: `OpenCode 2 is not installed for this user. Install it with \`${hostInstallCommand(family(), platform)}\`, then retry.` };
}

function unsupported(version: string | null, platform: NodeJS.Platform): Refusal {
  const command = hostInstallCommand(family(), platform);
  const { min, belowCore } = family().hostInstall.versions;
  if (version === null) return { diagnostic: "opencode_unsupported_version", message: `The installed OpenCode did not report its version. Install OpenCode 2 with \`${command}\`, then retry.` };
  if (/^v?1\./.test(version)) return { diagnostic: "opencode_unsupported_version", message: `OpenCode 1 is not supported (found ${version}): install OpenCode 2 with \`${command}\`, then retry.` };
  return { diagnostic: "opencode_unsupported_version", message: `OpenCode ${version} is not a version Konteks supports (${min} up to, but not including, ${belowCore}). Install OpenCode 2 with \`${command}\`, then retry.` };
}

function unsafe(path: string, platform: NodeJS.Platform): Refusal {
  return { diagnostic: "opencode_unsafe_install", message: `The OpenCode installation at ${path} can be changed by other users; reinstall it for this user only with \`${hostInstallCommand(family(), platform)}\`, then retry.` };
}

/**
 * Locate the person's own OpenCode 2 without running anything but, at most,
 * one `--version` of a safely owned native executable (with the allow-list
 * environment, in a throwaway home). Order:
 * 1. `OPENCODE_EXECUTABLE`: an absolute path to the executable, a shim, or
 *    the `@opencode/cli` package folder (operator override; nothing else is
 *    searched);
 * 2. `PATH`: every folder for `opencode2` first (OpenCode 1 also claims
 *    `opencode`), then `opencode`; on Windows each `PATHEXT` name;
 * 3. the homepage installer's `~/.opencode/bin`, the npm global roots
 *    (`@opencode/cli/bin/opencode.exe`), Homebrew, and on Windows scoop and
 *    Chocolatey shims.
 * A shim is resolved to its target by layout (the executable beside it, npm's
 * `node_modules`, scoop's `.shim` file, Chocolatey's `lib`), never run. The
 * first supported, safely owned executable wins; otherwise the most telling
 * refusal (unsupported version, then unsafe, then not found), each naming the
 * install command. Operator process configuration only; never from Core or ACP.
 */
export async function resolveNativeOpenCodeInstallation(
  env: NodeJS.ProcessEnv = process.env,
  operatorHome = homedir(),
  platform: NodeJS.Platform = process.platform,
  deps: OpenCodeLocatorDeps = {},
): Promise<NativeOpenCodeInstallation> {
  const hostInstall = family().hostInstall;
  const candidates: string[] = [];
  const override = env.OPENCODE_EXECUTABLE;
  if (override !== undefined) {
    if (!isAbsolute(override) || CONTROL.test(override)) {
      throw refuse({ diagnostic: "opencode_not_found", message: "OPENCODE_EXECUTABLE must be an absolute path to the installed OpenCode 2 executable or its @opencode/cli package." });
    }
    candidates.push(override);
  } else {
    const windows = platform === "win32";
    const extensions = windows ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => ext.toLowerCase()), ".ps1", ""] : [""];
    const directories = (env.PATH ?? "").split(windows ? ";" : ":").filter(directory => directory && isAbsolute(directory));
    for (const name of hostInstall.pathNames ?? [hostInstall.bin]) {
      for (const directory of directories) for (const extension of extensions) candidates.push(join(directory, `${name}${extension}`));
    }
    candidates.push(...fallbackCandidates(env, operatorHome, platform));
  }
  let best: Refusal = notFound(platform);
  for (const candidate of [...new Set(candidates)]) {
    for (const binary of await binariesFor(candidate, platform)) {
      const outcome = await inspect(binary, platform, deps);
      if ("binary" in outcome) return outcome;
      if (PRIORITY[outcome.diagnostic] > PRIORITY[best.diagnostic]) best = outcome;
    }
  }
  throw refuse(best);
}

/** Re-verify a recorded executable before every start (ownership, kind and version). */
export async function verifyNativeOpenCodeBinary(binary: string, platform: NodeJS.Platform = process.platform, deps: OpenCodeLocatorDeps = {}): Promise<NativeOpenCodeInstallation> {
  if (!isAbsolute(binary) || CONTROL.test(binary)) throw refuse(notFound(platform));
  const outcome = await inspect(binary, platform, deps);
  if ("binary" in outcome) return outcome;
  throw refuse(outcome);
}

/** What an install record keeps for the person's OpenCode. */
export async function locateNativeOpenCode(env: NodeJS.ProcessEnv = process.env): Promise<{ opencodeBinary: string; opencodeVersion: string }> {
  const installation = await resolveNativeOpenCodeInstallation(env);
  return { opencodeBinary: installation.binary, opencodeVersion: installation.version };
}

/** Documented install locations, after PATH. Root never inherits a user-writable per-user install. */
function fallbackCandidates(env: NodeJS.ProcessEnv, operatorHome: string, platform: NodeJS.Platform): string[] {
  const perUser = process.getuid?.() !== 0;
  const npmBinary = (prefix: string, windows: boolean) => windows ? join(prefix, "node_modules", "@opencode", "cli", "bin", "opencode.exe") : join(prefix, "lib", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  const absolute = (path: string | undefined): path is string => Boolean(path && isAbsolute(path));
  if (platform === "win32") {
    const profile = absolute(env.USERPROFILE) ? env.USERPROFILE : operatorHome;
    const scoop = absolute(env.SCOOP) ? env.SCOOP : join(profile, "scoop");
    const choco = absolute(env.ChocolateyInstall) ? env.ChocolateyInstall : absolute(env.ProgramData) ? join(env.ProgramData, "chocolatey") : undefined;
    return [
      ...(perUser ? [join(profile, ".opencode", "bin", "opencode.exe")] : []),
      ...[env.npm_config_prefix, absolute(env.APPDATA) ? join(env.APPDATA, "npm") : undefined].filter(absolute).map(prefix => npmBinary(prefix, true)),
      ...(perUser ? ["opencode2.exe", "opencode.exe"].map(name => join(scoop, "shims", name)) : []),
      ...(choco ? ["opencode2.exe", "opencode.exe"].map(name => join(choco, "bin", name)) : []),
    ];
  }
  const prefixes = [env.npm_config_prefix, ...(perUser ? [join(operatorHome, ".npm-global"), join(operatorHome, ".local")] : []), "/opt/homebrew", "/usr/local", "/usr"].filter(absolute);
  return [
    ...(perUser ? [join(operatorHome, ".opencode", "bin", "opencode")] : []),
    ...prefixes.map(prefix => npmBinary(prefix, false)),
    ...["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"].flatMap(directory => ["opencode2", "opencode"].map(name => join(directory, name))),
  ];
}

/** Executables a candidate may stand for, in trust order, found without running or parsing any script. */
async function binariesFor(candidate: string, platform: NodeJS.Platform): Promise<string[]> {
  if (!(await lstat(candidate).then(() => true, () => false))) return [];
  const windows = platform === "win32";
  const executable = windows ? "opencode.exe" : "opencode";
  const out: string[] = [];
  let canonical: string | null = null;
  try {
    canonical = await realpath(candidate);
    const info = await stat(canonical);
    // The @opencode/cli package folder itself (an override may name it).
    if (info.isDirectory()) return [join(canonical, "bin", "opencode.exe")];
    if (await nativeExecutable(canonical)) return [canonical];
  } catch { /* unreadable: try the layouts beside it */ }
  const beside = dirname(candidate);
  // scoop: `<shims>/opencode.exe` + `opencode.shim` naming the real path.
  const shimTarget = await scoopShimTarget(join(beside, `${basename(candidate, extname(candidate))}.shim`));
  if (shimTarget) out.push(shimTarget);
  // The homepage installer's `opencode2` (or `opencode2.cmd`) next to the executable.
  out.push(join(beside, executable));
  if (canonical && canonical !== candidate) out.push(join(dirname(canonical), executable));
  // npm: Windows `.cmd`/`.ps1` shims with node_modules beside them; a POSIX wrapper under <prefix>/bin.
  out.push(join(beside, "node_modules", "@opencode", "cli", "bin", "opencode.exe"), resolve(beside, "..", "lib", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
  // Chocolatey: `<choco>/bin/opencode.exe` is a shim for `<choco>/lib/<package>/tools/…`.
  if (windows && basename(beside).toLowerCase() === "bin") out.push(...await chocolateyTargets(dirname(beside)));
  return [...new Set(out)];
}

async function scoopShimTarget(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 4096) return null;
    const match = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/m.exec(await readFile(file, "utf8"));
    return match && isAbsolute(match[1]!) && !CONTROL.test(match[1]!) ? match[1]! : null;
  } catch {
    return null;
  }
}

async function chocolateyTargets(chocoRoot: string): Promise<string[]> {
  const lib = join(chocoRoot, "lib");
  const packages = await readdir(lib, { withFileTypes: true }).catch(() => []);
  return packages.filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith("opencode")).map(entry => entry.name).sort()
    .flatMap(name => [join(lib, name, "tools", "opencode.exe"), join(lib, name, "tools", "bin", "opencode.exe")]);
}

/** A native executable (Mach-O, ELF or PE) of a plausible size; scripts and shims are not. */
async function nativeExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < OPENCODE_MIN_BINARY_BYTES) return false;
    const handle = await open(path, constants.O_RDONLY);
    try {
      const head = Buffer.alloc(4);
      await handle.read(head, 0, 4, 0);
      const magic = head.readUInt32BE(0);
      return head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF"
        || head.toString("latin1", 0, 2) === "MZ"
        || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
    } finally { await handle.close(); }
  } catch {
    return false;
  }
}

function safelyOwned(info: { uid: number; mode: number }): boolean {
  const owner = info.uid === process.getuid?.() || info.uid === 0;
  return owner && (info.mode & 0o022) === 0;
}

async function inspect(candidate: string, platform: NodeJS.Platform, deps: OpenCodeLocatorDeps): Promise<NativeOpenCodeInstallation | Refusal> {
  let binary: string;
  try {
    binary = await realpath(candidate);
  } catch {
    return notFound(platform);
  }
  if (!(await nativeExecutable(binary))) return notFound(platform);
  const posixOwnership = platform !== "win32" && process.platform !== "win32";
  // Same rule as the Claude executable: user- or root-owned, not writable by others.
  if (posixOwnership) {
    const info = await stat(binary);
    if (!safelyOwned(info)) return unsafe(binary, platform);
    try { await access(binary, constants.X_OK); } catch { return notFound(platform); }
  }
  const packaged = await npmPackageVersion(binary, posixOwnership);
  if (packaged === "unsafe") return unsafe(binary, platform);
  const version = packaged ?? await cachedVersion(binary, deps);
  if (version === null || !hostAgentVersionSupported(family(), version)) return unsupported(version, platform);
  return { binary, version };
}

/**
 * The version npm recorded beside its shim: `<package>/bin/opencode.exe` with
 * `<package>/package.json` naming `@opencode/cli` (or 1.x's `opencode-ai`).
 */
async function npmPackageVersion(binary: string, posixOwnership: boolean): Promise<string | "unsafe" | null> {
  if (basename(binary) !== "opencode.exe" || basename(dirname(binary)) !== "bin") return null;
  const file = join(dirname(dirname(binary)), "package.json");
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const manifest = JSON.parse(await readFile(file, "utf8")) as { name?: unknown; version?: unknown };
    if (!NPM_PACKAGES.includes(manifest.name as (typeof NPM_PACKAGES)[number]) || typeof manifest.version !== "string") return null;
    if (posixOwnership && !safelyOwned(info)) return "unsafe";
    return manifest.version;
  } catch {
    return null;
  }
}

const versionCaches = new WeakMap<(binary: string) => Promise<string | null>, Map<string, Promise<string | null>>>();

/** One `--version` per executable file (path, inode, size and modification time), per process. */
async function cachedVersion(binary: string, deps: OpenCodeLocatorDeps): Promise<string | null> {
  const run = deps.versionOutput ?? openCodeVersionOutput;
  let cache = versionCaches.get(run);
  if (!cache) versionCaches.set(run, cache = new Map());
  const info = await stat(binary);
  const key = `${binary}\u0000${info.ino}\u0000${info.size}\u0000${info.mtimeMs}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = run(binary).then(parseOpenCodeVersion, () => null);
    if (cache.size >= 32) cache.delete(cache.keys().next().value as string);
    cache.set(key, pending);
  }
  return pending;
}

/** `opencode v2.0.18`, `2.0.18` or `1.18.33` → the semantic version; anything else → null. */
export function parseOpenCodeVersion(output: string | null): string | null {
  if (output === null) return null;
  const first = output.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/.exec(first.trim());
  return match ? match[1]! : null;
}

/**
 * Run `<binary> --version` once: the allow-list environment (no inherited
 * credential or `OPENCODE_*` variable), a throwaway private home and working
 * folder, a short timeout and bounded output. Nothing else of OpenCode runs
 * during detection.
 */
export async function openCodeVersionOutput(binary: string): Promise<string | null> {
  const scratch = await mkdtemp(join(tmpdir(), "konteks-opencode-"));
  try {
    const env = openCodeScratchEnvironment(scratch);
    return await new Promise<string | null>(done => {
      execFile(binary, ["--version"], { cwd: scratch, env, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => done(error ? null : String(stdout)));
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** How the person installed the OpenCode the connector runs, in words for doctor (never the path). */
export type OpenCodeInstallKind = "homepage installer" | "npm" | "Homebrew" | "scoop" | "Chocolatey" | "another location";

/** Read from the canonical executable path the locator returned (so a shim already points at its target). */
export function openCodeInstallKind(binary: string): OpenCodeInstallKind {
  const path = binary.replace(/\\/g, "/");
  const lower = path.toLowerCase();
  if (/\/node_modules\/@opencode\/cli\/bin\//.test(path)) return "npm";
  if (/\/\.opencode\/bin\//.test(path)) return "homepage installer";
  if (/\/cellar\//.test(lower) || lower.startsWith("/opt/homebrew/") || lower.includes("/.linuxbrew/")) return "Homebrew";
  if (lower.includes("/scoop/")) return "scoop";
  if (lower.includes("/chocolatey/")) return "Chocolatey";
  return "another location";
}

/** For the launcher's onboarding remedies (it depends on the supervisor, not the agent-runner). */
export { personalOpenCodeDataExists } from "@konteks/remote-agent-runner";
