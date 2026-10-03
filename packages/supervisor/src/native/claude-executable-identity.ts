import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createLogger, type Logger } from "@konteks/remote-common";

/**
 * The Claude Code executable a personal profile runs is the operator's own
 * (`resolveNativeClaudeExecutable`), whatever version they installed: the
 * release's pinned package is not runnable. Its version and sha256 ride the
 * `agent_runner` component's capabilities as one string, so anything bound to
 * one executable (a compatibility certificate) is invalidated when the person
 * updates or replaces it.
 */
const CLAUDE_EXECUTABLE_CAPABILITY_PREFIX = "claude-code-executable:";

const VERSION = /^([0-9][0-9A-Za-z.+-]{0,31}) \(Claude Code\)\s*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The version `claude --version` prints (`2.1.259 (Claude Code)`), or null. */
export function parseClaudeVersion(output: string): string | null {
  return VERSION.exec(output.trim())?.[1] ?? null;
}

/** `claude-code-executable:<version>:sha256:<hex>`: at most 127 characters (the wire allows 128). */
export function claudeExecutableCapability(version: string, sha256: string): string | null {
  if (!VERSION.test(`${version} (Claude Code)`) || !SHA256.test(sha256)) return null;
  return `${CLAUDE_EXECUTABLE_CAPABILITY_PREFIX}${version}:sha256:${sha256}`;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

/** Runs `<executable> --version` with a minimal environment: no Konteks state, bounded output and time. */
function readVersion(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 15_000, maxBuffer: 4096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() } },
      (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

interface ClaudeExecutableIdentityDeps {
  version?: (path: string) => Promise<string>;
  logger?: Logger;
}

/**
 * Hashes and asks the executable only when its file changed (device, inode,
 * size, modification and change times), so a heartbeat costs one `stat`.
 */
export class ClaudeExecutableIdentity {
  private cached: { fingerprint: string; capability: string | null } | null = null;
  private inFlight: Promise<string | null> | null = null;
  private readonly logger: Logger;

  constructor(private readonly path: string, private readonly deps: ClaudeExecutableIdentityDeps = {}) {
    this.logger = deps.logger ?? createLogger({ name: "claude-executable-identity" });
  }

  capability(): Promise<string | null> {
    this.inFlight ??= this.read().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async read(): Promise<string | null> {
    let fingerprint: string;
    try {
      const info = await stat(this.path);
      if (!info.isFile()) return this.remember("missing", null);
      fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch { return this.remember("missing", null); }
    if (this.cached?.fingerprint === fingerprint) return this.cached.capability;
    let capability: string | null = null;
    try {
      const [sha256, output] = await Promise.all([sha256File(this.path), (this.deps.version ?? readVersion)(this.path)]);
      const version = parseClaudeVersion(output);
      capability = version === null ? null : claudeExecutableCapability(version, sha256);
    } catch { capability = null; }
    return this.remember(fingerprint, capability);
  }

  private remember(fingerprint: string, capability: string | null): string | null {
    const previous = this.cached;
    this.cached = { fingerprint, capability };
    if (previous !== null && previous.capability !== capability) {
      // A changed executable: whatever was certified against the previous one no longer applies.
      this.logger.warn({ event: "agent.claude_executable_changed", agentId: "claude-code", previous: previous.capability, current: capability },
        "the personal Claude Code executable changed");
    }
    return capability;
  }
}
