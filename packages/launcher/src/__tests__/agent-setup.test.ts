import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAgentSetup, ensurePersonalAgent, setUpPersonalAgent, type AgentClosingDeps, type AgentSetupDeps, type AgentState } from "../native/agent-setup.js";
import { createOutput } from "../output.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function captured() {
  const lines: string[] = [];
  const output = createOutput({ json: false, stdout: { write: (text: string) => { lines.push(text.trimEnd()); return true; } } as never });
  return { lines, output };
}

function setupDeps(overrides: Partial<AgentSetupDeps> = {}): AgentSetupDeps & { questions: string[]; runs: Array<[string, readonly string[]]> } {
  const questions: string[] = [];
  const runs: Array<[string, readonly string[]]> = [];
  let installed = false;
  return {
    questions, runs,
    interactive: () => true,
    ask: async question => { questions.push(question); return true; },
    run: async (command, args) => { runs.push([command, args]); installed = true; return 0; },
    platform: "win32",
    found: async () => installed,
    codexHome: () => undefined,
    gitForWindows: () => true,
    ...overrides,
  };
}

describe("setting up a missing Claude Code or Codex (D116)", () => {
  it("asks once, then runs Anthropic's official Windows installer in the person's terminal", async () => {
    const { lines, output } = captured();
    const deps = setupDeps();
    await expect(setUpPersonalAgent("claude-code", output, deps)).resolves.toBe(true);
    expect(deps.questions).toHaveLength(1);
    expect(deps.questions[0]).toContain("https://claude.ai/install.ps1");
    expect(deps.questions.join(" ") + lines.join(" ")).not.toContain("install.sh");
    expect(deps.runs).toHaveLength(1);
    const [command, args] = deps.runs[0]!;
    expect(command).toMatch(/powershell\.exe$/i);
    expect(args.at(-1)).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("on Windows without Git for Windows, asks once and installs it with winget before Claude Code (D116)", async () => {
    const { output } = captured();
    let git = false;
    const deps = setupDeps({ gitForWindows: () => git });
    const run = deps.run;
    deps.run = async (command, args) => { if (command === "winget") git = true; return run(command, args); };
    await expect(setUpPersonalAgent("claude-code", output, deps)).resolves.toBe(true);
    expect(deps.questions).toEqual([
      "Claude Code is not installed. Install it with Anthropic's official installer (https://claude.ai/install.ps1) and sign in?",
      "Claude Code needs Git for Windows. Install it with winget (Git.Git) first?",
    ]);
    expect(deps.runs[0]).toEqual(["winget", ["install", "--id", "Git.Git", "-e", "--source", "winget"]]);
    expect(deps.runs[1]![0]).toMatch(/powershell\.exe$/i);
  });

  it("without winget, or on a no, gives the one download line and still installs Claude Code (D116)", async () => {
    const noWinget = captured();
    const deps = setupDeps({ gitForWindows: () => false });
    const run = deps.run;
    deps.run = async (command, args) => (command === "winget" ? null : run(command, args));
    await expect(setUpPersonalAgent("claude-code", noWinget.output, deps)).resolves.toBe(true);
    expect(noWinget.lines.filter(line => line.includes("https://git-scm.com/download/win"))).toHaveLength(1);
    expect(deps.runs.map(([command]) => command).at(-1)).toMatch(/powershell\.exe$/i);

    const declined = captured();
    const answers = [true, false];
    const no = setupDeps({ gitForWindows: () => false, ask: async question => { no.questions.push(question); return answers.shift()!; } });
    await expect(setUpPersonalAgent("claude-code", declined.output, no)).resolves.toBe(true);
    expect(no.runs.map(([command]) => command)).not.toContain("winget");
    expect(declined.lines.filter(line => line.includes("https://git-scm.com/download/win"))).toHaveLength(1);
  });

  it("asks about Git only on Windows, and only when it is missing (D116)", async () => {
    const { output } = captured();
    const present = setupDeps();
    await setUpPersonalAgent("claude-code", output, present);
    expect(present.questions).toHaveLength(1);
    const mac = setupDeps({ platform: "darwin", gitForWindows: () => false });
    await setUpPersonalAgent("claude-code", output, mac);
    expect(mac.questions).toHaveLength(1);
    expect(mac.runs.map(([command]) => command)).not.toContain("winget");
  });

  it("runs the official shell installer on macOS and Linux", async () => {
    const { output } = captured();
    const deps = setupDeps({ platform: "darwin" });
    await expect(setUpPersonalAgent("claude-code", output, deps)).resolves.toBe(true);
    expect(deps.questions[0]).toContain("https://claude.ai/install.sh");
    expect(deps.runs).toEqual([["/bin/bash", ["-o", "pipefail", "-c", "curl -fsSL https://claude.ai/install.sh | bash"]]]);
  });

  it("downloads nothing on a no, or without a terminal to ask in", async () => {
    const { output } = captured();
    const no = setupDeps({ ask: async () => false });
    await expect(setUpPersonalAgent("claude-code", output, no)).resolves.toBe(false);
    expect(no.runs).toEqual([]);
    const headless = setupDeps({ interactive: () => false });
    await expect(setUpPersonalAgent("claude-code", output, headless)).resolves.toBe(false);
    expect(headless.questions).toEqual([]);
    expect(headless.runs).toEqual([]);
  });

  it("says the one command to try again when the installer does not finish", async () => {
    const { lines, output } = captured();
    const deps = setupDeps({ run: async () => 1 });
    await expect(setUpPersonalAgent("claude-code", output, deps)).resolves.toBe(false);
    expect(lines.at(-1)).toContain("konteks-remote agent add claude-code");
  });

  it("sets Codex up from the copy that ships with Konteks, downloading nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-setup-")); roots.push(root);
    const home = join(root, ".codex");
    const { output } = captured();
    const deps = setupDeps({ codexHome: () => home, found: async () => (await stat(home).catch(() => null))?.isDirectory() === true });
    await expect(setUpPersonalAgent("codex", output, deps)).resolves.toBe(true);
    expect(deps.questions).toHaveLength(1);
    expect(deps.questions[0]).toMatch(/nothing is downloaded/i);
    expect(deps.runs).toEqual([]);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("agent add without a terminal names the platform's installer and the command to run after it", async () => {
    const { output } = captured();
    const deps = setupDeps({ interactive: () => false });
    const refused = ensurePersonalAgent("claude-code", output, deps);
    await expect(refused).rejects.toMatchObject({ message: expect.stringContaining("irm https://claude.ai/install.ps1 | iex") });
    await expect(ensurePersonalAgent("claude-code", output, deps)).rejects.toMatchObject({ message: expect.stringContaining("konteks-remote agent add claude-code") });
    await expect(ensurePersonalAgent("claude-code", output, deps)).rejects.not.toMatchObject({ message: expect.stringContaining("install.sh") });
    // Without a terminal and without Git for Windows: no download, the hint only.
    await expect(ensurePersonalAgent("claude-code", output, setupDeps({ interactive: () => false, gitForWindows: () => false }))).rejects.toMatchObject({ message: expect.stringContaining("https://git-scm.com/download/win") });
    await expect(ensurePersonalAgent("claude-code", output, setupDeps({ ask: async () => false }))).rejects.toMatchObject({ message: "Nothing was installed: Claude Code was not added." });
    await expect(ensurePersonalAgent("claude-code", output, setupDeps({ found: async () => true }))).resolves.toBe("found");
    await expect(ensurePersonalAgent("claude-code", output, setupDeps())).resolves.toBe("set_up");
  });
});

function closingDeps(sequence: Array<Record<string, AgentState> | null>, overrides: Partial<AgentClosingDeps> = {}) {
  let now = 0;
  const signedIn: string[] = [];
  const questions: string[] = [];
  const deps: AgentClosingDeps = {
    interactive: () => true,
    ask: async question => { questions.push(question); return true; },
    signIn: async agent => { signedIn.push(agent); },
    states: vi.fn(async () => (sequence.length > 1 ? sequence.shift()! : sequence[0]!)),
    sleep: async ms => { now += ms; },
    now: () => now,
    ...overrides,
  };
  return { deps, signedIn, questions };
}

describe("the install's closing summary (D116)", () => {
  it("with no agent, says so and gives the one command for each", async () => {
    const { lines, output } = captured();
    const c = closingDeps([{}]);
    await closeAgentSetup({ agents: [], signInNow: [], missing: ["claude-code", "codex"], output }, c.deps);
    expect(lines).toEqual([
      "No coding agent is ready here yet.",
      "To add Claude Code: konteks-remote agent add claude-code",
      "To add Codex: konteks-remote agent add codex",
    ]);
    expect(c.deps.states).not.toHaveBeenCalled();
  });

  it("signs a just-installed agent in, then names it ready", async () => {
    const { lines, output } = captured();
    const c = closingDeps([{ "claude-code": "ready" }]);
    await closeAgentSetup({ agents: ["claude-code"], signInNow: ["claude-code"], missing: ["codex"], output }, c.deps);
    expect(c.signedIn).toEqual(["claude-code"]);
    expect(c.questions).toEqual([]);
    expect(lines).toEqual(["Ready to work here: Claude Code.", "To add Codex: konteks-remote agent add codex"]);
  });

  it("offers to sign in an agent found here without a sign-in, once", async () => {
    const { lines, output } = captured();
    const c = closingDeps([{ "claude-code": "ready", codex: "needs_sign_in" }, { "claude-code": "ready", codex: "ready" }]);
    await closeAgentSetup({ agents: ["claude-code", "codex"], signInNow: [], missing: [], output }, c.deps);
    expect(c.questions).toEqual(["Codex is here but not signed in. Sign in now?"]);
    expect(c.signedIn).toEqual(["codex"]);
    expect(lines).toEqual(["Ready to work here: Claude Code and Codex."]);
  });

  it("without a terminal, asks nothing and says the command", async () => {
    const { lines, output } = captured();
    const c = closingDeps([{ codex: "needs_sign_in" }], { interactive: () => false });
    await closeAgentSetup({ agents: ["codex"], signInNow: [], missing: ["claude-code"], output }, c.deps);
    expect(c.questions).toEqual([]);
    expect(lines).toEqual([
      "No coding agent is ready here yet.",
      "Codex needs you to sign in: konteks-remote auth login codex",
      "To add Claude Code: konteks-remote agent add claude-code",
    ]);
  });

  it("waits for agents still starting, saying so once", async () => {
    const { lines, output } = captured();
    const c = closingDeps([null, { codex: "starting" }, { codex: "ready" }]);
    await closeAgentSetup({ agents: ["codex"], signInNow: [], missing: [], output }, c.deps);
    expect(lines).toEqual(["Checking which agents are ready…", "Ready to work here: Codex."]);
  });

  it("names Git for Windows when Claude Code is here without it (D116)", async () => {
    const { lines, output } = captured();
    const c = closingDeps([{ "claude-code": "failed" }], { gitForWindowsMissing: () => true });
    await closeAgentSetup({ agents: ["claude-code"], signInNow: [], missing: [], output }, c.deps);
    expect(lines).toContain("Claude Code needs Git for Windows: https://git-scm.com/download/win");
  });

  it("a sign-in that is skipped or fails leaves the command to run later", async () => {
    const { lines, output } = captured();
    const c = closingDeps([{ "claude-code": "needs_sign_in" }], { signIn: async () => { throw new Error("cancelled"); } });
    await closeAgentSetup({ agents: ["claude-code"], signInNow: ["claude-code"], missing: [], output }, c.deps);
    expect(c.questions).toEqual([]);
    expect(lines).toEqual(["No coding agent is ready here yet.", "Claude Code needs you to sign in: konteks-remote auth login claude-code"]);
  });
});
