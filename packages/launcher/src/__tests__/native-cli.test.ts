import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeProgram, installedReleaseVersion } from "../native/cli.js";

function fixture() {
  const actions = { install: vi.fn(async () => {}), addAgent: vi.fn(async () => {}), removeAgent: vi.fn(async () => {}), serve: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), update: vi.fn(async () => {}), uninstall: vi.fn(async () => {}), control: vi.fn(async () => {}) };
  const program = createNativeProgram(actions).exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return { program, actions };
}

describe("native customer entry point", () => {
  it("exposes native lifecycle without a BYOK or appliance command", () => {
    const { program } = fixture();
    expect(program.commands.map(command => command.name())).toEqual(expect.arrayContaining(["install", "serve", "start", "stop", "status", "agents", "auth"]));
    expect(program.commands.map(command => command.name())).not.toContain("gateway");
    expect(program.helpInformation()).not.toMatch(/Docker|Compose|gateway-keyed/);
  });
  it("offers an uninstall an agent can find in --help (W1-L2)", async () => {
    const { program, actions } = fixture();
    expect(program.helpInformation()).toMatch(/uninstall\s+remove Konteks from this computer/);
    // Every command a person runs says in plain words what it does (WS1-158).
    expect(program.helpInformation()).toMatch(/status\s+show whether this computer is connected/);
    await program.parseAsync(["--json", "uninstall"], { from: "user" });
    expect(actions.uninstall).toHaveBeenCalledWith(expect.objectContaining({ root: expect.any(String) }));
  });
  it("runs the native service command used by all OS service definitions", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["serve", "--root", "/private/native-root"], { from: "user" });
    expect(actions.serve).toHaveBeenCalledWith(expect.objectContaining({ root: "/private/native-root" }));
    expect(actions.install).not.toHaveBeenCalled();
  });
  it("routes install to native activation without passing a secret or appliance switches", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "install", "--activation-id", "activation-123", "--agents", "codex", "--core-url", "https://core.example", "--relay-url", "wss://relay.example/runtime"], { from: "user" });
    expect(actions.install).toHaveBeenCalledWith(expect.objectContaining({ activationId: "activation-123", agents: ["codex"], root: "/private/native-root" }));
    expect(actions.install.mock.calls[0]?.[0]).not.toHaveProperty("activationCode");
  });
  it.each(["--setup-docker-engine", "--gateway-keyed", "--activation-code"])("rejects retired/secret install switch %s", async option => {
    const { program, actions } = fixture();
    await expect(program.parseAsync(["install", "--activation-id", "activation-123", option], { from: "user" })).rejects.toThrow();
    expect(actions.install).not.toHaveBeenCalled();
  });
  it("routes official login and organization attestation through native control", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["auth", "login", "codex", "--organization"], { from: "user" });
    expect(actions.control).toHaveBeenCalledWith(expect.objectContaining({ operation: "auth.login", agent: "codex", organization: true }));
    // OpenCode names which sign-in (CP3); it is not installable yet, but its sign-in commands parse.
    await program.parseAsync(["auth", "login", "opencode", "--provider", "deepseek", "--method", "key", "--reuse"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "auth.login", agent: "opencode", organization: false, provider: "deepseek", method: "key", reuse: true }));
    await program.parseAsync(["auth", "logout", "opencode", "--provider", "openai"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "auth.logout", agent: "opencode", provider: "openai" }));
  });
  it("signs Google Antigravity in and out with a Gemini API key or Gemini Enterprise (antigravity CP3)", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["auth", "login", "antigravity"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "auth.login", agent: "antigravity", organization: false }));
    expect(actions.control.mock.calls.at(-1)?.[0]).not.toHaveProperty("method");
    await program.parseAsync(["auth", "login", "antigravity", "--api-key"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity", method: "gemini-api-key" }));
    // The key itself is never an argument: only the choice is.
    expect(JSON.stringify(actions.control.mock.calls.at(-1))).not.toMatch(/AIza/);
    await program.parseAsync(["auth", "login", "antigravity", "--enterprise"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity", method: "oauth-business" }));
    await program.parseAsync(["auth", "login", "antigravity", "--project", "gemini-enterprise-qa-25d3"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity", method: "oauth-business", project: "gemini-enterprise-qa-25d3", location: "global" }));
    await program.parseAsync(["auth", "login", "antigravity", "--enterprise", "--project", "gemini-enterprise-qa-25d3", "--location", "eu"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ project: "gemini-enterprise-qa-25d3", location: "eu" }));
    const calls = actions.control.mock.calls.length;
    for (const argv of [["auth", "login", "antigravity", "--project", "Bad_Project"], ["auth", "login", "antigravity", "--project", "gemini-enterprise-qa-25d3", "--location", "asia"],
      ["auth", "login", "antigravity", "--api-key", "--enterprise"], ["auth", "login", "antigravity", "--location", "us"], ["auth", "login", "codex", "--api-key"],
      ["auth", "logout", "antigravity", "--api-key", "--enterprise"], ["auth", "logout", "opencode", "--enterprise"]]) {
      await expect(program.parseAsync(argv, { from: "user" }), argv.join(" ")).rejects.toThrow();
    }
    expect(actions.control.mock.calls.length).toBe(calls);
    await program.parseAsync(["auth", "logout", "antigravity", "--enterprise"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "auth.logout", agent: "antigravity", method: "oauth-business" }));
    await program.parseAsync(["auth", "logout", "antigravity"], { from: "user" });
    expect(actions.control.mock.calls.at(-1)?.[0]).not.toHaveProperty("method");
  });
  it("adds Google Antigravity on the person's yes, installs it, removes it, and its help names it (antigravity CP6)", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "agent", "add", "antigravity"], { from: "user" });
    expect(actions.addAgent).toHaveBeenLastCalledWith(expect.objectContaining({ root: "/private/native-root", agent: "antigravity" }));
    expect(actions.addAgent.mock.calls.at(-1)?.[0]).not.toHaveProperty("yes");
    await program.parseAsync(["agent", "add", "antigravity", "--yes"], { from: "user" });
    expect(actions.addAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity", yes: true }));
    // Other agents ask no download question.
    await expect(program.parseAsync(["agent", "add", "codex", "--yes"], { from: "user" })).rejects.toThrow();
    await program.parseAsync(["--root", "/private/native-root", "install", "--activation-id", "activation-123", "--agents", "codex,antigravity"], { from: "user" });
    expect(actions.install).toHaveBeenLastCalledWith(expect.objectContaining({ agents: ["codex", "antigravity"] }));
    await program.parseAsync(["agent", "remove", "antigravity"], { from: "user" });
    expect(actions.removeAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity" }));
    await program.parseAsync(["agent", "remove", "antigravity", "--yes"], { from: "user" });
    expect(actions.removeAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity", yes: true }));
    await program.parseAsync(["auth", "status", "antigravity"], { from: "user" });
    expect(actions.control).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "auth.status", agent: "antigravity" }));
    const agentCommand = program.commands.find(c => c.name() === "agent")!;
    expect(agentCommand.commands.find(c => c.name() === "add")!.helpInformation().replace(/\s+/g, " ")).toMatch(/Google Antigravity, downloaded from Google \(dl\.google\.com, about 110 MB\) after you say yes/);
    expect(agentCommand.commands.find(c => c.name() === "remove")!.helpInformation().replace(/\s+/g, " ")).toMatch(/remove Google Antigravity from this computer/);
    expect(program.commands.find(c => c.name() === "install")!.helpInformation().replace(/\s+/g, " ")).toContain("claude-code, codex, dsh, opencode, antigravity");
  });
  it("offers a read-only preview status, and no local preview switch", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["preview", "status"], { from: "user" });
    expect(actions.control).toHaveBeenCalledWith(expect.objectContaining({ operation: "preview.status" }));
    const preview = program.commands.find(command => command.name() === "preview");
    expect(preview?.commands.map(command => command.name())).toEqual(["status"]);
  });
  it("reports the installed release as its version, so it matches status after an update (W1-L4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-version-"));
    try {
      expect(installedReleaseVersion(root)).toBeNull();
      await writeFile(join(root, "native-runtime.json"), JSON.stringify({ releaseId: "release-next", bundleVersion: "0.5.1" }));
      expect(installedReleaseVersion(root)).toBe("0.5.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exposes update as a native transaction with check-only and unattended forms", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "update"], { from: "user" });
    expect(actions.update).toHaveBeenLastCalledWith(expect.objectContaining({ root: "/private/native-root", check: false, unattended: false }));
    await program.parseAsync(["--root", "/private/native-root", "--json", "update", "--unattended"], { from: "user" });
    expect(actions.update).toHaveBeenLastCalledWith(expect.objectContaining({ unattended: true, check: false }));
    await program.parseAsync(["update", "--check"], { from: "user" });
    expect(actions.update).toHaveBeenLastCalledWith(expect.objectContaining({ check: true }));
    expect(program.commands.map(command => command.name())).not.toContain("rollback");
  });
  it("adds an agent to the installed runtime without asking for activation material", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "agent", "add", "codex"], { from: "user" });
    expect(actions.addAgent).toHaveBeenCalledWith(expect.objectContaining({ root: "/private/native-root", agent: "codex" }));
    // The person's own DeepSeek Harness is added the same way.
    await program.parseAsync(["--root", "/private/native-root", "agent", "add", "dsh"], { from: "user" });
    expect(actions.addAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "dsh" }));
    expect(actions.install).not.toHaveBeenCalled();
  });
  it.each(["pi"])("refuses the retired %s agent with the shared sentence", async retired => {
    const { program, actions } = fixture();
    program.exitOverride();
    for (const command of [program.commands.find(c => c.name() === "agent")!, ...program.commands.find(c => c.name() === "agent")!.commands]) command.exitOverride();
    let stderr = "";
    program.configureOutput({ writeErr: text => { stderr += text; } });
    for (const command of program.commands.find(c => c.name() === "agent")!.commands) command.configureOutput({ writeErr: text => { stderr += text; } });
    await expect(program.parseAsync(["--root", "/private/native-root", "agent", "add", retired], { from: "user" })).rejects.toThrow();
    // The agent list is packages' (7.1.0 names four; the Antigravity minor adds Google Antigravity).
    expect(stderr).toMatch(new RegExp(`${retired} is no longer supported\\. Choose Claude Code, Codex, DeepSeek Harness(,| or) OpenCode( or Google Antigravity)? on your computer\\.`));
    expect(actions.addAgent).not.toHaveBeenCalled();
  });
  it("adds, installs, signs in and out the person's own OpenCode 2, and its help names it (CP6)", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "agent", "add", "opencode"], { from: "user" });
    expect(actions.addAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: "opencode" }));
    await program.parseAsync(["--root", "/private/native-root", "install", "--enroll", "--agents", "codex,opencode"], { from: "user" });
    expect(actions.install).toHaveBeenCalledWith(expect.objectContaining({ enroll: true, agents: ["codex", "opencode"] }));
    await program.parseAsync(["--root", "/private/native-root", "auth", "status", "opencode"], { from: "user" });
    expect(actions.control).toHaveBeenCalledWith(expect.objectContaining({ operation: "auth.status", agent: "opencode" }));
    await program.parseAsync(["--root", "/private/native-root", "auth", "login", "opencode", "--reuse"], { from: "user" });
    expect(actions.control).toHaveBeenCalledWith(expect.objectContaining({ operation: "auth.login", agent: "opencode", reuse: true }));
    const agent = program.commands.find(c => c.name() === "agent")!.commands.find(c => c.name() === "add")!;
    expect(agent.helpInformation().replace(/\s+/g, " ")).toContain("dsh, opencode or antigravity");
    expect(program.commands.find(c => c.name() === "install")!.helpInformation().replace(/\s+/g, " ")).toContain("claude-code, codex, dsh, opencode");
  });
});
