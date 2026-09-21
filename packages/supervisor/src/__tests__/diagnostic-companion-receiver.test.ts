import { describe, expect, it, vi } from "vitest";
import { DiagnosticCompanionReceiver } from "../control/diagnostic-companion-receiver.js";

const request = {
  schemaVersion: "diagnostic-carrier-companion-delivery-v1",
  type: "runtime_diagnostic_carrier_companion_delivery",
  method: "POST",
  path: { instanceId: "instance" },
  nodeId: "node",
  connectionRef: "connection",
  connectionEpoch: 1,
  companion: {
    schemaVersion: "diagnostic-carrier-companion-v1",
    deliveryId: "delivery",
    match: { assignmentId: "assignment", attempt: 1, executionSessionId: "session", invocationId: "invocation", dispatchGeneration: 2 },
    capabilityOffer: { schemaVersion: "diagnostic-carrier-capability-offer-v1", capabilities: ["diagnostic-carrier-v1"] },
    carrier: {
      schemaVersion: "diagnostic-carrier-v1",
      context: { schemaVersion: "observability-context-v1", traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01", tenantId: "workspace", assignmentId: "assignment", attempt: 1, invocationId: "invocation" },
      build: { service: "core", component: "admission", sourceRevision: "a".repeat(40) },
      protocol: { remoteInstanceProtocolVersion: "2.0" },
    },
  },
  keyId: "control",
  nonce: "N".repeat(22),
  issuedAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-21T00:01:00.000Z",
  signature: "A".repeat(86),
} as const;

describe("diagnostic companion receiver observation", () => {
  it("notifies the diagnostic observer only after retention and isolates observer failure", async () => {
    const retained = { companion: request.companion, deliveryDigest: "a".repeat(43), runnerIncarnation: "runtime", nodeId: "node", connectionRef: "connection", connectionEpoch: 1, receivedAt: "2026-09-21T00:00:00.000Z", version: 1 } as const;
    const receiveVerified = vi.fn(async () => retained);
    const onAccepted = vi.fn(async () => { throw new Error("telemetry unavailable"); });
    const receiver = new DiagnosticCompanionReceiver({
      verifier: { verifyDiagnosticCarrierCompanionDelivery: () => true },
      inbox: { receiveVerified },
      onAccepted,
      now: () => Date.parse("2026-09-21T00:00:30.000Z"),
      captureConnection: () => ({ instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "runtime", nodeId: "node", connectionRef: "connection", connectionEpoch: 1, assertCurrent: () => {} }),
    });

    await expect(receiver.receive(request)).resolves.toEqual(retained);
    expect(receiveVerified).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith(retained);
  });
});
