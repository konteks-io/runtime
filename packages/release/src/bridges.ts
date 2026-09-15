/**
 * The supported agent-bridge matrix as this release pins it. Digests and
 * image refs come from the signed manifest at install time; this table is the
 * static knowledge the runner needs about each bridge family: how to spawn it,
 * which official tooling owns login/logout, whether an official identity
 * signal exists (D111), and whether a documented file-backed host cache may be
 * copied once with consent.
 *
 * Versions are the CP0-pinned bridge releases. A bridge is never resolved from
 * a package registry at runtime: the runner image vendors the exact version.
 */
export interface AgentBridgeFamily {
  agentId: "claude-code" | "codex" | "opencode" | "pi";
  displayName: string;
  package: string;
  version: string;
  /** Spawned over stdio from the vendored install prefix inside the runner image. */
  command: readonly string[];
  tooling: {
    login: readonly string[];
    logout: readonly string[];
    /** Official identity signal; when absent every login counts as an identity change. */
    identitySignal?: readonly string[];
    /** Documented file-backed cache eligible for a one-time consented copy. */
    hostCacheImport?: { relativePath: string; documentedBy: string };
  };
  egress: {
    baseUrlEnv?: string;
    providers: ReadonlyArray<"anthropic" | "openai" | "google" | "deepseek">;
  };
  acpProtocol: { min: number; max: number };
}

export const SUPPORTED_AGENT_BRIDGES: readonly AgentBridgeFamily[] = Object.freeze([
  {
    agentId: "claude-code",
    displayName: "Claude Code",
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.75.1",
    command: ["claude-agent-acp"],
    tooling: {
      login: ["claude", "auth", "login"],
      logout: ["claude", "auth", "logout"],
      identitySignal: ["claude", "auth", "status", "--json"],
      // Claude Code documents no safe file-backed import (keychain on macOS); fresh login only.
    },
    egress: { baseUrlEnv: "ANTHROPIC_BASE_URL", providers: ["anthropic"] },
    acpProtocol: { min: 1, max: 1 },
  },
  {
    agentId: "codex",
    displayName: "Codex",
    package: "@agentclientprotocol/codex-acp",
    version: "1.10.0",
    command: ["codex-acp"],
    tooling: {
      login: ["codex", "login", "--device-auth"],
      logout: ["codex", "logout"],
      identitySignal: ["codex", "login", "status"],
      hostCacheImport: {
        relativePath: ".codex/auth.json",
        documentedBy: "https://github.com/openai/codex/blob/main/docs/authentication.md",
      },
    },
    egress: { baseUrlEnv: "OPENAI_BASE_URL", providers: ["openai"] },
    acpProtocol: { min: 1, max: 1 },
  },
  {
    agentId: "opencode",
    displayName: "OpenCode",
    package: "opencode-ai",
    version: "1.2.0",
    command: ["opencode", "acp"],
    tooling: {
      login: ["opencode", "auth", "login"],
      logout: ["opencode", "auth", "logout"],
      identitySignal: ["opencode", "auth", "list"],
    },
    egress: { providers: ["anthropic", "openai", "google", "deepseek"] },
    acpProtocol: { min: 1, max: 1 },
  },
  {
    agentId: "pi",
    displayName: "Pi",
    package: "pi-acp",
    version: "0.0.33",
    command: ["pi-acp"],
    tooling: {
      login: ["pi", "login"],
      logout: ["pi", "logout"],
      // CONTRACT-GAP: CP0 has not yet proven an official identity signal for pi;
      // every login is treated as an identity change (conservative fallback, D111).
    },
    egress: { providers: ["anthropic", "openai", "google", "deepseek"] },
    acpProtocol: { min: 1, max: 1 },
  },
]);

export function findAgentBridge(agentId: string): AgentBridgeFamily | undefined {
  return SUPPORTED_AGENT_BRIDGES.find((bridge) => bridge.agentId === agentId);
}
