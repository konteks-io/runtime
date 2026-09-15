import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
const at = "2026-09-06T00:00:00.000Z";
const scope = { instanceId: "instance", workspaceId: "workspace" };
const ack = (cumulativeSeq: number) => ({ kind: "ack", origin: "core", dataDirection: "to_core", channelId: "assignment:instance", cumulativeSeq, issuedAt: at });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "assignment-ack-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function load() { const journal = new SupervisorJournal(dir); await journal.load(); return journal; }
async function fixture(count = 2) {
  const journal = await load();
  const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at, assignmentStreamVersion: 1 };
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  for (let i = 0; i < count; i++) await journal.assignmentStream.allocateOperation({ ...scope, runnerIncarnation: "process", operationId: `operation-${i}`, kind: "report",
    origin: { runnerIncarnation: "process", manifestId: "manifest" }, issuedAt: at,
    report: { reportId: `report-${i}`, key: `report:assignment:1:claim:${i + 1}`, group: "report:assignment:1:claim", order: i + 1 },
    body: { assignmentId: "assignment", attempt: 1, claimId: "claim", reportId: `report-${i}`, reportSequence: i + 1,
      payloadDigest: "a".repeat(43), terminal: false, reportedAt: at } }, () => undefined);
  return journal;
}

it("durably observes only the explicit Core prefix, monotonically, without retiring or consuming replies", async () => {
  const journal = await fixture();
  await journal.assignmentStream.observeCoreRequestAck(scope, ack(2), () => undefined);
  await journal.assignmentStream.observeCoreRequestAck(scope, ack(1), () => undefined);
  const reopened = await load();
  expect(reopened.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 2, observedCoreRequestAckSequence: 2,
    retiredThroughRequestSequence: 0, nativeConsumedReplySequence: 0 });
  expect(reopened.assignmentStream.request(scope, 1)).toBeDefined();
});

it.each([{ cumulativeSeq: 3 }, { cumulativeSeq: -1 }, { cumulativeSeq: Number.MAX_SAFE_INTEGER + 1 }, { channelId: "assignment:other" },
  { origin: "runtime" }, { dataDirection: "to_runtime" }, { kind: "data" }])("refuses an invalid or impossible ACK %j", async patch => {
  const journal = await fixture();
  await expect(journal.assignmentStream.observeCoreRequestAck(scope, { ...ack(1), ...patch }, () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(0);
});

it("permits zero-request ACK housekeeping without allocating a request", async () => {
  const journal = await fixture(0);
  await journal.assignmentStream.observeCoreRequestAck(scope, ack(0), () => undefined);
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 0, observedCoreRequestAckSequence: 0 });
});

it("refuses stale authority before commit and surfaces authority loss across fsync", async () => {
  const journal = await fixture();
  await expect(journal.assignmentStream.observeCoreRequestAck(scope, ack(1), () => { throw new Error("fenced"); })).rejects.toThrow("fenced");
  expect(journal.assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(0);
  const handle = await open(join(dir, "local-execution.jsonl"), "r");
  const prototype = Object.getPrototypeOf(handle); await handle.close();
  const original = prototype.sync;
  let active = true;
  vi.spyOn(prototype, "sync").mockImplementationOnce(async function (this: unknown) {
    await original.call(this); active = false;
  });
  await expect(journal.assignmentStream.observeCoreRequestAck(scope, ack(1), () => { if (!active) throw new Error("fenced"); })).rejects.toThrow("fenced");
  // The completed durable historical observation is retained, but the old
  // continuation did not return as authorized in the successor generation.
  expect((await load()).assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(1);
});

it("does not advance observation when the real fsync fails", async () => {
  const journal = await fixture(); const path = join(dir, "local-execution.jsonl");
  const before = await readFile(path, "utf8"), handle = await open(path, "r"), prototype = Object.getPrototypeOf(handle); await handle.close();
  vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fsync failed"));
  await expect(journal.assignmentStream.observeCoreRequestAck(scope, ack(1), () => undefined)).rejects.toThrow("fsync failed");
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await load()).assignmentStream.snapshot(scope).observedCoreRequestAckSequence).toBe(0);
});
