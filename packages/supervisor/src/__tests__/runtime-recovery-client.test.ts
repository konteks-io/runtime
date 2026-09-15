import { NATIVE_TRANSIENT_MAX_ATTEMPTS } from "../native/transient-retry.js";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, jcsDigest, verifyInstanceProof, RemoteInstanceErrorCodeSchema } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

const at = "2026-09-06T00:00:00.000Z";
const hash = "a".repeat(43);
const owner = { instanceId: "instance", ownerRevision: 1, currentIncarnation: "process", acceptedHeartbeatSequence: 7, heartbeatSequenceFloor: 10 };
const semanticReceipt = { instanceId: "instance", runnerIncarnation: "process", manifestId: "manifest", decisionResults: [{ assignmentId: "assignment", attempt: 1, disposition: "interrupted" as const, terminalReportId: "report", terminalEvidence: { kind: "queued" as const, reportSequence: 1, payloadDigest: hash, terminalResultHash: hash } }], pendingClaimResults: [] };
const receipt = { ...semanticReceipt, connection: { kind: "https" as const } };
const accepted = { instanceId: "instance", runnerIncarnation: "process", manifestId: "manifest", receiptDigest: jcsDigest(semanticReceipt), acceptedAt: at, outcome: "accepted" };

function fixture(response: object = owner, status = 200) {
  const key = generateInstanceKey();
  // New machine-proof endpoints must work before a predecessor lease exists.
  const credential = vi.fn(() => { throw new Error("No predecessor bearer is available"); });
  const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(at)), key: () => key, credential, fetchFn });
  return { client, fetchFn, key, credential };
}

describe("native runtime owner resolution HTTPS boundary", () => {
  it("uses the exact route and a fresh ES256 proof without accessing a lease", async () => {
    const f = fixture();
    await expect(f.client.resolveRuntimeOwner("instance")).resolves.toEqual(owner);
    await f.client.resolveRuntimeOwner("instance");
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/runtime-owner/resolve");
    expect(init?.method).toBe("POST");
    expect(init?.headers).not.toHaveProperty("authorization");
    const { proof, ...body } = JSON.parse(String(init?.body));
    expect(body).toEqual({ instanceId: "instance" });
    expect(verifyInstanceProof(f.key.publicKey, { method: "runtime_owner_resolve", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
    expect(verifyInstanceProof(f.key.publicKey, { method: "reconnect", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(false);
    expect(JSON.parse(String(f.fetchFn.mock.calls[1]![1]?.body)).proof.nonce).not.toBe(proof.nonce);
    expect(f.credential).not.toHaveBeenCalled();
  });

  it("preserves Core's unestablished owner projection without fabricating an incarnation", async () => {
    const initial = { ...owner, ownerRevision: 0, currentIncarnation: null, acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 0 };
    await expect(fixture(initial).client.resolveRuntimeOwner("instance")).resolves.toEqual(initial);
  });

  it.each([
    { instanceId: "foreign" }, { ownerRevision: -1 }, { ownerRevision: Number.MAX_SAFE_INTEGER + 1 },
    { currentIncarnation: undefined }, { heartbeatSequenceFloor: 6 }, { acceptedHeartbeatSequence: -1 },
    { acceptedHeartbeatSequence: "7" }, { heartbeatSequenceFloor: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
  ])("rejects a noncanonical or mismatched owner response %j", async patch => {
    const f = fixture({ ...owner, ...patch });
    await expect(f.client.resolveRuntimeOwner("instance")).rejects.toThrow();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("validates the requested identity before network I/O", async () => {
    const f = fixture();
    await expect(f.client.resolveRuntimeOwner("../foreign")).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("preserves establishment conflict as a closed denial, not a transient service failure", async () => {
    const f = fixture({ code: "conflict", message: "owner moved" }, 409);
    await expect(f.client.resolveRuntimeOwner("instance")).rejects.toMatchObject({ code: "conflict", wireCode: "conflict", status: 409, retryable: false });
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("native applied receipt HTTPS boundary", () => {
  it.each(["accepted", "already_accepted"])("matches the %s result to the exact signed semantic receipt", async outcome => {
    const response = { ...accepted, outcome };
    const f = fixture(response);
    await expect(f.client.applyReconciliation(receipt)).resolves.toEqual(response);
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/reconciliation/applied");
    expect(init?.headers).not.toHaveProperty("authorization");
    const { proof, ...body } = JSON.parse(String(init?.body));
    expect(body).toEqual(receipt);
    expect(verifyInstanceProof(f.key.publicKey, { method: "reconciliation_applied", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
    expect(verifyInstanceProof(f.key.publicKey, { method: "reconciliation_applied", audience: CORE_AUDIENCE, subject: "instance", body: { ...body, connection: { kind: "relay", connectionEpoch: 2 } } }, proof)).toBe(false);
    expect(f.credential).not.toHaveBeenCalled();
  });

  it("preserves receipt evidence and digest across caller retries with a fresh proof/current connection", async () => {
    const f = fixture(accepted);
    const original = JSON.stringify(receipt);
    await f.client.applyReconciliation(receipt);
    await f.client.applyReconciliation({ ...receipt, connection: { kind: "relay", connectionEpoch: 2 } });
    const [first, second] = f.fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(first.proof.nonce).not.toBe(second.proof.nonce);
    const { proof: _firstProof, connection: _firstConnection, ...firstSemantic } = first;
    const { proof: _secondProof, connection: _secondConnection, ...secondSemantic } = second;
    expect(firstSemantic).toEqual(secondSemantic);
    expect(JSON.stringify(receipt)).toBe(original);
  });

  it.each([
    { instanceId: "foreign" }, { runnerIncarnation: "foreign" }, { manifestId: "foreign" }, { receiptDigest: "b".repeat(43) },
    { acceptedAt: "invalid" }, { outcome: "pending" }, { extra: true }, { acceptedAt: undefined },
  ])("rejects a noncanonical or mismatched acceptance %j", async patch => {
    const f = fixture({ ...accepted, ...patch });
    await expect(f.client.applyReconciliation(receipt)).rejects.toThrow();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { extra: true }, { manifestId: "../foreign" }, { runnerIncarnation: "" },
    { connection: { kind: "relay", connectionEpoch: 0 } },
    { decisionResults: [{ ...receipt.decisionResults[0], terminalEvidence: undefined }] },
    { decisionResults: [receipt.decisionResults[0], receipt.decisionResults[0]] },
    { decisionResults: [{ ...receipt.decisionResults[0], assignmentId: "z" }, receipt.decisionResults[0]] },
  ])("rejects malformed semantic evidence before sending %j", async patch => {
    const f = fixture(accepted);
    await expect(f.client.applyReconciliation({ ...receipt, ...patch } as never)).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("compares acceptance against the signed snapshot, not a caller object mutated during I/O", async () => {
    const f = fixture(accepted);
    const input = structuredClone(receipt);
    f.fetchFn.mockImplementationOnce(async () => {
      input.runnerIncarnation = "another-process";
      input.manifestId = "another-manifest";
      return new Response(JSON.stringify(accepted));
    });
    await expect(f.client.applyReconciliation(input)).resolves.toEqual(accepted);
    expect(JSON.parse(String(f.fetchFn.mock.calls[0]![1]?.body))).toMatchObject({ runnerIncarnation: "process", manifestId: "manifest" });
  });

  it.each([
    [409, "reconciliation_replay"], [409, "idempotency_conflict"], [422, "resume_deadline_expired"],
    [422, "instance_revoked"],
  ])("surfaces HTTP %s %s without hidden retries or local completion", async (status, code) => {
    const f = fixture({ code, message: "denied" }, status as number);
    await expect(f.client.applyReconciliation(receipt)).rejects.toMatchObject({ status, code, wireCode: code });
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 503 within the bounded transient budget, then surfaces it without local completion", async () => {
    const f = fixture({ code: "temporarily_unavailable", message: "denied" }, 503);
    await expect(f.client.applyReconciliation(receipt)).rejects.toMatchObject({ status: 503, code: "temporarily_unavailable", wireCode: "temporarily_unavailable" });
    expect(f.fetchFn).toHaveBeenCalledTimes(NATIVE_TRANSIENT_MAX_ATTEMPTS);
  });

  it("does not turn an uncertain delivery into success, and fresh caller retry preserves evidence", async () => {
    const f = fixture(accepted);
    f.fetchFn.mockRejectedValueOnce(new Error("connection interrupted"));
    // A transport failure is retried within the bounded budget; the retry
    // re-signs the identical receipt rather than inventing a local outcome.
    await expect(f.client.applyReconciliation(receipt)).resolves.toEqual(accepted);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
    const bodies = f.fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].decisionResults).toEqual(bodies[1].decisionResults);
    expect(bodies[0].proof.nonce).not.toBe(bodies[1].proof.nonce);
  });

  it("does not expose malformed response bytes or credentials in the returned error", async () => {
    const secret = "sensitive-response-canary";
    const f = fixture();
    f.fetchFn.mockImplementationOnce(async () => new Response(`invalid ${secret}`));
    const error = await f.client.applyReconciliation(receipt).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(f.credential).not.toHaveBeenCalled();
  });
});

describe("exact local recovery error vocabulary", () => {
  it.each(["schema_invalid", "permission_denied", "not_found", "idempotency_conflict", "resume_deadline_expired", "conflict"])("preserves canonical %s instead of downgrading it to unavailable", code => {
    expect(RemoteInstanceErrorCodeSchema.parse(code)).toBe(code);
  });
});
