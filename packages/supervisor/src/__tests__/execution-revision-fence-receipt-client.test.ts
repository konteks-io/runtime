import { expect, it, vi } from "vitest";
import { FixedClock, computeExecutionRevisionControlIntentDigest, generateInstanceKey, verifyInstanceProof, type NativeExecutionRevisionFenceReceipt } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

const intent = { schemaVersion: "remote-execution-revision-control-v1", negotiatedCapability: "execution-revision-control-v1", intentId: "intent", tenantId: "tenant", instanceId: "instance", executionId: "execution", executionRevision: 1, checkId: "check", policyRevision: null, connectionRef: "connection", connectionEpoch: 2, reason: "authority_revoked", issuedAt: "2026-09-21T00:00:00.000Z", deadlineAt: "2026-09-21T00:00:02.000Z" } as const;
const receipt: NativeExecutionRevisionFenceReceipt = {
  kind: "execution_revision_fenced", intent,
  intentDigest: computeExecutionRevisionControlIntentDigest(intent), runnerIncarnation: "runner", connectionRef: "connection", connectionEpoch: 2, fencedAt: "2026-09-21T00:00:01.000Z",
};

it("submits the exact proof-bearing fence receipt and refuses a mismatched result", async () => {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ...receipt, disposition: "accepted", requestNonce: body.proof.nonce, acceptedAt: receipt.fencedAt }), { status: 200 });
  });
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(receipt.fencedAt)), key: () => key, credential: () => null, fetchFn });
  const request = client.createExecutionRevisionFenceReceiptRequest(receipt);
  await expect(client.submitExecutionRevisionFenceReceipt(request)).resolves.toMatchObject({ disposition: "accepted", requestNonce: request.proof.nonce });
  const [url, init] = fetchFn.mock.calls[0]!;
  expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/execution-revision-controls/receipt");
  expect(JSON.parse(String(init?.body))).toEqual(request);
  const { proof, ...body } = request;
  expect(verifyInstanceProof(key.publicKey, { method: "execution_revision_fence_receipt", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
});
