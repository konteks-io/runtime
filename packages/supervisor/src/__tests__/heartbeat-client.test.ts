import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const message = { instanceId: "instance", sequence: 2, observedAt: "2026-09-06T00:00:00Z", components: [], agents: [], roles: [], roleBindings: [], utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 }, activeAssignmentIds: [], configRevision: 1, bundleVersion: "1.0.0", signature: "signed-heartbeat" };
const result = { instanceId: "instance", lease: "core-issued-lease", leaseExpiresAt: "2026-09-06T00:10:00Z", leaseMode: "active", roles: ["planner"], strippedRoles: [{ role: "qa", reason: "agent_capability_missing" }], configRevision: 1, heartbeatIntervalSeconds: 15 };
function fixture(response: object = result) {
  const fetchFn = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200 }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(message.observedAt)), key: () => generateInstanceKey(), credential: () => null, fetchFn });
  return { client, fetchFn };
}
describe("canonical HTTPS heartbeat response", () => {
  it("accepts the actual Core owner result without inventing acceptance or directives", async () => {
    const f = fixture();
    await expect(f.client.heartbeat(message)).resolves.toEqual(result);
    expect(String(f.fetchFn.mock.calls[0]![0])).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/heartbeat");
    expect(JSON.parse(String(f.fetchFn.mock.calls[0]![1]?.body))).toEqual(message);
  });
  it.each([{ instanceId: "foreign" }, { leaseMode: "drain_only" }, { leaseExpiresAt: "bad" }, { accepted: true }, { directives: [] }])("rejects mismatched or noncanonical result %j", async patch => {
    await expect(fixture({ ...result, ...patch }).client.heartbeat(message)).rejects.toThrow();
  });
  it("does not expose a nonexistent standalone lease-renewal operation", () => {
    expect("renewLease" in fixture().client).toBe(false);
  });
});
