import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { FixedClock, logicalAssignmentResponseDigest, type AssignmentRequestReference, type LogicalAssignmentRequestFrame } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { AssignmentSender } from "../work/assignment-sender.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";
import type { OutboundMessage } from "../transport/transport.js";
import type { ExecutionLog } from "../state/local-execution.js";

const at = "2026-09-06T00:00:00.000Z";
const scope = { instanceId: "instance", workspaceId: "workspace" };
const pull = { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] };
const assignment = { id: "assignment", kind: "delivery", placementId: "placement", ...scope, taskId: "task", correlationId: "correlation", attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "generator", agentId: "codex" },
  source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
};
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "claim-owner-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture(claimOutcome: "denied" | "claimed" = "denied", overrides: Partial<ConstructorParameters<typeof WorkOrchestrator>[0]> = {}) {
  const journal = new SupervisorJournal(dir); await journal.load();
  const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at, assignmentStreamVersion: 1 };
  await journal.execution.seedEnrollment(seed); await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  const outbox = new DurableOutbox(dir); await outbox.load();
  const sent: OutboundMessage[] = [];
  const clock = new FixedClock(Date.parse(at)), authority = { key: "accepted-a" as string | null };
  let foreign = false;
  const submit = vi.fn(async (_id: string, frame: LogicalAssignmentRequestFrame) => {
    const request = journal.assignmentStream.request(scope, frame.seq)!;
    const kind = "maxItems" in frame.body ? "pull" : "claim";
    const claim = frame.body as { assignmentId: string; attempt: number; claimId: string };
    const body = kind === "pull" ? { assignments: [assignment] } : {
      assignmentId: claim.assignmentId, attempt: claim.attempt, claimId: foreign ? "foreign-claim" : claim.claimId,
      outcome: foreign ? "already_claimed" : claimOutcome, ...(!foreign && claimOutcome === "denied" ? { reason: "assignment_conflict" } : {}),
    };
    const reply = { channel: "assignment", channelId: frame.channelId, direction: "to_runtime", seq: frame.seq, issuedAt: at,
      body: { requestSequence: frame.seq, requestDigest: request.digest, requestKind: kind, body } };
    return { disposition: "accepted", response: { deliveryId: `delivery-${frame.seq}`, sequence: frame.seq, digest: logicalAssignmentResponseDigest(reply) }, frame: reply };
  });
  const sender = new AssignmentSender({ journal, clock, core: { submitAssignment: submit } as never,
    instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process", originManifestId: () => "manifest",
    assertOwned: () => undefined, captureRecoveryAuthority: () => new RecoveryAuthority(() => authority.key).capture("assignment"),
    captureClaimAuthority: admission => work.capturePendingClaimAuthority(admission) });
  const work = new WorkOrchestrator({ journal, outbox, assignmentSender: sender, clock, deploymentKind: "native_connector",
    transport: { send: (message: OutboundMessage) => sent.push(message) }, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "process", assertOwned: () => undefined, recoveryAuthority: () => authority.key,
    reportDeliveryAllowed: () => true, reconciliationComplete: () => true, lease: { canPullNewWork: () => true }, draining: () => false,
    headroom: () => 2, maxPullItems: 1, acceptedKinds: () => ["delivery"], advertisedRoles: () => ["generator"], browserToolAvailable: () => false,
    agents: () => [{ agentId: "codex", readiness: "ready", connectionState: "ready" }], instanceEvidencePolicy: () => "structured_only", components: {},
    ...overrides,
  } as never);
  const initial = await sender.preparePull(pull);
  await sender.deliverAllocated(initial, body => work.onAssignmentMessage(body, initial));
  const reference = () => journal.execution.start("assignment", 1)!.allocation!;
  const deliver = (ref: AssignmentRequestReference) => sender.deliverAllocated(ref, body => work.onAssignmentMessage(body, ref));
  return { journal, outbox, sender, work, sent, clock, authority, submit, reference, deliver, setForeign: () => { foreign = true; } };
}

it("allocates the actual Work admission before transport and applies a correlated negative claim without execution", async () => {
  const f = await fixture(); const start = f.journal.execution.start("assignment", 1)!;
  expect(start.delivery).toBe("allocated");
  expect(start.allocation).toMatchObject({ requestSequence: 2, requestKind: "claim" });
  const ref = f.reference();
  expect(f.journal.assignmentStream.request(scope, 2)).toMatchObject({ admission: start.admission, frame: { issuedAt: start.claimCreatedAt } });
  expect(() => f.journal.assignmentStream.operation(scope, ref)).toThrow();
  await f.deliver(ref);
  expect(f.journal.execution.start("assignment", 1)).toMatchObject({ claimEffect: { state: "applied", response: { sequence: 2 } } });
  expect(f.journal.assignments.get("assignment:1")?.state).toBe("cancelled");
  expect(f.journal.execution.execution(start.admission)).toBeUndefined();
  expect(f.outbox.depth).toBe(0);
});

it("replays the same admission claim after a lost reply, in order with later pull operations", async () => {
  const f = await fixture(); const ref = f.reference();
  f.submit.mockRejectedValueOnce(new Error("lost response"));
  await expect(f.deliver(ref)).rejects.toThrow("lost response");
  const next = await f.sender.preparePull(pull);
  const scheduled: OutboundMessage[] = []; f.sender.scheduleRetained(message => scheduled.push(message));
  expect(scheduled.map(message => message.assignmentRequest?.requestSequence)).toEqual([ref.requestSequence, next.requestSequence]);
  await f.deliver(ref);
  expect(f.submit.mock.calls[1]![1]).toEqual(f.submit.mock.calls[2]![1]);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(3);
});

it("retains a foreign already-claimed disposition without adopting its claim or executing", async () => {
  const f = await fixture(); const own = f.journal.execution.start("assignment", 1)!;
  f.setForeign(); await f.deliver(f.reference());
  expect(f.journal.assignments.get("assignment:1")?.claimId).toBe(own.admission.claimId);
  expect(f.journal.execution.execution(own.admission)).toBeUndefined();
  expect(f.journal.execution.start("assignment", 1)).toMatchObject({ claimEffect: { state: "applied" } });
  expect(f.journal.assignmentStream.pendingClaims(scope)).toEqual([]);
});

it("does not replay an uncertain claim effect after the full reply was accepted", async () => {
  const f = await fixture(); const ref = f.reference();
  const apply = vi.fn(async () => { throw new Error("dispatch outcome uncertain"); });
  await expect(f.sender.deliverAllocated(ref, apply)).rejects.toThrow("dispatch outcome uncertain");
  expect(f.journal.execution.start("assignment", 1)).toMatchObject({ claimEffect: { state: "applying" } });
  await expect(f.sender.deliverAllocated(ref, apply)).rejects.toMatchObject({ code: "recovery_required" });
  expect(apply).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(2);
});

it("rejects a claim continuation when accepted authority moves during its exchange", async () => {
  const f = await fixture(); const ref = f.reference();
  const original = f.submit.getMockImplementation()!;
  f.submit.mockImplementationOnce(async (...args) => { const result = await original(...args); f.authority.key = "accepted-b"; return result; });
  await expect(f.deliver(ref)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(1);
  expect(f.journal.assignmentStream.pendingClaims(scope)).toHaveLength(1);
});

it("does not mark a claim applied when the original pending local owner is missing", async () => {
  const f = await fixture(); const ref = f.reference();
  (f.work as unknown as { pendingClaims: Map<string, unknown> }).pendingClaims.clear();
  await expect(f.deliver(ref)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.execution.start("assignment", 1)?.claimEffect?.state).not.toBe("applied");
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.journal.assignments.get("assignment:1")?.state).toBe("claimed");
});

it("does not open execution from allocation alone or from a negative claim effect", async () => {
  const f = await fixture(); const admission = f.journal.execution.start("assignment", 1)!.admission;
  await expect(f.journal.execution.open(admission, () => undefined, at)).rejects.toMatchObject({ code: "recovery_required" });
  await f.sender.deliverAllocated(f.reference(), async () => {
    await expect(f.journal.execution.open(admission, () => undefined, at)).rejects.toMatchObject({ code: "recovery_required" });
  });
  expect(f.journal.execution.execution(admission)).toBeUndefined();
});

it("opens the exact admitted generation only during the genuine chosen-claim handoff", async () => {
  const f = await fixture("claimed"); const admission = f.journal.execution.start("assignment", 1)!.admission;
  await f.sender.deliverAllocated(f.reference(), async () => {
    await f.journal.execution.open(admission, f.sender.captureAuthority(), at);
  });
  expect(f.journal.execution.execution(admission)).toMatchObject({ phase: "opened", admission });
  expect(f.journal.execution.start("assignment", 1)).toMatchObject({ claimEffect: { state: "applied" } });
});

it("preserves the claim effect when the original complete admission is repeated", async () => {
  const f = await fixture();
  const { delivery: _delivery, allocation: _allocation, claimEffect: _effect, ...input } = f.journal.execution.start("assignment", 1)!;
  await f.deliver(f.reference());
  const before = f.journal.execution.start("assignment", 1)!;
  await f.journal.execution.beginAdmission(input, () => undefined);
  expect(f.journal.execution.start("assignment", 1)).toEqual(before);
  await expect(f.journal.execution.beginAdmission({ ...input, claimCreatedAt: "2026-09-06T00:00:01.000Z" }, () => undefined)).rejects.toMatchObject({ code: "recovery_required" });
});

it("rejects inconsistent persisted claim-effect evidence and never reconstructs a missing historical effect", async () => {
  const f = await fixture(); const ref = f.reference(); await f.deliver(ref);
  const log = (f.journal as unknown as { executionLog: ExecutionLog }).executionLog;
  const key = JSON.stringify(["admission", "assignment", 1]);
  const original = log.all().find(row => row.kind === "admission_start")!;
  if (original.kind !== "admission_start") throw new Error("missing start fixture");
  await log.update(key, () => ({ ...original, value: { ...original.value, claimEffect: { state: "applied", response: { sequence: 2, digest: "z".repeat(43) } } } }));
  expect(() => f.journal.assignmentStream.snapshot(scope)).toThrow();
  const { claimEffect: _effect, ...historical } = original.value;
  await log.update(key, () => ({ ...original, value: historical }));
  await expect(f.sender.deliverAllocated(ref, async () => undefined)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.execution.start("assignment", 1)?.claimEffect).toBeUndefined();
});

it("does not transmit an old same-manifest claim under a replacement accepted key", async () => {
  const f = await fixture(); const ref = f.reference();
  f.authority.key = "accepted-b";
  await expect(f.deliver(ref)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(() => f.sender.scheduleRetained(() => undefined)).toThrow();
  expect(f.journal.execution.start("assignment", 1)?.claimEffect).toBeUndefined();
});

it("does not fence or duplicate a live claim handoff when maintenance runs during slow native bootstrap", async () => {
  let release!: () => void;
  const barrier = new Promise<never>((_resolve, reject) => { release = () => reject(new Error("bounded input fixture unavailable")); });
  const preparing = vi.fn(() => barrier);
  const f = await fixture("claimed", { runners: new Map([["codex", {} as never]]),
    sessionDeps: () => ({ deploymentKind: "native_connector", instanceId: "instance", prepareInputs: preparing, registerReady: vi.fn() } as never) });
  const ref = f.reference(); const delivery = f.deliver(ref).then(() => undefined, error => error);
  try {
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce());
    const settled = vi.fn(); void delivery.then(settled);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    const admission = f.journal.execution.start("assignment", 1)!.admission;
    // The execution opens only after input preparation and capability
    // redemption, so a slow bootstrap holds it unopened without any fence.
    expect(f.journal.execution.execution(admission)?.phase).toBeUndefined();
    expect((f.work as unknown as { pendingClaims: Map<string, unknown> }).pendingClaims.size).toBe(0);
    expect(f.journal.execution.start("assignment", 1)?.claimEffect?.state).toBe("applied");
    const count = f.sent.filter(message => message.assignmentRequest?.requestSequence === ref.requestSequence).length;
    f.work.pull();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((f.work as unknown as { recoveryFences: Set<string> }).recoveryFences.has("assignment:1")).toBe(false);
    expect(f.sent.filter(message => message.assignmentRequest?.requestSequence === ref.requestSequence)).toHaveLength(count);
  } finally {
    release();
    await vi.waitFor(() => expect((f.work as unknown as { bootstrapping: Map<string, unknown> }).bootstrapping.size).toBe(0));
  }
  expect(await delivery).toBeUndefined();
  expect(f.journal.execution.start("assignment", 1)?.claimEffect?.state).toBe("applied");
});

it("keeps the durable claim handoff applied when its execution owner is later fenced during bootstrap", async () => {
  let release!: () => void;
  const barrier = new Promise<never>((_resolve, reject) => { release = () => reject(new Error("input preparation interrupted")); });
  const preparing = vi.fn(() => barrier);
  const f = await fixture("claimed", { runners: new Map([["codex", {} as never]]),
    sessionDeps: () => ({ deploymentKind: "native_connector", instanceId: "instance", prepareInputs: preparing, registerReady: vi.fn() } as never) });
  const delivery = f.deliver(f.reference()).then(() => undefined, error => error);
  try {
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce());
    await expect(delivery).resolves.toBeUndefined();
    (f.work as unknown as { fenceLostAuthority: (key: string) => void }).fenceLostAuthority("assignment:1");
  } finally {
    release();
    await vi.waitFor(() => expect((f.work as unknown as { bootstrapping: Map<string, unknown> }).bootstrapping.size).toBe(0));
  }
  expect(f.journal.execution.start("assignment", 1)?.claimEffect?.state).toBe("applied");
  expect(f.journal.assignments.get("assignment:1")?.reports.terminalSequence).toBeUndefined();
});
