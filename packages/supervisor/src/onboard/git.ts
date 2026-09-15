import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RemoteInstanceError, createLogger, runCommand, sanitizeInheritedChildProcessEnv, sha256Hex, type Logger } from "@konteks/remote-common";

/**
 * The onboard role's git access (OB6 §5, invariant 3, amendments A5/A10).
 *
 * The runtime uses **the machine's own git access** for a customer's VCS —
 * whatever `git` on this machine already authenticates with, exactly as native
 * delivery does — and its own registered key for managed git. Core's connector
 * credential never reaches a runtime and the broker is never called from here,
 * so there is no credential lane to build: the only thing this module does is
 * run `git` and read what the local credential helper already holds.
 *
 * A side this machine cannot read is NOT an exception. It is reported back as
 * an ordinary evidence gap (`credential_unavailable`) carrying the remedy a
 * person can act on ("sign in to that provider on this machine"), because an
 * unreadable repository is a fact about the portfolio, not a fault of the run.
 */

/** Never prompt, never open a pager, never let a helper block a bounded run. */
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "0",
  // An askpass that exits non-zero turns "we have no credential" into an
  // immediate refusal instead of a hang on a machine with a GUI helper.
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  SSH_ASKPASS_REQUIRE: "never",
} as const;

export const CREDENTIAL_UNAVAILABLE_REMEDY =
  "sign in to this provider with git on the machine running this Konteks runtime";

export type GitGapCode = "credential_unavailable" | "not_found" | "unavailable";

/** An evidence gap, never an exception text (OB6 §5). */
export interface GitGap {
  code: GitGapCode;
  /** What a person does about it. Bounded prose; never command output. */
  remedy: string;
}

export type GitResult<T> = { ok: true; value: T } | { ok: false; gap: GitGap };

export const gitOk = <T>(value: T): GitResult<T> => ({ ok: true, value });
export const gitGap = <T>(code: GitGapCode, remedy: string): GitResult<T> => ({ ok: false, gap: { code, remedy } });

/** One `ref → head sha` pair as `git ls-remote` reports it. */
export interface GitRef {
  ref: string;
  sha: string;
}

/**
 * How this machine reaches one repository. `identityFile` is present only for
 * managed git, where the runtime's own registered key IS the person's
 * credential (A10); for a customer connector it is absent and git resolves
 * whatever it already has.
 */
export interface GitRemote {
  url: string;
  identityFile?: string;
}

export interface GitAccess {
  /** The git version on this machine, or `null` when git is not on PATH. */
  version(): Promise<string | null>;
  lsRemote(remote: GitRemote): Promise<GitResult<GitRef[]>>;
  /**
   * `git archive --remote`; `not_found` when the host refuses the protocol
   * (GitHub disables it outright) so the caller falls through to the raw-file
   * API. The tar is written to `tarPath` rather than captured, because command
   * output here is decoded text and a tar is not text.
   */
  archiveFile(remote: GitRemote, ref: string, path: string, tarPath: string): Promise<GitResult<Buffer>>;
  /** What the local credential helper holds for a URL, if anything. */
  credential(url: string): Promise<GitResult<{ username: string; password: string }>>;
  cloneShallow(remote: GitRemote, directory: string): Promise<GitResult<void>>;
  cloneMirror(remote: GitRemote, directory: string): Promise<GitResult<void>>;
  pushMirror(directory: string, remote: GitRemote): Promise<GitResult<void>>;
}

/**
 * The digest both sides of a relocation are compared on (G6): sha256 over the
 * sorted `"<ref> <sha>"` lines. Sorting is what makes two providers that
 * enumerate refs in different orders comparable at all.
 */
export function refDigest(refs: readonly GitRef[]): string {
  const lines = [...refs].map(entry => `${entry.ref} ${entry.sha}`).sort();
  return sha256Hex(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}

/** Parse `git ls-remote` output. Peeled tags (`^{}`) are refs like any other. */
export function parseLsRemote(stdout: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (match) refs.push({ sha: match[1]!, ref: match[2]! });
  }
  return refs;
}

/**
 * Classify a git failure into an evidence gap. Only the exit code and a small
 * set of stable phrases are read: the message itself is never surfaced, because
 * git prints the remote URL (and occasionally a helper's own output) into it.
 */
export function classifyGitFailure(stderr: string): GitGap {
  const text = stderr.toLowerCase();
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("permission denied") ||
    text.includes("terminal prompts disabled") ||
    text.includes("access denied") ||
    text.includes("403 forbidden") ||
    text.includes("401 unauthorized") ||
    text.includes("invalid username or token")
  ) {
    return { code: "credential_unavailable", remedy: CREDENTIAL_UNAVAILABLE_REMEDY };
  }
  if (text.includes("repository not found") || text.includes("not found") || text.includes("does not exist") || text.includes("404")) {
    return { code: "not_found", remedy: "confirm the repository still exists and this machine may see it" };
  }
  return { code: "unavailable", remedy: "retry when this machine can reach the provider" };
}

export interface LocalGitOptions {
  /** Injected in tests; production runs the real subprocess. */
  run?: typeof runCommand;
  /** How long a single git invocation may take. */
  timeoutMs?: number;
  /** How long a probed git version stays fresh. */
  versionTtlMs?: number;
  now?: () => number;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const VERSION_TTL_MS = 60_000;

export class LocalGit implements GitAccess {
  private readonly run: typeof runCommand;
  private readonly timeoutMs: number;
  private readonly versionTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private probed: { version: string | null; at: number } | null = null;

  constructor(options: LocalGitOptions = {}) {
    this.run = options.run ?? runCommand;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.versionTtlMs = options.versionTtlMs ?? VERSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? createLogger({ name: "onboard-git" });
  }

  async version(): Promise<string | null> {
    const cached = this.probed;
    if (cached && this.now() - cached.at <= this.versionTtlMs) return cached.version;
    let version: string | null = null;
    try {
      const result = await this.run({ command: "git", args: ["--version"], env: this.env(), timeoutMs: 10_000 });
      const match = result.code === 0 ? /\b(\d+\.\d+(?:\.\d+)*)\b/.exec(result.stdout) : null;
      version = match ? match[1]! : null;
    } catch {
      // A missing executable is an ordinary answer here: the runtime simply
      // advertises neither onboard capability and Core reports it ineligible.
      version = null;
    }
    this.probed = { version, at: this.now() };
    return version;
  }

  async lsRemote(remote: GitRemote): Promise<GitResult<GitRef[]>> {
    const result = await this.git(remote, ["ls-remote", "--quiet", remote.url]);
    if (!result.ok) return result;
    return gitOk(parseLsRemote(result.value.stdout));
  }

  async archiveFile(remote: GitRemote, ref: string, path: string, tarPath: string): Promise<GitResult<Buffer>> {
    // `git archive --remote` is the cheapest single-file read that exists, but
    // GitHub disables the protocol entirely and several hosts disable it per
    // repository. A refusal is `not_found` so the caller falls through to the
    // raw-file API rather than treating the host as unreachable.
    await mkdir(dirname(tarPath), { recursive: true, mode: 0o700 });
    const result = await this.git(remote, ["archive", "--format=tar", `--remote=${remote.url}`, "-o", tarPath, ref, "--", path]);
    if (!result.ok) {
      await rm(tarPath, { force: true });
      return result;
    }
    try {
      const entry = firstTarEntry(await readFile(tarPath), path);
      return entry ? gitOk(entry) : gitGap("not_found", "the repository does not carry this file at its default branch");
    } catch {
      return gitGap("not_found", "the repository does not carry this file at its default branch");
    } finally {
      await rm(tarPath, { force: true });
    }
  }

  async credential(url: string): Promise<GitResult<{ username: string; password: string }>> {
    // Git credentials are read THROUGH git (the OB6 gotcha): never by importing
    // a host login cache the way the agent lane's `host-cache-import` does, and
    // never by reading a helper's private store directly.
    const parsed = safeUrl(url);
    if (!parsed) return gitGap("unavailable", "the repository URL is not an HTTP(S) location");
    const request = `protocol=${parsed.protocol.replace(":", "")}\nhost=${parsed.host}\npath=${parsed.pathname.replace(/^\//, "")}\n\n`;
    let result;
    try {
      result = await this.run({ command: "git", args: ["credential", "fill"], env: this.env(), input: request, timeoutMs: 20_000 });
    } catch {
      return gitGap("credential_unavailable", CREDENTIAL_UNAVAILABLE_REMEDY);
    }
    if (result.code !== 0) return gitGap("credential_unavailable", CREDENTIAL_UNAVAILABLE_REMEDY);
    const fields = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1));
    }
    const password = fields.get("password");
    if (!password) return gitGap("credential_unavailable", CREDENTIAL_UNAVAILABLE_REMEDY);
    return gitOk({ username: fields.get("username") ?? "x-access-token", password });
  }

  async cloneShallow(remote: GitRemote, directory: string): Promise<GitResult<void>> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result = await this.git(remote, ["clone", "--depth", "1", "--filter=blob:none", "--no-tags", "--quiet", "--", remote.url, directory]);
    return result.ok ? gitOk(undefined) : result;
  }

  async cloneMirror(remote: GitRemote, directory: string): Promise<GitResult<void>> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result = await this.git(remote, ["clone", "--mirror", "--quiet", "--", remote.url, directory]);
    return result.ok ? gitOk(undefined) : result;
  }

  async pushMirror(directory: string, remote: GitRemote): Promise<GitResult<void>> {
    // A mirror push is idempotent: re-running it after a worker died between
    // `sync` and `verify` converges on the same refs rather than duplicating
    // anything (G6, OB6 §3).
    const result = await this.git(remote, ["push", "--mirror", "--quiet", "--", remote.url], { cwd: directory });
    return result.ok ? gitOk(undefined) : result;
  }

  private async git(
    remote: GitRemote,
    args: readonly string[],
    options: { cwd?: string } = {},
  ): Promise<GitResult<{ stdout: string }>> {
    let result;
    try {
      result = await this.run({
        command: "git",
        args: [...args],
        env: this.env(remote.identityFile),
        timeoutMs: this.timeoutMs,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch {
      return gitGap("unavailable", "git could not be started on this machine");
    }
    if (result.code !== 0) {
      const gap = classifyGitFailure(result.stderr);
      this.logger.info({ operation: args[0], gap: gap.code }, "git refused an onboard operation");
      return { ok: false, gap };
    }
    return gitOk({ stdout: result.stdout });
  }

  private env(identityFile?: string): NodeJS.ProcessEnv {
    const env = sanitizeInheritedChildProcessEnv({ env: process.env });
    Object.assign(env, NON_INTERACTIVE_ENV);
    if (identityFile) {
      // Managed git is the one place the runtime's own key is the credential
      // (A10). `IdentitiesOnly` stops ssh from offering every agent key first
      // and being refused before it reaches ours.
      env.GIT_SSH_COMMAND = `ssh -i ${identityFile} -o IdentitiesOnly=yes -o BatchMode=yes`;
    }
    return env;
  }
}

/** Extract one file from an uncompressed tar stream produced by `git archive`. */
export function firstTarEntry(tar: Buffer, path: string): Buffer | null {
  const wanted = path.replace(/^\.\//, "");
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (name === wanted || name.endsWith(`/${wanted}`)) return Buffer.from(body);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The scratch the onboard lane owns, split in two on purpose. **Clones** live
 * under `clones/` and nowhere else, so "the clones directory stayed empty" is a
 * checkable proof that a `grouping` pass never cloned anything (OB6 acceptance
 * criteria); the short-lived tar a single-file `git archive` writes lives under
 * `archives/` so it cannot be mistaken for one.
 */
export class OnboardScratch {
  readonly clonesRoot: string;
  readonly archivesRoot: string;

  constructor(root: string) {
    this.clonesRoot = join(root, "clones");
    this.archivesRoot = join(root, "archives");
  }

  /** A per-read tar path; the caller deletes it, and so does `archiveFile`. */
  archivePath(name: string): string {
    return join(this.archivesRoot, `${safeName(name)}.tar`);
  }

  async reserveClone(name: string): Promise<string> {
    const directory = join(this.clonesRoot, safeName(name));
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async releaseClone(name: string): Promise<void> {
    await rm(join(this.clonesRoot, safeName(name)), { recursive: true, force: true });
  }

  /** What is on disk right now; the enrichment worker asserts it drains. */
  async clones(): Promise<string[]> {
    try {
      return (await readdir(this.clonesRoot)).sort();
    } catch {
      return [];
    }
  }

  async readCloned(name: string, path: string, limitBytes: number): Promise<Buffer | null> {
    try {
      const body = await readFile(join(this.clonesRoot, safeName(name), path));
      return body.byteLength > limitBytes ? body.subarray(0, limitBytes) : body;
    } catch {
      return null;
    }
  }
}

function safeName(value: string): string {
  const name = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  if (!name || name === "." || name === "..") throw new RemoteInstanceError("schema_invalid", "a scratch reservation needs a bounded name");
  return name;
}
