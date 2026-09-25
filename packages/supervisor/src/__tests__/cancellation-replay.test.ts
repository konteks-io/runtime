import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SupervisorJournal } from "../state/journal.js";
import { CancellationReplay } from "../control/cancellation-replay.js";
import type { CancelDirective } from "@konteks/remote-common";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cancellation-replay-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const now = "2026-09-10T00:00:00.000Z";
const conversation = { kind: "assistant_execution" as const, agentRoute: { requiredRole: "assistant" as const, agentId: "codex" },
  source: { kind: "conversation" as const, portability: "portable_before_claim" as const, sessionId: "session", turnRef: "turn" } };
// A repository-role delivery turn (WS2-159): Core owns its cleanup.
const delivery = { kind: "validation" as const, agentRoute: { requiredRole: "qa" as const, agentId: "codex" },
  source: { kind: "harness_delivery" as const, portability: "instance_bound" as const, ownerInstanceId: "instance",
    executionSessionId: "session", repositoryId: "https://git.example.com/acme/store",
    modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model" }, turn: { invocationId: "qa-run", dispatchGeneration: 0 } } };
async function fixture(count = 1, work: typeof conversation | typeof delivery = conversation) {
  const journal = new SupervisorJournal(dir); await journal.load();
  const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: now };
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, instanceId: "instance", workspaceId: "tenant", exchangeNonce: "exchange" });
  for (let n = 0; n < count; n++) {
    const assignmentId = `assignment-${n}`, claimId = `claim-${n}`;
    await journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1,
      admission: { instanceId: "instance", workspaceId: "tenant", runnerIncarnation: "runner", assignmentId,
        attempt: 1, claimId, agentId: "codex", executionGeneration: `generation-${n}`, openedAt: now },
      assignment: { id: assignmentId, kind: work.kind, placementId: "placement", instanceId: "instance", workspaceId: "tenant",
        taskId: "turn", correlationId: work.source.kind === "harness_delivery" ? work.source.turn.invocationId : "correlation", attempt: 1, expiresAt: "2026-09-10T01:00:00.000Z", requiredCapabilities: [],
        agentRoute: work.agentRoute, source: work.source,
        policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [],
          recoveryMode: "report_interrupted", latestResumeAt: "2026-09-10T01:00:00.000Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true } },
      evidenceUpload: "structured_only", projectionCreatedAt: now, claimCreatedAt: now }, () => {});
    await journal.assignments.put({ assignmentId, attempt: 1, claimId, kind: work.kind, placementId: "placement",
      workspaceId: "tenant", agentId: "codex", state: "running", recoveryEpoch: 0,
      expiresAt: "2026-09-10T01:00:00.000Z", latestResumeAt: "2026-09-10T01:00:00.000Z",
      reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", updatedAt: now });
    await journal.cancellations.receiveVerified({ intentId: `intent-${n}`, tenantId: "tenant", instanceId: "instance", sessionId: "session",
      claimId, delegationRef: "delegation", directive: { assignmentId, attempt: 1, reason: work === delivery ? "superseded" : "policy_denied",
        issuedAt: now, signature: "AA" } }, now, () => {});
  }
  const owner = { instanceId: "instance", workspaceId: "tenant", runnerIncarnation: "runner", assertCurrent: vi.fn() };
  const stop = vi.fn<(id: string, attempt: number) => Promise<void>>(async () => { throw new Error("Qualified quiescence unavailable"); });
  const cancelDelivery = vi.fn<(directive: CancelDirective) => Promise<void>>(async () => undefined);
  const replay = new CancellationReplay({ journal, owner: () => ({ ...owner }), stopForRecovery: stop, cancelDelivery });
  return { journal, owner, stop, cancelDelivery, replay };
}

it("cancels a claimed, unprompted delivery turn through its signed cancel instead of a recovery fence (WS2-159)", async () => {
  const f = await fixture(1, delivery);
  f.replay.tick(); await f.replay.settle();
  expect(f.cancelDelivery).toHaveBeenCalledOnce();
  expect(f.cancelDelivery.mock.calls[0]![0]).toMatchObject({ assignmentId: "assignment-0", attempt: 1, reason: "superseded" });
  expect(f.stop).not.toHaveBeenCalled();
  // Retained until the terminal report exists; then nothing is left to do.
  f.replay.tick(); await f.replay.settle(); expect(f.cancelDelivery).toHaveBeenCalledTimes(2);
  const entry = f.journal.assignments.get("assignment-0:1")!;
  await f.journal.assignments.put({ ...entry, reports: { ...entry.reports, terminalSequence: 1 } });
  f.replay.tick(); await f.replay.settle(); expect(f.cancelDelivery).toHaveBeenCalledTimes(2);
  expect(f.journal.cancellations.pending()).toHaveLength(1);
});

it("refuses a delivery cancellation that names another role session", async () => {
  const f = await fixture(1, { ...delivery, source: { ...delivery.source, executionSessionId: "other-session" } });
  f.replay.tick(); await f.replay.settle();
  expect(f.cancelDelivery).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
});

it("replays durable records after restart into the exact stop owner without inventing completion", async () => {
  const f = await fixture(); const restarted = new SupervisorJournal(dir); await restarted.load();
  const replay = new CancellationReplay({ journal: restarted, owner: () => ({ ...f.owner }), stopForRecovery: f.stop });
  replay.tick(); expect(f.stop).toHaveBeenCalledWith("assignment-0", 1); await replay.settle();
  expect(restarted.cancellations.pending()).toEqual(f.journal.cancellations.pending());
  expect(restarted.assignments.get("assignment-0:1")?.reports.terminalSequence).toBeUndefined();
});

it("coalesces duplicate notifications while a stop is pending and retains failure for another pass", async () => {
  const f = await fixture(); const pending = Promise.withResolvers<void>();
  f.stop.mockImplementationOnce(() => pending.promise);
  const record = f.journal.cancellations.pending()[0]!;
  f.replay.notify(record); f.replay.notify(record); f.replay.tick(); expect(f.stop).toHaveBeenCalledOnce();
  pending.reject(new Error("uncertain")); await f.replay.settle();
  f.replay.tick(); await f.replay.settle(); expect(f.stop).toHaveBeenCalledTimes(2);
  expect(f.journal.cancellations.pending()).toEqual([record]);
});

it.each(["runnerIncarnation", "workspaceId", "instanceId"] as const)("does not fence another current %s", async field => {
  const f = await fixture(); f.owner[field] = "foreign";
  f.replay.tick(); await f.replay.settle(); expect(f.stop).not.toHaveBeenCalled();
});

it("refuses a replacement claim and missing or changed durable record before the synchronous fence", async () => {
  const f = await fixture(); const record = f.journal.cancellations.pending()[0]!;
  f.replay.notify({ ...record, receivedAt: "2026-09-10T00:00:01.000Z" });
  await f.journal.assignments.put({ ...f.journal.assignments.get("assignment-0:1")!, claimId: "replacement" });
  f.replay.notify(record); expect(f.stop).not.toHaveBeenCalled();
});

it("bounds active stops and rotates past unavailable historical owners", async () => {
  const f = await fixture(10); const pending = Promise.withResolvers<void>();
  f.stop.mockImplementation(() => pending.promise);
  f.replay.tick(); expect(f.stop).toHaveBeenCalledTimes(8);
  f.replay.tick(); expect(f.stop).toHaveBeenCalledTimes(8);
  pending.resolve(); await f.replay.settle();
  f.replay.tick(); await f.replay.settle();
  expect(new Set(f.stop.mock.calls.map(call => call[0])).size).toBe(10);
  expect(f.journal.cancellations.pending()).toHaveLength(10);
});

it("does not interpret successful callback completion as quiescence or resume after shutdown", async () => {
  const f = await fixture(); f.stop.mockResolvedValue(undefined);
  f.replay.tick(); await f.replay.stop(); f.replay.tick(); f.replay.notify(f.journal.cancellations.pending()[0]!);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.journal.cancellations.pending()).toHaveLength(1);
  expect(() => f.journal.execution.assertQuiescent(f.journal.execution.admission("assignment-0", 1)!)).toThrow();
});
