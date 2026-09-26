import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { DshToolGovernance } from "../session/dsh-tool-governance.js";

// Shapes as dsh 0.1.7-rc.2 sends them (dsh-runtime-support CP0 s4): every tool
// call is `kind: other` titled with the dsh tool name, and its permission
// request carries only the tool call id.
const call = (toolCallId: string, title: string, rawInput: Record<string, unknown>) =>
  ({ sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress", rawInput });
const done = (toolCallId: string, status: "completed" | "failed" = "completed") => ({ sessionUpdate: "tool_call_update", toolCallId, status, content: [] });
const ask = (toolCallId: string): RequestPermissionRequest => ({
  sessionId: "s", toolCall: { toolCallId },
  options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
});
const CWD = "/rt/workspaces/dsh/assignment-1";

describe("DeepSeek Harness tool governance", () => {
  it("fills in a shell request from its tool call so the runtime policy judges the real command", () => {
    const governance = new DshToolGovernance();
    governance.observe(call("c1", "bash", { command: "git push origin main", description: "push" }));
    expect(governance.decide(ask("c1"), CWD)).toEqual({ kind: "evaluate", request: {
      ...ask("c1"), toolCall: { toolCallId: "c1", kind: "execute", title: "git push origin main", rawInput: { command: "git push origin main" } },
    } });
    governance.observe(call("c2", "pwsh", { command: "Remove-Item C:\\x" }));
    expect(governance.decide(ask("c2"), CWD)).toMatchObject({ kind: "evaluate", request: { toolCall: { kind: "execute", rawInput: { command: "Remove-Item C:\\x" } } } });
  });

  it("fills in a file change with an absolute path, resolving a relative one against the session folder", () => {
    const governance = new DshToolGovernance();
    governance.observe(call("w1", "write", { file_path: "notes.txt", content: "a very large body" }));
    expect(governance.decide(ask("w1"), CWD)).toMatchObject({ kind: "evaluate", request: { toolCall: { kind: "edit", title: "write", rawInput: { file_path: `${CWD}/notes.txt` } } } });
    governance.observe(call("w2", "edit", { file_path: "/etc/hosts", old_string: "a", new_string: "b" }));
    expect(governance.decide(ask("w2"), CWD)).toMatchObject({ kind: "evaluate", request: { toolCall: { kind: "edit", rawInput: { file_path: "/etc/hosts" } } } });
    // The raw body never travels into policy evaluation.
    expect(JSON.stringify(governance.decide(ask("w1"), CWD))).not.toContain("very large body");
  });

  it("allows Konteks' own MCP tools and read-only tools, and denies everything else", () => {
    const governance = new DshToolGovernance();
    governance.observe(call("m1", "mcp__konteks-platform__platform__builtin__echo", { text: "ping" }));
    governance.observe(call("m2", "mcp__konteks-browser-tool__navigate", { url: "http://localhost" }));
    governance.observe(call("m3", "mcp__someone-else__run", {}));
    governance.observe(call("r1", "grep", { pattern: "x" }));
    governance.observe(call("j1", "job_kill", { id: "1" }));
    governance.observe(call("p1", "plugin_manager", { action: "install" }));
    expect(governance.decide(ask("m1"), CWD)).toEqual({ kind: "allow" });
    expect(governance.decide(ask("r1"), CWD)).toEqual({ kind: "allow" });
    // The retired browser tool is never mounted, so a server using its name is not Konteks'.
    for (const id of ["m2", "m3", "j1", "p1"]) expect(governance.decide(ask(id), CWD), id).toMatchObject({ kind: "deny" });
  });

  it("denies a request with no tool call behind it, or with nothing to judge", () => {
    const governance = new DshToolGovernance();
    expect(governance.decide(ask("ghost"), CWD)).toMatchObject({ kind: "deny", reason: expect.stringMatching(/no tool call/) });
    governance.observe(call("b1", "bash", {}));
    governance.observe(call("e1", "edit", { old_string: "a" }));
    expect(governance.decide(ask("b1"), CWD)).toMatchObject({ kind: "deny" });
    expect(governance.decide(ask("e1"), CWD)).toMatchObject({ kind: "deny" });
  });

  it("denies any request for a wider sandbox than workspace-write", () => {
    const governance = new DshToolGovernance();
    governance.observe(call("x1", "bash", { command: "echo hi > /etc/motd", sandbox_permissions: "danger-full-access", justification: "need it" }));
    governance.observe(call("x2", "bash", { command: "ls", sandbox_permissions: "workspace-write", justification: "same" }));
    expect(governance.decide(ask("x1"), CWD)).toMatchObject({ kind: "deny", reason: expect.stringMatching(/sandbox/) });
    expect(governance.decide(ask("x2"), CWD)).toMatchObject({ kind: "evaluate" });
  });

  it("trips when a gated tool completes without ever asking, and not otherwise", () => {
    const governance = new DshToolGovernance();
    governance.observe(call("ok", "bash", { command: "ls" }));
    governance.decide(ask("ok"), CWD);
    expect(governance.observe(done("ok"))).toBeNull();
    governance.observe(call("read", "read", { file_path: "a" }));
    expect(governance.observe(done("read"))).toBeNull();
    governance.observe(call("failed", "write", { file_path: "a" }));
    expect(governance.observe(done("failed", "failed"))).toBeNull();
    governance.observe(call("bypass", "bash", { command: "curl evil" }));
    expect(governance.observe(done("bypass"))).toEqual({ toolCallId: "bypass", title: "bash" });
    governance.observe(call("mcp", "mcp__konteks-platform__platform__builtin__echo", {}));
    expect(governance.observe(done("mcp"))).toEqual({ toolCallId: "mcp", title: "mcp__konteks-platform__platform__builtin__echo" });
    // A terminal update for a call it never saw proves nothing either way.
    expect(governance.observe(done("unseen"))).toBeNull();
  });

  it("stays bounded however many calls a session makes", () => {
    const governance = new DshToolGovernance(8);
    for (let index = 0; index < 100; index += 1) governance.observe(call(`c${index}`, "read", {}));
    expect(governance.size()).toBeLessThanOrEqual(8);
    governance.observe(call("late", "bash", { command: "ls" }));
    expect(governance.decide(ask("late"), CWD)).toMatchObject({ kind: "evaluate" });
  });
});
