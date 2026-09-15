import { expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

const at = "2026-09-06T00:00:00.000Z";
function fixture(patch: Record<string, unknown> = {}) {
  const key = generateInstanceKey();
  const credential = vi.fn(() => { throw new Error("No bearer required"); });
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ instanceId: "instance", channelId: "assignment:instance", requestNonce: request.proof.nonce,
      requestAck: { kind: "ack", origin: "core", dataDirection: "to_core", channelId: "assignment:instance", cumulativeSeq: 0, issuedAt: at },
      committedRequestSequence: 0, observedRequestAckSequence: 0, retiredThroughRequestSequence: 0,
      allocatedReplySequence: 0, consumedReplySequence: 0, ...patch }), { status: 200 });
  });
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(at)), key: () => key, credential, fetchFn });
  return { client, key, credential, fetchFn };
}

it("binds the explicit zero-prefix ACK to this exact signed HTTPS exchange", async () => {
  const f = fixture();
  const result = await f.client.acknowledgeAssignments("instance", { observedRequestAckSequence: 0, consumedReplySequence: 0 });
  await f.client.acknowledgeAssignments("instance", { observedRequestAckSequence: 0, consumedReplySequence: 0 });
  const [url, init] = f.fetchFn.mock.calls[0]!;
  expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/assignments/stream/ack");
  const { proof, ...body } = JSON.parse(String(init?.body));
  expect(verifyInstanceProof(f.key.publicKey, { method: "assignment_ack", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
  expect(result.requestNonce).toBe(proof.nonce);
  expect(JSON.parse(String(f.fetchFn.mock.calls[1]![1]?.body)).proof.nonce).not.toBe(proof.nonce);
  expect(f.credential).not.toHaveBeenCalled();
});

it.each([
  { requestNonce: "a".repeat(22) },
  { instanceId: "foreign" },
  { channelId: "assignment:foreign", requestAck: { kind: "ack", origin: "core", dataDirection: "to_core", channelId: "assignment:foreign", cumulativeSeq: 0, issuedAt: at } },
  { requestAck: undefined },
])("rejects an uncorrelated or absent explicit Core ACK %j without retry", async patch => {
  const f = fixture(patch);
  await expect(f.client.acknowledgeAssignments("instance", { observedRequestAckSequence: 0, consumedReplySequence: 0 })).rejects.toThrow();
  expect(f.fetchFn).toHaveBeenCalledTimes(1);
});
