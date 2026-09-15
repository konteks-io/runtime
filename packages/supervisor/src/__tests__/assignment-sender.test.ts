import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, logicalAssignmentResponseDigest } from "@konteks/remote-common";
import { AssignmentSender } from "../work/assignment-sender.js";
import { SupervisorJournal } from "../state/journal.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "assignment-sender-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const at = "2026-09-06T00:00:00.000Z";
const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at, assignmentStreamVersion: 1 };
const scope = { instanceId: "instance", workspaceId: "workspace" };
const admission = (id: string) => ({ ...scope, runnerIncarnation: "process", assignmentId: id, attempt: 1, claimId: `claim-${id}`, agentId: "codex", executionGeneration: `generation-${id}`, openedAt: at });
const start = (id: string) => ({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: admission(id), assignment: {
  id, kind: "delivery", placementId: "placement", ...scope, taskId: "task", correlationId: "correlation", attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "generator", agentId: "codex" },
  source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
}, evidenceUpload: "structured_only", projectionCreatedAt: at, claimCreatedAt: at });

async function fixture(reply: (frame: { seq: number }) => unknown = () => ({ assignments: [] })) {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  const submitAssignment = vi.fn(async (_instanceId: string, frame: { seq: number; channelId: string; body: Record<string, unknown> }) => {
    const kind = "maxItems" in frame.body ? "pull" : "reportId" in frame.body ? "report" : "claim";
    const replyBody = {
      requestSequence: frame.seq, requestDigest: journal.assignmentStream.request(scope, frame.seq)!.digest,
      requestKind: kind, body: reply(frame),
    };
    const replyFrame = { channel: "assignment", direction: "to_runtime", channelId: frame.channelId, seq: frame.seq, issuedAt: at, body: replyBody };
    return { disposition: "accepted" as const, response: { deliveryId: `d-${frame.seq}`, sequence: frame.seq, digest: logicalAssignmentResponseDigest(replyFrame) }, frame: replyFrame };
  });
  const authority = { instanceId: "instance", workspaceId: "workspace", process: "process", manifest: "manifest" };
  const recovery = { key: "accepted-generation-a" as string | null };
  const acknowledgeAssignments = vi.fn(async () => {
    const state = journal.assignmentStream.snapshot(scope);
    return { instanceId: "instance", channelId: "assignment:instance", requestNonce: "a".repeat(22),
      requestAck: { kind: "ack", origin: "core", dataDirection: "to_core", channelId: "assignment:instance", cumulativeSeq: state.allocatedThrough, issuedAt: at },
      committedRequestSequence: state.allocatedThrough, observedRequestAckSequence: state.observedCoreRequestAckSequence,
      retiredThroughRequestSequence: 0, allocatedReplySequence: state.nativeConsumedReplySequence, consumedReplySequence: state.nativeConsumedReplySequence };
  });
  const sender = new AssignmentSender({
    clock: new FixedClock(Date.parse(at)), journal,
    core: { submitAssignment, acknowledgeAssignments } as never,
    instanceId: () => authority.instanceId, workspaceId: () => authority.workspaceId,
    runnerIncarnation: () => authority.process, originManifestId: () => authority.manifest,
    assertOwned: () => undefined,
    captureRecoveryAuthority: () => new RecoveryAuthority(() => recovery.key).capture("assignment"),
    captureClaimAuthority: () => new RecoveryAuthority(() => recovery.key).capture("assignment"),
  });
  const pull = async (body: Parameters<AssignmentSender["preparePull"]>[0]) => {
    const reference = await sender.preparePull(body);
    let delivered: unknown;
    await sender.deliverAllocated(reference, async result => { delivered = result; });
    return delivered;
  };
  const claim = async (chosen: Parameters<AssignmentSender["prepareClaim"]>[0]) => {
    const reference = await sender.prepareClaim(chosen, () => undefined);
    let delivered: unknown;
    await sender.deliverAllocated(reference, async result => { delivered = result; });
    return delivered;
  };
  return { journal, sender, pull, claim, submitAssignment, acknowledgeAssignments, authority, recovery };
}

const pullBody = { instanceId: "instance", maxItems: 3, acceptedKinds: ["delivery"] as const };

it("freezes the frame and sequence before sending, then durably handles the reply", async () => {
  const f = await fixture();
  const available = await f.pull({ ...pullBody });
  expect(available).toEqual({ assignments: [] });
  const sent = f.submitAssignment.mock.calls[0]![1];
  expect(sent).toMatchObject({ seq: 1, channelId: "assignment:instance", origin: { runnerIncarnation: "process", manifestId: "manifest" } });
  // The retained frame is the one that went on the wire, and its reply is handled.
  expect(f.journal.assignmentStream.request(scope, 1)?.frame).toEqual(sent);
  expect(f.journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1, nativeConsumedReplySequence: 1 });
});

it("carries a claim under its exact admission and returns the owner verdict", async () => {
  const f = await fixture(frame => ({ assignmentId: (frame as never as { body: { assignmentId: string } }).body.assignmentId, attempt: 1, claimId: "claim-a", outcome: "claimed" }));
  await f.journal.execution.beginAdmission(start("a"), () => undefined);
  const verdict = await f.claim(admission("a"));
  expect(verdict).toMatchObject({ outcome: "claimed", claimId: "claim-a" });
  expect(f.journal.assignmentStream.request(scope, 1)?.admission).toMatchObject({ assignmentId: "a", claimId: "claim-a" });
  expect(f.journal.execution.start("a", 1)).toMatchObject({ delivery: "allocated", allocation: { requestKind: "claim" } });
});

it("keeps a durably handled request out of the acceptance-unresolved inventory", async () => {
  const f = await fixture(() => ({ assignmentId: "a", attempt: 1, claimId: "claim-a", outcome: "denied", reason: "assignment_conflict" }));
  await f.journal.execution.beginAdmission(start("a"), () => undefined);
  await f.claim(admission("a"));
  expect(f.journal.assignmentStream.pendingClaims(scope)).toEqual([]);
});

it("refuses a reply that correlates to another request without consuming a slot", async () => {
  const f = await fixture();
  f.submitAssignment.mockImplementation(async () => ({
    disposition: "accepted" as const, response: { deliveryId: "d", sequence: 1, digest: "z".repeat(43) },
    frame: { channel: "assignment", direction: "to_runtime", channelId: "assignment:instance", seq: 1, issuedAt: at,
      body: { requestSequence: 9, requestDigest: "b".repeat(43), requestKind: "pull" as const, body: { assignments: [] } } },
  }));
  await expect(f.pull({ ...pullBody })).rejects.toMatchObject({ code: "registration_mismatch" });
  expect(f.journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1, nativeConsumedReplySequence: 0 });
});

it("treats a gap and a retired slot as local history problems, never business outcomes", async () => {
  const f = await fixture();
  f.submitAssignment.mockResolvedValueOnce({ disposition: "sequence_gap", expectedSequence: 4 } as never);
  await expect(f.pull({ ...pullBody })).rejects.toMatchObject({ code: "assignment_sequence_gap" });
  f.submitAssignment.mockResolvedValueOnce({ disposition: "replay_retired", retiredThroughRequestSequence: 3 } as never);
  await expect(f.pull({ ...pullBody })).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.assignmentStream.snapshot(scope)).toMatchObject({ nativeConsumedReplySequence: 0 });
});

it("delivers a closed correlated refusal to the actual consumer without fabricating work", async () => {
  const f = await fixture(() => ({ kind: "request_refused", reason: "instance_draining" }));
  await expect(f.pull({ ...pullBody })).resolves.toEqual({ kind: "request_refused", reason: "instance_draining" });
  // A refusal is still a committed reply: its slot is durably handled.
  expect(f.journal.assignmentStream.snapshot(scope)).toMatchObject({ nativeConsumedReplySequence: 1 });
});

it("preserves a superseded-origin disposition for its explicit domain consumer", async () => {
  const f = await fixture(() => ({ kind: "request_obsolete", reason: "origin_superseded" }));
  await expect(f.pull({ ...pullBody })).resolves.toEqual({ kind: "request_obsolete", reason: "origin_superseded" });
});

it("uses only an explicit Core ACK for observation and permits zero-request housekeeping", async () => {
  const f = await fixture();
  await f.sender.acknowledge();
  expect(f.acknowledgeAssignments).toHaveBeenCalledWith("instance", { observedRequestAckSequence: 0, consumedReplySequence: 0 });
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  await f.pull({ ...pullBody });
  await f.sender.acknowledge();
  expect(f.acknowledgeAssignments).toHaveBeenCalledWith("instance", { observedRequestAckSequence: 0, consumedReplySequence: 1 });
  expect(f.journal.assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(1);
  await f.sender.acknowledge();
  expect(f.acknowledgeAssignments).toHaveBeenLastCalledWith("instance", { observedRequestAckSequence: 1, consumedReplySequence: 1 });
});

it.each(["instanceId", "workspaceId", "process", "manifest"] as const)("rejects %s movement while the explicit ACK is in flight", async field => {
  const f = await fixture(); await f.pull({ ...pullBody });
  const result = await f.acknowledgeAssignments();
  f.acknowledgeAssignments.mockImplementationOnce(async () => { f.authority[field] = "successor"; return result; });
  await expect(f.sender.acknowledge()).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(0);
});

it("does not infer observation from successful HTTP or raw committed counters without an ACK", async () => {
  const f = await fixture(); await f.pull({ ...pullBody });
  const result = await f.acknowledgeAssignments();
  f.acknowledgeAssignments.mockResolvedValueOnce({ ...result, requestAck: undefined } as never);
  await expect(f.sender.acknowledge()).rejects.toThrow();
  expect(f.journal.assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(0);
});

it("fences an ACK after the accepted authority changes within the same process and manifest", async () => {
  const f = await fixture(); await f.pull({ ...pullBody });
  const result = await f.acknowledgeAssignments();
  f.acknowledgeAssignments.mockImplementationOnce(async () => { f.recovery.key = null; f.recovery.key = "accepted-generation-b"; return result; });
  await expect(f.sender.acknowledge()).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(0);
});

it("keeps ACK observation at zero after an uncertain request delivery", async () => {
  const f = await fixture();
  f.submitAssignment.mockRejectedValueOnce(new Error("connection lost"));
  await expect(f.pull({ ...pullBody })).rejects.toThrow("connection lost");
  expect(f.journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1, observedCoreRequestAckSequence: 0 });
  await f.sender.acknowledge();
  expect(f.acknowledgeAssignments).toHaveBeenCalledWith("instance", { observedRequestAckSequence: 0, consumedReplySequence: 0 });
  expect(f.journal.assignmentStream.request(scope, 1)).toBeDefined();
});
