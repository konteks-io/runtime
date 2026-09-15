import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { logicalAssignmentResponseDigest } from "@konteks/remote-common";
import type { ExecutionLog } from "../state/local-execution.js";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "assignment-reply-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const at = "2026-09-06T00:00:00Z";
const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at, assignmentStreamVersion: 1 };
const scope = { instanceId: "instance", workspaceId: "workspace" };
const origin = { runnerIncarnation: "process", manifestId: "manifest" };
const admission = (id: string) => ({ ...scope, runnerIncarnation: "process", assignmentId: id, attempt: 1, claimId: `claim-${id}`, agentId: "codex", executionGeneration: `generation-${id}`, openedAt: at });
const start = (id: string) => ({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: admission(id), assignment: {
  id, kind: "delivery", placementId: "placement", ...scope, taskId: "task", correlationId: "correlation", attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "generator", agentId: "codex" },
  source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
}, evidenceUpload: "structured_only", projectionCreatedAt: at, claimCreatedAt: at });

async function load() { const journal = new SupervisorJournal(dir); await journal.load(); return journal; }
async function fixture() {
  const journal = await load();
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  return journal;
}
async function allocate(journal: SupervisorJournal, id: string) {
  await journal.execution.beginAdmission(start(id), () => undefined);
  return journal.assignmentStream.allocateClaim({ admission: admission(id), origin, issuedAt: at }, () => undefined);
}
const reply = (request: { frame: { seq: number }; digest: string }, sequence: number, body: Record<string, unknown>, patch: Record<string, unknown> = {}) => {
  const frame = { channel: "assignment", direction: "to_runtime", channelId: "assignment:instance", seq: sequence, issuedAt: at,
    body: { requestSequence: request.frame.seq, requestDigest: request.digest, requestKind: "claim", body } };
  return { schemaVersion: 2, ...scope,
  request: { requestSequence: request.frame.seq, requestDigest: request.digest, requestKind: "claim" },
  response: { sequence, digest: logicalAssignmentResponseDigest(frame) }, frame, ...patch };
};
const claimed = (id: string) => ({ assignmentId: id, attempt: 1, claimId: `claim-${id}`, outcome: "claimed" });

it("accepts a correlated reply, records its disposition and advances the consumed prefix together", async () => {
  const journal = await fixture();
  const request = await allocate(journal, "assignment");
  await journal.assignmentStream.acceptReply(reply(request, 1, claimed("assignment")), () => undefined);
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1, nativeConsumedReplySequence: 1 });
  expect(journal.assignmentStream.handled(scope, 1)).toMatchObject({ schemaVersion: 2, response: { sequence: 1 }, frame: { body: { body: { outcome: "claimed" } } } });
  const reopened = await load();
  expect(reopened.assignmentStream.snapshot(scope)).toMatchObject({ nativeConsumedReplySequence: 1 });
});

it("accepts the same logical frame across carriers without a Core delivery identifier", async () => {
  const journal = await fixture();
  const request = await allocate(journal, "a-one");
  const value = reply(request, 1, claimed("a-one"));
  await journal.assignmentStream.acceptReply(value, () => undefined);
  const reopened = await load();
  await reopened.assignmentStream.acceptReply(structuredClone(value), () => undefined);
  expect(reopened.assignmentStream.handled(scope, 1)).toEqual(value);
  expect(reopened.assignmentStream.handled(scope, 1)?.response).not.toHaveProperty("deliveryId");
});

it.each(["digest", "sequence", "time", "channel"])("rejects changed frame %s before advancing the cursor", async change => {
  const journal = await fixture(); const request = await allocate(journal, "a-one");
  const value = reply(request, 1, claimed("a-one"));
  if (change === "digest") value.response.digest = "z".repeat(43);
  if (change === "sequence") value.frame.seq = 2;
  if (change === "time") value.frame.issuedAt = "2026-09-06T00:00:01Z";
  if (change === "channel") value.frame.channelId = "assignment:other";
  await expect(journal.assignmentStream.acceptReply(value, () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(0);
});

it("does not accept a new timestamp and recomputed digest as an exact replay", async () => {
  const journal = await fixture(); const request = await allocate(journal, "a-one");
  const value = reply(request, 1, claimed("a-one"));
  await journal.assignmentStream.acceptReply(value, () => undefined);
  value.frame.issuedAt = "2026-09-06T00:00:01Z";
  value.response.digest = logicalAssignmentResponseDigest(value.frame);
  await expect(journal.assignmentStream.acceptReply(value, () => undefined)).rejects.toThrow();
});

async function legacyFixture() {
  const journal = await fixture(); const request = await allocate(journal, "a-one");
  const value = reply(request, 1, claimed("a-one"));
  const legacy = { ...scope, request: value.request, response: { ...value.response, deliveryId: "old-core-id" }, body: value.frame.body };
  const log = (journal as unknown as { executionLog: ExecutionLog }).executionLog;
  await log.batch(() => [
    { kind: "assignment_reply", value: legacy },
    { kind: "assignment_stream", value: { ...journal.assignmentStream.snapshot(scope), nativeConsumedReplySequence: 1 } },
  ] as never);
  return { value, legacy, request, journal: await load() };
}

it("preserves old receipts but refuses their use as verified consumption or new work authority", async () => {
  const f = await legacyFixture();
  expect(f.journal.assignmentStream.request(scope, 1)).toEqual(f.request);
  expect(() => f.journal.assignmentStream.snapshot(scope)).toThrow();
  expect(() => f.journal.assignmentStream.handled(scope, 1)).toThrow();
  expect(() => f.journal.assignmentStream.pendingClaims(scope)).toThrow();
  await expect(f.journal.assignmentStream.observeCoreRequestAck(scope, { kind: "ack", origin: "core", dataDirection: "to_core",
    channelId: "assignment:instance", cumulativeSeq: 1, issuedAt: at }, () => undefined)).rejects.toThrow();
  await expect(f.journal.assignmentStream.allocateOperation({ ...scope, runnerIncarnation: "process", operationId: "new-pull", kind: "pull", origin, issuedAt: at,
    body: { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] } }, () => undefined)).rejects.toThrow();
  expect(await readFile(join(dir, "local-execution.jsonl"), "utf8")).toContain("old-core-id");
});

it("upgrades only exact authenticated legacy replay without changing its historical cursor", async () => {
  const f = await legacyFixture();
  await expect(f.journal.assignmentStream.acceptReply(f.value, () => { throw new Error("fenced"); })).rejects.toThrow("fenced");
  const changed = structuredClone(f.value); changed.frame.issuedAt = "2026-09-06T00:00:01Z";
  changed.response.digest = logicalAssignmentResponseDigest(changed.frame);
  await expect(f.journal.assignmentStream.acceptReply(changed, () => undefined)).rejects.toThrow();
  await f.journal.assignmentStream.acceptReply(f.value, () => undefined);
  const reopened = await load();
  expect(reopened.assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(1);
  expect(reopened.assignmentStream.handled(scope, 1)).toEqual(f.value);
});

it("keeps frame and cursor absent when the real reply append fsync fails", async () => {
  const journal = await fixture(); const request = await allocate(journal, "a-one");
  const path = join(dir, "local-execution.jsonl"), before = await readFile(path, "utf8");
  const handle = await open(path, "r"), prototype = Object.getPrototypeOf(handle); await handle.close();
  const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fsync unavailable"));
  await expect(journal.assignmentStream.acceptReply(reply(request, 1, claimed("a-one")), () => undefined)).rejects.toThrow("fsync unavailable");
  sync.mockRestore();
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await load()).assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(0);
});

it("refuses a reply whose retained request identity does not match", async () => {
  const journal = await fixture();
  const request = await allocate(journal, "assignment");
  await expect(journal.assignmentStream.acceptReply(reply(request, 1, claimed("assignment"), { request: { requestSequence: 2, requestDigest: request.digest, requestKind: "claim" } }), () => undefined)).rejects.toThrow();
  await expect(journal.assignmentStream.acceptReply(reply(request, 1, claimed("assignment"), { request: { requestSequence: 1, requestDigest: "z".repeat(43), requestKind: "claim" } }), () => undefined)).rejects.toThrow();
  await expect(journal.assignmentStream.acceptReply(reply(request, 1, claimed("other")), () => undefined)).rejects.toThrow();
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ nativeConsumedReplySequence: 0 });
});

it("keeps the consumed prefix contiguous and immutable under retry", async () => {
  const journal = await fixture();
  const first = await allocate(journal, "a-one");
  const second = await allocate(journal, "b-two");
  await expect(journal.assignmentStream.acceptReply(reply(second, 2, claimed("b-two")), () => undefined)).rejects.toThrow();
  await journal.assignmentStream.acceptReply(reply(first, 1, claimed("a-one")), () => undefined);
  await journal.assignmentStream.acceptReply(reply(first, 1, claimed("a-one")), () => undefined);
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ nativeConsumedReplySequence: 1 });
  await expect(journal.assignmentStream.acceptReply(reply(first, 1, { ...claimed("a-one"), outcome: "already_claimed" }), () => undefined)).rejects.toThrow();
  await journal.assignmentStream.acceptReply(reply(second, 2, claimed("b-two")), () => undefined);
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ nativeConsumedReplySequence: 2 });
});

it("a durably handled claim leaves the acceptance-unresolved inventory", async () => {
  const journal = await fixture();
  const first = await allocate(journal, "a-one");
  const second = await allocate(journal, "b-two");
  expect(journal.assignmentStream.pendingClaims(scope).map(item => item.admission.assignmentId)).toEqual(["a-one", "b-two"]);
  await journal.assignmentStream.acceptReply(reply(first, 1, claimed("a-one")), () => undefined);
  expect(journal.assignmentStream.pendingClaims(scope).map(item => item.admission.assignmentId)).toEqual(["b-two"]);
  await journal.assignmentStream.acceptReply(reply(second, 2, { ...claimed("b-two"), outcome: "denied", reason: "assignment_conflict" }), () => undefined);
  // A durably handled denial is also known: it leaves the inventory without
  // erasing its retained transport frame or admission history.
  expect(journal.assignmentStream.pendingClaims(scope)).toEqual([]);
  expect(journal.assignmentStream.request(scope, 2)).toMatchObject({ frame: { seq: 2 } });
});
