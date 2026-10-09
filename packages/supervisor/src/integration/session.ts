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
import { RemoteInstanceError, createLogger, plainRecord, type AgentTurnUsageObservation, type Logger, type RemoteWorkAssignment } from "@konteks/remote-common";
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


/** The text of an ACP tool result: the structured `rawOutput` when the agent gives one, else its text content blocks. */
function toolResultText(update: Record<string, unknown>): string | null {
  if (update.rawOutput !== undefined) return jsonText(update.rawOutput);
  if (!Array.isArray(update.content)) return null;
  const parts = update.content.map(blockText).filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

function jsonText(value: unknown): string | null {
  try { return JSON.stringify(value); } catch { return null; }
}

function blockText(block: unknown): string | null {
  const inner = plainRecord(plainRecord(block)?.content);
  return inner?.type === "text" && typeof inner.text === "string" ? inner.text : null;
}

type IntegrationSource = NonNullable<IntegrationTaskSpec["binding"]>["source"];

/**
 * The bound source, when this agent can hold it: Claude's account
 * connectors, Codex's personal servers, and (in E2E only) a fixture.
 */
function admittedSource(spec: IntegrationTaskSpec, e2eFixtures: boolean): IntegrationSource {
  const source = spec.binding!.source;
  if (source.kind === "fixture_mcp" && !e2eFixtures) throw new IntegrationTaskError("operation_unsupported", { reason: "fixture_source" });
  if (!sourceFitsAgent(spec.agentId, source.kind)) throw new IntegrationTaskError("operation_unsupported", { reason: "source_kind" });
  return source;
}

function sourceFitsAgent(agentId: string, kind: IntegrationSource["kind"]): boolean {
  if (agentId === "claude-code") return kind !== "agent_mcp";
  if (agentId === "codex") return kind !== "account_connector";
  return false;
}

function compiledResultSchema(spec: IntegrationTaskSpec): Record<string, unknown> {
  const resultSchema = plainRecord(spec.resultSchema);
  try {
    if (!resultSchema) throw new Error("not an object");
    compileResultSchema(resultSchema);
    return resultSchema;
  } catch {
    throw new RemoteInstanceError("schema_invalid", "The integration task's result schema does not compile.", { diagnostic: "integration_result_schema_invalid" });
  }
}

/** Which MCP sources the session admits: the account's connectors, or the bound personal server (a fixture is served directly). */
function integrationAdmission(source: IntegrationSource, fixture: unknown): NonNullable<RunnerSessionInput["integration"]> {
  if (source.kind === "account_connector") return { admittedMcpServerNames: [], accountConnectors: true };
  return { admittedMcpServerNames: fixture ? [] : [source.serverName], accountConnectors: false };
}

/** How a turn that did not end with a result failed, if it did. */
function turnEndError(end: TurnEnd): IntegrationTaskError | undefined {
  if (end.kind === "deadline") return new IntegrationTaskError("capacity_wait", { reason: "deadline" });
  if (end.kind === "error" && end.class === "agent_auth_required") return new IntegrationTaskError("needs_auth");
  if (end.kind === "error" || end.kind === "exited") return new IntegrationTaskError("capacity_wait", { reason: end.kind === "error" ? "agent_error" : "agent_exited" });
  return undefined;
}

/** How a runner event ends the prompted turn, if it does. */
function turnEnd(event: RunnerEvent, promptId: string | null): TurnEnd | null {
  if (event.kind === "prompt_result") return event.requestId === promptId ? { kind: "result" } : null;
  if (event.kind === "request_error") return event.requestId === promptId ? { kind: "error", class: event.class } : null;
  return event.kind === "session_exited" ? { kind: "exited" } : null;
}

type GateDecision = Awaited<ReturnType<IntegrationToolGate["evaluate"]>>;

function permissionResponse(decision: GateDecision): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  if (decision.kind === "allow") return { outcome: { outcome: "selected", optionId: decision.optionId } };
  return decision.optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: decision.optionId } };
}

function isToolCallUpdate(update: Record<string, unknown> | undefined): update is Record<string, unknown> {
  return update !== undefined && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
}

function isCallId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 256;
}

function isMcpCall(meta: Record<string, unknown> | undefined, claudeTool: unknown): boolean {
  return meta?.is_mcp_tool_call === true || (typeof claudeTool === "string" && claudeTool.startsWith("mcp__"));
}

/** The session's own `konteks-result` tool, which is not a provider call. */
function isOwnResultCall(codexServer: unknown, claudeTool: unknown): boolean {
  return codexServer === STRUCTURED_RESULT_MCP_SERVER_NAME || (typeof claudeTool === "string" && claudeTool.startsWith(`mcp__${STRUCTURED_RESULT_MCP_SERVER_NAME}__`));
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function boundedUtf8(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, truncated: false };
  let content = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
  while (Buffer.byteLength(content, "utf8") > maxBytes || content.endsWith("�")) content = content.slice(0, -1);
  return { content, truncated: true };
}

/**
 * One integration task's own ACP session on the bound agent: a
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
/** How long a finished read waits for its last events and its session close before it reports anyway. */
const SETTLE_GRACE_MS = 15_000;

/** Whether `work` settled within `ms`; it keeps running either way. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); timer.unref(); });
  const done = await Promise.race([work.then(() => true, () => true), timeout]);
  clearTimeout(timer);
  return done;
}

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
    const now = this.deps.now ?? Date.now;
    const deadlineAt = now() + spec.limits.deadlineMs;
    const source = admittedSource(spec, this.deps.e2eFixtures);
    const schema = compiledResultSchema(spec);
    const fixture = source.kind === "fixture_mcp" ? spec.fixtureServer : undefined;
    const cwd = await mkdtemp(join(this.deps.workspaceRoot, ".integration-"));
    await chmod(cwd, 0o700);
    const resultTools = new StructuredResultToolServer({ logger: this.logger, context: { assignmentId: this.assignment.id, attempt: this.assignment.attempt } });
    let created = false;
    // Where a read's time goes, one line per task (a read takes ~45 s and
    // nothing said which part was slow).
    const startedAt = now();
    const phasesMs: Record<string, number> = {};
    let mark = startedAt;
    const lap = (phase: string) => { const at = now(); phasesMs[phase] = at - mark; mark = at; };
    try {
      const resultServer = await resultTools.start();
      const mcpServers: RunnerSessionInput["mcpServers"] = [{ type: "http", ...resultServer }];
      if (fixture) mcpServers.push({ type: "http", name: source.serverName, url: fixture.url, headers: [] });
      this.gate = new IntegrationToolGate(spec, {
        agentId: spec.agentId,
        sessionServers: new Set(mcpServers.map(server => server.name)),
        ledger: this.ledger,
        writes: this.deps.writes,
        now: () => new Date(now()).toISOString(),
      });
      assertCurrent();
      const session = await this.deps.runner.createSession({
        context: { instanceId: this.deps.instanceId, assignmentId: this.assignment.id, attempt: this.assignment.attempt, agentId: spec.agentId },
        readinessDeadlineAt: new Date(deadlineAt).toISOString(),
        cwd,
        mcpServers,
        integration: integrationAdmission(source, fixture),
      });
      created = true;
      lap("session");
      this.acpSessionRef = session.acpSessionRef;
      assertCurrent();
      const definition = await resultTools.bind(schema);
      const end = await this.promptTurn(session.acpSessionRef, () => buildIntegrationPrompt(spec, definition), deadlineAt, now);
      lap("turn");
      return this.result(end, resultTools.result()?.value);
    } finally {
      await this.cleanUp(created, resultTools, cwd);
      lap("cleanup");
      this.logger.info({ event: "integration.task.timing", assignmentId: this.assignment.id, phase: spec.phase,
        agentId: spec.agentId, totalMs: now() - startedAt, phasesMs }, "integration task timing");
    }
  }

  /** Prompt once and wait for the turn to end, at the latest at the deadline; every pending event is handled first. */
  private async promptTurn(acpSessionRef: string, text: () => string, deadlineAt: number, now: () => number): Promise<TurnEnd> {
    const turn = new Promise<TurnEnd>(resolve => { this.endTurn = resolve; });
    const remaining = Math.max(0, deadlineAt - now());
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<TurnEnd>(resolve => { timer = setTimeout(() => resolve({ kind: "deadline" }), remaining); timer.unref(); });
    this.promptId = `integration-${randomUUID()}`;
    await this.deps.runner.prompt(acpSessionRef, this.promptId, {
      sessionId: acpSessionRef,
      prompt: [{ type: "text", text: text() }],
    });
    const end = await Promise.race([turn, deadline]);
    clearTimeout(timer);
    if (end.kind === "deadline" || end.kind === "ungated") {
      await this.deps.runner.cancel(acpSessionRef).catch(() => undefined);
      // Give the turn a moment to end, so a call that already ran is settled.
      await Promise.race([turn, new Promise(resolve => setTimeout(resolve, this.deps.cancelGraceMs ?? 2_000).unref())]);
    }
    this.ended = end;
    // Bounded like every other step of a read: one handler that never
    // settles must not hold the task (and its terminal report) open.
    await settledWithin(Promise.allSettled([...this.pending]), SETTLE_GRACE_MS);
    return this.ended;
  }

  private async cleanUp(created: boolean, resultTools: StructuredResultToolServer, cwd: string): Promise<void> {
    this.ended ??= { kind: "exited" };
    this.endTurn = null;
    if (created && this.acpSessionRef) {
      const closing = this.deps.runner.closeSession(this.acpSessionRef).catch(error => this.logger.warn({ err: error }, "integration session close failed"));
      if (!(await settledWithin(closing, SETTLE_GRACE_MS))) this.logger.warn({ assignmentId: this.assignment.id }, "integration session close still running; reporting without waiting for it");
    }
    await resultTools.close().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Runner events for this session only. */
  async onRunnerEvent(event: RunnerEvent): Promise<void> {
    if (this.acpSessionRef === null || !("acpSessionRef" in event) || event.acpSessionRef !== this.acpSessionRef) return;
    const work = this.handle(event);
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  private async handle(event: RunnerEvent): Promise<void> {
    if (event.kind === "session_update") return this.observe(plainRecord(plainRecord(event.params)?.update));
    if (event.kind === "permission_request") return this.answerPermission(event.requestId, event.params as RequestPermissionRequest);
    // A provider asking for a sign-in or a form is never answered here.
    if (event.kind === "elicitation_request") return void await this.deps.runner.answer(this.acpSessionRef!, event.requestId, { action: "decline" }).catch(() => undefined);
    if (event.kind === "usage_observation") return void await this.deps.onUsage?.(event.observation);
    this.endOnTurnEvent(event);
  }

  private endOnTurnEvent(event: RunnerEvent): void {
    const end = turnEnd(event, this.promptId);
    if (end) this.endTurn?.(end);
  }

  private async answerPermission(requestId: string, request: RequestPermissionRequest): Promise<void> {
    const ref = this.acpSessionRef!;
    if (this.ended !== null || !this.gate) {
      await this.deps.runner.answer(ref, requestId, { outcome: { outcome: "cancelled" } }).catch(() => undefined);
      return;
    }
    const decision = await this.gate.evaluate(request);
    if (decision.kind === "deny") {
      this.logger.info({ assignmentId: this.assignment.id, toolCallId: request.toolCall?.toolCallId, reason: decision.reason }, "integration gate refused a tool call");
    }
    await this.deps.runner.answer(ref, requestId, permissionResponse(decision));
  }

  /** Track MCP calls and capture what the connector returned for the calls the gate allowed. */
  private observe(update: Record<string, unknown> | undefined): void {
    if (!isToolCallUpdate(update)) return;
    this.ledger.observe(update);
    const id = update.toolCallId;
    if (!isCallId(id)) return;
    this.trackMcpCall(update, id);
    if (!this.unsettledTerminal(update.status, id)) return;
    const allowed = this.gate!.allowedCall(id);
    if (!allowed) return this.stopIfUngated(id, update.status);
    this.settled.add(id);
    this.gate!.settle(id, update.status === "completed" ? "succeeded" : "failed");
    if (update.status === "completed") this.recordObservation(update, allowed);
  }

  private unsettledTerminal(status: unknown, id: string): status is string {
    return typeof status === "string" && TERMINAL.has(status) && !this.settled.has(id);
  }

  private trackMcpCall(update: Record<string, unknown>, id: string): void {
    const meta = plainRecord(update._meta);
    const claudeTool = plainRecord(meta?.claudeCode)?.toolName;
    const codexServer = plainRecord(update.rawInput)?.server;
    if (isMcpCall(meta, claudeTool) && !isOwnResultCall(codexServer, claudeTool)) this.mcpCalls.add(id);
  }

  /**
   * An MCP call that ran to completion without ever asking the gate went
   * around it: the route is not governed. Stop instead of reporting.
   */
  private stopIfUngated(id: string, status: string): void {
    if (!this.mcpCalls.has(id) || status !== "completed" || this.gate!.wasJudged(id)) return;
    this.settled.add(id);
    this.logger.error({ assignmentId: this.assignment.id, toolCallId: id }, "an MCP call ran without reaching the integration gate; stopping the task");
    this.endTurn?.({ kind: "ungated" });
    this.ungated = true;
  }

  /** The provider call's own result, bounded and digested, as connector-observed evidence. */
  private recordObservation(update: Record<string, unknown>, allowed: { server: string; tool: string }): void {
    const text = toolResultText(update);
    if (text === null || this.observations.length >= INTEGRATION_TASK_LIMITS.maxObservations) return;
    const budget = Math.min(INTEGRATION_TASK_LIMITS.maxObservationContentBytes, Math.max(0, this.spec.limits.maxBytes - this.observedBytes));
    const { content, truncated } = boundedUtf8(text, budget);
    this.observedBytes += Buffer.byteLength(content, "utf8");
    this.observations.push({ server: allowed.server, tool: allowed.tool, content, contentDigest: sha256Hex(content), truncated, evidenceClass: "connector_observed" });
  }

  private result(end: TurnEnd, reported: unknown): IntegrationTaskResult {
    const toolCalls = this.gate?.records() ?? [];
    const error = this.taskError(end, toolCalls);
    return IntegrationTaskResultSchema.parse({
      schemaVersion: 1,
      taskId: this.spec.taskId,
      phase: this.spec.phase,
      toolCalls,
      observations: this.observations,
      ...this.agentReport(reported),
      ...(error ? { error: error.toResultError() } : {}),
    });
  }

  /** The agent's own account, never evidence; dropped when a call went around the gate. */
  private agentReport(reported: unknown): { agentReport?: unknown } {
    if (reported === undefined || this.ungated) return {};
    const report = BoundedJsonValueSchema.safeParse(reported);
    return report.success ? { agentReport: report.data } : {};
  }

  private taskError(end: TurnEnd, toolCalls: ReturnType<IntegrationToolGate["records"]>): IntegrationTaskError | undefined {
    if (this.ungated || end.kind === "ungated") return new IntegrationTaskError("operation_unsupported", { reason: "ungated_call" });
    if (this.spec.phase === "write" && toolCalls.some(call => call.status === "allowed" && call.outcome === "unknown")) return new IntegrationTaskError("outcome_unknown");
    return turnEndError(end);
  }}
