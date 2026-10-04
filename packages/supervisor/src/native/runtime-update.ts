import {
  allEqual, jcsDigest, RemoteInstanceError, RuntimeUpdateDeliveryRequestSchema, RuntimeUpdateFailureSchema,
  type RuntimeUpdateDeliveryRequest, type RuntimeUpdateFailure, type RuntimeUpdateReport,
} from "@konteks/remote-common";
import type { CoreSignatureVerifier } from "../control/core-signature.js";
import { deliveryNotCurrent } from "../control/delivery-scope.js";
import type { NativeUpdateCoordinator } from "./update.js";
import type { NativeUpdateLedger } from "./update-ledger.js";
import { RuntimeUpdateStore, type RuntimeUpdateJournal, type RuntimeUpdateRecord } from "./runtime-update-store.js";

export interface RuntimeUpdateScope {
  instanceId: string;
  tenantId: string;
  leaseId: string;
  runnerIncarnation: string;
  connectionEpoch: number;
  leaseExpiresAt: string;
  assertCurrent(): void;
}

interface RuntimeUpdateProof {
  bundleVersion: string;
  manifestDigest: string;
  runnerIncarnation: string;
  /** Verified serving release, accepted fresh recovery, and no update health probation. */
  ready: boolean;
}

/** The only remote action is a fixed, signed release replacement. A detached
 * launcher owns the existing transaction. This durable observer survives its
 * shutdown, and only the healthy successor can attest success. */
export class RuntimeUpdateReceiver {
  private lane: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private recovering: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: {
    verifier: Pick<CoreSignatureVerifier, "verifyRuntimeUpdateDelivery">;
    store: RuntimeUpdateStore;
    coordinator: () => Pick<NativeUpdateCoordinator, "apply"> | null;
    now: () => number;
    proof: () => RuntimeUpdateProof;
    readLedger: () => Promise<NativeUpdateLedger>;
    captureReportOwner: () => () => void;
    report: (report: RuntimeUpdateReport) => Promise<{ accepted: boolean }>;
    pollMs?: number;
  }) {}

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => void this.recover().catch(() => undefined);
    tick();
    this.timer = setInterval(tick, this.deps.pollMs ?? 2_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async receive(candidate: unknown, scope: RuntimeUpdateScope): Promise<void> {
    const parsed = RuntimeUpdateDeliveryRequestSchema.safeParse(candidate);
    if (!parsed.success || !this.deps.verifier.verifyRuntimeUpdateDelivery(parsed.data)) {
      throw new RemoteInstanceError("permission_denied", "Core runtime update signatures are required.");
    }
    const request = parsed.data;
    const assertCurrent = () => this.assertDelivery(request, scope);
    assertCurrent();
    return this.enqueue(() => this.receiveCurrent(request, assertCurrent));
  }

  private assertDelivery(request: RuntimeUpdateDeliveryRequest, scope: RuntimeUpdateScope): void {
    scope.assertCurrent();
    const intent = request.intent;
    if (this.stopped || !allEqual([
      [intent.instanceId, scope.instanceId], [intent.tenantId, scope.tenantId],
      [intent.leaseId, scope.leaseId], [intent.runnerIncarnation, scope.runnerIncarnation],
      [request.connectionEpoch, scope.connectionEpoch],
    ]) || deliveryNotCurrent(request, { instanceId: scope.instanceId, workspaceId: scope.tenantId,
      connectionEpoch: scope.connectionEpoch, leaseExpiresAt: scope.leaseExpiresAt }, this.deps.now(), 1_000)) {
      throw new RemoteInstanceError("recovery_required", "Runtime update delivery ownership is not current.");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lane.then(operation);
    this.lane = task.catch(() => undefined);
    return task;
  }

  private async receiveCurrent(request: RuntimeUpdateDeliveryRequest, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const assertReportOwner = this.deps.captureReportOwner();
    assertReportOwner();
    const journal = await this.deps.store.read();
    assertCurrent();
    const existing = rememberDelivery(journal, request, this.deps.now());
    if (existing) return this.deps.store.write(journal, assertCurrent);
    const ledger = await this.deps.readLedger().catch(() => null);
    const record = this.newRecord(request, ledger);
    retainRecord(journal, record, this.deps.now());
    await this.deps.store.write(journal, assertCurrent);
    if (ledger) await this.launch(journal, record, assertCurrent, assertReportOwner);
    else await this.fail(journal, record, "unavailable", assertCurrent);
    await this.flush(journal, record, assertReportOwner);
  }

  private newRecord(request: RuntimeUpdateDeliveryRequest, ledger: NativeUpdateLedger | null): RuntimeUpdateRecord {
    return { intent: request.intent, intentDigest: jcsDigest(request.intent), receivedAt: new Date(this.deps.now()).toISOString(),
      knownAttemptIds: ledger?.attempts.map(attempt => attempt.id) ?? [], state: "requested", reportPending: false };
  }

  private async launch(journal: RuntimeUpdateJournal, record: RuntimeUpdateRecord, assertCurrent: () => void, assertReportOwner: () => void): Promise<void> {
    record.state = "updating";
    record.reportPending = true;
    // Persist before any spawn so losing this process cannot permit a replay.
    await this.deps.store.write(journal, assertCurrent);
    try {
      if (!await this.confirmUpdating(journal, record, assertCurrent)) return;
      const coordinator = this.deps.coordinator();
      if (!coordinator) return this.fail(journal, record, "unavailable", assertCurrent);
      const applied = await coordinator.apply("operator", { bundleVersion: record.intent.targetBundle, manifestDigest: record.intent.manifestDigest }, assertCurrent);
      if (!applied.started) await this.fail(journal, record, refusalFailure(applied.reason), assertCurrent);
    } catch {
      await this.fail(journal, record, "update_failed", assertReportOwner);
    }
  }

  /** Core must durably recognize replacement before it can observe a successor
   * lease. A queue ACK is transport evidence and cannot replace this barrier. */
  private async confirmUpdating(journal: RuntimeUpdateJournal, record: RuntimeUpdateRecord, assertCurrent: () => void): Promise<boolean> {
    assertCurrent();
    const ack = await this.deps.report(updateReport(record)).catch(() => null);
    assertCurrent();
    if (!ack?.accepted) {
      await this.fail(journal, record, "unavailable", assertCurrent);
      return false;
    }
    record.reportPending = false;
    await this.deps.store.write(journal, assertCurrent);
    return true;
  }

  private fail(journal: RuntimeUpdateJournal, record: RuntimeUpdateRecord, failure: RuntimeUpdateFailure, assertCurrent: () => void): Promise<void> {
    record.state = "failed";
    record.failure = failure;
    record.reportPending = true;
    return this.deps.store.write(journal, assertCurrent);
  }

  recover(): Promise<void> {
    this.recovering ??= this.enqueue(async () => {
      if (this.stopped) return;
      const assertReportOwner = this.deps.captureReportOwner();
      assertReportOwner();
      const journal = await this.deps.store.read();
      const ledger = await this.deps.readLedger().catch(() => null);
      assertReportOwner();
      for (const record of journal.records) {
        await this.observe(journal, record, ledger, assertReportOwner);
        await this.flush(journal, record, assertReportOwner);
      }
    }).finally(() => { this.recovering = null; });
    return this.recovering;
  }

  private async observe(journal: RuntimeUpdateJournal, record: RuntimeUpdateRecord, ledger: NativeUpdateLedger | null, assertReportOwner: () => void): Promise<void> {
    assertReportOwner();
    if (record.state === "succeeded" || record.state === "failed") return;
    if (successorProvesUpdate(record, this.deps.proof(), ledger)) {
      record.state = "succeeded";
      record.reportPending = true;
      return this.deps.store.write(journal, assertReportOwner);
    }
    const failure = observedFailure(record, ledger, this.deps.now());
    if (failure) await this.fail(journal, record, failure, assertReportOwner);
  }

  private async flush(journal: RuntimeUpdateJournal, record: RuntimeUpdateRecord, assertReportOwner: () => void): Promise<void> {
    if (!record.reportPending || record.state === "requested") return;
    assertReportOwner();
    const report = updateReport(record);
    const ack = await this.deps.report(report).catch(() => null);
    if (!ack?.accepted) return;
    assertReportOwner();
    record.reportPending = false;
    await this.deps.store.write(journal, assertReportOwner);
  }
}

/** Exact operation replays are inert; a reused proof or operation with another
 * immutable intent is refused, including after a restart. */
function rememberDelivery(journal: RuntimeUpdateJournal, request: RuntimeUpdateDeliveryRequest, now: number): RuntimeUpdateRecord | undefined {
  const intentDigest = jcsDigest(request.intent);
  const retained = journal.records.find(record => record.intent.updateId === request.intent.updateId);
  if (retained && retained.intentDigest !== intentDigest) throw new RemoteInstanceError("permission_denied", "Runtime update identity was reused.");
  journal.deliveries = journal.deliveries.filter(delivery => Date.parse(delivery.expiresAt) > now);
  const replay = journal.deliveries.find(delivery => delivery.keyId === request.keyId && delivery.nonce === request.nonce);
  if (replay && replay.intentDigest !== intentDigest) throw new RemoteInstanceError("permission_denied", "Runtime update proof was reused.");
  if (!replay) rememberProof(journal, request, intentDigest);
  return retained;
}

function rememberProof(journal: RuntimeUpdateJournal, request: RuntimeUpdateDeliveryRequest, intentDigest: string): void {
  if (journal.deliveries.length >= 200) throw new RemoteInstanceError("temporarily_unavailable", "Runtime update admission is busy.");
  journal.deliveries.push({ keyId: request.keyId, nonce: request.nonce, intentDigest, expiresAt: request.expiresAt });
}

function retainRecord(journal: RuntimeUpdateJournal, record: RuntimeUpdateRecord, now: number): void {
  if (journal.records.length >= 50) {
    const removable = journal.records.findIndex(entry => removableRecord(entry, now));
    if (removable < 0) throw new RemoteInstanceError("temporarily_unavailable", "Runtime update reporting is busy.");
    journal.records.splice(removable, 1);
  }
  journal.records.push(record);
}

function removableRecord(record: RuntimeUpdateRecord, now: number): boolean {
  return (record.state === "succeeded" || record.state === "failed") && !record.reportPending && Date.parse(record.intent.deadlineAt) <= now;
}

function refusalFailure(reason: string | null): RuntimeUpdateFailure {
  const parsed = RuntimeUpdateFailureSchema.safeParse(reason);
  return parsed.success ? parsed.data : "unavailable";
}

function successorProvesUpdate(record: RuntimeUpdateRecord, proof: RuntimeUpdateProof, ledger: NativeUpdateLedger | null): boolean {
  if (observedAttempt(record, ledger)?.outcome !== "applied") return false;
  return proof.ready && proof.runnerIncarnation !== record.intent.runnerIncarnation && proof.bundleVersion === record.intent.targetBundle && proof.manifestDigest === record.intent.manifestDigest;
}

function observedFailure(record: RuntimeUpdateRecord, ledger: NativeUpdateLedger | null, now: number): RuntimeUpdateFailure | null {
  const attempt = observedAttempt(record, ledger);
  if (attempt?.outcome === "failed" || attempt?.outcome === "rolled_back") return "update_failed";
  return now >= Date.parse(record.intent.deadlineAt) ? "timed_out" : null;
}

function observedAttempt(record: RuntimeUpdateRecord, ledger: NativeUpdateLedger | null): NativeUpdateLedger["attempts"][number] | undefined {
  return ledger?.attempts.slice().reverse().find(entry => !record.knownAttemptIds.includes(entry.id) && entry.bundleVersion === record.intent.targetBundle && entry.manifestDigest === record.intent.manifestDigest);
}

function updateReport(record: RuntimeUpdateRecord): RuntimeUpdateReport {
  if (record.state === "requested") throw new Error("A requested runtime update has no report yet.");
  return { updateId: record.intent.updateId, targetBundle: record.intent.targetBundle, manifestDigest: record.intent.manifestDigest, state: record.state,
    ...(record.failure ? { failure: record.failure } : {}) };
}
