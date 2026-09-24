import { randomUUID } from "node:crypto";
import { terminalOperationDispositions } from '../state/operation-dispositions.js';
import { AssignmentReportSchema, ReportAckSchema, createLogger, jcsDigest, reportPayloadDigest, type AssignmentReport, type AssignmentRequestReference, type Clock, type JsonValue, type Logger, type ReportAck } from "@konteks/remote-common";
import type { SupervisorJournal } from "../state/journal.js";
import type { DurableOutbox, OutboxItem } from "../state/outbox.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { coreChannelId } from "../relay/channel-ids.js";
import type { AssignmentSender } from "./assignment-sender.js";

/**
 * The sender side of the D125 report protocol. Per claim: mint a `reportId`,
 * a strictly consecutive `reportSequence`, and a `payloadDigest`; journal the
 * report in the outbox BEFORE sending; send in order; resend unchanged until
 * `accepted`/`duplicate`; resend from `durableWatermark + 1` on
 * `sequence_gap`; halt the claim into `recovery_required(assignment_conflict)`
 * on `payload_conflict` or `report_id_reused`.
 *
 * `operation_conflict` on a terminal report means Core refused to close the
 * claim that way while an operation it admitted is unresolved (for example,
 * a duplicate prompt the runtime journaled `interrupted`). Core recorded
 * nothing for that report, so once the session is confirmed stopped the claim
 * reports `interrupted(not_resumable)` under the same sequence, retried with
 * exponential backoff until it is durable. The claim frees itself instead of
 * halting until its deadline.
 */
export interface ReportSenderOptions {
  journal: SupervisorJournal;
  outbox: DurableOutbox;
  transport: TransportManager;
  assignmentSender?: AssignmentSender;
  clock: Clock;
  instanceId: () => string;
  /** Delivery authority, not permission to append a recovery report locally. */
  canSend: () => boolean;
  onConflict: (assignmentId: string, attempt: number) => Promise<void>;
  onTerminalDurable: (assignmentId: string, attempt: number) => Promise<void>;
  /**
   * Resolves only once the claim's session is stopped, so no prompt of it can
   * still run. Absent, an `operation_conflict` halts the claim as before.
   */
  confirmStopped?: (assignmentId: string, attempt: number) => Promise<void>;
  /** Test seam for the resubmission backoff. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

const RESUBMIT_BASE_DELAY_MS = 500;
const RESUBMIT_MAX_DELAY_MS = 30_000;
const STOP_CONFIRMED_RESULT = { class: "interrupted" as const, reason: "not_resumable" as const };

export type ReportDraft = Omit<AssignmentReport, "reportId" | "reportSequence" | "payloadDigest" | "reportedAt" | "assignmentId" | "attempt" | "claimId">;

export function reportGroup(assignmentId: string, attempt: number, claimId: string): string {
  return `report:${assignmentId}:${attempt}:${claimId}`;
}

export class ReportSender {
  private readonly logger: Logger;
  private retryFlight: Promise<void> | null = null;
  private readonly resubmits = new Map<string, Promise<void>>();
  /** Halted claims this process already tried to heal; never twice per process. */
  private readonly healed = new Set<string>();

  constructor(private readonly options: ReportSenderOptions) {
    this.logger = options.logger ?? createLogger({ name: "report-sender" });
  }

  /** A terminal pointer alone cannot prove the report append survived a crash. */
  hasDurableTerminalReport(assignmentId: string, attempt: number, claimId: string): boolean {
    return this.queuedTerminalReport(assignmentId, attempt, claimId) !== undefined || this.acknowledgedTerminalReport(assignmentId, attempt, claimId) !== undefined;
  }

  /** The actual received ACK, validated on journal write/load; never synthesized. */
  acknowledgedTerminalReport(assignmentId: string, attempt: number, claimId: string): ReportAck | undefined {
    const entry = this.options.journal.assignments.get(`${assignmentId}:${attempt}`);
    return entry?.claimId === claimId ? entry.reports.terminalAck : undefined;
  }

  /** Actual saved result content, only with a queued report or a genuine ACK. */
  terminalResult(assignmentId: string, attempt: number, claimId: string): AssignmentReport["result"] {
    const queued = this.queuedTerminalReport(assignmentId, attempt, claimId);
    if (queued) return queued.result;
    if (!this.acknowledgedTerminalReport(assignmentId, attempt, claimId)) return undefined;
    return this.options.journal.assignments.get(`${assignmentId}:${attempt}`)?.reports.terminalResult;
  }

  reportForControllerDirective(assignmentId: string, attempt: number, claimId: string, directiveId: string): { reportId: string; result: NonNullable<AssignmentReport["result"]> } | undefined {
    const entry = this.options.journal.assignments.get(`${assignmentId}:${attempt}`);
    if (!entry || entry.claimId !== claimId || entry.reports.terminalControllerDirectiveId !== directiveId) return undefined;
    const queued = this.queuedTerminalReport(assignmentId, attempt, claimId);
    if (queued?.controllerDirectiveId === directiveId && queued.result) return { reportId: queued.reportId, result: queued.result };
    const ack = this.acknowledgedTerminalReport(assignmentId, attempt, claimId), result = entry.reports.terminalResult;
    return ack && result ? { reportId: ack.acknowledged.reportId, result } : undefined;
  }

  /** Exact detached outbox evidence. A watermark is never a report or an ACK. */
  queuedTerminalReport(assignmentId: string, attempt: number, claimId: string): AssignmentReport | undefined {
    const entry = this.options.journal.assignments.get(`${assignmentId}:${attempt}`);
    if (!entry || entry.claimId !== claimId || entry.reports.terminalSequence === undefined) return undefined;
    const sequence = entry.reports.terminalSequence;
    const group = reportGroup(assignmentId, attempt, claimId);
    const item = this.options.outbox.groupFrom(group, sequence).find(candidate => candidate.order === sequence && candidate.key === `${group}:${sequence}`);
    if (!item || item.channel !== "assignment") return undefined;
    const parsed = AssignmentReportSchema.safeParse(item.body);
    if (!parsed.success) return undefined;
    const report = parsed.data;
    return report.terminal && report.result !== undefined && report.assignmentId === assignmentId && report.attempt === attempt && report.claimId === claimId && report.reportId === item.id && report.reportSequence === sequence &&
      report.result.terminalResultHash === entry.terminalResultHash && report.payloadDigest === reportPayloadDigest(report as unknown as { [key: string]: JsonValue }) ? report : undefined;
  }

  /** Mint, journal, and send the next report for a claim. */
  async submit(args: { assignmentId: string; attempt: number; claimId: string; draft: ReportDraft }): Promise<AssignmentReport> {
    const key = `${args.assignmentId}:${args.attempt}`;
    const entry = this.options.journal.assignments.get(key);
    if (!entry) throw new Error(`no journal entry for ${key}`);
    if (entry.reports.terminalSequence !== undefined) throw new Error(`claim ${key} already has a terminal report`);
    if (args.draft.terminal && ((entry.kind === "planning") !== (args.draft.controllerDirectiveId !== undefined))) throw new Error("Planning terminal authority must come from exactly one controller directive");
    if (!args.draft.terminal && args.draft.controllerDirectiveId !== undefined) throw new Error("A progress report cannot carry a controller directive");
    const reportSequence = entry.reports.nextSequence;
    const reportId = randomUUID();
    if (args.draft.operationDispositions !== undefined) throw new Error('Operation dispositions must come from the durable native journal');
    // Every native ACP-backed terminal must settle the operations admitted for
    // its claim. Delivery uses the same ACP operation journal as assistant
    // execution; omitting its dispositions leaves Core's execution open even
    // after the generated output was accepted, which blocks all successors.
    const dispositions = args.draft.terminal
      ? await terminalOperationDispositions(this.options.journal, args.assignmentId, args.attempt, args.claimId) : [];
    // Dispositions bind to an execution Core recorded with its ACP session, so
    // the report must name that session. A recovery-authored terminal (which
    // has no live session to ask) takes it from the claim's durable journal
    // entry; without it Core refuses the evidence and the report retries forever.
    const acpSessionRef = args.draft.acpSessionRef ?? (dispositions.length ? entry.acpSessionRef : undefined);
    const base = { assignmentId: args.assignmentId, attempt: args.attempt, claimId: args.claimId, reportId, reportSequence, ...args.draft,
      ...(acpSessionRef ? { acpSessionRef } : {}),
      ...(dispositions.length ? { operationDispositions: dispositions } : {}) } as Omit<AssignmentReport, "payloadDigest" | "reportedAt">;
    const payloadDigest = reportPayloadDigest(base as unknown as { [key: string]: JsonValue });
    const report = AssignmentReportSchema.parse({ ...base, payloadDigest, reportedAt: this.options.clock.nowIso() });
    await this.options.journal.assignments.put({
      ...entry,
      state: report.terminal ? "terminal_pending_report" : entry.state,
      ...(report.terminal && report.result ? { terminalResultHash: report.result.terminalResultHash } : {}),
      reports: { ...entry.reports, nextSequence: reportSequence + 1, ...(report.terminal ? { terminalSequence: reportSequence } : {}), ...(report.controllerDirectiveId ? { terminalControllerDirectiveId: report.controllerDirectiveId } : {}) },
      updatedAt: report.reportedAt,
    });
    await this.options.outbox.enqueue({
      id: reportId,
      channel: "assignment",
      key: `${reportGroup(args.assignmentId, args.attempt, args.claimId)}:${reportSequence}`,
      group: reportGroup(args.assignmentId, args.attempt, args.claimId),
      order: reportSequence,
      body: report,
      createdAt: report.reportedAt,
    });
    await this.flushGroup(reportGroup(args.assignmentId, args.attempt, args.claimId));
    return report;
  }

  /** Send the head of a group (only one report of a claim is in flight at a time). */
  async flushGroup(group: string): Promise<void> {
    if (!this.options.canSend()) return;
    const head = this.options.outbox.heads("assignment").find((item) => item.group === group);
    if (!head) return;
    // The head is already in flight: a second submit must not resend it; the
    // ack (or a restart's flushAll) is what moves the group forward.
    if (head.attempts > 0) return;
    await this.sendItem(head);
  }

  /** Resend every unacked report after restart or transport switch. */
  async flushAll(): Promise<void> {
    for (const head of this.options.outbox.heads("assignment")) {
      if (!head.group.startsWith("report:")) continue;
      if (!await this.sendItem(head)) return;
    }
  }

  /**
   * Bounded maintenance retry for a lost terminal/progress ACK. Protocol 1.0
   * has no retained AssignmentSender, so reconnect-only retries can otherwise
   * strand a completed run forever. The immutable outbox item is resent and
   * Core's report endpoint remains idempotent by reportId/sequence/digest.
   */
  retryDue(retryIntervalMs = 5_000, maxItems = 4): Promise<void> {
    if (this.retryFlight) return this.retryFlight;
    const flight = (async () => {
      const now = this.options.clock.coreNow();
      if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw new Error("report_retry_budget_invalid");
      const due = this.options.outbox.heads("assignment")
        .filter(head => head.group.startsWith("report:"))
        .sort((left, right) => {
          const leftAt = left.lastAttemptAt ? Date.parse(left.lastAttemptAt) : Number.NEGATIVE_INFINITY;
          const rightAt = right.lastAttemptAt ? Date.parse(right.lastAttemptAt) : Number.NEGATIVE_INFINITY;
          return leftAt - rightAt;
        });
      let attempted = 0;
      for (const head of due) {
        const lastAttempt = head.lastAttemptAt ? Date.parse(head.lastAttemptAt) : Number.NEGATIVE_INFINITY;
        if (head.attempts > 0 && Number.isFinite(lastAttempt) && now - lastAttempt < retryIntervalMs) continue;
        if (attempted >= maxItems) break;
        attempted += 1;
        if (!await this.sendItem(head)) return;
      }
    })();
    this.retryFlight = flight;
    void flight.finally(() => { if (this.retryFlight === flight) this.retryFlight = null; }).catch(() => undefined);
    return flight;
  }

  private async sendItem(item: OutboxItem, retryAfter?: AssignmentRequestReference): Promise<boolean> {
    if (!this.options.canSend()) return false;
    const assertOriginal = this.options.assignmentSender?.captureAuthority() ?? (() => undefined);
    await this.options.outbox.markAttempt(item.id, this.options.clock.nowIso());
    assertOriginal();
    // Ownership/recovery can change while the durable append is pending.
    if (!this.options.canSend()) return false;
    const reference = this.options.assignmentSender ? await this.options.assignmentSender.prepareReport(AssignmentReportSchema.parse(item.body), item, retryAfter) : undefined;
    assertOriginal();
    if (!this.options.canSend()) return false;
    // An ACK may retire the domain item during allocation. Its stream-owned
    // immutable operation remains scheduled by Work's existing maintenance tick;
    // outbox absence never deletes a slot or proves it was unsent.
    if (!this.options.outbox.all("assignment").some(current => current.id === item.id && current.key === item.key)) return false;
    if (reference && this.options.assignmentSender) {
      // Never let a newly prepared report overtake an older durable stream slot.
      this.options.assignmentSender.scheduleRetained(message => { assertOriginal(); this.options.transport.send(message); });
    } else {
      this.options.transport.send({ channel: "assignment", channelId: coreChannelId("assignment", this.options.instanceId()), body: item.body as AssignmentReport });
    }
    return true;
  }

  /** Apply a `ReportAck` verdict exactly as the D125 sender-side table prescribes. */
  async onAck(candidate: ReportAck, reference?: AssignmentRequestReference): Promise<void> {
    const ack = ReportAckSchema.parse(candidate);
    const key = `${ack.assignmentId}:${ack.attempt}`;
    const entry = this.options.journal.assignments.get(key);
    if (!entry || entry.claimId !== ack.claimId) {
      this.logger.warn({ assignmentId: ack.assignmentId }, "report ack for an unknown claim; ignored");
      return;
    }
    const group = reportGroup(ack.assignmentId, ack.attempt, ack.claimId);
    const ackedKey = `${group}:${ack.acknowledged.reportSequence}`;
    const watermark = Math.max(entry.reports.durableWatermark, ack.durableWatermark);
    const advance = async (): Promise<void> => {
      await this.options.journal.assignments.put({ ...entry, reports: { ...entry.reports, durableWatermark: watermark }, updatedAt: this.options.clock.nowIso() });
    };
    switch (ack.outcome) {
      case "accepted":
      case "duplicate": {
        const item = this.options.outbox.groupFrom(group, ack.acknowledged.reportSequence).find(value => value.key === ackedKey && value.id === ack.acknowledged.reportId && value.order === ack.acknowledged.reportSequence && value.channel === "assignment");
        const parsed = AssignmentReportSchema.safeParse(item?.body);
        const report = parsed.success ? parsed.data : undefined;
        const saved = this.acknowledgedTerminalReport(ack.assignmentId, ack.attempt, ack.claimId);
        const savedMatch = saved?.acknowledged.reportId === ack.acknowledged.reportId && saved.acknowledged.reportSequence === ack.acknowledged.reportSequence;
        if (ack.durableWatermark < ack.acknowledged.reportSequence) return;
        if (!savedMatch && (!report || report.reportId !== ack.acknowledged.reportId || report.reportSequence !== ack.acknowledged.reportSequence ||
          report.assignmentId !== ack.assignmentId || report.attempt !== ack.attempt || report.claimId !== ack.claimId ||
          report.payloadDigest !== reportPayloadDigest(report as unknown as { [key: string]: JsonValue }))) return;
        const terminal = savedMatch || report?.terminal === true;
        if (terminal && (ack.terminalSequence !== ack.acknowledged.reportSequence || ack.terminalSequence !== entry.reports.terminalSequence ||
          (!savedMatch && !this.queuedTerminalReport(ack.assignmentId, ack.attempt, ack.claimId)))) return;
        // Persist the original received terminal ACK before retiring its only
        // report evidence. Retry after either crash window keeps this first ACK.
        await this.options.journal.assignments.update(key, current => {
          if (!current || current.claimId !== ack.claimId) throw new Error("Report ACK claim changed before commit");
          return { ...current, ...(terminal ? { state: "completed" as const } : {}),
            reports: { ...current.reports, durableWatermark: Math.max(current.reports.durableWatermark, ack.durableWatermark), ...(terminal ? { terminalAck: current.reports.terminalAck ?? ack, terminalResult: report?.result ?? current.reports.terminalResult } : {}) }, updatedAt: this.options.clock.nowIso() };
        });
        await this.options.outbox.ackKey(ackedKey);
        if (terminal) {
          await this.options.onTerminalDurable(ack.assignmentId, ack.attempt);
        } else {
          await this.flushGroup(group);
        }
        return;
      }
      case "sequence_gap":
        await advance();
        for (const item of this.options.outbox.groupFrom(group, ack.durableWatermark + 1)) {
          if (!await this.sendItem(item, item.id === ack.acknowledged.reportId ? reference : undefined)) return;
        }
        return;
      case "out_of_order":
        // The sequence is already occupied durably; this retry record is stale.
        await this.options.outbox.ackKey(ackedKey);
        await advance();
        await this.flushGroup(group);
        return;
      case "terminal_winner_exists":
        await this.options.outbox.removeGroup(group);
        await this.options.journal.assignments.put({ ...entry, state: "completed", updatedAt: this.options.clock.nowIso() });
        return;
      case "operation_conflict":
        if (await this.reopenForStopConfirmedTerminal(ack.assignmentId, ack.attempt, ack.claimId, ack.acknowledged)) return;
        // Not a terminal we can settle as stop-confirmed: halt as before.
        // falls through
      case "payload_conflict":
      case "report_id_reused":
        this.logger.error({ assignmentId: ack.assignmentId, outcome: ack.outcome }, "report conflict: halting the claim into recovery_required(assignment_conflict)");
        await this.options.outbox.removeGroup(group);
        await this.options.journal.assignments.put({ ...entry, state: "recovery_required", recoveryReason: "assignment_conflict", updatedAt: this.options.clock.nowIso() });
        await this.options.onConflict(ack.assignmentId, ack.attempt);
        return;
      case "claim_unknown":
        await this.options.outbox.removeGroup(group);
        await this.options.journal.assignments.put({ ...entry, state: "recovery_required", recoveryReason: "assignment_conflict", updatedAt: this.options.clock.nowIso() });
        return;
      case "schema_invalid":
        this.logger.error({ assignmentId: ack.assignmentId }, "Core rejected a report as schema_invalid; halting the claim");
        await this.options.outbox.removeGroup(group);
        await this.options.journal.assignments.put({ ...entry, state: "recovery_required", recoveryReason: "assignment_conflict", updatedAt: this.options.clock.nowIso() });
        return;
    }
  }

  /**
   * A claim halted into recovery_required(assignment_conflict) whose terminal
   * report Core never made durable (halted before stop-confirmed resubmission
   * existed, or by a crash mid-resubmission) heals on the maintenance cadence:
   * once per process its refused terminal is taken back and the claim reports
   * interrupted(not_resumable) once its session is stopped, with backoff. Core
   * stored nothing for an operation_conflict refusal; for a genuine integrity
   * conflict it refuses again and the claim halts as before (WS2-153).
   */
  async healHaltedConflicts(): Promise<void> {
    if (!this.options.confirmStopped || !this.options.canSend()) return;
    for (const entry of this.options.journal.assignments.all()) {
      const key = `${entry.assignmentId}:${entry.attempt}`;
      const terminalSequence = entry.reports.terminalSequence;
      if (entry.state !== "recovery_required" || entry.recoveryReason !== "assignment_conflict" || entry.kind === "planning" ||
        terminalSequence === undefined || entry.reports.durableWatermark >= terminalSequence ||
        this.healed.has(key) || this.resubmits.has(key)) continue;
      this.healed.add(key);
      await this.options.outbox.removeGroup(reportGroup(entry.assignmentId, entry.attempt, entry.claimId));
      await this.options.journal.assignments.update(key, current => {
        if (!current || current.claimId !== entry.claimId || current.state !== "recovery_required") throw new Error("Halted claim changed before healing");
        const { terminalSequence: _sequence, terminalResult: _result, ...reports } = current.reports;
        const { terminalResultHash: _hash, ...rest } = current;
        return { ...rest, reports: { ...reports, nextSequence: terminalSequence }, updatedAt: this.options.clock.nowIso() };
      });
      this.logger.warn({ assignmentId: entry.assignmentId, attempt: entry.attempt, reportSequence: terminalSequence },
        "healing a claim halted over a refused terminal report; reporting interrupted once the session is stopped");
      this.resubmitStopConfirmed(entry.assignmentId, entry.attempt, entry.claimId,
        entry.acpSessionRef ? { acpSessionRef: entry.acpSessionRef } : {});
    }
  }

  /** In-flight stop-confirmed resubmissions (tests and shutdown observe them). */
  pendingResubmissions(): Promise<void>[] {
    return [...this.resubmits.values()];
  }

  /**
   * Take back a terminal report Core refused with `operation_conflict`. Core's
   * refusal recorded no report row and no terminal, so the sequence it held is
   * free again. Returns false when this is not such a report (or the claim was
   * already reported stop-confirmed), and the caller halts the claim.
   */
  private async reopenForStopConfirmedTerminal(assignmentId: string, attempt: number, claimId: string,
    acknowledged: { reportId: string; reportSequence: number }): Promise<boolean> {
    if (!this.options.confirmStopped) return false;
    const rejected = this.queuedTerminalReport(assignmentId, attempt, claimId);
    if (!rejected || rejected.reportId !== acknowledged.reportId || rejected.reportSequence !== acknowledged.reportSequence ||
      rejected.controllerDirectiveId !== undefined ||
      (rejected.result?.class === STOP_CONFIRMED_RESULT.class && rejected.result.reason === STOP_CONFIRMED_RESULT.reason)) return false;
    const key = `${assignmentId}:${attempt}`;
    const group = reportGroup(assignmentId, attempt, claimId);
    await this.options.outbox.removeGroup(group);
    await this.options.journal.assignments.update(key, current => {
      if (!current || current.claimId !== claimId) throw new Error("Report conflict claim changed before reopening");
      const { terminalSequence: _sequence, terminalResult: _result, ...reports } = current.reports;
      const { terminalResultHash: _hash, ...rest } = current;
      return { ...rest, reports: { ...reports, nextSequence: rejected.reportSequence }, updatedAt: this.options.clock.nowIso() };
    });
    this.logger.warn({ assignmentId, attempt, reportSequence: rejected.reportSequence, refusedClass: rejected.result?.class,
      outcome: "operation_conflict" }, "terminal report refused over an unresolved operation; reporting interrupted once the session is stopped");
    this.resubmitStopConfirmed(assignmentId, attempt, claimId, rejected);
    return true;
  }

  private resubmitStopConfirmed(assignmentId: string, attempt: number, claimId: string,
    rejected: Pick<AssignmentReport, "usage" | "acpSessionRef">): void {
    const key = `${assignmentId}:${attempt}`;
    if (this.resubmits.has(key)) return;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
    const task = (async () => {
      for (let failures = 0; ; failures += 1) {
        const entry = this.options.journal.assignments.get(key);
        // Someone else settled the claim (a restart's recovery, a cancel): done.
        if (!entry || entry.claimId !== claimId || entry.reports.terminalSequence !== undefined) return;
        try {
          await this.options.confirmStopped!(assignmentId, attempt);
          await this.submit({ assignmentId, attempt, claimId, draft: { terminal: true,
            result: { ...STOP_CONFIRMED_RESULT, terminalResultHash: jcsDigest(STOP_CONFIRMED_RESULT) },
            ...(rejected.usage ? { usage: rejected.usage } : {}),
            ...(rejected.acpSessionRef ? { acpSessionRef: rejected.acpSessionRef } : {}) } });
          return;
        } catch (error) {
          const delayMs = Math.min(RESUBMIT_MAX_DELAY_MS, RESUBMIT_BASE_DELAY_MS * 2 ** Math.min(failures, 16));
          this.logger.warn({ assignmentId, attempt, failures: failures + 1, delayMs,
            code: error instanceof Error && "code" in error ? String((error as { code: unknown }).code).slice(0, 64) : "unexpected_error" },
          "stop-confirmed terminal report not yet submitted; retrying");
          await sleep(delayMs);
        }
      }
    })();
    this.resubmits.set(key, task);
    void task.finally(() => { if (this.resubmits.get(key) === task) this.resubmits.delete(key); }).catch(() => undefined);
  }
}
