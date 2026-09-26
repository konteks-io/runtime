import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, generateEd25519, ed25519Sign, remoteControlSigningBytes, computeExecutionRevisionControlIntentDigest, computeRemoteExecutionOperationDigest, type RemoteDeliveryAcceptanceReceipt, type RemoteWorkAssignment } from "@konteks/remote-common";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { PermissionAnswerReceiver } from "../control/permission-answer-receiver.js";
import { SupervisorJournal } from "../state/journal.js";
import { NativeExecutionGate } from "../native/execution-gate.js";
import { terminalOperationDispositions } from "../state/operation-dispositions.js";
import { RelayedSession } from "../session/relayed-session.js";
import { PermissionBroker } from "../session/permissions.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import type { RunnerPort } from "../runner-port.js";
import type { TransportManager } from "../transport/relay-transport.js";

let root: string;
const gates: NativeExecutionGate[] = [];
const sessions: RelayedSession[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-gate-")); });
afterEach(async () => { for (const session of sessions.splice(0)) session.fenceForRecovery(); for (const gate of gates.splice(0)) gate.stop(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = new Map([["core", pair.publicKey]]);
function signed(value: unknown, signingKey = pair.privateKey, kid = "core") {
  const encoded = (part: unknown) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const body = `${encoded({ alg: "RS256", kid })}.${encoded(value)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), signingKey).toString("base64url")}`;
}
const expiresAt = "2026-09-10T01:00:00Z";
const assignment: RemoteWorkAssignment = { id: "assignment", attempt: 1, workspaceId: "tenant", instanceId: "instance", placementId: "placement", kind: "assistant_execution", taskId: "turn", correlationId: "correlation", expiresAt, requiredCapabilities: [], agentRoute: { agentId: "codex", requiredRole: "assistant" }, source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: "turn" }, policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: expiresAt, permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: false } };
const message = { kind: "acp", method: "session/prompt", id: "request", params: { sessionId: "acp", prompt: [{ type: "text", text: "hello" }] } };

async function fixture() {
  const clock = new FixedClock(Date.parse("2026-09-10T00:00:00Z"));
  const journal = new SupervisorJournal(root); await journal.load();
  const ready = { workspaceId: "tenant", instanceId: "instance", sessionId: "session", channelId: "session:session", assignmentId: "assignment", attempt: 1,
    claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "runner", agentId: "codex", acpSessionRef: "acp", readyRevision: 1, registeredAt: clock.nowIso() };
  await journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution", placementId: "placement", workspaceId: "tenant", agentId: "codex", state: "running", recoveryEpoch: 0, executionReady: ready,
    reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt, latestResumeAt: expiresAt, updatedAt: clock.nowIso() });
  const { registeredAt: _time, ...binding } = ready;
  const authority = { ...binding, executionId: "execution", delegationRef: "delegation", turnRef: "turn", principal: "assistant",
    actorId: "user:default/owner", actorPrincipalId: "human", leaseSetId: "set", executionRevision: 1, state: "active", expiresAt };
  // Fixed JCS digest vector for the exact message above.
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update('{"id":"request","kind":"acp","method":"session/prompt","params":{"prompt":[{"text":"hello","type":"text"}],"sessionId":"acp"}}').digest("base64url");
  const claims = { ...authority, operationId: "operation", permitId: "permit", kind: "acp", method: "session/prompt", requestId: "request", payloadDigest: digest,
    sender: { kind: "holder", principal: "assistant" }, iss: "konteks:control-plane", aud: "konteks:remote-execution-operation", iat: clock.coreNow() / 1000, exp: clock.coreNow() / 1000 + 30 };
  const receipt = signed({ ...claims, aud: "konteks:remote-execution-admission", admissionId: "admission", admittedAt: clock.nowIso(), checkExpiresAt: "2026-09-10T00:00:30Z" });
  const envelope = { kind: "authorized_operation", operationId: "operation", permit: signed(claims), message };
  const client = {
    executionSigningKeys: vi.fn(async () => keys),
    consumeExecution: vi.fn(async () => ({ outcome: "admitted" as const, admissionId: "admission", receipt })),
    checkExecution: vi.fn(async () => ({ executionId: "execution", executionRevision: 1, expiresAt: new Date(clock.coreNow() + 30_000).toISOString(),
      lease: signed({ ...authority, iss: "konteks:control-plane", aud: "konteks:remote-execution-lease", checkId: "check",
        iat: clock.coreNow() / 1000, exp: clock.coreNow() / 1000 + 30 }) })),
  };
  let monotonic = 0;
  const assertOwned = vi.fn();
  const onAuthorityLost = vi.fn(async () => undefined);
  const makeGate = (overrides: Record<string, unknown> = {}) => { const gate = new NativeExecutionGate({ assignment, journal, clock, runnerIncarnation: "runner", client,
    assertOwned, onAuthorityLost, currentRevisionFenceConnection: () => ({ connectionRef: "connection", connectionEpoch: 2 }), monotonicNow: () => monotonic, ...overrides } as never); gates.push(gate); return gate; };
  return { journal, clock, ready, claims, client, envelope, gate: makeGate(), makeGate, onAuthorityLost, assertOwned,
    advance: (milliseconds: number) => { monotonic += milliseconds; clock.advance(milliseconds); } };
}

async function deliveryFixture() {
  const f = await fixture();
  const assigned: RemoteWorkAssignment = { ...assignment, kind: "delivery", taskId: "task", correlationId: "invocation",
    agentRoute: { agentId: "codex", requiredRole: "generator", sessionConfig: { model: "model-a" } },
    source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: "instance", executionSessionId: "session",
      repositoryId: "https://git.example.com/acme/store", modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
      turn: { invocationId: "invocation", dispatchGeneration: 0 } } };
  const entry = f.journal.assignments.get("assignment:1")!;
  await f.journal.assignments.put({ ...entry, kind: "delivery" });
  const { delegationRef: _delegation, turnRef: _turn, ...base } = f.claims;
  const claims = { ...base, workloadKind: "harness_delivery", principal: "harness", sender: { kind: "holder", principal: "harness" },
    aud: "konteks:delivery-execution-operation", invocationOwnerId: "owner", modelBindingDigest: "b".repeat(64),
    deliveryIdentity: { version: 1, tenantId: "tenant", requestingUserId: base.actorId, authorizationId: "approval",
      proposalId: "proposal", proposalVersion: 1, planId: "plan", taskId: "task", taskScopeDigest: `sha256:${"a".repeat(64)}`,
      repositoryId: "https://git.example.com/acme/store",
      routeId: "executor", routeManifestHash: "a".repeat(64), invocationId: "invocation", dispatchGeneration: 0,
      publicSessionId: "public", executionSessionId: "session", instanceId: "instance", requiredRuntimeRole: "generator",
      agentId: "codex", modelBinding: { selectedValue: "model-a", canonicalProviderId: "openai", canonicalModelId: "model-a" } },
    modelSelection: { mappingId: "mapping", mappingRevision: 1, mappingDigest: "m".repeat(43), snapshotId: "snapshot",
      snapshotRevision: 1, snapshotDigest: "s".repeat(43), configId: "model", selectedValue: "model-a",
      canonicalIdentity: { canonicalProviderId: "openai", canonicalModelId: "model-a" } } };
  const { operationId: _op, permitId: _permit, kind: _kind, method: _method, requestId: _id,
    payloadDigest: _digest, sender: _sender, iss: _issuer, aud: _aud, iat: _iat, exp: _exp, ...authority } = claims;
  const client = { ...f.client,
    consumeDeliveryExecution: vi.fn(async () => ({ outcome: "admitted" as const, admissionId: "delivery-admission",
      receipt: signed({ ...claims, aud: "konteks:delivery-execution-admission", admissionId: "delivery-admission",
        admittedAt: f.clock.nowIso(), checkExpiresAt: new Date(claims.exp * 1000).toISOString() }) })),
    checkDeliveryExecution: vi.fn(async () => ({ executionId: "execution", executionRevision: 1,
      expiresAt: new Date(f.clock.coreNow() + 30000).toISOString(), lease: signed({ ...authority,
        checkId: "check", iss: "konteks:control-plane", aud: "konteks:delivery-execution-lease",
        iat: f.clock.coreNow() / 1000, exp: f.clock.coreNow() / 1000 + 30 }) })) };
  const makeGate = (journal = f.journal) => { const gate = new NativeExecutionGate({ assignment: assigned, journal,
    clock: f.clock, runnerIncarnation: "runner", client, assertOwned: f.assertOwned, onAuthorityLost: f.onAuthorityLost });
    gates.push(gate); return gate; };
  return { ...f, gate: makeGate(), makeGate, client, claims, assigned,
    envelope: { ...f.envelope, permit: signed(claims) } };
}

it("passes an operation key identifier to the configured-origin trust cache", async () => {
  const f = await fixture();
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotatedKeys = new Map([["rotated", rotated.publicKey]]);
  const receipt = signed({ ...f.claims, aud: "konteks:remote-execution-admission", admissionId: "admission",
    admittedAt: f.clock.nowIso(), checkExpiresAt: "2026-09-10T00:00:30Z" }, rotated.privateKey, "rotated");
  f.client.executionSigningKeys.mockResolvedValue(rotatedKeys);
  f.client.consumeExecution.mockResolvedValue({ outcome: "admitted", admissionId: "admission", receipt });

  await f.gate.admit({ ...f.envelope, permit: signed(f.claims, rotated.privateKey, "rotated") });

  expect(f.client.executionSigningKeys).toHaveBeenCalledWith(undefined, "rotated");
});

it("dispatches delivery exactly once through dedicated consumption and check routes", async () => {
  const f = await deliveryFixture(); const operation = await f.gate.admit(f.envelope);
  expect(await f.gate.begin(operation)).toBe(true);
  expect(await f.gate.begin(operation)).toBe(false);
  expect(f.client.consumeDeliveryExecution).toHaveBeenCalledOnce();
  expect(f.client.checkDeliveryExecution).toHaveBeenCalled();
  expect(f.client.consumeExecution).not.toHaveBeenCalled();
  expect(f.client.checkExecution).not.toHaveBeenCalled();
  expect(f.journal.pendingRequests.get(operation.key)?.authorization?.claims).toMatchObject({ workloadKind: "harness_delivery" });
});

it("does not give renewal I/O more time than the verified monotonic lease has left", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const operation = await f.gate.admit(f.envelope);
  await f.gate.begin(operation);

  f.advance(29_999);
  await vi.advanceTimersByTimeAsync(1_000);

  const renewalDeadline = f.client.executionSigningKeys.mock.calls.at(-1)?.[0] as number;
  expect(renewalDeadline).toBeLessThanOrEqual(Date.now() + 1);
});

it("renews early enough to recover from a 19 second busy-host pause without extending the old lease", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const operation = await f.gate.admit(f.envelope);
  await f.gate.begin(operation);
  f.client.checkExecution.mockImplementationOnce(async () => {
    f.advance(19_000);
    throw new RemoteInstanceError("temporarily_unavailable", "check timed out", { retryable: true });
  });
  f.advance(5_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.client.checkExecution).toHaveBeenCalledTimes(2);
  expect(f.onAuthorityLost).not.toHaveBeenCalled();
  f.advance(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.client.checkExecution).toHaveBeenCalledTimes(3);
  expect(f.onAuthorityLost).not.toHaveBeenCalled();
  f.advance(3_000);
  expect(() => f.gate.assertDispatchCurrent(operation.authority)).not.toThrow();
});

it("refuses a successful renewal response received after the old monotonic lease expired", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const operation = await f.gate.admit(f.envelope);
  await f.gate.begin(operation);
  const normalCheck = f.client.checkExecution.getMockImplementation()!;
  f.client.checkExecution.mockImplementationOnce(async () => {
    f.advance(26_000);
    return normalCheck();
  });
  f.advance(5_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.onAuthorityLost).toHaveBeenCalledOnce();
  expect(() => f.gate.assertDispatchCurrent(operation.authority)).toThrow();
});

it("records renewal stage and remaining authority without logging signed material", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  const gate = f.makeGate({ logger });
  const operation = await gate.admit(f.envelope);
  await gate.begin(operation);
  f.client.checkExecution.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "secret upstream message", { retryable: true }));
  f.advance(5_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "execution.renewal_failed", stage: "check", executionId: "execution", remainingLeaseMs: 25_000 }), expect.any(String));
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret upstream message");
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(f.envelope.permit);
});

it("does not redispatch recovered ambiguous delivery work", async () => {
  const f = await deliveryFixture(); const operation = await f.gate.admit(f.envelope);
  await f.gate.begin(operation); f.gate.stop();
  const journal = new SupervisorJournal(root); await journal.load();
  const recovered = f.makeGate(journal); const admitted = await recovered.admit(f.envelope);
  await expect(recovered.begin(admitted)).rejects.toMatchObject({ code: "operation_interrupted" });
});

it.each(["model", "turn-generation", "session-model-binding", "assistant-audience", "check-audience"])("refuses delivery %s mismatch", async mode => {
  const f = await deliveryFixture();
  if (mode === "model") f.assigned.agentRoute.sessionConfig = { model: "other" };
  if (mode === "turn-generation" && f.assigned.source.kind === "harness_delivery") f.assigned.source.turn.dispatchGeneration = 1;
  if (mode === "session-model-binding") {
    f.claims.deliveryIdentity.modelBinding.canonicalModelId = "different";
    f.envelope.permit = signed(f.claims);
  }
  if (mode === "assistant-audience") f.envelope.permit = signed({ ...f.claims, aud: "konteks:remote-execution-operation" });
  if (mode === "check-audience") {
    f.client.checkDeliveryExecution.mockImplementationOnce(f.client.checkExecution);
    const admitted = await f.gate.admit(f.envelope);
    await expect(f.gate.begin(admitted)).rejects.toThrow();
  } else await expect(f.gate.admit(f.envelope)).rejects.toThrow();
});

it("retains delivery completion for replay without a second consumption", async () => {
  const f = await deliveryFixture(); const operation = await f.gate.admit(f.envelope);
  await f.gate.begin(operation);
  await f.gate.complete(operation.key, { kind: "acp_result", id: "request", method: "session/prompt", result: { stopReason: "end_turn" } });
  f.advance(31000);
  const replay = await f.gate.admit(f.envelope);
  expect(replay.replay).toBe(true); expect(await f.gate.begin(replay)).toBe(false);
  expect(f.client.consumeDeliveryExecution).toHaveBeenCalledOnce();
});

it.each(["valid", "lost-during-keys", "lost-during-admission", "wrong-producer", "wrong-incarnation"])("independently verifies native answer delivery: %s", async mode => {
  const f = await fixture(), control = generateEd25519();
  const verifier = new CoreSignatureVerifier([{ keyId: "release", publicKeyJwk: generateEd25519().publicJwk,
    coreControlKeys: [{ keyId: "control", publicKeyJwk: control.publicJwk }] }]);
  const answer = { kind: "acp_result", method: "session/request_permission", id: "pending", result: { outcome: { outcome: "cancelled" } } };
  const claims = { ...f.claims, kind: answer.kind, method: answer.method, requestId: answer.id,
    payloadDigest: computeRemoteExecutionOperationDigest(answer), sender: { kind: "core_permission_answer", principal: "core-answer",
      pendingRef: "pending-ref", requestDigest: "b".repeat(43), responderActorId: "user:default/responder", decisionId: "decision" } };
  const operation = { kind: "authorized_operation", operationId: claims.operationId, permit: signed(claims), message: answer };
  const body = { type: "runtime_permission_answer_delivery", method: "POST", path: { instanceId: "instance" }, nodeId: "node",
    connectionRef: "connection", connectionEpoch: 1, intent: { intentId: "intent", tenantId: "tenant", instanceId: "instance", executionId: "execution", operation },
    keyId: "control", nonce: "N".repeat(22), issuedAt: f.clock.nowIso(), expiresAt: new Date(f.clock.coreNow() + 30000).toISOString(), signature: "AA" };
  body.signature = ed25519Sign(control.privateKey, remoteControlSigningBytes(body));
  let current = true;
  const dispatched = vi.fn();
  const deliver = vi.fn(async (_operation, _claims, guard: () => void) => {
    if (mode === "lost-during-admission") current = false;
    guard(); dispatched();
  });
  if (mode === "lost-during-keys") f.client.executionSigningKeys.mockImplementationOnce(async () => { current = false; return keys; });
  const receiver = new PermissionAnswerReceiver({ verifier, core: f.client, coreProducer: mode === "wrong-producer" ? "assistant" : "core-answer",
    now: () => f.clock.coreNow(), deliver,
    captureConnection: () => ({ instanceId: "instance", workspaceId: "tenant", runnerIncarnation: mode === "wrong-incarnation" ? "other" : "runner",
      connectionEpoch: 1, leaseExpiresAt: expiresAt, assertCurrent: () => { if (!current) throw new Error("delivery ownership lost"); } }) });
  if (mode === "valid") {
    await receiver.receive(body); expect(dispatched).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(operation, expect.objectContaining({ sender: claims.sender }), expect.any(Function));
  } else { await expect(receiver.receive(body)).rejects.toThrow(); expect(dispatched).not.toHaveBeenCalled(); }
});

async function sessionFixture(work: RemoteWorkAssignment = assignment, acceptDeliveryOutput?: (authority: { claimId: string; invocationRef: string }) => Promise<RemoteDeliveryAcceptanceReceipt>) {
  const f = work.source.kind === "harness_delivery" ? await deliveryFixture() : await fixture();
  const entry = f.journal.assignments.get(`${work.id}:${work.attempt}`)!;
  await f.journal.assignments.put({ ...entry, kind: work.kind });
  const runner = { createSession: vi.fn(async () => ({ acpSessionRef: "acp", resumed: false, capabilities: { forkSession: false, sessionResume: false } })),
    prompt: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    // Mirrors NativeRunner: every completed native close returns the continuation receipt.
    closeSession: vi.fn(async (_ref: string, options?: { completed: true }) => options?.completed ? { completion: "native_continuation_ready" as const } : undefined),
    stopForRecovery: vi.fn(async () => undefined) };
  const send = vi.fn();
  const beforePrompt = vi.fn(async () => undefined);
  const session = new RelayedSession(work, { clock: f.clock, journal: f.journal, runner: runner as unknown as RunnerPort,
    transport: { send, openChannel: vi.fn() } as unknown as TransportManager,
    instanceId: "instance", workspaceRoot: root,
    executionAuthority: { client: f.client, runnerIncarnation: "runner" }, assertExecutionOwned: f.assertOwned,
    // The orchestrator wires settlement recording for every native session.
    recordCompletedSettlement: async () => undefined,
    prepareInputs: async () => ({ binding: { workspaceId: "tenant", instanceId: "instance", sessionId: "session", assignmentId: "assignment", attempt: 1 }, cwd: root, skillInstructions: "trusted local skill", beforePrompt,
      ...(acceptDeliveryOutput ? { acceptDeliveryOutput } : {}) }),
    registerReady: async () => f.ready, redeemCapabilityToken: async () => { throw new Error("unexpected capability redemption"); },
    policy: new EvaluatorPolicyResponder(null, () => false), broker: new PermissionBroker({ clock: f.clock, deadlineSeconds: () => 60, onTimeout: async () => undefined }),
    onUsage: async () => undefined, onClosed: async () => undefined });
  sessions.push(session); await session.bootstrap(); send.mockClear();
  return { ...f, session, runner, send, beforePrompt };
}

describe("native session dispatch uses genuine execution admission", () => {
  it("closes a prepared delivery assignment after its authorized pre-prompt cancellation", async () => {
    const work = { ...assignment, kind: "delivery" as const, taskId: "task", correlationId: "invocation",
      agentRoute: { agentId: "codex", requiredRole: "generator" as const, sessionConfig: { model: "model-a" } },
      source: { kind: "harness_delivery" as const, portability: "instance_bound" as const, ownerInstanceId: "instance", executionSessionId: "session",
        repositoryId: "https://git.example.com/acme/store", modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
        turn: { invocationId: "invocation", dispatchGeneration: 0 } } };
    const f = await sessionFixture(work);
    const message = { kind: "acp" as const, method: "session/cancel" as const, params: { sessionId: "acp" } };
    const { requestId: _requestId, ...promptClaims } = f.claims;
    const claims = { ...promptClaims, operationId: "cancel-operation", method: "session/cancel" as const,
      payloadDigest: computeRemoteExecutionOperationDigest(message) };
    f.client.consumeDeliveryExecution.mockResolvedValueOnce({ outcome: "admitted", admissionId: "cancel-admission",
      receipt: signed({ ...claims, aud: "konteks:delivery-execution-admission", admissionId: "cancel-admission",
        admittedAt: f.clock.nowIso(), checkExpiresAt: new Date(claims.exp * 1000).toISOString() }) });
    await f.session.onToRuntime({ kind: "authorized_operation", operationId: claims.operationId,
      permit: signed(claims), message });
    expect(f.runner.cancel).toHaveBeenCalledExactlyOnceWith("acp");
    expect(f.send.mock.calls.at(-1)?.[0].body).toEqual({
      kind: "session_closed", assignmentId: "assignment", reason: "cancelled",
    });
  });

  it("withholds delivery completion until the exact generated output is durably accepted", async () => {
    const accepted = Promise.withResolvers<RemoteDeliveryAcceptanceReceipt>();
    const acceptDeliveryOutput = vi.fn(() => accepted.promise);
    const work = { ...assignment, kind: "delivery" as const, taskId: "task", correlationId: "invocation",
      agentRoute: { agentId: "codex", requiredRole: "generator" as const, sessionConfig: { model: "model-a" } },
      source: { kind: "harness_delivery" as const, portability: "instance_bound" as const, ownerInstanceId: "instance", executionSessionId: "session",
        repositoryId: "https://git.example.com/acme/store", modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
        turn: { invocationId: "invocation", dispatchGeneration: 0 } } };
    const f = await sessionFixture(work, acceptDeliveryOutput);
    await f.session.onToRuntime(f.envelope);
    const completion = f.session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp", requestId: "request", result: { stopReason: "end_turn" } } as never);
    await vi.waitFor(() => expect(acceptDeliveryOutput).toHaveBeenCalledWith(expect.objectContaining({ claimId: "claim", invocationRef: "invocation",
      completion: expect.objectContaining({ kind: "acp_result", id: "request" }) })));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("dispatch_started");
    const receipt = { version: 1 as const, acceptanceId: "acceptance", invocationRef: "invocation",
      binding: { workspaceId: "tenant", instanceId: "instance", sessionId: "session", assignmentId: "assignment", attempt: 1 },
      claimId: "claim", resultId: "result", resultDigest: `sha256:${"a".repeat(64)}`, inputSelectionDigest: `sha256:${"b".repeat(64)}`,
      baseRevision: "base", acceptedAt: f.clock.nowIso() };
    accepted.resolve(receipt);
    await completion;
    expect(f.send.mock.calls.map(call => call[0].body)).toContainEqual(expect.objectContaining({ kind: "acp_result", id: "request" }));
    expect(f.send.mock.calls.at(-1)?.[0].body).toMatchObject({ kind: "session_closed", reason: "completed" });
    expect(f.session.deliveryAcceptanceReceipt()).toEqual(receipt);
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("completed");
  });

  it("never falls back to bare ACP or borrowed Assistant permits for prepared delivery", async () => {
    const f = await sessionFixture({ ...assignment, kind: "delivery", correlationId: "invocation",
      agentRoute: { agentId: "codex", requiredRole: "generator", sessionConfig: { model: "model-a" } },
      source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: "instance", executionSessionId: "session",
        repositoryId: "https://git.example.com/acme/store", modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
        turn: { invocationId: "invocation", dispatchGeneration: 0 } } });
    await expect(f.session.onToRuntime(message)).rejects.toThrow();
    await expect(f.session.onToRuntime(f.envelope)).rejects.toThrow();
    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(f.client.consumeExecution).not.toHaveBeenCalled();
  });
  it("refuses executable ACP on the dedicated Core answer entry before consumption", async () => {
    const f = await sessionFixture();
    await expect(f.session.onCorePermissionAnswer(f.envelope, () => {})).rejects.toMatchObject({ code: "operation_conflict" });
    expect(f.client.consumeExecution).not.toHaveBeenCalled();
    expect(f.runner.prompt).not.toHaveBeenCalled();
  });
  it("fences an admitted native prompt waiting on local input preparation before settling recovery", async () => {
    const f = await sessionFixture();
    const preparation = Promise.withResolvers<void>();
    f.beforePrompt.mockImplementationOnce(() => preparation.promise);
    const request = f.session.onToRuntime(f.envelope);
    await vi.waitFor(() => expect(f.beforePrompt).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = f.session.stopForRecovery().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    preparation.resolve(); await request; await stop;
    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("denied");
  });
  it("rejects bare ACP and dispatches a verified operation only once, preserving local skill injection", async () => {
    const f = await sessionFixture();
    await expect(f.session.onToRuntime(message)).rejects.toMatchObject({ code: "operation_permit_required" });
    await f.session.onToRuntime(f.envelope);
    expect(f.runner.prompt).toHaveBeenCalledWith("acp", "request", { sessionId: "acp", prompt: [{ type: "text", text: "trusted local skill" }, { type: "text", text: "hello" }] });
    await f.session.onToRuntime(f.envelope);
    expect(f.runner.prompt).toHaveBeenCalledTimes(1);
    await f.session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp", requestId: "request", result: { stopReason: "end_turn" } } as never);
    const completion = f.journal.pendingRequests.get("acp:received:request")?.authorization?.completion;
    expect(completion).toMatchObject({ kind: "acp_result", id: "request" });
    expect(f.send.mock.calls.map(call => call[0].body)).toContainEqual(completion);
    // end_turn now seals the native turn and closes the assignment; a late
    // duplicate must still never redispatch the verified operation.
    f.advance(31_000); await f.session.onToRuntime(f.envelope);
    expect(f.runner.prompt).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls.map(call => call[0].body)).toContainEqual({ kind: "session_closed", assignmentId: "assignment", reason: "completed" });
  });

  it("denies a second prompt on a busy session before dispatch and leaves the running turn alone (WS2-153)", async () => {
    const f = await sessionFixture();
    const second = { kind: "acp" as const, method: "session/prompt" as const, id: "request-2", params: { sessionId: "acp", prompt: [{ type: "text" as const, text: "hello again" }] } };
    const claims = { ...f.claims, operationId: "operation-2", permitId: "permit-2", requestId: "request-2", payloadDigest: computeRemoteExecutionOperationDigest(second) };
    await f.session.onToRuntime(f.envelope);
    f.client.consumeExecution.mockResolvedValueOnce({ outcome: "admitted", admissionId: "admission-2",
      receipt: signed({ ...claims, aud: "konteks:remote-execution-admission", admissionId: "admission-2", admittedAt: f.clock.nowIso(), checkExpiresAt: "2026-09-10T00:00:30Z" }) });
    await f.session.onToRuntime({ kind: "authorized_operation", operationId: "operation-2", permit: signed(claims), message: second });
    expect(f.runner.prompt).toHaveBeenCalledOnce();
    expect(f.runner.prompt).toHaveBeenCalledWith("acp", "request", expect.anything());
    expect(f.journal.pendingRequests.get("acp:received:request-2")?.authorization).toMatchObject({ state: "denied",
      completion: { kind: "acp_error", id: "request-2", error: { class: "invalid_params", retryable: false } } });
    expect(f.session.isClosed).toBe(false);
    expect(f.runner.cancel).not.toHaveBeenCalled();
    expect(f.send.mock.calls.map(call => call[0].body)).toEqual([expect.objectContaining({ kind: "acp_error", id: "request-2" })]);
    // The first turn ends normally: the claim's report settles both operations,
    // one completed and one denied, and none interrupted.
    await f.session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp", requestId: "request", result: { stopReason: "end_turn" } } as never);
    expect(f.send.mock.calls.map(call => call[0].body)).toContainEqual({ kind: "session_closed", assignmentId: "assignment", reason: "completed" });
    const dispositions = await terminalOperationDispositions(f.journal, "assignment", 1, "claim");
    expect(dispositions.map(item => [item.operationId, item.state]).sort()).toEqual([["operation", "completed"], ["operation-2", "denied"]]);
  });

  it("settles a prompt the runner refused as busy as a denial without closing the session", async () => {
    const f = await sessionFixture();
    f.runner.prompt.mockRejectedValueOnce(new RemoteInstanceError("operation_conflict", "Another prompt is already running on this session."));
    await f.session.onToRuntime(f.envelope);
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization).toMatchObject({ state: "denied",
      completion: { kind: "acp_error", id: "request", error: { class: "invalid_params" } } });
    expect(f.session.isClosed).toBe(false);
    expect(f.send.mock.calls.map(call => call[0].body)).toEqual([expect.objectContaining({ kind: "acp_error", id: "request" })]);
  });

  it("persists preparation rejection before replying", async () => {
    const f = await sessionFixture(); f.beforePrompt.mockRejectedValueOnce(new Error("local input unavailable"));
    await f.session.onToRuntime(f.envelope);
    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization).toMatchObject({ state: "denied", completion: { kind: "acp_error" } });
    await f.session.onToRuntime(f.envelope); expect(f.beforePrompt).toHaveBeenCalledTimes(1);
  });

  it("closes a native turn after a retryable check refusal before dispatch", async () => {
    const f = await sessionFixture();
    f.client.checkExecution.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "Core request failed", { retryable: true }));
    await f.session.onToRuntime(f.envelope);
    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("denied");
    expect(f.runner.closeSession).toHaveBeenCalledOnce();
    expect(f.session.isClosed).toBe(true);
    expect(f.send.mock.calls.map(call => call[0].body)).toEqual([
      expect.objectContaining({ kind: "acp_error", id: "request" }),
      { kind: "session_closed", assignmentId: "assignment", reason: "agent_exited" },
    ]);
  });

  it("closes a native turn on a matched agent prompt error, ignoring unrelated errors", async () => {
    const f = await sessionFixture();
    await f.session.onToRuntime(f.envelope);
    const error = { kind: "request_error", acpSessionRef: "acp", requestId: "unknown", method: "session/prompt",
      code: -32603, class: "internal", message: "failed", retryable: true };
    await f.session.onRunnerEvent(error as never);
    expect(f.session.isClosed).toBe(false);
    await f.session.onRunnerEvent({ ...error, requestId: "request" } as never);
    expect(f.session.isClosed).toBe(true);
    expect(f.runner.closeSession).toHaveBeenCalledOnce();
    expect(f.send.mock.calls.map(call => call[0].body)).toContainEqual({ kind: "session_closed", assignmentId: "assignment", reason: "agent_exited" });
  });

  it("terminalizes a delivery whose local inputs fail before agent dispatch", async () => {
    const delivery = await deliveryFixture();
    const f = await sessionFixture(delivery.assigned);
    f.beforePrompt.mockRejectedValueOnce(new Error("local input unavailable"));

    await f.session.onToRuntime(f.envelope);

    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization).toMatchObject({
      state: "denied",
      completion: { kind: "acp_error", error: { retryable: false } },
    });
    expect(f.send.mock.calls.map(call => call[0].body)).toEqual([
      expect.objectContaining({ kind: "acp_error", id: "request" }),
      { kind: "session_closed", assignmentId: "assignment", reason: "agent_exited" },
    ]);
    expect(f.runner.closeSession).toHaveBeenCalledOnce();
    expect(f.session.isClosed).toBe(true);

    await f.session.onToRuntime(f.envelope);
    expect(f.beforePrompt).toHaveBeenCalledOnce();
    expect(f.runner.closeSession).toHaveBeenCalledOnce();
  });

  it("leaves an uncertain bridge dispatch unresolved", async () => {
    const f = await sessionFixture(); f.runner.prompt.mockRejectedValueOnce(new Error("bridge transport failed"));
    await expect(f.session.onToRuntime(f.envelope)).rejects.toThrow("bridge transport failed");
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("dispatch_started");
    await f.session.onToRuntime(f.envelope); expect(f.runner.prompt).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses dispatch on a failed fresh check and retains failed safety-stop evidence", async () => {
    const f = await sessionFixture(); f.client.checkExecution.mockRejectedValueOnce(new Error("revoked"));
    await f.session.onToRuntime(f.envelope);
    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("denied");
  });

  it("surfaces a failed per-session safety stop without claiming successful closure", async () => {
    const f = await sessionFixture(); vi.useFakeTimers();
    await f.session.onToRuntime(f.envelope);
    f.runner.stopForRecovery.mockRejectedValueOnce(new Error("stop unproven"));
    // The verified lease schedules renewal while 25 seconds remain; a
    // definitive refusal must stop without claiming the stop succeeded.
    f.client.checkExecution.mockRejectedValue(new RemoteInstanceError("execution_fenced", "moved"));
    f.clock.advance(25_000); await vi.advanceTimersByTimeAsync(25_000);
    await expect(f.session.waitForAuthorityStop()).rejects.toThrow("stop unproven");
    expect(f.runner.stopForRecovery).toHaveBeenCalledWith("acp");
    expect(f.runner.closeSession).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: { kind: "session_closed", assignmentId: "assignment", reason: "lease_lost" } }));
    expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("dispatch_started");
  });
});

describe("independent native live execution gate", () => {
  it("fences before dispatch when durable verified control names the fresh exact execution check", async () => {
    const f = await fixture();
    const intent = {
      schemaVersion: "remote-execution-revision-control-v1" as const,
      negotiatedCapability: "execution-revision-control-v1" as const,
      intentId: "intent",
      tenantId: "tenant",
      instanceId: "instance",
      executionId: "execution",
      executionRevision: 1,
      checkId: "check",
      policyRevision: null,
      connectionRef: "connection",
      connectionEpoch: 2,
      reason: "authority_revoked" as const,
      issuedAt: f.clock.nowIso(),
      deadlineAt: new Date(f.clock.coreNow() + 2_000).toISOString(),
    };
    await f.journal.executionRevisionFences.receiveVerified({
      intent,
      intentDigest: computeExecutionRevisionControlIntentDigest(intent),
      runnerIncarnation: "runner",
      connectionRef: "connection",
      connectionEpoch: 2,
    }, f.clock.nowIso(), () => {});
    const operation = await f.gate.admit(f.envelope);
    await expect(f.gate.begin(operation)).rejects.toMatchObject({
      code: "execution_fenced",
    });
    expect(f.client.checkExecution).toHaveBeenCalledOnce();
  });

  it("creates a nonterminal receipt only after applying the exact current native fence", async () => {
    const f = await fixture();
    const onFenceApplied = vi.fn(async () => undefined);
    const gate = f.makeGate({ onFenceApplied });
    const intent = {
      schemaVersion: "remote-execution-revision-control-v1" as const,
      negotiatedCapability: "execution-revision-control-v1" as const,
      intentId: "receipt-intent", tenantId: "tenant", instanceId: "instance", executionId: "execution", executionRevision: 1,
      checkId: "check", policyRevision: null, connectionRef: "connection", connectionEpoch: 2,
      reason: "authority_revoked" as const, issuedAt: f.clock.nowIso(), deadlineAt: new Date(f.clock.coreNow() + 2_000).toISOString(),
    };
    await f.journal.executionRevisionFences.receiveVerified({
      intent, intentDigest: computeExecutionRevisionControlIntentDigest(intent), runnerIncarnation: "runner", connectionRef: "connection", connectionEpoch: 2,
    }, f.clock.nowIso(), () => {});

    const operation = await gate.admit(f.envelope);
    await expect(gate.begin(operation)).rejects.toMatchObject({ code: "execution_fenced" });
    await vi.waitFor(() => expect(onFenceApplied).toHaveBeenCalledWith(expect.objectContaining({
      kind: "execution_revision_fenced", intent, intentDigest: computeExecutionRevisionControlIntentDigest(intent),
      runnerIncarnation: "runner", connectionRef: "connection", connectionEpoch: 2,
    })));
  });

  it("does not fence a different execution revision or connection record", async () => {
    const f = await fixture();
    const intent = {
      schemaVersion: "remote-execution-revision-control-v1" as const,
      negotiatedCapability: "execution-revision-control-v1" as const,
      intentId: "other-intent",
      tenantId: "tenant",
      instanceId: "instance",
      executionId: "execution",
      executionRevision: 2,
      checkId: "other-check",
      policyRevision: null,
      connectionRef: "other-connection",
      connectionEpoch: 3,
      reason: "authority_revoked" as const,
      issuedAt: f.clock.nowIso(),
      deadlineAt: new Date(f.clock.coreNow() + 2_000).toISOString(),
    };
    await f.journal.executionRevisionFences.receiveVerified({
      intent,
      intentDigest: computeExecutionRevisionControlIntentDigest(intent),
      runnerIncarnation: "runner",
      connectionRef: "other-connection",
      connectionEpoch: 3,
    }, f.clock.nowIso(), () => {});
    const operation = await f.gate.admit(f.envelope);
    await expect(f.gate.begin(operation)).resolves.toBe(true);
  });

  it("does not fence a control for the same revision when its verified check differs", async () => {
    const f = await fixture();
    const intent = {
      schemaVersion: "remote-execution-revision-control-v1" as const,
      negotiatedCapability: "execution-revision-control-v1" as const,
      intentId: "other-check-intent",
      tenantId: "tenant",
      instanceId: "instance",
      executionId: "execution",
      executionRevision: 1,
      checkId: "other-check",
      policyRevision: null,
      connectionRef: "connection",
      connectionEpoch: 2,
      reason: "authority_revoked" as const,
      issuedAt: f.clock.nowIso(),
      deadlineAt: new Date(f.clock.coreNow() + 2_000).toISOString(),
    };
    await f.journal.executionRevisionFences.receiveVerified({
      intent,
      intentDigest: computeExecutionRevisionControlIntentDigest(intent),
      runnerIncarnation: "runner",
      connectionRef: "connection",
      connectionEpoch: 2,
    }, f.clock.nowIso(), () => {});

    const operation = await f.gate.admit(f.envelope);
    await expect(f.gate.begin(operation)).resolves.toBe(true);
  });

  it("requires genuine signatures, exact local readiness, consumption and a check before start", async () => {
    const f = await fixture(); const operation = await f.gate.admit(f.envelope);
    expect(f.journal.pendingRequests.get(operation.key)?.authorization?.state).toBe("admitted");
    expect(f.client.checkExecution).not.toHaveBeenCalled();
    expect(await f.gate.begin(operation)).toBe(true);
    expect(await f.gate.begin(operation)).toBe(false);
    expect(f.client.consumeExecution).toHaveBeenCalledWith("instance", "execution", { permitId: "permit", operationId: "operation", payloadDigest: f.claims.payloadDigest, runnerIncarnation: "runner", executionRevision: 1 });
  });

  it("rejects bare frames, tampering and foreign local execution before consumption", async () => {
    const f = await fixture();
    await expect(f.gate.admit(message)).rejects.toMatchObject({ code: "operation_permit_required" });
    await expect(f.gate.admit({ ...f.envelope, message: { ...message, id: "other" } })).rejects.toThrow();
    await expect(f.gate.admit({ ...f.envelope, permit: signed({ ...f.claims, runnerIncarnation: "foreign" }) })).rejects.toMatchObject({ code: "execution_fenced" });
    expect(f.client.consumeExecution).not.toHaveBeenCalled();
  });

  it("rejects an invalid admission receipt without journaling authorization", async () => {
    const f = await fixture(); f.client.consumeExecution.mockResolvedValueOnce({ outcome: "admitted", admissionId: "admission", receipt: f.envelope.permit });
    await expect(f.gate.admit(f.envelope)).rejects.toThrow("Invalid execution admission receipt");
    expect(f.journal.pendingRequests.all()).toHaveLength(0);
  });

  it("never starts after revocation or an unavailable Core check", async () => {
    const f = await fixture(); const operation = await f.gate.admit(f.envelope);
    f.client.checkExecution.mockRejectedValueOnce(new Error("revoked"));
    await expect(f.gate.begin(operation)).rejects.toThrow("revoked");
    expect(f.journal.pendingRequests.get(operation.key)?.authorization?.state).toBe("denied");
  });

  it("returns durable completion after expiry without consuming or executing again", async () => {
    const f = await fixture(); const operation = await f.gate.admit(f.envelope); await f.gate.begin(operation);
    const completion = { kind: "acp_result" as const, method: "session/prompt" as const, id: "request", result: { stopReason: "end_turn" as const } };
    await f.gate.complete(operation.key, completion); f.advance(31_000);
    const replay = await f.gate.admit(f.envelope);
    expect(replay.replayCompletion).toEqual(completion); expect(await f.gate.begin(replay)).toBe(false);
    expect(f.client.consumeExecution).toHaveBeenCalledTimes(1);
  });

  it("does not replay a started operation from another process incarnation of the gate", async () => {
    const f = await fixture(); const operation = await f.gate.admit(f.envelope); await f.gate.begin(operation); f.gate.stop();
    const successor = f.makeGate(); const recovered = await successor.admit(f.envelope);
    await expect(successor.begin(recovered)).rejects.toMatchObject({ code: "operation_interrupted" });
  });

  it("cancels once when a periodic fresh check fails", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const operation = await f.gate.admit(f.envelope); await f.gate.begin(operation);
    f.client.checkExecution.mockRejectedValueOnce(new Error("policy revoked"));
    f.advance(4_000); await vi.advanceTimersByTimeAsync(4_000);
    expect(f.onAuthorityLost).not.toHaveBeenCalled();
    f.advance(1_000); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.onAuthorityLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(f.onAuthorityLost).toHaveBeenCalledTimes(1);
  });

  it("does not extend authority when wall-clock time moves backward", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const operation = await f.gate.admit(f.envelope); await f.gate.begin(operation);
    // The old lease is not trusted again: only a fresh Core check could
    // extend it, and Core refuses this one.
    f.client.checkExecution.mockRejectedValueOnce(new RemoteInstanceError("execution_fenced", "moved"));
    f.advance(31_000); f.clock.advance(-40_000); await vi.advanceTimersByTimeAsync(1000);
    // A backward wall-clock jump cannot manufacture time before the local
    // monotonic expiry; the old check is never retried or extended.
    expect(f.client.checkExecution).toHaveBeenCalledOnce();
    expect(f.onAuthorityLost).toHaveBeenCalledTimes(1);
  });

  it("fences at the monotonic projection of the last verified expiry when a renewal is unavailable", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const operation = await f.gate.admit(f.envelope); await f.gate.begin(operation);
    f.client.checkExecution.mockRejectedValue(new RemoteInstanceError("temporarily_unavailable", "Core request failed", { retryable: true }));
    const step = async (seconds: number) => {
      for (let second = 0; second < seconds; second += 1) { f.advance(1000); await vi.advanceTimersByTimeAsync(1000); }
    };
    await step(29);
    expect(f.onAuthorityLost).not.toHaveBeenCalled();
    await step(1);
    expect(f.onAuthorityLost).toHaveBeenCalledTimes(1);
  });
});


it('retains a genuine admission that expires in transit as non-dispatch evidence', async () => {
  const f = await fixture();
  const consume = f.client.consumeExecution.getMockImplementation()!;
  f.client.consumeExecution.mockImplementationOnce(async (...args) => {
    const response = await consume(...args); f.clock.advance(31_000); return response;
  });
  const operation = await f.gate.admit(f.envelope);
  await expect(f.gate.begin(operation)).rejects.toMatchObject({ code: 'operation_expired' });
  expect(f.journal.pendingRequests.get(operation.key)?.authorization?.state).toBe('denied');
  expect(f.client.checkExecution).not.toHaveBeenCalled();
});

it('accepts an admission and fresh check at an HTTP Date second boundary', async () => {
  const f = await fixture();
  const freshCheck = await f.client.checkExecution();
  f.client.checkExecution.mockResolvedValue(freshCheck);
  f.clock.advance(-550);
  const op = await f.gate.admit(f.envelope);
  expect(await f.gate.begin(op)).toBe(true);
});


it('refuses a new permit for an already admitted ACP request before consuming again', async () => {
  const f = await fixture(); await f.gate.admit(f.envelope);
  const changed = { ...f.claims, operationId: 'second-operation', permitId: 'second-permit' };
  await expect(f.gate.admit({ ...f.envelope, operationId: changed.operationId, permit: signed(changed) })).rejects.toMatchObject({ code: 'operation_conflict' });
  expect(f.client.consumeExecution).toHaveBeenCalledTimes(1);
});

it("notifies the holder of authority loss before recovery suppresses session traffic", async () => {
  const f = await sessionFixture();
  await f.session.onToRuntime(f.envelope);
  const gate = (f.session as unknown as { executionGate: { fenceAuthority(): Promise<void> } }).executionGate;
  await gate.fenceAuthority();
  expect(f.send.mock.calls.map(call => call[0].body)).toContainEqual({
    kind: "session_closed", assignmentId: assignment.id, reason: "lease_lost",
  });
  expect(f.runner.stopForRecovery).toHaveBeenCalledExactlyOnceWith("acp");
  expect(f.journal.pendingRequests.get("acp:received:request")?.authorization?.state).toBe("dispatch_started");
  expect(f.session.isClosed).toBe(true);
});
