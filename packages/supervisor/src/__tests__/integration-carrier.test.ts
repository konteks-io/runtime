import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationTaskResultSchema,
  IntegrationTaskSpecSchema,
  REMOTE_INTEGRATION_TASK_CAPABILITY,
  argsDigest,
  canonicalArgs,
  integrationWorkloadDigest,
  sha256Hex,
  type IntegrationTaskResult,
  type IntegrationTaskSpec,
} from "@konteks/backstage-plugin-common";
import { RemoteWorkAssignmentSchema, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import { SupervisorJournal } from "../state/journal.js";
import type { RunnerPort, RunnerSessionInput } from "../runner-port.js";
import { IntegrationTaskCarrier, integrationFixturesEnabled, type IntegrationWorkAssignment } from "../integration/carrier.js";
import { journalWriteLedger } from "../integration/tool-gate.js";

let dir = "";
let workspace = "";
let journal: SupervisorJournal;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-integration-carrier-"));
  workspace = join(dir, "work");
  await (await import("node:fs/promises")).mkdir(workspace);
  await (await import("node:fs/promises")).mkdir(join(dir, "journal"));
  journal = new SupervisorJournal(join(dir, "journal"));
  await journal.load();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const options = [
  { optionId: "always", name: "Always", kind: "allow_always" },
  { optionId: "once", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as RequestPermissionRequest["options"];

interface AgentContext {
  /** Ask permission; resolves with the connector's answer. */
  ask(request: Omit<RequestPermissionRequest, "sessionId" | "options">): Promise<unknown>;
  update(update: Record<string, unknown>): Promise<void>;
  submit(value: unknown): Promise<unknown>;
  end(): Promise<void>;
}

/** A scripted agent behind the RunnerPort the carrier drives. */
class FakeAgent {
  input: RunnerSessionInput | null = null;
  promptText = "";
  readonly answers = new Map<string, (response: unknown) => void>();
  readonly cancelled = vi.fn();
  readonly closed = vi.fn();
  sink: (event: RunnerEvent) => Promise<void> = async () => undefined;
  private promptId = "";
  private counter = 0;
  readonly ref = "acp-int-1";

  constructor(private readonly script: (agent: AgentContext) => Promise<void>) {}

  port(agentId: string): RunnerPort {
    return {
      agentId,
      createSession: async (input: RunnerSessionInput) => { this.input = input; return { acpSessionRef: this.ref, resumed: false, capabilities: { forkSession: false, sessionResume: false } }; },
      prompt: async (_ref: string, id: string, params: unknown) => {
        this.promptId = id;
        this.promptText = ((params as { prompt: Array<{ text: string }> }).prompt[0]!.text);
        // A script that keeps going after the connector ended the session just stops.
        void this.script(this.context()).catch(() => undefined);
      },
      answer: async (_ref: string, id: string, response: unknown) => { this.answers.get(id)?.(response); return { delivered: true }; },
      cancel: async () => { this.cancelled(); },
      closeSession: async () => { this.closed(); },
    } as unknown as RunnerPort;
  }

  private context(): AgentContext {
    return {
      ask: async request => {
        const requestId = `perm-${++this.counter}`;
        const answered = new Promise<unknown>(resolve => this.answers.set(requestId, resolve));
        await this.sink({ kind: "permission_request", acpSessionRef: this.ref, requestId, params: { sessionId: this.ref, options, ...request } });
        return answered;
      },
      update: async update => { await this.sink({ kind: "session_update", acpSessionRef: this.ref, params: { sessionId: this.ref, update } }); },
      submit: async value => {
        const server = this.input!.mcpServers.find(entry => entry.name === "konteks-result")!;
        const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", [server.headers[0]!.name]: server.headers[0]!.value },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_result", arguments: value } }) });
        return response.json();
      },
      end: async () => { await this.sink({ kind: "prompt_result", acpSessionRef: this.ref, requestId: this.promptId, result: { stopReason: "end_turn" } }); },
    };
  }
}

const claudeTool = (toolCallId: string, toolName: string, rawInput: unknown) => ({ toolCall: { toolCallId, kind: "other", title: toolName, rawInput, _meta: { claudeCode: { toolName } } } });
const claudeDone = (toolCallId: string, toolName: string, rawOutput: unknown) => ({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput, _meta: { claudeCode: { toolName } } });
const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

const claudeBinding = { bindingId: "b1", revision: 1, source: { kind: "account_connector", serverName: "claude_ai_Atlassian" } } as const;
function spec(overrides: Record<string, unknown> = {}): IntegrationTaskSpec {
  return IntegrationTaskSpecSchema.parse({
    schemaVersion: 1, taskId: "xi-task-1", phase: "read", agentId: "claude-code", binding: claudeBinding,
    admittedTools: [{ server: "claude_ai_Atlassian", tool: "getJiraIssue", mode: "read" }],
    instructions: "Read ENG-42 and summarize it.", resultSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    limits: { maxToolCalls: 4, maxBytes: 65536, deadlineMs: 30_000 },
    ...overrides,
  });
}

function assignmentFor(task: IntegrationTaskSpec | Record<string, unknown>, digest = integrationWorkloadDigest(task as IntegrationTaskSpec), agentId = (task as { agentId: string }).agentId): IntegrationWorkAssignment {
  return RemoteWorkAssignmentSchema.parse({
    id: "asg-int", kind: "integration", placementId: "pl", instanceId: "inst-1", workspaceId: "ws-1", taskId: (task as { taskId: string }).taskId, correlationId: "c", attempt: 1,
    expiresAt: "2099-01-01T00:00:00Z", requiredCapabilities: [REMOTE_INTEGRATION_TASK_CAPABILITY],
    agentRoute: { requiredRole: "assistant", agentId },
    source: { kind: "integration_task", portability: "instance_bound", ownerInstanceId: "inst-1", taskId: (task as { taskId: string }).taskId, specDigest: digest },
    policy: { maxDurationSeconds: 600, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
      latestResumeAt: "2099-01-01T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: false },
  }) as RemoteWorkAssignment as IntegrationWorkAssignment;
}

function carrier(agent: FakeAgent | null, task: unknown, overrides: Partial<ConstructorParameters<typeof IntegrationTaskCarrier>[0]> = {}) {
  const runners = new Map<string, RunnerPort>();
  if (agent) for (const id of ["claude-code", "codex"]) runners.set(id, agent.port(id));
  const created = new IntegrationTaskCarrier({
    fetchWorkload: async assignment => ({ assignmentId: assignment.id, attempt: assignment.attempt, kind: "integration", workload: task as never }),
    discovery: { discover: async () => [] },
    setup: { run: async () => { throw new Error("no setup here"); } },
    runners: () => runners,
    instanceId: () => "inst-1",
    workspaceRoot: () => workspace,
    writes: journalWriteLedger(journal),
    e2eFixtures: false,
    cancelGraceMs: 50,
    ...overrides,
  });
  if (agent) agent.sink = event => created.onRunnerEvent(event);
  return created;
}

async function run(task: IntegrationTaskSpec, agent: FakeAgent | null, overrides: Partial<ConstructorParameters<typeof IntegrationTaskCarrier>[0]> = {}): Promise<IntegrationTaskResult> {
  const outcome = await carrier(agent, task, overrides).execute(assignmentFor(task), () => undefined);
  return IntegrationTaskResultSchema.parse(outcome.structuredOutput);
}

describe("integration task carrier: a read through a Claude account connector", () => {
  it("runs one gated session, keeps the connector's result as evidence and the agent's as its report", async () => {
    const issue = { key: "ENG-42", summary: "Checkout fails on retry" };
    const answers: unknown[] = [];
    const agent = new FakeAgent(async a => {
      answers.push(await a.ask(claudeTool("t1", "mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "ENG-42" })));
      await a.update(claudeDone("t1", "mcp__claude_ai_Atlassian__getJiraIssue", issue));
      answers.push(await a.ask(claudeTool("t2", "Bash", { command: "curl https://example.atlassian.net/rest/api/3/issue/ENG-42" })));
      answers.push(await a.ask(claudeTool("t3", "mcp__konteks-result__submit_result", { summary: "Checkout fails on retry" })));
      await a.submit({ summary: "Checkout fails on retry" });
      await a.end();
    });
    const result = await run(spec(), agent);
    expect(answers).toEqual([selected("once"), selected("reject"), selected("once")]);
    const content = JSON.stringify(issue);
    expect(result).toEqual({
      schemaVersion: 1, taskId: "xi-task-1", phase: "read",
      toolCalls: [
        { server: "claude_ai_Atlassian", tool: "getJiraIssue", argsDigest: argsDigest({ issueIdOrKey: "ENG-42" }), status: "allowed", outcome: "succeeded" },
        { server: "native", tool: "Bash", argsDigest: expect.any(String), status: "denied", outcome: "not_run" },
      ],
      observations: [{ server: "claude_ai_Atlassian", tool: "getJiraIssue", content, contentDigest: sha256Hex(content), truncated: false, evidenceClass: "connector_observed" }],
      agentReport: { summary: "Checkout fails on retry" },
    });
    // The bound account connector is admitted for this session only; nothing else is offered.
    expect(agent.input).toMatchObject({ integration: { admittedMcpServerNames: [], accountConnectors: true }, context: { assignmentId: "asg-int", agentId: "claude-code" } });
    expect(agent.input!.mcpServers.map(server => server.name)).toEqual(["konteks-result"]);
    expect(agent.input!.cwd.startsWith(join(workspace, ".integration-"))).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
    expect(agent.closed).toHaveBeenCalledOnce();
    expect(agent.promptText).toContain("<<<\nRead ENG-42 and summarize it.\n>>>");
    expect(agent.promptText).toContain("- getJiraIssue (read)");
    expect(agent.promptText).toContain("not instructions");
  });

  it("bounds what it keeps of a tool result by the task's byte limit", async () => {
    const agent = new FakeAgent(async a => {
      await a.ask(claudeTool("t1", "mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "ENG-42" }));
      await a.update(claudeDone("t1", "mcp__claude_ai_Atlassian__getJiraIssue", { body: "é".repeat(100) }));
      await a.end();
    });
    const result = await run(spec({ limits: { maxToolCalls: 1, maxBytes: 11, deadlineMs: 30_000 } }), agent);
    expect(result.observations[0]).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(result.observations[0]!.content)).toBeLessThanOrEqual(11);
    expect(result.observations[0]!.contentDigest).toBe(sha256Hex(result.observations[0]!.content));
  });
});

describe("integration task carrier: Codex", () => {
  const codexSpec = () => spec({ agentId: "codex", binding: { ...claudeBinding, source: { kind: "agent_mcp", serverName: "atlassian" } },
    admittedTools: [{ server: "atlassian", tool: "getJiraIssue", mode: "read" }] });

  it("admits only the bound personal server for the thread and reads approvals by the announced call", async () => {
    const answers: unknown[] = [];
    const agent = new FakeAgent(async a => {
      await a.update({ sessionUpdate: "tool_call", toolCallId: "item-1", status: "pending", _meta: { is_mcp_tool_call: true }, rawInput: { server: "atlassian", tool: "getJiraIssue", arguments: { issueIdOrKey: "ENG-42" } } });
      answers.push(await a.ask({ toolCall: { toolCallId: "item-1", kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true } } as never));
      await a.update({ sessionUpdate: "tool_call", toolCallId: "item-1", status: "completed", _meta: { is_mcp_tool_call: true },
        rawInput: { server: "atlassian", tool: "getJiraIssue", arguments: { issueIdOrKey: "ENG-42" } }, rawOutput: { result: { content: [{ type: "text", text: "ENG-42" }] }, error: null } });
      await a.end();
    });
    const result = await run(codexSpec(), agent);
    expect(answers).toEqual([selected("once")]);
    expect(agent.input).toMatchObject({ integration: { admittedMcpServerNames: ["atlassian"], accountConnectors: false } });
    expect(result.toolCalls).toEqual([expect.objectContaining({ server: "atlassian", tool: "getJiraIssue", status: "allowed", outcome: "succeeded" })]);
    expect(result.observations[0]!.content).toBe(JSON.stringify({ result: { content: [{ type: "text", text: "ENG-42" }] }, error: null }));
  });

  it("stops and reports when an MCP call completes without ever reaching the gate", async () => {
    const agent = new FakeAgent(async a => {
      await a.update({ sessionUpdate: "tool_call", toolCallId: "item-9", status: "completed", _meta: { is_mcp_tool_call: true },
        rawInput: { server: "atlassian", tool: "getJiraIssue", arguments: {} }, rawOutput: { result: { content: [] }, error: null } });
      await a.submit({ summary: "I read it" });
      await a.end();
    });
    const result = await run(codexSpec(), agent);
    expect(result.error).toMatchObject({ code: "operation_unsupported", params: { reason: "ungated_call" } });
    expect(result.observations).toEqual([]);
    expect(result.agentReport).toBeUndefined();
    expect(agent.cancelled).toHaveBeenCalled();
  });
});

describe("integration task carrier: the one approved write", () => {
  const comment = { cloudId: "c1", issueIdOrKey: "ENG-42", commentBody: "Shipped in v1.2" };
  const writeSpec = () => spec({ phase: "write", admittedTools: [{ server: "claude_ai_Atlassian", tool: "addCommentToJiraIssue", mode: "write" }],
    write: { tool: { server: "claude_ai_Atlassian", tool: "addCommentToJiraIssue" }, canonicalArgs: canonicalArgs(comment), argsDigest: argsDigest(comment), actionId: "act-1", attemptId: "att-1", nonce: "nonce-1" },
    limits: { maxToolCalls: 1, maxBytes: 65536, deadlineMs: 30_000 } });

  it("allows exactly the approved call once and records what the connector returned", async () => {
    const answers: unknown[] = [];
    const agent = new FakeAgent(async a => {
      answers.push(await a.ask(claudeTool("w1", "mcp__claude_ai_Atlassian__addCommentToJiraIssue", { ...comment, commentBody: "Shipped in v1.3" })));
      answers.push(await a.ask(claudeTool("w2", "mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment)));
      await a.update(claudeDone("w2", "mcp__claude_ai_Atlassian__addCommentToJiraIssue", { id: "10042" }));
      answers.push(await a.ask(claudeTool("w3", "mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment)));
      await a.end();
    });
    const result = await run(writeSpec(), agent);
    expect(answers).toEqual([selected("reject"), selected("once"), selected("reject")]);
    expect(result.toolCalls.filter(call => call.status === "allowed")).toEqual([
      { server: "claude_ai_Atlassian", tool: "addCommentToJiraIssue", argsDigest: argsDigest(comment), status: "allowed", outcome: "succeeded" }]);
    expect(result.observations).toEqual([expect.objectContaining({ content: JSON.stringify({ id: "10042" }), evidenceClass: "connector_observed" })]);
    expect(journal.integrationWrites.get("nonce-1")).toMatchObject({ toolCallId: "w2", attemptId: "att-1" });
    expect(result.error).toBeUndefined();
  });

  it("reports an unknown outcome, never success, when an allowed write never settles", async () => {
    const agent = new FakeAgent(async a => {
      await a.ask(claudeTool("w1", "mcp__claude_ai_Atlassian__addCommentToJiraIssue", comment));
      await a.end();
    });
    const result = await run(writeSpec(), agent);
    expect(result.error).toMatchObject({ code: "outcome_unknown", retryClass: "reconcile_first" });
    expect(result.toolCalls[0]).toMatchObject({ status: "allowed", outcome: "unknown" });
  });
});

describe("integration task carrier: limits and refusals", () => {
  it("cancels a turn that outlives the task's deadline", async () => {
    const agent = new FakeAgent(async () => undefined);
    const result = await run(spec({ limits: { maxToolCalls: 1, maxBytes: 1024, deadlineMs: 100 } }), agent);
    expect(result.error).toMatchObject({ code: "capacity_wait", params: { reason: "deadline" } });
    expect(agent.cancelled).toHaveBeenCalledOnce();
    expect(agent.closed).toHaveBeenCalledOnce();
  });

  it("fails the assignment when the task does not match it", async () => {
    const task = spec();
    await expect(carrier(new FakeAgent(async () => undefined), task).execute(assignmentFor(task, "b".repeat(64)), () => undefined))
      .rejects.toMatchObject({ code: "schema_invalid", diagnostic: "integration_spec_digest_mismatch" });
    await expect(carrier(new FakeAgent(async () => undefined), task).execute(assignmentFor(task, undefined, "codex"), () => undefined))
      .rejects.toMatchObject({ code: "schema_invalid", diagnostic: "integration_agent_mismatch" });
    await expect(carrier(new FakeAgent(async () => undefined), { ...task, rawConfig: "x" }).execute(assignmentFor(task), () => undefined))
      .rejects.toMatchObject({ code: "schema_invalid", diagnostic: "integration_spec_invalid" });
  });

  it("answers a source the agent cannot hold with a stable error and opens no session", async () => {
    const agent = new FakeAgent(async () => undefined);
    const result = await run(spec({ binding: { ...claudeBinding, source: { kind: "agent_mcp", serverName: "atlassian" } }, admittedTools: [{ server: "atlassian", tool: "getJiraIssue", mode: "read" }] }), agent);
    expect(result.error).toMatchObject({ code: "operation_unsupported", params: { reason: "source_kind" } });
    expect(agent.input).toBeNull();
  });
});

describe("integration task carrier: E2E fixture source", () => {
  const fixtureSpec = () => spec({ binding: { ...claudeBinding, source: { kind: "fixture_mcp", serverName: "jira-fixture" } },
    admittedTools: [{ server: "jira-fixture", tool: "getIssue", mode: "read" }], fixtureServer: { type: "http", url: "http://127.0.0.1:43123/mcp" } });

  it("is refused outside the E2E connector", async () => {
    const agent = new FakeAgent(async () => undefined);
    const result = await run(fixtureSpec(), agent);
    expect(result.error).toMatchObject({ code: "operation_unsupported", params: { reason: "fixture_source" } });
    expect(agent.input).toBeNull();
    expect(integrationFixturesEnabled({})).toBe(false);
    expect(integrationFixturesEnabled({ KONTEKS_E2E_NATIVE_CONNECTOR: "0" })).toBe(false);
    expect(integrationFixturesEnabled({ KONTEKS_E2E_NATIVE_CONNECTOR: "1" })).toBe(true);
  });

  it("is passed to the agent as the session's own MCP server in the E2E connector, and still gated", async () => {
    const answers: unknown[] = [];
    const agent = new FakeAgent(async a => {
      answers.push(await a.ask(claudeTool("f1", "mcp__jira-fixture__getIssue", { key: "ENG-1" })));
      answers.push(await a.ask(claudeTool("f2", "mcp__jira-fixture__addComment", { key: "ENG-1", body: "x" })));
      await a.end();
    });
    const result = await run(fixtureSpec(), agent, { e2eFixtures: true });
    expect(agent.input!.mcpServers).toEqual([expect.objectContaining({ name: "konteks-result" }), { type: "http", name: "jira-fixture", url: "http://127.0.0.1:43123/mcp", headers: [] }]);
    expect(agent.input!.integration).toEqual({ admittedMcpServerNames: [], accountConnectors: false });
    expect(answers).toEqual([selected("once"), selected("reject")]);
    expect(result.toolCalls.map(call => [call.tool, call.status])).toEqual([["getIssue", "allowed"], ["addComment", "denied"]]);
  });
});

describe("integration task carrier: discovery", () => {
  it("is model-free and returns the allowlisted inventory", async () => {
    const task = IntegrationTaskSpecSchema.parse({ schemaVersion: 1, taskId: "xi-d", phase: "discover", agentId: "codex", admittedTools: [], instructions: "",
      resultSchema: { type: "object" }, limits: { maxToolCalls: 0, maxBytes: 1, deadlineMs: 1000 } });
    const inventory = [{ serverName: "atlassian", sourceKind: "agent_mcp" as const, status: "connected" as const, providerCategory: "jira" as const, toolNames: ["getJiraIssue"] }];
    const discover = vi.fn(async () => inventory);
    const agent = new FakeAgent(async () => undefined);
    const outcome = await carrier(agent, task, { discovery: { discover } }).execute(assignmentFor(task), () => undefined);
    expect(outcome.structuredOutput).toEqual({ schemaVersion: 1, taskId: "xi-d", phase: "discover", toolCalls: [], observations: [], inventory });
    expect(discover).toHaveBeenCalledWith("codex");
    expect(agent.input).toBeNull();
  });
});
