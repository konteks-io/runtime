import { ObservabilityContextV1Schema } from "@konteks/backstage-plugin-common";
import type { DiagnosticCompanionInboxRecord } from "../state/diagnostic-companion-inbox.js";

interface ActiveDiagnosticCompanionOperation {
  assignmentId: string;
  attempt: number;
  claimId: string;
  executionId: string;
  runtimeIncarnationId: string;
}

function coverageGapReason(
  record: DiagnosticCompanionInboxRecord,
  operation: ActiveDiagnosticCompanionOperation | null,
): string | null {
  const { match } = record.companion;
  const carrier = record.companion.carrier.context;
  if (!operation) return "operation_not_active";
  if (operation.assignmentId !== match.assignmentId || operation.attempt !== match.attempt) {
    return "operation_identity_mismatch";
  }
  if (operation.runtimeIncarnationId !== record.runnerIncarnation) {
    return "runtime_incarnation_mismatch";
  }
  if (carrier.assignmentId !== match.assignmentId || carrier.attempt !== match.attempt ||
      carrier.invocationId !== match.invocationId) {
    return "carrier_identity_mismatch";
  }
  return null;
}

/**
 * Converts a retained diagnostic companion into an operational event only when its
 * assignment identity can still be joined to the local active operation.
 * This is diagnostic-only: callers must never use its result for authority,
 * routing, idempotency, or delivery decisions.
 */
export function diagnosticCompanionOperationalObservation(
  record: DiagnosticCompanionInboxRecord,
  operation: ActiveDiagnosticCompanionOperation | null,
) {
  const { companion } = record;
  const match = companion.match;
  const carrier = companion.carrier.context;
  const reason = coverageGapReason(record, operation);
  if (reason !== null || operation === null) {
    return {
      event: "runtime.diagnostic_companion.coverage_incomplete" as const,
      outcome: "unknown" as const,
      reason: reason ?? "operation_not_active",
      deliveryId: companion.deliveryId,
      deliveryDigest: record.deliveryDigest,
      assignmentId: match.assignmentId,
      attempt: match.attempt,
    };
  }

  return {
    event: "runtime.diagnostic_companion.persisted" as const,
    outcome: "succeeded" as const,
    // Correlate logs with the exported parent. A random local span id would
    // imply an exported runtime span that this log-only boundary does not own.
    context: ObservabilityContextV1Schema.parse({
      ...carrier,
      runtimeIncarnationId: operation.runtimeIncarnationId,
      assignmentId: operation.assignmentId,
      attempt: operation.attempt,
      claimId: operation.claimId,
      executionId: operation.executionId,
    }),
    diagnosticCompanion: {
      deliveryId: companion.deliveryId,
      deliveryDigest: record.deliveryDigest,
      match: {
        executionSessionId: match.executionSessionId,
        invocationId: match.invocationId,
        dispatchGeneration: match.dispatchGeneration,
      },
      source: {
        service: companion.carrier.build.service,
        component: companion.carrier.build.component,
        sourceRevision: companion.carrier.build.sourceRevision,
        remoteInstanceProtocolVersion: companion.carrier.protocol.remoteInstanceProtocolVersion,
      },
    },
  };
}
