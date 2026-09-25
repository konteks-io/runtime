import type { SupervisorJournal } from "../state/journal.js";
import { CancellationInboxRecordSchema, type CancellationInboxRecord } from "../state/cancellation-inbox.js";
import type { CancelDirective } from "@konteks/remote-common";
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
     * the cancelled terminal (WS2-159). Idempotent once reported. */
    cancelDelivery?: (directive: CancelDirective) => Promise<void>;
  }) {}

  /** Called immediately after fsync. Never waits for ACP before receipt I/O. */
  notify(candidate: CancellationInboxRecord): void {
    if (this.stopped || this.inFlight.size >= 8) return;
    const parsed = CancellationInboxRecordSchema.safeParse(candidate);
    if (!parsed.success) return;
    const record = parsed.data;
    if (this.inFlight.has(record.intent.intentId)) return;
    const retained = this.deps.journal.cancellations.pending().find(value => value.intent.intentId === record.intent.intentId);
    if (!retained || retained.intentDigest !== record.intentDigest || retained.receivedAt !== record.receivedAt) return;
    let owner: ReplayOwner | null;
    try { owner = this.deps.owner(); } catch { return; }
    if (!owner) return;
    const { assignmentId, attempt } = record.intent.directive;
    const assertCurrent = () => {
      owner.assertCurrent();
      const start = this.deps.journal.execution.start(assignmentId, attempt);
      const admission = this.deps.journal.execution.admission(assignmentId, attempt);
      const entry = this.deps.journal.assignments.get(`${assignmentId}:${attempt}`);
      if (!start || !admission || admission.executionGeneration !== start.admission.executionGeneration ||
          owner.instanceId !== record.intent.instanceId || owner.workspaceId !== record.intent.tenantId ||
          admission.instanceId !== owner.instanceId || admission.workspaceId !== owner.workspaceId ||
          admission.runnerIncarnation !== owner.runnerIncarnation || admission.claimId !== record.intent.claimId ||
          entry?.claimId !== record.intent.claimId || !cancellationNamesAssignment(start.assignment, record.intent.sessionId)) {
        throw new Error("Retained cancellation has no exact current execution owner");
      }
    };
    try {
      assertCurrent();
      // Reserve the slot before calling a synchronous fence (which can trigger
      // callbacks). The Work owner retains its own failed-stop retry evidence.
      this.inFlight.set(record.intent.intentId, Promise.resolve());
      const entry = this.deps.journal.assignments.get(`${assignmentId}:${attempt}`);
      const delivery = isDeliveryCancellation(this.deps.journal.execution.start(assignmentId, attempt)!.assignment);
      // A reported delivery turn is already stopped; nothing is left to do.
      if (delivery && (entry?.reports.terminalSequence !== undefined || !this.deps.cancelDelivery)) {
        this.inFlight.delete(record.intent.intentId);
        return;
      }
      const stop = delivery ? this.deps.cancelDelivery!(record.intent.directive) : this.deps.stopForRecovery(assignmentId, attempt);
      const task = stop.then(() => { assertCurrent(); }).catch(() => {
        // Unresolved stays durable; never erase, report terminal or infer stop.
      }).finally(() => { this.inFlight.delete(record.intent.intentId); });
      this.inFlight.set(record.intent.intentId, task);
    } catch {
      this.inFlight.delete(record.intent.intentId);
    }
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
