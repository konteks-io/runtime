import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorJournal } from "../state/journal.js";
import { McpToolCallLedger } from "../session/permission-tool-identity.js";
import { NativeCoordinationInvocations } from "../mcp/native-invocations.js";
import { DshToolGovernance } from "../session/dsh-tool-governance.js";
import { dshCoordinationArguments, dshCoordinationCall, dshCoordinationPermission, dshCoordinationResult } from "./fixtures/dsh-acp-coordination.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const tool = "platform__coordination__send";
const args = { target: { kind: "ticket", id: "TKT-2" }, kind: "question", body: "Which interface?" };
const context = { workspaceId: "tenant", assignmentId: "assignment", attempt: 1, acpSessionRef: "acp", operationId: "operation" };
const servers = new Set(["konteks-platform"]);
function permission(toolCallId = "call-1", argumentsValue: unknown = args): RequestPermissionRequest {
  return { sessionId: "acp", toolCall: { toolCallId, rawInput: argumentsValue, _meta: { claudeCode: { toolName: `mcp__konteks-platform__${tool}` } } }, options: [] } as RequestPermissionRequest;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "coordination-invocations-")); directories.push(dir);
  const journal = new SupervisorJournal(dir); await journal.load();
  return { dir, journal, invocations: new NativeCoordinationInvocations(journal, () => context) };
}

describe("trusted native coordination invocation capture", () => {
  it("journals the DSH adapter's committed call and reuses its existing durable replay and terminal ownership", async () => {
    const { dir, invocations } = await fixture();
    const governance = new DshToolGovernance();
    governance.observe(dshCoordinationCall);
    const options = { browserTools: false, servers };
    const request = { ...dshCoordinationPermission, toolCall: { toolCallId: "dsh-call-1", title: "a misleading approval display title", rawInput: { body: "forged" } } } as RequestPermissionRequest;
    const decision = governance.decide(request, "/work", options);
    expect(decision.kind).toBe("allow");
    if (decision.kind !== "allow") throw new Error("fixture DSH call was refused");
    await invocations.capture(request, "dsh", servers, undefined, decision.coordinationInvocation);
    const first = await invocations.resolve(tool, dshCoordinationArguments);
    expect(first).toMatchObject({ ...context, toolCallId: "dsh-call-1", tool });
    await invocations.capture(request, "dsh", servers, undefined, decision.coordinationInvocation);
    const restored = new SupervisorJournal(dir); await restored.load();
    const resumed = new NativeCoordinationInvocations(restored, () => context);
    expect(await resumed.resolve(tool, dshCoordinationArguments)).toEqual(first);
    await expect(resumed.resolve(tool, { body: "forged" })).rejects.toThrow();
    await resumed.observe(dshCoordinationResult);
    await expect(resumed.resolve(tool, dshCoordinationArguments)).rejects.toThrow();
    expect(restored.coordinationInvocations.all()).toHaveLength(1);
  });

  it("persists the provider call identity before forwarding and recovers it without storing message content", async () => {
    const { dir, invocations } = await fixture();
    await invocations.capture(permission(), "claude-code", servers);
    const first = await invocations.resolve(tool, args);
    expect(first).toMatchObject({ version: 1, ...context, toolCallId: "call-1", tool });
    const restored = new SupervisorJournal(dir); await restored.load();
    await expect(new NativeCoordinationInvocations(restored, () => context).resolve(tool, args)).resolves.toEqual(first);
    const disk = await readFile(join(dir, "coordination-invocations.jsonl"), "utf8");
    expect(disk).not.toContain("Which interface?");
    expect(disk).toContain(first.payloadHash);
  });

  it("binds Codex to its announced MCP tool rather than its approval title or transport request ID", async () => {
    const { invocations } = await fixture();
    const ledger = new McpToolCallLedger();
    ledger.observe({ sessionUpdate: "tool_call", toolCallId: "codex-item", rawInput: { server: "konteks-platform", tool, arguments: args }, _meta: { is_mcp_tool_call: true } });
    const request = { sessionId: "acp", toolCall: { toolCallId: "codex-item", title: "Something else" }, options: [], _meta: { is_mcp_tool_approval: true } } as RequestPermissionRequest;
    await invocations.capture(request, "codex", servers, ledger);
    expect((await invocations.resolve(tool, args)).toolCallId).toBe("codex-item");
  });

  it("refuses missing captures, conflicting payloads, ambiguous parallel calls and another operation", async () => {
    const { journal, invocations } = await fixture();
    await expect(invocations.resolve(tool, args)).rejects.toThrow();
    await invocations.capture(permission(), "claude-code", servers);
    await expect(invocations.capture(permission("call-1", { ...args, body: "changed" }), "claude-code", servers)).rejects.toThrow();
    await expect(invocations.resolve(tool, { ...args, body: "changed" })).rejects.toThrow();
    await invocations.capture(permission("call-2"), "claude-code", servers);
    await expect(invocations.resolve(tool, args)).rejects.toThrow();
    await invocations.observe({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
    expect((await invocations.resolve(tool, args)).toolCallId).toBe("call-2");
    await expect(new NativeCoordinationInvocations(journal, () => ({ ...context, operationId: "other" })).resolve(tool, args)).rejects.toThrow();
  });

  it("does not grant identity from an unsupported adapter, a foreign server or a title", async () => {
    const { invocations } = await fixture();
    await invocations.capture(permission(), "opencode", servers);
    await invocations.capture(permission(), "claude-code", new Set(["other-server"]));
    await invocations.capture({ ...permission(), toolCall: { toolCallId: "spoof", title: `mcp__konteks-platform__${tool}`, rawInput: args } } as RequestPermissionRequest, "claude-code", servers);
    await expect(invocations.resolve(tool, args)).rejects.toThrow();
  });
});
