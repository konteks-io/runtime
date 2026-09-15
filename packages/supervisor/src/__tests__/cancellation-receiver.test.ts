import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { generateEd25519, ed25519Sign, remoteControlSigningBytes, generateInstanceKey, FixedClock, verifyInstanceProof, type JsonValue } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";
import { SupervisorJournal } from "../state/journal.js";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { CancellationReceiver } from "../control/cancellation-receiver.js";
import type { CancellationInboxRecord } from "../state/cancellation-inbox.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cancellation-receiver-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function fixture(core?: CoreClient, onPersisted?: (record: CancellationInboxRecord) => void) {
  const journal = new SupervisorJournal(dir); await journal.load();
  const key = generateEd25519();
  const verifier = new CoreSignatureVerifier([{ keyId: "release", publicKeyJwk: generateEd25519().publicJwk,
    coreControlKeys: [{ keyId: "control", publicKeyJwk: key.publicJwk }] }]);
  const now = Date.parse("2026-09-10T00:00:00.000Z");
  const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: new Date(now).toISOString() };
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, instanceId: "instance", workspaceId: "tenant", exchangeNonce: "exchange" });
  await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1,
    admission: { instanceId: "instance", workspaceId: "tenant", runnerIncarnation: "runner", assignmentId: "assignment",
      attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: seed.createdAt },
    assignment: { id: "assignment", kind: "assistant_execution", placementId: "placement", instanceId: "instance", workspaceId: "tenant",
      taskId: "turn", correlationId: "correlation", attempt: 1, expiresAt: new Date(now + 60000).toISOString(), requiredCapabilities: [],
      agentRoute: { requiredRole: "assistant", agentId: "codex" },
      source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: "turn" },
      policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [],
        recoveryMode: "report_interrupted", latestResumeAt: new Date(now + 60000).toISOString(), permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true } },
    evidenceUpload: "structured_only", projectionCreatedAt: seed.createdAt, claimCreatedAt: seed.createdAt }, () => {});
  const scope = { instanceId: "instance", workspaceId: "tenant", runnerIncarnation: "runner", connectionEpoch: 2,
    leaseExpiresAt: new Date(now + 60000).toISOString(), assertCurrent: vi.fn() };
  const clock = { now };
  const receiver = new CancellationReceiver({ verifier, inbox: journal.cancellations, claims: journal.execution,
    ...(core ? { core } : {}),
    ...(onPersisted ? { onPersisted } : {}),
    captureConnection: () => ({ ...scope }), now: () => clock.now });
  const sign = (body: Record<string, JsonValue>) => ({ ...body, signature: ed25519Sign(key.privateKey, remoteControlSigningBytes(body)) });
  const intent = { intentId: "intent", tenantId: "tenant", instanceId: "instance", sessionId: "session", claimId: "claim", delegationRef: "delegation",
    directive: sign({ assignmentId: "assignment", attempt: 1, reason: "policy_denied", issuedAt: seed.createdAt }) };
  const make = (overrides: Record<string, JsonValue> = {}) => sign({ type: "runtime_cancellation_delivery", method: "POST", path: { instanceId: "instance" },
    nodeId: "node", connectionRef: "connection", connectionEpoch: 2, intent, keyId: "control", nonce: "N".repeat(22),
    issuedAt: seed.createdAt, expiresAt: new Date(now + 30000).toISOString(), ...overrides });
  return { journal, receiver, make, intent, scope, clock };
}
describe("native cancellation receiver admission", () => {
  function receiptTransport() {
    const key = generateInstanceKey();
    const state = { fail: false, afterSubmit: () => {} };
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const { proof, ...body } = JSON.parse(String(init?.body));
      expect(verifyInstanceProof(key.publicKey, { method: "cancellation_receipt", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
      // Reopen actual storage at the network boundary: memory-only admission
      // must never be sufficient to send an authenticated persistence receipt.
      const restarted = new SupervisorJournal(dir); await restarted.load();
      expect(restarted.cancellations.pending()).toEqual([expect.objectContaining({ intentDigest: body.intentDigest, receivedAt: body.receivedAt })]);
      state.afterSubmit();
      if (state.fail) return new Response(JSON.stringify({ code: "registration_mismatch", message: "refused" }), { status: 400 });
      return new Response(JSON.stringify({ ...body, disposition: "accepted", requestNonce: proof.nonce, acceptedAt: body.receivedAt }), { status: 200 });
    });
    const core = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-10T00:00:00.000Z")),
      key: () => key, credential: () => { throw new Error("No holder bearer"); }, fetchFn });
    return { core, fetchFn, state };
  }

  it("submits real machine-signed receipts only after durable storage and resends the original on duplicate delivery", async () => {
    const transport = receiptTransport(); const f = await fixture(transport.core);
    const first = await f.receiver.receive(f.make());
    f.clock.now += 10;
    const duplicate = await f.receiver.receive(f.make({ nonce: "B".repeat(22) }));
    expect(duplicate).toEqual(first); expect(transport.fetchFn).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(transport.fetchFn.mock.calls[0]?.[1]?.body));
    const secondRequest = JSON.parse(String(transport.fetchFn.mock.calls[1]?.[1]?.body));
    expect(firstRequest.receivedAt).toBe(secondRequest.receivedAt);
    expect(firstRequest.proof.nonce).not.toBe(secondRequest.proof.nonce);
    expect(f.journal.cancellations.pending()).toEqual([first]);
    expect(first).not.toHaveProperty("stoppedAt");
  });

  it("notifies the synchronous stop fence after persistence and before receipt submission", async () => {
    const calls: string[] = [];
    const transport = receiptTransport(); transport.state.afterSubmit = () => { calls.push("receipt"); };
    const onPersisted = vi.fn((_record: CancellationInboxRecord) => { calls.push("fence"); });
    const f = await fixture(transport.core, onPersisted);
    const record = await f.receiver.receive(f.make());
    expect(calls).toEqual(["fence", "receipt"]);
    expect(onPersisted).toHaveBeenCalledWith(record);
    expect(f.journal.cancellations.pending()).toEqual([record]);
  });

  it("retains persisted evidence after receipt refusal and allows a new explicit delivery to retry", async () => {
    const transport = receiptTransport(); transport.state.fail = true;
    const f = await fixture(transport.core);
    await expect(f.receiver.receive(f.make())).rejects.toThrow();
    const persisted = f.journal.cancellations.pending()[0]; expect(persisted).toBeDefined();
    transport.state.fail = false;
    await expect(f.receiver.receive(f.make({ nonce: "B".repeat(22) }))).resolves.toEqual(persisted);
    expect(f.journal.cancellations.pending()).toEqual([persisted]);
  });

  it("does not transfer ownership when the socket changes during receipt submission", async () => {
    const transport = receiptTransport(); const f = await fixture(transport.core);
    transport.state.afterSubmit = () => { f.scope.assertCurrent.mockImplementation(() => { throw new Error("replacement socket"); }); };
    await expect(f.receiver.receive(f.make())).rejects.toThrow("replacement socket");
    expect(f.journal.cancellations.pending()).toHaveLength(1);
  });

  it("verifies real signatures against retained claim/session and returns durable storage only", async () => {
    const f = await fixture(); const record = await f.receiver.receive(f.make());
    expect(record.intent.claimId).toBe("claim");
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.cancellations.pending()).toEqual([record]);
    expect(record).not.toHaveProperty("stoppedAt");
  });
  it("rejects unknown key IDs, tampered outer signature and invalid inner control", async () => {
    const f = await fixture();
    for (const request of [f.make({ keyId: "unknown" }), { ...f.make(), nonce: "B".repeat(22) },
      f.make({ intent: { ...f.intent, directive: { ...f.intent.directive, signature: "AA" } } })]) {
      await expect(f.receiver.receive(request)).rejects.toMatchObject({ code: "permission_denied" });
    }
    expect(f.journal.cancellations.pending()).toEqual([]);
  });
  it.each(["tenantId", "sessionId", "claimId"])("rejects signed foreign %s", async field => {
    const f = await fixture();
    await expect(f.receiver.receive(f.make({ intent: { ...f.intent, [field]: "foreign" } }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.journal.cancellations.pending()).toEqual([]);
  });
  it("refuses expired or wrong-epoch delivery and mismatched runner ownership", async () => {
    const f = await fixture();
    await expect(f.receiver.receive(f.make({ connectionEpoch: 3 }))).rejects.toMatchObject({ code: "recovery_required" });
    f.scope.runnerIncarnation = "other";
    await expect(f.receiver.receive(f.make())).rejects.toMatchObject({ code: "recovery_required" });
    f.scope.runnerIncarnation = "runner"; const request = f.make(); f.clock.now += 31000;
    await expect(f.receiver.receive(request)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.journal.cancellations.pending()).toEqual([]);
  });
  it("withholds a stale receipt after fsync without discarding durable evidence", async () => {
    const f = await fixture();
    f.scope.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => {})
      .mockImplementation(() => { throw new Error("socket replaced"); });
    await expect(f.receiver.receive(f.make())).rejects.toThrow("socket replaced");
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.cancellations.pending()).toHaveLength(1);
  });
  it("refuses a delivery lifetime beyond its current lease", async () => {
    const f = await fixture(); f.scope.leaseExpiresAt = new Date(f.clock.now + 10000).toISOString();
    await expect(f.receiver.receive(f.make())).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.journal.cancellations.pending()).toEqual([]);
  });
});
