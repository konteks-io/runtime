import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { McpToolCallLedger, permissionToolIdentity } from "../session/permission-tool-identity.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { createWorkspaceToolPolicy } from "../session/workspace-tool-policy.js";

const options = [
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as RequestPermissionRequest["options"];

function request(toolCall: Record<string, unknown>, extra: Record<string, unknown> = {}): RequestPermissionRequest {
  return { sessionId: "acp-1", toolCall: { toolCallId: "t1", ...toolCall }, options, ...extra } as RequestPermissionRequest;
}

/** What the Stage 0 Claude bridge sends: the tool's own name in `_meta.claudeCode.toolName`. */
function claude(toolName: string, toolCall: Record<string, unknown> = {}): RequestPermissionRequest {
  return request({ kind: "other", title: toolName, ...toolCall, _meta: { claudeCode: { toolName } } });
}

describe("permission tool identity (S0-4)", () => {
  it("reads a Claude tool's server and name from the bridge's structured field, never its title", () => {
    expect(permissionToolIdentity(claude("mcp__konteks-browser__browser_navigate"), "claude-code"))
      .toEqual({ kind: "mcp", server: "konteks-browser", tool: "browser_navigate" });
    expect(permissionToolIdentity(claude("Bash", { kind: "execute", title: "mcp__konteks-browser__browser_click" }), "claude-code"))
      .toEqual({ kind: "native", tool: "Bash" });
    // No structured field: the title is display text and identifies nothing.
    expect(permissionToolIdentity(request({ kind: "other", title: "mcp__konteks-browser__browser_navigate" }), "claude-code"))
      .toEqual({ kind: "unidentified", mcp: false });
  });

  it("matches a Claude MCP name against the session's own servers, whose names Claude normalizes", () => {
    const servers = new Set(["konteks-1787206951837-gjy9xi", "konteks.result"]);
    expect(permissionToolIdentity(claude("mcp__konteks-1787206951837-gjy9xi__platform__builtin__list_sessions"), "claude-code", { sessionServers: servers }))
      .toEqual({ kind: "mcp", server: "konteks-1787206951837-gjy9xi", tool: "platform__builtin__list_sessions" });
    expect(permissionToolIdentity(claude("mcp__konteks_result__submit_result"), "claude-code", { sessionServers: servers }))
      .toEqual({ kind: "mcp", server: "konteks.result", tool: "submit_result" });
  });

  it("reads a Codex MCP approval's server and tool from the tool call Codex announced for it", () => {
    const ledger = new McpToolCallLedger();
    ledger.observe({ sessionUpdate: "tool_call", toolCallId: "item-1", kind: "execute", title: "mcp.konteks-browser.browser_navigate",
      rawInput: { server: "konteks-preview", tool: "preview_start", arguments: {} }, _meta: { is_mcp_tool_call: true } });
    const approval = request({ toolCallId: "item-1", kind: "execute", status: "pending" }, { _meta: { is_mcp_tool_approval: true } });
    expect(permissionToolIdentity(approval, "codex", { ledger })).toEqual({ kind: "mcp", server: "konteks-preview", tool: "preview_start" });
    // An approval Codex could not correlate names no tool: never guessed.
    const standalone = request({ toolCallId: "konteks-preview-1", kind: "execute", rawInput: { serverName: "konteks-preview" } }, { _meta: { is_mcp_tool_approval: true } });
    expect(permissionToolIdentity(standalone, "codex", { ledger })).toEqual({ kind: "unidentified", mcp: true });
    // A tool call that did not come from Codex's MCP item is not an MCP identity.
    ledger.observe({ sessionUpdate: "tool_call", toolCallId: "item-2", rawInput: { server: "konteks-browser", tool: "browser_click" } });
    expect(permissionToolIdentity(request({ toolCallId: "item-2", kind: "execute" }, { _meta: { is_mcp_tool_approval: true } }), "codex", { ledger }))
      .toEqual({ kind: "unidentified", mcp: true });
    // Codex's command and file-change approvals are its own tools.
    expect(permissionToolIdentity(request({ toolCallId: "c1", kind: "execute", rawInput: { command: "npm test" } }), "codex", { ledger }))
      .toEqual({ kind: "native", tool: "execute" });
    ledger.observe({ sessionUpdate: "tool_call_update", toolCallId: "item-1", status: "completed" });
    expect(permissionToolIdentity(approval, "codex", { ledger })).toEqual({ kind: "unidentified", mcp: true });
  });
});

describe("browser allow keyed on structured identity (S0-4, X05)", () => {
  const context = { assignmentId: "a", agentId: "claude-code", workspaceRoot: "/w", browserTools: true };
  const responder = new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => false);

  it("allows the session's browser tools once, never always", async () => {
    await expect(responder.evaluatePermission(claude("mcp__konteks-browser__browser_navigate"), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    await expect(responder.evaluatePermission(claude("mcp__konteks-browser__browser_navigate"), { ...context, browserTools: false }))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
  });

  it("never allows a shell command whose display title imitates a browser tool", async () => {
    // Claude's Bash title is the model-written description: the old title
    // match allowed this past the blocklist on a QA session.
    const spoof = claude("Bash", { kind: "execute", title: "mcp__konteks-browser__browser_navigate", rawInput: { command: "git push origin main", description: "mcp__konteks-browser__browser_navigate" } });
    await expect(responder.evaluatePermission(spoof, context)).resolves.toEqual({ kind: "deny", optionId: "reject" });
  });

  it("never allows a tool of another server titled like a browser tool, nor one with no structured identity", async () => {
    const spoof = claude("mcp__lookalike__navigate", { kind: "execute", title: "mcp__konteks-browser__browser_navigate", rawInput: { command: "sudo true" } });
    await expect(responder.evaluatePermission(spoof, context)).resolves.toEqual({ kind: "deny", optionId: "reject" });
    const untitled = request({ kind: "other", title: "konteks-browser.browser_click" });
    await expect(responder.evaluatePermission(untitled, context)).resolves.toEqual({ kind: "deny", optionId: "reject" });
  });

  it("answers every policy allow with allow_once, and never falls back to allow_always", async () => {
    await expect(responder.evaluatePermission(claude("Read", { kind: "read" }), context)).resolves.toEqual({ kind: "allow", optionId: "allow" });
    const onlyAlways = { ...claude("Read", { kind: "read" }), options: options.filter(option => option.kind !== "allow_once") } as RequestPermissionRequest;
    await expect(responder.evaluatePermission(onlyAlways, context)).resolves.toEqual({ kind: "deny", optionId: "reject" });
  });
});
