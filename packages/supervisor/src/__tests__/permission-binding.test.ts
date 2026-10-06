import { describe, expect, it } from "vitest";
import { sanitizePermissionRequest, deferredPermissionBody, registerDeferral } from "../session/permissions.js";
import { DshToolGovernance } from "../session/dsh-tool-governance.js";
const request = (command: string) => ({ sessionId: "session", toolCall: { toolCallId: "tool", kind: "execute", title: "Run", rawInput: { command } }, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" as const }] });
const body = (sanitized: ReturnType<typeof sanitizePermissionRequest>) => deferredPermissionBody({ sessionId: "session", assignmentId: "assignment", attempt: 1, agentId: "dsh", requestId: "request", sanitized });
describe("exact permission content binding", () => {
  it("binds full arguments and cwd independently of the display title", () => {
    const a = sanitizePermissionRequest(request("echo a"), { cwd: "/work/a" });
    const b = sanitizePermissionRequest(request("echo b"), { cwd: "/work/a" });
    const c = sanitizePermissionRequest(request("echo a"), { cwd: "/work/b" });
    expect(a.params.toolCallBinding).toMatchObject({ toolCallId: "tool", contentDigest: expect.any(String) });
    expect(a.params.toolCallBinding).not.toEqual(b.params.toolCallBinding);
    expect(a.params.toolCallBinding).not.toEqual(c.params.toolCallBinding);
    expect(JSON.stringify(body(a))).not.toContain("echo a");
    expect(JSON.stringify(body(a))).not.toContain("/work/a");
    expect(body(a)).toMatchObject({ permission: { toolCallBinding: a.params.toolCallBinding } });
  });
  it("binds DeepSeek original input even when policy keeps only an edit path", () => {
    const governance = new DshToolGovernance();
    const bind = (content: string) => {
      governance.observe({ sessionUpdate: "tool_call", toolCallId: "tool", title: "write", rawInput: { file_path: "a", content } });
      return sanitizePermissionRequest(request("same policy projection"), { cwd: "/work", observedInput: governance.bindingInput("tool") });
    };
    expect(bind("first").params.toolCallBinding).not.toEqual(bind("second").params.toolCallBinding);
  });
  it("keeps the old wire unchanged unless exact binding is enabled", () => {
    expect(sanitizePermissionRequest(request("echo a")).params).not.toHaveProperty("toolCallBinding");
  });
  it("fails closed when Core drops or changes the requested binding", async () => {
    const wire = body(sanitizePermissionRequest(request("echo a"), { cwd: "/work" }));
    if (wire.kind !== "permission") throw new Error("wrong kind");
    const view = { ...wire, pendingRef: "pending", requestDigest: "A".repeat(43), raisedAt: "2026-10-06T00:00:00Z", deadlineAt: "2026-10-06T00:01:00Z" };
    expect(await registerDeferral(async () => view as never, wire)).toEqual(view);
    const { toolCallBinding: _binding, ...permission } = wire.permission;
    expect(await registerDeferral(async () => ({ ...view, permission }) as never, wire)).toBeNull();
    expect(await registerDeferral(async () => ({ ...view, permission: { ...permission, toolCallBinding: { toolCallId: "other", contentDigest: "B".repeat(43) } } }) as never, wire)).toBeNull();
  });
});
