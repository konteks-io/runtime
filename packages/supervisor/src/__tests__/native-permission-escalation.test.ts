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

function claudeRequest(toolName: string, command: string) {
  return {
    sessionId: "acp-1",
    options: claudeOptions,
    toolCall: { toolCallId: "tool-1", title: "Size of memory files", kind: "execute", locations: [{ path: "/tmp/outside.txt" }],
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
    expect(sanitizePermissionRequest(request as never).params.title).toBe(title);
  });

  it("removes control and directional characters before the cut, so the card keeps the whole bounded title", () => {
    const command = `echo \u202Ehidden ${"b".repeat(400)}`;
    const title = deferredTitle(nativePermissionEscalation(
      claudeRequest("Bash", command) as never, claudeContext as never, { kind: "native", tool: "Bash" } as never, () => true));
    expect(title).not.toContain("\u202E");
    expect(title).toContain("echo hidden b");
    const request = { ...claudeRequest("Bash", command), toolCall: { ...claudeRequest("Bash", command).toolCall, title } };
    expect(sanitizePermissionRequest(request as never).params.title).toBe(title);
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
    expect(decide([`${contextRoot}/memory/conversation.md`, "/tmp/outside.txt"])).toMatchObject({ kind: "defer" });
    expect(decide([`${skillRoot}/scripts/run.sh`])).toMatchObject({ kind: "defer" });
    expect(decide(["/work/session/src/a.ts"])).toMatchObject({ kind: "defer" });
    expect(decide([`${contextRoot}/memory/conversation.md`], { ...context, sessionContextRoot: undefined })).toMatchObject({ kind: "defer" });
  });
});
