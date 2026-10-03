import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  BoundedJsonValueSchema,
  INTEGRATION_TASK_LIMITS,
  IntegrationTaskResultSchema,
  sha256Hex,
  type IntegrationTaskObservation,
  type IntegrationTaskResult,
  type IntegrationTaskSpec,
} from "@konteks/backstage-plugin-common";
import { RemoteInstanceError, createLogger, type AgentTurnUsageObservation, type Logger, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import type { RunnerPort, RunnerSessionInput } from "../runner-port.js";
import { McpToolCallLedger } from "../session/permission-tool-identity.js";
import { STRUCTURED_RESULT_MCP_SERVER_NAME, StructuredResultToolServer, compileResultSchema } from "../structured-result/result-tool-server.js";
import { IntegrationTaskError } from "./errors.js";
import { buildIntegrationPrompt } from "./prompt.js";
import { IntegrationToolGate, type IntegrationWriteLedger } from "./tool-gate.js";

interface IntegrationSessionDeps {
  runner: RunnerPort;
  instanceId: string;
  /** The agent runner's workspace folder; the session gets an empty private folder inside it. */
  workspaceRoot: string;
  writes: IntegrationWriteLedger;
  /** E2E only (`KONTEKS_E2E_NATIVE_CONNECTOR=1`): a `fixture_mcp` binding is served. */
  e2eFixtures: boolean;
  now?: () => number;
  onUsage?: (observation: AgentTurnUsageObservation) => Promise<void>;
  /** After a cancel, how long the turn gets to end before the session is closed anyway. */
  cancelGraceMs?: number;
  logger?: Logger;
}

type TurnEnd = { kind: "result" } | { kind: "error"; class: string } | { kind: "exited" } | { kind: "deadline" } | { kind: "ungated" };

const TERMINAL = new Set(["completed", "failed"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The text of an ACP tool result: the structured `rawOutput` when the agent gives one, else its text content blocks. */
function toolResultText(update: Record<string, unknown>): string | null {
  if (update.rawOutput !== undefined) {
    try { return JSON.stringify(update.rawOutput); } catch { return null; }
  }
  if (!Array.isArray(update.content)) return null;
  const parts: string[] = [];
  for (const block of update.content) {
    const inner = record(record(block)?.content);
    if (inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function boundedUtf8(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, truncated: false };
  let content = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
  while (Buffer.byteLength(content, "utf8") > maxBytes || content.endsWith("�")) content = content.slice(0, -1);
  return { content, truncated: true };
}

/**
 * One integration task's own ACP session on the bound agent (DESIGN §2): a
 * new session in an empty private folder with only the `konteks-result` tool
 * (and, in E2E, the fixture server), the bound source admitted for this
 * session only, one locally built prompt, and the `IntegrationToolGate` as
 * its entire permission policy. Nothing of it is relayed: Core sees only the
 * structured result.
 *
 * Evidence: a provider call's own result, captured from the ACP
 * `tool_call`/`tool_call_update` of a call the gate allowed, is an
 * observation (`connector_observed`, bounded and digested). What the agent
 * hands in through `submit_result` is only the `agentReport`. An MCP call
 * that completes without ever reaching the gate stops the session: that
 * route is not governed, so the task reports it instead of a result.
 */
export class IntegrationSession {
  private readonly logger: Logger;
  private readonly ledger = new McpToolCallLedger();
  private readonly mcpCalls = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly observations: IntegrationTaskObservation[] = [];
  private observedBytes = 0;
  private gate: IntegrationToolGate | null = null;
  private acpSessionRef: string | null = null;
  private promptId: string | null = null;
  private endTurn: ((end: TurnEnd) => void) | null = null;
  private ended: TurnEnd | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  /** An MCP call completed without reaching the gate. */
  private ungated = false;

  constructor(
    private readonly assignment: RemoteWorkAssignment,
    private readonly spec: IntegrationTaskSpec,
    private readonly deps: IntegrationSessionDeps,
  ) {
    this.logger = deps.logger ?? createLogger({ name: "integration-session" });
  }

  async run(assertCurrent: () => void): Promise<IntegrationTaskResult> {
    const spec = this.spec;
    const binding = spec.binding!;
    const agentId = spec.agentId;
    const now = this.deps.now ?? Date.now;
    const deadlineAt = now() + spec.limits.deadlineMs;
    const source = binding.source;
    // Which source each agent can hold (preflight C2/C3, Stage 1): Claude's
    // account connectors, Codex's personal servers, and an E2E fixture.
    if (source.kind === "fixture_mcp" && !this.deps.e2eFixtures) throw new IntegrationTaskError("operation_unsupported", { reason: "fixture_source" });
    if (agentId === "claude-code" ? source.kind === "agent_mcp" : agentId === "codex" ? source.kind === "account_connector" : true) {
      throw new IntegrationTaskError("operation_unsupported", { reason: "source_kind" });
    }
    let schema: Record<string, unknown>;
    const resultSchema = record(spec.resultSchema);
    try {
      if (!resultSchema) throw new Error("not an object");
      compileResultSchema(resultSchema);
      schema = resultSchema;
    } catch {
      throw new RemoteInstanceError("schema_invalid", "The integration task's result schema does not compile.", { diagnostic: "integration_result_schema_invalid" });
    }
    const fixture = source.kind === "fixture_mcp" ? spec.fixtureServer : undefined;
    const integration: NonNullable<RunnerSessionInput["integration"]> = source.kind === "account_connector"
      ? { admittedMcpServerNames: [], accountConnectors: true }
      : { admittedMcpServerNames: fixture ? [] : [source.serverName], accountConnectors: false };
    const cwd = await mkdtemp(join(this.deps.workspaceRoot, ".integration-"));
    await chmod(cwd, 0o700);
    const resultTools = new StructuredResultToolServer({ logger: this.logger, context: { assignmentId: this.assignment.id, attempt: this.assignment.attempt } });
    let created = false;
    try {
      const resultServer = await resultTools.start();
      const mcpServers: RunnerSessionInput["mcpServers"] = [{ type: "http", ...resultServer }];
      if (fixture) mcpServers.push({ type: "http", name: source.serverName, url: fixture.url, headers: [] });
      this.gate = new IntegrationToolGate(spec, {
        agentId,
        sessionServers: new Set(mcpServers.map(server => server.name)),
        ledger: this.ledger,
        writes: this.deps.writes,
        now: () => new Date(now()).toISOString(),
      });
      assertCurrent();
      const session = await this.deps.runner.createSession({
        context: { instanceId: this.deps.instanceId, assignmentId: this.assignment.id, attempt: this.assignment.attempt, agentId },
        readinessDeadlineAt: new Date(deadlineAt).toISOString(),
        cwd,
        mcpServers,
        integration,
      });
      created = true;
      this.acpSessionRef = session.acpSessionRef;
      assertCurrent();
      const definition = await resultTools.bind(schema);
      const turn = new Promise<TurnEnd>(resolve => { this.endTurn = resolve; });
      const remaining = Math.max(0, deadlineAt - now());
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<TurnEnd>(resolve => { timer = setTimeout(() => resolve({ kind: "deadline" }), remaining); timer.unref(); });
      this.promptId = `integration-${randomUUID()}`;
      await this.deps.runner.prompt(session.acpSessionRef, this.promptId, {
        sessionId: session.acpSessionRef,
        prompt: [{ type: "text", text: buildIntegrationPrompt(spec, definition) }],
      });
      let end = await Promise.race([turn, deadline]);
      clearTimeout(timer);
      if (end.kind === "deadline" || end.kind === "ungated") {
        await this.deps.runner.cancel(session.acpSessionRef).catch(() => undefined);
        // Give the turn a moment to end, so a call that already ran is settled.
        await Promise.race([turn, new Promise(resolve => setTimeout(resolve, this.deps.cancelGraceMs ?? 2_000).unref())]);
      }
      this.ended = end;
      await Promise.allSettled([...this.pending]);
      end = this.ended;
      return this.result(end, resultTools.result()?.value);
    } finally {
      this.ended ??= { kind: "exited" };
      this.endTurn = null;
      if (created && this.acpSessionRef) await this.deps.runner.closeSession(this.acpSessionRef).catch(error => this.logger.warn({ err: error }, "integration session close failed"));
      await resultTools.close().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Runner events for this session only. */
  async onRunnerEvent(event: RunnerEvent): Promise<void> {
    if (this.acpSessionRef === null || !("acpSessionRef" in event) || event.acpSessionRef !== this.acpSessionRef) return;
    const work = this.handle(event);
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  private async handle(event: RunnerEvent): Promise<void> {
    const ref = this.acpSessionRef!;
    switch (event.kind) {
      case "session_update":
        this.observe(record(record(event.params)?.update));
        return;
      case "permission_request": {
        const request = event.params as RequestPermissionRequest;
        if (this.ended !== null || !this.gate) {
          await this.deps.runner.answer(ref, event.requestId, { outcome: { outcome: "cancelled" } }).catch(() => undefined);
          return;
        }
        const decision = await this.gate.evaluate(request);
        if (decision.kind === "deny") {
          this.logger.info({ assignmentId: this.assignment.id, toolCallId: request.toolCall?.toolCallId, reason: decision.reason }, "integration gate refused a tool call");
        }
        const response = decision.kind === "allow" ? { outcome: { outcome: "selected", optionId: decision.optionId } }
          : decision.optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: decision.optionId } };
        await this.deps.runner.answer(ref, event.requestId, response);
        return;
      }
      case "elicitation_request":
        // A provider asking for a sign-in or a form is never answered here.
        await this.deps.runner.answer(ref, event.requestId, { action: "decline" }).catch(() => undefined);
        return;
      case "prompt_result":
        if (event.requestId === this.promptId) this.endTurn?.({ kind: "result" });
        return;
      case "request_error":
        if (event.requestId === this.promptId) this.endTurn?.({ kind: "error", class: event.class });
        return;
      case "session_exited":
        this.endTurn?.({ kind: "exited" });
        return;
      case "usage_observation":
        await this.deps.onUsage?.(event.observation);
        return;
      default:
        return;
    }
  }

  /** Track MCP calls and capture what the connector returned for the calls the gate allowed. */
  private observe(update: Record<string, unknown> | undefined): void {
    if (!update || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) return;
    this.ledger.observe(update);
    const id = update.toolCallId;
    if (typeof id !== "string" || id.length === 0 || id.length > 256) return;
    const meta = record(update._meta);
    const claudeTool = record(meta?.claudeCode)?.toolName;
    const codexServer = record(update.rawInput)?.server;
    if (meta?.is_mcp_tool_call === true || (typeof claudeTool === "string" && claudeTool.startsWith("mcp__"))) {
      const ownResult = codexServer === STRUCTURED_RESULT_MCP_SERVER_NAME || (typeof claudeTool === "string" && claudeTool.startsWith(`mcp__${STRUCTURED_RESULT_MCP_SERVER_NAME}__`));
      if (!ownResult) this.mcpCalls.add(id);
    }
    if (typeof update.status !== "string" || !TERMINAL.has(update.status) || this.settled.has(id)) return;
    const gate = this.gate!;
    const allowed = gate.allowedCall(id);
    if (!allowed) {
      // An MCP call that ran to completion without ever asking the gate went
      // around it: the route is not governed. Stop instead of reporting.
      if (this.mcpCalls.has(id) && update.status === "completed" && !gate.wasJudged(id)) {
        this.settled.add(id);
        this.logger.error({ assignmentId: this.assignment.id, toolCallId: id }, "an MCP call ran without reaching the integration gate; stopping the task");
        this.endTurn?.({ kind: "ungated" });
        this.ungated = true;
      }
      return;
    }
    this.settled.add(id);
    gate.settle(id, update.status === "completed" ? "succeeded" : "failed");
    if (update.status !== "completed") return;
    const text = toolResultText(update);
    if (text === null || this.observations.length >= INTEGRATION_TASK_LIMITS.maxObservations) return;
    const budget = Math.min(INTEGRATION_TASK_LIMITS.maxObservationContentBytes, Math.max(0, this.spec.limits.maxBytes - this.observedBytes));
    const { content, truncated } = boundedUtf8(text, budget);
    this.observedBytes += Buffer.byteLength(content, "utf8");
    this.observations.push({ server: allowed.server, tool: allowed.tool, content, contentDigest: sha256Hex(content), truncated, evidenceClass: "connector_observed" });
  }

  private result(end: TurnEnd, reported: unknown): IntegrationTaskResult {
    const toolCalls = this.gate?.records() ?? [];
    const report = reported === undefined ? undefined : BoundedJsonValueSchema.safeParse(reported);
    const writeOpen = this.spec.phase === "write" && toolCalls.some(call => call.status === "allowed" && call.outcome === "unknown");
    let error: IntegrationTaskError | undefined;
    if (this.ungated || end.kind === "ungated") error = new IntegrationTaskError("operation_unsupported", { reason: "ungated_call" });
    else if (writeOpen) error = new IntegrationTaskError("outcome_unknown");
    else if (end.kind === "deadline") error = new IntegrationTaskError("capacity_wait", { reason: "deadline" });
    else if (end.kind === "error" && end.class === "agent_auth_required") error = new IntegrationTaskError("needs_auth");
    else if (end.kind === "error" || end.kind === "exited") error = new IntegrationTaskError("capacity_wait", { reason: end.kind === "error" ? "agent_error" : "agent_exited" });
    return IntegrationTaskResultSchema.parse({
      schemaVersion: 1,
      taskId: this.spec.taskId,
      phase: this.spec.phase,
      toolCalls,
      observations: this.observations,
      // The agent's own account, never evidence; dropped when a call went around the gate.
      ...(report?.success && !this.ungated ? { agentReport: report.data } : {}),
      ...(error ? { error: error.toResultError() } : {}),
    });
  }
}
