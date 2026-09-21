import { describe, expect, it } from "vitest";
import type { DiagnosticCompanionInboxRecord } from "../state/diagnostic-companion-inbox.js";
import { diagnosticCompanionOperationalObservation } from "../control/diagnostic-companion-observability.js";

const record = {
  version: 1,
  deliveryDigest: "a".repeat(43),
  runnerIncarnation: "runtime-1",
  nodeId: "node",
  connectionRef: "connection",
  connectionEpoch: 1,
  receivedAt: "2026-09-21T00:00:01.000Z",
  companion: {
    schemaVersion: "diagnostic-carrier-companion-v1",
    deliveryId: "delivery",
    match: { assignmentId: "assignment", attempt: 1, executionSessionId: "session", invocationId: "invocation", dispatchGeneration: 2 },
    capabilityOffer: { schemaVersion: "diagnostic-carrier-capability-offer-v1", capabilities: ["diagnostic-carrier-v1"] },
    carrier: {
      schemaVersion: "diagnostic-carrier-v1",
      context: {
        schemaVersion: "observability-context-v1",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        tenantId: "tenant",
        assignmentId: "assignment",
        attempt: 1,
        invocationId: "invocation",
      },
      build: { service: "core", component: "admission", sourceRevision: "a".repeat(40) },
      protocol: { remoteInstanceProtocolVersion: "2.0" },
    },
  },
} as DiagnosticCompanionInboxRecord;

const active = {
  assignmentId: "assignment",
  attempt: 1,
  claimId: "claim",
  executionId: "execution",
  runtimeIncarnationId: "runtime-1",
};

describe("diagnostic companion operational observation", () => {
  it("links a retained companion to its matching active operation with a child trace", () => {
    const observation = diagnosticCompanionOperationalObservation(record, active);

    expect(observation).toMatchObject({
      event: "runtime.diagnostic_companion.persisted",
      outcome: "succeeded",
      observability: {
        assignmentId: "assignment",
        attempt: 1,
        claimId: "claim",
        executionId: "execution",
        runtimeIncarnationId: "runtime-1",
      },
      diagnosticCompanion: {
        deliveryId: "delivery",
        match: { executionSessionId: "session", invocationId: "invocation", dispatchGeneration: 2 },
      },
    });
    if (observation.event !== "runtime.diagnostic_companion.persisted") throw new Error("expected persisted observation");
    expect(observation.observability.traceparent.split("-")[1]).toBe("0123456789abcdef0123456789abcdef");
    expect(observation.observability.traceparent.split("-")[2]).not.toBe("0123456789abcdef");
  });

  it("makes an absent or mismatched operation an explicit coverage gap", () => {
    expect(diagnosticCompanionOperationalObservation(record, null)).toMatchObject({
      event: "runtime.diagnostic_companion.coverage_incomplete",
      outcome: "unknown",
      reason: "operation_not_active",
      deliveryId: "delivery",
    });
    expect(diagnosticCompanionOperationalObservation(record, { ...active, runtimeIncarnationId: "replacement" })).toMatchObject({
      event: "runtime.diagnostic_companion.coverage_incomplete",
      reason: "runtime_incarnation_mismatch",
    });
  });
});
