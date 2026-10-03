import { randomBytes } from "node:crypto";
import { keyedFingerprint, readOrCreateSecretFile, runCommand, type ConnectedAgentCredential } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { resolveToolingCommand } from "../bridge/spec.js";
import { readCodexAccount } from "./codex-account.js";
import { hostAgentRunnerAdapter } from "../host/registry.js";
import { DEFAULT_HOST_AGENT_SETTINGS, type HostAgentSettings } from "../host/host-agent.js";

/**
 * The opaque `authIdentityFingerprint`: a keyed hash of the identity
 * signal the bridge's OFFICIAL tooling exposes (a status/whoami result). The
 * runner never parses a credential file. The HMAC key is generated once into
 * the credential volume so the fingerprint is stable across restarts but
 * meaningless outside this runner. Where no official signal is proven, every
 * login is an identity change (conservative fallback).
 */
const FINGERPRINT_KEY_FILE = "fingerprint.key";

export type IdentityProbe =
  // `credentials`: what an agent with several sign-ins reported (OpenCode's `auth list`), no secret.
  // `tokenUsageObservable`: whether turns under this identity report billing usage (Antigravity: only through its key relay).
  // `providerAdminBlocked`: signed in, but a setting only the provider's admin can change keeps Konteks tools out (Antigravity: MCP Servers off).
  | { kind: "signal"; fingerprint: string; credentials?: ConnectedAgentCredential[]; tokenUsageObservable?: boolean; providerAdminBlocked?: boolean }
  | { kind: "logged_out"; credentials?: ConnectedAgentCredential[] }
  | { kind: "no_official_signal" };

interface IdentityProbeDeps {
  run?: typeof runCommand;
  readAccount?: typeof readCodexAccount;
}

export async function probeIdentity(
  config: RunnerConfig,
  family: AgentBridgeFamily,
  env: NodeJS.ProcessEnv,
  deps: IdentityProbeDeps = {},
  settings: HostAgentSettings = DEFAULT_HOST_AGENT_SETTINGS,
): Promise<IdentityProbe> {
  // A host-installed agent answers itself: DeepSeek Harness with a keyed hash
  // of the API key the runtime stored, OpenCode from its own `auth list`.
  const host = hostAgentRunnerAdapter(family.agentId);
  if (host?.identity) return host.identity(config, settings);
  if (!family.tooling.identitySignal) return { kind: "no_official_signal" };
  const key = await readOrCreateSecretFile({ bytes: 32, dataDir: config.RUNNER_CREDENTIAL_DIR, encoding: "base64url", fileName: FINGERPRINT_KEY_FILE });
  const signal = await identitySignal(config, family, family.tooling.identitySignal, env, deps);
  return signal === null ? { kind: "logged_out" } : { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), `${family.agentId}\n${signal}`) };
}

/** Codex's signed-in account email, else the official status signal. */
function identitySignal(config: RunnerConfig, family: AgentBridgeFamily, signal: readonly string[], env: NodeJS.ProcessEnv, deps: IdentityProbeDeps): Promise<string | null> {
  if (family.agentId === "codex") return (deps.readAccount ?? readCodexAccount)(config, family, env);
  return officialStatusSignal(config, family, signal, env, deps.run ?? runCommand);
}

/** The stable projection of the official status command's output; null when it says nobody is signed in. */
async function officialStatusSignal(config: RunnerConfig, family: AgentBridgeFamily, identitySignal: readonly string[], env: NodeJS.ProcessEnv, run: typeof runCommand): Promise<string | null> {
  const { command, args } = resolveToolingCommand(config, family, identitySignal);
  const result = await run({ command, args, env, cwd: config.RUNNER_CREDENTIAL_DIR, timeoutMs: 20_000, outputCapBytes: 64 * 1024 });
  if (result.code !== 0) return null;
  // Claude Code's status exits 0 when signed out; only `loggedIn: true` is an identity.
  if (family.agentId === "claude-code" && !claudeLoggedIn(result.stdout)) return null;
  const signal = normalizeSignal(result.stdout);
  return signal.length === 0 ? null : signal;
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
