import type { z } from "zod";
import { RemoteInstanceError, createLogger, jcsDigest, type AgentTurnUsageObservation, type BoundedJsonValue, type JsonValue, type Logger, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import {
  IntegrationSetupResultSchema,
  IntegrationTaskResultSchema,
  IntegrationWorkloadSchema,
  REMOTE_INTEGRATION_TASK_CAPABILITY,
  integrationWorkloadDigest,
  type IntegrationTaskResult,
  type IntegrationTaskSpec,
} from "@konteks/backstage-plugin-common";
import type { RunnerPort } from "../runner-port.js";
import type { WorkloadDefinition } from "../work/workload.js";
import type { IntegrationDiscovery } from "./discovery.js";
import { IntegrationTaskError } from "./errors.js";
import { IntegrationSession } from "./session.js";
import type { IntegrationSetupRunner } from "./setup.js";
import type { IntegrationWriteLedger } from "./tool-gate.js";

/**
 * An `integration` assignment (external-integration-via-agent CP2): one
 * bounded integration task Core placed on the runtime that holds the
 * binding. It never takes the relayed-session path: the carrier fetches the
 * frozen task from Core's workload route and runs it here, model-free for
 * discovery and setup, through its own gated ACP session otherwise.
 */
export type IntegrationWorkAssignment = RemoteWorkAssignment & { kind: "integration"; source: Extract<RemoteWorkAssignment["source"], { kind: "integration_task" }> };

export function isIntegrationWorkAssignment(assignment: RemoteWorkAssignment): assignment is IntegrationWorkAssignment {
  return assignment.kind === "integration" && assignment.source.kind === "integration_task";
}

/** What the orchestrator turns into a terminal report. */
export interface IntegrationWorkOutcome {
  structuredOutput: BoundedJsonValue;
}

/** The orchestrator's view of the carrier. */
export interface IntegrationWorkCarrier {
  execute(assignment: IntegrationWorkAssignment, assertCurrent: () => void): Promise<IntegrationWorkOutcome>;
  /** Runner events, so the carrier's own ACP session hears its permission requests and tool results. */
  onRunnerEvent(event: RunnerEvent): Promise<void>;
}

/** The terminal result: like an onboard result, the structured output is the whole outcome. */
export function integrationTerminalResult(outcome: IntegrationWorkOutcome): { class: "succeeded"; structuredOutput: BoundedJsonValue; terminalResultHash: string } {
  return { class: "succeeded", structuredOutput: outcome.structuredOutput, terminalResultHash: jcsDigest(outcome.structuredOutput as JsonValue) };
}

/** The agents an integration task can run on: the two with a certified permission gate (Stage 0). */
const INTEGRATION_AGENT_IDS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/** `integration-task-v1` for the `agent_runner` component when a Claude Code or Codex runner is installed. */
export function integrationTaskCapabilities(agentIds: Iterable<string>): string[] {
  for (const agentId of agentIds) if (INTEGRATION_AGENT_IDS.has(agentId)) return [REMOTE_INTEGRATION_TASK_CAPABILITY];
  return [];
}

/** E2E only: the connector serves `fixture_mcp` bindings when its process runs with `KONTEKS_E2E_NATIVE_CONNECTOR=1`. */
export function integrationFixturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KONTEKS_E2E_NATIVE_CONNECTOR === "1";
}

interface IntegrationTaskCarrierDeps {
  /** Core's frozen task for the claimed assignment (the workload route, assignment authority). */
  fetchWorkload: (assignment: IntegrationWorkAssignment) => Promise<WorkloadDefinition>;
  discovery: IntegrationDiscovery;
  setup: IntegrationSetupRunner;
  runners: () => ReadonlyMap<string, RunnerPort>;
  instanceId: () => string;
  /** The agent runner's workspace folder (the session's private folder goes inside it). */
  workspaceRoot: (agentId: string) => string;
  writes: IntegrationWriteLedger;
  e2eFixtures: boolean;
  onUsage?: (observation: AgentTurnUsageObservation) => Promise<void>;
  now?: () => number;
  /** After a cancel, how long a turn gets to end before its session is closed anyway. */
  cancelGraceMs?: number;
  logger?: Logger;
}

/**
 * The integration lane (DESIGN §2). Fetches the frozen task through the
 * workload route, refuses it unless it parses with the shared schema, its
 * digest equals the assignment source's `specDigest`, and it names this
 * assignment's task and agent; then runs it: discovery model-free, setup
 * through the reviewed catalogue, every other phase in one gated session.
 * A genuine task that cannot be done here ends in a result with a stable
 * error; a task that does not match its assignment fails the assignment.
 */
/** The task the fetched workload carries, when it is exactly the one this assignment names. */
function assignedTask(assignment: IntegrationWorkAssignment, workload: WorkloadDefinition): z.infer<typeof IntegrationWorkloadSchema> {
  const invalid = (diagnostic: string) => new RemoteInstanceError("schema_invalid", "The integration task does not match its assignment.", { diagnostic });
  if (workload.kind !== "integration" || workload.assignmentId !== assignment.id || workload.attempt !== assignment.attempt) throw invalid("integration_workload_mismatch");
  const parsed = IntegrationWorkloadSchema.safeParse(workload.workload);
  if (!parsed.success) throw invalid("integration_spec_invalid");
  const task = parsed.data;
  if (integrationWorkloadDigest(task) !== assignment.source.specDigest) throw invalid("integration_spec_digest_mismatch");
  if (task.taskId !== assignment.source.taskId) throw invalid("integration_task_mismatch");
  if (task.agentId !== assignment.agentRoute.agentId) throw invalid("integration_agent_mismatch");
  return task;
}

export class IntegrationTaskCarrier implements IntegrationWorkCarrier {
  private readonly sessions = new Set<IntegrationSession>();
  private readonly logger: Logger;

  constructor(private readonly deps: IntegrationTaskCarrierDeps) {
    this.logger = deps.logger ?? createLogger({ name: "integration-carrier" });
  }

  async execute(assignment: IntegrationWorkAssignment, assertCurrent: () => void): Promise<IntegrationWorkOutcome> {
    const workload = await this.deps.fetchWorkload(assignment);
    assertCurrent();
    const task = assignedTask(assignment, workload);
    if ("kind" in task) {
      const result = await this.deps.setup.run(task, assertCurrent);
      return { structuredOutput: IntegrationSetupResultSchema.parse(result) as BoundedJsonValue };
    }
    const result = await this.runTask(assignment, task, assertCurrent);
    this.logger.info({ assignmentId: assignment.id, taskId: task.taskId, phase: task.phase, toolCalls: result.toolCalls.length,
      observations: result.observations.length, error: result.error?.code }, "integration task finished");
    return { structuredOutput: IntegrationTaskResultSchema.parse(result) as BoundedJsonValue };
  }
  async onRunnerEvent(event: RunnerEvent): Promise<void> {
    for (const session of this.sessions) await session.onRunnerEvent(event);
  }

  private async runTask(assignment: IntegrationWorkAssignment, spec: IntegrationTaskSpec, assertCurrent: () => void): Promise<IntegrationTaskResult> {
    const base = { schemaVersion: 1 as const, taskId: spec.taskId, phase: spec.phase, toolCalls: [], observations: [] };
    try {
      if (!INTEGRATION_AGENT_IDS.has(spec.agentId)) throw new IntegrationTaskError("operation_unsupported", { reason: "agent" });
      if (spec.phase === "discover") {
        const inventory = await this.deps.discovery.discover(spec.agentId);
        return IntegrationTaskResultSchema.parse({ ...base, inventory });
      }
      const session = this.openSession(assignment, spec);
      this.sessions.add(session);
      try { return await session.run(assertCurrent); }
      finally { this.sessions.delete(session); }
    } catch (error) {
      if (error instanceof IntegrationTaskError) return IntegrationTaskResultSchema.parse({ ...base, error: error.toResultError() });
      throw error;
    }
  }

  private openSession(assignment: IntegrationWorkAssignment, spec: IntegrationTaskSpec): IntegrationSession {
    const runner = this.deps.runners().get(spec.agentId);
    if (!runner) throw new IntegrationTaskError("runtime_offline", { reason: "agent_runner" });
    return new IntegrationSession(assignment, spec, {
      runner,
      instanceId: this.deps.instanceId(),
      workspaceRoot: this.deps.workspaceRoot(spec.agentId),
      writes: this.deps.writes,
      e2eFixtures: this.deps.e2eFixtures,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.onUsage ? { onUsage: this.deps.onUsage } : {}),
      ...(this.deps.cancelGraceMs !== undefined ? { cancelGraceMs: this.deps.cancelGraceMs } : {}),
      logger: this.logger,
    });
  }}
