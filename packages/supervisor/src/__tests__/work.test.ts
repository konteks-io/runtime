import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, reportPayloadDigest, type AssignmentReport, type JsonValue, type Logger, type ReportAck, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { ReportSender } from "../work/report-sender.js";
import { intersectEvidencePolicy } from "../work/evidence.js";
import { LeaseState } from "../lease/lease.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import type { TransportManager } from "../transport/relay-transport.js";
import type { OutboundMessage } from "../transport/transport.js";
import type { RunnerPort, RunnerSessionInput, RunnerSessionLifecycle } from "../runner-port.js";
import { PermissionBroker } from "../session/permissions.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { createNativeReadyRegistrar } from "../native/execution-ready.js";
import { OperationAdmissionJournal, admittedOperationKey } from '../state/operation-admission.js';
import type { RemoteExecutionAdmissionClaims } from '@konteks/remote-common';
import { generateEd25519, ed25519Sign, remoteControlSigningBytes, type CancelDirective } from '@konteks/remote-common';
import { CoreSignatureVerifier } from '../control/core-signature.js';

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-work-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeTransport(): { sent: OutboundMessage[]; transport: TransportManager } {
  const sent: OutboundMessage[] = [];
  const transport = { send: (message: OutboundMessage) => void sent.push(message), openChannel: () => undefined, closeChannel: () => undefined, kind: "relay", available: true } as unknown as TransportManager;
  return { sent, transport };
}

async function senderHarness(canSend = () => true, extra: Partial<ConstructorParameters<typeof ReportSender>[0]> = {}) {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const { sent, transport } = fakeTransport();
  const conflicts: string[] = [];
  const terminals: string[] = [];
  await journal.assignments.put({ assignmentId: "a", attempt: 1, claimId: "c", kind: "delivery", placementId: "p", workspaceId: "w", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: "2026-09-07T00:00:00Z", latestResumeAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" });
  const sender = new ReportSender({ journal, outbox, transport, clock, canSend, instanceId: () => "inst-1", onConflict: async (id) => void conflicts.push(id), onTerminalDurable: async (id) => void terminals.push(id), ...extra });
  return { journal, outbox, sender, sent, conflicts, terminals, clock };
}

const reports = (sent: OutboundMessage[]): AssignmentReport[] => sent.map((message) => message.body as AssignmentReport).filter((body) => "reportId" in body);

// Claim acknowledgement only installs the durable owner. Observe completion of
// its asynchronous bootstrap (including failure handling) before asserting the
// resulting session or deleting the fixture's journals.
async function settleBootstrap(work: WorkOrchestrator, id: string): Promise<void> {
  const internal = work as unknown as { bootstrapping: Map<string, Promise<void>> };
  await vi.waitFor(() => expect(internal.bootstrapping.has(`${id}:1`)).toBe(false));
}

describe("report sender (D125 sender-side state machine)", () => {
  it.each(['assistant_execution', 'delivery'] as const)('includes only journal-derived operation dispositions in a terminal %s report digest', async kind => {
    const f = await senderHarness();
    await f.journal.assignments.put({ ...f.journal.assignments.get('a:1')!, kind });
    const claims: RemoteExecutionAdmissionClaims = { executionId: 'execution', delegationRef: 'delegation', workspaceId: 'w',
      sessionId: 'session', turnRef: 'turn', principal: 'assistant', actorId: 'user:default/owner', actorPrincipalId: 'human',
      leaseSetId: 'set', channelId: 'session:session', assignmentId: 'a', attempt: 1, claimId: 'c', recoveryEpoch: 0,
      readyRevision: 1, runnerIncarnation: 'runner', instanceId: 'inst-1', agentId: 'codex', acpSessionRef: 'acp',
      executionRevision: 1, state: 'active', expiresAt: '2026-09-07T00:00:00Z', operationId: 'op', permitId: 'permit',
      kind: 'acp', method: 'session/prompt', requestId: 'request', payloadDigest: 'a'.repeat(43),
      sender: { kind: 'holder', principal: 'assistant' }, iss: 'konteks:control-plane', aud: 'konteks:remote-execution-admission',
      iat: f.clock.coreNow() / 1000, exp: f.clock.coreNow() / 1000 + 30, admissionId: 'admission',
      admittedAt: f.clock.nowIso(), checkExpiresAt: new Date(f.clock.coreNow() + 30000).toISOString() };
    const operations = new OperationAdmissionJournal(f.journal, f.clock);
    await operations.admit(claims, 'a.b.c', () => undefined); await operations.begin(admittedOperationKey(claims), () => undefined);
    await operations.complete(admittedOperationKey(claims), { kind: 'acp_result', id: 'request', method: 'session/prompt', result: { stopReason: 'end_turn' } });
    const draft = { terminal: true, acpSessionRef: 'acp', result: { class: 'succeeded' as const, terminalResultHash: 'c'.repeat(43) } };
    await expect(f.sender.submit({ assignmentId: 'a', attempt: 1, claimId: 'c', draft: { ...draft, operationDispositions: [] } })).rejects.toThrow('durable native journal');
    const report = await f.sender.submit({ assignmentId: 'a', attempt: 1, claimId: 'c', draft });
    expect(report.operationDispositions).toEqual([expect.objectContaining({ executionId: 'execution', operationId: 'op', admissionId: 'admission', state: 'completed', completionDigest: expect.any(String) })]);
    const { reportedAt: _at, payloadDigest: digest, ...body } = report;
    expect(digest).toBe(reportPayloadDigest(body as unknown as { [key: string]: JsonValue }));
    expect(JSON.stringify(report)).not.toContain('a.b.c');
  });
  it('names the journaled ACP session on a recovery-authored terminal that carries dispositions', async () => {
    // Recovery has no live session to ask, and Core refuses dispositions whose
    // execution names a session the report does not: the report retried forever.
    const f = await senderHarness();
    await f.journal.assignments.put({ ...f.journal.assignments.get('a:1')!, kind: 'assistant_execution', acpSessionRef: 'acp' });
    const claims: RemoteExecutionAdmissionClaims = { executionId: 'execution', delegationRef: 'delegation', workspaceId: 'w',
      sessionId: 'session', turnRef: 'turn', principal: 'assistant', actorId: 'user:default/owner', actorPrincipalId: 'human',
      leaseSetId: 'set', channelId: 'session:session', assignmentId: 'a', attempt: 1, claimId: 'c', recoveryEpoch: 0,
      readyRevision: 1, runnerIncarnation: 'runner', instanceId: 'inst-1', agentId: 'codex', acpSessionRef: 'acp',
      executionRevision: 1, state: 'active', expiresAt: '2026-09-07T00:00:00Z', operationId: 'op', permitId: 'permit',
      kind: 'acp', method: 'session/prompt', requestId: 'request', payloadDigest: 'a'.repeat(43),
      sender: { kind: 'holder', principal: 'assistant' }, iss: 'konteks:control-plane', aud: 'konteks:remote-execution-admission',
      iat: f.clock.coreNow() / 1000, exp: f.clock.coreNow() / 1000 + 30, admissionId: 'admission',
      admittedAt: f.clock.nowIso(), checkExpiresAt: new Date(f.clock.coreNow() + 30000).toISOString() };
    const operations = new OperationAdmissionJournal(f.journal, f.clock);
    await operations.admit(claims, 'a.b.c', () => undefined); await operations.begin(admittedOperationKey(claims), () => undefined);
    const report = await f.sender.submit({ assignmentId: 'a', attempt: 1, claimId: 'c',
      draft: { terminal: true, result: { class: 'interrupted', reason: 'not_resumable', terminalResultHash: 'd'.repeat(43) } } });
    expect(report.operationDispositions?.length).toBeGreaterThan(0);
    expect(report.acpSessionRef).toBe('acp');
    const { reportedAt: _at, payloadDigest: digest, ...body } = report;
    expect(digest).toBe(reportPayloadDigest(body as unknown as { [key: string]: JsonValue }));
  });
  it('retries an identical unacknowledged terminal report on the maintenance cadence and stops after ACK', async () => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: 'a', attempt: 1, claimId: 'c',
      draft: { terminal: true, result: { class: 'succeeded', terminalResultHash: 'h'.repeat(43) } } });
    expect(reports(f.sent)).toEqual([report]);
    await f.sender.retryDue();
    expect(reports(f.sent)).toEqual([report]);
    f.clock.advance(5_001);
    await f.sender.retryDue();
    expect(reports(f.sent)).toEqual([report, report]);
    expect(f.outbox.all('assignment')).toMatchObject([{ attempts: 2 }]);
    await f.sender.onAck({ assignmentId: 'a', attempt: 1, claimId: 'c',
      acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 1,
      terminalSequence: 1, outcome: 'accepted' });
    f.clock.advance(5_001);
    await f.sender.retryDue();
    expect(reports(f.sent)).toEqual([report, report]);
  });

  it('bounds one maintenance pass so a stale report backlog cannot monopolize work polling', async () => {
    const f = await senderHarness();
    for (const assignmentId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await f.journal.assignments.put({
        assignmentId, attempt: 1, claimId: `claim-${assignmentId}`, kind: 'delivery',
        placementId: `placement-${assignmentId}`, workspaceId: 'workspace', agentId: 'agent',
        state: 'running', recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 },
        evidenceUpload: 'structured_only', expiresAt: '2026-09-06T01:00:00Z',
        latestResumeAt: f.clock.nowIso(), updatedAt: f.clock.nowIso(),
      });
      await f.sender.submit({ assignmentId, attempt: 1, claimId: `claim-${assignmentId}`,
        draft: { terminal: true, result: { class: 'succeeded', terminalResultHash: assignmentId.repeat(43) } } });
    }
    f.sent.length = 0;
    f.clock.advance(5_001);
    await f.sender.retryDue();
    expect(reports(f.sent)).toHaveLength(4);
  });
  it("persists the actual terminal ACK before removing its outbox evidence and survives restart", async () => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const ack: ReportAck = { assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" };
    const remove = f.outbox.ackKey.bind(f.outbox);
    vi.spyOn(f.outbox, "ackKey").mockImplementation(async key => {
      const disk = new SupervisorJournal(dir);
      await disk.load();
      expect(disk.assignments.get("a:1")?.reports.terminalAck).toEqual(ack);
      await remove(key);
    });
    await f.sender.onAck(ack);
    expect(f.outbox.depth).toBe(0);
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    const restored = new ReportSender({ journal, outbox, clock: f.clock, transport: fakeTransport().transport, instanceId: () => "inst-1", canSend: () => false, onConflict: async () => undefined, onTerminalDurable: async () => undefined });
    expect(restored.acknowledgedTerminalReport("a", 1, "c")).toEqual(ack);
    expect(restored.hasDurableTerminalReport("a", 1, "c")).toBe(true);
    expect(restored.queuedTerminalReport("a", 1, "c")).toBeUndefined();
    ack.outcome = "duplicate";
    expect(restored.acknowledgedTerminalReport("a", 1, "c")?.outcome).toBe("accepted");
    vi.restoreAllMocks();
  });

  it.each(["reportId", "sequence", "watermark", "terminalSequence"] as const)("does not retire a terminal report on an accepted ACK with mismatched %s", async mismatch => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const ack: ReportAck = { assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" };
    if (mismatch === "reportId") ack.acknowledged.reportId = "foreign";
    if (mismatch === "sequence") ack.acknowledged.reportSequence = 2;
    if (mismatch === "watermark") ack.durableWatermark = 0;
    if (mismatch === "terminalSequence") delete ack.terminalSequence;
    await f.sender.onAck(ack);
    expect(f.outbox.depth).toBe(1);
    expect(f.journal.assignments.get("a:1")?.state).toBe("terminal_pending_report");
    expect(f.terminals).toEqual([]);
  });

  it("retains the report when saving its ACK fails; retries keep the first actual ACK", async () => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const ack: ReportAck = { assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" };
    vi.spyOn(f.journal.assignments, "update").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.sender.onAck(ack)).rejects.toThrow("disk unavailable");
    expect(f.outbox.depth).toBe(1);
    expect(f.terminals).toEqual([]);
    vi.restoreAllMocks();
    await f.sender.onAck(ack);
    await f.sender.onAck({ ...ack, outcome: "duplicate" });
    expect(f.sender.acknowledgedTerminalReport("a", 1, "c")).toEqual(ack);
  });

  it("watermark-only legacy records cannot prove a terminal ACK", async () => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    await f.outbox.ack(report.reportId);
    const entry = f.journal.assignments.get("a:1")!;
    await f.journal.assignments.put({ ...entry, reports: { ...entry.reports, durableWatermark: 1 } });
    expect(f.sender.hasDurableTerminalReport("a", 1, "c")).toBe(false);
  });

  it("retries cleanup after the terminal ACK committed but outbox retirement failed", async () => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const ack: ReportAck = { assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" };
    vi.spyOn(f.outbox, "ackKey").mockRejectedValueOnce(new Error("retirement failed"));
    await expect(f.sender.onAck(ack)).rejects.toThrow("retirement failed");
    expect(f.outbox.depth).toBe(1);
    const disk = new SupervisorJournal(dir);
    await disk.load();
    expect(disk.assignments.get("a:1")?.reports.terminalAck).toEqual(ack);
    expect(f.terminals).toEqual([]);
    vi.restoreAllMocks();
    await f.sender.onAck({ ...ack, outcome: "duplicate" });
    expect(f.outbox.depth).toBe(0);
    expect(f.sender.acknowledgedTerminalReport("a", 1, "c")).toEqual(ack);
    expect(f.terminals).toEqual(["a"]);
  });

  it.each(["claimId", "assignmentId", "attempt", "terminalSequence", "durableWatermark", "outcome"] as const)("journal rejects stored terminal ACK with inconsistent %s", async field => {
    const f = await senderHarness();
    const report = await f.sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const ack: ReportAck = { assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" };
    if (field === "claimId") ack.claimId = "other";
    if (field === "assignmentId") ack.assignmentId = "other";
    if (field === "attempt") ack.attempt = 2;
    if (field === "terminalSequence") ack.terminalSequence = 2;
    if (field === "durableWatermark") ack.durableWatermark = 0;
    if (field === "outcome") ack.outcome = "terminal_winner_exists";
    const entry = f.journal.assignments.get("a:1")!;
    await expect(f.journal.assignments.put({ ...entry, reports: { ...entry.reports, durableWatermark: 1, terminalAck: ack } })).rejects.toThrow();
    expect(f.journal.assignments.get("a:1")?.reports.terminalAck).toBeUndefined();
  });

  it("queues recovery reports without sending or attempting them until delivery is authorized", async () => {
    let allowed = false;
    const { sender, outbox, sent } = await senderHarness(() => allowed);
    const report = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    await sender.flushGroup("report:a:1:c");
    await sender.flushAll();
    expect(sent).toEqual([]);
    expect(outbox.all()).toMatchObject([{ body: report, attempts: 0 }]);
    const restored = new DurableOutbox(dir);
    await restored.load();
    expect(restored.all()[0]?.body).toEqual(report);
    allowed = true;
    await sender.flushAll();
    expect(reports(sent)).toEqual([report]);
    expect(outbox.depth).toBe(1);
  });

  it.each(["accepted", "duplicate", "out_of_order", "sequence_gap"] as const)("%s ACK processing cannot bypass the closed delivery gate", async outcome => {
    let allowed = true;
    const { sender, outbox, sent } = await senderHarness(() => allowed);
    const first = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    allowed = false;
    sent.length = 0;
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: first.reportId, reportSequence: 1 }, durableWatermark: 1, outcome });
    expect(sent).toEqual([]);
    expect(outbox.groupFrom("report:a:1:c", 2)[0]?.attempts).toBe(0);
    allowed = true;
    await sender.flushAll();
    expect(sent).toHaveLength(1);
  });

  it.each(["flushGroup", "flushAll"] as const)("%s rechecks authorization after the asynchronous attempt append", async method => {
    let allowed = false;
    const { sender, sent, outbox } = await senderHarness(() => allowed);
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    const mark = outbox.markAttempt.bind(outbox);
    vi.spyOn(outbox, "markAttempt").mockImplementation(async (...args) => { await mark(...args); allowed = false; });
    allowed = true;
    await sender[method]("report:a:1:c");
    expect(sent).toEqual([]);
    expect(outbox.depth).toBe(1);
    vi.restoreAllMocks();
  });

  it("returns detached exact queued terminal evidence, never a watermark-only claim", async () => {
    const { sender, journal, outbox } = await senderHarness(() => false);
    const report = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    expect(sender.queuedTerminalReport("a", 1, "c")).toEqual(report);
    const detached = sender.queuedTerminalReport("a", 1, "c")!;
    detached.reportId = "mutated";
    expect(sender.queuedTerminalReport("a", 1, "c")).toEqual(report);
    expect(sender.queuedTerminalReport("a", 1, "foreign")).toBeUndefined();
    await outbox.ack(report.reportId);
    const entry = journal.assignments.get("a:1")!;
    await journal.assignments.put({ ...entry, reports: { ...entry.reports, durableWatermark: 1 } });
    expect(sender.queuedTerminalReport("a", 1, "c")).toBeUndefined();
  });

  it.each(["reportId", "payloadDigest", "terminalResultHash", "attempt", "channel"] as const)("rejects queued evidence with mismatched %s", async field => {
    const { sender, outbox } = await senderHarness(() => false);
    const report = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const item = outbox.all()[0]!;
    await outbox.ack(item.id);
    const body = structuredClone(report);
    if (field === "reportId") body.reportId = "foreign";
    if (field === "payloadDigest") body.payloadDigest = "x".repeat(43);
    if (field === "terminalResultHash") body.result!.terminalResultHash = "x".repeat(43);
    if (field === "attempt") body.attempt = 2;
    await outbox.enqueue({ ...item, channel: field === "channel" ? "control" : item.channel, body });
    expect(sender.queuedTerminalReport("a", 1, "c")).toBeUndefined();
  });

  it("mints consecutive sequences, a digest, journals before send, and sends one report per claim at a time", async () => {
    const { sender, sent, outbox } = await senderHarness();
    const first = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    const second = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    expect([first.reportSequence, second.reportSequence]).toEqual([1, 2]);
    expect(first.payloadDigest).toBe(reportPayloadDigest(first as unknown as { [key: string]: JsonValue }));
    expect(outbox.depth).toBe(2);
    expect(reports(sent).map((report) => report.reportSequence)).toEqual([1]);
    await expect(sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } })).rejects.toThrow(/terminal/);
  });

  it("accepted/duplicate drop the retry record and advance to the next report; terminal durable completes the claim", async () => {
    const { sender, sent, outbox, journal, terminals } = await senderHarness();
    const first = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    const terminal = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    const ack = (outcome: ReportAck["outcome"], sequence: number, extra: Partial<ReportAck> = {}): ReportAck => ({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: sequence === 1 ? first.reportId : terminal.reportId, reportSequence: sequence }, durableWatermark: sequence, outcome, ...extra });
    await sender.onAck(ack("accepted", 1));
    expect(outbox.depth).toBe(1);
    expect(reports(sent).map((report) => report.reportSequence)).toEqual([1, 2]);
    await sender.onAck(ack("duplicate", 2, { terminalSequence: 2 }));
    expect(outbox.depth).toBe(0);
    expect(journal.assignments.get("a:1")?.state).toBe("completed");
    expect(terminals).toEqual(["a"]);
    expect(terminal.terminal).toBe(true);
  });

  it("sequence_gap resends from durableWatermark + 1", async () => {
    const { sender, sent } = await senderHarness();
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    sent.length = 0;
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: "r3", reportSequence: 3 }, durableWatermark: 1, outcome: "sequence_gap" });
    expect(reports(sent).map((report) => report.reportSequence)).toEqual([2, 3]);
  });

  it("operation_conflict on a terminal report resubmits it as interrupted(not_resumable) once the session is stopped, backing off, and frees the claim (WS2-153)", async () => {
    const delays: number[] = [];
    const confirmStopped = vi.fn()
      .mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "The session is still open."))
      .mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "The session is still open."))
      .mockResolvedValue(undefined);
    const { sender, sent, journal, conflicts, terminals, outbox } = await senderHarness(() => true,
      { confirmStopped, sleep: async ms => void delays.push(ms) });
    const refused = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: {
      terminal: true, acpSessionRef: "acp", result: { class: "succeeded", terminalResultHash: "h".repeat(43) },
    } });
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: refused.reportId, reportSequence: 1 }, durableWatermark: 0, outcome: "operation_conflict" });
    await Promise.all(sender.pendingResubmissions());
    expect(conflicts).toEqual([]);
    expect(confirmStopped).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
    const resubmitted = reports(sent).at(-1)!;
    expect(resubmitted).toMatchObject({ terminal: true, reportSequence: 1, acpSessionRef: "acp",
      result: { class: "interrupted", reason: "not_resumable" } });
    expect(resubmitted.reportId).not.toBe(refused.reportId);
    expect(outbox.depth).toBe(1);
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: resubmitted.reportId, reportSequence: 1 }, durableWatermark: 1, terminalSequence: 1, outcome: "accepted" });
    expect(journal.assignments.get("a:1")?.state).toBe("completed");
    expect(terminals).toEqual(["a"]);
    expect(outbox.depth).toBe(0);
  });

  it("heals a claim halted over a refused terminal before this fix existed, once per process (WS2-153)", async () => {
    const confirmStopped = vi.fn(async () => undefined);
    const { sender, sent, journal, outbox } = await senderHarness(() => true, { confirmStopped, sleep: async () => undefined });
    await journal.assignments.update("a:1", current => ({ ...current!, state: "recovery_required", recoveryReason: "assignment_conflict",
      acpSessionRef: "acp", reports: { nextSequence: 2, durableWatermark: 0, terminalSequence: 1 } }));
    await sender.healHaltedConflicts();
    await Promise.all(sender.pendingResubmissions());
    const resubmitted = reports(sent).at(-1)!;
    expect(resubmitted).toMatchObject({ terminal: true, reportSequence: 1, acpSessionRef: "acp",
      result: { class: "interrupted", reason: "not_resumable" } });
    expect(journal.assignments.get("a:1")?.state).toBe("terminal_pending_report");
    // Refused again as a genuine conflict: the claim halts and is not retried in this process.
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: resubmitted.reportId, reportSequence: 1 }, durableWatermark: 0, outcome: "payload_conflict" });
    expect(journal.assignments.get("a:1")).toMatchObject({ state: "recovery_required", recoveryReason: "assignment_conflict" });
    const before = sent.length;
    await sender.healHaltedConflicts();
    expect(sent.length).toBe(before);
    expect(outbox.depth).toBe(0);
  });

  it("operation_conflict on a report already stop-confirmed halts the claim instead of looping", async () => {
    const confirmStopped = vi.fn(async () => undefined);
    const { sender, journal, conflicts, outbox } = await senderHarness(() => true, { confirmStopped });
    const report = await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: {
      terminal: true, result: { class: "interrupted", reason: "not_resumable", terminalResultHash: "h".repeat(43) },
    } });
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: report.reportId, reportSequence: 1 }, durableWatermark: 0, outcome: "operation_conflict" });
    expect(confirmStopped).not.toHaveBeenCalled();
    expect(journal.assignments.get("a:1")).toMatchObject({ state: "recovery_required", recoveryReason: "assignment_conflict" });
    expect(conflicts).toEqual(["a"]);
    expect(outbox.depth).toBe(0);
  });

  it.each(["payload_conflict", "report_id_reused"] as const)("%s halts the claim into recovery_required(assignment_conflict)", async outcome => {
    const { sender, journal, conflicts, outbox } = await senderHarness();
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: {
      terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) },
    } });
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: "r", reportSequence: 1 }, durableWatermark: 0, outcome });
    expect(journal.assignments.get("a:1")).toMatchObject({ state: "recovery_required", recoveryReason: "assignment_conflict" });
    expect(conflicts).toEqual(["a"]);
    expect(outbox.depth).toBe(0);
  });

  it("terminal_winner_exists records late and never resends; a foreign claim ack is ignored", async () => {
    const { sender, journal, outbox } = await senderHarness();
    await sender.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "succeeded", terminalResultHash: "h".repeat(43) } } });
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "other", acknowledged: { reportId: "r", reportSequence: 1 }, durableWatermark: 0, outcome: "accepted" });
    expect(outbox.depth).toBe(1);
    await sender.onAck({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: "r", reportSequence: 1 }, durableWatermark: 1, outcome: "terminal_winner_exists", terminalSequence: 1 });
    expect(outbox.depth).toBe(0);
    expect(journal.assignments.get("a:1")?.state).toBe("completed");
  });
});

describe("evidence policy intersection (invariant 33)", () => {
  it("selected_artifacts requires both authorities", () => {
    expect(intersectEvidencePolicy("selected_artifacts", "selected_artifacts")).toBe("selected_artifacts");
    expect(intersectEvidencePolicy("selected_artifacts", "structured_only")).toBe("structured_only");
    expect(intersectEvidencePolicy("structured_only", "selected_artifacts")).toBe("structured_only");
  });
});

describe("work orchestrator claim validation", () => {
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const assignment: RemoteWorkAssignment = {
    id: "asg-1",
    kind: "delivery",
    placementId: "pl",
    instanceId: "inst-1",
    workspaceId: "ws-1",
    taskId: "task",
    correlationId: "corr",
    attempt: 1,
    expiresAt: "2026-09-06T01:00:00Z",
    requiredCapabilities: [],
    agentRoute: { requiredRole: "generator", agentId: "codex" },
    source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "inst-1", workspaceRef: "ref" },
    policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-06T02:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
  };
  const readyAgent = { agentId: "codex", displayName: "Codex", connectionState: "ready" as const, authMode: "agent_local_subscription" as const, accountScope: "personal" as const, readiness: "ready" as const, tokenUsageObservable: true, acpCapabilities: { sessionResume: true, forkSession: false, structuredOutputShim: true, toolControl: "approve" as const } };

  async function orchestrator(overrides: Partial<ConstructorParameters<typeof WorkOrchestrator>[0]> = {}) {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    const lease = new LeaseState(clock);
    lease.set({ lease: "2026-09-06T00:00:00Z", mode: "active", expiresAt: "2026-09-07T00:00:00Z", drainDeadline: null, issuedAt: "2026-09-06T00:00:00Z", workspaceId: "ws-1" });
    const { sent, transport } = fakeTransport();
    const work = new WorkOrchestrator({
      clock,
      journal,
      outbox,
      transport,
      lease,
      instanceId: () => "inst-1",
      runnerIncarnation: () => "process",
      assertOwned: () => undefined,
      workspaceId: () => "ws-1",
      agents: () => [readyAgent],
      roleBindings: () => [{ role: "generator", agentPreference: ["codex"] }],
      advertisedRoles: () => ["generator"],
      acceptedKinds: () => ["delivery", "validation", "qa", "assistant_execution"],
      instanceEvidencePolicy: () => "structured_only",
      draining: () => false,
      reconciliationComplete: () => true,
      recoveryAuthority: () => "accepted-A",
      reportDeliveryAllowed: () => true,
      headroom: () => 2,
      maxPullItems: 4,
      runners: new Map(),
      sessionDeps: () => {
        throw new Error("not used");
      },
      onUsage: async () => undefined,
      ...overrides,
    });
    return { work, sent, journal, lease, transport, outbox };
  }

  it.each(['tampered', 'foreign_key', 'missing_verifier', 'empty_trust', 'malformed'] as const)('rejects %s Core cancellation before any local effect', async variant => {
    const core = generateEd25519();
    const verifier = new CoreSignatureVerifier(variant === 'empty_trust' ? [] : [{ keyId: 'root', publicKeyJwk: core.publicJwk,
      coreControlKeys: [{ keyId: 'core', publicKeyJwk: core.publicJwk }] }]);
    const f = await orchestrator(variant === 'missing_verifier' ? {} : { verifyCancellation: value => verifier.verify(value, value.signature) });
    const unsigned = { assignmentId: 'cancel-target', attempt: 1, reason: 'policy_denied' as const, issuedAt: clock.nowIso() };
    const key = variant === 'foreign_key' ? generateEd25519().privateKey : core.privateKey;
    const directive: CancelDirective = { ...unsigned, signature: ed25519Sign(key, remoteControlSigningBytes(unsigned)) };
    if (variant === 'tampered') directive.reason = 'user_cancelled';
    if (variant === 'malformed') directive.attempt = 0;
    const read = vi.spyOn(f.journal.assignments, 'get');
    const submit = vi.spyOn(f.work.reports, 'submit');
    await expect(f.work.onCancel(directive)).rejects.toMatchObject({ code: 'permission_denied' });
    if (variant !== 'malformed') await expect(f.work.onAssignmentMessage(directive)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(read).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it('accepts release-root-signed cancellation only for the retained attempt and keeps local safety cancellation independent', async () => {
    const core = generateEd25519();
    const verifier = new CoreSignatureVerifier([{ keyId: 'root', publicKeyJwk: core.publicJwk,
      coreControlKeys: [{ keyId: 'core', publicKeyJwk: core.publicJwk }] }]);
    const f = await orchestrator({ verifyCancellation: value => verifier.verify(value, value.signature) });
    await f.journal.assignments.put({ assignmentId: 'cancel-target', attempt: 2, claimId: 'claim', kind: 'assistant_execution',
      placementId: 'placement', workspaceId: 'ws-1', agentId: 'codex', state: 'running', recoveryEpoch: 0,
      reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: 'structured_only', expiresAt: '2026-09-07T00:00:00Z',
      latestResumeAt: '2026-09-07T00:00:00Z', updatedAt: clock.nowIso() });
    const close = vi.fn(async () => undefined);
    const internal = f.work as unknown as { sessions: Map<string, { close(reason: string): Promise<void> }> };
    internal.sessions.set('cancel-target:2', { close });
    const signed = (attempt: number) => {
      const body = { assignmentId: 'cancel-target', attempt, reason: 'policy_denied' as const, issuedAt: clock.nowIso() };
      return { ...body, signature: ed25519Sign(core.privateKey, remoteControlSigningBytes(body)) };
    };
    await f.work.onAssignmentMessage(signed(1));
    expect(close).not.toHaveBeenCalled();
    await f.work.onAssignmentMessage(signed(2));
    expect(close).toHaveBeenCalledExactlyOnceWith('cancelled');
    await f.work.cancelLocalSession('cancel-target', 2);
    expect(close).toHaveBeenCalledTimes(2);
    // The receiver requests cancellation; this spy is not quiescence evidence.
    expect(f.sent).toEqual([]);
  });

  it("closes local work on an unrecoverable relay replay gap", async () => {
    const fake = (kind: string, source: string) => ({
      channelId: "session:live", isClosed: false, close: vi.fn(async () => undefined),
      assignment: { id: "live", attempt: 1, kind, source: { kind: source } },
    });
    const native = await orchestrator();
    const nativeSession = fake("delivery", "harness_delivery");
    (native.work as unknown as { sessions: Map<string, unknown> }).sessions.set("live:1", nativeSession);
    const nativeClose = vi.spyOn(native.transport, "closeChannel");
    await native.work.onChannelReset("session:live");
    expect(nativeSession.close).toHaveBeenCalledExactlyOnceWith("relay_replay_gap");
    expect(nativeClose).not.toHaveBeenCalled();

    // a close that throws is logged and does not abort the reset handler
    const failing = await orchestrator();
    const failingSession = { ...fake("delivery", "harness_delivery"), close: vi.fn(async () => { throw new Error("cancel failed"); }) };
    (failing.work as unknown as { sessions: Map<string, unknown> }).sessions.set("live:1", failingSession);
    await expect(failing.work.onChannelReset("session:live")).resolves.toBeUndefined();
  });

  it("retires an ownerless terminal session channel after reset but preserves an ownerless live recovery channel", async () => {
    const f = await orchestrator();
    const close = vi.spyOn(f.transport, "closeChannel");
    const base = {
      attempt: 1, kind: "delivery" as const, placementId: "placement", workspaceId: "ws-1", agentId: "codex",
      recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const,
      expiresAt: "2026-09-07T00:00:00Z", latestResumeAt: "2026-09-07T00:00:00Z", updatedAt: clock.nowIso(),
    };
    await f.journal.assignments.put({ ...base, assignmentId: "done", claimId: "done-claim", state: "completed", sessionChannelId: "session:done" });
    await f.journal.assignments.put({ ...base, assignmentId: "live", claimId: "live-claim", state: "running", sessionChannelId: "session:live" });

    await f.work.onChannelReset("session:done");
    await f.work.onChannelReset("session:live");

    expect(close).toHaveBeenCalledExactlyOnceWith("session:done");
  });

  it("native continuation rejects a newer accepted generation after admission fsync", async () => {
    let generation: string | null = "accepted-A";
    const f = await orchestrator({ recoveryAuthority: () => generation });
    const begin = f.journal.execution.beginAdmission.bind(f.journal.execution);
    vi.spyOn(f.journal.execution, "beginAdmission").mockImplementation(async (candidate, check) => {
      await begin(candidate, check);
      generation = null;
      await Promise.resolve();
      generation = "accepted-B";
    });
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow();
    expect(f.sent).toEqual([]);
    expect(f.outbox.depth).toBe(0);
    expect(f.journal.execution.start("asg-1", 1)?.delivery).toBe("unallocated");
  });

  it("emits causal diagnostics only after native admission is durable", async () => {
    let admissionPersisted = false;
    const info = vi.fn((fields: Record<string, unknown>) => {
      if (fields.event === "runtime.admission.durable") {
        expect(admissionPersisted).toBe(true);
      }
    });
    const logger = { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const f = await orchestrator({ logger });
    const begin = f.journal.execution.beginAdmission.bind(f.journal.execution);
    vi.spyOn(f.journal.execution, "beginAdmission").mockImplementation(async (candidate, check) => {
      await begin(candidate, check);
      admissionPersisted = true;
    });

    await f.work.onAssignmentMessage({ assignments: [assignment] });

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "runtime.admission.durable",
      observability: expect.objectContaining({
        schemaVersion: "observability-context-v1",
        assignmentId: "asg-1",
        attempt: 1,
        executionId: expect.any(String),
        runtimeIncarnationId: "process",
      }),
    }), "native claim admission persisted");
  });

  it("claim ACK completion cannot adopt newer authority or invent a terminal", async () => {
    let generation: string | null = "accepted-A";
    const f = await orchestrator({ recoveryAuthority: () => generation });
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const entry = f.journal.assignments.get("asg-1:1")!;
    const ack = f.outbox.ack.bind(f.outbox);
    vi.spyOn(f.outbox, "ack").mockImplementation(async id => { await ack(id); generation = null; await Promise.resolve(); generation = "accepted-B"; });
    await expect(f.work.onAssignmentMessage({ assignmentId: "asg-1", attempt: 1, claimId: entry.claimId, outcome: "claimed" })).rejects.toThrow();
    expect(f.outbox.depth).toBe(0); // Real ACK stays historical; no reconstruction.
    expect(f.journal.execution.execution(f.journal.execution.admission("asg-1", 1)!)).toBeUndefined();
    expect(reports(f.sent)).toEqual([]);
    expect(f.journal.assignments.get("asg-1:1")?.reports.terminalSequence).toBeUndefined();
  });

  it("negative claim disposition cannot overwrite moved recovery while its final write waits", async () => {
    let generation = "accepted-A";
    const f = await orchestrator({ recoveryAuthority: () => generation });
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const original = f.journal.assignments.get("asg-1:1")!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = f.journal.assignments.put.bind(f.journal.assignments);
    const update = f.journal.assignments.update.bind(f.journal.assignments);
    vi.spyOn(f.journal.assignments, "put").mockImplementation(async value => { entered.resolve(); await release.promise; await put(value); });
    vi.spyOn(f.journal.assignments, "update").mockImplementation(async (key, derive) => { entered.resolve(); await release.promise; await update(key, derive); });
    const denied = f.work.onAssignmentMessage({ assignmentId: "asg-1", attempt: 1, claimId: original.claimId, outcome: "denied", reason: "no_eligible_agent" });
    const rejected = expect(denied).rejects.toThrow();
    await entered.promise;
    const moved = { ...original, state: "recovery_required" as const, recoveryEpoch: 2, updatedAt: "2026-09-06T00:02:00Z" };
    await put(moved);
    generation = "accepted-B";
    release.resolve();
    await rejected;
    expect(f.journal.assignments.get("asg-1:1")).toEqual(moved);
    const owner = f.work as unknown as { pendingClaims: Map<string, unknown>; pendingClaimFences: Map<string, unknown>; recoveryFences: Set<string> };
    expect(owner.pendingClaims.has("asg-1:1")).toBe(true);
    expect(owner.pendingClaimFences.has("asg-1:1")).toBe(true);
    expect(owner.recoveryFences.has("asg-1:1")).toBe(true);
    expect(reports(f.sent)).toEqual([]);
  });

  it("live admission does not create assignment projection after authority moves during outbox fsync", async () => {
    let generation: string | null = "accepted-A";
    const f = await orchestrator({ recoveryAuthority: () => generation });
    const enqueue = f.outbox.enqueue.bind(f.outbox);
    vi.spyOn(f.outbox, "enqueue").mockImplementation(async item => {
      const persisted = await enqueue(item);
      generation = null; await Promise.resolve(); generation = "accepted-B";
      return persisted;
    });
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow();
    expect(f.sent).toEqual([]);
    expect(f.outbox.depth).toBe(1); // Committed evidence remains; it is not replay authority.
    expect(f.journal.assignments.get("asg-1:1")).toBeUndefined();
    expect(f.journal.execution.start("asg-1", 1)?.delivery).toBe("unallocated");
  });

  it("native admission requires non-null accepted authority, but unchanged renewal continues", async () => {
    const blocked = await orchestrator({ recoveryAuthority: () => null });
    await expect(blocked.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow();
    expect(blocked.journal.execution.admission("asg-1", 1)).toBeUndefined();
    const f = await orchestrator({ recoveryAuthority: () => "accepted-A" });
    const begin = f.journal.execution.beginAdmission.bind(f.journal.execution);
    vi.spyOn(f.journal.execution, "beginAdmission").mockImplementation(async (candidate, check) => { await begin(candidate, check); await Promise.resolve(); });
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    expect(f.sent).toHaveLength(1);
  });

  it("native claim admission is retained before the first outbox/network effect", async () => {
    const f = await orchestrator();
    const enqueue = f.outbox.enqueue.bind(f.outbox);
    vi.spyOn(f.outbox, "enqueue").mockImplementation(async item => {
      const disk = new SupervisorJournal(dir); await disk.load();
      expect(disk.execution.admission("asg-1", 1)).toMatchObject({ instanceId: "inst-1", workspaceId: "ws-1", runnerIncarnation: "process", claimId: (item.body as { claimId: string }).claimId, agentId: "codex" });
      return enqueue(item);
    });
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    expect(f.sent).toHaveLength(1);
    expect(f.journal.execution.coverage("inst-1", "ws-1")).toBe("legacy_unknown");
  });

  it("failed native admission write prevents claim enqueue, journal and delivery", async () => {
    const f = await orchestrator();
    vi.spyOn(f.journal.execution, "beginAdmission").mockRejectedValueOnce(new Error("admission disk full"));
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow("admission disk full");
    expect(f.outbox.depth).toBe(0); expect(f.sent).toEqual([]); expect(f.journal.assignments.all()).toEqual([]);
  });

  it.each(["outbox", "assignment"] as const)("complete start repairs missing %s projections after reopening without sending", async failure => {
    const f = await orchestrator();
    if (failure === "outbox") vi.spyOn(f.outbox, "enqueue").mockRejectedValueOnce(new Error("projection failed"));
    else vi.spyOn(f.journal.assignments, "update").mockRejectedValueOnce(new Error("projection failed"));
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow("projection failed");
    const start = f.journal.execution.start("asg-1", 1)!;
    expect(start).toMatchObject({ assignment, mandatoryOpenVersion: 1, delivery: "unallocated" });
    expect(f.sent).toEqual([]);
    const reopened = await orchestrator();
    await reopened.work.reconstructAdmissionProjections("asg-1", 1);
    expect(reopened.journal.assignments.get("asg-1:1")).toMatchObject({ claimId: start.admission.claimId, claimedAt: start.projectionCreatedAt, updatedAt: start.projectionCreatedAt });
    expect(reopened.outbox.all()[0]).toMatchObject({ id: start.admission.claimId, createdAt: start.claimCreatedAt });
    expect(reopened.sent).toEqual([]);
    expect(reopened.journal.execution.start("asg-1", 1)).toEqual(start);
  });

  it("reserves before transport entry and never resends an uncertain claim on repeated work", async () => {
    const f = await orchestrator();
    vi.spyOn(f.transport, "send").mockImplementation(() => {
      expect(f.journal.execution.start("asg-1", 1)?.delivery).toBe("allocation_reserved");
      throw new Error("uncertain send");
    });
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow("uncertain send");
    const reopened = await orchestrator();
    await reopened.work.onAssignmentMessage({ assignments: [assignment] });
    expect(reopened.sent).toEqual([]);
    expect(reopened.journal.execution.start("asg-1", 1)?.delivery).toBe("allocation_reserved");
  });

  it("failed reservation permits no send and reconstruction preserves progressed state", async () => {
    const f = await orchestrator();
    vi.spyOn(f.journal.execution, "reserveAllocation").mockRejectedValueOnce(new Error("reserve failed"));
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow("reserve failed");
    expect(f.sent).toEqual([]);
    const entry = f.journal.assignments.get("asg-1:1")!;
    const progressed = { ...entry, state: "running" as const, recoveryEpoch: 7, reports: { nextSequence: 4, durableWatermark: 3 }, updatedAt: "2026-09-06T00:01:00Z" };
    await f.journal.assignments.put(progressed);
    await f.outbox.ack(entry.claimId);
    await f.work.reconstructAdmissionProjections("asg-1", 1);
    expect(f.journal.assignments.get("asg-1:1")).toEqual(progressed);
    expect(f.outbox.depth).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it("repair rejects conflicting projection identity and changed assignment metadata", async () => {
    const f = await orchestrator();
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const original = f.journal.assignments.get("asg-1:1")!;
    await f.journal.assignments.put({ ...original, claimId: "foreign" });
    await expect(f.work.reconstructAdmissionProjections("asg-1", 1)).rejects.toThrow();
    expect(f.journal.assignments.get("asg-1:1")?.claimId).toBe("foreign");
    await expect(f.work.onAssignmentMessage({ assignments: [{ ...assignment, taskId: "different" }] })).rejects.toThrow();
  });

  it("reserved initial projection with a retired claim outbox is not recreated by repair", async () => {
    const f = await orchestrator();
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const entry = f.journal.assignments.get("asg-1:1")!;
    await f.outbox.ack(entry.claimId);
    const reopened = await orchestrator();
    await reopened.work.reconstructAdmissionProjections("asg-1", 1);
    expect(reopened.outbox.depth).toBe(0);
    expect(reopened.journal.assignments.get("asg-1:1")).toEqual(entry);
    expect(reopened.sent).toEqual([]);
    await reopened.journal.assignments.clear();
    await expect(reopened.work.reconstructAdmissionProjections("asg-1", 1)).rejects.toThrow("unknown assignment projection history");
    expect(reopened.journal.assignments.all()).toEqual([]);
  });

  it("a progressed projection encountered during first admission cannot grant reservation or send", async () => {
    const f = await orchestrator();
    const update = f.journal.assignments.update.bind(f.journal.assignments);
    vi.spyOn(f.journal.assignments, "update").mockImplementation(async (key, derive) => {
      await update(key, derive);
      const initial = f.journal.assignments.get(key)!;
      await f.journal.assignments.put({ ...initial, state: "running", recoveryEpoch: 2 });
    });
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow();
    expect(f.sent).toEqual([]);
    expect(f.journal.execution.start("asg-1", 1)?.delivery).toBe("unallocated");
    expect(f.journal.assignments.get("asg-1:1")?.state).toBe("running");
  });

  it("repair cannot create initial assignment after reservation advances during outbox persistence", async () => {
    const f = await orchestrator();
    const enqueue = f.outbox.enqueue.bind(f.outbox);
    vi.spyOn(f.outbox, "enqueue").mockRejectedValueOnce(new Error("initial setup failed"));
    await expect(f.work.onAssignmentMessage({ assignments: [assignment] })).rejects.toThrow("initial setup failed");
    vi.spyOn(f.outbox, "enqueue").mockImplementation(async item => {
      const result = await enqueue(item);
      await f.journal.execution.reserveAllocation(f.journal.execution.admission("asg-1", 1)!, () => undefined);
      return result;
    });
    await expect(f.work.reconstructAdmissionProjections("asg-1", 1)).rejects.toThrow();
    expect(f.journal.assignments.get("asg-1:1")).toBeUndefined();
    expect(f.sent).toEqual([]);
  });

  it("concurrent repair waits for the real admission setup and never duplicates allocation", async () => {
    const f = await orchestrator();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const enqueue = f.outbox.enqueue.bind(f.outbox);
    const enqueueSpy = vi.spyOn(f.outbox, "enqueue").mockImplementation(async item => { entered(); await proceed; return enqueue(item); });
    const original = f.work.onAssignmentMessage({ assignments: [assignment] });
    await waiting;
    const repair = f.work.reconstructAdmissionProjections("asg-1", 1);
    await Promise.resolve();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([original, repair]);
    expect(f.sent).toHaveLength(1);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(f.journal.execution.start("asg-1", 1)?.delivery).toBe("allocation_reserved");
  });

  it("retained tombstone blocks late assignment admission after process restart", async () => {
    const f = await orchestrator();
    const seed = { enrollmentId: "enrollment", activationId: "activation", keyDigest: "a".repeat(43), createdAt: clock.nowIso() };
    await f.journal.execution.seedEnrollment(seed);
    await f.journal.execution.bindEnrollment({ ...seed, instanceId: "inst-1", workspaceId: "ws-1", exchangeNonce: "exchange" });
    await f.journal.execution.cancelAbsent({ instanceId: "inst-1", workspaceId: "ws-1", runnerIncarnation: "old", manifestId: "old-manifest", assignmentId: "asg-1", attempt: 1, decisionDigest: "b".repeat(43), cancelledAt: clock.nowIso() }, () => undefined);
    const reopened = await orchestrator();
    await reopened.work.onAssignmentMessage({ assignments: [assignment] });
    expect(reopened.work.counters.stale_attempt).toBe(1);
    expect(reopened.sent).toEqual([]); expect(reopened.journal.assignments.all()).toEqual([]);
  });

  it("a mismatched claim reply cannot retire the actual pending claim or outbox", async () => {
    const f = await orchestrator();
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const claim = f.journal.assignments.get("asg-1:1")!;
    const pending = f.outbox.all("assignment");
    await f.work.onAssignmentMessage({ assignmentId: "asg-1", attempt: 1, claimId: "delayed-other-claim", outcome: "claimed" });
    expect(f.outbox.all("assignment")).toEqual(pending);
    expect(f.journal.assignments.get("asg-1:1")).toEqual(claim);
    await f.work.onAssignmentMessage({ assignmentId: "asg-1", attempt: 1, claimId: claim.claimId, outcome: "denied", reason: "no_eligible_agent" });
    expect(f.outbox.depth).toBe(0);
    expect(f.journal.assignments.get("asg-1:1")?.state).toBe("cancelled");
  });

  it("native report delivery fails closed without receipt authority even when local reconciliation says complete", async () => {
    const { work, journal, sent } = await orchestrator({ reportDeliveryAllowed: () => false });
    await journal.assignments.put({ assignmentId: "a", attempt: 1, claimId: "c", kind: "delivery", placementId: "p", workspaceId: "w", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: "2026-09-07T00:00:00Z", latestResumeAt: "2026-09-07T00:00:00Z", updatedAt: clock.nowIso() });
    await work.reports.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: false } });
    await work.reports.flushAll();
    expect(sent).toEqual([]);
  });

  it.each(["delivery", "validation", "qa", "assistant_execution"] as const)("native %s claims bootstrap ACP", async kind => {
    const runner = { createSession: vi.fn(async (_input: RunnerSessionInput, lifecycle?: RunnerSessionLifecycle) => { await lifecycle?.beforeCreate("native-acp"); lifecycle?.assertCurrent(); return { acpSessionRef: "native-acp", resumed: false, capabilities: { forkSession: false, sessionResume: false } }; }), cancel: vi.fn(async () => undefined), closeSession: vi.fn(async () => undefined) } as unknown as RunnerPort;
    const role = kind === "delivery" ? "generator" : kind === "assistant_execution" ? "assistant" : "qa";
    const f = await orchestrator({ runners: new Map([["codex", runner]]), advertisedRoles: () => [role],
      sessionDeps: (target, selected) => ({ clock, journal: f.journal, transport: f.transport, runner: selected, policy: new EvaluatorPolicyResponder(null, () => true), broker: new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined }), instanceId: "inst-1", redeemCapabilityToken: async () => { throw new Error("not needed"); }, workspaceRoot: "/native", prepareInputs: async () => ({ binding: { workspaceId: target.workspaceId, assignmentId: target.id, attempt: target.attempt, instanceId: target.instanceId, sessionId: "cloud-session" }, cwd: "/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
        registerReady: createNativeReadyRegistrar({ clock, journal: f.journal, instanceId: target.instanceId, workspaceId: target.workspaceId, runnerIncarnation: "process", assertActive: () => undefined,
          client: { registerExecutionReady: async (_instanceId, request) => ({ ...request, workspaceId: target.workspaceId, instanceId: target.instanceId, sessionId: "cloud-session", channelId: "session:cloud-session", readyRevision: 1, registeredAt: clock.nowIso() }) },
        }),
      }),
    });
    await f.work.onAssignmentMessage({ assignments: [{ ...assignment, kind, agentRoute: { ...assignment.agentRoute, requiredRole: role }, ...(kind === "assistant_execution" ? { source: { kind: "conversation", portability: "portable_before_claim", sessionId: "cloud-session", turnRef: "turn" } } : {}) }] });
    const claim = f.journal.assignments.get("asg-1:1")!;
    await f.work.onAssignmentMessage({ assignmentId: "asg-1", attempt: 1, claimId: claim.claimId, outcome: "claimed" });
    await settleBootstrap(f.work, "asg-1");
    expect(runner.createSession).toHaveBeenCalledOnce();
    expect(f.journal.assignments.get("asg-1:1")).toMatchObject({ state: "running", acpSessionRef: "native-acp", executionReady: { claimId: claim.claimId, readyRevision: 1, channelId: "session:cloud-session" } });
    expect(reports(f.sent)).toEqual([]);
    expect(f.sent.at(-1)?.body).toMatchObject({ kind: "session_ready", agentId: "codex" });
    await f.work.drainSessions("drain");
    expect(runner.cancel).toHaveBeenCalledWith("native-acp");
  });

  it("logs bounded dispatch failure ownership without bridge error payloads", async () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const f = await orchestrator({ logger });
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const claim = f.journal.assignments.get("asg-1:1")!;
    const handler = f.work as unknown as { handleDispatchFailure(work: RemoteWorkAssignment, entry: typeof claim, assertAuthority: () => void, error: unknown): Promise<void> };
    await handler.handleDispatchFailure(assignment, claim, () => undefined,
      new RemoteInstanceError("recovery_required", "private-bootstrap-canary"));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: "asg-1", attempt: 1, claimId: claim.claimId,
      stage: "assignment_dispatch", reason: "recovery_required", sessionContinuation: false,
    }), "dispatch failed; reporting");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-bootstrap-canary");
    expect(reports(f.sent).at(-1)?.result).toMatchObject({ class: "interrupted", reason: "not_resumable" });
    expect(JSON.stringify(reports(f.sent))).not.toContain("private-bootstrap-canary");
  });

  it("names the exact refusing check through its bounded diagnostic, never its message", async () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const f = await orchestrator({ logger });
    await f.work.onAssignmentMessage({ assignments: [assignment] });
    const claim = f.journal.assignments.get("asg-1:1")!;
    const handler = f.work as unknown as { handleDispatchFailure(work: RemoteWorkAssignment, entry: typeof claim, assertAuthority: () => void, error: unknown): Promise<void> };
    await handler.handleDispatchFailure(assignment, claim, () => undefined,
      new RemoteInstanceError("recovery_required", "private-bootstrap-canary", { diagnostic: "session_generation_fenced" }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      stage: "assignment_dispatch", reason: "recovery_required", detail: "session_generation_fenced",
    }), "dispatch failed; reporting");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-bootstrap-canary");
  });

  it("claims exactly the placed agent for a valid instance-bound assignment", async () => {
    const { work, sent, journal } = await orchestrator();
    expect(work.validate(assignment)).toBeNull();
    await work.onAssignmentMessage({ assignments: [assignment] });
    const claim = sent.find((message) => "claimId" in (message.body as object)) as OutboundMessage;
    expect(claim.body).toMatchObject({ assignmentId: "asg-1", attempt: 1, agentId: "codex" });
    expect(journal.assignments.get("asg-1:1")?.state).toBe("claimed");
  });

  async function nativeSessions(register: (target: RemoteWorkAssignment) => Promise<void>, recoveryAuthority = () => "accepted-A") {
    const runner = {
      createSession: vi.fn(async (input: { context: { assignmentId: string }; acpSessionRef?: string; restoreAcpSessionRef?: string }, lifecycle?: RunnerSessionLifecycle) => { const ref = input.acpSessionRef ?? `acp:${input.context.assignmentId}`; await lifecycle?.beforeCreate(ref); lifecycle?.assertCurrent(); return { acpSessionRef: ref, resumed: input.acpSessionRef !== undefined || input.restoreAcpSessionRef !== undefined, capabilities: { forkSession: false, sessionResume: true } }; }),
      prompt: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), closeSession: vi.fn(async () => undefined),
    } as unknown as RunnerPort;
    const f = await orchestrator({ recoveryAuthority, components: {}, runners: new Map([["codex", runner]]),
      advertisedRoles: () => ["generator", "assistant"],
      roleBindings: () => [{ role: "generator", agentPreference: ["codex"] }, { role: "assistant", agentPreference: ["codex"] }],
      sessionDeps: (target, selected) => ({ clock, journal: f.journal, transport: f.transport, runner: selected, policy: new EvaluatorPolicyResponder(null, () => true), broker: new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined }), instanceId: "inst-1", redeemCapabilityToken: async () => { throw new Error("not needed"); }, workspaceRoot: "/native",         prepareInputs: async () => ({ binding: { workspaceId: target.workspaceId, assignmentId: target.id, attempt: target.attempt, instanceId: target.instanceId, sessionId: "cloud-session" }, cwd: "/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
        registerReady: async (_assignment, binding, acpSessionRef) => {
          await register(target);
          const claim = f.journal.assignments.get(`${target.id}:${target.attempt}`)!;
          return { ...binding, channelId: "session:cloud-session", claimId: claim.claimId, recoveryEpoch: claim.recoveryEpoch, runnerIncarnation: "process", agentId: target.agentRoute.agentId, acpSessionRef, readyRevision: 1, registeredAt: clock.nowIso() };
        },
      }),
    });
    const claim = async (id: string, overrides: Partial<RemoteWorkAssignment> = {}) => {
      await f.work.onAssignmentMessage({ assignments: [{ ...assignment, id, ...overrides } as RemoteWorkAssignment] });
      const entry = f.journal.assignments.get(`${id}:1`)!;
      return async () => {
        await f.work.onAssignmentMessage({ assignmentId: id, attempt: 1, claimId: entry.claimId, outcome: "claimed" });
        await settleBootstrap(f.work, id);
      };
    };
    const prompt = (id: string) => f.work.onSessionMessage("session:cloud-session", { kind: "acp", method: "session/prompt", id: `request:${id}`, params: { sessionId: `acp:${id}`, prompt: [{ type: "text", text: "work" }] } });
    return { ...f, runner, claim, prompt };
  }

  it.each([false, true])("bootstrap authority movement retains uncertain owner without fake terminal (reject=%s)", async reject => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => {
      generation = ""; await Promise.resolve(); generation = "accepted-B";
      if (reject) throw new Error("late readiness transport error");
    }, () => generation);
    await (await f.claim("old"))();
    expect(f.runner.createSession).toHaveBeenCalledOnce();
    expect(f.runner.closeSession).not.toHaveBeenCalled();
    expect(reports(f.sent)).toEqual([]);
    expect(f.sent.filter(message => (message.body as { kind?: string }).kind === "session_ready")).toEqual([]);
    const owned = (f.work as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(owned.has("old:1")).toBe(true);
    await f.prompt("old"); // Already-fenced closed session cannot execute.
    expect(f.runner.prompt).not.toHaveBeenCalled();
  });

  it("deferred execution-open continuation keeps the original pending claim capture", async () => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    const run = await f.claim("old");
    const open = f.journal.execution.open.bind(f.journal.execution);
    vi.spyOn(f.journal.execution, "open").mockImplementation(async (admission, check, at) => {
      await open(admission, check, at);
      generation = ""; await Promise.resolve(); generation = "accepted-B";
    });
    await run();
    expect(f.runner.createSession).not.toHaveBeenCalled();
    expect(reports(f.sent)).toEqual([]);
    expect(f.journal.assignments.get("old:1")?.reports.terminalSequence).toBeUndefined();
  });

  it("existing session callbacks retain their original accepted generation", async () => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    await (await f.claim("live"))();
    generation = "accepted-B";
    await expect(f.prompt("live")).rejects.toThrow();
    expect(f.runner.prompt).not.toHaveBeenCalled();
    expect(reports(f.sent)).toEqual([]);
  });

  it("final running-projection await cannot leave an owner usable after generation movement", async () => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    const run = await f.claim("live");
    const update = f.journal.assignments.update.bind(f.journal.assignments);
    vi.spyOn(f.journal.assignments, "update").mockImplementation(async (key, derive) => {
      await update(key, derive);
      if (f.journal.assignments.get(key)?.state === "running") generation = "accepted-B";
    });
    await run();
    const owner = (f.work as unknown as { sessions: Map<string, { isClosed: boolean }> }).sessions.get("live:1");
    expect(owner?.isClosed).toBe(true);
    expect(f.runner.closeSession).not.toHaveBeenCalled();
    expect(reports(f.sent)).toEqual([]);
  });

  it("unchanged accepted generation permits normal bootstrap and subsequent prompt", async () => {
    const f = await nativeSessions(async () => { await Promise.resolve(); }, () => "accepted-A");
    await (await f.claim("live"))();
    await f.prompt("live");
    expect(f.runner.prompt).toHaveBeenCalledOnce();
  });

  it("loads Core's durable ACP reference after a connector restart removed the in-memory channel owner", async () => {
    const f = await nativeSessions(async () => undefined, () => "accepted-A");
    const priorRef = "acp:durable-prior";
    await (await f.claim("restarted", {
      kind: "assistant_execution",
      agentRoute: { requiredRole: "assistant", agentId: "codex" },
      source: { kind: "conversation", portability: "portable_before_claim", sessionId: "cloud-session", turnRef: "turn-restarted", acpSessionRef: priorRef },
    }))();
    expect(f.runner.createSession).toHaveBeenCalledWith(expect.objectContaining({ restoreAcpSessionRef: priorRef }), expect.any(Object));
    expect(f.runner.createSession.mock.calls[0]?.[0]).not.toHaveProperty("acpSessionRef");
    expect(f.journal.execution.execution(f.journal.execution.admission("restarted", 1)!)).toMatchObject({ acpSessionRef: "acp:restarted" });
    expect(f.sent).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ kind: "session_ready", acpSessionRef: "acp:restarted", resumed: true }) }));
  });

  it.each(["readiness_cancel", "readiness_close", "disposal_cancel", "disposal_close"])("authority movement during %s cleanup retains final ownership", async phase => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => { if (phase.startsWith("readiness")) throw new Error("ordinary readiness failure"); }, () => generation);
    const run = await f.claim("old");
    if (phase.startsWith("disposal")) vi.spyOn(f.journal.assignments, "update").mockRejectedValueOnce(new Error("ordinary journal failure"));
    const movingMethod = phase.endsWith("cancel") ? "cancel" : "closeSession";
    vi.spyOn(f.runner, movingMethod).mockImplementation(async () => { generation = ""; await Promise.resolve(); generation = "accepted-B"; });
    await run();
    const owners = f.work as unknown as { sessions: Map<string, { isClosed: boolean }>; channelOwners: Map<string, unknown> };
    expect(owners.sessions.get("old:1")?.isClosed).toBe(true);
    expect(owners.channelOwners.has("session:cloud-session")).toBe(true);
    expect(reports(f.sent)).toEqual([]);
    expect(f.sent.filter(message => (message.body as { kind?: string }).kind === "session_closed")).toEqual([]);
    expect(f.runner.closeSession).toHaveBeenCalledTimes(phase.endsWith("cancel") ? 0 : 1);
  });

  it.each(["prompt_result", "session_exited"] as const)("late %s event cannot mutate pending state or close under a new generation", async kind => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    await (await f.claim("live"))();
    await f.prompt("live");
    const before = f.journal.pendingRequests.all();
    generation = "accepted-B";
    const event = kind === "prompt_result" ? { kind, acpSessionRef: "acp:live", requestId: "request:live", result: { stopReason: "end_turn" } } : { kind, acpSessionRef: "acp:live", reason: "agent_exited" as const };
    await expect(f.work.onRunnerEvent(event)).rejects.toThrow();
    expect(f.journal.pendingRequests.all()).toEqual(before);
    expect(f.runner.closeSession).not.toHaveBeenCalled();
    expect(reports(f.sent)).toEqual([]);
    expect((f.work as unknown as { sessions: Map<string, unknown> }).sessions.has("live:1")).toBe(true);
  });

  it.each(["cancel", "closeSession"] as const)("ordinary close authority movement during %s retains the owner and channel", async method => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    await (await f.claim("live"))();
    vi.spyOn(f.runner, method).mockImplementation(async () => { generation = ""; await Promise.resolve(); generation = "accepted-B"; });
    await expect(f.work.cancelLocalSession("live", 1)).rejects.toThrow();
    const owners = f.work as unknown as { sessions: Map<string, unknown>; channelOwners: Map<string, unknown> };
    expect(owners.sessions.has("live:1")).toBe(true);
    expect(owners.channelOwners.has("session:cloud-session")).toBe(true);
    expect(f.runner.closeSession).toHaveBeenCalledTimes(method === "cancel" ? 0 : 1);
    expect(reports(f.sent)).toEqual([]);
  });

  it("authority movement during genuine close report persistence retains owner and historical report", async () => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    await (await f.claim("live"))();
    const submit = f.work.reports.submit.bind(f.work.reports);
    vi.spyOn(f.work.reports, "submit").mockImplementation(async input => { const report = await submit(input); generation = "accepted-B"; return report; });
    await expect(f.work.cancelLocalSession("live", 1)).rejects.toThrow();
    const owners = f.work as unknown as { sessions: Map<string, unknown>; channelOwners: Map<string, unknown> };
    expect(owners.sessions.has("live:1")).toBe(true);
    expect(owners.channelOwners.has("session:cloud-session")).toBe(true);
    expect(reports(f.sent)).toHaveLength(1);
    expect(reports(f.sent)[0]?.result?.class).toBe("cancelled");
    expect(f.journal.assignments.get("live:1")?.reports.terminalSequence).toBe(1);
  });

  it("completion journal await fences on changed generation before publishing the result", async () => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    await (await f.claim("live"))();
    await f.prompt("live");
    const put = f.journal.pendingRequests.put.bind(f.journal.pendingRequests);
    vi.spyOn(f.journal.pendingRequests, "put").mockImplementation(async entry => { await put(entry); generation = "accepted-B"; });
    await expect(f.work.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp:live", requestId: "request:live", result: { stopReason: "end_turn" } })).rejects.toThrow();
    expect((f.work as unknown as { sessions: Map<string, { isClosed: boolean }> }).sessions.get("live:1")?.isClosed).toBe(true);
    expect(f.sent.filter(message => (message.body as { kind?: string }).kind === "acp_result")).toEqual([]);
  });

  it.each([false, true])("lease-loss requests defensive cancellation without stale completion (pending permission=%s)", async pendingPermission => {
    let generation = "accepted-A";
    const f = await nativeSessions(async () => undefined, () => generation);
    await (await f.claim("live"))();
    if (pendingPermission) await f.work.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp:live", requestId: "pending-permission", params: { sessionId: "acp:live", toolCall: { toolCallId: "tool", title: "Write" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    generation = "";
    await expect(f.work.drainSessions("lease_lost")).rejects.toThrow();
    expect(f.runner.cancel).toHaveBeenCalledWith("acp:live");
    expect(f.runner.closeSession).not.toHaveBeenCalled();
    const owners = f.work as unknown as { sessions: Map<string, unknown>; channelOwners: Map<string, unknown> };
    expect(owners.sessions.has("live:1")).toBe(true);
    expect(owners.channelOwners.has("session:cloud-session")).toBe(true);
    expect(reports(f.sent)).toEqual([]);
  });

  it("removes denied bootstrap ownership so the next assignment on its channel reaches the new runner", async () => {
    const f = await nativeSessions(async target => { if (target.id === "denied") throw new Error("Core readiness denied"); });
    await (await f.claim("denied"))();
    expect(reports(f.sent).map(report => report.result?.class)).toEqual(["failed"]);
    expect(f.sent.filter(message => (message.body as { kind?: string }).kind === "session_closed")).toHaveLength(0);
    await (await f.claim("next"))();
    await f.prompt("next");
    expect(f.runner.prompt).toHaveBeenCalledWith("acp:next", "request:next", expect.objectContaining({ sessionId: "acp:next" }));
    await f.work.drainSessions("drain");
  });

  it("reserves the logical channel before readiness and rejects a concurrent bootstrap without disturbing its owner", async () => {
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const register = vi.fn(async target => { if (target.id === "first") await ready; });
    const f = await nativeSessions(register);
    const first = (await f.claim("first"))();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    await (await f.claim("overlap"))();
    expect(register).toHaveBeenCalledTimes(1);
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(reports(f.sent)).toEqual([expect.objectContaining({ assignmentId: "overlap", result: expect.objectContaining({ class: "failed" }) })]);
    finish();
    await first;
    await f.prompt("first");
    expect(f.runner.prompt).toHaveBeenCalledWith("acp:first", "request:first", expect.anything());
    expect(f.runner.cancel).not.toHaveBeenCalled();
    await f.work.drainSessions("drain");
  });

  it("preserves a cancellation already closing a bootstrap instead of reporting a competing failure", async () => {
    let finishReady!: () => void, finishClose!: () => void;
    const waitingReady = new Promise<void>(resolve => { finishReady = resolve; });
    const waitingClose = new Promise<void>(resolve => { finishClose = resolve; });
    const register = vi.fn(async () => waitingReady);
    const f = await nativeSessions(register);
    vi.mocked(f.runner.closeSession).mockImplementationOnce(async () => waitingClose);
    const dispatch = (await f.claim("cancelled"))();
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
    const cancel = f.work.cancelLocalSession("cancelled", 1);
    await vi.waitFor(() => expect(f.runner.closeSession).toHaveBeenCalledOnce());
    finishReady();
    await vi.waitFor(() => expect(f.runner.closeSession).toHaveBeenCalledTimes(2));
    await new Promise<void>(resolve => setImmediate(resolve));
    finishClose();
    await Promise.all([dispatch, cancel]);
    expect(reports(f.sent).map(report => report.result?.class)).toEqual(["cancelled"]);
  });

  it.each([
    ["instance_mismatch", { instanceId: "inst-2" }],
    ["workspace_mismatch", { workspaceId: "ws-9" }],
    ["checkout_owned_elsewhere", { source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "inst-9", workspaceRef: "ref" } }],
    ["expired", { expiresAt: "2026-09-05T00:00:00Z" }],
    ["role_not_advertised", { kind: "qa", agentRoute: { requiredRole: "qa", agentId: "codex" } }],
    ["agent_unavailable", { agentRoute: { requiredRole: "generator", agentId: "claude-code" } }],
    ["unknown_kind", { kind: "mystery" }],
  ])("rejects %s", async (rejection, patch) => {
    const { work, sent } = await orchestrator();
    const mutated = { ...assignment, ...(patch as object) } as RemoteWorkAssignment;
    await work.onAssignmentMessage({ assignments: [mutated] });
    expect(sent.filter((message) => "claimId" in (message.body as object))).toHaveLength(0);
    if (rejection !== "unknown_kind") expect(work.validate(mutated)).toBe(rejection);
  });

  it("rejects work while draining, under a drain_only lease, or before reconciliation", async () => {
    const draining = await orchestrator({ draining: () => true });
    expect(draining.work.validate(assignment)).toBe("draining");
    const pending = await orchestrator({ reconciliationComplete: () => false });
    expect(pending.work.validate(assignment)).toBe("reconciliation_pending");
    const { work, lease } = await orchestrator();
    lease.set({ lease: "2026-09-06T00:00:00Z", mode: "drain_only", expiresAt: "2026-09-07T00:00:00Z", drainDeadline: "2026-09-07T00:00:00Z", issuedAt: "2026-09-06T00:00:00Z", workspaceId: "ws-1" });
    expect(work.validate(assignment)).toBe("lease_invalid");
  });

  it("rejects a stale attempt already journaled", async () => {
    const { work, journal } = await orchestrator();
    await journal.assignments.put({ assignmentId: "asg-1", attempt: 2, claimId: "c", kind: "delivery", placementId: "p", workspaceId: "ws-1", agentId: "codex", state: "running", recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: "2026-09-06T00:00:00Z", latestResumeAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" });
    expect(work.validate(assignment)).toBe("stale_attempt");
  });
});
