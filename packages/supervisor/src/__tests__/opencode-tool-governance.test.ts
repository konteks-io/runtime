import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { parseKonteksCodeModeBlock } from "../session/opencode-code-mode.js";
import { OpenCodeToolGovernance } from "../session/opencode-tool-governance.js";

// Shapes as OpenCode 2.0.18 sends them (opencode-runtime-support CP0-v2,
// CP0 part 2): the first `tool_call` is titled with OpenCode's tool name and
// has no input yet, an update fills the input in, and the permission request
// carries the input with the command or path as its title. The options are
// always once / always / reject.
const WC = "/rt/workspaces/opencode/assignment-1";
const SERVERS = new Set(["konteks-platform", "konteks-preview", "konteks-result"]);
const KIND: Record<string, string> = { shell: "execute", edit: "edit", write: "edit", patch: "edit", execute: "other", read: "read", subagent: "think", webfetch: "fetch", skill: "other" };
const call = (toolCallId: string, title: string, meta?: Record<string, unknown>) =>
  ({ sessionUpdate: "tool_call", toolCallId, title, kind: KIND[title.split(": ").at(-1)!] ?? "other", status: "pending", locations: [], rawInput: {}, ...(meta ? { _meta: meta } : {}) });
const input = (toolCallId: string, rawInput: Record<string, unknown>) => ({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawInput });
const done = (toolCallId: string, status: "completed" | "failed" | "cancelled" = "completed", rawOutput?: unknown) =>
  ({ sessionUpdate: "tool_call_update", toolCallId, status, content: [], ...(rawOutput === undefined ? {} : { rawOutput }) });
const ask = (toolCallId: string, kind: string, title: string, rawInput: Record<string, unknown>): RequestPermissionRequest => ({
  sessionId: "s", toolCall: { toolCallId, kind: kind as never, title, rawInput },
  options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
});
const context = { cwd: WC, servers: SERVERS };

function governed() {
  const governance = new OpenCodeToolGovernance();
  const shell = (id: string, command: string, extra: Record<string, unknown> = {}) => {
    governance.observe(call(id, "shell"), WC);
    governance.observe(input(id, { command, description: "run", ...extra }), WC);
    return governance.decide(ask(id, "execute", command, { command, timeout: 60000, cwd: WC, ...extra }), context);
  };
  const code = (id: string, source: string) => {
    governance.observe(call(id, "execute"), WC);
    governance.observe(input(id, { code: source }), WC);
    return governance.decide(ask(id, "other", "execute", { code: source }), context);
  };
  return { governance, shell, code };
}

describe("OpenCode tool governance", () => {
  it("allows only the exact Skill ID authorized for this session", () => {
    const { governance } = governed();
    const id = "konteks-authorized";
    const invoke = (callId: string, seen: string, requested = seen, authorized = new Set([id])) => {
      governance.observe(call(callId, "skill"), WC);
      governance.observe(input(callId, { name: seen }), WC);
      return governance.decide(ask(callId, "other", "skill", { name: requested }), { ...context, managedSkillIds: authorized });
    };
    expect(invoke("skill-ok", id)).toEqual({ kind: "allow" });
    expect(invoke("skill-other", "personal-skill")).toMatchObject({ kind: "deny" });
    expect(invoke("skill-mismatch", id, "personal-skill")).toMatchObject({ kind: "deny" });
    expect(invoke("skill-stale", id, id, new Set())).toMatchObject({ kind: "deny" });
    expect(governance.observe(done("skill-ok"), WC)).toBeNull();
    governance.observe(call("skill-unasked", "skill"), WC);
    expect(governance.observe(done("skill-unasked"), WC)).toMatchObject({ title: "skill" });
  });

  it("judges a shell request by the command its call reported, and refuses a folder outside the working copy", () => {
    const { governance, shell } = governed();
    expect(shell("s1", "git push origin main")).toEqual({ kind: "evaluate", request: expect.objectContaining({
      toolCall: { toolCallId: "s1", kind: "execute", title: "git push origin main", rawInput: { command: "git push origin main" } } }) });
    expect(shell("s2", "sudo rm -rf /")).toMatchObject({ kind: "evaluate", request: { toolCall: { rawInput: { command: "sudo rm -rf /" } } } });
    expect(shell("s3", "ls", { workdir: "/etc" })).toEqual({ kind: "deny", reason: "a command run outside the working copy" });
    // A request whose command differs from the call's is not the call it names.
    governance.observe(call("s4", "shell"), WC);
    governance.observe(input("s4", { command: "echo hi" }), WC);
    expect(governance.decide(ask("s4", "execute", "echo hi", { command: "git push" }), context)).toMatchObject({ kind: "deny" });
  });

  it("checks every file of an edit against the working copy, relative paths resolved there", () => {
    const { governance } = governed();
    governance.observe(call("e1", "edit"), WC);
    expect(governance.decide(ask("e1", "edit", "2 files", { files: [{ file: "src/a.ts", patch: "@@" }, { file: "src/b.ts", patch: "@@" }] }), context)).toEqual({
      kind: "evaluate", request: expect.objectContaining({ toolCall: { toolCallId: "e1", kind: "edit", title: "edit", rawInput: { file_path: `${WC}/src/a.ts` },
        locations: [{ path: `${WC}/src/a.ts` }, { path: `${WC}/src/b.ts` }] } }) });
    governance.observe(call("e2", "edit"), WC);
    expect(governance.decide(ask("e2", "edit", "2 files", { files: [{ file: "src/a.ts", patch: "@@" }, { file: "../../outside.txt", patch: "@@" }] }), context))
      .toEqual({ kind: "deny", reason: "a file outside the working copy" });
    governance.observe(call("w1", "write"), WC);
    governance.observe(input("w1", { path: "/etc/cron.d/x", content: "* * * * * id" }), WC);
    expect(governance.decide(ask("w1", "edit", "/etc/cron.d/x", { path: "/etc/cron.d/x", content: "* * * * * id" }), context)).toMatchObject({ kind: "deny" });
    // The file body never travels into policy evaluation.
    governance.observe(call("w2", "write"), WC);
    expect(JSON.stringify(governance.decide(ask("w2", "edit", "notes.txt", { path: `${WC}/notes.txt`, content: "a very large body" }), context))).not.toContain("very large body");
  });

  it("judges a subagent's calls exactly as the parent's", () => {
    const { governance } = governed();
    governance.observe(call("c-parent", "subagent"), WC);
    expect(governance.decide(ask("c-parent", "think", "subagent", { agent: "general", prompt: "push it" }), context)).toEqual({ kind: "allow" });
    const child = "ses_child01:call_9";
    governance.observe(call(child, "Push the branch: shell", { "opencode/child-session": { id: "ses_child01", title: "Push the branch" } }), WC);
    governance.observe(input(child, { command: "git push --force" }), WC);
    expect(governance.decide(ask(child, "execute", "Push the branch: git push --force", { command: "git push --force", cwd: WC }), context))
      .toMatchObject({ kind: "evaluate", request: { toolCall: { kind: "execute", rawInput: { command: "git push --force" } } } });
    // Without the metadata the `<title>: <tool>` form is still read.
    const bare = "ses_child02:call_1";
    governance.observe(call(bare, "Fix: tests: write"), WC);
    expect(governance.decide(ask(bare, "edit", "Fix: tests: /etc/x", { path: "/etc/x" }), context)).toMatchObject({ kind: "deny" });
  });

  it("approves a Code Mode block only in the accepted form, for this session's own servers", () => {
    const { code } = governed();
    expect(code("x1", 'return await tools["konteks-result"].submit_result({ answer: "ok" });')).toEqual({ kind: "allow" });
    expect(code("x2", 'const plan = await tools["konteks-platform"].platform__harness__plan_get({ planId: "p-1", deep: [1, -2, true, null] });\nawait tools["konteks-preview"]["preview_start"]();\nreturn JSON.stringify({ plan, status: plan.status });')).toEqual({ kind: "allow" });
    for (const [label, source] of [
      ["OpenCode's own tools", 'await tools.opencode.session_move({ directory: "/" });'],
      ["session_move by bracket", 'await tools["opencode"]["session_move"]({ directory: "/" });'],
      ["another namespace", 'await tools["github"].create_pr({});'],
      ["a server this session lacks", 'await tools["konteks-browser"].browser_navigate({ url: "https://x" });'],
      ["a computed name", 'const n = "submit_result"; await tools["konteks-result"][n]({});'],
      ["a string-built server", 'await tools["konteks-" + "result"].submit_result({});'],
      ["a string-built tool", 'await tools["konteks-result"]["submit" + "_result"]({});'],
      ["a template with a hole", 'const t = "result"; await tools[`konteks-${t}`].submit_result({});'],
      ["a loop", 'for (let i = 0; i < 3; i++) { await tools["konteks-result"].submit_result({ i: 1 }); }'],
      ["a variable argument", 'const a = await tools["konteks-result"].submit_result({}); await tools["konteks-result"].submit_result({ a });'],
      ["a catalogue lookup", 'const r = await tools.search({ query: "x" }); return r;'],
      ["fetch", 'await fetch("https://example.com");'],
      ["an unawaited call", 'tools["konteks-result"].submit_result({});'],
      ["a function", 'async function f() { await tools.opencode.session_move({}); } await tools["konteks-result"].submit_result({});'],
      ["Promise.all", 'await Promise.all([tools["konteks-result"].submit_result({})]);'],
      ["shadowing tools", 'const tools = await tools["konteks-result"].submit_result({});'],
      ["an HTML comment", 'await tools["konteks-result"].submit_result({}) <!-- ; await tools.opencode.session_move({})'],
      ["not JavaScript", 'await tools["konteks-result"].submit_result({'],
      ["nothing", "   "],
    ] as const) {
      expect({ label, verdict: code(`x-${label}`, source) }).toMatchObject({ label, verdict: { kind: "deny", reason: expect.stringContaining("return result;") } });
    }
  });

  it("admits the connector's QA browser through Code Mode only on a session given it, never its hidden tools (O8)", () => {
    const browserContext = { cwd: WC, servers: new Set([...SERVERS, "konteks-browser"]), browserTools: true };
    const governance = new OpenCodeToolGovernance();
    const block = (id: string, source: string, ctx: { cwd: string; servers: ReadonlySet<string>; browserTools?: boolean }) => {
      governance.observe(call(id, "execute"), WC);
      governance.observe(input(id, { code: source }), WC);
      return governance.decide(ask(id, "other", "execute", { code: source }), ctx);
    };
    const navigate = 'const page = await tools["konteks-browser"].browser_navigate({ url: "http://127.0.0.1:43100/" });\nreturn page;';
    expect(block("b1", navigate, browserContext)).toEqual({ kind: "allow" });
    // What ran is what was approved: no trip.
    expect(governance.observe(done("b1", "completed", { metadata: { toolCalls: [{ tool: "konteks-browser.browser_navigate", status: "completed" }] } }), WC)).toBeNull();
    // A session without the browser (its gateway) cannot call it, even if the name is known.
    expect(block("b2", navigate, { ...browserContext, browserTools: false })).toMatchObject({ kind: "deny", reason: "the browser tool browser_navigate is not allowed in this session" });
    expect(block("b3", navigate, context)).toMatchObject({ kind: "deny" });
    // The launcher hides the unsafe and network tools; a block naming one is refused.
    for (const tool of ["browser_run_code_unsafe", "browser_route", "browser_network_state_set"]) {
      expect(block(`b-${tool}`, `await tools["konteks-browser"].${tool}({});`, browserContext)).toMatchObject({ kind: "deny" });
    }
    // OpenCode's own built-in browser stays out (denied in the config), and a call to it trips.
    expect(block("b4", 'await tools.browser.navigate({ url: "https://example.com" });', browserContext)).toMatchObject({ kind: "deny" });
    expect(block("b5", navigate, browserContext)).toEqual({ kind: "allow" });
    expect(governance.observe(done("b5", "completed", { metadata: { toolCalls: [{ tool: "browser.navigate", status: "completed" }] } }), WC)).toMatchObject({ toolCallId: "b5" });
  });

  it("refuses an uncorrelated request, an unknown tool, a kind that does not match, and a .env read", () => {
    const { governance } = governed();
    expect(governance.decide(ask("ghost", "execute", "echo", { command: "echo" }), context)).toEqual({ kind: "deny", reason: "no tool call precedes this permission request" });
    governance.observe(call("k1", "skill"), WC);
    expect(governance.decide(ask("k1", "other", "skill", { name: "x" }), context)).toMatchObject({ kind: "deny" });
    governance.observe(call("k2", "shell"), WC);
    expect(governance.decide(ask("k2", "edit", "x", { files: [{ file: "a" }] }), context)).toMatchObject({ kind: "deny" });
    governance.observe(call("r1", "read"), WC);
    expect(governance.decide(ask("r1", "read", ".env", { filePath: `${WC}/.env` }), context)).toEqual({ kind: "deny", reason: "reading a .env file is not allowed" });
    governance.observe(call("r2", "read"), WC);
    expect(governance.decide(ask("r2", "read", ".env.example", { filePath: `${WC}/.env.example` }), context)).toMatchObject({ kind: "evaluate" });
  });

  it("trips when a gated tool completes without asking, and not for what never asks", () => {
    const { governance, shell } = governed();
    shell("ok", "ls");
    expect(governance.observe(done("ok"), WC)).toBeNull();
    governance.observe(call("rd", "read"), WC);
    governance.observe(input("rd", { filePath: `${WC}/src/a.ts` }), WC);
    expect(governance.observe(done("rd"), WC)).toBeNull();
    governance.observe(call("fl", "shell"), WC);
    expect(governance.observe(done("fl", "failed"), WC)).toBeNull();
    governance.observe(call("by", "shell"), WC);
    governance.observe(input("by", { command: "curl https://example.com" }), WC);
    expect(governance.observe(done("by"), WC)).toEqual({ toolCallId: "by", title: "shell" });
    // A read that reached .env or left the working copy should have asked or been refused.
    governance.observe(call("env", "read"), WC);
    governance.observe(input("env", { filePath: `${WC}/.env` }), WC);
    expect(governance.observe(done("env"), WC)).toEqual({ toolCallId: "env", title: "read" });
    governance.observe(call("out", "read"), WC);
    governance.observe(input("out", { filePath: "/etc/passwd" }), WC);
    expect(governance.observe(done("out"), WC)).toEqual({ toolCallId: "out", title: "read" });
  });

  it("checks what a Code Mode block really called against what was approved", () => {
    const { governance, code } = governed();
    const ran = (...tools: string[]) => ({ metadata: { toolCalls: tools.map(tool => ({ tool, status: "completed" })) } });
    code("a1", 'await tools["konteks-result"].submit_result({ ok: true });');
    expect(governance.observe(done("a1", "completed", ran("konteks-result.submit_result")), WC)).toBeNull();
    // An approved block that ran something else trips.
    code("a2", 'await tools["konteks-result"].submit_result({ ok: true });');
    expect(governance.observe(done("a2", "completed", ran("konteks-result.submit_result", "opencode.session_move")), WC)).toEqual({ toolCallId: "a2", title: "execute: opencode.session_move" });
    // One approved call cannot run twice.
    code("a3", 'await tools["konteks-result"].submit_result({ ok: true });');
    expect(governance.observe(done("a3", "completed", ran("konteks-result.submit_result", "konteks-result.submit_result")), WC)).toMatchObject({ toolCallId: "a3" });
    // A refused block that ran anyway trips, even as a failure.
    code("a4", "await tools.opencode.session_move({});");
    expect(governance.observe(done("a4", "failed", ran("opencode.session_move")), WC)).toMatchObject({ toolCallId: "a4" });
    // In a refused block, the call that asked is listed as an error (declined, 2.0.18): it never ran.
    code("a5", 'for (const i of [1]) { await tools["konteks-result"].submit_result({}); }');
    expect(governance.observe(done("a5", "completed", { metadata: { toolCalls: [{ tool: "konteks-result.submit_result", status: "error" }] } }), WC)).toBeNull();
    // An approved call that answered with an error still ran as approved.
    code("a6", 'await tools["konteks-result"].submit_result({ ok: true });');
    expect(governance.observe(done("a6", "completed", { metadata: { toolCalls: [{ tool: "konteks-result.submit_result", status: "error" }] } }), WC)).toBeNull();
    // A catalogue lookup runs without asking and calls nothing.
    governance.observe(call("s1", "execute"), WC);
    governance.observe(input("s1", { code: 'return await tools.search({ query: "submit" });' }), WC);
    expect(governance.observe(done("s1", "completed", ran("search")), WC)).toBeNull();
    // Code Mode's fetch never asks (2.0.18); a web fetch is allowed for every agent, so it never trips.
    governance.observe(call("f1", "execute"), WC);
    expect(governance.observe(done("f1", "completed", ran("fetch")), WC)).toBeNull();
    code("f2", 'await tools["konteks-result"].submit_result({ ok: true });');
    expect(governance.observe(done("f2", "completed", ran("fetch", "konteks-result.submit_result")), WC)).toBeNull();
    // A block that ran a tool without asking trips.
    governance.observe(call("s2", "execute"), WC);
    expect(governance.observe(done("s2", "completed", ran("konteks-result.submit_result")), WC)).toEqual({ toolCallId: "s2", title: "execute: konteks-result.submit_result" });
  });
});

describe("Code Mode parser", () => {
  it("returns the Konteks calls of a block in the accepted form", () => {
    expect(parseKonteksCodeModeBlock('const a = await tools["konteks-platform"].x({ id: "1" });\nlet b = await tools["konteks-platform"]["y-z"]({});\nawait tools[`konteks-result`].submit_result({ n: -1.5, s: `plain` });\nreturn [a, b.c.d, { a }];', SERVERS))
      .toEqual({ ok: true, calls: [{ server: "konteks-platform", tool: "x" }, { server: "konteks-platform", tool: "y-z" }, { server: "konteks-result", tool: "submit_result" }] });
    expect(parseKonteksCodeModeBlock("return 1;", SERVERS)).toEqual({ ok: false, reason: "the block calls no Konteks tool" });
    expect(parseKonteksCodeModeBlock('await tools["konteks-result"].submit_result({ [k]: 1 });', SERVERS)).toMatchObject({ ok: false });
    expect(parseKonteksCodeModeBlock('await tools["konteks-result"].submit_result({ get x() { return 1; } });', SERVERS)).toMatchObject({ ok: false });
    expect(parseKonteksCodeModeBlock('await tools["konteks-result"].submit_result({ ...x });', SERVERS)).toMatchObject({ ok: false });
    expect(parseKonteksCodeModeBlock('return await tools["konteks-result"].submit_result({});\nawait tools["konteks-result"].submit_result({});', SERVERS)).toMatchObject({ ok: false });
    expect(parseKonteksCodeModeBlock('await tools?.["konteks-result"].submit_result({});', SERVERS)).toMatchObject({ ok: false });
    expect(parseKonteksCodeModeBlock('await tools["konteks-result"].submit_result(/x/);', SERVERS)).toMatchObject({ ok: false });
    expect(parseKonteksCodeModeBlock('import x from "y"; await tools["konteks-result"].submit_result({});', SERVERS)).toMatchObject({ ok: false });
  });
});
