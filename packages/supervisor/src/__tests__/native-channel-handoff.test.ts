import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import type { LocalAdmission } from "../state/local-admission.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "channel-handoff-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const clock = new FixedClock(Date.parse("2026-09-06T00:00:05Z"));
const current = () => undefined;
const processOwner = { version: 1 as const, platform: "darwin" as const, pid: 42, processGroupId: 42,
  startToken: "start-token", commandDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const prior: LocalAdmission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "process", assignmentId: "prior", attempt: 1,
  claimId: "prior-claim", agentId: "claude-code", executionGeneration: "prior-generation", openedAt: "2026-09-06T00:00:00.000Z" };
const next: LocalAdmission = { ...prior, assignmentId: "next", claimId: "next-claim", executionGeneration: "next-generation", openedAt: "2026-09-06T00:00:02.000Z" };

const work = (identity: LocalAdmission, acpSessionRef?: string): RemoteWorkAssignment => ({
  id: identity.assignmentId, kind: "assistant_execution", placementId: `placement-${identity.assignmentId}`, instanceId: identity.instanceId,
  workspaceId: identity.workspaceId, taskId: `task-${identity.assignmentId}`, correlationId: `correlation-${identity.assignmentId}`, attempt: identity.attempt,
  expiresAt: "2026-09-06T01:00:00.000Z", requiredCapabilities: [], agentRoute: { requiredRole: "assistant", agentId: identity.agentId },
  source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: `turn-${identity.assignmentId}`, ...(acpSessionRef ? { acpSessionRef } : {}) },
  policy: { maxDurationSeconds: 3600, maxArtifactBytes: 0, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-06T01:00:00.000Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
});
const delivery = (identity: LocalAdmission, invocationId: string): RemoteWorkAssignment => ({
  id: identity.assignmentId, kind: "delivery", placementId: `placement-${identity.assignmentId}`, instanceId: identity.instanceId,
  workspaceId: identity.workspaceId, taskId: "repository-task", correlationId: invocationId, attempt: identity.attempt,
  expiresAt: "2026-09-06T01:00:00.000Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "generator", agentId: identity.agentId, sessionConfig: { model: "claude-sonnet" } },
  source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: identity.instanceId,
    executionSessionId: "repository-generator-session", repositoryId: "https://git.example.com/acme/store",
    modelBinding: { canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet" },
    turn: { invocationId, dispatchGeneration: 0,
      ...(identity.assignmentId === "next" ? { predecessor: { invocationId: "generate-1", dispatchGeneration: 0 } } : {}) } },
  policy: { maxDurationSeconds: 3600, maxArtifactBytes: 0, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-06T01:00:00.000Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
});

async function fixture(options: { terminal?: boolean; closed?: boolean; priorRequestedRef?: string } = {}) {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  for (const [identity, assignment] of [[prior, work(prior, options.priorRequestedRef)], [next, work(next, "ref")]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment, evidenceUpload: "structured_only",
      projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  await journal.execution.open(prior, current, prior.openedAt);
  await journal.execution.bindReference(prior, "ref", current);
  await journal.execution.bindProcessOwner(prior, processOwner, current);
  await journal.execution.markCompletedTurnSettled(prior, "ref", "2026-09-06T00:00:01.000Z", current);
  await journal.assignments.put({ assignmentId: "prior", attempt: 1, claimId: "prior-claim", kind: "assistant_execution", placementId: "placement-prior", workspaceId: "workspace",
    agentId: "claude-code", state: "running", recoveryEpoch: 0, reports: { nextSequence: 2, durableWatermark: 0, ...(options.terminal === false ? {} : { terminalSequence: 1 }) },
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const runner = { stopForRecovery: vi.fn(async () => undefined), releaseSealedSession: vi.fn(async () => undefined), stopRetainedExecution: vi.fn(async () => undefined) };
  const orchestrator = new WorkOrchestrator({ deploymentKind: "native_connector", journal, outbox, transport: {}, clock, runners: new Map([["claude-code", runner]]),
    sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process",
    assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as { channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined> };
  const predecessor = { assignment: work(prior), acpSessionRef: "ref", isClosed: options.closed ?? true,
    releaseCompletedChannel: vi.fn(() => { internal.channelOwners.delete("session:session"); }) };
  internal.channelOwners.set("session:session", predecessor);
  internal.sessions.set("prior:1", predecessor);
  return { journal, runner, internal, predecessor };
}

it("stops a conversation's idle completed session before a fresh turn takes its channel", async () => {
  const f = await fixture();
  await expect(f.internal.takeOverCompletedChannel(work(next), next, current)).resolves.toBeUndefined();
  expect(f.runner.releaseSealedSession).toHaveBeenCalledWith("ref");
  expect(f.runner.stopForRecovery).not.toHaveBeenCalled();
  expect(f.runner.stopRetainedExecution).toHaveBeenCalledWith(processOwner);
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled", acpSessionRef: "ref" });
  expect(f.predecessor.releaseCompletedChannel).toHaveBeenCalledOnce();
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  expect(f.internal.sessions.has("prior:1")).toBe(false);
});

it("continues the exact live reference through the journaled generation transfer", async () => {
  const f = await fixture();
  await expect(f.internal.takeOverCompletedChannel(work(next, "ref"), next, current)).resolves.toEqual({ reference: "ref", mode: "live" });
  expect(f.runner.stopForRecovery).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "continued", continuedToGeneration: "next-generation" });
  expect(() => f.journal.execution.assertExecutable(next, "ref")).not.toThrow();
  expect(f.internal.sessions.has("prior:1")).toBe(false);
});

it("continues the reference a predecessor actually opened, not the stale one it asked for", async () => {
  // The prior turn asked to continue a session that was not live here and
  // opened "ref" fresh; the next turn continues "ref". This is every second
  // turn after a connector restart, and it must not become recovery_required.
  const f = await fixture({ priorRequestedRef: "stale-ref" });
  await expect(f.internal.takeOverCompletedChannel(work(next, "ref"), next, current)).resolves.toEqual({ reference: "ref", mode: "live" });
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "continued", continuedToGeneration: "next-generation" });
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
});

it("falls back to a fresh session when the journal cannot prove the exact continuation", async () => {
  const f = await fixture();
  vi.spyOn(f.journal.execution, "transferLiveContinuation")
    .mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "Local execution history cannot prove this admission or absence."));
  await expect(f.internal.takeOverCompletedChannel(work(next, "ref"), next, current)).resolves.toBeUndefined();
  // The idle completion is stopped like any other predecessor of a fresh turn;
  // the turn itself survives, only in-agent history is lost.
  expect(f.runner.releaseSealedSession).toHaveBeenCalledWith("ref");
  expect(f.runner.stopRetainedExecution).toHaveBeenCalledWith(processOwner);
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled", acpSessionRef: "ref" });
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  expect(f.journal.execution.execution(next)).toBeUndefined();
});

it("does not swallow a non-recovery refusal of the continuation transfer", async () => {
  const f = await fixture();
  vi.spyOn(f.journal.execution, "transferLiveContinuation").mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(f.internal.takeOverCompletedChannel(work(next, "ref"), next, current)).rejects.toThrow("disk unavailable");
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
});

it("keeps a previous turn's channel while its terminal report is still being journaled", async () => {
  const f = await fixture({ terminal: false });
  await expect(f.internal.takeOverCompletedChannel(work(next), next, current)).rejects.toMatchObject({ code: "assignment_conflict" });
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "opened" });
  expect(f.internal.channelOwners.has("session:session")).toBe(true);
});

it("supersedes a previous turn that is still live here when Core places a new turn for the conversation", async () => {
  // Core admits a new conversation turn only when the session has no queued
  // or claimed assignment, so a live local owner is a turn Core already
  // cancelled — and the cancellation itself needs protocol 2.0. Live
  // 2026-09-12: a hosted turn that failed before its prompt arrived left a
  // zombie owner, and every later turn on the session was refused as
  // assignment_conflict until the connector restarted.
  const f = await fixture({ closed: false, terminal: false });
  const predecessor = f.predecessor as unknown as { isClosed: boolean; close: ReturnType<typeof vi.fn> };
  predecessor.close = vi.fn(async () => { predecessor.isClosed = true; f.internal.channelOwners.delete("session:session"); });
  await expect(f.internal.takeOverCompletedChannel(work(next, "ref"), next, current)).resolves.toBeUndefined();
  expect(predecessor.close).toHaveBeenCalledWith("cancelled");
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  expect(f.internal.sessions.has("prior:1")).toBe(false);
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
  expect(f.runner.stopRetainedExecution).not.toHaveBeenCalled();
});

it("leaves bootstrap to restore Core's prior reference when no in-memory channel owner remains", async () => {
  const f = await fixture();
  f.internal.channelOwners.clear(); f.internal.sessions.clear();
  await expect(f.internal.takeOverCompletedChannel(work(next, "ref"), next, current)).resolves.toBeUndefined();
  expect(f.runner.stopForRecovery).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "opened", acpSessionRef: "ref" });
  expect(f.journal.execution.execution(next)).toBeUndefined();
});

it("restores a repository generator session from the durable journal after connector restart", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const restarted = { ...next, runnerIncarnation: "restarted-process" };
  for (const [identity, assignment] of [[prior, delivery(prior, "generate-1")], [restarted, delivery(restarted, "generate-2")]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment,
      evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  await journal.execution.open(prior, current, prior.openedAt);
  await journal.execution.bindReference(prior, "generator-ref", current);
  await journal.execution.bindProcessOwner(prior, processOwner, current);
  await journal.execution.markCompletedTurnSettled(prior, "generator-ref", "2026-09-06T00:00:01.000Z", current);
  await journal.assignments.put({ assignmentId: "prior", attempt: 1, claimId: "prior-claim", kind: "delivery", placementId: "placement-prior", workspaceId: "workspace",
    agentId: "claude-code", state: "running", recoveryEpoch: 0, reports: { nextSequence: 2, durableWatermark: 0, terminalSequence: 1 },
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const orchestrator = new WorkOrchestrator({ deploymentKind: "native_connector", journal, outbox, transport: {}, clock,
    runners: new Map(), sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "restarted-process", assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as {
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };

  await expect(internal.takeOverCompletedChannel(delivery(restarted, "generate-2"), restarted, current))
    .resolves.toEqual({ reference: "generator-ref", mode: "restore" });
  expect(journal.execution.execution(prior)).toMatchObject({ phase: "continued", continuedToGeneration: "next-generation" });
  expect(journal.execution.execution(restarted)).toMatchObject({ phase: "opened", acpSessionRef: null,
    restoredFromGeneration: "prior-generation", restoreAcpSessionRef: "generator-ref" });
});

it("starts a fresh repository-role session after its exact predecessor terminated not_resumable without a continuation", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const restarted = { ...next, runnerIncarnation: "restarted-process" };
  for (const [identity, assignment] of [[prior, delivery(prior, "generate-1")], [restarted, delivery(restarted, "generate-2")]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment,
      evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  await journal.assignments.put({ assignmentId: "prior", attempt: 1, claimId: "prior-claim", kind: "delivery", placementId: "placement-prior", workspaceId: "workspace",
    agentId: "claude-code", state: "completed", recoveryEpoch: 0, terminalResultHash: "n".repeat(43),
    reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1,
      terminalResult: { class: "interrupted", reason: "not_resumable", terminalResultHash: "n".repeat(43) } },
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const orchestrator = new WorkOrchestrator({ deploymentKind: "native_connector", journal, outbox, transport: {}, clock,
    runners: new Map(), sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "restarted-process", assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as {
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };

  await expect(internal.takeOverCompletedChannel(delivery(restarted, "generate-2"), restarted, current)).resolves.toBeUndefined();
  expect(journal.execution.execution(restarted)).toBeUndefined();
});

it("leaves the previous execution untouched when its session is not an idle sealed completion", async () => {
  const f = await fixture();
  f.runner.releaseSealedSession.mockRejectedValueOnce(Object.assign(new Error("Only an idle sealed session can be released."), { code: "recovery_required" }));
  await expect(f.internal.takeOverCompletedChannel(work(next), next, current)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "opened" });
  expect(f.runner.stopRetainedExecution).not.toHaveBeenCalled();
});

it("releases a finished predecessor that can neither continue nor be proven stopped, and starts fresh", async () => {
  const f = await fixture();
  // Finished and reported, but the journal no longer agrees with the owner's
  // reference, so no continuation and no proven stop are possible. Refusing
  // here pinned the channel until the connector restarted, because the idle
  // reaper screens on these same facts and could never reclaim it either.
  f.predecessor.acpSessionRef = "other";
  await expect(f.internal.takeOverCompletedChannel(work(next), next, current)).resolves.toBeUndefined();
  expect(f.predecessor.releaseCompletedChannel).toHaveBeenCalledOnce();
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  expect(f.internal.sessions.has("prior:1")).toBe(false);
  // A stop is never claimed for an owner whose process ownership cannot be proven.
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
  expect(f.runner.stopRetainedExecution).not.toHaveBeenCalled();
});

it("keeps refusing when the owner itself will not release", async () => {
  const f = await fixture();
  f.predecessor.acpSessionRef = "other";
  f.predecessor.releaseCompletedChannel.mockImplementationOnce(() => {
    throw Object.assign(new Error("still owns its session channel"), { code: "assignment_conflict" });
  });
  await expect(f.internal.takeOverCompletedChannel(work(next), next, current)).rejects.toMatchObject({ code: "assignment_conflict" });
  expect(f.internal.channelOwners.has("session:session")).toBe(true);
});

it("leaves a process the runtime kept resident alone and settles the predecessor without a process-stop claim", async () => {
  const f = await fixture();
  f.runner.releaseSealedSession.mockResolvedValueOnce({ processRetained: true } as never);
  await expect(f.internal.takeOverCompletedChannel(work(next), next, current)).resolves.toBeUndefined();
  expect(f.runner.releaseSealedSession).toHaveBeenCalledWith("ref");
  // Signalling the retained owner would kill the process the next turn reuses.
  expect(f.runner.stopRetainedExecution).not.toHaveBeenCalled();
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled", acpSessionRef: "ref", processOwner });
  expect(f.journal.execution.execution(prior)?.processStoppedAt).toBeUndefined();
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  expect(f.internal.sessions.has("prior:1")).toBe(false);
});

it("releases a completed session idle past the reaper window and keeps a recent one", async () => {
  const f = await fixture();
  const internal = f.internal as unknown as { reapIdleCompletedSessions(idleMs: number): Promise<number> };
  // Settled at 00:00:01; the clock reads 00:00:05.
  await expect(internal.reapIdleCompletedSessions(60_000)).resolves.toBe(0);
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
  await expect(internal.reapIdleCompletedSessions(1_000)).resolves.toBe(1);
  expect(f.runner.releaseSealedSession).toHaveBeenCalledWith("ref");
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled" });
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
});
