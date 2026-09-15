import { describe, expect, it } from "vitest";
import {
  exportPrivateJwk,
  generateInstanceKey,
  instanceKeyFromPrivateJwk,
  signBody,
  signInstanceProof,
  signRelayAck,
  verifyBody,
  verifyInstanceProof,
} from "../instance-key.js";
import { jcsDigest, reportPayloadDigest } from "../digest.js";

describe("instance key proofs", () => {
  const key = generateInstanceKey();
  const request = { method: "readiness", audience: "konteks:remote-instance", subject: "inst-1" };

  it("signs the body digest, nonce, method, audience, and subject with ES256", () => {
    const body = { instanceId: "inst-1", bundleVersion: "1.0.0", proof: { should: "be-stripped" } };
    const proof = signInstanceProof(key, { ...request, body });
    expect(proof.algorithm).toBe("ES256");
    expect(proof.nonce).toHaveLength(22);
    expect(verifyInstanceProof(key.publicKey, { ...request, body }, proof)).toBe(true);
  });

  it("rejects a proof replayed against a different body, method, audience, or subject", () => {
    const body = { instanceId: "inst-1" };
    const proof = signInstanceProof(key, { ...request, body });
    expect(
      verifyInstanceProof(key.publicKey, { ...request, body: { instanceId: "inst-2" } }, proof),
    ).toBe(false);
    expect(verifyInstanceProof(key.publicKey, { ...request, method: "reconnect", body }, proof)).toBe(
      false,
    );
    expect(verifyInstanceProof(key.publicKey, { ...request, audience: "other", body }, proof)).toBe(
      false,
    );
    expect(verifyInstanceProof(key.publicKey, { ...request, subject: "inst-9", body }, proof)).toBe(
      false,
    );
  });

  it("rejects a proof from a different key (wrong key at refresh/reconnect)", () => {
    const other = generateInstanceKey();
    const body = { instanceId: "inst-1" };
    const proof = signInstanceProof(other, { ...request, body });
    expect(verifyInstanceProof(key.publicKey, { ...request, body }, proof)).toBe(false);
  });

  it("round-trips through the private JWK the supervisor volume stores", () => {
    const restored = instanceKeyFromPrivateJwk(exportPrivateJwk(key));
    expect(restored.publicKeyJwk).toEqual(key.publicKeyJwk);
    const proof = signInstanceProof(restored, { ...request, body: {} });
    expect(verifyInstanceProof(key.publicKey, { ...request, body: {} }, proof)).toBe(true);
  });

  it("detached body signatures exclude the signature member itself", () => {
    const body = {
      type: "drain_ack",
      instanceId: "inst-1",
      activeAssignments: 0,
      acknowledgedAt: "2026-09-06T00:00:00Z",
    };
    const signature = signBody(key, body);
    expect(verifyBody(key.publicKey, { ...body, signature }, signature)).toBe(true);
    expect(verifyBody(key.publicKey, { ...body, activeAssignments: 1 }, signature)).toBe(false);
  });

  it("the supervisor RelayAck signature never covers the epoch (D115)", () => {
    const ack = {
      channelId: "control",
      dataDirection: "to_runtime" as const,
      cumulativeSeq: 7,
      issuedAt: "2026-09-06T00:00:00Z",
    };
    const signature = signRelayAck(key, ack);
    expect(verifyBody(key.publicKey, { ...ack, connectionEpoch: 1 }, signature)).toBe(false);
    expect(verifyBody(key.publicKey, { ...ack }, signature)).toBe(true);
  });
});

describe("report payload digest (D125)", () => {
  it("ignores reportedAt and payloadDigest so a retry matches", () => {
    const a = reportPayloadDigest({
      assignmentId: "a",
      reportSequence: 1,
      reportedAt: "t1",
      payloadDigest: "x",
    });
    const b = reportPayloadDigest({ assignmentId: "a", reportSequence: 1, reportedAt: "t2" });
    expect(a).toBe(b);
    expect(a).toBe(jcsDigest({ assignmentId: "a", reportSequence: 1 }));
  });

  it("changes when any other member changes", () => {
    expect(reportPayloadDigest({ assignmentId: "a", reportSequence: 1 })).not.toBe(
      reportPayloadDigest({ assignmentId: "a", reportSequence: 2 }),
    );
  });
});
