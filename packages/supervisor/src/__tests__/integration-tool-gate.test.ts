import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntegrationTaskSpecSchema, argsDigest, canonicalArgs, type IntegrationTaskSpec } from "@konteks/backstage-plugin-common";
import { SupervisorJournal } from "../state/journal.js";
import { McpToolCallLedger } from "../session/permission-tool-identity.js";
import { IntegrationToolGate, journalWriteLedger } from "../integration/tool-gate.js";

let dir = "";
let journal: SupervisorJournal;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-integration-gate-"));
  journal = new SupervisorJournal(dir);
  await journal.load();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const options = [
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "once", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as RequestPermissionRequest["options"];

/** What the Stage 0 Claude bridge sends: the tool in `_meta.claudeCode.toolName`, the arguments in `rawInput`. */
function claude(toolName: string, rawInput: unknown, toolCallId = "t1", title = toolName): RequestPermissionRequest {
  return { sessionId: "acp-1", toolCall: { toolCallId, kind: "other", title, rawInput, _meta: { claudeCode: { toolName } } }, options } as RequestPermissionRequest;
}

const base = {
  schemaVersion: 1, taskId: "xi-1", agentId: "claude-code",
  binding: { bindingId: "b1", revision: 1, source: { kind: "account_connector", serverName: "claude_ai_Atlassian" } },
  instructions: "Read ENG-42.", resultSchema: { type: "object" },
} as const;
const readSpec = IntegrationTaskSpecSchema.parse({ ...base, phase: "read",
  admittedTools: [{ server: "claude_ai_Atlassian", tool: "getJiraIssue", mode: "read" }],
  limits: { maxToolCalls: 2, maxBytes: 65536, deadlineMs: 60000 } });
const comment = { cloudId: "c1", issueIdOrKey: "ENG-42", commentBody: "Shipped in v1.2" };
const writeSpec = IntegrationTaskSpecSchema.parse({ ...base, phase: "write",
  admittedTools: [{ server: "claude_ai_Atlassian", tool: "addCommentToJiraIssue", mode: "write" }],
  write: { tool: { server: "claude_ai_Atlassian", tool: "addCommentToJiraIssue" }, canonicalArgs: canonicalArgs(comment), argsDigest: argsDigest(comment), actionId: "act-1", attemptId: "att-1", nonce: "nonce-1" },
  limits: { maxToolCalls: 1, maxBytes: 65536, deadlineMs: 60000 } });

function gate(spec: IntegrationTaskSpec, agentId = "claude-code", ledger = new McpToolCallLedger()) {
  return new IntegrationToolGate(spec, { agentId, sessionServers: new Set(["konteks-result"]), ledger, writes: journalWriteLedger(journal), now: () => "2026-10-01T00:00:00.000Z" });
}

describe("IntegrationToolGate: reads", () => {
  it("allows an admitted read once, by structured identity, never always", async () => {
    const g = gate(readSpec);
    expect(await g.evaluate(claude("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "ENG-42" }))).toMatchObject({ kind: "allow", optionId: "once" });
    expect(g.records()).toEqual([{ server: "claude_ai_Atlassian", tool: "getJiraIssue", argsDigest: argsDigest({ issueIdOrKey: "ENG-42" }), status: "allowed", outcome: "unknown" }]);
  });

  it("denies shell, edit, browser, other servers and unadmitted tools without asking anyone", async () => {
    const g = gate(readSpec);
    for (const request of [
      claude("Bash", { command: "curl https://example.atlassian.net" }),
      claude("Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b" }),
      claude("mcp__konteks-browser__browser_navigate", { url: "https://example.atlassian.net" }),
      claude("mcp__claude_ai_Slack__slack_send_message", { channel: "C1", text: "hi" }),
      claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment),
      // A spoofed title never grants: the structured identity is a shell call.
      claude("Bash", { command: "rm -rf /" }, "t9", "mcp__claude_ai_Atlassian__getJiraIssue"),
    ]) {
      expect(await g.evaluate(request)).toMatchObject({ kind: "deny", optionId: "reject" });
    }
    // An MCP request with no structured identity is never guessed.
    expect(await g.evaluate({ sessionId: "acp-1", toolCall: { toolCallId: "u", title: "mcp__claude_ai_Atlassian__getJiraIssue" }, options } as RequestPermissionRequest)).toMatchObject({ kind: "deny" });
    expect(g.records().every(record => record.status === "denied" && record.outcome === "not_run")).toBe(true);
  });

  it("lets the agent hand in its result through the result tool, which is no provider call", async () => {
    const g = gate(readSpec);
    expect(await g.evaluate(claude("mcp__konteks-result__submit_result", { summary: "x" }))).toMatchObject({ kind: "allow", optionId: "once" });
    expect(g.records()).toEqual([]);
  });

  it("enforces the tool-call limit and treats a repeated callback for one call as the same grant", async () => {
    const g = gate(readSpec);
    const read = (id: string) => claude("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: id }, id);
    expect((await g.evaluate(read("a"))).kind).toBe("allow");
    expect((await g.evaluate(read("a"))).kind).toBe("allow");
    expect((await g.evaluate(read("b"))).kind).toBe("allow");
    expect(await g.evaluate(read("c"))).toMatchObject({ kind: "deny", reason: "limit" });
    expect(g.records().filter(record => record.status === "allowed")).toHaveLength(2);
  });

  it("refuses when the agent offers no one-time allow", async () => {
    const g = gate(readSpec);
    const request = claude("mcp__claude_ai_Atlassian__getJiraIssue", {});
    expect(await g.evaluate({ ...request, options: options.filter(option => option.kind !== "allow_once") })).toMatchObject({ kind: "deny" });
  });

  it("reads a Codex MCP approval's identity and arguments from the call Codex announced", async () => {
    const spec = IntegrationTaskSpecSchema.parse({ ...readSpec, agentId: "codex", binding: { ...readSpec.binding, source: { kind: "agent_mcp", serverName: "atlassian" } },
      admittedTools: [{ server: "atlassian", tool: "getJiraIssue", mode: "read" }] });
    const ledger = new McpToolCallLedger();
    const g = gate(spec, "codex", ledger);
    const approval = { sessionId: "acp-1", toolCall: { toolCallId: "item-1", kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true }, options } as unknown as RequestPermissionRequest;
    expect(await g.evaluate(approval)).toMatchObject({ kind: "deny" });
    ledger.observe({ sessionUpdate: "tool_call", toolCallId: "item-1", status: "pending", _meta: { is_mcp_tool_call: true }, rawInput: { server: "atlassian", tool: "getJiraIssue", arguments: { issueIdOrKey: "ENG-42" } } });
    expect(await g.evaluate(approval)).toMatchObject({ kind: "allow", optionId: "once" });
    expect(g.records()).toEqual([expect.objectContaining({ server: "atlassian", tool: "getJiraIssue", argsDigest: argsDigest({ issueIdOrKey: "ENG-42" }), status: "allowed" })]);
  });
});

describe("IntegrationToolGate: the one approved write", () => {
  it("allows exactly the approved arguments, once per nonce, durably", async () => {
    const g = gate(writeSpec);
    const reordered = { commentBody: "Shipped in v1.2", issueIdOrKey: "ENG-42", cloudId: "c1" };
    expect(await g.evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", { ...comment, commentBody: "Shipped in v1.3" }, "w0"))).toMatchObject({ kind: "deny", reason: "args_mismatch" });
    expect(await g.evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", reordered, "w1"))).toMatchObject({ kind: "allow", optionId: "once" });
    expect(journal.integrationWrites.get("nonce-1")).toMatchObject({ nonce: "nonce-1", toolCallId: "w1", actionId: "act-1", attemptId: "att-1", argsDigest: argsDigest(comment), taskId: "xi-1" });
    // The same call asking again is the same grant; a new call id never reuses it.
    expect((await g.evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment, "w1"))).kind).toBe("allow");
    expect(await g.evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment, "w2"))).toMatchObject({ kind: "deny" });
    expect(await g.evaluate(claude("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "ENG-42" }, "r1"))).toMatchObject({ kind: "deny" });
  });

  it("refuses a consumed nonce after a restart, and a write with missing arguments", async () => {
    await gate(writeSpec).evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment, "w1"));
    const reloaded = new SupervisorJournal(dir);
    await reloaded.load();
    const after = new IntegrationToolGate(writeSpec, { agentId: "claude-code", sessionServers: new Set(["konteks-result"]), ledger: new McpToolCallLedger(), writes: journalWriteLedger(reloaded), now: () => "2026-10-01T00:00:01.000Z" });
    expect(await after.evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment, "w-new"))).toMatchObject({ kind: "deny", reason: "nonce_consumed" });
    const fresh = IntegrationTaskSpecSchema.parse({ ...writeSpec, write: { ...writeSpec.write!, nonce: "nonce-2" } });
    expect(await gate(fresh).evaluate(claude("mcp__claude_ai_Atlassian__addCommentToJiraIssue", undefined, "w3"))).toMatchObject({ kind: "deny" });
  });
});
