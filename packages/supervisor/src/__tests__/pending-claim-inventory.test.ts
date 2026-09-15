import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PendingClaimRequestSchema, derivePendingClaimReference } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pending-claim-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const at = "2026-09-06T00:00:00Z";
const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at };
const scope = { instanceId: "instance", workspaceId: "workspace" };
const origin = { runnerIncarnation: "process", manifestId: "manifest" };
const admission = (assignmentId: string) => ({ ...scope, runnerIncarnation: "process", assignmentId, attempt: 1, claimId: `claim-${assignmentId}`, agentId: "codex", executionGeneration: `generation-${assignmentId}`, openedAt: at });
const start = (assignmentId: string) => ({ schemaVersion: 1, mandatoryOpenVersion: 1, admission: admission(assignmentId), assignment: {
  id: assignmentId, kind: "delivery", placementId: "placement", ...scope, taskId: "task", correlationId: "correlation", attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [], agentRoute: { requiredRole: "planner", agentId: "codex" },
  source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "instance", workspaceRef: "ref" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
}, evidenceUpload: "structured_only", projectionCreatedAt: at, claimCreatedAt: at });

async function load() { const journal = new SupervisorJournal(dir); await journal.load(); return journal; }
async function fixture(versioned = true) {
  const journal = await load();
  const enrollment = versioned ? { ...seed, assignmentStreamVersion: 1 } : seed;
  await journal.execution.seedEnrollment(enrollment);
  await journal.execution.bindEnrollment({ ...enrollment, ...scope, exchangeNonce: "exchange" });
  return journal;
}

it("proves an empty inventory before any stream version exists instead of refusing recovery", async () => {
  const empty = await load();
  expect(empty.assignmentStream.pendingClaims(scope)).toEqual([]);
  const legacy = await fixture(false);
  expect(() => legacy.assignmentStream.snapshot(scope)).toThrow("recovery");
  expect(legacy.assignmentStream.pendingClaims(scope)).toEqual([]);
});

it("proves an empty inventory for an initialized stream that has allocated nothing", async () => {
  const journal = await fixture();
  expect(journal.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 0 });
  expect(journal.assignmentStream.pendingClaims(scope)).toEqual([]);
});

const nonClaimOperations = [
  { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] },
  { assignmentId: "reported", attempt: 1, claimId: "reported-claim", reportId: "report",
    reportSequence: 1, payloadDigest: "d".repeat(43), terminal: false, reportedAt: at },
];
function operationOwner(body: typeof nonClaimOperations[number]) {
  return body.reportId ? { operationId: "report-operation", kind: "report", report: { reportId: "report", key: "report:reported:1:reported-claim:1", group: "report:reported:1:reported-claim", order: 1 } }
    : { operationId: "pull-operation", kind: "pull" };
}

it.each(nonClaimOperations)("does not turn an unresolved non-claim operation into a pending admission: %j", async body => {
  const journal = await fixture();
  const request = await journal.assignmentStream.allocateOperation({
    ...scope, ...operationOwner(body), runnerIncarnation: origin.runnerIncarnation, origin, issuedAt: at, body,
  }, () => undefined);
  expect(journal.assignmentStream.pendingClaims(scope)).toEqual([]);
  const reopened = await load();
  expect(reopened.assignmentStream.pendingClaims(scope)).toEqual([]);
  expect(reopened.assignmentStream.request(scope, request.frame.seq)).toEqual(request);
  expect(reopened.assignmentStream.snapshot(scope)).toMatchObject({ allocatedThrough: 1, nativeConsumedReplySequence: 0 });
});

it("preserves unresolved claims in a mixed stream without dropping other retained frames", async () => {
  const journal = await fixture();
  const pull = await journal.assignmentStream.allocateOperation({
    ...scope, ...operationOwner(nonClaimOperations[0]!), runnerIncarnation: origin.runnerIncarnation, origin, issuedAt: at, body: nonClaimOperations[0],
  }, () => undefined);
  await journal.execution.beginAdmission(start("assignment"), () => undefined);
  const claim = await journal.assignmentStream.allocateClaim({ admission: admission("assignment"), origin, issuedAt: at }, () => undefined);
  const report = await journal.assignmentStream.allocateOperation({
    ...scope, ...operationOwner(nonClaimOperations[1]!), runnerIncarnation: origin.runnerIncarnation, origin, issuedAt: at, body: nonClaimOperations[1],
  }, () => undefined);
  const reopened = await load();
  const pending = reopened.assignmentStream.pendingClaims(scope);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ frame: claim.frame, requestDigest: claim.digest, admission: claim.admission });
  expect(reopened.assignmentStream.request(scope, pull.frame.seq)).toEqual(pull);
  expect(reopened.assignmentStream.request(scope, report.frame.seq)).toEqual(report);
  expect(() => reopened.assignmentStream.pendingClaims({ ...scope, workspaceId: "foreign" })).toThrow("recovery");
});

it("still refuses corrupt non-claim history before selecting the pending-claim inventory", async () => {
  const journal = await fixture();
  await journal.assignmentStream.allocateOperation({
    ...scope, ...operationOwner(nonClaimOperations[0]!), runnerIncarnation: origin.runnerIncarnation, origin, issuedAt: at, body: nonClaimOperations[0],
  }, () => undefined);
  const log = (journal as unknown as { executionLog: { batch(derive: () => unknown[]): Promise<void> } }).executionLog;
  await log.batch(() => [{ kind: "assignment_stream", value: { ...journal.assignmentStream.snapshot(scope), allocatedThrough: 2 } }]);
  expect(() => journal.assignmentStream.pendingClaims(scope)).toThrow("recovery");
});

it("derives each acceptance-unresolved intent from the exact retained frame, admission and digests", async () => {
  const journal = await fixture();
  await journal.execution.beginAdmission(start("assignment"), () => undefined);
  const allocated = await journal.assignmentStream.allocateClaim({ admission: admission("assignment"), origin, issuedAt: at }, () => undefined);
  const [pending, ...rest] = journal.assignmentStream.pendingClaims(scope);
  expect(rest).toEqual([]);
  expect(pending).toEqual({ frame: allocated.frame, requestDigest: allocated.digest, admission: allocated.admission, admissionDigest: allocated.admissionDigest });
  expect(PendingClaimRequestSchema.safeParse(pending).success).toBe(true);
  expect(derivePendingClaimReference(pending)).toMatchObject({ channelId: "assignment:instance", requestSequence: 1, requestDigest: allocated.digest, assignmentId: "assignment", attempt: 1, claimId: "claim-assignment" });
  const reopened = await load();
  expect(reopened.assignmentStream.pendingClaims(scope)).toEqual([pending]);
});

it("orders the inventory by retained request sequence and refuses another scope", async () => {
  const journal = await fixture();
  for (const id of ["b-second", "a-first"]) {
    await journal.execution.beginAdmission(start(id), () => undefined);
    await journal.assignmentStream.allocateClaim({ admission: admission(id), origin, issuedAt: at }, () => undefined);
  }
  expect(journal.assignmentStream.pendingClaims(scope).map(pending => [pending.frame.seq, pending.admission.assignmentId]))
    .toEqual([[1, "b-second"], [2, "a-first"]]);
  expect(() => journal.assignmentStream.pendingClaims({ ...scope, workspaceId: "other" })).toThrow("recovery");
});

it("refuses inconsistent retained allocation history instead of reporting nothing pending", async () => {
  const journal = await fixture();
  await journal.execution.beginAdmission(start("assignment"), () => undefined);
  await journal.assignmentStream.allocateClaim({ admission: admission("assignment"), origin, issuedAt: at }, () => undefined);
  const log = (journal as unknown as { executionLog: { batch(derive: () => unknown[]): Promise<void> } }).executionLog;
  await log.batch(() => [{ kind: "assignment_stream", value: { ...journal.assignmentStream.snapshot(scope), allocatedThrough: 3 } }]);
  expect(() => journal.assignmentStream.pendingClaims(scope)).toThrow("recovery");
});
