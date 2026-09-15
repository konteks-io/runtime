import { expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof, type NativeCancellationReceipt } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

const receipt: NativeCancellationReceipt = { kind: "durable_received", tenantId: "tenant", instanceId: "instance",
  runnerIncarnation: "runner", connectionEpoch: 2, intentId: "intent", intentDigest: "a".repeat(43),
  receivedAt: "2026-09-10T00:00:00.000Z" };
function fixture(patch: Record<string, unknown> = {}, duringRequest?: () => void) {
  const key = generateInstanceKey();
  const credential = vi.fn(() => { throw new Error("No holder bearer allowed"); });
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const { proof, ...body } = JSON.parse(String(init?.body));
    duringRequest?.();
    return new Response(JSON.stringify({ ...body, disposition: "accepted", requestNonce: proof.nonce,
      acceptedAt: receipt.receivedAt, ...patch }), { status: 200 });
  });
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(receipt.receivedAt)),
    key: () => key, credential, fetchFn });
  return { client, key, credential, fetchFn };
}

it("signs the complete persistence receipt with a dedicated proof and a fresh nonce on each explicit retry", async () => {
  const f = fixture();
  const result = await f.client.acknowledgeCancellation(receipt);
  await f.client.acknowledgeCancellation(receipt);
  const [url, init] = f.fetchFn.mock.calls[0]!;
  expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/cancellations/receipt");
  const { proof, ...body } = JSON.parse(String(init?.body));
  expect(body).toEqual(receipt);
  expect(verifyInstanceProof(f.key.publicKey, { method: "cancellation_receipt", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
  expect(verifyInstanceProof(f.key.publicKey, { method: "assignment_ack", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(false);
  for (const changed of [{ ...body, intentId: "foreign" }, { ...body, tenantId: "foreign" },
    { ...body, connectionEpoch: 3 }, { ...body, runnerIncarnation: "replacement" },
    { ...body, intentDigest: "b".repeat(43) }]) {
    expect(verifyInstanceProof(f.key.publicKey, { method: "cancellation_receipt", audience: CORE_AUDIENCE, subject: "instance", body: changed }, proof)).toBe(false);
  }
  expect(result.requestNonce).toBe(proof.nonce);
  expect(JSON.parse(String(f.fetchFn.mock.calls[1]![1]?.body)).proof.nonce).not.toBe(proof.nonce);
  expect(f.credential).not.toHaveBeenCalled();
});

it.each([
  { tenantId: "foreign" }, { instanceId: "foreign" }, { runnerIncarnation: "other" },
  { connectionEpoch: 3 }, { intentId: "foreign" }, { intentDigest: "b".repeat(43) },
  { receivedAt: "2026-09-10T00:00:01.000Z" }, { requestNonce: "b".repeat(22) },
  { disposition: "stopped" }, { stoppedAt: receipt.receivedAt },
])("rejects mismatched or extended receipt response without transparent retry: %j", async patch => {
  const f = fixture(patch);
  await expect(f.client.acknowledgeCancellation(receipt)).rejects.toThrow();
  expect(f.fetchFn).toHaveBeenCalledTimes(1);
});

it("compares with a detached validated snapshot rather than mutable caller state", async () => {
  const input = { ...receipt };
  const f = fixture({ disposition: "already_accepted" }, () => { input.intentId = "mutated"; });
  await expect(f.client.acknowledgeCancellation(input)).resolves.toMatchObject({ intentId: "intent", disposition: "already_accepted" });
});

it("refuses malformed caller evidence before signing or network I/O", async () => {
  const f = fixture();
  await expect(f.client.acknowledgeCancellation({ ...receipt, intentDigest: "invalid" })).rejects.toThrow();
  expect(f.fetchFn).not.toHaveBeenCalled();
});
