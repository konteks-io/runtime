import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { findAgentBridge, hostAgentVersionSupported, type AgentBridgeFamily } from "@konteks/remote-release";

/** The person's own installed DeepSeek Harness, as the runtime will launch it. */
export interface NativeDshInstallation {
  /** Canonical package root (`…/node_modules/@deepseek-ai/dsh`). */
  root: string;
  /** Canonical `bin.dsh` entry inside the root; the runtime's bundled Node runs it. */
  entry: string;
  version: string;
}

type Refusal = { diagnostic: "dsh_not_found" | "dsh_unsupported_version" | "dsh_unsafe_install"; message: string };
const PRIORITY: Record<Refusal["diagnostic"], number> = { dsh_not_found: 0, dsh_unsafe_install: 1, dsh_unsupported_version: 2 };

function family(): AgentBridgeFamily & { hostInstall: NonNullable<AgentBridgeFamily["hostInstall"]> } {
  const dsh = findAgentBridge("dsh");
  if (!dsh?.hostInstall) throw new Error("the dsh host-agent family is not registered");
  return dsh as AgentBridgeFamily & { hostInstall: NonNullable<AgentBridgeFamily["hostInstall"]> };
}

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
 * yarn global) are reached through DSH_EXECUTABLE. The first supported,
 * safely owned package wins. Operator process configuration only; never take
 * this path from Core or ACP.
 */
export async function resolveNativeDshInstallation(env: NodeJS.ProcessEnv = process.env, operatorHome = homedir(), platform: NodeJS.Platform = process.platform): Promise<NativeDshInstallation> {
  const bin = family().hostInstall.bin;
  const candidates: string[] = [];
  const override = env.DSH_EXECUTABLE;
  if (override !== undefined) {
    if (!isAbsolute(override) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(override)) throw refuse({ diagnostic: "dsh_not_found", message: "DSH_EXECUTABLE must be an absolute path to the installed @deepseek-ai/dsh package or its launcher." });
    candidates.push(override);
  } else {
    const names = platform === "win32"
      ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => `${bin}${ext.toLowerCase()}`), `${bin}.ps1`, bin]
      : [bin];
    for (const directory of (env.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
      if (directory && isAbsolute(directory)) for (const name of names) candidates.push(join(directory, name));
    }
  }
  let best: Refusal = notFound();
  for (const candidate of candidates) {
    for (const packageRoot of await packageRootsFor(candidate)) {
      const outcome = await inspect(packageRoot, platform);
      if ("root" in outcome) return outcome;
      if (PRIORITY[outcome.diagnostic] > PRIORITY[best.diagnostic]) best = outcome;
    }
  }
  if (override === undefined) {
    for (const packageRoot of globalPackageRoots(env, operatorHome, platform)) {
      const outcome = await inspect(packageRoot, platform);
      if ("root" in outcome) return outcome;
      if (outcome.diagnostic !== "dsh_not_found" && PRIORITY[outcome.diagnostic] > PRIORITY[best.diagnostic]) best = outcome;
    }
  }
  throw refuse(best);
}

/** Re-verify a recorded package root before every start. */
export async function verifyNativeDshRoot(root: string, platform: NodeJS.Platform = process.platform): Promise<NativeDshInstallation> {
  if (!isAbsolute(root) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(root)) throw refuse(notFound());
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

async function inspect(candidateRoot: string, platform: NodeJS.Platform): Promise<NativeDshInstallation | Refusal> {
  const dsh = family();
  let root: string;
  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    root = await realpath(candidateRoot);
    const file = join(root, "package.json");
    const info = await stat(file);
    if (!info.isFile() || info.size > 256 * 1024) return notFound();
    manifest = JSON.parse(await readFile(file, "utf8")) as typeof manifest;
  } catch {
    return notFound();
  }
  if (manifest.name !== dsh.package || typeof manifest.version !== "string") return notFound();
  const binPath = typeof manifest.bin === "string" ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object" ? (manifest.bin as Record<string, unknown>)[dsh.hostInstall.bin] : undefined;
  if (typeof binPath !== "string" || binPath.length === 0 || isAbsolute(binPath)) return notFound();
  let entry: string;
  try {
    entry = await realpath(resolve(root, binPath));
    if (!(await stat(entry)).isFile()) return notFound();
  } catch {
    return notFound();
  }
  const inside = relative(root, entry);
  if (inside.startsWith("..") || isAbsolute(inside)) return notFound();
  if (!hostAgentVersionSupported(dsh, manifest.version)) {
    return {
      diagnostic: "dsh_unsupported_version",
      message: `DeepSeek Harness ${manifest.version} is not a version Konteks supports (${dsh.hostInstall.versions.min} up to, but not including, ${dsh.hostInstall.versions.belowCore}). Install it with \`${dsh.hostInstall.installCommand}\`, then retry.`,
    };
  }
  if (platform !== "win32" && process.platform !== "win32") {
    for (const path of [root, join(root, "package.json"), entry]) {
      const info = await stat(path);
      const owner = info.uid === process.getuid?.() || info.uid === 0;
      if (!owner || (info.mode & 0o022) !== 0) {
        return { diagnostic: "dsh_unsafe_install", message: `The DeepSeek Harness installation at ${root} can be changed by other users; reinstall it for this user only, then retry.` };
      }
    }
  }
  return { root, entry, version: manifest.version };
}
