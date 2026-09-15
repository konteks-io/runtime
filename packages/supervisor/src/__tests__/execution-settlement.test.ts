import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "process", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: "2026-09-06T00:00:00.000Z" };
const now = "2026-09-06T00:00:01.000Z";
const current = () => undefined;
const processOwner = { version: 1 as const, platform: "darwin" as const, pid: 42, processGroupId: 42,
  startToken: "start-token", commandDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const assignment = (identity: typeof admission, sessionId: string, acpSessionRef?: string): RemoteWorkAssignment => ({
  id: identity.assignmentId, kind: "assistant_execution", placementId: `placement-${identity.assignmentId}`,
  instanceId: identity.instanceId, workspaceId: identity.workspaceId, taskId: `task-${identity.assignmentId}`,
  correlationId: `correlation-${identity.assignmentId}`, attempt: identity.attempt,
  expiresAt: "2026-09-06T01:00:00.000Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "assistant", agentId: identity.agentId },
  source: { kind: "conversation", portability: "portable_before_claim", sessionId,
    turnRef: `turn-${identity.assignmentId}`, ...(acpSessionRef ? { acpSessionRef } : {}) },
  policy: { maxDurationSeconds: 3600, maxArtifactBytes: 0, evidenceUpload: "structured_only",
    allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-06T01:00:00.000Z",
    permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
});
const delivery = (
  identity: typeof admission,
  turn: { invocationId: string; dispatchGeneration: number; predecessor?: { invocationId: string; dispatchGeneration: number } },
  options: { executionSessionId?: string; role?: "generator" | "qa"; model?: string } = {},
): RemoteWorkAssignment => {
  const role = options.role ?? "generator";
  return {
    id: identity.assignmentId,
    kind: role === "generator" ? "delivery" : "validation",
    placementId: `placement-${identity.assignmentId}`,
    instanceId: identity.instanceId,
    workspaceId: identity.workspaceId,
    taskId: "repository-task",
    correlationId: turn.invocationId,
    attempt: identity.attempt,
    expiresAt: "2026-09-06T01:00:00.000Z",
    requiredCapabilities: [],
    agentRoute: {
      requiredRole: role,
      agentId: identity.agentId,
      sessionConfig: { model: options.model ?? "claude-sonnet" },
    },
    source: {
      kind: "harness_delivery",
      portability: "instance_bound",
      ownerInstanceId: identity.instanceId,
      executionSessionId: options.executionSessionId ?? "repository-generator-session",
      repositoryId: "https://git.example.com/org/repository",
      modelBinding: { canonicalProviderId: "anthropic", canonicalModelId: options.model ?? "claude-sonnet" },
      turn,
    },
    policy: {
      maxDurationSeconds: 3600,
      maxArtifactBytes: 0,
      evidenceUpload: "structured_only",
      allowedArtifactKinds: [],
      recoveryMode: "report_interrupted",
      latestResumeAt: "2026-09-06T01:00:00.000Z",
      permissionResponderDeadlineSeconds: 60,
      humanDeferralAllowed: true,
    },
  };
};
const begin = async (journal: SupervisorJournal, identity: typeof admission, work: RemoteWorkAssignment) => {
  await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: identity,
    assignment: work, evidenceUpload: "structured_only", projectionCreatedAt: identity.openedAt,
    claimCreatedAt: identity.openedAt }, current);
  await journal.execution.reserveAllocation(identity, current);
};
it("retains a durable completed-turn receipt without releasing ownership or certifying quiescence", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.execution.admit(admission, current);
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "ref", current);
  await expect(journal.execution.markCompletedTurnSettled(admission, "wrong", now, current)).rejects.toThrow();
  await journal.execution.markCompletedTurnSettled(admission, "ref", now, current);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.execution.execution(admission)).toMatchObject({ completedTurnSettledAt: now, phase: "opened", referenceFence: "generation", lifecycleProfileDigest: null });
  expect(() => reopened.execution.assertQuiescent(admission)).toThrow();
  const other = { ...admission, assignmentId: "other", claimId: "other", executionGeneration: "other" };
  await reopened.execution.admit(other, current); await reopened.execution.open(other, current, now);
  await expect(reopened.execution.bindReference(other, "ref", current)).rejects.toThrow();
});
it("keeps completed-turn receipt absent after a failed durable write", async () => {
  let fail = false;
  const journal = new SupervisorJournal(dir, async operation => { if (fail) throw new Error("disk unavailable"); return operation(); });
  await journal.load(); await journal.execution.admit(admission, current);
  await journal.execution.open(admission, current, admission.openedAt); await journal.execution.bindReference(admission, "ref", current);
  fail = true;
  await expect(journal.execution.markCompletedTurnSettled(admission, "ref", now, current)).rejects.toThrow("disk unavailable");
  expect(journal.execution.execution(admission)?.completedTurnSettledAt).toBeUndefined();
  fail = false;
  await journal.execution.markCompletedTurnSettled(admission, "ref", now, current);
  await journal.execution.markCompletedTurnSettled(admission, "ref", "2026-09-06T00:00:02.000Z", current);
  expect(journal.execution.execution(admission)?.completedTurnSettledAt).toBe(now);
});

it("atomically replaces only the exact pre-ready bootstrap process owner", async () => {
  const replacement = { ...processOwner, pid: 43, processGroupId: 43, startToken: "replacement-start" };
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.execution.admit(admission, current);
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);

  await journal.execution.replaceBootstrapProcessOwner(admission, processOwner, replacement, current);
  expect(journal.execution.execution(admission)?.processOwner).toEqual(replacement);
  await expect(journal.execution.replaceBootstrapProcessOwner(admission, processOwner, { ...replacement, pid: 44 }, current)).rejects.toThrow();

  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.execution.execution(admission)?.processOwner).toEqual(replacement);
  await reopened.execution.markCompletedTurnSettled(admission, "ref", now, current);
  await expect(reopened.execution.replaceBootstrapProcessOwner(admission, replacement, processOwner, current)).rejects.toThrow();
});

it("continues a predecessor that was admitted with a stale reference but opened fresh", async () => {
  // The predecessor asked to continue a session that was not live here, so it
  // opened a FRESH reference. Its successor continues the reference it opened,
  // not the one it asked for; the request must not make that unprovable.
  const journal = new SupervisorJournal(dir); await journal.load();
  const successor = { ...admission, assignmentId: "successor", claimId: "successor-claim", executionGeneration: "successor-generation", openedAt: now };
  await begin(journal, admission, assignment(admission, "session", "stale-ref"));
  await begin(journal, successor, assignment(successor, "session", "ref"));
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);
  await journal.execution.markCompletedTurnSettled(admission, "ref", now, current);

  await journal.execution.transferLiveContinuation({ predecessor: admission, successor, sessionId: "session",
    acpSessionRef: "ref", processOwner, continuedAt: "2026-09-06T00:00:02.000Z" }, current);

  expect(journal.execution.execution(admission)).toMatchObject({ phase: "continued", continuedToGeneration: successor.executionGeneration });
  expect(journal.execution.execution(successor)).toMatchObject({ phase: "opened", acpSessionRef: "ref", continuedFromGeneration: admission.executionGeneration });
});

it("atomically transfers one live completed conversation reference to its exact successor", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const successor = { ...admission, assignmentId: "successor", claimId: "successor-claim", executionGeneration: "successor-generation", openedAt: now };
  await begin(journal, admission, assignment(admission, "session"));
  await begin(journal, successor, assignment(successor, "session", "ref"));
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);
  await journal.execution.markCompletedTurnSettled(admission, "ref", now, current);

  await journal.execution.transferLiveContinuation({ predecessor: admission, successor, sessionId: "session",
    acpSessionRef: "ref", processOwner, continuedAt: "2026-09-06T00:00:02.000Z" }, current);

  expect(() => journal.execution.assertExecutable(admission, "ref")).toThrow();
  expect(journal.execution.execution(admission)).toMatchObject({ phase: "continued", referenceFence: null,
    continuedToGeneration: successor.executionGeneration, continuedAt: "2026-09-06T00:00:02.000Z" });
  expect(journal.execution.execution(successor)).toMatchObject({ phase: "opened", acpSessionRef: "ref",
    referenceFence: successor.executionGeneration, continuedFromGeneration: admission.executionGeneration, processOwner });
  expect(() => journal.execution.assertExecutable(successor, "ref")).not.toThrow();

  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(() => reopened.execution.assertExecutable(admission, "ref")).toThrow();
  expect(() => reopened.execution.assertExecutable(successor, "ref")).not.toThrow();
});

it("reuses one durable generator ACP session across correction turns and discovers it after restart", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const successor = { ...admission, assignmentId: "correction", claimId: "correction-claim", executionGeneration: "correction-generation", openedAt: now };
  const first = delivery(admission, { invocationId: "generate-1", dispatchGeneration: 0 });
  const correction = delivery(successor, { invocationId: "generate-2", dispatchGeneration: 0,
    predecessor: { invocationId: "generate-1", dispatchGeneration: 0 } });
  await begin(journal, admission, first);
  await begin(journal, successor, correction);
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "generator-ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);
  await journal.execution.markCompletedTurnSettled(admission, "generator-ref", now, current);
  await expect(journal.execution.markCompletedTurnSettled(admission, "generator-ref", now, current)).resolves.toBeUndefined();

  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.execution.liveContinuation(correction)).toEqual({
    admission,
    acpSessionRef: "generator-ref",
    processOwner,
  });
  await reopened.execution.transferLiveContinuation({
    predecessor: admission,
    successor,
    sessionId: "repository-generator-session",
    acpSessionRef: "generator-ref",
    processOwner,
    continuedAt: "2026-09-06T00:00:02.000Z",
  }, current);
  expect(() => reopened.execution.assertExecutable(successor, "generator-ref")).not.toThrow();
});

it("never opens a fresh Harness session when declared predecessor evidence is absent", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const successor = { ...admission, assignmentId: "correction", claimId: "correction-claim",
    executionGeneration: "correction-generation" };
  const correction = delivery(successor, { invocationId: "generate-2", dispatchGeneration: 0,
    predecessor: { invocationId: "generate-1", dispatchGeneration: 0 } });
  await begin(journal, successor, correction);
  expect(() => journal.execution.liveContinuation(correction)).toThrow();
});

it("makes cross-incarnation restore succession durable and exactly retryable before provider load", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const successor = { ...admission, runnerIncarnation: "restarted-process", assignmentId: "correction",
    claimId: "correction-claim", executionGeneration: "correction-generation", openedAt: now };
  const first = delivery(admission, { invocationId: "generate-1", dispatchGeneration: 0 });
  const correction = delivery(successor, { invocationId: "generate-2", dispatchGeneration: 0,
    predecessor: { invocationId: "generate-1", dispatchGeneration: 0 } });
  await begin(journal, admission, first); await begin(journal, successor, correction);
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "generator-ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);
  await journal.execution.markCompletedTurnSettled(admission, "generator-ref", now, current);
  const proof = { predecessor: admission, successor, sessionId: "repository-generator-session",
    acpSessionRef: "generator-ref", processOwner, continuedAt: "2026-09-06T00:00:02.000Z" };

  await journal.execution.transferRestoredContinuation(proof, current);
  await expect(journal.execution.transferRestoredContinuation(proof, current)).resolves.toBeUndefined();
  expect(journal.execution.pendingRestore(successor, correction)).toBe("generator-ref");
  await journal.execution.bindReference(successor, "restored-ref", current);
  expect(journal.execution.pendingRestore(successor, correction)).toBeUndefined();
});

it("never substitutes a persistent delivery session across role, agent, model, or stable session identity", async () => {
  for (const change of ["role", "agent", "model", "session", "duplicate-turn"] as const) {
    const scopedDir = join(dir, `delivery-${change}`); await mkdir(scopedDir);
    const scoped = new SupervisorJournal(scopedDir); await scoped.load();
    const successor = {
      ...admission,
      assignmentId: `successor-${change}`,
      claimId: `claim-${change}`,
      executionGeneration: `generation-${change}`,
      openedAt: now,
      ...(change === "agent" ? { agentId: "other-agent" } : {}),
    };
    const first = delivery(admission, { invocationId: "generate-1", dispatchGeneration: 0 });
    const nextWork = delivery(
      successor,
      change === "duplicate-turn"
        ? { invocationId: "generate-1", dispatchGeneration: 0 }
        : { invocationId: "generate-2", dispatchGeneration: 0,
          predecessor: { invocationId: "generate-1", dispatchGeneration: 0 } },
      {
        ...(change === "role" ? { role: "qa" as const, executionSessionId: "repository-generator-session" } : {}),
        ...(change === "model" ? { model: "different-model" } : {}),
        ...(change === "session" ? { executionSessionId: "different-session" } : {}),
      },
    );
    await begin(scoped, admission, first);
    await begin(scoped, successor, nextWork);
    await scoped.execution.open(admission, current, admission.openedAt);
    await scoped.execution.bindReference(admission, "generator-ref", current);
    await scoped.execution.bindProcessOwner(admission, processOwner, current);
    await scoped.execution.markCompletedTurnSettled(admission, "generator-ref", now, current);

    expect(() => scoped.execution.liveContinuation(nextWork)).toThrow();
    await expect(scoped.execution.transferLiveContinuation({
      predecessor: admission,
      successor,
      sessionId: "repository-generator-session",
      acpSessionRef: "generator-ref",
      processOwner,
      continuedAt: "2026-09-06T00:00:02.000Z",
    }, current)).rejects.toThrow();
  }
});

it("makes exact live continuation retry idempotent and rejects changed proof", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  const successor = { ...admission, assignmentId: "successor", claimId: "successor-claim", executionGeneration: "successor-generation", openedAt: now };
  await begin(journal, admission, assignment(admission, "session"));
  await begin(journal, successor, assignment(successor, "session", "ref"));
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);
  await journal.execution.markCompletedTurnSettled(admission, "ref", now, current);
  const proof = { predecessor: admission, successor, sessionId: "session", acpSessionRef: "ref", processOwner,
    continuedAt: "2026-09-06T00:00:02.000Z" };
  await journal.execution.transferLiveContinuation(proof, current);
  await expect(journal.execution.transferLiveContinuation(proof, current)).resolves.toBeUndefined();
  await expect(journal.execution.transferLiveContinuation({ ...proof, sessionId: "other" }, current)).rejects.toThrow();
  await expect(journal.execution.transferLiveContinuation({ ...proof, processOwner: { ...processOwner, pid: 43 } }, current)).rejects.toThrow();
});

it("refuses live continuation across incarnation, agent, session, reference, or unsettled predecessor", async () => {
  for (const change of ["runnerIncarnation", "agentId", "sessionId", "acpSessionRef", "unsettled"] as const) {
    const scopedDir = join(dir, change); await mkdir(scopedDir);
    const scoped = new SupervisorJournal(scopedDir); await scoped.load();
    const successor = { ...admission, assignmentId: `successor-${change}`, claimId: `claim-${change}`,
      executionGeneration: `generation-${change}`, openedAt: now,
      ...(change === "runnerIncarnation" ? { runnerIncarnation: "other-process" } : {}),
      ...(change === "agentId" ? { agentId: "claude" } : {}) };
    await begin(scoped, admission, assignment(admission, "session"));
    await begin(scoped, successor, assignment(successor, change === "sessionId" ? "other-session" : "session", change === "acpSessionRef" ? "other-ref" : "ref"));
    await scoped.execution.open(admission, current, admission.openedAt);
    await scoped.execution.bindReference(admission, "ref", current);
    await scoped.execution.bindProcessOwner(admission, processOwner, current);
    if (change !== "unsettled") await scoped.execution.markCompletedTurnSettled(admission, "ref", now, current);
    await expect(scoped.execution.transferLiveContinuation({ predecessor: admission, successor, sessionId: "session",
      acpSessionRef: "ref", processOwner, continuedAt: "2026-09-06T00:00:02.000Z" }, current)).rejects.toThrow();
    expect(scoped.execution.execution(admission)).toMatchObject({ phase: "opened", referenceFence: admission.executionGeneration });
    expect(scoped.execution.execution(successor)).toBeUndefined();
  }
});

it("publishes neither half of a live continuation when its atomic fsync fails", async () => {
  let fail = false;
  const journal = new SupervisorJournal(dir, async operation => { if (fail) throw new Error("disk unavailable"); return operation(); });
  await journal.load();
  const successor = { ...admission, assignmentId: "successor", claimId: "successor-claim", executionGeneration: "successor-generation", openedAt: now };
  await begin(journal, admission, assignment(admission, "session"));
  await begin(journal, successor, assignment(successor, "session", "ref"));
  await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.bindReference(admission, "ref", current);
  await journal.execution.bindProcessOwner(admission, processOwner, current);
  await journal.execution.markCompletedTurnSettled(admission, "ref", now, current);
  fail = true;
  await expect(journal.execution.transferLiveContinuation({ predecessor: admission, successor, sessionId: "session",
    acpSessionRef: "ref", processOwner, continuedAt: "2026-09-06T00:00:02.000Z" }, current)).rejects.toThrow("disk unavailable");
  expect(journal.execution.execution(admission)).toMatchObject({ phase: "opened", referenceFence: admission.executionGeneration });
  expect(journal.execution.execution(successor)).toBeUndefined();
});
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "execution-settlement-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("persists exact opened ownership and reference before execution; never rebinds across claims", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.execution.admit(admission, current);
  await journal.execution.open(admission, current, now);
  await journal.execution.bindReference(admission, "ref", current);
  expect(journal.execution.execution(admission)).toMatchObject({ phase: "opened", openedAt: now, acpSessionRef: "ref", referenceFence: "generation", lifecycleProfileDigest: null });
  const other = { ...admission, assignmentId: "other", claimId: "other", executionGeneration: "other" };
  await journal.execution.admit(other, current); await journal.execution.open(other, current, other.openedAt);
  await expect(journal.execution.bindReference(other, "ref", current)).rejects.toThrow();
  const reopened = new SupervisorJournal(dir); await reopened.load();
  await expect(reopened.execution.bindReference(other, "ref", current)).rejects.toThrow();
  await expect(reopened.execution.bindReference(admission, "ref", current)).rejects.toThrow();
});

it("stopping fences execution and ACP settlement never authorizes D139 quiescence", async () => {
  const journal = new SupervisorJournal(dir); await journal.load(); await journal.execution.admit(admission, current);
  await journal.execution.open(admission, current, admission.openedAt); await journal.execution.bindReference(admission, "ref", current);
  await journal.execution.markStopping(admission, now, current);
  expect(() => journal.execution.assertExecutable(admission)).toThrow();
  await journal.execution.markAcpSettled(admission, "ref", now, current);
  expect(journal.execution.execution(admission)).toMatchObject({ phase: "acp_settled", stoppingAt: now, acpSettledAt: now });
  expect(() => journal.execution.assertQuiescent(admission)).toThrow();
  await expect(journal.execution.open(admission, current, admission.openedAt)).rejects.toThrow();
});

it("failed stopping and settlement writes preserve last durable state for exact retry", async () => {
  let fail = false;
  const journal = new SupervisorJournal(dir, async operation => { if (fail) throw new Error("disk unavailable"); return operation(); });
  await journal.load(); await journal.execution.admit(admission, current); await journal.execution.open(admission, current, admission.openedAt); await journal.execution.bindReference(admission, "ref", current);
  fail = true;
  await expect(journal.execution.markStopping(admission, now, current)).rejects.toThrow("disk unavailable");
  expect(journal.execution.execution(admission)?.phase).toBe("opened");
  fail = false; await journal.execution.markStopping(admission, now, current); fail = true;
  await expect(journal.execution.markAcpSettled(admission, "ref", now, current)).rejects.toThrow("disk unavailable");
  expect(journal.execution.execution(admission)?.phase).toBe("stopping");
  fail = false; await journal.execution.markAcpSettled(admission, "ref", now, current);
  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.execution.execution(admission)?.phase).toBe("acp_settled");
});

it("uncertain bootstrap without a known reference cannot claim ACP settlement", async () => {
  const journal = new SupervisorJournal(dir); await journal.load(); await journal.execution.admit(admission, current); await journal.execution.open(admission, current, admission.openedAt);
  await journal.execution.markStopping(admission, now, current);
  await expect(journal.execution.markAcpSettled(admission, "unknown", now, current)).rejects.toThrow();
  expect(journal.execution.execution(admission)?.phase).toBe("stopping");
});
