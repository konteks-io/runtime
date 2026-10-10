import { AgentSkillReadObservationSchema, RemoteInstanceError, type AgentSkillReadObservation } from "@konteks/remote-common";
import type { PendingRequest } from "../state/journal.js";

export interface NativeSkillLoad {
  acpSessionRef: string;
  requestId: string;
  loadId: string;
  readOnlyRoots: readonly string[];
  observedAt: string;
}

/** The native plugin supplies only load identity; execution dimensions come from durable signed admission. */
export function nativeSkillLoadObservations(request: PendingRequest | undefined, load: NativeSkillLoad,
  skills: readonly { skillId: string; version: string }[]): AgentSkillReadObservation[] {
  if (!request || request.method !== "session/prompt" || request.closedAt !== null ||
    request.authorization?.state !== "dispatch_started" || request.acpSessionRef !== load.acpSessionRef || request.id !== load.requestId) {
    throw new RemoteInstanceError("execution_fenced", "Completed Skill load has no admitted native turn.");
  }
  const authority = request.authorization.claims;
  const turnId = admittedTurnId(authority);
  return skills.map(skill => AgentSkillReadObservationSchema.parse({
    kind: "skill_read_completed", eventId: `${load.loadId}:${skill.skillId}`, toolCallId: `native-context:${load.loadId}`,
    turnId, capabilityId: skill.skillId, version: skill.version, observedAt: load.observedAt,
    instanceId: authority.instanceId, agentId: authority.agentId, executionId: authority.executionId,
    sessionId: authority.sessionId, assignmentId: authority.assignmentId, attempt: authority.attempt,
    claimId: authority.claimId, recoveryEpoch: authority.recoveryEpoch, readyRevision: authority.readyRevision,
    runnerIncarnation: authority.runnerIncarnation, acpSessionRef: authority.acpSessionRef,
    executionRevision: authority.executionRevision, leaseSetId: authority.leaseSetId,
  }));
}

function admittedTurnId(authority: NonNullable<PendingRequest["authorization"]>["claims"]): string {
  return "deliveryIdentity" in authority ? authority.deliveryIdentity.invocationId : authority.turnRef;
}
