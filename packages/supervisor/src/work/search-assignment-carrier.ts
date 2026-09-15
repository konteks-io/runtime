import { RemoteInstanceError, jcsDigest, type Clock, type JsonValue, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { SupervisorJournal } from "../state/journal.js";
import type { LocalAdmission } from "../state/local-admission.js";

export type SearchAssignment = RemoteWorkAssignment & { kind: "search_generation" };

export interface SearchClaimedHandoff {
  assignment: SearchAssignment;
  admission: LocalAdmission;
}

export interface SearchControllerBoundary {
  /** Durably accept the chosen claim without opening ACP/config/prompt locally. */
  acceptClaimed(input: SearchClaimedHandoff): Promise<void>;
}

/** Native durable handoff to the hosted Search controller boundary. */
export class DurableSearchAssignmentCarrier implements SearchControllerBoundary {
  constructor(private readonly journal: SupervisorJournal, private readonly clock: Clock) {}

  async acceptClaimed(input: SearchClaimedHandoff): Promise<void> {
    const { assignment, admission } = input;
    if (assignment.kind !== "search_generation" || assignment.id !== admission.assignmentId ||
      assignment.attempt !== admission.attempt || assignment.instanceId !== admission.instanceId ||
      assignment.workspaceId !== admission.workspaceId || assignment.agentRoute.agentId !== admission.agentId) {
      throw new RemoteInstanceError("recovery_required", "Search claim handoff identity changed.");
    }
    const start = this.journal.execution.start(admission.assignmentId, admission.attempt);
    if (!start || jcsDigest(start.assignment as JsonValue) !== jcsDigest(assignment as JsonValue) ||
      jcsDigest(start.admission as JsonValue) !== jcsDigest(admission as JsonValue) || start.claimEffect?.state !== "applying") {
      throw new RemoteInstanceError("recovery_required", "Search claim has no exact durable accepted-reply handoff.");
    }
    await this.journal.assignments.update(`${assignment.id}:${assignment.attempt}`, existing => {
      if (!existing || existing.kind !== "search_generation" || existing.claimId !== admission.claimId ||
        existing.assignmentId !== assignment.id || existing.attempt !== assignment.attempt ||
        existing.placementId !== assignment.placementId || existing.workspaceId !== assignment.workspaceId ||
        existing.agentId !== assignment.agentRoute.agentId ||
        (existing.state !== "claimed" && existing.state !== "running")) {
        throw new RemoteInstanceError("recovery_required", "Search controller handoff projection changed.");
      }
      return existing.state === "running" ? existing : { ...existing, state: "running", updatedAt: this.clock.nowIso() };
    });
  }
}

export function isSearchAssignment(assignment: RemoteWorkAssignment): assignment is SearchAssignment {
  return assignment.kind === "search_generation";
}
