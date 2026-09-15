import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, computeRemoteReconciliationReceiptSnapshotDigest, type RecoveryDecision } from "@konteks/remote-common";
import { Reconciliation, type ReconciliationDeps } from "../reconnect/reconciliation.js";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { ReportSender } from "../work/report-sender.js";
import type { CoreClient } from "../core/client.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { WorkOrchestrator } from "../work/orchestrator.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "recovery-receipt-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture(decisions: RecoveryDecision[] = []) {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const send = vi.fn();
  const reports = new ReportSender({ journal, outbox, clock, transport: { send } as unknown as TransportManager, instanceId: () => "instance", canSend: () => false, onConflict: async () => undefined, onTerminalDurable: async () => undefined });
  const apply = vi.fn<CoreClient["applyReconciliation"]>(async request => ({ instanceId: request.instanceId, runnerIncarnation: request.runnerIncarnation, manifestId: request.manifestId, receiptDigest: computeRemoteReconciliationReceiptSnapshotDigest(({ instanceId: request.instanceId, runnerIncarnation: request.runnerIncarnation, manifestId: request.manifestId, decisionResults: request.decisionResults, pendingClaimResults: request.pendingClaimResults })), outcome: "accepted", acceptedAt: clock.nowIso() }));
  let floor = 10;
  const reconnect = vi.fn<CoreClient["reconnect"]>(async request => ({ lease: "lease", leaseExpiresAt: "2026-09-06T01:00:00Z", manifest: { instanceId: request.instanceId, runnerIncarnation: request.runnerIncarnation, reconnectIntentId: request.reconnectIntentId, manifestId: "manifest", ownerRevision: 1, issuedAt: clock.nowIso(), applyDeadlineAt: "2026-09-06T01:00:00Z", acceptedHeartbeatSequence: floor, heartbeatSequenceFloor: floor, lease: "lease", decisions, pendingClaimDecisions: [] } }));
  const stop = vi.fn(async () => undefined);
  const deps: ReconciliationDeps = { clock, journal, core: { reconnect, applyReconciliation: apply, resolveRuntimeOwner: async () => ({ instanceId: "instance", currentIncarnation: null, ownerRevision: 0, acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 0 }) } as unknown as CoreClient,
    instanceId: () => "instance", runnerIncarnation: () => "process", assertOwned: () => undefined, bundleVersion: "1.0.0", protocolVersion: "1.0", lastHeartbeatSequence: async () => 0, reserveHeartbeatFloor: async () => undefined, components: {}, stopLocalWork: stop, reports, onLease: async () => undefined };
  const recovery = new Reconciliation(deps);
  const addClaim = () => journal.assignments.put({ assignmentId: "a", attempt: 1, claimId: "claim", kind: "assistant_execution", placementId: "p", workspaceId: "w", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: "2026-09-06T02:00:00Z", latestResumeAt: "2026-09-06T02:00:00Z", updatedAt: clock.nowIso() });
  return { journal, outbox, reports, deps, recovery, apply, reconnect, stop, send, clock, addClaim, advanceFloor: () => { floor = 20; } };
}

async function absentFixture() {
  const f = await fixture([{ action: "cancel", assignmentId: "absent", attempt: 1, reason: "user_cancelled" }]);
  const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: f.clock.nowIso() };
  await f.journal.execution.seedEnrollment(seed);
  await f.journal.execution.bindEnrollment({ ...seed, instanceId: "instance", workspaceId: "w", exchangeNonce: "exchange" });
  const work = new WorkOrchestrator({ clock: f.clock, journal: f.journal, outbox: f.outbox, transport: { send: f.send }, deploymentKind: "native_connector", instanceId: () => "instance", workspaceId: () => "w", runnerIncarnation: () => "process", assertOwned: () => undefined } as never);
  f.deps.cancelAbsentLocalWork = (manifest, decision, assertCurrent) => work.cancelAbsentForRecovery(manifest, decision, assertCurrent);
  return { ...f, work };
}

it("D139 refuses actual ACP-only durable settlement without a terminal report or applied receipt", async () => {
  const f = await fixture([{ action: "report_interrupted", assignmentId: "a", attempt: 1, reason: "agent_session_lost" }]);
  await f.addClaim();
  const admission = { instanceId: "instance", workspaceId: "w", runnerIncarnation: "process", assignmentId: "a", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: f.clock.nowIso() };
  await f.journal.execution.admit(admission, () => undefined); await f.journal.execution.open(admission, () => undefined, f.clock.nowIso()); await f.journal.execution.bindReference(admission, "ref", () => undefined);
  await f.journal.execution.markStopping(admission, f.clock.nowIso(), () => undefined);
  await f.journal.execution.markAcpSettled(admission, "ref", f.clock.nowIso(), () => undefined);
  f.deps.stopLocalWork = async () => f.journal.execution.assertQuiescent(admission);
  await expect(f.recovery.run()).rejects.toThrow("quiescence");
  expect(f.apply).not.toHaveBeenCalled(); expect(f.outbox.depth).toBe(0);
  expect(f.recovery.isComplete).toBe(false);
  expect(f.journal.assignments.get("a:1")?.reports.terminalSequence).toBeUndefined();
});

it("exact absent cancellation fsyncs its tombstone before immutable receipt without a fake claim/report", async () => {
  const f = await absentFixture();
  const apply = f.apply.getMockImplementation()!;
  f.apply.mockImplementation(async request => {
    const disk = new SupervisorJournal(dir); await disk.load();
    expect(disk.execution.tombstone({ manifestId: "manifest", assignmentId: "absent", attempt: 1 })).toMatchObject({ instanceId: "instance", workspaceId: "w", runnerIncarnation: "process" });
    expect(request.decisionResults).toEqual([{ assignmentId: "absent", attempt: 1, disposition: "absent_local_cancelled" }]);
    expect(disk.assignments.all()).toEqual([]); expect(f.outbox.depth).toBe(0);
    return apply(request);
  });
  await f.recovery.run();
  expect(f.recovery.isComplete).toBe(true);
  const result = f.journal.decisions.get("manifest:absent:1");
  expect(result?.claimId).toBeUndefined();
  const receipt = f.journal.recovery.current("instance", "process")?.receipt;
  await f.recovery.run();
  expect(f.journal.recovery.current("instance", "process")?.receipt).toEqual(receipt);
});

it("absence refuses retained prior admissions even after the mutable assignment row is gone", async () => {
  const f = await absentFixture();
  await f.journal.execution.admit({ instanceId: "instance", workspaceId: "w", runnerIncarnation: "predecessor", assignmentId: "absent", attempt: 2, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: f.clock.nowIso() }, () => undefined);
  await expect(f.recovery.run()).rejects.toThrow();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.recovery.isComplete).toBe(false);
  expect(f.journal.execution.tombstone({ manifestId: "manifest", assignmentId: "absent", attempt: 1 })).toBeUndefined();
});

it("tombstone survives outcome-write failure and retry retains its first exact cancellation", async () => {
  const f = await absentFixture();
  const put = f.journal.decisions.put.bind(f.journal.decisions);
  let fail = true;
  vi.spyOn(f.journal.decisions, "put").mockImplementation(async record => {
    if (record.result && fail) { fail = false; throw new Error("outcome disk full"); }
    return put(record);
  });
  await expect(f.recovery.run()).rejects.toThrow("outcome disk full");
  const tombstone = f.journal.execution.tombstone({ manifestId: "manifest", assignmentId: "absent", attempt: 1 });
  expect(tombstone).toBeDefined(); expect(f.apply).not.toHaveBeenCalled();
  await f.recovery.run();
  expect(f.journal.execution.tombstone({ manifestId: "manifest", assignmentId: "absent", attempt: 1 })).toEqual(tombstone);
  expect(f.recovery.isComplete).toBe(true); expect(f.outbox.depth).toBe(0);
});

it("a claim in the immutable intent cannot become absent because its mutable row disappeared", async () => {
  const f = await absentFixture(); await f.addClaim();
  const entry = f.journal.assignments.get("a:1")!;
  await f.journal.assignments.put({ ...entry, assignmentId: "absent" });
  await f.recovery.buildRequest();
  await f.journal.assignments.clear();
  await expect(f.recovery.run()).rejects.toThrow();
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.journal.execution.tombstone({ manifestId: "manifest", assignmentId: "absent", attempt: 1 })).toBeUndefined();
});

it("a known local session cannot be hidden by an empty ordinary journal", async () => {
  const f = await absentFixture();
  (f.work as unknown as { sessions: Map<string, unknown> }).sessions.set("absent:1", { assignment: { id: "absent", attempt: 1 } });
  await expect(f.recovery.run()).rejects.toThrow();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.outbox.depth).toBe(0);
});

it("an empty manifest is incomplete until its durable receipt is accepted", async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const apply = f.apply.getMockImplementation()!;
  f.apply.mockImplementation(async request => {
    const disk = new SupervisorJournal(dir);
    await disk.load();
    expect(disk.recovery.current("instance", "process")?.receipt?.snapshot.decisionResults).toEqual([]);
    expect(f.recovery.isComplete).toBe(false);
    await pending;
    return apply(request);
  });
  const run = f.recovery.run();
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
  expect(f.recovery.isComplete).toBe(false);
  release();
  await run;
  expect(f.recovery.isComplete).toBe(true);
  expect(f.journal.recovery.current("instance", "process")?.state).toBe("applied");
});

it("publishes pending inventory after floor and lease adoption outside the acquisition lane, before applying", async () => {
  const f = await fixture();
  const events: string[] = [];
  let acquiring = false;
  f.deps.withLeaseAcquisition = async operation => {
    acquiring = true;
    try { return await operation(); } finally { acquiring = false; }
  };
  f.deps.reserveHeartbeatFloor = async () => { events.push("floor"); };
  f.deps.onLease = async () => { events.push("lease"); };
  f.deps.afterEstablishment = async assertCurrent => {
    assertCurrent();
    expect(acquiring).toBe(false);
    expect(f.journal.recovery.current("instance", "process")?.manifest).not.toBeNull();
    expect(f.recovery.isComplete).toBe(false);
    events.push("pending-heartbeat");
  };
  const apply = f.apply.getMockImplementation()!;
  f.apply.mockImplementation(async request => { events.push("receipt"); return apply(request); });
  await f.recovery.run();
  expect(events).toEqual(["floor", "lease", "pending-heartbeat", "receipt"]);
});

it("failed pending publication leaves the durable intent retryable and cannot submit a receipt", async () => {
  const f = await fixture();
  f.deps.afterEstablishment = vi.fn().mockRejectedValueOnce(new Error("pending heartbeat unavailable")).mockResolvedValue(undefined);
  await expect(f.recovery.run()).rejects.toThrow("pending heartbeat unavailable");
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.recovery.isComplete).toBe(false);
  const intent = f.journal.recovery.current("instance", "process")!.intent;
  await f.recovery.run();
  expect(f.journal.recovery.current("instance", "process")!.intent).toEqual(intent);
  expect(f.recovery.isComplete).toBe(true);
});

it("fences acceptance when ownership is lost during pending publication", async () => {
  const f = await fixture();
  let owned = true;
  f.deps.assertOwned = () => { if (!owned) throw new Error("ownership lost"); };
  f.deps.afterEstablishment = async () => { owned = false; };
  await expect(f.recovery.run()).rejects.toThrow("ownership lost");
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.recovery.isComplete).toBe(false);
});

it("a lost acceptance response retries the frozen receipt despite advancing heartbeat projections", async () => {
  const f = await fixture();
  f.apply.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "response lost"));
  await expect(f.recovery.run()).rejects.toMatchObject({ code: "temporarily_unavailable" });
  expect(f.recovery.isComplete).toBe(false);
  const frozen = f.journal.recovery.current("instance", "process")?.receipt;
  f.advanceFloor();
  await f.recovery.run();
  expect(f.apply.mock.calls[1]?.[0]).toEqual(f.apply.mock.calls[0]?.[0]);
  expect(f.journal.recovery.current("instance", "process")?.receipt).toEqual(frozen);
  expect(f.recovery.isComplete).toBe(true);
});

it("failed local receipt persistence prevents submission and completion", async () => {
  const f = await fixture();
  vi.spyOn(f.journal.recovery, "prepareReceipt").mockRejectedValueOnce(new Error("receipt write failed"));
  await expect(f.recovery.run()).rejects.toThrow("receipt write failed");
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.recovery.isComplete).toBe(false);
});

it("failed acceptance persistence keeps completion closed", async () => {
  const f = await fixture();
  vi.spyOn(f.journal.recovery, "acceptReceipt").mockRejectedValueOnce(new Error("acceptance write failed"));
  await expect(f.recovery.run()).rejects.toThrow("acceptance write failed");
  expect(f.recovery.isComplete).toBe(false);
});

it("interruption stops local work before producing its exact queued receipt evidence", async () => {
  const f = await fixture([{ action: "report_interrupted", assignmentId: "a", attempt: 1, reason: "agent_session_lost" }]);
  await f.addClaim();
  f.stop.mockImplementation(async () => { expect(f.outbox.depth).toBe(0); });
  await f.recovery.run();
  expect(f.stop).toHaveBeenCalledWith("a", 1);
  const report = f.reports.queuedTerminalReport("a", 1, "claim")!;
  expect(report.result).toMatchObject({ class: "interrupted", reason: "agent_session_lost" });
  expect(f.apply.mock.calls[0]?.[0].decisionResults).toEqual([{ assignmentId: "a", attempt: 1, disposition: "interrupted", terminalReportId: report.reportId, terminalEvidence: { kind: "queued", reportSequence: report.reportSequence, payloadDigest: report.payloadDigest, terminalResultHash: report.result!.terminalResultHash } }]);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.outbox.depth).toBe(1);
});

it("unproven stop cannot produce an interrupted report or recovery receipt", async () => {
  const f = await fixture([{ action: "report_interrupted", assignmentId: "a", attempt: 1, reason: "agent_session_lost" }]);
  await f.addClaim();
  f.stop.mockRejectedValueOnce(new Error("agent still running"));
  await expect(f.recovery.run()).rejects.toThrow("agent still running");
  expect(f.outbox.depth).toBe(0);
  expect(f.apply).not.toHaveBeenCalled();
});

it("unknown local work cannot be treated as applied without an absence tombstone", async () => {
  const f = await fixture([{ action: "cancel", assignmentId: "a", attempt: 1, reason: "removed" }]);
  await expect(f.recovery.run()).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.recovery.isComplete).toBe(false);
});

it.each(["instanceId", "runnerIncarnation", "reconnectIntentId", "ownerRevision"] as const)("control delivery with wrong %s cannot reach local effects", async field => {
  const f = await fixture();
  await f.addClaim();
  await f.recovery.run();
  const response = await f.reconnect.mock.results[0]!.value;
  const candidate = { ...response.manifest, [field]: field === "ownerRevision" ? 99 : "foreign" };
  await expect(f.recovery.apply(candidate)).rejects.toMatchObject({ code: "registration_mismatch" });
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.outbox.depth).toBe(0);
  expect(f.journal.decisions.all()).toEqual([]);
  expect(f.recovery.isComplete).toBe(false);
});

it("an interrupted receipt stays unchanged after its report becomes acknowledged", async () => {
  const f = await fixture([{ action: "report_interrupted", assignmentId: "a", attempt: 1, reason: "agent_session_lost" }]);
  await f.addClaim();
  f.apply.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "response lost"));
  await expect(f.recovery.run()).rejects.toMatchObject({ code: "temporarily_unavailable" });
  const frozen = f.journal.recovery.current("instance", "process")!.receipt!;
  const report = f.reports.queuedTerminalReport("a", 1, "claim")!;
  await f.reports.onAck({ assignmentId: "a", attempt: 1, claimId: "claim", acknowledged: { reportId: report.reportId, reportSequence: report.reportSequence }, terminalSequence: report.reportSequence, durableWatermark: report.reportSequence, outcome: "accepted" });
  await f.recovery.run();
  expect(f.journal.recovery.current("instance", "process")!.receipt).toEqual(frozen);
  expect(f.apply.mock.calls[1]?.[0]).toEqual(f.apply.mock.calls[0]?.[0]);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.outbox.depth).toBe(0);
});

it("a superseded accepted generation cannot keep completion open", async () => {
  const f = await fixture();
  await f.recovery.run();
  const current = f.journal.recovery.current("instance", "process")!;
  await f.journal.recovery.terminate(current.intent, "superseded");
  expect(f.recovery.isComplete).toBe(false);
});

it("known cancellation reports its actual cancelled disposition after stop", async () => {
  const f = await fixture([{ action: "cancel", assignmentId: "a", attempt: 1, reason: "removed" }]);
  await f.addClaim();
  await f.recovery.run();
  expect(f.stop).toHaveBeenCalledWith("a", 1);
  expect(f.reports.queuedTerminalReport("a", 1, "claim")?.result).toMatchObject({ class: "cancelled", reason: "removed" });
  expect(f.apply.mock.calls[0]?.[0].decisionResults[0]).toMatchObject({ disposition: "applied", terminalEvidence: { kind: "queued" } });
});

it("terminal replay reuses the original report rather than producing a replacement", async () => {
  const f = await fixture([{ action: "replay_terminal", assignmentId: "a", attempt: 1, recoveryEpoch: 1, authorization: "authorization" }]);
  await f.addClaim();
  const report = await f.reports.submit({ assignmentId: "a", attempt: 1, claimId: "claim", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
  await f.recovery.run();
  expect(f.apply.mock.calls[0]?.[0].decisionResults[0]).toMatchObject({ disposition: "applied", terminalReportId: report.reportId });
  expect(f.reports.queuedTerminalReport("a", 1, "claim")).toEqual(report);
  expect(f.send).not.toHaveBeenCalled();
});

it("restart disposition stops newAttempt minus one without running the proposed new assignment", async () => {
  const f = await fixture([{ action: "restart_new_attempt_same_instance", priorAssignmentId: "a", newAssignmentId: "b", newAttempt: 2, recoveryEpoch: 1, approvalRequired: true }]);
  await f.addClaim();
  const prior = f.journal.assignments.get("a:1")!;
  await f.journal.assignments.put({ ...prior, attempt: 3, claimId: "other" });
  await f.recovery.run();
  expect(f.stop).toHaveBeenCalledWith("a", 1);
  expect(f.journal.assignments.get("a:1")?.state).toBe("cancelled");
  expect(f.journal.assignments.get("a:3")?.state).toBe("running");
  expect(f.journal.latestAttempt("b")).toBeUndefined();
  expect(f.apply.mock.calls[0]?.[0].decisionResults).toEqual([{ assignmentId: "a", attempt: 1, disposition: "applied" }]);
  expect(f.outbox.depth).toBe(0);
});

it("unproven native checkpoint resume produces interruption, never a resumed disposition", async () => {
  const f = await fixture([{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 1, authorization: "authorization", latestResumeAt: "2026-09-06T01:00:00Z" }]);
  await f.addClaim();
  await f.recovery.run();
  expect(f.reports.queuedTerminalReport("a", 1, "claim")?.result).toMatchObject({ class: "interrupted", reason: "checkpoint_invalid" });
  expect(f.apply.mock.calls[0]?.[0].decisionResults[0]).toMatchObject({ disposition: "interrupted", terminalEvidence: { kind: "queued" } });
});

it("a failed receipt write retries the saved decision without changing its disposition or report", async () => {
  const f = await fixture([{ action: "report_interrupted", assignmentId: "a", attempt: 1, reason: "agent_session_lost" }]);
  await f.addClaim();
  vi.spyOn(f.journal.recovery, "prepareReceipt").mockRejectedValueOnce(new Error("receipt write failed"));
  await expect(f.recovery.run()).rejects.toThrow("receipt write failed");
  const record = f.journal.decisions.get("manifest:a:1")!;
  expect(record.result?.disposition).toBe("interrupted");
  await f.recovery.run();
  expect(f.apply.mock.calls[0]?.[0].decisionResults).toEqual([record.result]);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.outbox.depth).toBe(1);
});

it.each(["replay_terminal", "restart_new_attempt_same_instance"] as const)("%s survives a failed decision-result append without an unrecoverable equal epoch", async action => {
  const decision: RecoveryDecision = action === "replay_terminal" ? { action, assignmentId: "a", attempt: 1, recoveryEpoch: 1, authorization: "authorization" } : { action, priorAssignmentId: "a", newAssignmentId: "b", newAttempt: 2, recoveryEpoch: 1, approvalRequired: true };
  const f = await fixture([decision]);
  await f.addClaim();
  if (action === "replay_terminal") await f.reports.submit({ assignmentId: "a", attempt: 1, claimId: "claim", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
  const put = f.journal.decisions.put.bind(f.journal.decisions);
  vi.spyOn(f.journal.decisions, "put").mockImplementationOnce(put).mockRejectedValueOnce(new Error("decision write failed"));
  await expect(f.recovery.run()).rejects.toThrow("decision write failed");
  vi.restoreAllMocks();
  await f.recovery.run();
  expect(f.recovery.isComplete).toBe(true);
  expect(f.journal.assignments.get("a:1")?.recoveryEpoch).toBe(1);
});

it.each(["cancel", "report_interrupted"] as const)("%s rejects a claim replaced during stop", async action => {
  const decision: RecoveryDecision = action === "cancel" ? { action, assignmentId: "a", attempt: 1, reason: "removed" } : { action, assignmentId: "a", attempt: 1, reason: "agent_session_lost" };
  const f = await fixture([decision]);
  await f.addClaim();
  f.stop.mockImplementation(async () => { const entry = f.journal.assignments.get("a:1")!; await f.journal.assignments.put({ ...entry, claimId: "replacement" }); });
  await expect(f.recovery.run()).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.outbox.depth).toBe(0);
  expect(f.journal.assignments.get("a:1")?.reports.nextSequence).toBe(1);
  expect(f.apply).not.toHaveBeenCalled();
});

it("recovers an interrupted checkpoint outcome ACKed before its decision result was saved", async () => {
  const f = await fixture([{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 1, authorization: "authorization", latestResumeAt: "2026-09-06T01:00:00Z" }]);
  await f.addClaim();
  const put = f.journal.decisions.put.bind(f.journal.decisions);
  vi.spyOn(f.journal.decisions, "put").mockImplementationOnce(put).mockRejectedValueOnce(new Error("decision write failed"));
  await expect(f.recovery.run()).rejects.toThrow("decision write failed");
  vi.restoreAllMocks();
  const report = f.reports.queuedTerminalReport("a", 1, "claim")!;
  await f.reports.onAck({ assignmentId: "a", attempt: 1, claimId: "claim", acknowledged: { reportId: report.reportId, reportSequence: report.reportSequence }, terminalSequence: report.reportSequence, durableWatermark: report.reportSequence, outcome: "accepted" });
  await f.recovery.run();
  expect(f.apply.mock.calls[0]?.[0].decisionResults[0]).toMatchObject({ disposition: "interrupted", terminalReportId: report.reportId, terminalEvidence: { kind: "acknowledged" } });
});

it("repairs an assignment projection from the committed outcome without repeating stop", async () => {
  const f = await fixture([{ action: "restart_new_attempt_same_instance", priorAssignmentId: "a", newAssignmentId: "b", newAttempt: 2, recoveryEpoch: 1, approvalRequired: true }]);
  await f.addClaim();
  vi.spyOn(f.journal.assignments, "update").mockRejectedValueOnce(new Error("projection failed"));
  await expect(f.recovery.run()).rejects.toThrow("projection failed");
  expect(f.journal.decisions.get("manifest:a:1")?.result).toMatchObject({ disposition: "applied" });
  expect(f.journal.assignments.get("a:1")?.recoveryEpoch).toBe(0);
  await f.recovery.run();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.journal.assignments.get("a:1")).toMatchObject({ state: "cancelled", recoveryEpoch: 1 });
});
