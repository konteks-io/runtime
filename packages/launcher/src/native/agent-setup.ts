import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { findGitForWindows, GIT_FOR_WINDOWS_DOWNLOAD, GIT_FOR_WINDOWS_WINGET, RemoteInstanceError, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";
import { claudeCodeInstaller, resolveNativeClaudeExecutable, resolveNativeCodexHome } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { confirm } from "../prompt.js";
import { SupervisorControl } from "../control.js";
import { agentName } from "./agent-name.js";
import { readNativeRecord } from "./install.js";

/**
 * Claude Code and Codex run from the person's own installation and sign-in
 * (`claudeExecutable`, `codexHome`), with their ACP bridges and Codex's own
 * CLI shipped in the connector's signed packages. A computer without them is
 * still connected (D116); this offers each one, once, on the person's yes:
 * Claude Code through Anthropic's official installer (nothing else is ever
 * downloaded or run for it), Codex by creating its profile folder for the
 * copy Konteks ships (nothing is downloaded). Without a terminal nothing is
 * asked and nothing is installed; the closing summary names the command.
 */
export const PERSONAL_AGENTS = ["claude-code", "codex"] as const;
type PersonalAgentId = (typeof PERSONAL_AGENTS)[number];

export function isPersonalAgent(agentId: string): agentId is PersonalAgentId {
  return (PERSONAL_AGENTS as readonly string[]).includes(agentId);
}

export interface AgentSetupDeps {
  /** A person is at a terminal to answer (and not a `--json` run). */
  interactive: () => boolean;
  /** One question; true on an explicit yes. */
  ask: (question: string) => Promise<boolean>;
  /** A command run in the person's own terminal; its exit code. */
  run: (command: string, args: readonly string[]) => Promise<number | null>;
  platform: NodeJS.Platform;
  /** Whether the agent's own installation is found the way the connector finds it. */
  found: (agentId: PersonalAgentId) => Promise<boolean>;
  /** Codex's profile folder to create (CODEX_HOME, else ~/.codex); undefined when it cannot be one. */
  codexHome: () => string | undefined;
  /** Windows: Git for Windows and its Git Bash, which Claude Code needs, are here. */
  gitForWindows: () => boolean;
}

/** The one line for a person who needs Git for Windows and is not getting it from winget. */
const GIT_HINT = `Claude Code needs Git for Windows: ${GIT_FOR_WINDOWS_DOWNLOAD}`;

function productionAgentSetupDeps(output: Pick<Output, "json">): AgentSetupDeps {
  return {
    interactive: () => process.stdin.isTTY === true && !output.json,
    ask: question => confirm(question),
    run: (command, args) => new Promise(resolveRun => {
      const child = spawn(command, [...args], { stdio: "inherit", env: sanitizeInheritedChildProcessEnv({ env: process.env }) });
      child.once("error", () => resolveRun(null));
      child.once("exit", code => resolveRun(code));
    }),
    platform: process.platform,
    found: agentId => (agentId === "claude-code" ? resolveNativeClaudeExecutable() : resolveNativeCodexHome()).then(() => true, () => false),
    codexHome: () => {
      const path = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      return isAbsolute(path) ? path : undefined;
    },
    gitForWindows: () => findGitForWindows(process.env) !== null,
  };
}

/**
 * Claude Code on Windows needs Git for Windows (D116): asked once, installed
 * with winget's Git.Git in the person's terminal on a yes. A no, no winget, or
 * a failed install is one line with the download page; Claude Code is still
 * installed, and the install carries on.
 */
async function offerGitForWindows(output: Output, deps: AgentSetupDeps): Promise<void> {
  if (!await deps.ask("Claude Code needs Git for Windows. Install it with winget (Git.Git) first?")) {
    output.line(GIT_HINT);
    return;
  }
  output.line("Installing Git for Windows with winget…");
  const code = await deps.run("winget", GIT_FOR_WINDOWS_WINGET).catch(() => null);
  if (code === null) output.line(`winget is not available here. ${GIT_HINT}`);
  else if (code !== 0 || !deps.gitForWindows()) output.line(`Git for Windows did not install. ${GIT_HINT}`);
}

/** The official installer as a command line: Windows PowerShell on Windows, bash elsewhere. */
function installerCommand(platform: NodeJS.Platform): [string, string[]] {
  const { command } = claudeCodeInstaller(platform);
  if (platform !== "win32") return ["/bin/bash", ["-o", "pipefail", "-c", command]];
  const root = process.env.SystemRoot;
  const powershell = root && isAbsolute(root) ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
  return [powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]];
}

/**
 * Offer one missing agent and set it up on a yes. True once the connector
 * finds it; every other outcome is false with at most one plain line, and
 * never stops the install.
 */
export async function setUpPersonalAgent(agentId: PersonalAgentId, output: Output, deps: AgentSetupDeps = productionAgentSetupDeps(output)): Promise<boolean> {
  if (!deps.interactive()) return false;
  return agentId === "codex" ? setUpCodex(output, deps) : installClaudeCode(output, deps);
}

/** Codex comes with Konteks: set up is its private folder, then found. */
async function setUpCodex(output: Output, deps: AgentSetupDeps): Promise<boolean> {
  if (!await deps.ask("Codex is not set up here. It comes with Konteks, so nothing is downloaded. Set it up and sign in with your ChatGPT account?")) return false;
  const home = deps.codexHome();
  if (home) await mkdir(home, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (home && await deps.found("codex")) return true;
  output.line("Codex could not be set up here: its folder (CODEX_HOME) must be yours and private. To try again: konteks-remote agent add codex");
  return false;
}

/** Claude Code with Anthropic's official installer (and Git for Windows first, where it is missing). */
async function installClaudeCode(output: Output, deps: AgentSetupDeps): Promise<boolean> {
  const later = "konteks-remote agent add claude-code";
  const installer = claudeCodeInstaller(deps.platform);
  if (!await deps.ask(`Claude Code is not installed. Install it with Anthropic's official installer (${installer.url}) and sign in?`)) return false;
  if (deps.platform === "win32" && !deps.gitForWindows()) await offerGitForWindows(output, deps);
  output.line("Installing Claude Code with Anthropic's installer…");
  const [command, args] = installerCommand(deps.platform);
  const code = await deps.run(command, args).catch(() => null);
  if (code !== 0) {
    output.line(`Claude Code's installer did not finish. To try again: ${later}`);
    return false;
  }
  if (await deps.found("claude-code")) return true;
  output.line(`Claude Code was installed but is not found yet. Open a new terminal, then: ${later}`);
  return false;
}

/**
 * `agent add claude-code|codex`: the agent's own installation, found or set
 * up now. A no, a failed setup, or no terminal to ask in refuses before
 * anything is stopped, with the one thing to do.
 */
export async function ensurePersonalAgent(agentId: PersonalAgentId, output: Output, deps: AgentSetupDeps = productionAgentSetupDeps(output)): Promise<"found" | "set_up"> {
  if (await deps.found(agentId)) return "found";
  const name = agentName(agentId);
  if (!deps.interactive()) throw new RemoteInstanceError("prerequisite_missing", notSetUpMessage(agentId, deps));
  let yes = false;
  if (await setUpPersonalAgent(agentId, output, { ...deps, ask: async question => (yes = await deps.ask(question)) })) return "set_up";
  // A no changes nothing; a setup that failed has already said what to do.
  throw new RemoteInstanceError("agent_unavailable", yes ? `${name} was not added.` : `Nothing was ${agentId === "claude-code" ? "installed" : "changed"}: ${name} was not added.`);
}

/** Without a terminal to ask in: the one thing to do. */
function notSetUpMessage(agentId: PersonalAgentId, deps: AgentSetupDeps): string {
  if (agentId === "codex") return "Codex is not set up for this user. Run this in a terminal to set it up and sign in: konteks-remote agent add codex";
  const git = deps.platform === "win32" && !deps.gitForWindows() ? `. ${GIT_HINT}` : "";
  return `Claude Code is not installed for this user. Install it with Anthropic's installer (${claudeCodeInstaller(deps.platform).command}), then: konteks-remote agent add claude-code${git}`;
}

/** Where one agent stands right after the connector started, in the closing summary's words. */
export type AgentState = "ready" | "needs_sign_in" | "starting" | "failed";

export interface AgentClosingDeps {
  interactive: () => boolean;
  ask: (question: string) => Promise<boolean>;
  /** `konteks-remote auth login <agent>`: the agent's own sign-in in this terminal, relayed by the connector. */
  signIn: (agentId: string) => Promise<void>;
  /** Each listed agent's state, or null while the connector does not answer yet. */
  states: () => Promise<Record<string, AgentState> | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  waitMs?: number;
  /** Windows without Git for Windows, which Claude Code needs. */
  gitForWindowsMissing?: () => boolean;
}

const AgentsReportSchema = z.object({
  agents: z.array(z.object({ agentId: z.string(), readiness: z.string().optional(), connectionState: z.string().optional(), startFailure: z.string().optional() }).passthrough()),
}).passthrough();

/** Readiness as the runner derives it: ready, a sign-in missing, still coming up, or failed. */
function agentState(agent: z.infer<typeof AgentsReportSchema>["agents"][number]): AgentState {
  if (agent.startFailure) return "failed";
  if (agent.readiness === "not_configured" || agent.readiness === "reconnect_required") return "needs_sign_in";
  if (agent.connectionState === "failed") return "failed";
  if (agent.readiness === "ready" && agent.connectionState === "ready") return "ready";
  return "starting";
}

export function productionAgentClosingDeps(root: string, output: Pick<Output, "json">, signIn: (agentId: string) => Promise<void>): AgentClosingDeps {
  return {
    interactive: () => process.stdin.isTTY === true && !output.json,
    ask: question => confirm(question),
    signIn,
    states: async () => {
      const record = await readNativeRecord(root).catch(() => null);
      if (!record) return null;
      const control = new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort);
      const report = await control.call({ op: "agents" }, AgentsReportSchema, { timeoutMs: 5_000 }).catch(() => null);
      return report ? Object.fromEntries(report.agents.map(agent => [agent.agentId, agentState(agent)])) : null;
    },
    sleep: ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
    now: Date.now,
    gitForWindowsMissing: () => process.platform === "win32" && findGitForWindows(process.env) === null,
  };
}

function names(agents: readonly string[]): string {
  const all = agents.map(agentName);
  return all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

/**
 * The close of `install` and `agent add` for Claude Code or Codex: sign in
 * the agents the person just set up, offer it once for any other found
 * without a sign-in, then say plainly which agents are ready and the one
 * command for each that is not.
 */
export async function closeAgentSetup(
  input: { agents: readonly string[]; signInNow: readonly string[]; missing: readonly string[]; output: Output },
  deps: AgentClosingDeps,
): Promise<void> {
  const closing = new AgentClosing(input, deps);
  for (const agent of input.signInNow) if (input.agents.includes(agent)) await closing.signIn(agent);
  let states = await closing.settle();
  if (deps.interactive() && await closing.offerSignIns(states)) states = await closing.settle();
  closing.summarize(states);
}

/** What the close of a setup did and still has to say. */
class AgentClosing {
  private readonly attempted = new Set<string>();
  private said = false;

  constructor(
    private readonly input: { agents: readonly string[]; signInNow: readonly string[]; missing: readonly string[]; output: Output },
    private readonly deps: AgentClosingDeps,
  ) {}

  /** A skipped or failed sign-in leaves the command in the summary. */
  async signIn(agent: string): Promise<void> {
    this.attempted.add(agent);
    await this.deps.signIn(agent).catch(() => undefined);
  }

  /** Every agent's state once none is still starting, or what is known at the deadline. */
  async settle(): Promise<Record<string, AgentState>> {
    if (this.input.agents.length === 0) return {};
    const deadline = this.deps.now() + (this.deps.waitMs ?? 90_000);
    for (;;) {
      const states = await this.deps.states().catch(() => null);
      if (states && this.allSettled(states)) return states;
      if (this.deps.now() >= deadline) return states ?? {};
      this.sayChecking();
      await this.deps.sleep(2_000);
    }
  }

  private sayChecking(): void {
    if (this.said) return;
    this.input.output.line("Checking which agents are ready…");
    this.said = true;
  }

  private allSettled(states: Record<string, AgentState>): boolean {
    return this.input.agents.every(agent => states[agent] !== undefined && states[agent] !== "starting");
  }

  /** Offers a sign-in, once, for each agent found without one; whether any was signed in. */
  async offerSignIns(states: Record<string, AgentState>): Promise<boolean> {
    let asked = false;
    for (const agent of this.input.agents) {
      if (states[agent] !== "needs_sign_in" || this.attempted.has(agent)) continue;
      if (!await this.deps.ask(`${agentName(agent)} is here but not signed in. Sign in now?`)) { this.attempted.add(agent); continue; }
      asked = true;
      await this.signIn(agent);
    }
    return asked;
  }

  summarize(states: Record<string, AgentState>): void {
    const { input } = this;
    const ready = input.agents.filter(agent => states[agent] === "ready");
    input.output.line(ready.length > 0 ? `Ready to work here: ${names(ready)}.` : "No coding agent is ready here yet.");
    for (const agent of input.agents) {
      const line = notReadyLine(agent, states[agent]);
      if (line) input.output.line(line);
    }
    if (input.agents.includes("claude-code") && this.deps.gitForWindowsMissing?.()) input.output.line(GIT_HINT);
    for (const agent of input.missing) input.output.line(`To add ${agentName(agent)}: konteks-remote agent add ${agent}`);
  }
}

function notReadyLine(agent: string, state: AgentState | undefined): string | null {
  const name = agentName(agent);
  switch (state) {
    case "ready": return null;
    case "needs_sign_in": return `${name} needs you to sign in: konteks-remote auth login ${agent}`;
    case "failed": return `${name} could not start here; to see why: konteks-remote doctor`;
    default: return `${name} is still starting; konteks-remote agents shows when it is ready.`;
  }
}
