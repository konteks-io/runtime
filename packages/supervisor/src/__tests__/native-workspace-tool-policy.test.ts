import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { blockedCommandPattern, createWorkspaceToolPolicy, isWithinWorkspace } from "../session/workspace-tool-policy.js";

const options = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as RequestPermissionRequest["options"];

function request(toolCall: Record<string, unknown>): RequestPermissionRequest {
  return { sessionId: "acp-1", toolCall: { toolCallId: "t1", ...toolCall }, options } as RequestPermissionRequest;
}

describe("native workspace tool policy", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-policy-"));
  mkdirSync(join(root, "src"));
  const context = { assignmentId: "a", agentId: "claude-code", workspaceRoot: root };
  const responder = new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true);

  it("answers ordinary tool calls by policy instead of deferring them to a human", async () => {
    await expect(responder.evaluatePermission(request({ kind: "other", title: "mcp__konteks-platform__prd_submit" }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    await expect(responder.evaluatePermission(request({ kind: "execute", title: "npm test", rawInput: { command: "npm test" } }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    await expect(responder.evaluatePermission(request({ kind: "edit", title: "Write", rawInput: { file_path: join(root, "src", "a.ts") } }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
  });

  it("denies blocklisted commands, including a shell call judged by its title", async () => {
    await expect(responder.evaluatePermission(request({ kind: "execute", rawInput: { command: "git push origin main" } }), context))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    await expect(responder.evaluatePermission(request({ kind: "execute", title: "sudo rm -rf x" }), context))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    expect(blockedCommandPattern("git branch --show-current", ["nc "])).toBeNull();
  });

  it("denies file changes outside the workspace, through locations or a symlink", async () => {
    await expect(responder.evaluatePermission(request({ kind: "edit", rawInput: { file_path: "/etc/hosts" } }), context))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    await expect(responder.evaluatePermission(request({ kind: "delete", locations: [{ path: join(root, "..", "x") }] }), context))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    symlinkSync(tmpdir(), join(root, "escape"));
    expect(isWithinWorkspace(join(root, "escape", "file.txt"), root)).toBe(false);
    expect(isWithinWorkspace("src/new-file.ts", root)).toBe(true);
  });
});
