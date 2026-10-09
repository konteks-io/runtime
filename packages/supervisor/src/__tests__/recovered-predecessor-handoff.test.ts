import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { FixedClock, RemoteInstanceError, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal, recoveryEvidenceRecordKey } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import type { LocalAdmission } from "../state/local-admission.js";
import type { RunnerSessionInput, RunnerSessionLifecycle } from "../runner-port.js";
import type { RelayedSession } from "../session/relayed-session.js";
import { PermissionBroker } from "../session/permissions.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { InMemorySessionRefStore, SessionManager } from "../../../agent-runner/src/sessions/manager.js";
import { RunnerEventBus } from "../../../agent-runner/src/events.js";
import type { BridgeProcess } from "../../../agent-runner/src/bridge/process.js";

// A session fenced after its execution lease could not renew must be
// able to start again once its process is proven stopped and Core settled the
// claim, even when Core can no longer accept the stop observation.

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "recovered-handoff-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const clock = new FixedClock(Date.parse("2026-09-06T00:00:05Z"));
const current = () => undefined;
const processOwner = { version: 1 as const, platform: "darwin" as const, pid: 42, processGroupId: 42,
  startToken: "start-token", commandDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const admission = (assignmentId: string, runnerIncarnation = "process", openedAt = "2026-09-06T00:00:00.000Z"): LocalAdmission => ({
  instanceId: "instance", workspaceId: "workspace", runnerIncarnation, assignmentId, attempt: 1, claimId: `${assignmentId}-claim`,
  agentId: "codex", executionGeneration: `${assignmentId}-generation`, openedAt });
const policy = { maxDurationSeconds: 3600, maxArtifactBytes: 0, evidenceUpload: "structured_only" as const, allowedArtifactKinds: [], recoveryMode: "report_interrupted" as const,
  latestResumeAt: "2026-09-06T01:00:00.000Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true };
const conversation = (identity: LocalAdmission): RemoteWorkAssignment => ({
  id: identity.assignmentId, kind: "assistant_execution", placementId: `placement-${identity.assignmentId}`, instanceId: identity.instanceId,
  workspaceId: identity.workspaceId, taskId: `task-${identity.assignmentId}`, correlationId: `correlation-${identity.assignmentId}`, attempt: identity.attempt,
  expiresAt: "2026-09-06T01:00:00.000Z", requiredCapabilities: [], agentRoute: { requiredRole: "assistant", agentId: identity.agentId },
  source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: `turn-${identity.assignmentId}` }, policy });
const qa = (identity: LocalAdmission, invocationId: string, predecessor?: string): RemoteWorkAssignment => ({
  id: identity.assignmentId, kind: "validation", placementId: `placement-${identity.assignmentId}`, instanceId: identity.instanceId,
  workspaceId: identity.workspaceId, taskId: "repository-task", correlationId: invocationId, attempt: identity.attempt,
  expiresAt: "2026-09-06T01:00:00.000Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "qa", agentId: identity.agentId, sessionConfig: { model: "gpt-5" } },
  source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: identity.instanceId,
    executionSessionId: "repository-qa-session", repositoryId: "https://git.example.com/acme/store",
    modelBinding: { canonicalProviderId: "openai", canonicalModelId: "gpt-5" },
    turn: { invocationId, dispatchGeneration: 0, ...(predecessor ? { predecessor: { invocationId: predecessor, dispatchGeneration: 0 } } : {}) } },
  policy });

async function admit(journal: SupervisorJournal, identity: LocalAdmission, assignment: RemoteWorkAssignment): Promise<void> {
  await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment, evidenceUpload: "structured_only",
    projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
  await journal.execution.reserveAllocation(identity, current);
}

/** Lease renewal failed: the session was stopped for recovery and its exact process proven gone. */
async function fenceAndStop(journal: SupervisorJournal, identity: LocalAdmission, ref: string, options: { processStopped?: boolean } = {}): Promise<void> {
  await journal.execution.markStopping(identity, clock.nowIso(), current);
  await journal.execution.markAcpSettled(identity, ref, clock.nowIso(), current);
  if (options.processStopped === false) return;
  await journal.execution.markProcessStopped(identity, clock.nowIso(), current);
  await journal.execution.markInterruptedWithoutQuiescence(identity, clock.nowIso(), current);
}

/** The interrupted terminal report the recovery path wrote, optionally acknowledged by Core. */
async function interruptedClaim(journal: SupervisorJournal, identity: LocalAdmission, kind: "assistant_execution" | "validation", acknowledged: boolean): Promise<void> {
  const hash = "i".repeat(43);
  await journal.assignments.put({ assignmentId: identity.assignmentId, attempt: 1, claimId: identity.claimId, kind, placementId: `placement-${identity.assignmentId}`,
    workspaceId: "workspace", agentId: "codex", state: acknowledged ? "completed" : "terminal_pending_report", recoveryEpoch: 0, terminalResultHash: hash,
    reports: { nextSequence: 2, durableWatermark: acknowledged ? 1 : 0, terminalSequence: 1,
      terminalResult: { class: "interrupted", reason: "agent_session_lost", terminalResultHash: hash },
      ...(acknowledged ? { terminalAck: { assignmentId: identity.assignmentId, attempt: 1, claimId: identity.claimId,
        acknowledged: { reportId: randomUUID(), reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" as const } } : {}) },
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
}

function orchestrator(journal: SupervisorJournal, outbox: DurableOutbox, runnerIncarnation: string, submit: ReturnType<typeof vi.fn>) {
  const work = new WorkOrchestrator({ journal, outbox, transport: {}, clock, recoveryEvidence: { submit },
    runners: new Map(), sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => runnerIncarnation, assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = work as unknown as {
    channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    recordTurnSettledRecoveryEvidence(admission: LocalAdmission, assertCurrent: () => void, stopClass: "stop_unconfirmed", deliver: false): Promise<void>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };
  return { work, internal };
}

/** The stop observation the connector durably recorded when the lease was lost, now due for delivery. */
async function recordStopObservation(journal: SupervisorJournal, internal: ReturnType<typeof orchestrator>["internal"], identity: LocalAdmission): Promise<void> {
  await internal.recordTurnSettledRecoveryEvidence(identity, current, "stop_unconfirmed", false);
  const [record] = journal.recoveryEvidence.all();
  await journal.recoveryEvidence.update(recoveryEvidenceRecordKey(record!), value => ({ ...value!, nextAttemptAt: clock.nowIso() }));
}

async function fencedConversation(options: { processStopped?: boolean; acknowledged: boolean }) {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const fenced = admission("fenced"), next = admission("next", "process", "2026-09-06T00:00:02.000Z");
  await admit(journal, fenced, conversation(fenced)); await admit(journal, next, conversation(next));
  await journal.execution.open(fenced, current, fenced.openedAt);
  await journal.execution.bindReference(fenced, "fenced-ref", current);
  await journal.execution.bindProcessOwner(fenced, processOwner, current);
  await fenceAndStop(journal, fenced, "fenced-ref", options);
  await interruptedClaim(journal, fenced, "assistant_execution", options.acknowledged);
  const submit = vi.fn();
  const o = orchestrator(journal, outbox, "process", submit);
  await recordStopObservation(journal, o.internal, fenced);
  // The recovery-fenced owner still holds the logical session channel in memory.
  const owner = { assignment: conversation(fenced), acpSessionRef: "fenced-ref", isClosed: true,
    releaseRecoveredChannel: vi.fn(() => { o.internal.channelOwners.delete("session:session"); }),
    releaseCompletedChannel: vi.fn(() => { throw new RemoteInstanceError("assignment_conflict", "fenced"); }) };
  o.internal.channelOwners.set("session:session", owner);
  o.internal.sessions.set("fenced:1", owner);
  return { journal, fenced, next, submit, owner, ...o };
}

it("starts a fresh session in the same process once Core settled the fenced claim and refuses its stop observation as closed", async () => {
  const f = await fencedConversation({ acknowledged: true });
  f.submit.mockRejectedValue(new RemoteInstanceError("assignment_conflict", "Recovery evidence does not match current work authority"));

  await f.work.retryRecoveryEvidence();

  expect(f.journal.recoveryEvidence.all()).toMatchObject([{ delivery: "superseded", supersededReason: "claim_settled",
    lastFailureCode: "assignment_conflict", acceptedAt: null }]);
  await expect(f.internal.takeOverCompletedChannel(conversation(f.next), f.next, current)).resolves.toBeUndefined();
  expect(f.owner.releaseRecoveredChannel).toHaveBeenCalledOnce();
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  expect(f.internal.sessions.has("fenced:1")).toBe(false);
  // The fenced ACP session is never resumed and its journal fence stays.
  expect(f.journal.execution.execution(f.fenced)).toMatchObject({ phase: "interrupted_unqualified", acpSessionRef: "fenced-ref" });
  // Superseded evidence is kept for audit and never sent again.
  await f.journal.recoveryEvidence.update(recoveryEvidenceRecordKey(f.journal.recoveryEvidence.all()[0]!), value => ({ ...value!, nextAttemptAt: clock.nowIso() }));
  await f.work.retryRecoveryEvidence();
  expect(f.submit).toHaveBeenCalledOnce();
});

it("keeps the session blocked while the process stop is unconfirmed and Core has not settled the claim", async () => {
  const f = await fencedConversation({ processStopped: false, acknowledged: false });
  f.submit.mockRejectedValue(new RemoteInstanceError("temporarily_unavailable", "Core unavailable"));

  await f.work.retryRecoveryEvidence();

  const [record] = f.journal.recoveryEvidence.all();
  expect(record).toMatchObject({ delivery: "pending", lastFailureCode: "temporarily_unavailable" });
  // Backoff: the first failure waits 5 s, not a fixed hammer on an overloaded Core.
  expect(Date.parse(record!.nextAttemptAt) - clock.coreNow()).toBe(5_000);
  await expect(f.internal.takeOverCompletedChannel(conversation(f.next), f.next, current)).rejects.toMatchObject({
    code: "recovery_required", diagnostic: "predecessor_recovery_unqualified" });
  expect(f.owner.releaseRecoveredChannel).not.toHaveBeenCalled();
  expect(f.internal.channelOwners.has("session:session")).toBe(true);
  expect(f.journal.execution.execution(f.next)).toBeUndefined();
});

it("does not treat a closed-claim refusal as settlement before Core acknowledged the terminal report", async () => {
  const f = await fencedConversation({ acknowledged: false });
  f.submit.mockRejectedValue(new RemoteInstanceError("assignment_conflict", "Recovery evidence does not match current work authority"));

  await f.work.retryRecoveryEvidence();

  expect(f.journal.recoveryEvidence.all()).toMatchObject([{ delivery: "pending", lastFailureCode: "assignment_conflict" }]);
  await expect(f.internal.takeOverCompletedChannel(conversation(f.next), f.next, current)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.internal.channelOwners.has("session:session")).toBe(true);
});

it("after a restart, supersedes a retired process's stop observation and starts the repository role session fresh", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  // QA turn 1 completed; QA turn 2 continued its live ACP session and was
  // fenced when its lease could not renew; the connector then restarted.
  const head = admission("head"), fenced = admission("fenced", "process", "2026-09-06T00:00:02.000Z");
  const next = admission("next", "restarted-process", "2026-09-06T00:00:04.000Z");
  await admit(journal, head, qa(head, "qa-1")); await admit(journal, fenced, qa(fenced, "qa-2", "qa-1")); await admit(journal, next, qa(next, "qa-3", "qa-1"));
  await journal.execution.open(head, current, head.openedAt);
  await journal.execution.bindReference(head, "qa-ref", current);
  await journal.execution.bindProcessOwner(head, processOwner, current);
  await journal.execution.markCompletedTurnSettled(head, "qa-ref", "2026-09-06T00:00:01.000Z", current);
  await journal.execution.transferLiveContinuation({ predecessor: head, successor: fenced, sessionId: "repository-qa-session",
    acpSessionRef: "qa-ref", processOwner, continuedAt: "2026-09-06T00:00:03.000Z" }, current);
  await fenceAndStop(journal, fenced, "qa-ref");
  await interruptedClaim(journal, fenced, "validation", true);
  const submit = vi.fn(async () => { throw new RemoteInstanceError("reconciliation_replay", "Runtime process is not current"); });
  const before = orchestrator(journal, outbox, "process", submit);
  await recordStopObservation(journal, before.internal, fenced);

  const { work, internal } = orchestrator(journal, outbox, "restarted-process", submit);
  // Until Core answers, the repository role session stays blocked.
  await expect(internal.takeOverCompletedChannel(qa(next, "qa-3", "qa-1"), next, current)).rejects.toMatchObject({ code: "recovery_required" });

  await work.retryRecoveryEvidence();

  expect(journal.recoveryEvidence.all()).toMatchObject([{ delivery: "superseded", supersededReason: "incarnation_retired",
    evidence: { runnerIncarnation: "process" } }]);
  await expect(internal.takeOverCompletedChannel(qa(next, "qa-3", "qa-1"), next, current)).resolves.toBeUndefined();
  // Fresh: nothing was transferred or restored from the fenced reference.
  expect(journal.execution.execution(next)).toBeUndefined();
  expect(journal.execution.execution(fenced)).toMatchObject({ phase: "interrupted_unqualified", acpSessionRef: "qa-ref" });
});

it("keeps a retired process's observation pending when Core refuses it for another reason", async () => {
  const f = await fencedConversation({ acknowledged: true });
  f.submit.mockRejectedValue(new RemoteInstanceError("reconciliation_replay", "Runtime process is not current"));
  // Same process: Core's owner view may simply lag behind this incarnation.
  await f.work.retryRecoveryEvidence();
  expect(f.journal.recoveryEvidence.all()).toMatchObject([{ delivery: "pending", lastFailureCode: "reconciliation_replay" }]);
  await expect(f.internal.takeOverCompletedChannel(conversation(f.next), f.next, current)).rejects.toMatchObject({ code: "recovery_required" });
});

it("lets a later recovery stop an execution an earlier one already interrupted, without moving it back", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const stopped = admission("stopped");
  await admit(journal, stopped, conversation(stopped));
  await journal.execution.open(stopped, current, stopped.openedAt);
  await journal.execution.bindReference(stopped, "stopped-ref", current);
  await journal.execution.bindProcessOwner(stopped, processOwner, current);
  await fenceAndStop(journal, stopped, "stopped-ref");
  const before = journal.execution.execution(stopped);
  expect(before?.phase).toBe("interrupted_unqualified");
  // Core's cancel after a restart runs the same stop sequence again: it used to be
  // refused here on every retry, and the computer never came back online.
  await fenceAndStop(journal, stopped, "stopped-ref");
  expect(journal.execution.execution(stopped)).toEqual(before);
});

// 10-09 (production): Core fenced a direct Claude Code turn; the connector
// stopped it and recorded the interruption. Every later message failed at
// acp_session_bootstrap ("This message did not reach the agent") because the
// runner still held the fenced owner of the agent's own session.
describe("a direct session after its turn was stopped by force", () => {
  const direct = (identity: LocalAdmission, acpSessionRef: string): RemoteWorkAssignment => ({
    ...conversation(identity), kind: "direct", agentRoute: { requiredRole: "assistant", agentId: identity.agentId },
    source: { kind: "direct_session", portability: "instance_bound", ownerInstanceId: identity.instanceId, sessionId: "session",
      turnRef: `turn-${identity.assignmentId}`, acpSessionRef } });

  function bridge(sessionId: string, loadSession: () => Promise<unknown>): BridgeProcess & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const call = (name: string, result: () => Promise<unknown>) => vi.fn(async (params: unknown) => { (calls[name] ??= []).push(params); return result(); });
    return { calls, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined),
      initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      connection: { newSession: call("newSession", async () => ({ sessionId })), loadSession: call("loadSession", loadSession),
        cancel: call("cancel", async () => undefined) } } as unknown as BridgeProcess & { calls: Record<string, unknown[]> };
  }

  /** A real runner session manager whose first turn was fenced, stopped, and whose process exited. */
  async function fencedRunner(loadSession: () => Promise<unknown>) {
    const store = new InMemorySessionRefStore();
    const first = bridge("provider-session", async () => ({}));
    const next = bridge("provider-session-new", loadSession);
    let currentBridge: BridgeProcess = first;
    const manager = new SessionManager({ bridge: () => currentBridge, events: new RunnerEventBus(), refStore: store });
    const { acpSessionRef } = await manager.create({ context: { instanceId: "instance", assignmentId: "fenced", attempt: 1, agentId: "claude-code" }, cwd: dir, mcpServers: [] });
    await manager.stopForRecovery(acpSessionRef);
    Object.assign(first, { exited: true });
    manager.closeAll("agent_exited", first);
    currentBridge = next;
    const runner = {
      createSession: vi.fn(async (input: RunnerSessionInput, lifecycle?: RunnerSessionLifecycle) => {
        const args = { context: input.context, readinessDeadlineAt: input.readinessDeadlineAt, cwd: input.cwd, mcpServers: input.mcpServers,
          ...(input.freshSessionWhenRestoreLost ? { freshSessionWhenRestoreLost: true } : {}), ...(input.agentTitled ? { agentTitled: true } : {}),
          ...(lifecycle ? { lifecycle } : {}) };
        return input.restoreAcpSessionRef ? manager.restore(args, input.restoreAcpSessionRef) : manager.create(args);
      }),
      forgetRecoveredSession: vi.fn((ref: string) => manager.forgetRecovered(ref)),
      closeSession: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    };
    return { store, manager, nextBridge: next, acpSessionRef, runner };
  }

  async function dispatchAfterFence(loadSession: () => Promise<unknown>) {
    const r = await fencedRunner(loadSession);
    const journal = new SupervisorJournal(dir); await journal.load();
    const outbox = new DurableOutbox(dir); await outbox.load();
    const fenced = { ...admission("fenced"), agentId: "claude-code" };
    const next = { ...admission("next", "process", "2026-09-06T00:00:02.000Z"), agentId: "claude-code" };
    await admit(journal, fenced, direct(fenced, r.acpSessionRef)); await admit(journal, next, direct(next, r.acpSessionRef));
    await journal.execution.open(fenced, current, fenced.openedAt);
    await journal.execution.bindReference(fenced, r.acpSessionRef, current);
    await journal.execution.bindProcessOwner(fenced, processOwner, current);
    await fenceAndStop(journal, fenced, r.acpSessionRef);
    await interruptedClaim(journal, fenced, "assistant_execution", true);
    const assignment = direct(next, r.acpSessionRef);
    const entry = { assignmentId: next.assignmentId, attempt: 1, claimId: next.claimId, kind: "direct" as const, placementId: assignment.placementId,
      workspaceId: next.workspaceId, agentId: "claude-code", state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 },
      evidenceUpload: "structured_only" as const, expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() };
    await journal.assignments.put(entry);
    const transport = { send: () => undefined, openChannel: () => undefined, closeChannel: () => undefined };
    const registerReady = vi.fn(async () => ({ workspaceId: "workspace", instanceId: "instance", sessionId: "session", channelId: "session:session",
      assignmentId: next.assignmentId, attempt: 1, claimId: next.claimId, recoveryEpoch: 0, runnerIncarnation: "process",
      agentId: "claude-code", acpSessionRef: journal.execution.execution(next)?.acpSessionRef, readyRevision: 1, registeredAt: clock.nowIso() }));
    const broker = new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined });
    const work = new WorkOrchestrator({ journal, outbox, transport, clock, runners: new Map([["claude-code", r.runner]]),
      instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process", assertOwned: () => undefined,
      recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false, onUsage: async () => undefined, recoveryEvidence: { submit: vi.fn() },
      sessionDeps: () => ({ clock, journal, transport, runner: r.runner, policy: new EvaluatorPolicyResponder(null, () => true), broker,
        instanceId: "instance", workspaceRoot: dir, registerReady, redeemCapabilityToken: async () => { throw new Error("a direct session redeems nothing"); },
        prepareInputs: async (item: RemoteWorkAssignment) => ({ binding: { workspaceId: item.workspaceId, sessionId: "session",
          assignmentId: item.id, instanceId: item.instanceId, attempt: item.attempt }, cwd: dir, skillInstructions: "", beforePrompt: async () => undefined }) }),
    } as never);
    const internal = work as unknown as { channelOwners: Map<string, unknown>; sessions: Map<string, unknown>; bootstrapping: Map<string, Promise<void>>;
      startRelayedSession(item: RemoteWorkAssignment, claim: typeof entry, assertCurrent: () => void): Promise<void>;
      bootstrapRelayedSession(session: RelayedSession): Promise<void>; handleDispatchFailure(...args: unknown[]): Promise<void> };
    // The recovery-fenced owner still holds the logical session channel in memory.
    const owner = { assignment: direct(fenced, r.acpSessionRef), acpSessionRef: r.acpSessionRef, isClosed: true,
      releaseRecoveredChannel: vi.fn(() => { internal.channelOwners.delete("session:session"); }) };
    internal.channelOwners.set("session:session", owner);
    internal.sessions.set("fenced:1", owner);
    let session: RelayedSession | undefined;
    vi.spyOn(internal, "bootstrapRelayedSession").mockImplementation(async value => { session = value; await value.bootstrap(); });
    const failed = vi.spyOn(internal, "handleDispatchFailure").mockResolvedValue(undefined);
    await internal.startRelayedSession(assignment, entry, current);
    await internal.bootstrapping.get("next:1");
    return { ...r, journal, fenced, next, registerReady, failed, owner, close: () => session?.close("cancelled") };
  }

  it("releases the fenced owner once and restores the agent's own session under a new reference", async () => {
    const f = await dispatchAfterFence(async () => ({}));
    try {
      expect(f.failed).not.toHaveBeenCalled();
      expect(f.runner.forgetRecoveredSession).toHaveBeenCalledOnce();
      expect(f.runner.forgetRecoveredSession).toHaveBeenCalledWith(f.acpSessionRef);
      expect(f.owner.releaseRecoveredChannel).toHaveBeenCalledOnce();
      expect(f.runner.createSession).toHaveBeenCalledOnce();
      expect(f.runner.createSession.mock.calls[0]?.[0]).toMatchObject({ restoreAcpSessionRef: f.acpSessionRef, freshSessionWhenRestoreLost: true });
      const restored = f.journal.execution.execution(f.next)?.acpSessionRef;
      expect(restored).toBeTruthy();
      expect(restored).not.toBe(f.acpSessionRef);
      expect(f.nextBridge.calls.loadSession?.[0]).toMatchObject({ sessionId: "provider-session" });
      expect(f.nextBridge.calls.newSession).toBeUndefined();
      expect(await f.store.get(restored!)).toBe("provider-session");
      expect(f.registerReady).toHaveBeenCalledOnce();
      // The fenced reference is never reused and its journal fence stays.
      expect(f.journal.execution.execution(f.fenced)).toMatchObject({ phase: "interrupted_unqualified", acpSessionRef: f.acpSessionRef });
    } finally { await f.close(); }
  });

  it("answers the turn in a new session when the agent cannot reopen its transcript", async () => {
    const f = await dispatchAfterFence(async () => { throw new RequestError(-32602, "no such session"); });
    try {
      expect(f.failed).not.toHaveBeenCalled();
      expect(f.runner.forgetRecoveredSession).toHaveBeenCalledOnce();
      expect(f.nextBridge.calls.loadSession).toHaveLength(1);
      expect(f.nextBridge.calls.newSession).toHaveLength(1);
      const restored = f.journal.execution.execution(f.next)?.acpSessionRef;
      expect(restored).not.toBe(f.acpSessionRef);
      expect(await f.store.get(restored!)).toBe("provider-session-new");
      expect(f.registerReady).toHaveBeenCalledOnce();
      expect(f.journal.execution.execution(f.fenced)).toMatchObject({ phase: "interrupted_unqualified", acpSessionRef: f.acpSessionRef });
    } finally { await f.close(); }
  });

  it("keeps the session blocked when the runner refuses to release the fenced owner", async () => {
    const f = await fencedConversation({ acknowledged: true });
    f.submit.mockRejectedValue(new RemoteInstanceError("assignment_conflict", "Recovery evidence does not match current work authority"));
    await f.work.retryRecoveryEvidence();
    const forgetRecoveredSession = vi.fn(() => { throw new RemoteInstanceError("recovery_required", "still running", { diagnostic: "forget_not_recovered" }); });
    (f.work as unknown as { deps: { runners: Map<string, unknown> } }).deps.runners.set("codex", { forgetRecoveredSession });
    await expect(f.internal.takeOverCompletedChannel(conversation(f.next), f.next, current)).rejects.toMatchObject({
      code: "recovery_required", diagnostic: "predecessor_recovery_unqualified" });
    expect(forgetRecoveredSession).toHaveBeenCalledWith("fenced-ref");
    expect(f.owner.releaseRecoveredChannel).not.toHaveBeenCalled();
    expect(f.internal.channelOwners.has("session:session")).toBe(true);
  });
});
