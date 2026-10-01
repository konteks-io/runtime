import { jcsDigest, type BoundedJsonValue, type JsonValue, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import { REMOTE_INTEGRATION_TASK_CAPABILITY } from "@konteks/backstage-plugin-common";

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
export const INTEGRATION_AGENT_IDS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/** `integration-task-v1` for the `agent_runner` component when a Claude Code or Codex runner is installed. */
export function integrationTaskCapabilities(agentIds: Iterable<string>): string[] {
  for (const agentId of agentIds) if (INTEGRATION_AGENT_IDS.has(agentId)) return [REMOTE_INTEGRATION_TASK_CAPABILITY];
  return [];
}
