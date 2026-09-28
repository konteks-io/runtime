import type { Logger, OpenCodeLoginOptionId } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { RunnerEventBus } from "../events.js";
import type { IdentityProbe } from "../auth/identity.js";
import type { LoginFlow } from "../auth/login-flow.js";

/**
 * An agent used from the person's own installation (DeepSeek Harness,
 * OpenCode): nothing of it is bundled or signed, so everything the runner
 * would otherwise take from the signed offline package is this adapter's job.
 * One adapter per host-installed agent id (`HOST_AGENT_BRIDGES` in
 * `@konteks/remote-release`); the generic runner code never names an agent.
 * The install side (locate, re-verify on load, self-check) lives in the
 * supervisor's `native/host-agents.ts`.
 */
export interface HostAgentRunnerAdapter {
  readonly agentId: string;
  /** Whether a runner config carries settings only this agent's runner may use. */
  carriesSettings(config: RunnerConfig): boolean;
  /**
   * Refuses unless `config` is a complete, safe runner of this agent on
   * `family`; its settings never reach another family.
   */
  assertRunner(config: RunnerConfig, family: AgentBridgeFamily): void;
  /** What to spawn for the ACP bridge (command and arguments). */
  launch(config: RunnerConfig, family: AgentBridgeFamily): { command: string; args: string[] };
  /**
   * The environment every process of this agent runs with, including its
   * private home. `generic` is the runner's default (inherited PATH and
   * locale with credentials removed by name, private HOME/XDG); an adapter may
   * extend it or build its own from an allow-list.
   */
  environment(config: RunnerConfig, family: AgentBridgeFamily, generic: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Before any process of this agent starts: write the Konteks overlay or config it boots from. */
  prepareToSpawn(config: RunnerConfig): Promise<void>;
  /**
   * For an agent whose execution process serves exactly one working copy
   * (OpenCode: the working copy's instructions ride on a per-process config
   * folder, and MCP servers are process-wide): prepare that process before it
   * spawns. Its process is never parked for reuse by another session. Absent
   * for agents whose processes serve any working copy.
   */
  bindWorkingCopy?(config: RunnerConfig, family: AgentBridgeFamily, workingCopy: string): Promise<HostWorkingCopyBinding>;
  /** A runtime-owned sign-in, used instead of the family's official login tooling when present. */
  startLogin?(options: HostAgentLoginOptions): LoginFlow;
  /** A runtime-owned sign-out, used instead of the family's official logout tooling when present. */
  logout?(config: RunnerConfig, request?: HostLoginRequest): Promise<void>;
  /** Plain line shown when this agent's sign-in did not complete. */
  readonly loginFailedMessage?: string;
  /** The identity signal (D111) when it is not an official tooling command; may carry the credentials it read. */
  identity?(config: RunnerConfig, settings: HostAgentSettings): Promise<IdentityProbe>;
  /** The reviewed sign-ins the site may start for this agent, as its installation offers them (OpenCode). */
  siteLoginOptions?(config: RunnerConfig): Promise<readonly OpenCodeLoginOptionId[]>;
  /** Whether a model value may be offered under `settings` (OpenCode: Zen's free models only when switched on, O6). */
  offersModel?(value: string, settings: HostAgentSettings): boolean;
  /** The verified installed version to report with readiness, when known. */
  hostVersion(config: RunnerConfig): string | undefined;
  /** Whether a turn reports billing token usage (false when the agent sends none). */
  readonly tokenUsageObservable: boolean;
  /**
   * Session modes Konteks never lets this agent enter, with the plain line a
   * refusal carries: refused on `set_mode` and `set_config_option`, refused in
   * an admitted session configuration, and dropped from what is reported.
   */
  readonly refusedSessionModes?: { readonly modeIds: readonly string[]; readonly message: string };
}

/** One execution process's hold on its working copy (`bindWorkingCopy`). */
export interface HostWorkingCopyBinding {
  /** The complete environment of the process serving this working copy. */
  readonly env: NodeJS.ProcessEnv;
  /** Before each prompt: re-check (and, where it is a copy, refresh) what the process reads from the working copy. */
  beforePrompt(): Promise<void>;
  /** Once the process is gone: undo what `bindWorkingCopy` prepared, when no other process of the same working copy needs it. Idempotent. */
  release(): Promise<void>;
}

export interface HostAgentLoginOptions {
  config: RunnerConfig;
  events: RunnerEventBus;
  logger: Pick<Logger, "info" | "warn">;
  loginId?: string;
  request?: HostLoginRequest;
}

/** Which sign-in the person (or the site) asked for; only agents with several sign-ins read it. */
export interface HostLoginRequest {
  /** The provider to sign in to (OpenCode's integration id). */
  provider?: string;
  /** The provider's sign-in method (OpenCode's method id, or `key`). */
  method?: string;
  /** The reviewed sign-in the site started (OpenCode). */
  loginOption?: OpenCodeLoginOptionId;
  /** Offer to repeat the sign-ins of the person's own installation (OpenCode O10). */
  reuse?: boolean;
}

/**
 * What Core's desired configuration and the Core contract say about host
 * agents on this computer. Applied by the supervisor; absent fields are off.
 */
export interface HostAgentSettings {
  /** The person switched on OpenCode Zen's free models for this computer (O6). */
  openCodeFreeModels: boolean;
  /**
   * Core takes pay-per-use turns and route billing on offered options (a 7.1.0
   * Core: it sends the free-models field to a connector that advertises it).
   * Until then a pay-per-use turn is not reported at all, never mislabelled.
   */
  coreAcceptsRouteBilling: boolean;
}

export const DEFAULT_HOST_AGENT_SETTINGS: HostAgentSettings = Object.freeze({ openCodeFreeModels: false, coreAcceptsRouteBilling: false });
