import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SessionManager, InMemorySessionRefStore } from "../../../agent-runner/src/sessions/manager.js";
import { RunnerEventBus } from "../../../agent-runner/src/events.js";
import { RelayedSession, type RelayedSessionDeps } from "../session/relayed-session.js";
import { recoveryEvidenceRecordKey, SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import { PermissionBroker } from "../session/permissions.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";

let dir: string;
const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "recovery-stop-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const assignment: RemoteWorkAssignment = {
  id: "assignment", attempt: 1, placementId: "placement", kind: "assistant_execution", instanceId: "instance", workspaceId: "workspace", taskId: "task", correlationId: "correlation", expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "assistant", agentId: "codex" }, source: { kind: "conversation", portability: "portable_before_claim", sessionId: "cloud-session", turnRef: "turn" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
};

function managerFixture() {
  const prompt = Promise.withResolvers<{ stopReason: "cancelled" }>();
  const connection = { newSession: vi.fn(async () => ({ sessionId: "bridge-session" })), loadSession: vi.fn(async () => ({})), prompt: vi.fn(() => prompt.promise), cancel: vi.fn(async () => undefined) };
  const store = new InMemorySessionRefStore();
  const manager = new SessionManager({ bridge: () => ({ exited: false, initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, connection }) as never, events: new RunnerEventBus(), refStore: store });
  return { manager, connection, prompt, store };
}
const create = (manager: SessionManager) => manager.create({ context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [] });

async function sessionFixture(overrides: Partial<RelayedSessionDeps> = {}, mutate?: ConstructorParameters<typeof SupervisorJournal>[1]) {
  const journal = new SupervisorJournal(dir, mutate); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const runner = { createSession: vi.fn(async () => ({ acpSessionRef: "acp", resumed: false, capabilities: { forkSession: false, sessionResume: false } })), prompt: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), closeSession: vi.fn(async () => undefined), stopForRecovery: vi.fn(async () => undefined), answer: vi.fn(async () => ({ delivered: true })), setMode: vi.fn(async () => undefined), setConfigOption: vi.fn(async () => undefined) };
  const transport = { send: vi.fn(), openChannel: vi.fn(), closeChannel: vi.fn() };
  const onClosed = vi.fn(async () => undefined);
  const binding = { workspaceId: "workspace", instanceId: "instance", assignmentId: "assignment", attempt: 1, sessionId: "cloud-session" };
  const deps: RelayedSessionDeps = { clock, journal, transport: transport as never, runner: runner as never, instanceId: "instance", browserToolUrl: null, workspaceRoot: "/workspace", deploymentKind: "native_connector", redeemCapabilityToken: async () => { throw new Error("not needed"); },
    broker: new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined }), policy: new EvaluatorPolicyResponder(null, () => true),
    prepareInputs: async () => ({ binding, cwd: "/workspace", skillInstructions: "", beforePrompt: async () => undefined }),
    registerReady: async () => ({ ...binding, claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "process", channelId: "session:cloud-session", agentId: "codex", acpSessionRef: "acp", readyRevision: 1, registeredAt: clock.nowIso() }), onUsage: async () => undefined, onClosed, ...overrides };
  const session = new RelayedSession(assignment, deps);
  return { session, runner, transport, onClosed, deps, journal, outbox };
}

async function realOwnedWork() {
  let failWrite = false;
  const m = managerFixture();
  const f = await sessionFixture({}, async operation => { if (failWrite) throw new Error("disk unavailable"); return operation(); });
  f.deps.registerReady = async (_assignment, binding, ref) => ({ ...binding, claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "process", channelId: "session:cloud-session", agentId: "codex", acpSessionRef: ref, readyRevision: 1, registeredAt: clock.nowIso() });
  (f.runner.createSession as unknown as ReturnType<typeof vi.fn>).mockImplementation((input, lifecycle) => m.manager.create({ ...input, lifecycle }));
  f.runner.stopForRecovery.mockImplementation(ref => m.manager.stopForRecovery(ref));
  let evidenceAtSubmission: unknown;
  const recoveryEvidence = {
    submit: vi.fn(async () => {
      evidenceAtSubmission = (f.journal as unknown as { recoveryEvidence?: { all(): unknown[] } }).recoveryEvidence?.all();
      return { outcome: "accepted" as const, acceptedAt: clock.nowIso() };
    }),
  };
  const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: f.journal, outbox: f.outbox, transport: f.transport, clock,
    recoveryEvidence,
    runners: new Map([["codex", f.runner]]), sessionDeps: () => f.deps, onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process", assertOwned: () => undefined, recoveryAuthority: () => "accepted-A", reportDeliveryAllowed: () => false } as never);
  const entry = { assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution" as const, placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const, expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() };
  await f.journal.assignments.put(entry);
  const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "process", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: clock.nowIso() };
  await f.journal.execution.admit(admission, () => undefined);
  const internal = work as unknown as { captureNativeAuthority(id: string, attempt: number): () => void; dispatch(a: RemoteWorkAssignment, e: typeof entry, check: () => void): Promise<void> };
  const originalAuthority = internal.captureNativeAuthority(assignment.id, assignment.attempt);
  const dispatch = () => internal.dispatch(assignment, entry, originalAuthority);
  return { ...f, ...m, work, dispatch, admission, recoveryEvidence, evidenceAtSubmission: () => evidenceAtSubmission, failWrites: (value: boolean) => { failWrite = value; } };
}

describe("proven per-session recovery stop", () => {
  it.each(["cancel", "closeSession"] as const)("late creation after ordinary close rechecks authority after %s cleanup", async method => {
    let generation = "accepted-A";
    const f = await sessionFixture();
    const captured = new RecoveryAuthority(() => generation).capture("session");
    f.deps.assertExecutionOwned = () => { try { captured(); } catch (error) { f.session.fenceForRecovery(); throw error; } };
    const creation = Promise.withResolvers<Awaited<ReturnType<typeof f.runner.createSession>>>();
    f.runner.createSession.mockImplementation(() => creation.promise);
    const bootstrap = f.session.bootstrap();
    const outcome = expect(bootstrap).rejects.toMatchObject({ code: "recovery_required" });
    await vi.waitFor(() => expect(f.runner.createSession).toHaveBeenCalledOnce());
    await f.session.close("cancelled");
    f.runner[method].mockImplementation(async () => { generation = ""; await Promise.resolve(); generation = "accepted-B"; });
    creation.resolve({ acpSessionRef: "late", resumed: false, capabilities: { forkSession: false, sessionResume: false } });
    await outcome;
    expect(f.runner.closeSession).toHaveBeenCalledTimes(method === "cancel" ? 0 : 1);
    expect(f.session.acpSessionRef).toBe("late");
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it("hands a prior native reference to the runner instead of adopting it locally", async () => {
    // Qualification moved into the runner's live-continuation path: only an
    // exact, sealed, still-live predecessor may be adopted. The session never
    // decides that itself, and an unqualified reference still fails there.
    const f = await sessionFixture();
    const prior = new RelayedSession({ ...assignment, source: { kind: "conversation", portability: "portable_before_claim", sessionId: "cloud-session", turnRef: "next", acpSessionRef: "legacy-ref" } }, f.deps);
    f.runner.createSession.mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "Live continuation predecessor is unavailable."));
    await expect(prior.bootstrap()).rejects.toThrow("Live continuation predecessor is unavailable.");
    expect(f.runner.createSession.mock.calls[0]?.[0]).toMatchObject({ acpSessionRef: "legacy-ref" });
  });
  it("rejects an alias reference before loading another claim's live bridge session", async () => {
    const f = managerFixture(); await create(f.manager); await f.store.put("alias", "bridge-session");
    await expect(f.manager.create({ context: { instanceId: "instance", assignmentId: "other", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [], acpSessionRef: "alias" })).rejects.toThrow();
    expect(f.connection.loadSession).not.toHaveBeenCalled();
    expect(f.manager.activeSessions).toBe(1);
  });

  it("serializes different opaque aliases of the same prior bridge session before either load", async () => {
    const f = managerFixture(); await f.store.put("first", "prior"); await f.store.put("alias", "prior");
    const gate = Promise.withResolvers<Record<string, never>>(); f.connection.loadSession.mockImplementation(() => gate.promise);
    const args = { context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [] };
    const first = f.manager.create({ ...args, acpSessionRef: "first" });
    await vi.waitFor(() => expect(f.connection.loadSession).toHaveBeenCalledTimes(1));
    const second = f.manager.create({ ...args, context: { ...args.context, assignmentId: "other" }, acpSessionRef: "alias" });
    const results = Promise.allSettled([first, second]);
    await Promise.resolve(); await Promise.resolve(); gate.resolve({});
    expect((await results).map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.connection.loadSession).toHaveBeenCalledTimes(1);
  });

  it("retains a known bridge-ID fence after uncertain load, blocking another opaque alias", async () => {
    const f = managerFixture(); await f.store.put("first", "prior"); await f.store.put("alias", "prior");
    const args = { context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [] };
    f.connection.loadSession.mockRejectedValueOnce(new Error("response lost after load"));
    await expect(f.manager.create({ ...args, acpSessionRef: "first" })).rejects.toThrow();
    await expect(f.manager.create({ ...args, context: { ...args.context, assignmentId: "other" }, acpSessionRef: "alias" })).rejects.toThrow();
    expect(f.connection.loadSession).toHaveBeenCalledTimes(1);
    expect(f.manager.activeSessions).toBe(0);
  });
  it.each(["stopping", "settlement"] as const)("retains the real session owner and retries after %s fsync failure", async stage => {
    const f = await realOwnedWork(); await f.dispatch();
    await vi.waitFor(() => expect(f.journal.assignments.get("assignment:1")?.state).toBe("running"));
    const ref = f.journal.assignments.get("assignment:1")!.acpSessionRef!;
    if (stage === "stopping") f.failWrites(true);
    else f.runner.stopForRecovery.mockImplementation(async target => { await f.manager.stopForRecovery(target); f.failWrites(true); });
    await expect(f.work.stopForRecovery("assignment", 1)).rejects.toThrow("disk unavailable");
    expect(f.manager.activeSessions).toBe(1);
    expect(() => f.manager.prompt(ref, "late", { prompt: [] })).toThrow();
    expect(() => f.manager.answer(ref, "late", {})).toThrow();
    expect(f.journal.execution.execution(f.admission)?.phase).toBe(stage === "stopping" ? "opened" : "stopping");
    f.failWrites(false); f.runner.stopForRecovery.mockImplementation(target => f.manager.stopForRecovery(target));
    await expect(f.work.stopForRecovery("assignment", 1)).rejects.toThrow("quiescence");
    expect(f.connection.cancel).toHaveBeenCalledTimes(1);
    expect(f.manager.activeSessions).toBe(1);
    expect(f.journal.execution.execution(f.admission)?.phase).toBe("acp_settled");
    expect(f.outbox.depth).toBe(0);
    expect(f.transport.closeChannel).not.toHaveBeenCalled();
  });

  it("durably records a turn-settled stop observation before submitting the immutable Core evidence", async () => {
    const f = await realOwnedWork(); await f.dispatch();
    await vi.waitFor(() => expect(f.journal.assignments.get("assignment:1")?.state).toBe("running"));

    await expect(f.work.stopForRecovery("assignment", 1)).rejects.toThrow("quiescence");

    const records = (f.journal as unknown as { recoveryEvidence?: { all(): Array<{ evidence: unknown }> } }).recoveryEvidence?.all();
    expect(records).toHaveLength(1);
    expect(records?.[0]?.evidence).toMatchObject({
      instanceId: "instance", assignmentId: "assignment", attempt: 1, claimId: "claim",
      runnerIncarnation: "process", recoveryEpoch: 0, evidenceKind: "stop_observation",
      schemaVersion: "remote-recovery-evidence-v1", stopClass: "turn_settled",
      terminalDisposition: "not_terminal", quiescenceAssertion: "not_asserted_by_recovery_evidence",
    });
    expect(f.recoveryEvidence.submit).toHaveBeenCalledTimes(1);
    expect(f.evidenceAtSubmission()).toMatchObject([{ evidence: records?.[0]?.evidence, delivery: "pending" }]);
    expect(f.outbox.depth).toBe(0);
  });

  it("keeps failed stop evidence pending and replays the same immutable bytes", async () => {
    const f = await realOwnedWork(); await f.dispatch();
    await vi.waitFor(() => expect(f.journal.assignments.get("assignment:1")?.state).toBe("running"));
    f.recoveryEvidence.submit.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "Core unavailable"));

    await expect(f.work.stopForRecovery("assignment", 1)).rejects.toThrow("quiescence");

    const pending = (f.journal as unknown as { recoveryEvidence: { all(): Array<{ evidence: unknown; delivery: string; lastFailureCode: string | null; nextAttemptAt: string }> } }).recoveryEvidence.all();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ delivery: "pending", lastFailureCode: "temporarily_unavailable" });
    const pendingRecord = pending[0]!;
    await (f.journal as unknown as { recoveryEvidence: { update(key: string, derive: (record: typeof pendingRecord) => typeof pendingRecord): Promise<void> } }).recoveryEvidence.update(
      recoveryEvidenceRecordKey(pendingRecord as never),
      record => ({ ...record, nextAttemptAt: clock.nowIso() }),
    );
    await f.work.retryRecoveryEvidence();
    expect(f.recoveryEvidence.submit).toHaveBeenCalledTimes(2);
    expect(f.recoveryEvidence.submit.mock.calls[0]?.[0]?.evidence).toEqual(f.recoveryEvidence.submit.mock.calls[1]?.[0]?.evidence);
    expect((f.journal as unknown as { recoveryEvidence: { all(): Array<{ delivery: string }> } }).recoveryEvidence.all()).toMatchObject([{ delivery: "accepted" }]);
    expect(f.outbox.depth).toBe(0);
  });

  it("settles the real late-created owner without treating the reserved reference as creation proof", async () => {
    const f = await realOwnedWork();
    const created = Promise.withResolvers<{ sessionId: string }>();
    f.connection.newSession.mockImplementation(() => created.promise);
    const dispatch = f.dispatch();
    await vi.waitFor(() => expect(f.connection.newSession).toHaveBeenCalledTimes(1));
    const stop = f.work.stopForRecovery("assignment", 1);
    const stopped = expect(stop).rejects.toThrow("quiescence");
    await vi.waitFor(() => expect(f.journal.execution.execution(f.admission)?.phase).toBe("stopping"));
    created.resolve({ sessionId: "late-bridge" });
    await dispatch; await stopped;
    expect(f.journal.execution.execution(f.admission)?.phase).toBe("acp_settled");
    expect(f.manager.activeSessions).toBe(1);
    expect(f.connection.cancel).toHaveBeenCalledWith({ sessionId: "late-bridge" });
    expect(f.outbox.depth).toBe(0);
  });
  it("reserves only an opaque reference durably before bridge creation and fences late config", async () => {
    const f = managerFixture(); let current = true;
    const reserve = vi.fn(async (ref: string) => { expect(ref).toMatch(/^acp-/); expect(f.connection.newSession).not.toHaveBeenCalled(); });
    f.connection.newSession.mockImplementation(async () => { current = false; return { sessionId: "bridge-generated" }; });
    await expect(f.manager.create({ context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [], lifecycle: { beforeCreate: reserve, assertCurrent: () => { if (!current) throw new Error("generation fenced"); } } })).rejects.toThrow("generation fenced");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(f.manager.activeSessions).toBe(1);
  });

  it("a failed reference reservation cannot execute session/new", async () => {
    const f = managerFixture();
    await expect(f.manager.create({ context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [], lifecycle: { beforeCreate: async () => { throw new Error("fsync failed"); }, assertCurrent: () => undefined } })).rejects.toThrow("fsync failed");
    expect(f.connection.newSession).not.toHaveBeenCalled();
  });
  it.each(["inputs", "ready"] as const)("rechecks durable admission after asynchronous %s before session/readiness publication", async stage => {
    let owned = true;
    const f = await sessionFixture({ assertExecutionOwned: () => { if (!owned) throw new Error("execution fenced"); } });
    const original = stage === "inputs" ? f.deps.prepareInputs! : f.deps.registerReady!;
    if (stage === "inputs") f.deps.prepareInputs = async (...args) => { const result = await (original as NonNullable<RelayedSessionDeps["prepareInputs"]>)(...args); owned = false; return result; };
    else f.deps.registerReady = async (...args) => { const result = await (original as NonNullable<RelayedSessionDeps["registerReady"]>)(...args); owned = false; return result; };
    await expect(f.session.bootstrap()).rejects.toThrow("execution fenced");
    expect(f.transport.send).not.toHaveBeenCalled();
    if (stage === "inputs") expect(f.runner.createSession).not.toHaveBeenCalled();
  });

  it("waits for the actual pending ACP prompt result, not cancellation notification", async () => {
    const f = managerFixture(); const { acpSessionRef } = await create(f.manager);
    f.manager.prompt(acpSessionRef, "request", { prompt: [] });
    let settled = false;
    const stop = f.manager.stopForRecovery(acpSessionRef).then(() => { settled = true; });
    await vi.waitFor(() => expect(f.connection.cancel).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(() => f.manager.prompt(acpSessionRef, "late", { prompt: [] })).toThrow();
    f.prompt.resolve({ stopReason: "cancelled" }); await stop;
    expect(f.manager.activeSessions).toBe(1);
    await expect(f.manager.create({ context: { instanceId: "instance", assignmentId: "later", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [], acpSessionRef })).rejects.toThrow();
  });

  it("stops only the exact owned session, retaining another session on the same runner", async () => {
    const f = managerFixture(); const first = await create(f.manager);
    f.connection.newSession.mockResolvedValueOnce({ sessionId: "other-bridge-session" });
    const other = await create(f.manager);
    await f.manager.stopForRecovery(first.acpSessionRef);
    expect(f.connection.cancel).toHaveBeenCalledWith({ sessionId: "bridge-session" });
    expect(f.manager.activeSessions).toBe(2);
    expect(() => f.manager.prompt(other.acpSessionRef, "other", { prompt: [] })).not.toThrow();
    f.prompt.resolve({ stopReason: "cancelled" });
  });

  it("cannot reload and replace a session reference while its recovery stop is pending", async () => {
    const f = managerFixture(); const { acpSessionRef } = await create(f.manager);
    f.manager.prompt(acpSessionRef, "request", { prompt: [] });
    const stop = f.manager.stopForRecovery(acpSessionRef);
    const reloaded = f.manager.create({ context: { instanceId: "instance", assignmentId: "other-assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [], acpSessionRef });
    // Settle the original prompt even when the red characterization admits the reload.
    const result = await Promise.allSettled([reloaded]);
    f.prompt.resolve({ stopReason: "cancelled" }); await stop;
    expect(result[0]?.status).toBe("rejected");
    expect(f.connection.loadSession).not.toHaveBeenCalled();
  });

  it("reserves a known reference before asynchronous load so concurrent bootstrap cannot steal it", async () => {
    const f = managerFixture(); await f.store.put("prior", "bridge-prior");
    const gate = Promise.withResolvers<Record<string, never>>();
    f.connection.loadSession.mockImplementation(() => gate.promise);
    const args = { context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, cwd: "/workspace", mcpServers: [], acpSessionRef: "prior" };
    const first = f.manager.create(args);
    await vi.waitFor(() => expect(f.connection.loadSession).toHaveBeenCalledTimes(1));
    const second = f.manager.create(args); const results = Promise.allSettled([first, second]);
    gate.resolve({});
    expect((await results).map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.connection.loadSession).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown sessions and transport-error completion instead of claiming quiescence", async () => {
    const f = managerFixture();
    await expect(f.manager.stopForRecovery("unknown")).rejects.toThrow();
    const { acpSessionRef } = await create(f.manager);
    f.manager.prompt(acpSessionRef, "request", { prompt: [] });
    const stop = f.manager.stopForRecovery(acpSessionRef);
    const rejected = expect(stop).rejects.toThrow();
    f.prompt.reject(new Error("transport lost")); await rejected;
    expect(f.manager.activeSessions).toBe(1);
    expect(() => f.manager.prompt(acpSessionRef, "late", { prompt: [] })).toThrow();
  });

  it("fails closed at a bounded stop deadline without killing the shared bridge", async () => {
    vi.useFakeTimers();
    try {
      const f = managerFixture(); const { acpSessionRef } = await create(f.manager);
      f.manager.prompt(acpSessionRef, "request", { prompt: [] });
      const stop = f.manager.stopForRecovery(acpSessionRef);
      const rejected = expect(stop).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_001); await rejected;
      expect(f.manager.activeSessions).toBe(1);
      f.prompt.resolve({ stopReason: "cancelled" });
    } finally { vi.useRealTimers(); }
  });

  it("does not turn recovery into an ordinary cancelled terminal", async () => {
    const f = await sessionFixture(); await f.session.bootstrap(); f.transport.send.mockClear();
    await f.session.stopForRecovery();
    expect(f.runner.stopForRecovery).toHaveBeenCalledWith("acp");
    expect(f.onClosed).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.session.isClosed).toBe(true);
  });

  it("waits for late bootstrap creation and stops it without registering readiness", async () => {
    const f = await sessionFixture();
    const created = Promise.withResolvers<Awaited<ReturnType<typeof f.runner.createSession>>>();
    f.runner.createSession.mockImplementation(() => created.promise);
    const ready = vi.spyOn(f.deps, "registerReady");
    const bootstrap = f.session.bootstrap(); const rejected = expect(bootstrap).rejects.toThrow();
    await vi.waitFor(() => expect(f.runner.createSession).toHaveBeenCalledTimes(1));
    let settled = false; const stop = f.session.stopForRecovery().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    created.resolve({ acpSessionRef: "late", resumed: false, capabilities: { forkSession: false, sessionResume: false } });
    await rejected; await stop;
    expect(f.runner.stopForRecovery).toHaveBeenCalledWith("late");
    expect(ready).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled();
  });

  it("does not infer stop when bridge creation has an unknown outcome and no reference", async () => {
    const f = await sessionFixture();
    const created = Promise.withResolvers<Awaited<ReturnType<typeof f.runner.createSession>>>();
    f.runner.createSession.mockImplementation(() => created.promise);
    const bootstrap = f.session.bootstrap(); const bootstrapFailure = expect(bootstrap).rejects.toThrow();
    await vi.waitFor(() => expect(f.runner.createSession).toHaveBeenCalledTimes(1));
    const stop = f.session.stopForRecovery(); const stopFailure = expect(stop).rejects.toThrow();
    created.reject(new Error("response lost after bridge created session"));
    await bootstrapFailure; await stopFailure;
    expect(f.onClosed).not.toHaveBeenCalled();
  });

  it("fences a legacy appliance prompt waiting on local inputs and settles that callback before returning", async () => {
    const gate = Promise.withResolvers<void>(); const entered = vi.fn();
    const f = await sessionFixture({ deploymentKind: "appliance" });
    f.deps.prepareInputs = async () => ({ binding: { workspaceId: "workspace", instanceId: "instance", assignmentId: "assignment", attempt: 1, sessionId: "cloud-session" }, cwd: "/workspace", skillInstructions: "", beforePrompt: async () => { entered(); await gate.promise; } });
    await f.session.bootstrap(); f.transport.send.mockClear();
    const request = f.session.onToRuntime({ kind: "acp", method: "session/prompt", id: "request", params: { sessionId: "acp", prompt: [{ type: "text", text: "work" }] } });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    let settled = false; const stop = f.session.stopForRecovery().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    gate.resolve(); await request; await stop;
    expect(f.runner.prompt).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled();
  });

  it("does not announce readiness after recovery stop wins the registration wait", async () => {
    const f = await sessionFixture();
    const ready = Promise.withResolvers<Awaited<ReturnType<NonNullable<RelayedSessionDeps["registerReady"]>>>>();
    const result = await f.deps.registerReady!(assignment, { workspaceId: "workspace", instanceId: "instance", assignmentId: "assignment", attempt: 1, sessionId: "cloud-session" }, "acp");
    const register = vi.fn(() => ready.promise); f.deps.registerReady = register;
    const bootstrap = f.session.bootstrap(); const rejected = expect(bootstrap).rejects.toThrow();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const stop = f.session.stopForRecovery(); ready.resolve(result);
    await rejected; await stop;
    expect(f.runner.stopForRecovery).toHaveBeenCalledWith("acp");
    expect(f.transport.send).not.toHaveBeenCalled(); expect(f.onClosed).not.toHaveBeenCalled();
  });

  it("never delivers a late policy allow after recovery fencing", async () => {
    const gate = Promise.withResolvers<{ kind: "allow"; optionId: string }>();
    const evaluatePermission = vi.fn(() => gate.promise);
    const f = await sessionFixture({ policy: { evaluatePermission, evaluateElicitation: async () => ({ kind: "decline" }) } });
    await f.session.bootstrap();
    const event = f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp", requestId: "permission", params: { sessionId: "acp", toolCall: { toolCallId: "tool", title: "Write" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    await vi.waitFor(() => expect(evaluatePermission).toHaveBeenCalledTimes(1));
    const stop = f.session.stopForRecovery(); gate.resolve({ kind: "allow", optionId: "allow" });
    await event; await stop;
    expect(f.runner.answer).not.toHaveBeenCalled();
  });

  it("fails closed when the runner cannot prove stop, and preserves ordinary cancel", async () => {
    const f = await sessionFixture(); await f.session.bootstrap();
    Reflect.deleteProperty(f.runner, "stopForRecovery");
    await expect(f.session.stopForRecovery()).rejects.toThrow();
    expect(f.onClosed).not.toHaveBeenCalled();
    const ordinary = await sessionFixture(); await ordinary.session.bootstrap();
    await ordinary.session.close("cancelled");
    expect(ordinary.onClosed).toHaveBeenCalledWith(ordinary.session, "cancelled");
  });

  it("the real orchestrator suppresses dispatch failure when recovery stops an in-flight bootstrap", async () => {
    const f = await sessionFixture();
    const created = Promise.withResolvers<Awaited<ReturnType<typeof f.runner.createSession>>>();
    f.runner.createSession.mockImplementation(() => created.promise);
    const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: f.journal, outbox: f.outbox, transport: f.transport, clock,
      runners: new Map([["codex", f.runner]]), sessionDeps: () => f.deps, onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process", assertOwned: () => undefined, recoveryAuthority: () => "accepted-A", reportDeliveryAllowed: () => false } as never);
    const begun = Promise.withResolvers<void>();
    (f.runner.createSession as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_input, lifecycle) => { await lifecycle.beforeCreate("late"); begun.resolve(); return created.promise; });
    const entry = { assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution" as const, placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const, expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() };
    await f.journal.assignments.put(entry);
    await f.journal.execution.admit({ instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "process", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: clock.nowIso() }, () => undefined);
    const internal = work as unknown as { captureNativeAuthority(id: string, attempt: number): () => void; dispatch(a: RemoteWorkAssignment, e: typeof entry, check: () => void): Promise<void> };
    const dispatch = internal.dispatch(assignment, entry, internal.captureNativeAuthority(assignment.id, assignment.attempt));
    await begun.promise;
    const stop = work.stopForRecovery("assignment", 1);
    created.resolve({ acpSessionRef: "late", resumed: false, capabilities: { forkSession: false, sessionResume: false } });
    await expect(stop).rejects.toThrow("quiescence"); await dispatch;
    expect(f.outbox.depth).toBe(0);
    expect(f.journal.assignments.get("assignment:1")?.reports.terminalSequence).toBeUndefined();
    expect(f.runner.stopForRecovery).toHaveBeenCalledWith("late");
    expect(f.journal.execution.execution(f.journal.execution.admission("assignment", 1)!)?.phase).toBe("acp_settled");
  });

  it("the orchestrator does not interpret a missing process owner as stopped prior journal work", async () => {
    const f = await sessionFixture();
    const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: f.journal, outbox: f.outbox, transport: f.transport, clock,
      runners: new Map([["codex", f.runner]]), sessionDeps: () => f.deps, onUsage: async () => undefined, instanceId: () => "instance", reportDeliveryAllowed: () => false } as never);
    await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution", placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "running", acpSessionRef: "prior-process-ref", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() });
    await expect(work.stopForRecovery("assignment", 1)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.runner.stopForRecovery).not.toHaveBeenCalled();
    expect(f.outbox.depth).toBe(0);
  });

  it("settles a claimed admission that never opened local execution without demanding a process owner", async () => {
    const f = await sessionFixture();
    const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: f.journal, outbox: f.outbox, transport: f.transport, clock,
      runners: new Map([["codex", f.runner]]), sessionDeps: () => f.deps, onUsage: async () => undefined,
      instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "successor", assertOwned: () => undefined,
      recoveryAuthority: () => "accepted-successor", reportDeliveryAllowed: () => false } as never);
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "predecessor", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: clock.nowIso() };
    await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution", placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "claimed", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() });
    await f.journal.execution.admit(admission, () => undefined);

    await expect(work.stopForRecovery("assignment", 1, () => undefined)).resolves.toBeUndefined();
    expect(f.runner.stopForRecovery).not.toHaveBeenCalled();
    expect(f.outbox.depth).toBe(0);
  });

  it("rehydrates an exact retained macOS owner only under the current reconciliation fence", async () => {
    const f = await sessionFixture();
    const retainedStop = vi.fn(async () => undefined);
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "predecessor", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: clock.nowIso() };
    await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution", placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "running", acpSessionRef: "prior-process-ref", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() });
    await f.journal.execution.admit(admission, () => undefined);
    await f.journal.execution.open(admission, () => undefined, clock.nowIso());
    await f.journal.execution.bindReference(admission, "prior-process-ref", () => undefined);
    const owner = { version: 1 as const, platform: "darwin" as const, pid: 123, processGroupId: 123, startToken: "start", commandDigest: "A".repeat(43) };
    await f.journal.execution.bindProcessOwner(admission, owner, () => undefined);
    const restarted = new SupervisorJournal(dir); await restarted.load();
    const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: restarted, outbox: f.outbox, transport: f.transport, clock,
      runners: new Map([["codex", { ...f.runner, stopRetainedExecution: retainedStop }]]), sessionDeps: () => f.deps, onUsage: async () => undefined,
      instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "successor", assertOwned: () => undefined,
      recoveryAuthority: () => "accepted-successor", reportDeliveryAllowed: () => false } as never);
    // The process is proven gone, so the attempt is settled as interrupted
    // rather than blocking startup recovery forever. This is not quiescence:
    // the retained reference stays excluded and no capacity is released.
    await expect(work.stopForRecovery("assignment", 1, () => undefined)).resolves.toBeUndefined();
    expect(retainedStop).toHaveBeenCalledWith(owner);
    expect(restarted.execution.execution(admission)?.phase).toBe("interrupted_unqualified");
    expect(() => restarted.execution.assertQuiescent(admission)).toThrow("not qualified execution quiescence");
    // Idempotent: a repeated recovery neither re-signals nor changes the record.
    const interruptedAt = restarted.execution.execution(admission)?.interruptedAt;
    await expect(work.stopForRecovery("assignment", 1, () => undefined)).resolves.toBeUndefined();
    expect(retainedStop).toHaveBeenCalledOnce();
    expect(restarted.execution.execution(admission)?.interruptedAt).toBe(interruptedAt);
  });

  it("reports a retained execution interrupted after a predecessor already settled its ACP turn", async () => {
    const f = await sessionFixture();
    const retainedStop = vi.fn(async () => undefined);
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "predecessor", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: clock.nowIso() };
    await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "assistant_execution", placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "running", acpSessionRef: "prior-process-ref", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() });
    await f.journal.execution.admit(admission, () => undefined);
    await f.journal.execution.open(admission, () => undefined, clock.nowIso());
    await f.journal.execution.bindReference(admission, "prior-process-ref", () => undefined);
    const owner = { version: 1 as const, platform: "darwin" as const, pid: 123, processGroupId: 123, startToken: "start", commandDigest: "A".repeat(43) };
    await f.journal.execution.bindProcessOwner(admission, owner, () => undefined);
    // The predecessor's live recovery settled ACP, then refused to certify quiescence and died.
    await f.journal.execution.markStopping(admission, clock.nowIso(), () => undefined);
    await f.journal.execution.markAcpSettled(admission, "prior-process-ref", clock.nowIso(), () => undefined);
    const restarted = new SupervisorJournal(dir); await restarted.load();
    const acpSettledAt = restarted.execution.execution(admission)?.acpSettledAt;
    const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: restarted, outbox: f.outbox, transport: f.transport, clock,
      runners: new Map([["codex", { ...f.runner, stopRetainedExecution: retainedStop }]]), sessionDeps: () => f.deps, onUsage: async () => undefined,
      instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "successor", assertOwned: () => undefined,
      recoveryAuthority: () => "accepted-successor", reportDeliveryAllowed: () => false } as never);
    await expect(work.stopForRecovery("assignment", 1, () => undefined)).resolves.toBeUndefined();
    expect(retainedStop).toHaveBeenCalledWith(owner);
    expect(restarted.execution.execution(admission)).toMatchObject({ phase: "interrupted_unqualified", acpSettledAt });
    expect(() => restarted.execution.assertQuiescent(admission)).toThrow("not qualified execution quiescence");
  });

  it("replays frozen native delivery output before a retained process is reported interrupted", async () => {
    const f = await sessionFixture();
    const events: string[] = [];
    const retainedStop = vi.fn(async () => { events.push("process-stopped"); });
    const recoverPendingDeliveryOutput = vi.fn(async () => {
      events.push("output-recovered");
      return {
        acpSessionRef: "prior-process-ref",
        receipt: {
          version: 1 as const,
          acceptanceId: "accepted",
          invocationRef: "invocation",
          binding: { workspaceId: "workspace", instanceId: "instance", sessionId: "execution-session", assignmentId: "assignment", attempt: 1 },
          claimId: "claim",
          resultId: "result",
          resultDigest: `sha256:${"a".repeat(64)}`,
          inputSelectionDigest: `sha256:${"b".repeat(64)}`,
          baseRevision: "base",
          acceptedAt: clock.nowIso(),
        },
      };
    });
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "predecessor", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: clock.nowIso() };
    await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "delivery", placementId: "placement", workspaceId: "workspace", agentId: "codex", state: "running", acpSessionRef: "prior-process-ref", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() });
    await f.journal.execution.admit(admission, () => undefined);
    await f.journal.execution.open(admission, () => undefined, clock.nowIso());
    await f.journal.execution.bindReference(admission, "prior-process-ref", () => undefined);
    const owner = { version: 1 as const, platform: "darwin" as const, pid: 123, processGroupId: 123, startToken: "start", commandDigest: "A".repeat(43) };
    await f.journal.execution.bindProcessOwner(admission, owner, () => undefined);
    const restarted = new SupervisorJournal(dir); await restarted.load();
    const work = new WorkOrchestrator({ deploymentKind: "native_connector", journal: restarted, outbox: f.outbox, transport: f.transport, clock,
      runners: new Map([["codex", { ...f.runner, stopRetainedExecution: retainedStop }]]), sessionDeps: () => f.deps, onUsage: async () => undefined,
      instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "successor", assertOwned: () => undefined,
      recoveryAuthority: () => "accepted-successor", reportDeliveryAllowed: () => false, recoverPendingDeliveryOutput } as never);

    await expect(work.stopForRecovery("assignment", 1, () => undefined)).resolves.toBeUndefined();
    expect(events).toEqual(["output-recovered", "process-stopped"]);
    expect(recoverPendingDeliveryOutput).toHaveBeenCalledWith(admission, expect.objectContaining({ acpSessionRef: "prior-process-ref", processOwner: owner }));
    expect(work.reports.queuedTerminalReport("assignment", 1, "claim")?.result).toMatchObject({
      class: "succeeded",
      structuredOutput: { nativeDeliveryAcceptance: { acceptanceId: "accepted" } },
    });
  });
});

it.each([true, false])("reports live authority loss only after exact process stop proof: %s", async confirmed => {
  const f = await realOwnedWork(); await f.dispatch();
  await vi.waitFor(() => expect(f.journal.assignments.get("assignment:1")?.state).toBe("running"));
  const owner = { version: 1 as const, platform: "darwin" as const, pid: 123, processGroupId: 123, startToken: "start", commandDigest: "A".repeat(43) };
  await f.journal.execution.bindProcessOwner(f.admission, owner, () => undefined);
  const stop = vi.fn(async () => { if (!confirmed) throw new RemoteInstanceError("recovery_required", "process identity is uncertain"); });
  Object.assign(f.runner, { stopRetainedExecution: stop });
  const recover = () => (f.work as unknown as { recoverLostExecutionAuthority(id: string, attempt: number): Promise<void> }).recoverLostExecutionAuthority("assignment", 1);
  if (confirmed) {
    await recover();
    await recover();
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(owner);
    expect(f.journal.execution.execution(f.admission)?.phase).toBe("interrupted_unqualified");
    expect(f.journal.assignments.get("assignment:1")?.reports.terminalSequence).toBeDefined();
    expect(f.outbox.depth).toBe(1);
  } else {
    await expect(recover()).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.outbox.depth).toBe(0);
    expect(f.journal.execution.execution(f.admission)?.phase).toBe("acp_settled");
  }
  expect(() => f.journal.execution.assertQuiescent(f.admission)).toThrow();
  expect(f.transport.closeChannel).not.toHaveBeenCalled();
});


it("persists authority-loss uncertainty before cancellation fails and replays the same evidence", async () => {
  const f = await realOwnedWork(); await f.dispatch();
  await vi.waitFor(() => expect(f.journal.assignments.get("assignment:1")?.state).toBe("running"));
  f.connection.cancel.mockImplementation(async () => {
    expect(f.journal.recoveryEvidence.all()).toHaveLength(1);
    expect(f.journal.recoveryEvidence.all()[0]?.evidence).toMatchObject({ stopClass: "stop_unconfirmed", terminalDisposition: "not_terminal" });
    throw new Error("cancel response lost");
  });
  f.recoveryEvidence.submit.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "Core down"));
  const recover = () => (f.work as unknown as { recoverLostExecutionAuthority(id: string, attempt: number): Promise<void> }).recoverLostExecutionAuthority("assignment", 1);
  await expect(recover()).rejects.toThrow();
  const first = f.journal.recoveryEvidence.all()[0];
  expect(first).toBeDefined();
  expect(first?.delivery).toBe("pending");
  expect(f.outbox.depth).toBe(0);
  expect(() => f.journal.execution.assertQuiescent(f.admission)).toThrow();
  await f.journal.recoveryEvidence.update(recoveryEvidenceRecordKey(first!), record => ({ ...record!, nextAttemptAt: clock.nowIso() }));
  await f.work.retryRecoveryEvidence();
  expect(f.recoveryEvidence.submit).toHaveBeenCalledTimes(2);
  expect(f.recoveryEvidence.submit.mock.calls[1]?.[0]?.evidence).toEqual(first?.evidence);
  expect(f.journal.recoveryEvidence.all()[0]?.delivery).toBe("accepted");
  expect(f.transport.closeChannel).not.toHaveBeenCalled();
});

it("still attempts cancellation when persisting the uncertainty observation fails", async () => {
  const f = await realOwnedWork(); await f.dispatch();
  await vi.waitFor(() => expect(f.journal.assignments.get("assignment:1")?.state).toBe("running"));
  vi.spyOn(f.journal.recoveryEvidence, "put").mockRejectedValue(new Error("disk unavailable"));
  f.connection.cancel.mockRejectedValue(new Error("cancel unavailable"));
  await expect((f.work as unknown as { recoverLostExecutionAuthority(id: string, attempt: number): Promise<void> })
    .recoverLostExecutionAuthority("assignment", 1)).rejects.toThrow();
  expect(f.connection.cancel).toHaveBeenCalled();
  expect(f.outbox.depth).toBe(0);
  expect(() => f.journal.execution.assertQuiescent(f.admission)).toThrow();
});
