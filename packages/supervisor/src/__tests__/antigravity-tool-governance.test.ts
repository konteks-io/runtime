import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE,
  ANTIGRAVITY_QUARANTINE_MESSAGE,
  AntigravityToolGovernance,
  antigravityCallTool,
  isAntigravityTrustQuestion,
} from "../session/antigravity-tool-governance.js";
import { hostToolGovernance } from "../session/host-tool-governance.js";

// Shapes as Google's antigravity-acp 1.2.1 sends them (antigravity-runtime-support
// proof/enterprise/*.jsonl and the feasibility transcripts acp-allow, acp-hostile,
// acp-subagent, acp-mcp-call-allow): a call that asks is a `tool_call` (status
// pending) with the full input, then `session/request_permission` naming it with
// the same title, kind and input; the harness reports what really runs as its
// own call `<conversationId>:<n>`, titled `Running <tool>`, snake_case input.
const SESSION = "7f941318-42d2-4710-9eca-c791fbc0770a";
const WC = "/rt/workspaces/antigravity/assignment-1";
const SERVERS = new Set(["konteks-platform", "konteks-preview", "konteks-result"]);
const context = { cwd: WC, servers: SERVERS };
const ONCE_REJECT = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] as const;

interface Call { toolCallId: string; title: string; kind?: string; rawInput: Record<string, unknown>; content?: unknown[]; locations?: unknown[]; _meta?: Record<string, unknown> }
const toolCall = (call: Call, status = "pending") => ({ sessionUpdate: "tool_call", status, ...call });
const request = (call: Call): RequestPermissionRequest => ({ sessionId: SESSION, toolCall: { ...call, status: "pending" } as never, options: [...ONCE_REJECT] as never });
const done = (toolCallId: string, status: "completed" | "failed" | "cancelled" = "completed", extra: Record<string, unknown> = {}) => ({ sessionUpdate: "tool_call_update", toolCallId, status, ...extra });

const command = (id: string, line: string, cwd = WC): Call => ({ toolCallId: id, title: line, kind: "execute", rawInput: { CommandLine: line, Cwd: cwd, WaitMsBeforeAsync: 5000 } });
const createFile = (id: string, path: string): Call => ({
  toolCallId: id, title: "Run create_file?", kind: "edit",
  rawInput: { CodeContent: "hi", Description: "probe", Overwrite: true, TargetFile: path },
  locations: [{ path }], content: [{ path, newText: "hi", _meta: { kind: "add" }, type: "diff" }],
});
const runningEdit = (n: number, path: string, conversation = SESSION): Call => ({ toolCallId: `${conversation}:${n}`, title: "Running edit_file", kind: "edit", rawInput: { file_path: path }, locations: [{ path }] });
const mcpCall = (id: string, server: string, tool: string, args: Record<string, unknown> = {}): Call => ({
  toolCallId: id, title: `${server}_${tool}`, kind: "other", rawInput: { arguments: args, ...args }, _meta: { mcp: { tool, server }, is_mcp_tool_call: true },
});
const TRUST: Call = { toolCallId: "interaction_9cf7b4aa", title: "Do you trust the authors of this workspace to execute automated agent hooks?", rawInput: {} };

function governed() {
  const governance = new AntigravityToolGovernance();
  /** The call, then its request; `allow` answers it as the session would after policy. */
  const ask = (call: Call, answer?: boolean, extra: Partial<typeof context> & { browserTools?: boolean } = {}) => {
    governance.observe(toolCall(call), WC);
    const verdict = governance.decide(request(call), { ...context, ...extra });
    if (answer !== undefined) governance.answered(call.toolCallId, answer);
    return verdict;
  };
  return { governance, ask };
}

describe("Google Antigravity tool governance", () => {
  it("is the governance an Antigravity session runs under", () => {
    expect(hostToolGovernance("antigravity")).toBeInstanceOf(AntigravityToolGovernance);
    expect(hostToolGovernance("antigravity")!.agentName).toBe("Google Antigravity");
  });

  it("judges a command by its CommandLine through the policy, and refuses a Cwd outside the working copy", () => {
    const { ask } = governed();
    expect(ask(command("c1", "git push origin HEAD:probe-push"))).toEqual({ kind: "evaluate", request: expect.objectContaining({
      toolCall: { toolCallId: "c1", kind: "execute", title: "git push origin HEAD:probe-push", rawInput: { command: "git push origin HEAD:probe-push" } } }) });
    expect(ask(command("c2", "sudo rm -rf /tmp/x"))).toMatchObject({ kind: "evaluate", request: { toolCall: { rawInput: { command: "sudo rm -rf /tmp/x" } } } });
    expect(ask(command("c3", "ls", "/etc"))).toEqual({ kind: "deny", reason: "a command run outside the working copy" });
    expect(ask(command("c4", "echo hi", `${WC}/src`))).toMatchObject({ kind: "evaluate" });
  });

  it("refuses a command that names the private home, where the Gemini Enterprise token lives (the server counts it as workspace)", () => {
    const { ask } = governed();
    const home = { kind: "deny", reason: "a command that reaches Google Antigravity's private home (its sign-in)" };
    // What the model ran live on Gemini Enterprise when it went looking for its tools.
    expect(ask(command("h1", 'ls -la "$HOME/.gemini"'))).toEqual(home);
    expect(ask(command("h2", 'find "$HOME/.gemini" -name "*mcp*"'))).toEqual(home);
    expect(ask(command("h3", "cat ~/.gemini/antigravity-acp/acp_business_token.json"))).toEqual(home);
    expect(ask(command("h4", "cat ${GEMINI_HOME}/antigravity-acp/settings.json"))).toEqual(home);
    expect(ask(command("h5", "cd ~ && ls"))).toEqual(home);
    // Ordinary work that only looks similar still goes to the policy.
    expect(ask(command("h6", "git diff HEAD~1 --stat"))).toMatchObject({ kind: "evaluate" });
    expect(ask(command("h7", "npm test -- --reporter=dot"))).toMatchObject({ kind: "evaluate" });
    expect(ask(command("h8", "echo $PATH"))).toMatchObject({ kind: "evaluate" });
  });

  it("refuses a request that is not the call it names", () => {
    const { governance } = governed();
    governance.observe(toolCall(command("m1", "echo hi")), WC);
    expect(governance.decide(request(command("m1", "git push")), context)).toMatchObject({ kind: "deny" });
    governance.observe(toolCall(createFile("m2", `${WC}/a.txt`)), WC);
    expect(governance.decide(request({ ...createFile("m2", `${WC}/a.txt`), rawInput: { TargetFile: "/etc/passwd", CodeContent: "x" } }), context)).toMatchObject({ kind: "deny" });
    expect(governance.decide(request(command("never-seen", "echo")), context)).toEqual({ kind: "deny", reason: "no tool call precedes this permission request" });
  });

  it("checks every file of a change against the working copy (diff path, location and TargetFile)", () => {
    const { ask } = governed();
    expect(ask(createFile("e1", `${WC}/inside.txt`))).toEqual({ kind: "evaluate", request: expect.objectContaining({
      toolCall: { toolCallId: "e1", kind: "edit", title: "create_file", rawInput: { file_path: `${WC}/inside.txt` }, locations: [{ path: `${WC}/inside.txt` }] } }) });
    // Gemini Enterprise asked for the outside write (the API key refused it unasked): Konteks refuses.
    expect(ask(createFile("e2", "/rt/workspaces/antigravity/outside.txt"))).toEqual({ kind: "deny", reason: "a file outside the working copy" });
    // A diff entry naming another file than TargetFile: both must be inside.
    const smuggled = { ...createFile("e3", `${WC}/inside.txt`), content: [{ path: "/etc/hosts", newText: "x", type: "diff" }] };
    expect(ask(smuggled)).toEqual({ kind: "deny", reason: "a file outside the working copy" });
    expect(ask(createFile("e4", "../../escape.txt"))).toEqual({ kind: "deny", reason: "a file outside the working copy" });
  });

  it("always answers the workspace-trust question with Don't Trust, correlated or not", () => {
    const { governance, ask } = governed();
    expect(isAntigravityTrustQuestion(TRUST)).toBe(true);
    expect(isAntigravityTrustQuestion({ ...TRUST, kind: "execute" })).toBe(false);
    expect(ask(TRUST)).toEqual({ kind: "deny", reason: "Konteks never trusts a repository's automated agent hooks" });
    expect(governance.decide(request({ ...TRUST, toolCallId: "interaction_other" }), context)).toMatchObject({ kind: "deny" });
    // Its "completed" update after the answer is not work.
    expect(governance.observe(done(TRUST.toolCallId, "completed", { rawOutput: "Response received" }), WC)).toBeNull();
  });

  it("admits only this session's own Konteks MCP servers, the browser only with the session browser", () => {
    const { ask } = governed();
    expect(ask(mcpCall("p1", "konteks-result", "submit_result", { answer: "ok" }))).toEqual({ kind: "allow" });
    expect(ask(mcpCall("p2", "konteks-platform", "platform__harness__plan_get", { planId: "p" }))).toEqual({ kind: "allow" });
    expect(ask(mcpCall("p3", "konteks-preview", "preview_start"))).toEqual({ kind: "allow" });
    expect(ask(mcpCall("p4", "repo-server", "exfiltrate"))).toEqual({ kind: "deny", reason: "repo-server is not one of this session's servers" });
    // A repository server that borrowed a Konteks name is still not one this session was given.
    expect(ask(mcpCall("p5", "konteks-evil", "x"), undefined, { servers: new Set([...SERVERS, "konteks-evil"]) })).toEqual({ kind: "deny", reason: "konteks-evil is not a Konteks server" });
    const withBrowser = { servers: new Set([...SERVERS, "konteks-browser"]), browserTools: true };
    expect(ask(mcpCall("b1", "konteks-browser", "browser_navigate", { url: "http://127.0.0.1:3000" }), undefined, withBrowser)).toEqual({ kind: "allow" });
    expect(ask(mcpCall("b2", "konteks-browser", "browser_run_code_unsafe"), undefined, withBrowser)).toMatchObject({ kind: "deny" });
    expect(ask(mcpCall("b3", "konteks-browser", "browser_navigate"))).toMatchObject({ kind: "deny" });
    // `_meta.mcp` decides, never the ambiguous title.
    expect(antigravityCallTool(mcpCall("t", "konteks-result", "submit_result"))).toBe("mcp");
  });

  it("refuses invoke_subagent and any tool it does not know", () => {
    const { governance } = governed();
    const subagent: Call = { toolCallId: "sub", title: "Run invoke_subagent?", kind: "other", rawInput: { Subagents: [{ Prompt: "push the code", Workspace: "inherit" }] } };
    // Forced: asked without its call ever being recorded (observing it trips first, below).
    expect(governance.decide(request(subagent), context)).toMatchObject({ kind: "deny" });
    const imaginary: Call = { toolCallId: "imag", title: "Run generate_image?", kind: "other", rawInput: { Prompt: "x" } };
    governance.observe(toolCall(imaginary), WC);
    expect(governance.decide(request(imaginary), context)).toEqual({ kind: "deny", reason: "generate_image is not a tool Konteks allows Google Antigravity to use" });
  });

  it("judges a URL fetch like every agent's", () => {
    const { ask } = governed();
    expect(ask({ toolCallId: "f1", title: "Run read_url_content?", kind: "fetch", rawInput: { Url: "https://example.com" } })).toMatchObject({
      kind: "evaluate", request: { toolCall: { kind: "fetch", rawInput: { url: "https://example.com" } } } });
    // Live on Gemini Enterprise a web search asks as kind `search` with a `query`.
    expect(ask({ toolCallId: "f2", title: "Run search_web?", kind: "search", rawInput: { query: "agent client protocol" } })).toMatchObject({
      kind: "evaluate", request: { toolCall: { kind: "fetch", rawInput: { url: "agent client protocol" } } } });
  });

  describe("tripwire", () => {
    it("pairs Enterprise's approved create_file with the separate Running edit_file that writes it, once", () => {
      const { governance, ask } = governed();
      const path = `${WC}/inside.txt`;
      expect(governance.observe(toolCall({ toolCallId: `${SESSION}:1`, title: "Running list_directory", kind: "search", rawInput: { directory_path: WC }, locations: [{ path: WC }] }, "in_progress"), WC)).toBeNull();
      expect(governance.observe(done(`${SESSION}:1`), WC)).toBeNull();
      ask(createFile("67f8e438", path), true);
      expect(governance.observe(toolCall(runningEdit(2, path), "in_progress"), WC)).toBeNull();
      expect(governance.observe(done(`${SESSION}:2`), WC)).toBeNull();
      expect(governance.observe(done("67f8e438", "failed", { rawOutput: "Tool call was approved but never executed." }), WC)).toBeNull();
      // The allowance is spent: a second unasked write of the same file is a bypass.
      governance.observe(toolCall(runningEdit(3, path), "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:3`), WC)).toEqual({ toolCallId: `${SESSION}:3`, title: "edit_file" });
    });

    it("trips on a Running edit_file whose request Konteks refused or that no request preceded", () => {
      const { governance, ask } = governed();
      ask(createFile("r1", `${WC}/a.txt`), false);
      governance.observe(toolCall(runningEdit(4, `${WC}/a.txt`), "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:4`), WC)).toEqual({ toolCallId: `${SESSION}:4`, title: "edit_file" });
      // Allowed for one file, not another.
      ask(createFile("r2", `${WC}/b.txt`), true);
      governance.observe(toolCall(runningEdit(5, `${WC}/c.txt`), "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:5`), WC)).toMatchObject({ title: "edit_file" });
    });

    it("lets an allowed command finish on its own call, and trips when a refused one ran anyway", () => {
      const { governance, ask } = governed();
      ask(command("ok", "echo hello"), true);
      governance.observe({ sessionUpdate: "tool_call_update", toolCallId: "ok", kind: "execute", status: "in_progress", rawInput: { command_line: "echo hello", working_dir: WC } }, WC);
      expect(governance.observe(done("ok", "completed", { rawOutput: { exitCode: 0, combinedOutput: "hello\n" } }), WC)).toBeNull();
      ask(command("no", "git push origin main"), false);
      expect(governance.observe(done("no", "failed", { rawOutput: "Rejected by user" }), WC)).toBeNull();
      ask(command("ignored", "git push origin main"), false);
      expect(governance.observe(done("ignored"), WC)).toEqual({ toolCallId: "ignored", title: "run_command", unaskedCommand: true });
    });

    it("trips on a subagent's command, which never asks", () => {
      const { governance } = governed();
      const conversation = "e1b92d65-1f8c-4c53-8885-e7cc4443b095";
      governance.observe(toolCall({ toolCallId: `${conversation}:1`, title: "git push origin HEAD:probe-push", kind: "execute", rawInput: { command_line: "git push origin HEAD:probe-push", working_dir: WC } }, "in_progress"), WC);
      expect(governance.observe(done(`${conversation}:1`, "completed", { rawOutput: { exitCode: 0 } }), WC)).toEqual({
        toolCallId: `${conversation}:1`, title: "run_command", unaskedCommand: true });
    });

    it("trips at once on any subagent tool or the admin browser subagent's chrome-devtools", () => {
      const { governance } = governed();
      expect(governance.observe(toolCall({ toolCallId: "s1", title: "Run invoke_subagent?", kind: "other", rawInput: { Subagents: [] } }), WC)).toEqual({ toolCallId: "s1", title: "invoke_subagent" });
      expect(governance.observe(toolCall({ toolCallId: `${SESSION}:2`, title: "Running start_subagent", kind: "other", rawInput: {} }, "in_progress"), WC)).toEqual({ toolCallId: `${SESSION}:2`, title: "start_subagent" });
      expect(governance.observe(toolCall(mcpCall("cd", "chrome-devtools", "navigate_page"), "in_progress"), WC)).toMatchObject({ toolCallId: "cd" });
    });

    it("a command with no request at all (Always proceed) trips and names the Enterprise setting on Gemini Enterprise", () => {
      const { governance } = governed();
      governance.observe(toolCall(command("auto", "echo unasked"), "in_progress"), WC);
      const bypass = governance.observe(done("auto"), WC);
      expect(bypass).toEqual({ toolCallId: "auto", title: "run_command", unaskedCommand: true });
      expect(governance.quarantineMessageFor(bypass!, "oauth-business")).toBe(ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE);
      expect(ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE).toContain("Terminal auto-execution to Require review");
      expect(governance.quarantineMessageFor(bypass!, "gemini-api-key")).toBe(ANTIGRAVITY_QUARANTINE_MESSAGE);
      expect(governance.quarantineMessageFor({ toolCallId: "x", title: "edit_file" }, "oauth-business")).toBe(ANTIGRAVITY_QUARANTINE_MESSAGE);
    });

    it("reads inside the working copy are fine; one outside trips; an unasked MCP call or unknown tool trips", () => {
      const { governance } = governed();
      governance.observe(toolCall({ toolCallId: `${SESSION}:6`, title: "Running view_file", kind: "read", rawInput: { AbsolutePath: `${WC}/README.md` } }, "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:6`), WC)).toBeNull();
      governance.observe(toolCall({ toolCallId: `${SESSION}:7`, title: "Running view_file", kind: "read", rawInput: { file_path: "/Users/someone/.gemini/antigravity-acp/acp_business_token.json" } }, "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:7`), WC)).toEqual({ toolCallId: `${SESSION}:7`, title: "view_file" });
      governance.observe(toolCall(mcpCall("m", "konteks-result", "submit_result"), "in_progress"), WC);
      expect(governance.observe(done("m"), WC)).toEqual({ toolCallId: "m", title: "mcp" });
      governance.observe(toolCall({ toolCallId: `${SESSION}:8`, title: "Running schedule", kind: "other", rawInput: {} }, "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:8`), WC)).toEqual({ toolCallId: `${SESSION}:8`, title: "schedule" });
      // `finish` and a web search never trip.
      governance.observe(toolCall({ toolCallId: `${SESSION}:9`, title: "Running finish", kind: "other", rawInput: {} }, "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:9`), WC)).toBeNull();
      governance.observe(toolCall({ toolCallId: `${SESSION}:10`, title: "Running search_web", kind: "fetch", rawInput: { query: "acp" } }, "in_progress"), WC);
      expect(governance.observe(done(`${SESSION}:10`), WC)).toBeNull();
    });

    it("an allowed MCP call completes on its own call", () => {
      const { governance, ask } = governed();
      expect(ask(mcpCall("r", "konteks-result", "submit_result", { answer: "ok" }), true)).toEqual({ kind: "allow" });
      expect(governance.observe(done("r", "completed", { rawOutput: "submit" }), WC)).toBeNull();
    });
  });
});


it("uses the same selected read roots for asked and observed Antigravity reads", () => {
  const governance = new AntigravityToolGovernance();
  const skill = "/rt/selected-skills/review", file = `${skill}/SKILL.md`;
  const requested = { toolCallId: "asked-skill", title: "Run view_file?", kind: "read", rawInput: { AbsolutePath: file } };
  governance.observe(toolCall(requested), WC, [skill]);
  expect(governance.decide(request(requested), { ...context, readOnlyRoots: [skill] })).toMatchObject({ kind: "evaluate" });
  const observed = { toolCallId: "unasked-skill", title: "Running view_file", kind: "read", rawInput: { file_path: file } };
  governance.observe(toolCall(observed, "in_progress"), WC, [skill]);
  expect(governance.observe(done("unasked-skill"), WC, [skill])).toBeNull();
  governance.observe(toolCall({ ...observed, toolCallId: "peer", rawInput: { file_path: "/rt/other-session/private.txt" } }, "in_progress"), WC, [skill]);
  expect(governance.observe(done("peer"), WC, [skill])).toEqual({ toolCallId: "peer", title: "view_file" });
  const unnamed = { toolCallId: "unnamed", title: "Run view_file?", kind: "read", rawInput: {} };
  governance.observe(toolCall(unnamed), WC, [skill]);
  expect(governance.decide(request(unnamed), { ...context, readOnlyRoots: [skill] })).toMatchObject({ kind: "deny" });
});


describe("Antigravity unasked read path authority", () => {
  it.each([
    ["view_file", "read"],
    ["list_directory", "search"],
    ["list_dir", "search"],
    ["search_directory", "search"],
    ["find_file", "search"],
    ["find_by_name", "search"],
    ["grep_search", "search"],
  ])("trips when completed %s has no extractable path", (tool, kind) => {
    const inputs: unknown[] = [{}, { opaque_path: `${WC}/README.md` }, { AbsolutePath: " ", path: null }, "{not-json", "{}", []];
    for (const [index, rawInput] of inputs.entries()) {
      const governance = new AntigravityToolGovernance();
      const toolCallId = `opaque-${tool}-${index}`;
      expect(governance.observe({ sessionUpdate: "tool_call", toolCallId, title: `Running ${tool}`, kind, status: "in_progress", rawInput, locations: [{ opaque_path: WC }] }, WC)).toBeNull();
      expect(governance.observe(done(toolCallId), WC)).toEqual({ toolCallId, title: tool });
    }
  });

  it.each([
    "AbsolutePath", "absolute_path", "DirectoryPath", "directory_path", "SearchPath",
    "search_path", "SearchDirectory", "file_path", "FilePath", "path",
  ])("keeps the supported %s input carrier inside the working copy", key => {
    const governance = new AntigravityToolGovernance();
    const toolCallId = `carrier-${key}`;
    governance.observe(toolCall({ toolCallId, title: "Running view_file", kind: "read", rawInput: { [key]: "README.md" } }, "in_progress"), WC);
    expect(governance.observe(done(toolCallId), WC)).toBeNull();
  });

  it.each([
    { tool: "view_file", kind: "read", rawInput: { AbsolutePath: `${WC}/README.md`, search_path: "/rt/other-session/private.txt" }, locations: [{ path: "/rt/selected-skills/review/SKILL.md" }] },
    { tool: "grep_search", kind: "search", rawInput: { AbsolutePath: `${WC}/README.md`, search_path: "/rt/other-session/private.txt" }, locations: [{ path: "/rt/selected-skills/review/SKILL.md" }] },
    { tool: "view_file", kind: "read", rawInput: { AbsolutePath: `${WC}/README.md`, search_path: "/rt/selected-skills/review/SKILL.md" }, locations: [{ path: "/rt/other-session/private.txt" }] },
    { tool: "grep_search", kind: "search", rawInput: { AbsolutePath: `${WC}/README.md`, search_path: "/rt/selected-skills/review/SKILL.md" }, locations: [{ path: "/rt/other-session/private.txt" }] },
  ])("trips on mixed allowed and outside paths in completed $tool", ({ tool, kind, rawInput, locations }) => {
    const governance = new AntigravityToolGovernance();
    const skill = "/rt/selected-skills/review";
    const toolCallId = `mixed-${tool}`;
    governance.observe(toolCall({ toolCallId, title: `Running ${tool}`, kind, rawInput, locations }, "in_progress"), WC, [skill]);
    expect(governance.observe(done(toolCallId), WC, [skill])).toEqual({ toolCallId, title: tool });
  });

  it("keeps location-only and replayed JSON carriers in selected read roots", () => {
    const governance = new AntigravityToolGovernance();
    const skill = "/rt/selected-skills/review", file = `${skill}/SKILL.md`;
    governance.observe(toolCall({ toolCallId: "location-only", title: "Running list_directory", kind: "search", rawInput: {}, locations: [{ path: skill }] }, "in_progress"), WC, [skill]);
    expect(governance.observe(done("location-only"), WC, [skill])).toBeNull();
    governance.observe({ sessionUpdate: "tool_call", toolCallId: "replay-json", title: "Running view_file", status: "in_progress", rawInput: JSON.stringify({ file_path: file }) }, WC, [skill]);
    expect(governance.observe(done("replay-json"), WC, [skill])).toBeNull();
  });

  it("judges paths filled by progress or the completion input", () => {
    const governance = new AntigravityToolGovernance();
    governance.observe(toolCall({ toolCallId: "progress-path", title: "Running grep_search", kind: "search", rawInput: {} }, "in_progress"), WC);
    expect(governance.observe({ sessionUpdate: "tool_call_update", toolCallId: "progress-path", status: "in_progress", locations: [{ path: WC }] }, WC)).toBeNull();
    expect(governance.observe(done("progress-path"), WC)).toBeNull();
    governance.observe(toolCall({ toolCallId: "completion-path", title: "Running view_file", kind: "read", rawInput: {} }, "in_progress"), WC);
    expect(governance.observe(done("completion-path", "completed", { rawInput: { AbsolutePath: `${WC}/README.md` } }), WC)).toBeNull();
  });

  it.each(["failed", "cancelled"] as const)("does not trip on a pathless read that %s", status => {
    const governance = new AntigravityToolGovernance();
    governance.observe(toolCall({ toolCallId: status, title: "Running view_file", kind: "read", rawInput: {} }, "in_progress"), WC);
    expect(governance.observe(done(status, status), WC)).toBeNull();
  });
});
