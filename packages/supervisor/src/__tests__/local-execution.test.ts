import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupervisorJournal } from "../state/journal.js";
import { LocalExecutionJournal, type LocalExecutionRecord } from "../state/local-execution.js";
import { canonicalize, RemoteWorkAssignmentSchema, type JsonValue } from "@konteks/remote-common";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "local-execution-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: "2026-09-06T00:00:00Z" };
const binding = { ...seed, instanceId: "instance", workspaceId: "workspace", exchangeNonce: "exchange" };
const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "process", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: seed.createdAt };
const cancellation = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "process", manifestId: "manifest", assignmentId: "assignment", attempt: 1, decisionDigest: "b".repeat(43), cancelledAt: seed.createdAt };
const start = { schemaVersion: 1, mandatoryOpenVersion: 1, admission, assignment: {
  id: "assignment", kind: "delivery", placementId: "placement", instanceId: "instance", workspaceId: "workspace", taskId: "task", correlationId: "correlation", attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "generator", agentId: "codex" },
  source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
}, evidenceUpload: "structured_only", projectionCreatedAt: seed.createdAt, claimCreatedAt: seed.createdAt };
async function fixture(enrolled = true) {
  const journal = new SupervisorJournal(dir); await journal.load();
  if (enrolled) { await journal.execution.seedEnrollment(seed); await journal.execution.bindEnrollment(binding); }
  return journal;
}

it("missing history is legacy_unknown, including a reopened empty root", async () => {
  const journal = await fixture(false);
  expect(journal.execution.coverage("instance", "workspace")).toBe("legacy_unknown");
  await expect(journal.execution.cancelAbsent(cancellation, () => undefined)).rejects.toThrow();
  const reopened = await fixture(false);
  expect(reopened.execution.coverage("instance", "workspace")).toBe("legacy_unknown");
});

it("loads pre-D162 delivery claims with a non-authoritative sentinel identity so the runtime can drain them", async () => {
  const journal = await fixture();
  const legacy = {
    ...start,
    assignment: {
      ...start.assignment,
      source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: "instance", executionSessionId: "legacy-session" },
    },
  };
  await journal.execution.beginAdmission(legacy, () => undefined);
  const reopened = await fixture(false);
  const restored = reopened.execution.start("assignment", 1)?.assignment;
  expect(restored?.source).toMatchObject({
    kind: "harness_delivery",
    repositoryId: "https://pre-d162.invalid/retired/assignment",
    modelBinding: { canonicalProviderId: "pre-d162", canonicalModelId: "pre-d162-unrecoverable" },
    turn: { invocationId: "correlation", dispatchGeneration: 0 },
  });
});

it("only exact bound enrollment permits absence; no claim or terminal is fabricated", async () => {
  const journal = await fixture();
  await journal.execution.cancelAbsent(cancellation, () => undefined);
  expect(journal.execution.coverage("instance", "workspace")).toBe("complete_from_enrollment");
  expect(journal.execution.coverage("instance", "other")).toBe("legacy_unknown");
  expect(journal.assignments.all()).toEqual([]);
  expect(journal.execution.tombstone(cancellation)).toEqual(cancellation);
  const reopened = await fixture(false);
  await reopened.execution.cancelAbsent(cancellation, () => undefined);
  expect(reopened.execution.tombstone(cancellation)).toEqual(cancellation);
  await expect(reopened.execution.admit(admission, () => undefined)).rejects.toThrow();
});

it("admission remains a conflict after ordinary assignment pruning or process replacement", async () => {
  const journal = await fixture();
  await journal.execution.admit(admission, () => undefined);
  await journal.assignments.clear();
  const reopened = await fixture(false);
  await expect(reopened.execution.cancelAbsent({ ...cancellation, runnerIncarnation: "successor" }, () => undefined)).rejects.toThrow();
  await expect(reopened.execution.cancelAbsent({ ...cancellation, attempt: 2 }, () => undefined)).rejects.toThrow();
  expect(reopened.execution.admission("assignment", 1)).toEqual(admission);
});

it("one serialized owner resolves concurrent admission versus absence without both winning", async () => {
  const journal = await fixture();
  const results = await Promise.allSettled([journal.execution.cancelAbsent(cancellation, () => undefined), journal.execution.admit(admission, () => undefined)]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(journal.execution.admission("assignment", 1)).toBeUndefined();
});

it("admission first prevents concurrent absence and refuses changed immutable claims", async () => {
  const journal = await fixture();
  const results = await Promise.allSettled([journal.execution.admit(admission, () => undefined), journal.execution.cancelAbsent(cancellation, () => undefined)]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  await journal.execution.admit(admission, () => undefined);
  await expect(journal.execution.admit({ ...admission, claimId: "changed" }, () => undefined)).rejects.toThrow();
});

it("owned runner/claim/bootstrap and lost ownership fail before a tombstone is durable", async () => {
  const journal = await fixture();
  await expect(journal.execution.cancelAbsent(cancellation, () => { throw new Error("owned bootstrap"); })).rejects.toThrow("owned bootstrap");
  expect(journal.execution.tombstone(cancellation)).toBeUndefined();
  await expect(journal.execution.admit(admission, () => { throw new Error("root lost"); })).rejects.toThrow("root lost");
  expect(journal.execution.admission("assignment", 1)).toBeUndefined();
});

it("rejects conflicting enrollment and manifest identity without rewriting history", async () => {
  const journal = await fixture();
  await expect(journal.execution.bindEnrollment({ ...binding, instanceId: "other" })).rejects.toThrow();
  await journal.execution.cancelAbsent(cancellation, () => undefined);
  await expect(journal.execution.cancelAbsent({ ...cancellation, decisionDigest: "c".repeat(43) }, () => undefined)).rejects.toThrow();
  await expect(journal.execution.cancelAbsent({ ...cancellation, runnerIncarnation: "other" }, () => undefined)).rejects.toThrow();
  expect(journal.execution.tombstone(cancellation)).toEqual(cancellation);
});

it("failed tombstone append cannot expose an absence result or erase prior coverage", async () => {
  let fail = false;
  const journal = new SupervisorJournal(dir, async operation => { if (fail) throw new Error("disk unavailable"); return operation(); });
  await journal.load(); await journal.execution.seedEnrollment(seed); await journal.execution.bindEnrollment(binding);
  fail = true;
  await expect(journal.execution.cancelAbsent(cancellation, () => undefined)).rejects.toThrow("disk unavailable");
  expect(journal.execution.tombstone(cancellation)).toBeUndefined();
  const reopened = await fixture(false);
  expect(reopened.execution.coverage("instance", "workspace")).toBe("complete_from_enrollment");
  expect(reopened.execution.tombstone(cancellation)).toBeUndefined();
});

it("bounded retained history refuses admission instead of evicting evidence; compaction preserves it", async () => {
  const journal = await fixture();
  const log = (journal as unknown as { executionLog: { readonly revision: number; all(): LocalExecutionRecord[]; update(key: string, derive: (record: LocalExecutionRecord | undefined) => LocalExecutionRecord): Promise<void>; compact(): Promise<void> } }).executionLog;
  const limited = new LocalExecutionJournal(log, 2);
  await limited.admit(admission, () => undefined);
  await expect(limited.admit({ ...admission, assignmentId: "other", executionGeneration: "other" }, () => undefined)).rejects.toThrow("full");
  await log.compact();
  const reopened = await fixture(false);
  expect(reopened.execution.admission("assignment", 1)).toEqual(admission);
  await expect(reopened.execution.cancelAbsent(cancellation, () => undefined)).rejects.toThrow();
});

it("hot-path admission guards use derived indexes but observe each new committed record", async () => {
  const journal = await fixture(); await journal.execution.admit(admission, () => undefined);
  const log = (journal as unknown as { executionLog: { all(): LocalExecutionRecord[] } }).executionLog;
  const read = vi.spyOn(log, "all");
  journal.execution.assertAdmission(admission); read.mockClear();
  for (let index = 0; index < 20; index += 1) journal.execution.assertAdmission(admission);
  expect(read).not.toHaveBeenCalled();
  await journal.execution.admit({ ...admission, assignmentId: "other", executionGeneration: "other" }, () => undefined);
  expect(journal.execution.admission("other", 1)).toMatchObject({ executionGeneration: "other" });
  const copy = journal.execution.admission("other", 1)!; copy.claimId = "tampered";
  expect(journal.execution.admission("other", 1)?.claimId).toBe("claim");
});

it("complete starts survive reservation, compaction and exact immutable retry without upgrading legacy", async () => {
  const journal = await fixture();
  await journal.execution.beginAdmission(start, () => undefined);
  expect(journal.execution.admission("assignment", 1)).toEqual(admission);
  expect(journal.execution.start("assignment", 1)).toEqual({ ...start, delivery: "unallocated" });
  await journal.execution.reserveAllocation(admission, () => undefined);
  await journal.execution.beginAdmission(start, () => undefined);
  await expect(journal.execution.reserveAllocation(admission, () => undefined)).rejects.toThrow();
  const log = (journal as unknown as { executionLog: { compact(): Promise<void> } }).executionLog;
  await log.compact();
  const restored = await fixture(false);
  expect(restored.execution.start("assignment", 1)).toEqual({ ...start, delivery: "allocation_reserved" });
  await expect(restored.execution.cancelAbsent(cancellation, () => undefined)).rejects.toThrow();
  const old = { ...admission, assignmentId: "old", executionGeneration: "old" };
  await restored.execution.admit(old, () => undefined);
  expect(restored.execution.start("old", 1)).toBeUndefined();
  await expect(restored.execution.beginAdmission({ ...start, admission: old, assignment: { ...start.assignment, id: "old" } }, () => undefined)).rejects.toThrow();
});

it.each(["claim", "assignment", "agent", "policy", "unknown"])("complete start rejects %s mismatch without mutation", async mismatch => {
  const journal = await fixture();
  await journal.execution.beginAdmission(start, () => undefined);
  const changed = structuredClone(start);
  if (mismatch === "claim") changed.admission.claimId = "other";
  if (mismatch === "assignment") changed.assignment.id = "other";
  if (mismatch === "agent") changed.assignment.agentRoute.agentId = "other";
  if (mismatch === "policy") changed.evidenceUpload = "selected_artifacts";
  if (mismatch === "unknown") Object.assign(changed, { bearer: "not-allowed" });
  await expect(journal.execution.beginAdmission(changed, () => undefined)).rejects.toThrow();
  expect(journal.execution.start("assignment", 1)).toEqual({ ...start, delivery: "unallocated" });
});

it("complete start byte limits include reservation growth and retained totals", async () => {
  const journal = await fixture();
  const log = (journal as unknown as { executionLog: ConstructorParameters<typeof LocalExecutionJournal>[0] }).executionLog;
  const initialBytes = Buffer.byteLength(canonicalize({ ...start, delivery: "unallocated" } as JsonValue));
  const limited = new LocalExecutionJournal(log, 50_000, { startBytes: initialBytes, totalStartBytes: initialBytes });
  await limited.beginAdmission(start, () => undefined);
  await expect(limited.reserveAllocation(admission, () => undefined)).rejects.toThrow("full");
  const second = { ...start, admission: { ...admission, assignmentId: "second", executionGeneration: "second" }, assignment: { ...start.assignment, id: "second" } };
  await expect(limited.beginAdmission(second, () => undefined)).rejects.toThrow("full");
  expect(limited.start("assignment", 1)?.delivery).toBe("unallocated");
  const oversized = { ...second, assignment: { ...second.assignment, taskId: "x".repeat(1024 * 1024) } };
  await expect(journal.execution.beginAdmission(oversized, () => undefined)).rejects.toThrow();
});

it("default one-MiB cap rejects schema-valid UTF8/escaped metadata before any admission", async () => {
  const journal = await fixture();
  const sessionConfig = Object.fromEntries(Array.from({ length: 2400 }, (_, index) => [`option-${index}`, "界\n".repeat(120)]));
  const assignment = RemoteWorkAssignmentSchema.parse({ ...start.assignment, agentRoute: { ...start.assignment.agentRoute, sessionConfig } });
  expect(Buffer.byteLength(canonicalize(assignment as JsonValue))).toBeGreaterThan(1024 * 1024);
  await expect(journal.execution.beginAdmission({ ...start, assignment }, () => undefined)).rejects.toThrow("full");
  expect(journal.execution.admission("assignment", 1)).toBeUndefined();
});

it("retained total limit refuses individually valid distinct complete starts", async () => {
  const journal = await fixture();
  const log = (journal as unknown as { executionLog: ConstructorParameters<typeof LocalExecutionJournal>[0] }).executionLog;
  const second = { ...start, admission: { ...admission, assignmentId: "second", executionGeneration: "second" }, assignment: { ...start.assignment, id: "second" } };
  const one = Buffer.byteLength(canonicalize({ ...start, delivery: "unallocated" } as JsonValue));
  const two = Buffer.byteLength(canonicalize({ ...second, delivery: "unallocated" } as JsonValue));
  const limited = new LocalExecutionJournal(log, 50_000, { startBytes: 1024 * 1024, totalStartBytes: one + two - 1 });
  await limited.beginAdmission(start, () => undefined);
  await expect(limited.beginAdmission(second, () => undefined)).rejects.toThrow("full");
  expect(limited.admission("second", 1)).toBeUndefined();
});

it("restored complete/legacy records with duplicate generation fail before guards can authorize", async () => {
  const journal = await fixture();
  await journal.execution.beginAdmission(start, () => undefined);
  const log = (journal as unknown as { executionLog: { put(value: LocalExecutionRecord): Promise<void> } }).executionLog;
  await log.put({ kind: "admission", value: { ...admission, assignmentId: "conflicting" } });
  const restored = await fixture(false);
  expect(() => restored.execution.assertAdmission(admission)).toThrow();
});

it("complete generation cannot open before claim reservation, and reserve rechecks lifecycle after fsync", async () => {
  const journal = await fixture();
  await journal.execution.beginAdmission(start, () => undefined);
  await expect(journal.execution.open(admission, () => undefined, seed.createdAt)).rejects.toThrow();
  let calls = 0;
  await expect(journal.execution.reserveAllocation(admission, () => { if (++calls === 2) throw new Error("root lost after fsync"); })).rejects.toThrow("root lost after fsync");
  expect(journal.execution.start("assignment", 1)?.delivery).toBe("allocation_reserved");
});
