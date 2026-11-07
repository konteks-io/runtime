import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal, type JournalEntry } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { IDLE_RELEASE_WAIT_MS, WorkOrchestrator } from "../work/orchestrator.js";
import type { LocalAdmission } from "../state/local-admission.js";
import { PermissionBroker } from "../session/permissions.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import type { RelayedSession } from "../session/relayed-session.js";

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
const delivery = (identity: LocalAdmission, invocationId: string, includePredecessor = identity.assignmentId === "next"): RemoteWorkAssignment => ({
  id: identity.assignmentId, kind: "delivery", placementId: `placement-${identity.assignmentId}`, instanceId: identity.instanceId,
  workspaceId: identity.workspaceId, taskId: "repository-task", correlationId: invocationId, attempt: identity.attempt,
  expiresAt: "2026-09-06T01:00:00.000Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "generator", agentId: identity.agentId, sessionConfig: { model: "claude-sonnet" } },
  source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: identity.instanceId,
    executionSessionId: "repository-generator-session", repositoryId: "https://git.example.com/acme/store",
    modelBinding: { canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet" },
    turn: { invocationId, dispatchGeneration: 0,
      ...(includePredecessor ? { predecessor: { invocationId: "generate-1", dispatchGeneration: 0 } } : {}) } },
  policy: { maxDurationSeconds: 3600, maxArtifactBytes: 0, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-06T01:00:00.000Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
});

const readyAgent = { agentId: "claude-code", displayName: "Claude Code", connectionState: "ready" as const,
  authMode: "agent_local_subscription" as const, accountScope: "personal" as const, readiness: "ready" as const,
  tokenUsageObservable: true, acpCapabilities: { sessionResume: true, forkSession: false, structuredOutputShim: true, toolControl: "approve" as const } };

/** The prior claim's report state, optionally carrying Core's ACK of its terminal. */
function priorReportState(options: { terminal?: boolean; acknowledged?: boolean }): Pick<JournalEntry, "reports" | "terminalResultHash"> {
  if (options.acknowledged) return { terminalResultHash: "s".repeat(43), reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1,
    terminalAck: { assignmentId: "prior", attempt: 1, claimId: "prior-claim",
      acknowledged: { reportId: "report-prior", reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" } } };
  return { reports: { nextSequence: 2, durableWatermark: 0, ...(options.terminal === false ? {} : { terminalSequence: 1 }) } };
}

async function fixture(options: {
  terminal?: boolean;
  acknowledged?: boolean;
  closed?: boolean;
  priorRequestedRef?: string;
  preserveStoppedWorkspace?: (admission: LocalAdmission, assertCurrent: () => void) => Promise<void>;
} = {}) {
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
    agentId: "claude-code", state: "running", recoveryEpoch: 0, ...priorReportState(options),
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const runner = { stopForRecovery: vi.fn(async () => undefined), releaseSealedSession: vi.fn(async () => undefined), stopRetainedExecution: vi.fn(async () => undefined) };
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => logger } as never;
  const orchestrator = new WorkOrchestrator({ journal, outbox, transport: {}, clock, runners: new Map([["claude-code", runner]]),
    sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process",
    assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false,
    lease: { canPullNewWork: () => true }, reconciliationComplete: () => true, draining: () => false, headroom: () => 2, maxPullItems: 4,
    agents: () => [readyAgent], roleBindings: () => [{ role: "assistant", agentPreference: ["claude-code"] }],
    advertisedRoles: () => ["assistant"], acceptedKinds: () => ["assistant_execution", "delivery"], instanceEvidencePolicy: () => "structured_only",
    verifyCancellation: () => true,
    logger, ...(options.preserveStoppedWorkspace ? { preserveStoppedWorkspace: options.preserveStoppedWorkspace } : {}) } as never);
  const internal = orchestrator as unknown as { channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined> };
  const predecessor = { assignment: work(prior), acpSessionRef: "ref", isClosed: options.closed ?? true,
    releaseCompletedChannel: vi.fn(() => { internal.channelOwners.delete("session:session"); }) };
  internal.channelOwners.set("session:session", predecessor);
  internal.sessions.set("prior:1", predecessor);
  return { journal, runner, orchestrator, internal, predecessor, warn };
}

/** A checkpoint upload the test holds open, so the reaper is inside the deliberate release window. */
function heldCheckpoint() {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const preserve = vi.fn(async () => { markStarted(); await held; });
  return { started, release, preserve };
}

/** A settled repository-role delivery head the reaper releases, and its exact successor turn. */
async function harnessReleaseWindow(preserveStoppedWorkspace: (admission: LocalAdmission, assertCurrent: () => void) => Promise<void>) {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const previous = delivery(prior, "generate-1");
  const successor = delivery(next, "generate-2");
  for (const [identity, assignment] of [[prior, previous], [next, successor]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment,
      evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  await journal.execution.open(prior, current, prior.openedAt);
  await journal.execution.bindReference(prior, "generator-ref", current);
  await journal.execution.bindProcessOwner(prior, processOwner, current);
  await journal.execution.markCompletedTurnSettled(prior, "generator-ref", "2026-09-06T00:00:01.000Z", current);
  await journal.assignments.put({ assignmentId: "prior", attempt: 1, claimId: "prior-claim", kind: "delivery",
    placementId: previous.placementId, workspaceId: "workspace", agentId: "claude-code", state: "completed", recoveryEpoch: 0,
    terminalResultHash: "s".repeat(43),
    reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1,
      terminalAck: { assignmentId: "prior", attempt: 1, claimId: "prior-claim",
        acknowledged: { reportId: "report-prior", reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" } },
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const runner = { stopForRecovery: vi.fn(async () => undefined), releaseSealedSession: vi.fn(async () => undefined), stopRetainedExecution: vi.fn(async () => undefined) };
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => logger } as never;
  const orchestrator = new WorkOrchestrator({ journal, outbox, transport: {}, clock, runners: new Map([["claude-code", runner]]),
    sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace", runnerIncarnation: () => "process",
    assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false,
    lease: { canPullNewWork: () => true }, reconciliationComplete: () => true, draining: () => false, headroom: () => 2, maxPullItems: 4,
    agents: () => [readyAgent], roleBindings: () => [{ role: "generator", agentPreference: ["claude-code"] }],
    advertisedRoles: () => ["generator"], acceptedKinds: () => ["delivery"], instanceEvidencePolicy: () => "structured_only",
    logger, preserveStoppedWorkspace } as never);
  const internal = orchestrator as unknown as { channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    reapIdleCompletedSessions(idleMs: number): Promise<number>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined> };
  const channel = "session:repository-generator-session";
  const owner = { assignment: previous, acpSessionRef: "generator-ref", isClosed: true,
    releaseCompletedChannel: vi.fn(() => { internal.channelOwners.delete(channel); }) };
  internal.channelOwners.set(channel, owner);
  internal.sessions.set("prior:1", owner);
  return { journal, runner, orchestrator, internal, owner, channel, successor, warn };
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

it.each(["fresh", "live"] as const)("binds a %s conversation bootstrap to the transport chosen by takeover", async mode => {
  const previous = { ...prior, agentId: "codex" };
  const successor = { ...next, agentId: "codex" };
  const assignment = { ...work(successor, mode === "live" ? "prior-ref" : undefined),
    agentRoute: { requiredRole: "assistant" as const, agentId: "codex", mcpCapabilityTokenRef: "capability" } };
  const previousAssignment = { ...work(previous), agentRoute: assignment.agentRoute };
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  for (const [identity, item] of [[previous, previousAssignment], [successor, assignment]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment: item,
      evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  const priorTransport = { port: await closedLoopbackPort(), credential: "p".repeat(43) };
  await journal.execution.open(previous, current, previous.openedAt);
  await journal.execution.bindReference(previous, "prior-ref", current);
  await journal.execution.bindMcpLocalTransport(previous, priorTransport, current);
  await journal.execution.bindProcessOwner(previous, processOwner, current);
  await journal.execution.markCompletedTurnSettled(previous, "prior-ref", "2026-09-06T00:00:01.000Z", current);
  await journal.assignments.put({ assignmentId: previous.assignmentId, attempt: 1, claimId: previous.claimId,
    kind: "assistant_execution", placementId: previousAssignment.placementId, workspaceId: previous.workspaceId,
    agentId: "codex", state: "completed", recoveryEpoch: 0, reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1 },
    evidenceUpload: "structured_only", expiresAt: previousAssignment.expiresAt, latestResumeAt: previousAssignment.policy.latestResumeAt, updatedAt: clock.nowIso() });
  const entry = { assignmentId: successor.assignmentId, attempt: 1, claimId: successor.claimId,
    kind: "assistant_execution" as const, placementId: assignment.placementId, workspaceId: successor.workspaceId,
    agentId: "codex", state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 },
    evidenceUpload: "structured_only" as const, expiresAt: assignment.expiresAt,
    latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso() };
  await journal.assignments.put(entry);
  const createSession = vi.fn(async (_request: unknown, lifecycle?: { beforeCreate(ref: string): Promise<void> }) => {
    const ref = mode === "live" ? "prior-ref" : "fresh-ref";
    await lifecycle?.beforeCreate(ref);
    return { acpSessionRef: ref, resumed: mode === "live", capabilities: { forkSession: false, sessionResume: true } };
  });
  const runner = { createSession, releaseSealedSession: vi.fn(async () => undefined), stopRetainedExecution: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
  const broker = new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined });
  const orchestrator = new WorkOrchestrator({ journal, outbox, transport: { send: () => undefined, openChannel: () => undefined, closeChannel: () => undefined },
    clock, runners: new Map([["codex", runner]]), instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "process", assertOwned: () => undefined, recoveryAuthority: () => "accepted",
    reportDeliveryAllowed: () => false, onUsage: async () => undefined,
    sessionDeps: () => ({ clock, journal, transport: { send: () => undefined, openChannel: () => undefined, closeChannel: () => undefined },
      runner, policy: new EvaluatorPolicyResponder(null, () => true), broker, instanceId: "instance", workspaceRoot: dir,
      prepareInputs: async (item: RemoteWorkAssignment) => ({ binding: { workspaceId: item.workspaceId, sessionId: "session",
        assignmentId: item.id, instanceId: item.instanceId, attempt: item.attempt }, cwd: dir, skillInstructions: "", beforePrompt: async () => undefined }),
      redeemCapabilityToken: async () => ({ mcpServer: { name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer current" }] },
        expiresAt: "2026-09-07T00:00:00Z" }),
      registerReady: async () => ({ workspaceId: "workspace", instanceId: "instance", sessionId: "session", channelId: "session:session",
        assignmentId: successor.assignmentId, attempt: 1, claimId: successor.claimId, recoveryEpoch: 0, runnerIncarnation: "process",
        agentId: "codex", acpSessionRef: mode === "live" ? "prior-ref" : "fresh-ref", readyRevision: 1, registeredAt: clock.nowIso() }) }),
  } as never);
  const internal = orchestrator as unknown as { channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    bootstrapping: Map<string, Promise<void>>; startRelayedSession(item: RemoteWorkAssignment, claim: typeof entry, assertCurrent: () => void): Promise<void>;
    bootstrapRelayedSession(session: RelayedSession): Promise<void>; handleDispatchFailure(): Promise<void> };
  const predecessor = { assignment: previousAssignment, acpSessionRef: "prior-ref", isClosed: true,
    releaseCompletedChannel: () => { internal.channelOwners.delete("session:session"); } };
  internal.channelOwners.set("session:session", predecessor);
  internal.sessions.set(`${previous.assignmentId}:1`, predecessor);
  let session: RelayedSession | undefined;
  vi.spyOn(internal, "bootstrapRelayedSession").mockImplementation(async value => { session = value; await value.bootstrap(); });
  vi.spyOn(internal, "handleDispatchFailure").mockResolvedValue(undefined);
  try {
    await internal.startRelayedSession(assignment, entry, current);
    await internal.bootstrapping.get(`${successor.assignmentId}:1`);
    expect(createSession).toHaveBeenCalledOnce();
    expectBootstrapTransport(mode, journal.execution.execution(successor)?.mcpLocalTransport, priorTransport, createSession.mock.calls[0]?.[0]);
  } finally { await session?.close("cancelled"); }
});

/** A loopback port that was free a moment ago: a prior transport nothing listens on any more. */
async function closedLoopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing listener port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

/** A live bootstrap reuses the prior transport and session; a fresh one gets its own. */
function expectBootstrapTransport(mode: "fresh" | "live", transport: { port: number; credential: string } | undefined, priorTransport: { port: number; credential: string }, request: unknown): void {
  expect(transport).toBeDefined();
  if (mode === "live") {
    expect(transport).toEqual(priorTransport);
    expect(request).toMatchObject({ acpSessionRef: "prior-ref" });
    return;
  }
  expect(transport?.credential).not.toBe(priorTransport.credential);
  expect(request).not.toHaveProperty("acpSessionRef");
  expect(request).not.toHaveProperty("restoreAcpSessionRef");
}

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
  // cancelled — and the cancellation itself needs protocol 2.0. Live,
  // a hosted turn that failed before its prompt arrived left a
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
  const orchestrator = new WorkOrchestrator({ journal, outbox, transport: {}, clock,
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
  const orchestrator = new WorkOrchestrator({ journal, outbox, transport: {}, clock,
    runners: new Map(), sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "restarted-process", assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as {
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };

  await expect(internal.takeOverCompletedChannel(delivery(restarted, "generate-2"), restarted, current)).resolves.toBeUndefined();
  expect(journal.execution.execution(restarted)).toBeUndefined();
});

it("starts a fresh repository-anchored cycle after the previous empty-output session was durably settled", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const restarted = { ...next, runnerIncarnation: "restarted-process" };
  const predecessor = delivery(prior, "generate-1");
  const repositoryAnchor = delivery(restarted, "generate-2", false);
  for (const [identity, assignment] of [[prior, predecessor], [restarted, repositoryAnchor]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment,
      evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  await journal.execution.open(prior, current, prior.openedAt);
  await journal.execution.bindReference(prior, "generator-ref", current);
  await journal.execution.bindProcessOwner(prior, processOwner, current);
  await journal.execution.markCompletedTurnSettled(prior, "generator-ref", "2026-09-06T00:00:01.000Z", current);
  await journal.execution.markStopping(prior, "2026-09-06T00:00:02.000Z", current);
  await journal.execution.markAcpSettled(prior, "generator-ref", "2026-09-06T00:00:03.000Z", current);
  await journal.assignments.put({ assignmentId: "prior", attempt: 1, claimId: "prior-claim", kind: "delivery", placementId: "placement-prior", workspaceId: "workspace",
    agentId: "claude-code", state: "completed", recoveryEpoch: 0, terminalResultHash: "s".repeat(43),
    reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1,
      terminalAck: { assignmentId: "prior", attempt: 1, claimId: "prior-claim",
        acknowledged: { reportId: "report-prior", reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" } },
    evidenceUpload: "structured_only", expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const orchestrator = new WorkOrchestrator({ deploymentKind: "native_connector", journal, outbox, transport: {}, clock,
    runners: new Map(), sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "restarted-process", assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as {
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };

  await expect(internal.takeOverCompletedChannel(repositoryAnchor, restarted, current)).resolves.toBeUndefined();
  expect(journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled", acpSessionRef: "generator-ref" });
  expect(journal.execution.execution(restarted)).toBeUndefined();
});

it("starts a fresh agent session to revalidate preserved changes after the exact predecessor was durably settled", async () => {
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
  await journal.execution.markStopping(prior, "2026-09-06T00:00:02.000Z", current);
  await journal.execution.markAcpSettled(prior, "generator-ref", "2026-09-06T00:00:03.000Z", current);
  await journal.assignments.put({ assignmentId: "prior", attempt: 1, claimId: "prior-claim", kind: "delivery", placementId: "placement-prior", workspaceId: "workspace",
    agentId: "claude-code", state: "completed", recoveryEpoch: 0, terminalResultHash: "s".repeat(43),
    reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1,
      terminalAck: { assignmentId: "prior", attempt: 1, claimId: "prior-claim",
        acknowledged: { reportId: "report-prior", reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" } }, evidenceUpload: "structured_only",
    expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const orchestrator = new WorkOrchestrator({ deploymentKind: "native_connector", journal, outbox, transport: {}, clock,
    runners: new Map(), sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "restarted-process", assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as {
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined>;
  };

  const wrongPredecessor = delivery(restarted, "generate-2");
  if (wrongPredecessor.source.kind !== "harness_delivery") throw new Error("delivery fixture mismatch");
  wrongPredecessor.source.turn.predecessor = { invocationId: "some-other-turn", dispatchGeneration: 0 };
  await expect(internal.takeOverCompletedChannel(wrongPredecessor, restarted, current))
    .rejects.toMatchObject({ code: "recovery_required", diagnostic: "local_execution_unprovable" });
  await expect(internal.takeOverCompletedChannel(delivery(restarted, "generate-2"), restarted, current)).resolves.toBeUndefined();
  expect(journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled", acpSessionRef: "generator-ref" });
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

// TKT-1: a claim reply is handled on the assignment channel's one-at-a-time
// lane. Waiting for the deliberate release there would hold every later claim,
// report ack and cancel, so the dispatch itself must be handed off-lane.
it("returns the claim lane while a deliberate release is still in flight", async () => {
  const checkpoint = heldCheckpoint();
  const f = await fixture({ preserveStoppedWorkspace: checkpoint.preserve });
  await f.journal.assignments.put({ assignmentId: "next", attempt: 1, claimId: "next-claim", kind: "assistant_execution",
    placementId: "placement-next", workspaceId: "workspace", agentId: "claude-code", state: "claimed", recoveryEpoch: 0,
    reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only",
    expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  await f.journal.assignments.put({ assignmentId: "other", attempt: 1, claimId: "other-claim", kind: "delivery",
    placementId: "placement-other", workspaceId: "workspace", agentId: "claude-code", state: "running", recoveryEpoch: 0,
    reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only",
    expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const internal = f.internal as unknown as {
    reapIdleCompletedSessions(idleMs: number): Promise<number>;
    dispatchClaimed(claimed: { key: string; assignment: RemoteWorkAssignment; entry: JournalEntry; assertAuthority: () => void }): Promise<void>;
    onAssignmentMessage(body: unknown): Promise<void>;
    dispatching: Map<string, Promise<void>>;
    bootstrapRelayedSession(session: RelayedSession): Promise<void>;
  };
  const submit = vi.spyOn(f.orchestrator.reports, "submit");
  const bootstrap = vi.spyOn(internal, "bootstrapRelayedSession").mockResolvedValue(undefined);
  const reaping = internal.reapIdleCompletedSessions(1_000);
  await checkpoint.started;

  let claimLaneReturned = false;
  const claim = internal.dispatchClaimed({ key: "next:1", assignment: work(next), entry: f.journal.assignments.get("next:1")!, assertAuthority: current })
    .then(() => { claimLaneReturned = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(claimLaneReturned).toBe(true);

  // A later assignment-channel frame is processed while the release is still held.
  await internal.onAssignmentMessage({ assignmentId: "other", attempt: 1, reason: "user_cancelled",
    issuedAt: clock.nowIso(), signature: "A".repeat(43) });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "other",
    draft: expect.objectContaining({ terminal: true, result: expect.objectContaining({ class: "cancelled" }) }) }));

  checkpoint.release();
  await expect(reaping).resolves.toBe(1);
  await claim;
  await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(internal.dispatching.has("next:1")).toBe(false));
  expect(f.journal.assignments.get("next:1")?.reports.terminalSequence).toBeUndefined();
});

// TKT-1: the successor takes the real post-release path rather than a mocked
// bootstrap: takeOverCompletedChannel -> takeOverHarnessHead ->
// canStartFreshAfterSettledHarnessPredecessor, with no refusal and no terminal.
it("starts the repository-role successor through the real post-release path", async () => {
  const checkpoint = heldCheckpoint();
  const f = await harnessReleaseWindow(checkpoint.preserve);
  const submit = vi.spyOn(f.orchestrator.reports, "submit");
  const order: string[] = [];
  f.owner.releaseCompletedChannel.mockImplementationOnce(() => {
    order.push("released");
    f.internal.channelOwners.delete(f.channel);
  });
  const reaping = f.internal.reapIdleCompletedSessions(1_000);
  await checkpoint.started;
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "process_stopped" });

  const handoff = f.internal.takeOverCompletedChannel(f.successor, next, current)
    .then(() => { order.push("successor"); return "resolved" as const; }, error => ({ error }));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(order).toEqual([]);
  checkpoint.release();

  await expect(handoff).resolves.toBe("resolved");
  await expect(reaping).resolves.toBe(1);
  expect(order).toEqual(["released", "successor"]);
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled" });
  expect(f.internal.channelOwners.has(f.channel)).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  expect(f.warn.mock.calls.some(([fields]) => fields?.outcome === "fresh_after_settled_predecessor")).toBe(true);
});

it("refuses a placement whose window expired while it waited for the release", async () => {
  const checkpoint = heldCheckpoint();
  const f = await fixture({ preserveStoppedWorkspace: checkpoint.preserve });
  const internal = f.internal as unknown as { reapIdleCompletedSessions(idleMs: number): Promise<number> };
  const reaping = internal.reapIdleCompletedSessions(1_000);
  await checkpoint.started;
  // The assignment was admitted under a 01:00 deadline; the wait carries it past that.
  clock.advance(2 * 60 * 60_000);
  try {
    const outcome = f.internal.takeOverCompletedChannel(work(next), next, current)
      .then(() => null, (error: unknown) => error);
    checkpoint.release();
    expect(await outcome).toMatchObject({ code: "recovery_required", diagnostic: "assignment_expired_while_releasing" });
  } finally {
    clock.advance(-2 * 60 * 60_000);
    checkpoint.release();
    await reaping;
  }
});

it("does not claim an offer while its session's deliberate release is in flight", async () => {
  const checkpoint = heldCheckpoint();
  const f = await fixture({ preserveStoppedWorkspace: checkpoint.preserve });
  const internal = f.internal as unknown as {
    reapIdleCompletedSessions(idleMs: number): Promise<number>;
    admitOffered(raw: unknown): Promise<void>;
  };
  const reaping = internal.reapIdleCompletedSessions(1_000);
  await checkpoint.started;
  const offered = { ...next, assignmentId: "offered", claimId: "offered-claim", executionGeneration: "offered-generation" };
  await internal.admitOffered(work(offered)).catch(() => undefined);
  expect(f.orchestrator.counters.release_in_progress).toBe(1);
  expect(f.journal.execution.start("offered", 1)).toBeUndefined();
  checkpoint.release();
  await expect(reaping).resolves.toBe(1);
});

it("names a deliberate release that outlives its deadline and leaves the recovery gate in charge", async () => {
  const checkpoint = heldCheckpoint();
  const f = await fixture({ preserveStoppedWorkspace: checkpoint.preserve });
  const internal = f.internal as unknown as { reapIdleCompletedSessions(idleMs: number): Promise<number> };
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let reaping: Promise<number> | undefined;
  try {
    reaping = internal.reapIdleCompletedSessions(1_000);
    await checkpoint.started;
    const outcome = f.internal.takeOverCompletedChannel(work(next), next, current)
      .then(() => null, (error: unknown) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_WAIT_MS);
    expect(await outcome).toMatchObject({ code: "recovery_required", diagnostic: "predecessor_recovery_unqualified" });
    const stalled = f.warn.mock.calls.filter(([fields]) => fields?.event === "execution.deliberate_release_stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]![0]).toMatchObject({ diagnostic: "deliberate_release_stalled", channelId: "session:session" });
  } finally {
    vi.useRealTimers();
    checkpoint.release();
    await reaping;
  }
});

// D62: parallel deliveries' reviews were refused while finished sessions
// held every execution slot, each waiting out the reaper's 30 minutes.
it("frees the agent's idle completed session at once when a new session needs its slot", async () => {
  const f = await fixture();
  const internal = f.internal as unknown as { reclaimIdleCompletedSession(agentId: string): Promise<boolean> };
  // Only the same agent's slots are full; another agent's session is never released for it.
  await expect(internal.reclaimIdleCompletedSession("codex")).resolves.toBe(false);
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
  // Settled four seconds ago: well inside the reaper window, freed anyway.
  await expect(internal.reclaimIdleCompletedSession("claude-code")).resolves.toBe(true);
  expect(f.runner.releaseSealedSession).toHaveBeenCalledWith("ref");
  expect(f.journal.execution.execution(prior)).toMatchObject({ phase: "acp_settled" });
  expect(f.internal.channelOwners.has("session:session")).toBe(false);
  await expect(internal.reclaimIdleCompletedSession("claude-code")).resolves.toBe(false);
});

it("never frees a completed session whose terminal report is not yet persisted", async () => {
  const f = await fixture({ terminal: false });
  const internal = f.internal as unknown as { reclaimIdleCompletedSession(agentId: string): Promise<boolean> };
  await expect(internal.reclaimIdleCompletedSession("claude-code")).resolves.toBe(false);
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
});

/** The refusal a genuinely unexpected stop keeps, byte for byte. */
const UNEXPECTED_STOP_REFUSAL = "The previous execution stopped unexpectedly and its background work could not be confirmed stopped. This session requires recovery before retrying.";

it("explains an unqualified stopped predecessor and preserves its fence", async () => {
  const f = await fixture({ terminal: false });
  await f.journal.execution.markStopping(prior, clock.nowIso(), current);
  await f.journal.execution.markAcpSettled(prior, "ref", clock.nowIso(), current);
  const refusal = await f.internal.takeOverCompletedChannel(work(next), next, current).then(() => undefined, (error: unknown) => error);
  expect(refusal).toMatchObject({ code: "recovery_required", diagnostic: "predecessor_recovery_unqualified" });
  expect((refusal as Error).message).toBe(UNEXPECTED_STOP_REFUSAL);
  expect(f.internal.channelOwners.has("session:session")).toBe(true);
  expect(f.journal.execution.execution(next)).toBeUndefined();
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
});

it("names a predecessor stopped on purpose instead of claiming an unexpected stop", async () => {
  // The idle reaper's post-stop shape: the turn had ended and settled, Core
  // acknowledged its terminal, the process was proven gone and the ACP turn
  // settled, and the old owner still holds the session channel while the
  // deliberate release finishes.
  const f = await fixture({ acknowledged: true });
  await f.journal.execution.markStopping(prior, clock.nowIso(), current);
  await f.journal.execution.markProcessStopped(prior, clock.nowIso(), current);
  await f.journal.execution.markAcpSettled(prior, "ref", clock.nowIso(), current);
  const refusal = await f.internal.takeOverCompletedChannel(work(next), next, current).then(() => undefined, (error: unknown) => error);
  expect(refusal).toMatchObject({ code: "recovery_required", diagnostic: "predecessor_deliberate_stop_pending_release" });
  const message = (refusal as Error).message;
  expect(message).not.toContain("stopped unexpectedly");
  expect(message).not.toContain("could not be confirmed stopped");
  expect(message).toMatch(/on purpose/i);
  expect(message).toMatch(/deliberate release/i);
  expect(message).toMatch(/session channel/i);
  const blocked = f.warn.mock.calls.filter(([fields]) => fields?.event === "execution.successor_blocked");
  expect(blocked).toHaveLength(1);
  expect(blocked[0]![0]).toMatchObject({ diagnostic: "predecessor_deliberate_stop_pending_release",
    processStopped: true, terminalAcknowledged: true, pendingRecoveryEvidence: 0 });
  expect(f.internal.channelOwners.has("session:session")).toBe(true);
});

// After a connector update the QA session was
// restored for one re-check, which completed. The next re-check of the same
// kept changes failed at activation with a ZodError on every try, the idle
// reaper could not release the session either, and the review never started.
async function restoredRoleSession() {
  const journal = new SupervisorJournal(dir); await journal.load();
  const outbox = new DurableOutbox(dir); await outbox.load();
  const restored = { ...next, runnerIncarnation: "restarted-process" };
  const recheck = { ...restored, assignmentId: "recheck", claimId: "recheck-claim", executionGeneration: "recheck-generation",
    openedAt: "2026-09-06T00:00:04.000Z" };
  const second = delivery(restored, "generate-2");
  const third: RemoteWorkAssignment = { ...delivery(recheck, "generate-3", false),
    source: { ...(delivery(recheck, "generate-3", false).source as Extract<RemoteWorkAssignment["source"], { kind: "harness_delivery" }>),
      turn: { invocationId: "generate-3", dispatchGeneration: 0, predecessor: { invocationId: "generate-2", dispatchGeneration: 0 } } } };
  for (const [identity, assignment] of [[prior, delivery(prior, "generate-1")], [restored, second], [recheck, third]] as const) {
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity, assignment,
      evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt, claimCreatedAt: identity.openedAt }, current);
    await journal.execution.reserveAllocation(identity, current);
  }
  await journal.execution.open(prior, current, prior.openedAt);
  await journal.execution.bindReference(prior, "generator-ref", current);
  await journal.execution.bindProcessOwner(prior, processOwner, current);
  await journal.execution.markCompletedTurnSettled(prior, "generator-ref", "2026-09-06T00:00:01.000Z", current);
  await journal.execution.transferRestoredContinuation({ predecessor: prior, successor: restored, sessionId: "repository-generator-session",
    acpSessionRef: "generator-ref", processOwner, continuedAt: "2026-09-06T00:00:02.000Z" }, current);
  const restoredOwner = { ...processOwner, pid: 77, processGroupId: 77, startToken: "restored-start" };
  await journal.execution.bindReference(restored, "restored-ref", current);
  await journal.execution.bindProcessOwner(restored, restoredOwner, current);
  await journal.execution.markCompletedTurnSettled(restored, "restored-ref", "2026-09-06T00:00:03.000Z", current);
  await journal.assignments.put({ assignmentId: restored.assignmentId, attempt: 1, claimId: restored.claimId, kind: "delivery",
    placementId: second.placementId, workspaceId: "workspace", agentId: "claude-code", state: "running", recoveryEpoch: 0,
    reports: { nextSequence: 2, durableWatermark: 0, terminalSequence: 1 }, evidenceUpload: "structured_only",
    expiresAt: "2026-09-06T01:00:00.000Z", latestResumeAt: "2026-09-06T01:00:00.000Z", updatedAt: clock.nowIso() });
  const runner = { stopForRecovery: vi.fn(async () => undefined), releaseSealedSession: vi.fn(async () => undefined), stopRetainedExecution: vi.fn(async () => undefined) };
  const orchestrator = new WorkOrchestrator({ journal, outbox, transport: {}, clock, runners: new Map([["claude-code", runner]]),
    sessionDeps: () => ({}), onUsage: async () => undefined, instanceId: () => "instance", workspaceId: () => "workspace",
    runnerIncarnation: () => "restarted-process", assertOwned: () => undefined, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => false } as never);
  const internal = orchestrator as unknown as { channelOwners: Map<string, unknown>; sessions: Map<string, unknown>;
    reapIdleCompletedSessions(idleMs: number): Promise<number>;
    takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined> };
  const channel = "session:repository-generator-session";
  const owner = { assignment: second, acpSessionRef: "restored-ref", isClosed: true,
    releaseCompletedChannel: vi.fn(() => { internal.channelOwners.delete(channel); }) };
  internal.channelOwners.set(channel, owner);
  internal.sessions.set(`${restored.assignmentId}:1`, owner);
  return { journal, runner, internal, owner, channel, restored, recheck, third, restoredOwner };
}

it("continues a restored role session for the next re-check of the same kept changes", async () => {
  const f = await restoredRoleSession();
  await expect(f.internal.takeOverCompletedChannel(f.third, f.recheck, current)).resolves.toEqual({ reference: "restored-ref", mode: "live" });
  expect(f.journal.execution.execution(f.restored)).toMatchObject({ phase: "continued", continuedToGeneration: "recheck-generation" });
  expect(f.journal.execution.execution(f.recheck)).toMatchObject({ phase: "opened", acpSessionRef: "restored-ref",
    continuedFromGeneration: "next-generation", processOwner: f.restoredOwner });
  expect(() => f.journal.execution.assertExecutable(f.recheck, "restored-ref")).not.toThrow();
  expect(f.owner.releaseCompletedChannel).toHaveBeenCalledOnce();
  expect(f.runner.releaseSealedSession).not.toHaveBeenCalled();
});

it("lets the idle reaper release a restored role session once its turn completed", async () => {
  const f = await restoredRoleSession();
  await expect(f.internal.reapIdleCompletedSessions(1_000)).resolves.toBe(1);
  expect(f.runner.releaseSealedSession).toHaveBeenCalledWith("restored-ref");
  expect(f.journal.execution.execution(f.restored)).toMatchObject({ phase: "acp_settled", restoredFromGeneration: "prior-generation" });
  expect(f.internal.channelOwners.has(f.channel)).toBe(false);
});
