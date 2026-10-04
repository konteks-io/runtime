import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import type { LocalAdmission } from "../state/local-admission.js";

// Every review turn of a task continues one QA delivery
// session. A continuation the person cancelled kept its journal record
// `opened` (no stop, no settlement) while the review it continued was marked
// `continued`, so every later review naming that completed review was refused
// at activation and reported interrupted(not_resumable), restart or not.

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cancelled-continuation-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const clock = new FixedClock(Date.parse("2026-10-01T09:40:00Z"));
const current = () => undefined;
const processOwner = { version: 1 as const, platform: "darwin" as const, pid: 42, processGroupId: 42,
  startToken: "start-token", commandDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const admission = (assignmentId: string, runnerIncarnation = "process", openedAt = "2026-10-01T09:30:00.000Z"): LocalAdmission => ({
  instanceId: "instance", workspaceId: "workspace", runnerIncarnation, assignmentId, attempt: 1, claimId: `${assignmentId}-claim`,
  agentId: "claude-code", executionGeneration: `${assignmentId}-generation`, openedAt });
const policy = { maxDurationSeconds: 3600, maxArtifactBytes: 0, evidenceUpload: "structured_only" as const, allowedArtifactKinds: [], recoveryMode: "report_interrupted" as const,
  latestResumeAt: "2026-10-01T11:00:00.000Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true };
type Turn = { invocationId: string; dispatchGeneration: number; predecessor?: { invocationId: string; dispatchGeneration: number } };
const review = (identity: LocalAdmission, invocationId: string, predecessor?: string): RemoteWorkAssignment => {
  const turn: Turn = { invocationId, dispatchGeneration: 0, ...(predecessor ? { predecessor: { invocationId: predecessor, dispatchGeneration: 0 } } : {}) };
  return {
    id: identity.assignmentId, kind: "validation", placementId: `placement-${identity.assignmentId}`, instanceId: identity.instanceId,
    workspaceId: identity.workspaceId, taskId: "repository-task", correlationId: invocationId, attempt: identity.attempt,
    expiresAt: "2026-10-01T11:00:00.000Z", requiredCapabilities: [],
    agentRoute: { requiredRole: "qa", agentId: identity.agentId, sessionConfig: { model: "claude-sonnet" } },
    source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: identity.instanceId,
      executionSessionId: "repository-qa-session", repositoryId: "https://git.example.com/acme/store",
      modelBinding: { canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet" }, turn },
    policy };
};

async function admit(journal: SupervisorJournal, identity: LocalAdmission, assignment: RemoteWorkAssignment): Promise<void> {
  await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment, evidenceUpload: "structured_only",
    projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
  await journal.execution.reserveAllocation(identity, current);
}

/** A claim the connector is still running: no terminal report yet. */
async function runningClaim(journal: SupervisorJournal, identity: LocalAdmission): Promise<void> {
  await journal.assignments.put({ assignmentId: identity.assignmentId, attempt: 1, claimId: identity.claimId, kind: "validation", placementId: `placement-${identity.assignmentId}`,
    workspaceId: "workspace", agentId: identity.agentId, state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 },
    evidenceUpload: "structured_only", expiresAt: "2026-10-01T11:00:00.000Z", latestResumeAt: "2026-10-01T11:00:00.000Z", updatedAt: clock.nowIso() });
}

/** A terminal claim with the given result, optionally acknowledged by Core. */
async function terminalClaim(journal: SupervisorJournal, identity: LocalAdmission, result: { class: "cancelled"; reason: "user_cancelled" } | { class: "succeeded" } | { class: "interrupted"; reason: "not_resumable" }, acknowledged: boolean): Promise<void> {
  const hash = "c".repeat(43);
  await journal.assignments.put({ assignmentId: identity.assignmentId, attempt: 1, claimId: identity.claimId, kind: "validation", placementId: `placement-${identity.assignmentId}`,
    workspaceId: "workspace", agentId: identity.agentId, state: acknowledged ? "completed" : "terminal_pending_report", recoveryEpoch: 0, terminalResultHash: hash,
    reports: { nextSequence: 2, durableWatermark: acknowledged ? 1 : 0, terminalSequence: 1,
      terminalResult: { ...result, terminalResultHash: hash } as never,
      ...(acknowledged ? { terminalAck: ack(identity, 1) } : {}) },
    evidenceUpload: "structured_only", expiresAt: "2026-10-01T11:00:00.000Z", latestResumeAt: "2026-10-01T11:00:00.000Z", updatedAt: clock.nowIso() });
}

const ack = (identity: LocalAdmission, sequence: number) => ({ assignmentId: identity.assignmentId, attempt: 1, claimId: identity.claimId,
  acknowledged: { reportId: randomUUID(), reportSequence: sequence }, durableWatermark: sequence, terminalSequence: sequence, outcome: "accepted" as const });

/** Core's acknowledgement of whatever terminal report the connector queued. */
async function acknowledge(journal: SupervisorJournal, identity: LocalAdmission): Promise<void> {
  const key = `${identity.assignmentId}:1`;
  await journal.assignments.update(key, entry => {
    const sequence = entry!.reports.terminalSequence!;
    return { ...entry!, state: "completed", reports: { ...entry!.reports, durableWatermark: sequence, terminalAck: ack(identity, sequence) } };
  });
}

function orchestrator(journal: SupervisorJournal, outbox: DurableOutbox, runnerIncarnation: string) {
  const runner = { stopRetainedExecution: vi.fn(async (_owner: unknown) => undefined), releaseSealedSession: vi.fn(async () => undefined) };
  const work = new WorkOrchestrator({ journal, outbox, transport: {}, clock, runners: new Map([["claude-code", runner]]),
    sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => runnerIncarnation, assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = work as unknown as {
    channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    onSessionClosed(session: unknown, reason: "cancelled" | "completed", assertAuthority: () => void): Promise<void>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };
  return { work, internal, runner };
}

/** Review 1 completed; review 2 continued its live ACP session and is running. */
async function continuedReviews(nextIncarnation = "process") {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const completed = admission("completed");
  const cancelled = admission("cancelled", "process", "2026-10-01T09:35:00.000Z");
  const next = admission("next", nextIncarnation, "2026-10-01T09:39:00.000Z");
  await admit(journal, completed, review(completed, "qa-1"));
  await admit(journal, cancelled, review(cancelled, "qa-2", "qa-1"));
  await admit(journal, next, review(next, "qa-3", "qa-1"));
  await journal.execution.open(completed, current, completed.openedAt);
  await journal.execution.bindReference(completed, "qa-ref", current);
  await journal.execution.bindProcessOwner(completed, processOwner, current);
  await journal.execution.markCompletedTurnSettled(completed, "qa-ref", "2026-10-01T09:30:30.000Z", current);
  await terminalClaim(journal, completed, { class: "succeeded" }, true);
  await journal.execution.transferLiveContinuation({ predecessor: completed, successor: cancelled, sessionId: "repository-qa-session",
    acpSessionRef: "qa-ref", processOwner, continuedAt: "2026-10-01T09:36:00.000Z" }, current);
  return { journal, outbox, completed, cancelled, next };
}

it("stops a cancelled review continuation's process at close so the next review starts fresh", async () => {
  const f = await continuedReviews();
  await runningClaim(f.journal, f.cancelled);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "process");
  // The cancelled turn's live owner: its own close has already cancelled and
  // closed the ACP session; the orchestrator now reports and retires it. As
  // in RelayedSession, close() is the in-flight close that calls onClosed.
  let finishClose!: () => void;
  const closeTask = new Promise<void>(resolve => { finishClose = resolve; });
  const session = { assignment: review(f.cancelled, "qa-2", "qa-1"), acpSessionRef: "qa-ref", isClosed: true,
    usage: () => undefined, close: vi.fn(() => closeTask) };
  internal.sessions.set("cancelled:1", session);

  await internal.onSessionClosed(session, "cancelled", current);
  // Nothing is stopped while the session's own close is still running.
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
  finishClose();

  await vi.waitFor(() => expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("interrupted_unqualified"));
  expect(runner.stopRetainedExecution).toHaveBeenCalledExactlyOnceWith(processOwner);
  expect(f.journal.execution.execution(f.cancelled)).toMatchObject({ acpSessionRef: "qa-ref", processOwner });
  expect(f.journal.assignments.get("cancelled:1")?.reports.terminalSequence).toBe(1);
  expect(internal.sessions.has("cancelled:1")).toBe(false);
  // The review it continued stays the head; nothing about it is rewritten.
  expect(f.journal.execution.execution(f.completed)).toMatchObject({ phase: "continued", continuedToGeneration: "cancelled-generation" });

  await acknowledge(f.journal, f.cancelled);
  // The next review names the completed review as its predecessor.
  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).resolves.toBeUndefined();
  // Fresh: nothing was transferred or restored from the cancelled reference.
  expect(f.journal.execution.execution(f.next)).toBeUndefined();
  expect(runner.stopRetainedExecution).toHaveBeenCalledOnce();
});

it("a next review placed while the cancelled turn is still closing waits for its stop, then starts fresh", async () => {
  const f = await continuedReviews();
  await runningClaim(f.journal, f.cancelled);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "process");
  let finishClose!: () => void;
  const closeTask = new Promise<void>(resolve => { finishClose = resolve; });
  const session = { assignment: review(f.cancelled, "qa-2", "qa-1"), acpSessionRef: "qa-ref", isClosed: true,
    usage: () => undefined, close: vi.fn(() => closeTask) };
  internal.sessions.set("cancelled:1", session);
  await internal.onSessionClosed(session, "cancelled", current);
  await acknowledge(f.journal, f.cancelled);

  let settled = false;
  const takeover = internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();

  finishClose();
  await expect(takeover).resolves.toBeUndefined();
  expect(runner.stopRetainedExecution).toHaveBeenCalledExactlyOnceWith(processOwner);
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("interrupted_unqualified");
  expect(f.journal.execution.execution(f.next)).toBeUndefined();
});

it("does not retire a completed review at close: its session stays continuable", async () => {
  const f = await continuedReviews();
  await runningClaim(f.journal, f.cancelled);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "process");
  const session = { assignment: review(f.cancelled, "qa-2", "qa-1"), acpSessionRef: "qa-ref", isClosed: true,
    usage: () => undefined, close: vi.fn(async () => undefined), deliveryAcceptanceReceipt: () => undefined };
  internal.sessions.set("cancelled:1", session);

  await internal.onSessionClosed(session, "completed", current);
  await new Promise(resolve => setTimeout(resolve, 10));

  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("opened");
  expect(internal.sessions.has("cancelled:1")).toBe(true);
});

it.each(["process", "restarted-process"])("heals a journal left with a cancelled continuation still opened (runner %s)", async incarnation => {
  const f = await continuedReviews(incarnation);
  // The journal as production left it: cancelled, reported, acknowledged, never stopped.
  await terminalClaim(f.journal, f.cancelled, { class: "cancelled", reason: "user_cancelled" }, true);
  const { internal, runner } = orchestrator(f.journal, f.outbox, incarnation);
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("opened");

  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).resolves.toBeUndefined();

  expect(runner.stopRetainedExecution).toHaveBeenCalledExactlyOnceWith(processOwner);
  expect(f.journal.execution.execution(f.cancelled)).toMatchObject({ phase: "interrupted_unqualified", acpSessionRef: "qa-ref" });
  expect(f.journal.execution.execution(f.next)).toBeUndefined();
  // A later review takes the same fresh-start path without another stop.
  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).resolves.toBeUndefined();
  expect(runner.stopRetainedExecution).toHaveBeenCalledOnce();
});

it("keeps refusing, and stops nothing, until Core acknowledged the cancelled continuation's report", async () => {
  const f = await continuedReviews();
  await terminalClaim(f.journal, f.cancelled, { class: "cancelled", reason: "user_cancelled" }, false);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "process");

  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).rejects.toMatchObject({ code: "recovery_required" });
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("opened");
});

it("never starts fresh while the cancelled continuation still has a local owner", async () => {
  const f = await continuedReviews();
  await terminalClaim(f.journal, f.cancelled, { class: "cancelled", reason: "user_cancelled" }, true);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "process");
  internal.sessions.set("cancelled:1", { assignment: review(f.cancelled, "qa-2", "qa-1"), isClosed: false });

  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).rejects.toMatchObject({ code: "recovery_required" });
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("opened");
});

it("refuses while the cancelled continuation's process cannot be proven stopped, then heals on a later review", async () => {
  const f = await continuedReviews();
  await terminalClaim(f.journal, f.cancelled, { class: "cancelled", reason: "user_cancelled" }, true);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "process");
  runner.stopRetainedExecution.mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "The retained execution process is live under a current local owner."));

  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).rejects.toMatchObject({
    code: "recovery_required", diagnostic: "unfinished_continuation_stop_unconfirmed" });
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("stopping");
  expect(f.journal.execution.execution(f.next)).toBeUndefined();

  await expect(internal.takeOverCompletedChannel(review(f.next, "qa-3", "qa-1"), f.next, current)).resolves.toBeUndefined();
  expect(runner.stopRetainedExecution).toHaveBeenCalledTimes(2);
  expect(f.journal.execution.execution(f.cancelled)?.phase).toBe("interrupted_unqualified");
});

it("starts fresh after an unresumable predecessor that itself continued an earlier turn", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  // Review 1 completed. Review 2 named review 1 and was reported
  // interrupted(not_resumable) before it ever opened. Review 3 names review 2.
  const completed = admission("completed");
  const unresumable = admission("unresumable", "process", "2026-10-01T09:35:00.000Z");
  const next = admission("next", "process", "2026-10-01T09:39:00.000Z");
  await admit(journal, completed, review(completed, "qa-1"));
  await admit(journal, unresumable, review(unresumable, "qa-2", "qa-1"));
  await admit(journal, next, review(next, "qa-3", "qa-2"));
  await journal.execution.open(completed, current, completed.openedAt);
  await journal.execution.bindReference(completed, "qa-ref", current);
  await journal.execution.bindProcessOwner(completed, processOwner, current);
  await journal.execution.markCompletedTurnSettled(completed, "qa-ref", "2026-10-01T09:30:30.000Z", current);
  await terminalClaim(journal, completed, { class: "succeeded" }, true);
  await terminalClaim(journal, unresumable, { class: "interrupted", reason: "not_resumable" }, true);
  const { internal, runner } = orchestrator(journal, outbox, "process");

  await expect(internal.takeOverCompletedChannel(review(next, "qa-3", "qa-2"), next, current)).resolves.toBeUndefined();
  expect(journal.execution.execution(next)).toBeUndefined();
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
});
