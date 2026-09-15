import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, logicalAssignmentResponseDigest } from "@konteks/remote-common";
import { AssignmentSender } from "../work/assignment-sender.js";
import { SupervisorJournal } from "../state/journal.js";
import { AssignmentStreamJournal, allocationReference } from "../state/assignment-stream.js";
import type { AssignmentRequestRecord } from "../state/assignment-stream.js";
import type { ExecutionLog } from "../state/local-execution.js";

const at = "2026-09-06T00:00:00.000Z";
const scope = { instanceId: "instance", workspaceId: "workspace" };
const origin = { runnerIncarnation: "process", manifestId: "manifest" };
const input = { ...scope, runnerIncarnation: "process", origin, issuedAt: at,
  body: { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] } };
const own = () => undefined;
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "assignment-retirement-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const journal = new SupervisorJournal(dir); await journal.load();
  const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at, assignmentStreamVersion: 1 };
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  return journal;
}
function log(journal: SupervisorJournal) {
  return (journal as unknown as { executionLog: ExecutionLog & {
    compactInternal(entries?: Map<string, unknown>): Promise<void>;
    syncDirectory(): Promise<void>;
  } }).executionLog;
}
function reply(request: AssignmentRequestRecord, sequence = request.frame.seq, body: unknown = { assignments: [] }) {
  const ref = allocationReference(request);
  const frame = { channel: "assignment", direction: "to_runtime", channelId: "assignment:instance", seq: sequence, issuedAt: at,
    body: { ...ref, body } };
  return { schemaVersion: 2, ...scope, request: ref, response: { sequence, digest: logicalAssignmentResponseDigest(frame) }, frame };
}
async function finish(journal: SupervisorJournal, request: AssignmentRequestRecord, sequence = request.frame.seq) {
  await journal.assignmentStream.acceptReply(reply(request, sequence), own);
  await journal.assignmentStream.beginOperationEffect(scope, allocationReference(request), own);
  await journal.assignmentStream.finishOperationEffect(scope, allocationReference(request), own);
}
async function ack(journal: SupervisorJournal, sequence: number, assert = own) {
  await journal.assignmentStream.observeCoreRequestAck(scope, { kind: "ack", origin: "core", dataDirection: "to_core",
    channelId: "assignment:instance", cumulativeSeq: sequence, issuedAt: at }, assert);
}

it("compacts completed pulls after genuine ACK, preserving counters across reopen and refusing retired identity", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "original" }, own);
  await finish(journal, request);
  await ack(journal, 1);
  await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1, nativeConsumedReplySequence: 1,
    observedCoreRequestAckSequence: 1, retiredThroughRequestSequence: 1, compactedThroughReplySequence: 1 });
  expect(log(journal).all().map(row => row.kind)).toEqual(["enrollment_bound", "assignment_stream"]);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(() => reopened.assignmentStream.request(scope, 1)).toThrow(expect.objectContaining({ code: "assignment_replay_retired" }));
  await expect(reopened.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "original" }, own)).rejects.toThrow();
  const next = await reopened.assignmentStream.allocatePull(input, own);
  expect(next.frame.seq).toBe(2);
  expect(next.operationId).not.toBe(request.operationId);
});

it("neither consumed replies alone nor request ACK alone retires a slot", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "one" }, own);
  await ack(journal, 1);
  await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(0);
  await finish(journal, request);
  // The previous explicit observation is still genuine; it now covers this exact reply.
  await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(1);
  const next = await journal.assignmentStream.allocatePull(input, own);
  await finish(journal, next);
  await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(1);
});

it.each(["pending", "applying"])("preserves %s domain effect and all its evidence despite ACK coverage", async phase => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "one" }, own);
  await journal.assignmentStream.acceptReply(reply(request), own);
  if (phase === "applying") await journal.assignmentStream.beginOperationEffect(scope, allocationReference(request), own);
  await ack(journal, 1);
  const before = log(journal).all();
  await journal.assignmentStream.retire(scope, own);
  expect(log(journal).all()).toEqual(before);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(0);
});

it("maintenance releases allocation pressure without resetting sequence or retaining completed pull history", async () => {
  const journal = await fixture();
  const owner = new AssignmentStreamJournal(log(journal), journal.execution, { maxRequests: 1, maxBytes: 16384 });
  for (let sequence = 1; sequence <= 8; sequence++) {
    const request = await owner.allocatePull(input, own);
    expect(request.frame.seq).toBe(sequence);
    await finish(journal, request);
    await expect(owner.allocatePull(input, own)).rejects.toThrow();
    await ack(journal, sequence);
    await owner.retire(scope, own);
  }
  expect(log(journal).all()).toHaveLength(2);
  expect((await readFile(join(dir, "local-execution.jsonl"), "utf8")).length).toBeLessThan(1600);
});

it("does not infer digest equality for a full authenticated replay below the retired floor", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "one" }, own);
  await finish(journal, request); await ack(journal, 1); await journal.assignmentStream.retire(scope, own);
  const incoming = reply(request);
  incoming.frame.issuedAt = "2026-09-06T00:00:01.000Z";
  incoming.response.digest = logicalAssignmentResponseDigest(incoming.frame);
  await expect(journal.assignmentStream.acceptReply(incoming, own)).rejects.toMatchObject({ code: "assignment_replay_retired" });
  expect(journal.assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(1);
});

it("failed rewrite preserves all records and a successful retry publishes one coherent floor", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "one" }, own);
  await finish(journal, request); await ack(journal, 1);
  const before = log(journal).all();
  vi.spyOn(log(journal), "compactInternal").mockRejectedValueOnce(new Error("fsync failed"));
  await expect(journal.assignmentStream.retire(scope, own)).rejects.toThrow("fsync failed");
  expect(log(journal).all()).toEqual(before);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(0);
  await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(1);
});

it("fences a renamed-but-unconfirmed rewrite until reopen instead of authorizing stale in-memory state", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "one" }, own);
  await finish(journal, request); await ack(journal, 1);
  vi.spyOn(log(journal), "syncDirectory").mockRejectedValueOnce(new Error("directory sync failed"));
  await expect(journal.assignmentStream.retire(scope, own)).rejects.toThrow("directory sync failed");
  expect(() => journal.assignmentStream.snapshot(scope)).toThrow();
  await expect(journal.assignmentStream.allocatePull(input, own)).rejects.toThrow();
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(1);
});

it("authority movement during rewrite preserves durable retirement without granting continuation", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({ ...input, kind: "pull", operationId: "one" }, own);
  await finish(journal, request); await ack(journal, 1);
  let checks = 0;
  await expect(journal.assignmentStream.retire(scope, () => { if (++checks === 2) throw new Error("authority changed"); })).rejects.toThrow("authority changed");
  expect((await (async () => { const reopened = new SupervisorJournal(dir); await reopened.load(); return reopened; })()).assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(1);
});

it("uses each exact response sequence, retaining report retry and terminal evidence across an independent reply prefix", async () => {
  const journal = await fixture();
  const body = { assignmentId: "assignment", attempt: 1, claimId: "claim", reportId: "report", reportSequence: 1,
    payloadDigest: "a".repeat(43), terminal: true, reportedAt: at, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } };
  const owner = { reportId: "report", key: "report:assignment:1:claim:1", group: "report:assignment:1:claim", order: 1 };
  const report = await journal.assignmentStream.allocateOperation({ ...input, kind: "report", operationId: "report-op", body, report: owner }, own);
  const poll = await journal.assignmentStream.allocatePull(input, own);
  await finish(journal, poll, 1); // Request 2's reply is sequence 1, not 2.
  await ack(journal, 2); await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(0);
  const evidence = reply(report, 2, { assignmentId: "assignment", attempt: 1, claimId: "claim",
    acknowledged: { reportId: "report", reportSequence: 1 }, outcome: "sequence_gap", durableWatermark: 0 });
  await journal.assignmentStream.acceptReply(evidence, own);
  await journal.assignmentStream.beginOperationEffect(scope, allocationReference(report), own);
  await journal.assignmentStream.finishOperationEffect(scope, allocationReference(report), own);
  await journal.assignmentStream.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ retiredThroughRequestSequence: 2, compactedThroughReplySequence: 2 });
  expect(journal.assignmentStream.operationReply(scope, allocationReference(report))).toEqual(evidence);
  expect(log(journal).all().some(row => row.kind === "assignment_request" && row.value.frame.seq === 2)).toBe(false);
  const retry = await journal.assignmentStream.allocateOperation({ ...input, kind: "report", operationId: "retry", body, report: owner,
    retryAfter: allocationReference(report) }, own);
  expect(retry.frame.seq).toBe(3);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.assignmentStream.operationReply(scope, allocationReference(report))).toEqual(evidence);
  expect(reopened.assignmentStream.operation(scope, allocationReference(retry))).toMatchObject({ retryAfter: { request: allocationReference(report), response: evidence.response } });
});

it("retains the genuine chosen claim, admission and opened execution when its transport prefix retires", async () => {
  const journal = await fixture();
  const admission = { ...scope, runnerIncarnation: "process", assignmentId: "assignment", attempt: 1, claimId: "claim",
    agentId: "codex", executionGeneration: "generation", openedAt: at };
  await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission, evidenceUpload: "structured_only", projectionCreatedAt: at, claimCreatedAt: at,
    assignment: { id: "assignment", kind: "delivery", placementId: "placement", ...scope, taskId: "task", correlationId: "correlation", attempt: 1,
      expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "planner", agentId: "codex" },
      source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
      policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
        latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true } } }, own);
  const claim = await journal.assignmentStream.allocateClaim({ admission, origin, issuedAt: at }, own);
  const evidence = reply(claim, 1, { assignmentId: "assignment", attempt: 1, claimId: "claim", outcome: "claimed" });
  await journal.assignmentStream.acceptReply(evidence, own);
  await journal.assignmentStream.beginClaimEffect(scope, allocationReference(claim), own);
  await journal.execution.open(admission, own, at);
  await journal.assignmentStream.finishClaimEffect(scope, allocationReference(claim), own);
  const before = log(journal).all().filter(row => row.kind !== "assignment_stream");
  await ack(journal, 1); await journal.assignmentStream.retire(scope, own);
  expect(log(journal).all().filter(row => row.kind !== "assignment_stream")).toEqual(before);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.execution.execution(admission)).toMatchObject({ phase: "opened", admission });
  expect(reopened.execution.start("assignment", 1)?.claimEffect?.state).toBe("applied");
  expect(reopened.assignmentStream.replyForRequest(scope, allocationReference(claim))).toEqual(evidence);
});

it("the real sender socket ACK owner composes retirement without submitting or executing anything", async () => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocatePull(input, own);
  await finish(journal, request);
  const submit = vi.fn();
  const sender = new AssignmentSender({ journal, clock: new FixedClock(Date.parse(at)), core: { submitAssignment: submit } as never,
    instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process", originManifestId: () => "manifest",
    assertOwned: own, captureRecoveryAuthority: () => own, captureClaimAuthority: () => own });
  await sender.observeRelayedRequestAck({ kind: "ack", origin: "core", dataDirection: "to_core", connectionEpoch: 1,
    channelId: "assignment:instance", cumulativeSeq: 1, issuedAt: at });
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(1);
  expect(sender.relayCursors()).toEqual({ channelId: "assignment:instance", to_core: 1, to_runtime: 1 });
  const next = await sender.preparePull(input.body as Parameters<AssignmentSender["preparePull"]>[0]);
  expect(next.requestSequence).toBe(2);
  expect(submit).not.toHaveBeenCalled();
});

it.each(["bytes", "count"])("rejects a receipt crossing %s capacity before persistence while ACK retirement remains available", async dimension => {
  const journal = await fixture();
  const limits = dimension === "bytes" ? { maxRecords: 16_384, maxBytes: 1 } : { maxRecords: 1, maxBytes: 64 * 1024 * 1024 };
  const owner = new AssignmentStreamJournal(log(journal), journal.execution, { maxRequests: 2048, maxBytes: 16 * 1024 * 1024 }, limits);
  const original = await journal.assignmentStream.allocatePull(input, own);
  let request = original;
  if (dimension === "count") {
    await finish(journal, original);
    request = await journal.assignmentStream.allocatePull(input, own);
  }
  const before = log(journal).all();
  await expect(owner.acceptReply(reply(request), own)).rejects.toMatchObject({ code: "assignment_transport_capacity" });
  expect(log(journal).all()).toEqual(before);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.assignmentStream.snapshot(scope)).toEqual(journal.assignmentStream.snapshot(scope));
  // Even below a deliberately tiny new-receipt limit, the genuine ACK owner
  // remains usable and never manufactures consumption for the refused reply.
  await owner.observeCoreRequestAck(scope, { kind: "ack", origin: "core", dataDirection: "to_core", channelId: "assignment:instance",
    cumulativeSeq: request.frame.seq, issuedAt: at }, own);
  await owner.retire(scope, own);
  expect(journal.assignmentStream.snapshot(scope).retiredThroughRequestSequence).toBe(request.frame.seq - 1);
});
