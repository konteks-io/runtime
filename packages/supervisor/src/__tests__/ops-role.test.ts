import { describe, expect, it } from "vitest";
import type { ConnectedAgentView } from "@konteks/remote-common";
import { deriveAdvertisedRoles, operationsCarrierReady } from "../inventory/roles.js";

const codex: ConnectedAgentView = {
  agentId: "codex", displayName: "Codex", connectionState: "ready", readiness: "ready",
  authMode: "agent_local_subscription", accountScope: "personal", tokenUsageObservable: true,
  acpCapabilities: { sessionResume: true, forkSession: false, structuredOutputShim: true, toolControl: "approve" },
};
const bindings = [{ role: "ops" as const, agentPreference: ["codex"] }];
const healthyCarrier = { components: [{ kind: "agent_runner", healthStatus: "healthy", capabilities: ["agent:codex", "execution-permits-v1"] }] };

describe("native Operations role admission", () => {
  it.each([
    ["7.2", true, true],
    ["7.1", true, false],
    [undefined, true, false],
    [null, true, false],
    ["7.2", false, false],
  ] as const)("requires Core %s and a healthy signed execution carrier", (coreContractVersion, carrierReady, expected) => {
    const snapshot = carrierReady ? healthyCarrier : { components: [] };
    const inputs = { browserToolAvailable: false, operationsCarrierReady: operationsCarrierReady(snapshot, coreContractVersion) };
    expect(deriveAdvertisedRoles(bindings, [codex], inputs)).toEqual(expected ? ["ops"] : []);
  });

  it.each([
    [{ ...healthyCarrier.components[0]!, healthStatus: "degraded" }],
    [{ ...healthyCarrier.components[0]!, healthStatus: "unhealthy" }],
    [{ ...healthyCarrier.components[0]!, kind: "validation_runtime" }],
    [{ ...healthyCarrier.components[0]!, capabilities: ["agent:codex"] }],
  ])("does not treat an incomplete or unhealthy component as the Ops carrier", component => {
    expect(operationsCarrierReady({ components: [component] }, "7.2")).toBe(false);
  });

  it("requires the role-bound agent itself to be ready", () => {
    const inputs = { browserToolAvailable: false, operationsCarrierReady: operationsCarrierReady(healthyCarrier, "7.2") };
    expect(deriveAdvertisedRoles(bindings, [{ ...codex, readiness: "unavailable" }], inputs)).toEqual([]);
    expect(deriveAdvertisedRoles([{ ...bindings[0]!, agentPreference: ["claude-code"] }], [codex], inputs)).toEqual([]);
  });
});
