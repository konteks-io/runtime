import { describe, expect, it } from "vitest";
import { SECRET_CANARIES } from "@konteks/remote-common";
import { nativePermissionEscalation } from "../session/native-permission-escalation.js";
import { sanitizePermissionRequest } from "../session/permissions.js";

const claudeOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
const codexOptions = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "decline", name: "Decline", kind: "reject_once" },
];
const claudeContext = { assignmentId: "a", agentId: "claude-code", cwd: "/work/session", workspaceRoot: "/work/session", readOnlyRoots: [] };
const codexContext = { assignmentId: "a", agentId: "codex", cwd: "/work/session", workspaceRoot: "/work/session", readOnlyRoots: [] };

function claudeRequest(toolName: string, command: string, locations = [{ path: "/tmp/outside.txt" }]) {
  return {
    sessionId: "acp-1",
    options: claudeOptions,
    toolCall: { toolCallId: "tool-1", title: "Size of memory files", kind: "execute", locations,
      rawInput: { command }, _meta: { claudeCode: { toolName } } },
  };
}

function codexRequest(command: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "acp-1",
    options: codexOptions,
    toolCall: { toolCallId: "tool-1", title: "Run command", kind: "execute", locations: [{ path: "/tmp/outside.txt" }],
      rawInput: { command, ...extra } },
  };
}

function deferredTitle(decision: unknown): string {
  expect(decision).toMatchObject({ kind: "defer" });
  return (decision as { title: string }).title;
}

describe("a native escalation the person reads on the card", () => {
  it("says in plain words that the command reaches outside the session's folder", () => {
    // 10-09: the card read "Command outside normal session authority: …".
    const request = {
      sessionId: "acp-1",
      toolCall: { toolCallId: "tool-1", title: "Check if target file already exists", kind: "execute", locations: [{ path: "/tmp/tally-result.txt" }] },
      options: claudeOptions,
    };
    const decision = nativePermissionEscalation(request as never,
      claudeContext as never,
      { kind: "native", tool: "Bash" } as never, () => true);
    expect(decision).toMatchObject({ kind: "defer", title: "Outside this session's folder: Check if target file already exists" });
  });

  it.each([
    ["Outside this session's folder", () => nativePermissionEscalation(
      claudeRequest("Bash", "c".repeat(400)) as never, claudeContext as never, { kind: "native", tool: "Bash" } as never, () => true)],
    ["Wants to run a shell command", () => nativePermissionEscalation(
      claudeRequest("Bash", "c".repeat(400), [{ path: "/work/session/src/a.ts" }]) as never, claudeContext as never,
      { kind: "native", tool: "Bash" } as never, () => true)],
    ["Needs the network", () => nativePermissionEscalation(
      claudeRequest("SandboxNetworkAccess", "c".repeat(400)) as never, claudeContext as never,
      { kind: "native", tool: "SandboxNetworkAccess" } as never, () => true)],
    ["Needs more access", () => nativePermissionEscalation(
      codexRequest("c".repeat(400), { additionalPermissions: { network: {} } }) as never, codexContext as never,
      { kind: "native", tool: "execute" } as never, () => true)],
  ])("keeps the %s prefix whole and leaves the command its room", (prefix, decide) => {
    const title = deferredTitle(decide());
    const command = title.slice(`${prefix}: `.length);
    expect(title.startsWith(`${prefix}: `)).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect([...title]).toHaveLength(256);
    expect([...command].length).toBeGreaterThanOrEqual(225);
  });

  it("redacts a credential before the cut, so a secret straddling the boundary never appears in part", () => {
    const command = `${"a".repeat(220)}${SECRET_CANARIES.anthropicKey} tail`;
    const title = deferredTitle(nativePermissionEscalation(
      claudeRequest("Bash", command) as never, claudeContext as never, { kind: "native", tool: "Bash" } as never, () => true));
    expect(title.endsWith("…")).toBe(true);
    expect(title).toContain("[red");
    expect(title).not.toContain("sk-");
    expect(title).not.toContain(SECRET_CANARIES.anthropicKey.slice(0, 12));
  });

  it("stays within the card's code-point and UTF-16 limits and survives its sanitizer", () => {
    const command = "😀".repeat(400);
    const title = deferredTitle(nativePermissionEscalation(
      claudeRequest("Bash", command) as never, claudeContext as never, { kind: "native", tool: "Bash" } as never, () => true));
    expect([...title].length).toBeLessThanOrEqual(256);
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title.endsWith("…")).toBe(true);
    const request = { ...claudeRequest("Bash", command), toolCall: { ...claudeRequest("Bash", command).toolCall, title } };
    expect(sanitizePermissionRequest(request as never, false).params.title).toBe(title);
  });

  it("removes control and directional characters before the cut, so the card keeps the whole bounded title", () => {
    const command = `echo \u202Ehidden ${"b".repeat(400)}`;
    const title = deferredTitle(nativePermissionEscalation(
      claudeRequest("Bash", command) as never, claudeContext as never, { kind: "native", tool: "Bash" } as never, () => true));
    expect(title).not.toContain("\u202E");
    expect(title).toContain("echo hidden b");
    const request = { ...claudeRequest("Bash", command), toolCall: { ...claudeRequest("Bash", command).toolCall, title } };
    expect(sanitizePermissionRequest(request as never, false).params.title).toBe(title);
  });
});

describe("a planning estimate's Claude shell call", () => {
  const contextRoot = "/work/session-context/session-1/source";
  const skillRoot = "/work/skills/org-1";
  const planning = { ...claudeContext, assignmentKind: "planning", readOnlyRoots: [skillRoot, contextRoot], sessionContextRoot: contextRoot };
  const decide = (paths: string[], ctx: object = planning, canDefer = true) => nativePermissionEscalation({
    sessionId: "acp-1", options: claudeOptions,
    toolCall: { toolCallId: "tool-1", title: "Size of memory files", kind: "execute", locations: paths.map(path => ({ path })),
      rawInput: { command: "wc -l memory/conversation.md" }, _meta: { claudeCode: { toolName: "Bash" } } },
  } as never, ctx as never, { kind: "native", tool: "Bash" } as never, () => canDefer);

  it("is refused at once when it reaches a sibling session's context folder, and asks no person", () => {
    expect(decide(["/work/session-context/session-2/source/memory/conversation.md"])).toEqual({
      kind: "deny", optionId: "reject", refusal: { reason: "planning_outside_shell" },
      message: expect.stringMatching(/^Konteks refused this shell command: .*Read tool/),
    });
  });

  it("is refused at once when it reaches the operator's own Claude memory, and asks no person", () => {
    expect(decide(["/home/operator/.claude/projects/-work/memory/MEMORY.md"])).toEqual({
      kind: "deny", optionId: "reject", refusal: { reason: "planning_outside_shell" },
      message: expect.stringMatching(/^Konteks refused this shell command: .*Read tool/),
    });
  });

  it("is refused at once when it reaches a staged organization skill folder too", () => {
    expect(decide([`${skillRoot}/scripts/run.sh`])).toEqual({
      kind: "deny", optionId: "reject", refusal: { reason: "planning_outside_shell" },
      message: expect.stringMatching(/^Konteks refused this shell command: .*Read tool/),
    });
  });

  it("keeps the current deferral on a delivery assignment", () => {
    expect(decide(["/home/operator/.claude/projects/-work/memory/MEMORY.md"], { ...planning, assignmentKind: "delivery" }))
      .toMatchObject({ kind: "defer", allowOnceOnly: true, optionIds: ["allow-once", "reject"],
        title: "Outside this session's folder: wc -l memory/conversation.md" });
  });

  it("still names a context-only call as the session context read", () => {
    expect(decide([`${contextRoot}/memory/conversation.md`])).toMatchObject({
      kind: "deny", refusal: { reason: "session_context_shell" },
    });
  });

  it("keeps its deferral when every flagged path is inside the working copy", () => {
    expect(decide(["/work/session/src/a.ts"])).toMatchObject({
      kind: "defer", title: "Wants to run a shell command: wc -l memory/conversation.md",
    });
  });
});

describe("a Claude shell command that reaches only into the session context folder", () => {
  const contextRoot = "/work/session-context/session-1/source";
  const skillRoot = "/work/skills/org-1";
  const context = { ...claudeContext, readOnlyRoots: [skillRoot, contextRoot], sessionContextRoot: contextRoot };
  const decide = (paths: string[], ctx: object = context, canDefer = true) => nativePermissionEscalation({
    sessionId: "acp-1", options: claudeOptions,
    toolCall: { toolCallId: "tool-1", title: "Check context file sizes", kind: "execute", locations: paths.map(path => ({ path })),
      rawInput: { command: "wc -l memory/conversation.md" }, _meta: { claudeCode: { toolName: "Bash" } } },
  } as never, ctx as never, { kind: "native", tool: "Bash" } as never, () => canDefer);

  it("is refused at once with the Read tool named, never put to a person", () => {
    for (const paths of [[`${contextRoot}/memory/conversation.md`], [`${contextRoot}/memory`, "/work/session/notes.md"]]) {
      expect(decide(paths)).toEqual({ kind: "deny", optionId: "reject", refusal: { reason: "session_context_shell" },
        message: expect.stringMatching(/^Konteks refused this shell command: .*Read tool/) });
    }
  });

  it("still asks a person for anything beyond it: other folders, skill folders, or no known context folder", () => {
    expect(decide([`${contextRoot}/memory/conversation.md`, "/tmp/outside.txt"]))
      .toMatchObject({ kind: "defer", title: "Outside this session's folder: wc -l memory/conversation.md" });
    expect(decide([`${skillRoot}/scripts/run.sh`]))
      .toMatchObject({ kind: "defer", title: "Wants to run a shell command: wc -l memory/conversation.md" });
    expect(decide(["/work/session/src/a.ts"])).toMatchObject({ kind: "defer", allowOnceOnly: true, optionIds: ["allow-once", "reject"],
      title: "Wants to run a shell command: wc -l memory/conversation.md" });
    expect(decide([`${contextRoot}/memory/conversation.md`], { ...context, sessionContextRoot: undefined }))
      .toMatchObject({ kind: "defer", title: "Wants to run a shell command: wc -l memory/conversation.md" });
  });

  it("never reads a sibling session folder or the session-context parent as this session's context", () => {
    const parent = "/work/session-context";
    const sibling = `${parent}/session-2/source/memory/conversation.md`;
    for (const path of [sibling, parent]) {
      // Not context reads: no automatic allow, and never a Read-tool refusal.
      expect(decide([path])).toMatchObject({ kind: "defer", allowOnceOnly: true, optionIds: ["allow-once", "reject"] });
      // Even a broken caller that names the parent as the context root gets no allow.
      expect(decide([path], { ...context, sessionContextRoot: parent, readOnlyRoots: [parent] }))
        .toMatchObject({ kind: "defer", allowOnceOnly: true, optionIds: ["allow-once", "reject"] });
    }
    const home = "/home/operator/.claude/projects/-work/memory/MEMORY.md";
    expect(decide([home])).toMatchObject({ kind: "defer", allowOnceOnly: true, optionIds: ["allow-once", "reject"] });
  });
});
