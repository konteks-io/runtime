import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupervisorJournal } from "../state/journal.js";
import { AssignmentStreamJournal } from "../state/assignment-stream.js";
import type { ExecutionLog } from "../state/local-execution.js";
import { canonicalize, jcsDigest } from "@konteks/remote-common";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "assignment-stream-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const at = "2026-09-06T00:00:00Z";
const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at };
const scope = { instanceId: "instance", workspaceId: "workspace" };
const origin = { runnerIncarnation: "process", manifestId: "manifest" };
const admission = { ...scope, runnerIncarnation: "process", assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: at };
const start = { schemaVersion: 1, mandatoryOpenVersion: 1, admission, assignment: {
  id: "assignment", kind: "delivery", placementId: "placement", ...scope, taskId: "task", correlationId: "correlation", attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "planner", agentId: "codex" },
  source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
}, evidenceUpload: "structured_only", projectionCreatedAt: at, claimCreatedAt: at };
const allocation = { admission, origin, issuedAt: at };
async function load() { const journal = new SupervisorJournal(dir); await journal.load(); return journal; }
async function fixture() {
  const journal = await load();
  const versioned = { ...seed, assignmentStreamVersion: 1 };
  await journal.execution.seedEnrollment(versioned);
  await journal.execution.bindEnrollment({ ...versioned, ...scope, exchangeNonce: "exchange" });
  await journal.execution.beginAdmission(start, () => undefined);
  return journal;
}
function rawLog(journal: SupervisorJournal) {
  return (journal as unknown as { executionLog: {
    all(): unknown[]; batch(derive: () => unknown[]): Promise<void>; compact(): Promise<void>;
  } }).executionLog;
}

it("binds positive fresh stream initialization atomically with enrollment, never from an old or empty root", async () => {
  const empty = await load();
  expect(() => empty.assignmentStream.snapshot(scope)).toThrow("recovery");
  await empty.execution.seedEnrollment(seed);
  await empty.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  expect(() => empty.assignmentStream.snapshot(scope)).toThrow("recovery");
  await expect(empty.execution.seedEnrollment({ ...seed, assignmentStreamVersion: 1 })).rejects.toThrow();
});

it("allocates original frame, highwater and exact admission link in one durable batch", async () => {
  const journal = await fixture();
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 0 });
  const saved = await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  expect(saved.frame).toEqual({ channel: "assignment", direction: "to_core", channelId: "assignment:instance", seq: 1, issuedAt: at, origin,
    body: { assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex" } });
  expect(saved.digest).toBe(jcsDigest(saved.frame));
  expect(journal.execution.start("assignment", 1)).toMatchObject({ delivery: "allocated", allocation: { requestSequence: 1, requestDigest: saved.digest, requestKind: "claim" } });
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1 });
  const last = JSON.parse((await readFile(join(dir, "local-execution.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(last.kind).toBe("journal_batch");
  expect(last.entries.map((entry: { kind: string }) => entry.kind).sort()).toEqual(["admission_start", "assignment_request", "assignment_stream"]);
  const reopened = await load();
  expect(reopened.assignmentStream.request(scope, 1)).toEqual(saved);
  expect(reopened.execution.start("assignment", 1)).toEqual(journal.execution.start("assignment", 1));
});

it("an immutable retry returns the original frame without allocating again; conflicting origin or identity refuses", async () => {
  const journal = await fixture();
  const original = await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  expect(await journal.assignmentStream.allocateClaim(allocation, () => undefined)).toEqual(original);
  await expect(journal.assignmentStream.allocateClaim({ ...allocation, origin: { ...origin, manifestId: "new" } }, () => undefined)).rejects.toThrow();
  await expect(journal.assignmentStream.allocateClaim({ ...allocation, admission: { ...admission, claimId: "other" } }, () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
});

it("reopened immutable requests survive process changes and cannot be mutated by readers", async () => {
  const journal = await fixture(); const saved = await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  const reopened = await load();
  const copy = reopened.assignmentStream.request(scope, 1)!; copy.frame.origin.runnerIncarnation = "other";
  expect(reopened.assignmentStream.request(scope, 1)).toEqual(saved);
  expect(JSON.stringify(saved)).not.toMatch(/connectionEpoch|receiptDigest|lease|proof|signature/);
  expect(() => reopened.assignmentStream.request({ ...scope, workspaceId: "other" }, 1)).toThrow();
});

it("serializes concurrent exact allocations into one immutable slot", async () => {
  const journal = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => journal.assignmentStream.allocateClaim(allocation, () => undefined)));
  expect(new Set(results.map(result => canonicalize(result as never))).size).toBe(1);
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
});

it("distinct admissions share the same instance stream across originating processes", async () => {
  const journal = await fixture();
  await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  const next = { ...admission, assignmentId: "second", claimId: "second", executionGeneration: "second", runnerIncarnation: "successor" };
  await journal.execution.beginAdmission({ ...start, admission: next, assignment: { ...start.assignment, id: "second" } }, () => undefined);
  const saved = await journal.assignmentStream.allocateClaim({ admission: next, origin: { runnerIncarnation: "successor", manifestId: "second" }, issuedAt: at }, () => undefined);
  expect(saved.frame.seq).toBe(2);
  expect(journal.assignmentStream.request(scope, 1)?.frame.origin).toEqual(origin);
});

it("a failed durable allocation cannot publish any frame or admission advancement", async () => {
  const journal = await fixture();
  const path = join(dir, "local-execution.jsonl"); await rename(path, `${path}.saved`); await mkdir(path);
  const send = vi.fn();
  await expect(journal.assignmentStream.allocateClaim(allocation, () => undefined).then(send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  expect(journal.execution.start("assignment", 1)?.delivery).toBe("unallocated");
  await rm(path, { recursive: true }); await rename(`${path}.saved`, path);
  const restored = await load(); expect(restored.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
});

it("authority movement after fsync retains the allocation but returns no send permission", async () => {
  const journal = await fixture(); let checks = 0; const send = vi.fn();
  await expect(journal.assignmentStream.allocateClaim(allocation, () => { if (++checks === 2) throw new Error("generation changed"); }).then(send)).rejects.toThrow("generation changed");
  expect(send).not.toHaveBeenCalled();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
  expect((await load()).execution.start("assignment", 1)?.delivery).toBe("allocated");
});

it("legacy allocation_reserved never becomes a fresh sequence merely because no frame exists", async () => {
  const journal = await fixture(); await journal.execution.reserveAllocation(admission, () => undefined);
  await expect(journal.assignmentStream.allocateClaim(allocation, () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  expect(journal.execution.start("assignment", 1)?.delivery).toBe("allocation_reserved");
});

it("allocation cannot enter an already opened generation", async () => {
  const journal = await fixture();
  await journal.execution.reserveAllocation(admission, () => undefined); await journal.execution.open(admission, () => undefined, at);
  await expect(journal.assignmentStream.allocateClaim(allocation, () => undefined)).rejects.toThrow();
  expect(journal.execution.execution(admission)?.phase).toBe("opened");
});

it("compaction retains coherent stream head, original request and allocated start", async () => {
  const journal = await fixture(); const saved = await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  await rawLog(journal).compact();
  const reopened = await load(); expect(reopened.assignmentStream.request(scope, 1)).toEqual(saved);
  expect(reopened.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
  expect(reopened.execution.start("assignment", 1)?.delivery).toBe("allocated");
});

it.each(["head", "request", "start", "digest", "link"])("missing or contradictory %s evidence fails closed instead of resetting", async corruption => {
  const journal = await fixture(); await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  const rows = rawLog(journal).all() as Array<{ kind: string; value: Record<string, unknown> }>;
  const remove = { head: "assignment_stream", request: "assignment_request", start: "admission_start" }[corruption as "head" | "request" | "start"];
  const changed = rows.filter(row => row.kind !== remove);
  if (corruption === "digest") changed.find(row => row.kind === "assignment_request")!.value.digest = "x".repeat(43);
  if (corruption === "link") Object.assign(changed.find(row => row.kind === "admission_start")!.value, { allocation: { requestSequence: 2, requestDigest: "x".repeat(43), requestKind: "claim" } });
  await writeFile(join(dir, "local-execution.jsonl"), changed.map(row => JSON.stringify(row)).join("\n") + "\n");
  await expect((async () => { const reopened = await load(); reopened.assignmentStream.snapshot(scope); })()).rejects.toThrow();
});

it("batch validation rejects duplicate keys and invalid later entries without partial publication", async () => {
  const journal = await fixture(); const log = rawLog(journal); const original = await readFile(join(dir, "local-execution.jsonl"), "utf8");
  const entry = log.all()[0]!;
  await expect(log.batch(() => [entry, entry])).rejects.toThrow();
  await expect(log.batch(() => [entry, { kind: "unknown", value: {} }])).rejects.toThrow();
  expect(await readFile(join(dir, "local-execution.jsonl"), "utf8")).toBe(original);
});

it("batch count and canonical UTF8 byte budgets reject valid oversized batches before append", async () => {
  const journal = await fixture(); const log = rawLog(journal);
  const original = await readFile(join(dir, "local-execution.jsonl"), "utf8");
  // Planning terminal convergence raised the shared atomic envelope limit to
  // 64. Exercise both sides of that boundary without changing byte limits.
  const admissions = Array.from({ length: 65 }, (_, index) => ({ kind: "admission", value: { ...admission, assignmentId: `other-${index}`, executionGeneration: `other-${index}` } }));
  await expect(log.batch(() => admissions)).rejects.toThrow("batch");
  const sessionConfig = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`${"界".repeat(125)}${String(index).padStart(3, "0")}`, "界".repeat(256)]));
  const starts = admissions.slice(0, 16).map(row => ({ kind: "admission_start", value: { ...start, admission: row.value,
    assignment: { ...start.assignment, id: row.value.assignmentId, agentRoute: { ...start.assignment.agentRoute, sessionConfig } }, delivery: "unallocated" } }));
  expect(Buffer.byteLength(canonicalize(starts as never))).toBeGreaterThan(4 * 1024 * 1024);
  await expect(log.batch(() => starts)).rejects.toThrow("batch");
  expect(await readFile(join(dir, "local-execution.jsonl"), "utf8")).toBe(original);
  await expect(log.batch(() => admissions.slice(0, 64))).resolves.toBeUndefined();
});

it("a torn allocation batch never restores only its stream head or admission link", async () => {
  const journal = await fixture(); const path = join(dir, "local-execution.jsonl");
  const before = await readFile(path, "utf8"); await journal.assignmentStream.allocateClaim(allocation, () => undefined);
  const appended = (await readFile(path, "utf8")).slice(before.length);
  await writeFile(path, before + appended.slice(0, -15));
  const reopened = await load();
  expect(reopened.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  expect(reopened.execution.start("assignment", 1)?.delivery).toBe("unallocated");
  expect(reopened.assignmentStream.request(scope, 1)).toBeUndefined();
});

it("allocation count pressure refuses before any retained state changes", async () => {
  const journal = await fixture();
  const owner = new AssignmentStreamJournal(rawLog(journal) as ExecutionLog, journal.execution, { maxRequests: 1, maxBytes: 16 * 1024 * 1024 });
  await owner.allocateClaim(allocation, () => undefined);
  const next = { ...admission, assignmentId: "second", claimId: "second", executionGeneration: "second" };
  await journal.execution.beginAdmission({ ...start, admission: next, assignment: { ...start.assignment, id: "second" } }, () => undefined);
  await expect(owner.allocateClaim({ ...allocation, admission: next }, () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
  expect(journal.execution.start("second", 1)?.delivery).toBe("unallocated");
});

it("allocation byte pressure refuses before any retained state changes", async () => {
  const journal = await fixture();
  const owner = new AssignmentStreamJournal(rawLog(journal) as ExecutionLog, journal.execution, { maxRequests: 1, maxBytes: 1 });
  await expect(owner.allocateClaim(allocation, () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  expect(journal.execution.start("assignment", 1)?.delivery).toBe("unallocated");
});

it("actual append fsync failure rolls back the whole allocation without partial memory or disk visibility", async () => {
  const journal = await fixture(); const path = join(dir, "local-execution.jsonl");
  const before = await readFile(path, "utf8");
  const handle = await open(path, "r"); const prototype = Object.getPrototypeOf(handle); await handle.close();
  const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fsync unavailable"));
  await expect(journal.assignmentStream.allocateClaim(allocation, () => undefined)).rejects.toThrow("fsync unavailable");
  expect(sync).toHaveBeenCalledTimes(2);
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  expect(journal.execution.start("assignment", 1)?.delivery).toBe("unallocated");
  sync.mockRestore();
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await load()).assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
});

it("allocation and legacy reservation share one lane; neither can reinterpret the other's winner", async () => {
  const journal = await fixture();
  const results = await Promise.allSettled([journal.execution.reserveAllocation(admission, () => undefined), journal.assignmentStream.allocateClaim(allocation, () => undefined)]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
  expect(journal.execution.start("assignment", 1)?.delivery).toBe("allocation_reserved");
});

it("allocation and mandatory execution-open share one serialization owner", async () => {
  const journal = await fixture();
  const results = await Promise.allSettled([journal.execution.open(admission, () => undefined, at), journal.assignmentStream.allocateClaim(allocation, () => undefined)]);
  expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
  expect(journal.execution.execution(admission)).toBeUndefined();
  expect(journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
});

it("counter exhaustion or a deleted stream is not zero on a new process", async () => {
  const journal = await fixture();
  const rows = rawLog(journal).all() as Array<{ kind: string; value: Record<string, unknown> }>;
  rows.find(row => row.kind === "assignment_stream")!.value.allocatedThrough = Number.MAX_SAFE_INTEGER;
  await writeFile(join(dir, "local-execution.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await expect((async () => { const restored = await load(); await restored.assignmentStream.allocateClaim(allocation, () => undefined); })()).rejects.toThrow();
});
