import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeExecutionRevisionControlIntentDigest,
  ed25519Sign,
  executionRevisionControlSigningBytes,
  generateEd25519,
  remoteControlSigningBytes,
  type JsonValue,
} from "@konteks/remote-common";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { ExecutionRevisionControlReceiver } from "../control/execution-revision-control-receiver.js";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "execution-revision-control-receiver-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  const key = generateEd25519();
  const verifier = new CoreSignatureVerifier([
    {
      keyId: "release",
      publicKeyJwk: generateEd25519().publicJwk,
      coreControlKeys: [{ keyId: "control", publicKeyJwk: key.publicJwk }],
    },
  ]);
  const clock = { wall: Date.parse("2026-09-21T00:00:00.000Z"), monotonic: 100 };
  const scope = {
    instanceId: "instance",
    workspaceId: "tenant",
    runnerIncarnation: "runner",
    nodeId: "node",
    connectionRef: "connection",
    connectionEpoch: 2,
    assertCurrent: vi.fn(),
  };
  const receiver = new ExecutionRevisionControlReceiver({
    verifier,
    inbox: journal.executionRevisionFences,
    captureConnection: () => ({ ...scope }),
    now: () => clock.wall,
    monotonicNow: () => clock.monotonic,
  });
  const intent = {
    schemaVersion: "remote-execution-revision-control-v1" as const,
    negotiatedCapability: "execution-revision-control-v1" as const,
    intentId: "intent",
    tenantId: "tenant",
    instanceId: "instance",
    executionId: "execution",
    executionRevision: 7,
    checkId: "check",
    policyRevision: 4,
    connectionRef: "connection",
    connectionEpoch: 2,
    reason: "authority_revoked" as const,
    issuedAt: new Date(clock.wall).toISOString(),
    deadlineAt: new Date(clock.wall + 2_000).toISOString(),
  };
  const sign = (body: Record<string, JsonValue>) => ({
    ...body,
    signature: ed25519Sign(
      key.privateKey,
      executionRevisionControlSigningBytes(body),
    ),
  });
  const cancellationSignature = () => {
    const cancellation = {
      type: "runtime_cancellation_delivery",
      method: "POST",
      path: { instanceId: "instance" },
      nodeId: "node",
      connectionRef: "connection",
      connectionEpoch: 2,
      intent: {
        intentId: "cancellation-intent",
        tenantId: "tenant",
        instanceId: "instance",
        sessionId: "session",
        claimId: "claim",
        delegationRef: "delegation",
        directive: {
          assignmentId: "assignment",
          attempt: 1,
          reason: "policy_denied",
          issuedAt: intent.issuedAt,
          signature: "AA",
        },
      },
      keyId: "control",
      nonce: "C".repeat(22),
      issuedAt: intent.issuedAt,
      expiresAt: intent.deadlineAt,
    };
    return ed25519Sign(key.privateKey, remoteControlSigningBytes(cancellation));
  };
  const makeForIntent = (
    candidateIntent: typeof intent,
    overrides: Record<string, JsonValue> = {},
  ) =>
    sign({
      type: "runtime_execution_revision_control_delivery",
      method: "POST",
      path: { instanceId: "instance" },
      nodeId: "node",
      connectionRef: candidateIntent.connectionRef,
      connectionEpoch: candidateIntent.connectionEpoch,
      intent: candidateIntent,
      intentDigest: computeExecutionRevisionControlIntentDigest(candidateIntent),
      keyId: "control",
      nonce: "N".repeat(22),
      issuedAt: intent.issuedAt,
      expiresAt: intent.deadlineAt,
      ...overrides,
    });
  const make = (overrides: Record<string, JsonValue> = {}) =>
    makeForIntent(intent, overrides);
  return {
    journal,
    receiver,
    scope,
    clock,
    intent,
    make,
    makeForIntent,
    cancellationSignature,
  };
}

describe("native execution revision-control receiver", () => {
  it("persists a valid exact signed delivery before returning a non-fencing acceptance", async () => {
    const f = await fixture();
    const accepted = await f.receiver.receive(f.make());
    expect(accepted).toMatchObject({ intent: f.intent, receivedAt: f.intent.issuedAt });
    expect(f.journal.executionRevisionFences.pending()).toEqual([accepted]);
    expect(accepted).not.toHaveProperty("fencedAt");
    expect(accepted).not.toHaveProperty("disposition");
  });

  it("rejects tampering and every signed foreign current-connection binding", async () => {
    const f = await fixture();
    await expect(
      f.receiver.receive({ ...f.make(), nonce: "B".repeat(22) }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    for (const request of [
      f.make({ nodeId: "other" }),
      f.makeForIntent({ ...f.intent, connectionRef: "other" }),
      f.makeForIntent({ ...f.intent, connectionEpoch: 3 }),
      f.makeForIntent({ ...f.intent, tenantId: "other" }),
    ]) {
      await expect(f.receiver.receive(request)).rejects.toMatchObject({
        code: "recovery_required",
      });
    }
    f.scope.instanceId = "other";
    await expect(f.receiver.receive(f.make())).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(f.journal.executionRevisionFences.pending()).toEqual([]);
  });

  it("rejects a request signed with cancellation canonical bytes", async () => {
    const f = await fixture();
    const { signature: _signature, ...body } = f.make();
    await expect(
      f.receiver.receive({ ...body, signature: f.cancellationSignature() }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(f.journal.executionRevisionFences.pending()).toEqual([]);
  });

  it("rejects a verified frame once its monotonic deadline has elapsed", async () => {
    const f = await fixture();
    f.clock.monotonic += 2_001;
    await expect(f.receiver.receive(f.make())).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(f.journal.executionRevisionFences.pending()).toEqual([]);
  });
});
