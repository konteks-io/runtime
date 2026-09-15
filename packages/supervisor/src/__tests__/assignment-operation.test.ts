import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, logicalAssignmentResponseDigest } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { AssignmentSender } from "../work/assignment-sender.js";
import { HttpsFallbackTransport } from "../transport/https-fallback.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";
import { TransportManager } from "../transport/relay-transport.js";
import { DurableOutbox } from "../state/outbox.js";
import { ReportSender } from "../work/report-sender.js";
import { WorkOrchestrator } from "../work/orchestrator.js";

const at = "2026-09-06T00:00:00.000Z";
const scope = { instanceId: "instance", workspaceId: "workspace" };
const pull = { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] };
const report = { assignmentId: "assignment", attempt: 1, claimId: "claim", reportId: "report", reportSequence: 1,
  payloadDigest: "a".repeat(43), terminal: false, reportedAt: at };
const outbox = { id: "report", key: "report:assignment:1:claim:1", group: "report:assignment:1:claim", order: 1 };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "assignment-operation-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function fixture(initialize = true) {
  const journal = new SupervisorJournal(dir); await journal.load();
  if (initialize) {
    const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: at, assignmentStreamVersion: 1 };
    await journal.execution.seedEnrollment(seed); await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  }
  const authority = { key: "generation-a" as string | null };
  const submit = vi.fn(async (_instance: string, frame: { seq: number; channelId: string; body: Record<string, unknown> }) => {
    const request = journal.assignmentStream.request(scope, frame.seq)!;
    const kind = "maxItems" in frame.body ? "pull" : "report";
    const body = kind === "pull" ? { assignments: [] } : { assignmentId: frame.body.assignmentId, attempt: frame.body.attempt, claimId: frame.body.claimId,
      acknowledged: { reportId: frame.body.reportId, reportSequence: frame.body.reportSequence }, outcome: "accepted", durableWatermark: frame.body.reportSequence,
      ...(frame.body.terminal ? { terminalSequence: frame.body.reportSequence } : {}) };
    const replyFrame = { channel: "assignment", channelId: frame.channelId, direction: "to_runtime", seq: frame.seq, issuedAt: at,
      body: { requestSequence: frame.seq, requestDigest: request.digest, requestKind: kind, body } };
    return { disposition: "accepted", response: { deliveryId: "core-id", sequence: frame.seq, digest: logicalAssignmentResponseDigest(replyFrame) }, frame: replyFrame };
  });
  const sender = new AssignmentSender({ clock: new FixedClock(Date.parse(at)), journal,
    core: { submitAssignment: submit } as never, instanceId: () => scope.instanceId, workspaceId: () => scope.workspaceId,
    runnerIncarnation: () => "process", originManifestId: () => "manifest", assertOwned: () => undefined,
    captureRecoveryAuthority: () => new RecoveryAuthority(() => authority.key).capture("assignment"),
    captureClaimAuthority: () => { throw new Error("This operation fixture owns no claim admission"); },
  });
  return { journal, sender, submit, authority };
}

async function workFixture(f: Awaited<ReturnType<typeof fixture>>, draining = false) {
  const box = new DurableOutbox(dir); await box.load();
  const sent: Array<{ body: unknown; assignmentRequest?: Parameters<AssignmentSender["deliverAllocated"]>[0] }> = [];
  const work = new WorkOrchestrator({ journal: f.journal, outbox: box, assignmentSender: f.sender,
    transport: { send: (message: typeof sent[number]) => sent.push(message) }, deploymentKind: "native_connector",
    clock: new FixedClock(Date.parse(at)), instanceId: () => "instance", workspaceId: () => "workspace",
    recoveryAuthority: () => f.authority.key, reportDeliveryAllowed: () => true,
    reconciliationComplete: () => true, lease: { canPullNewWork: () => true }, draining: () => draining,
    headroom: () => 0, maxPullItems: 1, acceptedKinds: () => ["delivery"], components: {},
  } as never);
  await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "delivery", placementId: "placement",
    workspaceId: "workspace", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 },
    evidenceUpload: "structured_only", expiresAt: "2026-09-07T00:00:00Z", latestResumeAt: "2026-09-07T00:00:00Z", updatedAt: at });
  return { work, box, sent };
}

it("keeps strict unsolicited cancellation available when the D143 sender is installed", async () => {
  const f = await fixture(); const w = await workFixture(f);
  await w.work.onAssignmentMessage({ assignmentId: "assignment", attempt: 1, reason: "user_cancelled", issuedAt: at, signature: "signature" });
  expect(f.journal.assignments.get("assignment:1")?.state).toBe("terminal_pending_report");
  expect(w.box.all()[0]?.body).toMatchObject({ terminal: true, result: { class: "cancelled", reason: "user_cancelled" } });
  await expect(w.work.onAssignmentMessage({ assignments: [] })).rejects.toMatchObject({ code: "assignment_channel_invalid" });
});

it.each([false, true])("schedules a retained report after its domain group disappeared during allocation, despite no headroom (drain=%s)", async draining => {
  const f = await fixture(); const w = await workFixture(f, draining);
  const allocate = f.sender.prepareReport.bind(f.sender);
  vi.spyOn(f.sender, "prepareReport").mockImplementationOnce(async (...args) => {
    const reference = await allocate(...args);
    await w.box.removeGroup(args[1].group);
    return reference;
  });
  await w.work.reports.submit({ assignmentId: "assignment", attempt: 1, claimId: "claim", draft: { terminal: false } });
  expect(w.box.depth).toBe(0); expect(w.sent).toEqual([]);
  const allocated = f.journal.assignmentStream.request(scope, 1)!;
  w.work.pull();
  await vi.waitFor(() => expect(w.sent).toHaveLength(1));
  expect(w.sent[0]).toMatchObject({ body: allocated.frame.body, assignmentRequest: { requestSequence: 1, requestDigest: allocated.digest, requestKind: "report" } });
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
});

it("deduplicates repeated scheduling of the same prepared reference while delivery is pending", async () => {
  const f = await fixture(); const reference = await f.sender.preparePull(pull);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const original = f.submit.getMockImplementation()!;
  f.submit.mockImplementationOnce(async (...args) => { await wait; return original(...args); });
  const fallback = new HttpsFallbackTransport({ core: {} as never, sender: f.sender, instanceId: () => "instance", pollIntervalMs: 250, recoveryAuthority: () => f.authority.key });
  const effect = vi.fn(); fallback.onInbound(effect);
  const message = { channel: "assignment", channelId: "assignment:instance", body: pull, assignmentRequest: reference };
  try {
    for (let i = 0; i < 20; i++) fallback.send(message as never);
    expect((fallback as unknown as { pending: unknown[] }).pending).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
    expect(f.submit).toHaveBeenCalledTimes(1);
  } finally { release(); fallback.stop(); }
});

it("queues a retained lower slot before a newly prepared report instead of overtaking it", async () => {
  const f = await fixture(); const w = await workFixture(f);
  const allocate = f.sender.prepareReport.bind(f.sender);
  vi.spyOn(f.sender, "prepareReport").mockImplementationOnce(async (...args) => {
    const reference = await allocate(...args);
    await w.box.removeGroup(args[1].group);
    return reference;
  });
  await w.work.reports.submit({ assignmentId: "assignment", attempt: 1, claimId: "claim", draft: { terminal: false } });
  expect(w.sent).toEqual([]);
  await w.work.reports.submit({ assignmentId: "assignment", attempt: 1, claimId: "claim", draft: { terminal: false } });
  expect(w.sent.map(message => message.assignmentRequest?.requestSequence)).toEqual([1, 2]);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(2);
});

it("does not recapture a replacement accepted generation while report attempt persistence is pending", async () => {
  const f = await fixture(); const w = await workFixture(f);
  const mark = w.box.markAttempt.bind(w.box);
  vi.spyOn(w.box, "markAttempt").mockImplementationOnce(async (...args) => {
    await mark(...args); f.authority.key = "generation-b";
  });
  await expect(w.work.reports.submit({ assignmentId: "assignment", attempt: 1, claimId: "claim", draft: { terminal: false } }))
    .rejects.toMatchObject({ code: "recovery_required" });
  expect(w.sent).toEqual([]);
  expect(w.box.depth).toBe(1);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(0);
});

it("freezes caller-owned pull intent before fallback, then retries the exact frame after a lost response", async () => {
  const f = await fixture();
  const request = await f.sender.preparePull(pull);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
  f.submit.mockRejectedValueOnce(new Error("response lost"));
  const fallback = new HttpsFallbackTransport({ core: {} as never, sender: f.sender, instanceId: () => "instance", pollIntervalMs: 60_000, recoveryAuthority: () => f.authority.key });
  const delivered = vi.fn(); fallback.onInbound(delivered);
  fallback.send({ channel: "assignment", channelId: "assignment:instance", body: pull, assignmentRequest: request } as never);
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(fallback.available).toBe(false));
  fallback.resumeAfterRecovery();
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
  expect(f.submit.mock.calls[1]![1]).toEqual(f.submit.mock.calls[0]![1]);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
});

it("carries bare protocol-1 assignments over authenticated HTTPS even with a healthy relay", async () => {
  const corePull = vi.fn(async () => ({ assignments: [] }));
  const fallback = new HttpsFallbackTransport({ core: { pull: corePull } as never,
    instanceId: () => "instance", pollIntervalMs: 250, recoveryAuthority: () => "owned" });
  const relay = { send: vi.fn(), onInbound: vi.fn(), available: true };
  const manager = new TransportManager(relay as never, fallback);
  const effect = vi.fn(); manager.onInbound(effect);
  manager.send({ channel: "assignment", channelId: "assignment:instance", body: pull });
  await vi.waitFor(() => expect(corePull).toHaveBeenCalledWith(pull));
  expect(relay.send).not.toHaveBeenCalled();
  expect(effect).toHaveBeenCalledWith(expect.objectContaining({ body: { assignments: [] } }));
});

it("lets a predecessor terminal report pass a failed successor claim and retries the claim later", async () => {
  const claim = vi.fn()
    .mockRejectedValueOnce(new Error("predecessor unresolved"))
    .mockResolvedValue({ assignmentId: "next", attempt: 1, claimId: "claim-next", outcome: "claimed" });
  const report = vi.fn(async () => ({ assignmentId: "previous", attempt: 1, claimId: "claim-previous",
    acknowledged: { reportId: "report-previous", reportSequence: 1 }, durableWatermark: 1,
    terminalSequence: 1, outcome: "accepted" }));
  const fallback = new HttpsFallbackTransport({ core: { claim, report } as never,
    instanceId: () => "instance", pollIntervalMs: 250, recoveryAuthority: () => "owned" });
  const received = vi.fn(); fallback.onInbound(received); fallback.startPreparedAssignments();
  try {
    fallback.send({ channel: "assignment", channelId: "assignment:instance",
      body: { assignmentId: "next", attempt: 1, claimId: "claim-next", agentId: "claude-code" } as never });
    fallback.send({ channel: "assignment", channelId: "assignment:instance",
      body: { assignmentId: "previous", attempt: 1, claimId: "claim-previous", reportId: "report-previous",
        reportSequence: 1, terminal: true } as never });
    // Duplicate maintenance wakes must not enqueue duplicate immutable reports.
    fallback.send({ channel: "assignment", channelId: "assignment:instance",
      body: { assignmentId: "previous", attempt: 1, claimId: "claim-previous", reportId: "report-previous",
        reportSequence: 1, terminal: true } as never });
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ outcome: "accepted" }) }));
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    expect((fallback as unknown as { pending: unknown[] }).pending).toHaveLength(0);
  } finally { fallback.stop(); }
});

it("does not let stale protocol-1 report retries starve a fresh pull", async () => {
  let releaseFirstReport!: () => void;
  const firstReport = new Promise<void>(resolve => { releaseFirstReport = resolve; });
  const report = vi.fn(async () => {
    if (report.mock.calls.length === 1) await firstReport;
    throw new Error("stale report");
  });
  const pullNow = vi.fn(async () => ({ assignments: [] }));
  const fallback = new HttpsFallbackTransport({ core: { pull: pullNow, report } as never,
    instanceId: () => "instance", pollIntervalMs: 60_000, recoveryAuthority: () => "owned" });
  fallback.onInbound(vi.fn()); fallback.startPreparedAssignments();
  try {
    for (let index = 0; index < 20; index += 1) {
      fallback.send({ channel: "assignment", channelId: "assignment:instance",
        body: { assignmentId: `old-${index}`, attempt: 1, claimId: `claim-${index}`,
          reportId: `report-${index}`, reportSequence: 1, terminal: true } as never });
    }
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    fallback.send({ channel: "assignment", channelId: "assignment:instance", body: pull });
    releaseFirstReport();
    await vi.waitFor(() => expect(pullNow).toHaveBeenCalledTimes(1));
    expect(report.mock.calls.length).toBeLessThan(20);
  } finally { fallback.stop(); }
});

it("carries a prepared assignment through the healthy relay without starting HTTP or allocating another frame", async () => {
  const f = await fixture(); const request = await f.sender.preparePull(pull);
  const controlPoll = vi.fn(async () => []), sessionInbound = vi.fn(async () => []);
  const fallback = new HttpsFallbackTransport({ core: { controlPoll, sessionInbound } as never, sender: f.sender,
    instanceId: () => "instance", pollIntervalMs: 250, recoveryAuthority: () => f.authority.key });
  const relay = { start: vi.fn(), stop: vi.fn(), send: vi.fn(), onInbound: vi.fn(), available: true };
  const manager = new TransportManager(relay as never, fallback, 3, () => ({ connected: true, consecutiveFailures: 0 }));
  const effect = vi.fn(); manager.onInbound(effect); manager.start();
  try {
    manager.send({ channel: "assignment", channelId: "assignment:instance", body: pull, assignmentRequest: request,
      assignmentFrame: f.journal.assignmentStream.request(scope, request.requestSequence)!.frame } as never);
    expect(relay.send).toHaveBeenCalledWith(expect.objectContaining({ assignmentRequest: request,
      assignmentFrame: f.journal.assignmentStream.request(scope, request.requestSequence)!.frame }));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
    expect(controlPoll).not.toHaveBeenCalled(); expect(sessionInbound).not.toHaveBeenCalled();
  } finally { manager.stop(); }
});

it("fences a pending prepared HTTPS reply when the manager stops", async () => {
  const f = await fixture(); const request = await f.sender.preparePull(pull);
  const original = f.submit.getMockImplementation()!;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.submit.mockImplementationOnce(async (...args) => { const result = await original(...args); await barrier; return result; });
  const fallback = new HttpsFallbackTransport({ core: {} as never, sender: f.sender, instanceId: () => "instance", pollIntervalMs: 250, recoveryAuthority: () => f.authority.key });
  const manager = new TransportManager(null, fallback); const effect = vi.fn(); manager.onInbound(effect);
  manager.send({ channel: "assignment", channelId: "assignment:instance", body: pull, assignmentRequest: request } as never);
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  manager.stop(); release();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(effect).not.toHaveBeenCalled();
  expect(f.journal.assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(0);
});

it("finds the same outstanding pull and report after reopening, without body-based deduplication", async () => {
  const f = await fixture();
  const first = await f.sender.preparePull(pull);
  const firstReport = await f.sender.prepareReport(report, outbox);
  const reopened = await fixture(false);
  expect(await reopened.sender.preparePull(pull)).toEqual(first);
  expect(await reopened.sender.preparePull({ ...pull, maxItems: 3, acceptedKinds: ["validation"] })).toEqual(first);
  expect(reopened.journal.assignmentStream.request(scope, first.requestSequence)?.frame.body).toEqual(pull);
  expect(await reopened.sender.prepareReport(report, outbox)).toEqual(firstReport);
  await reopened.sender.deliverAllocated(first, async () => undefined);
  const second = await reopened.sender.preparePull(pull);
  expect(second.requestSequence).not.toBe(first.requestSequence);
  expect(reopened.journal.assignmentStream.request(scope, second.requestSequence)?.frame.body).toEqual(pull);
});

it("does not replay an uncertain local effect or allocate a replacement after handler failure", async () => {
  const f = await fixture(); const request = await f.sender.preparePull(pull);
  const effect = vi.fn(async () => { throw new Error("domain write uncertain"); });
  await expect(f.sender.deliverAllocated(request, effect)).rejects.toThrow("domain write uncertain");
  await expect(f.sender.deliverAllocated(request, effect)).rejects.toMatchObject({ code: "recovery_required" });
  expect(effect).toHaveBeenCalledTimes(1);
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(1);
});

it("only allocates a report business retry after its exact handled sequence-gap verdict", async () => {
  const f = await fixture(); const request = await f.sender.prepareReport(report, outbox);
  await expect(f.sender.prepareReport(report, outbox, request)).rejects.toThrow();
  const response = await f.submit("instance", f.journal.assignmentStream.request(scope, request.requestSequence)!.frame as never);
  response.frame.body.body = { assignmentId: "assignment", attempt: 1, claimId: "claim", acknowledged: { reportId: "report", reportSequence: 1 }, outcome: "sequence_gap", durableWatermark: 0 } as never;
  response.response.digest = logicalAssignmentResponseDigest(response.frame);
  f.submit.mockResolvedValueOnce(response);
  await f.sender.deliverAllocated(request, async () => undefined);
  const next = await f.sender.prepareReport(report, outbox, request);
  expect(next.requestSequence).toBe(request.requestSequence + 1);
  expect(f.journal.assignmentStream.request(scope, next.requestSequence)?.frame.body).toEqual(report);
  expect(await f.sender.prepareReport(report, outbox, request)).toEqual(next);
});

it("fences a moved accepted authority before publishing the retained operation result", async () => {
  const f = await fixture(); const request = await f.sender.preparePull(pull);
  const response = await f.submit("instance", f.journal.assignmentStream.request(scope, request.requestSequence)!.frame as never);
  f.submit.mockImplementationOnce(async () => { f.authority.key = "generation-b"; return response; });
  const effect = vi.fn();
  await expect(f.sender.deliverAllocated(request, effect)).rejects.toMatchObject({ code: "recovery_required" });
  expect(effect).not.toHaveBeenCalled();
  expect(f.journal.assignmentStream.snapshot(scope).nativeConsumedReplySequence).toBe(0);
});

it.each([false, true])("recovers only an exactly saved terminal ACK after domain cleanup failed (changed=%s)", async changed => {
  const f = await fixture(); const box = new DurableOutbox(dir); await box.load();
  await f.journal.assignments.put({ assignmentId: "assignment", attempt: 1, claimId: "claim", kind: "delivery", placementId: "placement",
    workspaceId: "workspace", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 },
    evidenceUpload: "structured_only", expiresAt: "2026-09-07T00:00:00Z", latestResumeAt: "2026-09-07T00:00:00Z", updatedAt: at });
  const sent: Array<{ assignmentRequest: Parameters<AssignmentSender["deliverAllocated"]>[0] }> = [];
  const reports = new ReportSender({ journal: f.journal, outbox: box, assignmentSender: f.sender,
    transport: { send: (message: unknown) => sent.push(message as typeof sent[number]) } as never,
    clock: new FixedClock(Date.parse(at)), instanceId: () => "instance", canSend: () => true,
    onConflict: async () => undefined, onTerminalDurable: async () => undefined });
  await reports.submit({ assignmentId: "assignment", attempt: 1, claimId: "claim", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
  const reference = sent[0]!.assignmentRequest;
  vi.spyOn(box, "ackKey").mockRejectedValueOnce(new Error("retirement failed"));
  const apply = vi.fn(async (body: unknown) => reports.onAck(body as never, reference));
  await expect(f.sender.deliverAllocated(reference, apply)).rejects.toThrow("retirement failed");
  expect(f.journal.assignments.get("assignment:1")?.reports.terminalAck).toBeDefined();
  if (changed) {
    await f.journal.assignments.update("assignment:1", entry => ({ ...entry!, reports: { ...entry!.reports, terminalAck: { ...entry!.reports.terminalAck!, outcome: "duplicate" } } }));
    await expect(f.sender.deliverAllocated(reference, apply)).rejects.toMatchObject({ code: "recovery_required" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(box.depth).toBe(1);
  } else {
    await f.sender.deliverAllocated(reference, apply);
    expect(box.depth).toBe(0);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.journal.assignmentStream.operation(scope, reference).effect.state).toBe("applied");
  }
});
