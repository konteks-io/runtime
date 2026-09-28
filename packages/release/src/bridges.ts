/**
 * The supported agent-bridge matrix as this release pins it. Artifact digests
 * come from the signed native manifest at install time; this table is the
 * static knowledge the runner needs about each bridge family: how to spawn it,
 * which official tooling owns login/logout, whether an official identity
 * signal exists (D111), and whether a documented file-backed host cache may be
 * copied once with consent.
 *
 * Versions are the CP0-pinned bridge releases. A bridge is never resolved from
 * a package registry at runtime: the signed offline agent package carries the
 * exact version.
 */
export interface AgentBridgeFamily {
  agentId: "claude-code" | "codex" | "dsh";
  displayName: string;
  package: string;
  version: string;
  /** Spawned over stdio from the installed offline agent package. */
  command: readonly string[];
  tooling: {
    login: readonly string[];
    logout: readonly string[];
    /** Official identity signal; when absent every login counts as an identity change. */
    identitySignal?: readonly string[];
    /** Documented file-backed cache eligible for a one-time consented copy. */
    hostCacheImport?: { relativePath: string; documentedBy: string };
  };
  acpProtocol: { min: number; max: number };
  /**
   * Present only for an agent that speaks ACP itself and is used from the
   * person's own installation: nothing of it is bundled or signed, so `version`
   * is the lowest tested version and `command` is the arguments after the
   * package's own `bin` entry, which the runtime's bundled Node runs.
   */
  hostInstall?: {
    /** The package's `bin` name whose entry is launched (never a shell shim). */
    bin: string;
    /** Accepted versions: at least `min`, with a release core below `belowCore`. */
    versions: { min: string; belowCore: string };
    /** The one command a person runs to install a supported version. */
    installCommand: string;
  };
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
    acpProtocol: { min: 1, max: 1 },
  },
]);

/**
 * Agents used from the person's own installation (plan dsh-runtime-support D9).
 * Kept apart from SUPPORTED_AGENT_BRIDGES, which feeds the signed manifest and
 * the release build: a host-installed agent has no artifact to sign or build.
 */
export const HOST_AGENT_BRIDGES: readonly AgentBridgeFamily[] = Object.freeze([
  {
    agentId: "dsh",
    displayName: "DeepSeek Harness",
    package: "@deepseek-ai/dsh",
    version: "0.1.7-rc.2",
    command: ["--profile", "acp"],
    // No login command exists: the runtime owns the API-key entry (plan D1/D2).
    tooling: { login: [], logout: [] },
    acpProtocol: { min: 1, max: 1 },
    hostInstall: {
      bin: "dsh",
      // 0.1.5-rc.3 is npm `latest`, what `npx @deepseek-ai/dsh` installs; 0.1.7-rc.2 is `next`.
      versions: { min: "0.1.5-rc.3", belowCore: "0.1.8" },
      installCommand: "npm install -g @deepseek-ai/dsh@0.1.7-rc.2",
    },
  },
]);

export function findAgentBridge(agentId: string): AgentBridgeFamily | undefined {
  return SUPPORTED_AGENT_BRIDGES.find((bridge) => bridge.agentId === agentId)
    ?? HOST_AGENT_BRIDGES.find((bridge) => bridge.agentId === agentId);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string): { core: [number, number, number]; pre: string[] } {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`not a semantic version: ${JSON.stringify(version)}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

/** Semantic-version precedence (build metadata ignored); throws on anything else. */
export function compareAgentVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index]! - b.core[index]!;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index], y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether an agent family is used from the person's own installation (nothing of it in the release). */
export function isHostAgentId(agentId: string): boolean {
  return findAgentBridge(agentId)?.hostInstall !== undefined;
}

/**
 * Whether a host-installed agent's version is inside its tested range. The
 * ceiling compares release cores, so an untested prerelease of the next
 * release (0.1.8-alpha.1 under a 0.1.8 ceiling) is refused too.
 */
export function hostAgentVersionSupported(family: AgentBridgeFamily, version: string): boolean {
  if (!family.hostInstall) return false;
  try {
    const core = version.split(/[-+]/, 1)[0]!;
    return compareAgentVersions(version, family.hostInstall.versions.min) >= 0
      && compareAgentVersions(core, family.hostInstall.versions.belowCore) < 0;
  } catch {
    return false;
  }
}
