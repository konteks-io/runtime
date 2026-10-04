import { allEqual, RemoteExecutionReadyResultSchema, RemoteInstanceError, RemoteTransferBindingSchema, type Clock, type RemoteTransferBinding, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { JournalEntry, SupervisorJournal } from "../state/journal.js";
import { continuedSession } from "../work/continued-session.js";

interface NativeReadyOptions {
  clock: Clock;
  journal: SupervisorJournal;
  client: Pick<CoreClient, "registerExecutionReady">;
  instanceId: string;
  workspaceId: string;
  runnerIncarnation: string;
  /** Current root ownership, active lease and running supervisor, checked around IO. */
  assertActive: () => void;
}
const unavailable = () => new RemoteInstanceError("capability_unavailable", "The native claim is not authorized for execution readiness.");

/** States in which a claim may still register execution readiness. */
const READY_STATES = new Set(["claimed", "running", "checkpointed"]);

/** The binding names this runtime, this assignment and attempt, and a continued session's own id. */
function bindingMatches(assignment: RemoteWorkAssignment, binding: RemoteTransferBinding, options: NativeReadyOptions): boolean {
  const continued = continuedSession(assignment.source);
  return allEqual([
    [assignment.workspaceId, options.workspaceId],
    [assignment.instanceId, options.instanceId],
    [binding.workspaceId, options.workspaceId],
    [binding.instanceId, options.instanceId],
    [binding.assignmentId, assignment.id],
    [binding.attempt, assignment.attempt],
  ]) && (continued === null || binding.sessionId === continued.sessionId);
}

/**
 * The journal entry is this assignment's live claim. The local record starts
 * at the assignment's own expiry and moves only when Core renewed the turn:
 * it is the assignment's lifetime.
 */
function liveClaim(entry: JournalEntry | undefined, assignment: RemoteWorkAssignment, now: number): entry is JournalEntry {
  return entry !== undefined && allEqual([
    [entry.workspaceId, assignment.workspaceId],
    [entry.assignmentId, assignment.id],
    [entry.attempt, assignment.attempt],
    [entry.placementId, assignment.placementId],
    [entry.kind, assignment.kind],
    [entry.agentId, assignment.agentRoute.agentId],
  ]) && READY_STATES.has(entry.state) && Number.isFinite(Date.parse(entry.expiresAt)) && Number.isFinite(Date.parse(assignment.expiresAt)) && Date.parse(entry.expiresAt) > now;
}

function sameClaim(entry: JournalEntry, request: { claimId: string; recoveryEpoch: number }): boolean {
  return entry.claimId === request.claimId && entry.recoveryEpoch === request.recoveryEpoch;
}

/** Registration observes a live claim; it never issues permission to prompt. */
export function createNativeReadyRegistrar(options: NativeReadyOptions) {
  return async (assignment: RemoteWorkAssignment, expected: RemoteTransferBinding, acpSessionRef: string) => {
    const binding = RemoteTransferBindingSchema.parse(expected);
    if (!bindingMatches(assignment, binding, options)) throw unavailable();
    const key = `${assignment.id}:${assignment.attempt}`;
    const checked = (entry: JournalEntry | undefined): JournalEntry => {
      options.assertActive();
      if (!liveClaim(entry, assignment, options.clock.coreNow())) throw unavailable();
      return entry;
    };
    const initial = checked(options.journal.assignments.get(key));
    const request = { assignmentId: assignment.id, attempt: assignment.attempt, claimId: initial.claimId, recoveryEpoch: initial.recoveryEpoch, runnerIncarnation: options.runnerIncarnation, agentId: assignment.agentRoute.agentId, acpSessionRef };
    const localDeadlineAtMs = Date.now() + Math.max(0, Date.parse(initial.expiresAt) - options.clock.coreNow());
    const result = RemoteExecutionReadyResultSchema.parse(await options.client.registerExecutionReady(options.instanceId, request, localDeadlineAtMs));
    if (Object.entries({ ...binding, ...request }).some(([field, value]) => result[field as keyof typeof result] !== value)) throw unavailable();
    await options.journal.assignments.update(key, current => {
      const entry = checked(current);
      if (!sameClaim(entry, request)) throw unavailable();
      return { ...entry, executionReady: result, updatedAt: options.clock.nowIso() };
    });
    const persisted = checked(options.journal.assignments.get(key));
    if (!sameClaim(persisted, request) || persisted.executionReady?.readyRevision !== result.readyRevision) throw unavailable();
    return result;
  };
}
