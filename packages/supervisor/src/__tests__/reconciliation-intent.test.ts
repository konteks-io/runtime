import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, computeAgentModelOfferedValuesSnapshotDigest } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { Reconciliation, type ReconciliationDeps } from "../reconnect/reconciliation.js";
import type { CoreClient } from "../core/client.js";
import type { ReportSender } from "../work/report-sender.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "recovery-intent-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  let owned = true;
  let allocated = 7;
  const resolve = vi.fn(async () => ({ instanceId: "instance", ownerRevision: 4, currentIncarnation: "predecessor", acceptedHeartbeatSequence: 8, heartbeatSequenceFloor: 10 }));
  const reconnect = vi.fn<CoreClient["reconnect"]>(async () => { throw new RemoteInstanceError("temporarily_unavailable", "lost response"); });
  const modelSnapshotBody = { version: 1 as const, snapshotId: "snapshot", snapshotRevision: 1, instanceId: "instance", agentId: "claude-code", authIdentityFingerprint: "identity-a", runnerIncarnation: "process", manifestId: "manifest", mappingId: "mapping", mappingRevision: 1, mappingDigest: "B".repeat(43), configId: "model", currentValue: "sonnet", offeredValues: ["sonnet"], observedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-06T00:05:00Z" };
  const deps: ReconciliationDeps = {
    clock: new FixedClock(Date.parse("2026-09-06T00:00:00Z")), journal,
    core: { resolveRuntimeOwner: resolve, reconnect } as unknown as CoreClient,
    instanceId: () => "instance", runnerIncarnation: () => "process",
    modelCapabilitySnapshots: () => [{ ...modelSnapshotBody, snapshotDigest: computeAgentModelOfferedValuesSnapshotDigest(modelSnapshotBody) }],
    assertOwned: () => { if (!owned) throw new Error("ownership lost"); },
    bundleVersion: "1.0.0", protocolVersion: "1.0", lastHeartbeatSequence: async () => allocated,
    reserveHeartbeatFloor: async () => undefined,
    components: {}, stopLocalWork: async () => undefined, reports: {} as ReportSender, onLease: async () => undefined,
  };
  return { journal, deps, resolve, reconnect, recovery: new Reconciliation(deps), loseOwnership: () => { owned = false; }, allocate: () => { allocated = 99; } };
}

it("persists the exact process/CAS snapshot before returning the request", async () => {
  const f = await fixture();
  const request = await f.recovery.buildRequest();
  expect(request).toMatchObject({ instanceId: "instance", runnerIncarnation: "process", establishment: { expectedOwnerRevision: 4, expectedCurrentIncarnation: "predecessor" }, lastHeartbeatSequence: 7, connection: { kind: "https" }, modelCapabilitySnapshots: [{ snapshotId: "snapshot" }] });
  expect(request.reconnectIntentId).toBeTruthy();
  const disk = new SupervisorJournal(dir);
  await disk.load();
  const { connection: _connection, ...snapshot } = request;
  expect(disk.recovery.current("instance", "process")?.intent).toEqual(snapshot);
  expect(f.recovery.isComplete).toBe(false);
});

it("sorts retained ordinary claims before validating and persisting recovery", async () => {
  const f = await fixture();
  for (const [assignmentId, attempt] of [["z", 1], ["a", 2], ["a", 1]] as const) {
    await f.journal.assignments.put({ assignmentId, attempt, claimId: `claim-${assignmentId}-${attempt}`, kind: "assistant_execution", placementId: "p", workspaceId: "w", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: "2026-09-06T02:00:00Z", latestResumeAt: "2026-09-06T02:00:00Z", updatedAt: f.deps.clock.nowIso() });
  }
  const request = await f.recovery.buildRequest();
  expect(request.claims.map(({ assignmentId, attempt }) => `${assignmentId}:${attempt}`)).toEqual(["a:1", "a:2", "z:1"]);
  expect(f.journal.recovery.current("instance", "process")?.intent.claims).toEqual(request.claims);
});

it("same-process reload and allocation changes retain the original immutable intent", async () => {
  const f = await fixture();
  const original = await f.recovery.buildRequest();
  f.allocate();
  const disk = new SupervisorJournal(dir);
  await disk.load();
  const retry = new Reconciliation({ ...f.deps, journal: disk });
  expect(await retry.buildRequest()).toEqual(original);
  expect(f.resolve).toHaveBeenCalledTimes(1);
});

it("concurrent preparation returns one durable intent, not competing CAS requests", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.recovery.buildRequest(), f.recovery.buildRequest()]);
  expect(a).toEqual(b);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.journal.recovery.current("instance", "process")?.intent.reconnectIntentId).toBe(a.reconnectIntentId);
});

it("uncertain reconnect retries exactly the durable request", async () => {
  const f = await fixture();
  await expect(f.recovery.run()).rejects.toMatchObject({ code: "temporarily_unavailable" });
  f.allocate();
  await expect(f.recovery.run()).rejects.toMatchObject({ code: "temporarily_unavailable" });
  expect(f.reconnect.mock.calls[1]).toEqual(f.reconnect.mock.calls[0]);
  expect(f.journal.recovery.current("instance", "process")?.state).toBe("pending");
});

it("lost ownership after resolution cannot persist or transmit an intent", async () => {
  const f = await fixture();
  f.resolve.mockImplementationOnce(async () => { f.loseOwnership(); return { instanceId: "instance", ownerRevision: 4, currentIncarnation: "predecessor", acceptedHeartbeatSequence: 8, heartbeatSequenceFloor: 10 }; });
  await expect(f.recovery.buildRequest()).rejects.toThrow("ownership lost");
  expect(f.journal.recovery.current("instance", "process")).toBeUndefined();
  expect(f.reconnect).not.toHaveBeenCalled();
});

it("failed snapshot persistence cannot transmit a reconnect", async () => {
  const f = await fixture();
  vi.spyOn(f.journal.recovery, "prepareIntent").mockRejectedValueOnce(new Error("disk failed"));
  await expect(f.recovery.run()).rejects.toThrow("disk failed");
  expect(f.reconnect).not.toHaveBeenCalled();
});

it("binds the returned manifest and persists its floor before lease adoption", async () => {
  const f = await fixture();
  const order: string[] = [];
  f.reconnect.mockImplementation(async request => ({ lease: "lease", leaseExpiresAt: "2026-09-06T01:00:00Z", manifest: {
    instanceId: request.instanceId, runnerIncarnation: request.runnerIncarnation, reconnectIntentId: request.reconnectIntentId,
    manifestId: "manifest", ownerRevision: 5, issuedAt: "2026-09-06T00:00:00Z", applyDeadlineAt: "2026-09-06T01:00:00Z",
    acceptedHeartbeatSequence: 10, heartbeatSequenceFloor: 12, lease: "lease", decisions: [], pendingClaimDecisions: [],
  } }));
  f.deps.reserveHeartbeatFloor = async floor => {
    expect(floor).toBe(12);
    const disk = new SupervisorJournal(dir);
    await disk.load();
    expect(disk.recovery.current("instance", "process")?.manifest?.manifestId).toBe("manifest");
    order.push("floor");
  };
  f.deps.onLease = async () => { order.push("lease"); throw new Error("stop after adoption check"); };
  await expect(f.recovery.run()).rejects.toThrow("stop after adoption check");
  expect(order).toEqual(["floor", "lease"]);
  expect(f.recovery.isComplete).toBe(false);
});

it("a different process creates its own intent without inheriting the predecessor snapshot", async () => {
  const f = await fixture();
  const before = await f.recovery.buildRequest();
  const next = new Reconciliation({ ...f.deps, runnerIncarnation: () => "next-process", modelCapabilitySnapshots: () => [] });
  const after = await next.buildRequest();
  expect(after.runnerIncarnation).toBe("next-process");
  expect(after.reconnectIntentId).not.toBe(before.reconnectIntentId);
  expect(f.journal.recovery.current("instance", "process")?.intent.reconnectIntentId).toBe(before.reconnectIntentId);
});

it.each([["conflict", "establishment_conflict"], ["resume_deadline_expired", "expired"], ["reconciliation_replay", "superseded"]] as const)("persists explicit %s before allowing any later generation", async (code, state) => {
  const f = await fixture();
  f.reconnect.mockRejectedValueOnce(new RemoteInstanceError(code, "explicit owner denial"));
  await expect(f.recovery.run()).rejects.toMatchObject({ code });
  expect(f.journal.recovery.current("instance", "process")?.state).toBe(state);
  await expect(f.recovery.buildRequest()).rejects.toMatchObject({ code: "reconciliation_replay" });
  expect(f.resolve).toHaveBeenCalledTimes(1);
});
