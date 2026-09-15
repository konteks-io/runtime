import { randomBytes } from "node:crypto";
import { keyedFingerprint, readOrCreateSecretFile, runCommand } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { resolveToolingCommand } from "../bridge/spec.js";
import { readCodexAccount } from "./codex-account.js";

/**
 * The opaque `authIdentityFingerprint` (D111): a keyed hash of the identity
 * signal the bridge's OFFICIAL tooling exposes (a status/whoami result). The
 * runner never parses a credential file. The HMAC key is generated once into
 * the credential volume so the fingerprint is stable across restarts but
 * meaningless outside this runner. Where no official signal is proven, every
 * login is an identity change (conservative fallback).
 */
export const FINGERPRINT_KEY_FILE = "fingerprint.key";

export type IdentityProbe =
  | { kind: "signal"; fingerprint: string }
  | { kind: "logged_out" }
  | { kind: "no_official_signal" };

export interface IdentityProbeDeps {
  run?: typeof runCommand;
  readAccount?: typeof readCodexAccount;
}

export async function probeIdentity(
  config: RunnerConfig,
  family: AgentBridgeFamily,
  env: NodeJS.ProcessEnv,
  deps: IdentityProbeDeps = {},
): Promise<IdentityProbe> {
  if (!family.tooling.identitySignal) return { kind: "no_official_signal" };
  const key = await readOrCreateSecretFile({ bytes: 32, dataDir: config.RUNNER_CREDENTIAL_DIR, encoding: "base64url", fileName: FINGERPRINT_KEY_FILE });
  if (family.agentId === "codex") {
    const account = await (deps.readAccount ?? readCodexAccount)(config, family, env);
    return account === null ? { kind: "logged_out" } : { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), `${family.agentId}\n${account}`) };
  }
  const { command, args } = resolveToolingCommand(config, family, family.tooling.identitySignal);
  const run = deps.run ?? runCommand;
  const result = await run({ command, args, env, cwd: config.RUNNER_CREDENTIAL_DIR, timeoutMs: 20_000, outputCapBytes: 64 * 1024 });
  if (result.code !== 0) return { kind: "logged_out" };
  // Claude Code's status exits 0 when signed out; only `loggedIn: true` is an identity.
  if (family.agentId === "claude-code" && !claudeLoggedIn(result.stdout)) return { kind: "logged_out" };
  const signal = normalizeSignal(result.stdout);
  if (signal.length === 0) return { kind: "logged_out" };
  return { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), `${family.agentId}\n${signal}`) };
}

/**
 * Official status output may include volatile fields (timestamps, token
 * expiry). We hash a stable projection: JSON key/value pairs that do not look
 * like times or secrets, or the trimmed text when the output is not JSON.
 */
export function normalizeSignal(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([key, value]) => !VOLATILE_KEY.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${String(value)}`);
      return entries.join("\n");
    }
  } catch {
    // not JSON
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !VOLATILE_LINE.test(line))
    .join("\n");
}

function claudeLoggedIn(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return !!parsed && typeof parsed === "object" && (parsed as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

const VOLATILE_KEY =/(expire|expiry|token|secret|refresh|time|timestamp|updated|last|ttl|nonce)/i;
const VOLATILE_LINE = /(expire|expiry|token|secret|refresh|\d{4}-\d{2}-\d{2}T)/i;

/** Conservative fallback: an unlinkable per-login identity so every login resets scope. */
export function fallbackLoginIdentity(): string {
  return randomBytes(16).toString("base64url");
}
