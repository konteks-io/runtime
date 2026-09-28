import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentLoginGcp, AgentLoginOptionId, Logger, RemoteInstanceError } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { RunnerEventBus } from "../events.js";
import type { IdentityProbe } from "../auth/identity.js";
import type { LoginFlow } from "../auth/login-flow.js";
import type { BridgeProcess, spawnBridge } from "../bridge/process.js";
import type { MeasuredTurn } from "../sessions/usage-label.js";

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
  /** A runtime-owned sign-out, used instead of the family's official logout tooling when present; `spawn` is the runtime's own (Antigravity signs out over ACP). */
  logout?(config: RunnerConfig, request?: HostLoginRequest, spawn?: HostSpawn): Promise<void>;
  /** Plain line shown when this agent's sign-in did not complete. */
  readonly loginFailedMessage?: string;
  /** The identity signal (D111) when it is not an official tooling command; may carry the credentials it read. */
  identity?(config: RunnerConfig, settings: HostAgentSettings): Promise<IdentityProbe>;
  /** The reviewed sign-ins the site may start for this agent, as its installation offers them (OpenCode, Antigravity). */
  siteLoginOptions?(config: RunnerConfig): Promise<readonly AgentLoginOptionId[]>;
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
  /**
   * The agent's own slash commands Konteks never sends it (Antigravity's
   * `/plan` and `/logout`): a prompt that starts with one is refused before it
   * reaches the agent, with this plain line.
   */
  readonly refusedPromptCommands?: { readonly commands: readonly string[]; readonly message: string };
  /**
   * Extra `_meta` every `session/new`, `session/load` and `session/resume` of
   * this agent carries, model discovery's included (Antigravity: its built-in
   * tool filter, which a persisted session could otherwise override).
   */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * The configuration a new, loaded or resumed session reports, checked before
   * the session reads ready (Antigravity: a `model` select, and the `default`
   * mode). Throws a plain refusal when the agent drifted.
   */
  verifySession?(response: { configOptions?: unknown; modes?: unknown }): void;
  /**
   * Content the connector puts in front of a prompt, or null when there is
   * none (Antigravity: the working copy's `AGENTS.md`, which its server never
   * loads, A9). `delivered` is called once that prompt reached the agent.
   */
  promptPrelude?(config: RunnerConfig, session: HostPromptSession): Promise<HostPromptPrelude | null>;
  /**
   * How many processes of this agent may live at once and for how long an
   * unused one is kept (Antigravity: about 350 MB per process pair, A12).
   * Absent: the runtime's own limits.
   */
  readonly processLimits?: HostProcessLimits;
  /**
   * A line the agent printed on stderr that means it cannot go on without the
   * person (Antigravity: a sign-in or licence page it would open on this
   * computer); the refusal ends that process's current bootstrap or turn.
   */
  stderrFailure?(line: string, config: RunnerConfig): RemoteInstanceError | null;
  /**
   * A message the agent sent as its own reply that is really a failure
   * (Antigravity reports quota and model errors as text and ends the turn): the
   * plain classification, and the text is never forwarded. Null: a reply.
   */
  agentErrorText?(text: string): HostTurnError | null;
  /**
   * The least time one session bootstrap call (`session/new`, load, resume,
   * a configuration) may take before its process is recycled, when longer
   * than the runner's own (Antigravity on Gemini Enterprise checks the
   * organisation's settings with Google first: 3 to 7 s live).
   */
  readonly sessionBootstrapTimeoutMs?: number;
  /** After every process of this runner was stopped: stop anything it left behind (Antigravity: its harness child). */
  sweepLeftovers?(config: RunnerConfig): Promise<void>;
  /**
   * How every process of this agent is spawned, given the runtime's own spawn
   * (control, execution and discovery alike): an agent may start something
   * beside each process and finish signing it in after `initialize`
   * (Antigravity with a Gemini API key: its own loopback relay, A7).
   */
  wrapSpawn?(config: RunnerConfig, spawn: HostSpawn): HostSpawn;
  /**
   * The tokens and money of a turn measured outside the agent, when the agent
   * reports none itself (Antigravity with a Gemini API key: its relay).
   * Called as the turn starts; the returned function reads the turn once it
   * ended. Null: nothing is measured for this process.
   */
  measureTurn?(bridge: BridgeProcess): (() => MeasuredTurn | null) | null;
}

/** The runtime's process spawn (`spawnBridge`, or a test's). */
export type HostSpawn = typeof spawnBridge;

/** Which session a prompt prelude is for. */
export interface HostPromptSession {
  /** The session's working copy (absolute). */
  cwd: string;
  /** The agent's own session id, stable across load and resume; never leaves the runner. */
  sessionKey: string;
}

export interface HostPromptPrelude {
  blocks: ContentBlock[];
  /** The prompt carrying `blocks` was answered: remember what was delivered. */
  delivered(): Promise<void>;
}

export interface HostProcessLimits {
  /** Execution processes (one per session) alive at once. */
  executionProcesses: number;
  /** How long a session waits for a free execution process before it is refused. */
  queueMs: number;
  /** How long a finished session's process stays resident for the next one. */
  idleExecutionMs: number;
  /** How long the control process stays up with nothing to do; it starts again when needed. */
  controlIdleMs: number;
}

/** A failure the agent reported as reply text, classified for the person. */
export interface HostTurnError {
  class: "provider_failure" | "agent_auth_required";
  message: string;
  retryable: boolean;
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
  /** The runtime's own process spawn, for a sign-in driven over ACP (Antigravity's Gemini Enterprise). */
  spawn?: HostSpawn;
}

/** Which sign-in the person (or the site) asked for; only agents with several sign-ins read it. */
export interface HostLoginRequest {
  /** The provider to sign in to (OpenCode's integration id). */
  provider?: string;
  /** The provider's sign-in method (OpenCode's method id, or `key`). */
  method?: string;
  /** The reviewed sign-in the site started (OpenCode, Antigravity). */
  loginOption?: AgentLoginOptionId;
  /** Gemini Enterprise: the licence's Google Cloud project and location (Antigravity). */
  gcp?: AgentLoginGcp;
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
