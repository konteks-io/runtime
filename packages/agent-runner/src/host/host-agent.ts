import type { Logger } from "@konteks/remote-common";
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
  /** A runtime-owned sign-in, used instead of the family's official login tooling when present. */
  startLogin?(options: HostAgentLoginOptions): LoginFlow;
  /** A runtime-owned sign-out, used instead of the family's official logout tooling when present. */
  logout?(config: RunnerConfig): Promise<void>;
  /** Plain line shown when this agent's sign-in did not complete. */
  readonly loginFailedMessage?: string;
  /** The identity signal (D111) when it is not an official tooling command. */
  identity?(config: RunnerConfig): Promise<IdentityProbe>;
  /** The verified installed version to report with readiness, when known. */
  hostVersion(config: RunnerConfig): string | undefined;
  /** Whether a turn reports billing token usage (false when the agent sends none). */
  readonly tokenUsageObservable: boolean;
}

export interface HostAgentLoginOptions {
  config: RunnerConfig;
  events: RunnerEventBus;
  logger: Pick<Logger, "info">;
  loginId?: string;
}
