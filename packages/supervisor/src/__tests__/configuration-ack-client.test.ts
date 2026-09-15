import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, jcsDigest } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const ack = { type: "desired_configuration_ack", instanceId: "instance", revision: 3, digest: "A".repeat(43), status: "applied", acknowledgedAt: "2026-09-06T00:00:00Z", signature: "A".repeat(86) };
function fixture(response: object) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(response), { status: 202, headers: { "content-type": "application/json" } }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(ack.acknowledgedAt)), key: () => generateInstanceKey(), credential: () => "fixture-credential", fetchFn });
  return { client, fetchFn };
}
describe("configuration acknowledgement HTTPS response", () => {
  it("returns a correlated supersession receipt without claiming acceptance", async () => {
    const receipt = { instanceId: ack.instanceId, revision: ack.revision, status: "superseded", requestDigest: jcsDigest(ack), appliedRevision: 4 };
    await expect(fixture(receipt).client.controlAck("instance", ack)).resolves.toEqual(receipt);
  });
  it.each([{ requestDigest: "B".repeat(43) }, { appliedRevision: 2 }, { appliedRevision: 3 }, { instanceId: "foreign" }, { revision: 2 }, { unexpected: true }])("rejects unrelated or non-dominating supersession receipts", async change => {
    await expect(fixture({ instanceId: ack.instanceId, revision: ack.revision, status: "superseded", requestDigest: jcsDigest(ack), appliedRevision: 4, ...change }).client.controlAck("instance", ack)).rejects.toThrow();
  });
  it("accepts Core's actual correlated receipt instead of expecting a generic accepted boolean", async () => {
    const f = fixture({ instanceId: ack.instanceId, revision: ack.revision, status: ack.status });
    await expect(f.client.controlAck("instance", ack)).resolves.toBe(true);
    expect(f.fetchFn).toHaveBeenCalledOnce();
  });
  it.each([{ instanceId: "other", revision: 3, status: "applied" }, { instanceId: "instance", revision: 2, status: "applied" }, { instanceId: "instance", revision: 3, status: "rejected" }, { accepted: true }])("rejects uncorrelated receipts", async response => {
    await expect(fixture(response).client.controlAck("instance", ack)).rejects.toThrow();
  });
  it("does not send a different control variant to the configuration-only endpoint", async () => {
    const f = fixture({ accepted: true });
    await expect(f.client.controlAck("instance", { ...ack, type: "drain_ack" })).rejects.toMatchObject({ code: "protocol_incompatible" });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
});
