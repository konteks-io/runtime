import type { SupervisorJournal } from "../state/journal.js";
import { CancellationInboxRecordSchema, type CancellationInboxRecord } from "../state/cancellation-inbox.js";
import { allEqual, type CancelDirective } from "@konteks/remote-common";
import { cancellationNamesAssignment, isDeliveryCancellation } from "./cancellation-receiver.js";

interface ReplayOwner {
  instanceId: string;
  workspaceId: string;
  runnerIncarnation: string;
  assertCurrent(): void;
}

/** Bounded replay of retained, previously verified cancellation facts. Starting
 * a stop is not proving quiescence: all records remain in the inbox, including
 * failed/unknown stop attempts. Qualified finalization is a separate owner.
 */
export class CancellationReplay {
  private readonly inFlight = new Map<string, Promise<void>>();
  private cursor = 0;
  private stopped = false;
  constructor(private readonly deps: {
    journal: SupervisorJournal;
    owner: () => ReplayOwner | null;
    /** Must synchronously fence the exact attempt before returning its task. */
    stopForRecovery: (assignmentId: string, attempt: number) => Promise<void>;
    /** A native delivery turn's signed cancel: close its session and report
     * the cancelled terminal. Idempotent once reported. */
    cancelDelivery?: (directive: CancelDirective) => Promise<void>;
  }) {}

  /** Called immediately after fsync. Never waits for ACP before receipt I/O. */
  notify(candidate: CancellationInboxRecord): void {
    const record = this.admissible(candidate);
    if (!record) return;
    let owner: ReplayOwner | null;
    try { owner = this.deps.owner(); } catch { return; }
    if (!owner) return;
    this.replay(record, owner);
  }

  /** The candidate, when it is still retained unchanged, has no stop in flight, and a stop slot is free. */
  private admissible(candidate: CancellationInboxRecord): CancellationInboxRecord | null {
    if (this.stopped || this.inFlight.size >= 8) return null;
    const parsed = CancellationInboxRecordSchema.safeParse(candidate);
    if (!parsed.success || this.inFlight.has(parsed.data.intent.intentId)) return null;
    const record = parsed.data;
    const retained = this.deps.journal.cancellations.pending().find(value => value.intent.intentId === record.intent.intentId);
    return retained && retained.intentDigest === record.intentDigest && retained.receivedAt === record.receivedAt ? record : null;
  }

  private replay(record: CancellationInboxRecord, owner: ReplayOwner): void {
    const id = record.intent.intentId;
    const assertCurrent = () => this.assertOwned(record, owner);
    try {
      assertCurrent();
      // Reserve the slot before calling a synchronous fence (which can trigger
      // callbacks). The Work owner retains its own failed-stop retry evidence.
      this.inFlight.set(id, Promise.resolve());
      const stop = this.stopFor(record);
      if (!stop) {
        this.inFlight.delete(id);
        return;
      }
      const task = stop.then(() => { assertCurrent(); }).catch(() => {
        // Unresolved stays durable; never erase, report terminal or infer stop.
      }).finally(() => { this.inFlight.delete(id); });
      this.inFlight.set(id, task);
    } catch {
      this.inFlight.delete(id);
    }
  }

  /** The stop to start; null for a delivery turn that already reported, which is already stopped. */
  private stopFor(record: CancellationInboxRecord): Promise<void> | null {
    const { assignmentId, attempt } = record.intent.directive;
    const entry = this.deps.journal.assignments.get(`${assignmentId}:${attempt}`);
    const delivery = isDeliveryCancellation(this.deps.journal.execution.start(assignmentId, attempt)!.assignment);
    if (delivery && (entry?.reports.terminalSequence !== undefined || !this.deps.cancelDelivery)) return null;
    return delivery ? this.deps.cancelDelivery!(record.intent.directive) : this.deps.stopForRecovery(assignmentId, attempt);
  }

  private assertOwned(record: CancellationInboxRecord, owner: ReplayOwner): void {
    owner.assertCurrent();
    const { assignmentId, attempt } = record.intent.directive;
    const start = this.deps.journal.execution.start(assignmentId, attempt);
    const admission = this.deps.journal.execution.admission(assignmentId, attempt);
    const entry = this.deps.journal.assignments.get(`${assignmentId}:${attempt}`);
    const owned = start && admission && allEqual([
      [admission.executionGeneration, start.admission.executionGeneration],
      [owner.instanceId, record.intent.instanceId],
      [owner.workspaceId, record.intent.tenantId],
      [admission.instanceId, owner.instanceId],
      [admission.workspaceId, owner.workspaceId],
      [admission.runnerIncarnation, owner.runnerIncarnation],
      [admission.claimId, record.intent.claimId],
      [entry?.claimId, record.intent.claimId],
    ]) && cancellationNamesAssignment(start.assignment, record.intent.sessionId);
    if (!owned) throw new Error("Retained cancellation has no exact current execution owner");
  }

  tick(): void {
    if (this.stopped) return;
    const records = this.deps.journal.cancellations.pending();
    if (!records.length) return;
    // Round-robin prevents unavailable historical owners from starving later
    // cancellations. Both simultaneous stops and scanning per tick are bounded.
    for (let n = 0; n < Math.min(8, records.length); n++) {
      this.notify(records[this.cursor % records.length]!);
      this.cursor = (this.cursor + 1) % records.length;
    }
  }

  /** Drains scheduling tasks only; this is explicitly not a quiescence proof. */
  async settle(): Promise<void> { await Promise.all([...this.inFlight.values()]); }
  async stop(): Promise<void> { this.stopped = true; await this.settle(); }
}
