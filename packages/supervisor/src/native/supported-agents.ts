import { RemoteInstanceError, SupportedAgentEntrySchema, SupportedAgentListSchema, type ConnectedAgentView, type SupportedAgentEntry, type SupportedAgentState } from "@konteks/remote-common";
import { hostAgentFamily, type HostAgentFamily } from "@konteks/remote-release";
import { antigravityPin } from "./antigravity-installation.js";
import { claudeCodeInstaller, resolveNativeClaudeExecutable } from "./claude-executable.js";
import { resolveNativeCodexHome } from "./codex-home.js";
import { resolveNativeDshInstallation } from "./dsh-installation.js";
import { resolveNativeOpenCodeInstallation } from "./opencode-installation.js";

/**
 * Every agent Konteks supports on a connector, in the order the site lists
 * them (runtime-view R21): the connector reports all five on each heartbeat,
 * whether or not it runs them.
 */
export const SUPPORTED_AGENT_IDS = ["claude-code", "codex", "dsh", "opencode", "antigravity"] as const;
type SupportedAgentId = (typeof SUPPORTED_AGENT_IDS)[number];

/**
 * How a person installs the agents the connector runs from their own
 * installation but does not describe in `bridges.ts` (Claude Code's and
 * Codex's ACP bridges ship with the connector; the CLI and profile are the
 * person's own). The official installers, one line each.
 */
const BUNDLED_AGENT_INSTALL: Record<"claude-code" | "codex", { installCommand: string; windowsInstallCommand?: string }> = {
  "claude-code": { installCommand: claudeCodeInstaller("linux").command, windowsInstallCommand: claudeCodeInstaller("win32").command },
  codex: { installCommand: "npm install -g @openai/codex" },
};

/** What a refusal can mean to a person. */
type FailureState = Extract<SupportedAgentState, "not_installed" | "unsupported_version" | "not_added" | "not_supported_on_this_os" | "failed">;

/** Where an agent the installation does not list stands on this computer: only file checks, never an agent run with the person's environment. */
export interface NotAddedAgentDetection {
  state: FailureState | "installed_not_added";
  versionFound?: string;
}

/** What one listed (added) agent is doing right now. */
export interface AddedAgentFacts {
  /** The runner's current view, when it runs. */
  view?: ConnectedAgentView;
  /** A running agent found its sign-in no longer works (a turn's auth failure, or a credential it holds needs signing in again). */
  signInLost?: boolean;
  /** Why it is left out (parked for a retry, or given up), when it does not run. */
  failure?: unknown;
  /** The installed version the connector verified (host agents). */
  version?: string;
}

interface SupportedAgentsInputs {
  /** The agents the installation lists (runners and those left out at load). */
  added: ReadonlyMap<string, AddedAgentFacts>;
  /** The cached detection for every agent the installation does not list. */
  notAdded: ReadonlyMap<string, NotAddedAgentDetection>;
}

/** The installed version a locator's "unsupported version" refusal names ("OpenCode 1.18.33 is not…", "found 1.18.33"). */
export function versionFromRefusal(error: unknown): string | undefined {
  if (!(error instanceof RemoteInstanceError)) return undefined;
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(error.message);
  const version = match?.[1]?.replace(/[.-]+$/, "");
  return version && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) && version.length <= 64 ? version : undefined;
}

/** The state a refusal (a locator's, or a runner's failed start) means to a person. */
export function stateForFailure(agentId: string, error: unknown): FailureState {
  const diagnostic = error instanceof RemoteInstanceError ? error.diagnostic : undefined;
  if (diagnostic === "antigravity_unsupported_platform") return "not_supported_on_this_os";
  if (diagnostic === "antigravity_not_fetched") return "not_added";
  if (diagnostic?.endsWith("_not_found")) return "not_installed";
  if (diagnostic?.endsWith("_unsupported_version")) return "unsupported_version";
  // Claude Code's and Codex's own tooling missing: their locators name no diagnostic.
  if ((agentId === "claude-code" || agentId === "codex") && error instanceof RemoteInstanceError && error.code === "prerequisite_missing" && diagnostic === undefined) return "not_installed";
  return "failed";
}

function stateForView(facts: AddedAgentFacts): SupportedAgentState {
  const view = facts.view!;
  if (view.readiness === "ready" && view.connectionState === "ready") return "ready";
  if (view.readiness === "not_configured") return facts.signInLost ? "sign_in_expired" : "needs_sign_in";
  return "failed";
}

function installFacts(agentId: SupportedAgentId): Pick<SupportedAgentEntry, "supportedRange" | "installCommand" | "windowsInstallCommand"> {
  if (agentId === "claude-code" || agentId === "codex") return { ...BUNDLED_AGENT_INSTALL[agentId] };
  const family: HostAgentFamily = hostAgentFamily(agentId);
  const { min, belowCore } = family.hostInstall.versions;
  const supportedRange = `>=${min} <${belowCore}`;
  if (family.hostInstall.launch === "fetched") return { supportedRange, installCommand: `konteks-remote agent add ${agentId}` };
  return {
    supportedRange,
    installCommand: family.hostInstall.installCommand,
    ...(family.hostInstall.windowsInstallCommand ? { windowsInstallCommand: family.hostInstall.windowsInstallCommand } : {}),
  };
}

/**
 * The five supported agents and their real state on this computer
 * (runtime-view R21), from what the connector already knows: a listed agent
 * from its runner (ready, needs or lost its sign-in, or failed) or from why it
 * is left out; an agent the installation does not list from the cached
 * detection. Every entry is checked against the heartbeat schema, and the
 * whole list always parses, so it can never cost a heartbeat.
 */
export function projectSupportedAgents(inputs: SupportedAgentsInputs): SupportedAgentEntry[] {
  const entries: SupportedAgentEntry[] = [];
  for (const agentId of SUPPORTED_AGENT_IDS) {
    const install = installFacts(agentId);
    const added = inputs.added.get(agentId);
    let state: SupportedAgentState;
    let versionFound: string | undefined;
    if (added) {
      state = added.view ? stateForView(added) : stateForFailure(agentId, added.failure);
      versionFound = added.version ?? (state === "unsupported_version" ? versionFromRefusal(added.failure) : undefined);
    } else {
      const detected = inputs.notAdded.get(agentId);
      state = detected?.state ?? (agentId === "antigravity" ? "not_added" : "not_installed");
      versionFound = detected?.versionFound;
    }
    const entry = { agentId, state, ...(versionFound ? { versionFound } : {}), ...install };
    const parsed = SupportedAgentEntrySchema.safeParse(entry);
    entries.push(parsed.success ? parsed.data : { agentId, state });
  }
  return SupportedAgentListSchema.parse(entries);
}

/** Replaceable checks, for tests only. */
interface NotAddedDetectionDeps {
  claude?: () => Promise<unknown>;
  codex?: () => Promise<unknown>;
  dsh?: () => Promise<{ version: string }>;
  opencode?: () => Promise<{ version: string }>;
  antigravityPinned?: () => boolean;
}

/**
 * Where one agent the installation does not list stands. The same locators
 * onboarding and `agent add` use (`detectAgentFamilies`): Claude Code's
 * executable and Codex's profile by file checks, DeepSeek Harness by its
 * package manifest, OpenCode by its package manifest or, at most, one
 * `--version` of a safely owned executable with the allow-list environment in
 * a throwaway home (never a credential variable), Google Antigravity by
 * whether this release pins a copy for this computer. Nothing is downloaded.
 */
export async function detectNotAddedAgent(agentId: SupportedAgentId, deps: NotAddedDetectionDeps = {}): Promise<NotAddedAgentDetection> {
  const outcome = async (locate: () => Promise<unknown>, found: (value: unknown) => string | undefined): Promise<NotAddedAgentDetection> => {
    try {
      const value = await locate();
      const version = found(value);
      return { state: "installed_not_added", ...(version ? { versionFound: version } : {}) };
    } catch (error) {
      // Installed but unsafe or unusable here (other users can change it, no Node for it) reads `failed`: adding it would refuse.
      const state = stateForFailure(agentId, error);
      const version = state === "unsupported_version" ? versionFromRefusal(error) : undefined;
      return { state, ...(version ? { versionFound: version } : {}) };
    }
  };
  switch (agentId) {
    case "claude-code":
      return outcome(deps.claude ?? (() => resolveNativeClaudeExecutable()), () => undefined);
    case "codex":
      return outcome(deps.codex ?? (() => resolveNativeCodexHome()), () => undefined);
    case "dsh":
      return outcome(deps.dsh ?? (() => resolveNativeDshInstallation()), value => (value as { version?: string }).version);
    case "opencode":
      return outcome(deps.opencode ?? (() => resolveNativeOpenCodeInstallation()), value => (value as { version?: string }).version);
    case "antigravity": {
      const pinned = deps.antigravityPinned ?? (() => { try { antigravityPin(); return true; } catch { return false; } });
      return { state: pinned() ? "not_added" : "not_supported_on_this_os" };
    }
  }
}

/**
 * Every minute. It is a look at a few folders and at most a `--version`, and
 * a person who installs an agent expects to see it within about a minute; the
 * doubling to fifteen minutes it had took seven after a while (W1-D4).
 */
const REDETECT_MS = 60_000;

/**
 * The cached detection of agents the installation does not list, re-run in
 * the background every minute, never on the heartbeat's path: `current()` is
 * synchronous and a heartbeat only ever asks for a refresh.
 */
export class NotAddedAgentsDetector {
  private detected = new Map<string, NotAddedAgentDetection>();
  private nextAt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly options: {
    /** The agents the installation does not list. */
    agentIds: readonly SupportedAgentId[];
    now?: () => number;
    deps?: NotAddedDetectionDeps;
  }) {}

  current(): ReadonlyMap<string, NotAddedAgentDetection> {
    return this.detected;
  }

  /** Whether a detection has ended at least once (before that, `current()` knows nothing). */
  detectedOnce(): boolean {
    return this.nextAt > 0;
  }

  /** Re-detects in the background when due; resolves when that run (if any) ended. */
  refreshIfDue(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (this.running || now < this.nextAt) return this.running ?? Promise.resolve();
    this.running = (async () => {
      const next = new Map<string, NotAddedAgentDetection>();
      for (const agentId of this.options.agentIds) next.set(agentId, await detectNotAddedAgent(agentId, this.options.deps).catch(() => ({ state: "failed" as const })));
      this.detected = next;
      this.nextAt = (this.options.now ?? Date.now)() + REDETECT_MS;
    })().finally(() => { this.running = null; });
    return this.running;
  }
}
