import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const request = {
  instanceId: "instance", deploymentKind: "native_connector" as const,
  bundleVersion: "0.1.0", protocolVersion: "1.0", manifestDigest: "A".repeat(43),
  components: [{ kind: "agent_runner" as const, version: "0.1.0", capabilities: [], health: "healthy" as const }] as [{ kind: "agent_runner"; version: string; capabilities: []; health: "healthy" }],
};
const response = {
  instanceId: "instance", administrativeStatus: "active", lease: "test-lease",
  leaseExpiresAt: "2026-09-09T20:00:00Z", leaseMode: "active", heartbeatIntervalSeconds: 30,
};
function client(body: unknown) {
  return new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-09T19:00:00Z")), key: () => generateInstanceKey(), credential: () => "test-provisioning-credential", fetchFn: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) });
}
describe("Core readiness response boundary", () => {
  it("accepts Core's initial and idempotent readiness response metadata", async () => {
    await expect(client(response).submitReadiness(request)).resolves.toEqual(response);
  });
  it.each([{ ...response, leaseMode: "unrestricted" }, { ...response, heartbeatIntervalSeconds: 0 }, { ...response, unexpected: true }])("rejects invalid or unknown metadata", async body => {
    await expect(client(body).submitReadiness(request)).rejects.toThrow();
  });
});
