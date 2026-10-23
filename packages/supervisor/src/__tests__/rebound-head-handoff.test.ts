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

// A44 (10-22, TKT-A): Core moved a delivery session from codex to DeepSeek
// Harness. The new agent's turn names codex's completed turn as its
// predecessor, but a head only continues under the same agent and model, and
// no fresh-start rule covered a move, so every attempt was refused at
// activation (recovery_required / local_execution_unprovable).

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rebound-head-")); });
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

function orchestrator(journal: SupervisorJournal, outbox: DurableOutbox, runnerIncarnation: string) {
  const runner = { stopRetainedExecution: vi.fn(async (_owner: unknown) => undefined), releaseSealedSession: vi.fn(async () => undefined) };
  const preserveStoppedWorkspace = vi.fn(async (owner: LocalAdmission, assertCurrent: () => void) => {
    assertCurrent();
    expect(journal.execution.execution(owner)?.phase).toBe("process_stopped");
  });
  const work = new WorkOrchestrator({ journal, outbox, transport: {}, clock, runners: new Map([["claude-code", runner], ["dsh", runner]]),
    preserveStoppedWorkspace,
    sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => runnerIncarnation, assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = work as unknown as {
    channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    onSessionClosed(session: unknown, reason: "cancelled" | "completed", assertAuthority: () => void): Promise<void>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };
  return { work, internal, runner, preserveStoppedWorkspace };
}

const moved = (identity: LocalAdmission, invocationId: string, predecessor: string, agentId: string, model = "claude-sonnet"): RemoteWorkAssignment => {
  const base = review(identity, invocationId, predecessor);
  const source = base.source.kind === "harness_delivery" && model !== "claude-sonnet"
    ? { ...base.source, modelBinding: { canonicalProviderId: "anthropic", canonicalModelId: model } } : base.source;
  return { ...base, source, agentRoute: { ...base.agentRoute, agentId, sessionConfig: { model } } } as RemoteWorkAssignment;
};

/** Codex's completed head (here "claude-code"), retained and acknowledged; the moved turn comes after a restart. */
async function completedHead(acknowledged = true, agentId = "dsh", model = "claude-sonnet") {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const completed = admission("completed");
  const next = { ...admission("next", "restarted-process", "2026-10-01T09:39:00.000Z"), agentId };
  await admit(journal, completed, review(completed, "qa-1"));
  await admit(journal, next, moved(next, "qa-2", "qa-1", agentId, model));
  await journal.execution.open(completed, current, completed.openedAt);
  await journal.execution.bindReference(completed, "qa-ref", current);
  await journal.execution.bindProcessOwner(completed, processOwner, current);
  await journal.execution.markCompletedTurnSettled(completed, "qa-ref", "2026-10-01T09:30:30.000Z", current);
  await terminalClaim(journal, completed, { class: "succeeded" }, acknowledged);
  return { journal, outbox, completed, next };
}

it("stops the previous agent's session and starts fresh when Core moves the session to another agent", async () => {
  const f = await completedHead();
  const { internal, runner } = orchestrator(f.journal, f.outbox, "restarted-process");

  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "dsh"), f.next, current)).resolves.toBeUndefined();

  expect(runner.stopRetainedExecution).toHaveBeenCalledExactlyOnceWith(processOwner);
  expect(f.journal.execution.execution(f.completed)).toMatchObject({ phase: "interrupted_unqualified", acpSessionRef: "qa-ref" });
  expect(f.journal.execution.execution(f.next)).toBeUndefined();
  // A retry of the moved turn starts fresh again without another stop.
  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "dsh"), f.next, current)).resolves.toBeUndefined();
  expect(runner.stopRetainedExecution).toHaveBeenCalledOnce();
});

it("treats a move to another model of the same agent the same way", async () => {
  const f = await completedHead(true, "claude-code", "claude-opus");
  const { internal, runner } = orchestrator(f.journal, f.outbox, "restarted-process");

  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "claude-code", "claude-opus"), f.next, current)).resolves.toBeUndefined();
  expect(runner.stopRetainedExecution).toHaveBeenCalledExactlyOnceWith(processOwner);
});

it("keeps refusing, and stops nothing, until Core acknowledged the previous agent's report", async () => {
  const f = await completedHead(false);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "restarted-process");

  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "dsh"), f.next, current)).rejects.toMatchObject({ code: "recovery_required" });
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(f.completed)?.phase).toBe("opened");
});

it("does not start fresh for a turn that names another predecessor", async () => {
  const f = await completedHead();
  const { internal, runner } = orchestrator(f.journal, f.outbox, "restarted-process");

  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-0", "dsh"), f.next, current)).rejects.toBeInstanceOf(RemoteInstanceError);
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
});

/** The head the previous agent continued once more; that retry failed and, unless `settled` is false, was retired and acknowledged. */
async function continuedThenRetired(settled = true) {
  const f = await completedHead();
  const retry = admission("retry", "process", "2026-10-01T09:35:00.000Z");
  await admit(f.journal, retry, review(retry, "qa-1b", "qa-1"));
  await f.journal.execution.transferLiveContinuation({ predecessor: f.completed, successor: retry, sessionId: "repository-qa-session",
    acpSessionRef: "qa-ref", processOwner, continuedAt: "2026-10-01T09:36:00.000Z" }, current);
  if (settled) {
    await f.journal.execution.markStopping(retry, "2026-10-01T09:37:00.000Z", current);
    await f.journal.execution.markProcessStopped(retry, "2026-10-01T09:37:01.000Z", current);
    await f.journal.execution.markInterruptedWithoutQuiescence(retry, "2026-10-01T09:37:02.000Z", current);
  }
  await terminalClaim(f.journal, retry, { class: "cancelled", reason: "user_cancelled" }, settled);
  return { ...f, retry };
}

it("starts fresh for the new agent when the previous agent's retry of that turn was already stopped and settled", async () => {
  const f = await continuedThenRetired();
  const { internal, runner } = orchestrator(f.journal, f.outbox, "restarted-process");

  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "dsh"), f.next, current)).resolves.toBeUndefined();
  // Its process was already proven gone when the retry was retired.
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(f.next)).toBeUndefined();
});

it("keeps refusing while the previous agent's retry of that turn is not settled", async () => {
  const f = await continuedThenRetired(false);
  const { internal, runner } = orchestrator(f.journal, f.outbox, "restarted-process");

  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "dsh"), f.next, current)).rejects.toBeInstanceOf(RemoteInstanceError);
  expect(runner.stopRetainedExecution).not.toHaveBeenCalled();
});

it("lets the new agent's completed turn become the session's head after the move (TKT-A 10-22)", async () => {
  const f = await completedHead();
  const { internal } = orchestrator(f.journal, f.outbox, "restarted-process");
  await expect(internal.takeOverCompletedChannel(moved(f.next, "qa-2", "qa-1", "dsh"), f.next, current)).resolves.toBeUndefined();
  await f.journal.execution.open(f.next, current, f.next.openedAt);
  await f.journal.execution.bindReference(f.next, "dsh-ref", current);

  await expect(f.journal.execution.markCompletedTurnSettled(f.next, "dsh-ref", "2026-10-01T09:45:00.000Z", current)).resolves.toBeUndefined();
  expect(f.journal.execution.harnessRoleHead(moved(f.next, "qa-3", "qa-2", "dsh"))).toMatchObject({ assignmentId: "next", agentId: "dsh" });
});

it("never replaces a head whose previous agent's execution is still live", async () => {
  const f = await completedHead();
  await f.journal.execution.open(f.next, current, f.next.openedAt);
  await f.journal.execution.bindReference(f.next, "dsh-ref", current);

  await expect(f.journal.execution.markCompletedTurnSettled(f.next, "dsh-ref", "2026-10-01T09:45:00.000Z", current)).rejects.toMatchObject({ code: "recovery_required" });
});
