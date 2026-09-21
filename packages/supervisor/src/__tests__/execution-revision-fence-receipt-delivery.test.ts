import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeExecutionRevisionFenceReceipt } from "@konteks/remote-common";
import { FixedClock, computeExecutionRevisionControlIntentDigest } from "@konteks/remote-common";
import { ExecutionRevisionFenceReceiptDelivery } from "../control/execution-revision-fence-receipt-delivery.js";
import { DurableOutbox } from "../state/outbox.js";

let dir = "";
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const intent = {
    schemaVersion: "remote-execution-revision-control-v1", negotiatedCapability: "execution-revision-control-v1",
    intentId: "intent", tenantId: "tenant", instanceId: "instance", executionId: "execution", executionRevision: 1,
    checkId: "check", policyRevision: null, connectionRef: "connection", connectionEpoch: 2,
    reason: "authority_revoked", issuedAt: "2026-09-21T00:00:00.000Z", deadlineAt: "2026-09-21T00:00:02.000Z",
  } as const;
const receipt: NativeExecutionRevisionFenceReceipt = {
  kind: "execution_revision_fenced", intent,
  intentDigest: computeExecutionRevisionControlIntentDigest(intent), runnerIncarnation: "runner", connectionRef: "connection", connectionEpoch: 2,
  fencedAt: "2026-09-21T00:00:01.000Z",
};
const request = { ...receipt, proof: { algorithm: "ES256" as const, nonce: "N".repeat(22), signature: "A".repeat(86) } };

describe("execution revision fence receipt delivery", () => {
  it("retains one exact proof-bearing receipt before send and replays those bytes after restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "fence-receipt-"));
    const clock = new FixedClock(Date.parse(receipt.fencedAt));
    const firstOutbox = new DurableOutbox(dir); await firstOutbox.load();
    const firstCore = {
      createExecutionRevisionFenceReceiptRequest: vi.fn(() => request),
      submitExecutionRevisionFenceReceipt: vi.fn(async () => { throw new Error("response lost"); }),
    };
    const first = new ExecutionRevisionFenceReceiptDelivery({ outbox: firstOutbox, core: firstCore as never, clock, canSend: () => true });
    await first.submit(receipt);
    await first.settle();
    expect(firstOutbox.all("control").map(item => item.body)).toEqual([request]);

    const restartedOutbox = new DurableOutbox(dir); await restartedOutbox.load();
    const restartedCore = {
      createExecutionRevisionFenceReceiptRequest: vi.fn(() => { throw new Error("must replay durable bytes"); }),
      submitExecutionRevisionFenceReceipt: vi.fn(async () => ({ ...receipt, disposition: "already_accepted", requestNonce: request.proof.nonce, acceptedAt: receipt.fencedAt })),
    };
    const restarted = new ExecutionRevisionFenceReceiptDelivery({ outbox: restartedOutbox, core: restartedCore as never, clock, canSend: () => true });
    await restarted.flush();
    expect(restartedCore.createExecutionRevisionFenceReceiptRequest).not.toHaveBeenCalled();
    expect(restartedCore.submitExecutionRevisionFenceReceipt).toHaveBeenCalledWith(request);
    expect(restartedOutbox.depth).toBe(0);
  });
});
