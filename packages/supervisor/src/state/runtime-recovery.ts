import { z } from "zod";
import {
  RemoteInstanceError, RemoteReconnectIntentSnapshotSchema, allEqual,
  RemoteInstanceReconciliationManifestSchema, RemoteReconciliationReceiptSnapshotSchema,
  RemoteReconciliationAppliedResultSchema, computeRemoteReconnectSnapshotDigest,
  computeRemoteReconciliationManifestDigest, computeRemoteReconciliationReceiptSnapshotDigest,
  type RemoteReconnectIntentSnapshot,
} from "@konteks/remote-common";

const manifestFields = RemoteInstanceReconciliationManifestSchema.shape;
const ManifestRecordSchema = z.object({
  manifestId: manifestFields.manifestId, ownerRevision: manifestFields.ownerRevision,
  issuedAt: manifestFields.issuedAt, applyDeadlineAt: manifestFields.applyDeadlineAt,
  digest: RemoteReconciliationAppliedResultSchema.shape.receiptDigest,
}).strict();

const RecordFieldsSchema = z.object({
  intent: RemoteReconnectIntentSnapshotSchema,
  intentDigest: RemoteReconciliationAppliedResultSchema.shape.receiptDigest,
  state: z.enum(["pending", "applied", "expired", "superseded", "establishment_conflict"]),
  manifest: ManifestRecordSchema.nullable(),
  receipt: z.object({
    snapshot: RemoteReconciliationReceiptSnapshotSchema,
    digest: RemoteReconciliationAppliedResultSchema.shape.receiptDigest,
  }).strict().nullable(),
  acceptedAt: RemoteReconciliationAppliedResultSchema.shape.acceptedAt.nullable(),
}).strict();
type ParsedRecord = z.infer<typeof RecordFieldsSchema>;

/** The receipt belongs to this intent's generation and bound manifest, by its own digest. */
function receiptInconsistent(record: ParsedRecord): boolean {
  if (!record.receipt) return false;
  const snapshot = record.receipt.snapshot;
  return !record.manifest || !allEqual([
    [snapshot.instanceId, record.intent.instanceId], [snapshot.runnerIncarnation, record.intent.runnerIncarnation],
    [snapshot.manifestId, record.manifest.manifestId], [record.receipt.digest, computeRemoteReconciliationReceiptSnapshotDigest(snapshot)],
  ]);
}

/** Accepted only with a receipt, as applied or later superseded; applied only once accepted. */
function acceptanceInconsistent(record: ParsedRecord): boolean {
  if (!record.acceptedAt) return record.state === "applied";
  return !record.receipt || (record.state !== "applied" && record.state !== "superseded");
}

function establishmentInconsistent(record: ParsedRecord): boolean {
  return record.state === "establishment_conflict" && (record.manifest !== null || record.receipt !== null || !record.intent.establishment);
}

const RECORD_INCONSISTENCIES: ReadonlyArray<(record: ParsedRecord) => boolean> = [
  record => record.intentDigest !== computeRemoteReconnectSnapshotDigest(record.intent),
  receiptInconsistent,
  acceptanceInconsistent,
  establishmentInconsistent,
];

/** Local persistence only. No proof, bearer or decision authorization is stored. */
export const RuntimeRecoveryRecordSchema = RecordFieldsSchema.superRefine((record, ctx) => {
  for (const inconsistent of RECORD_INCONSISTENCIES) {
    if (inconsistent(record)) ctx.addIssue({ code: "custom", message: "Recovery record identity or state is inconsistent" });
  }
});
export type RuntimeRecoveryRecord = z.infer<typeof RuntimeRecoveryRecordSchema>;
type TerminalDisposition = "expired" | "superseded" | "establishment_conflict";

/** Supplied by the existing fsync/compaction/ownership-gated append log. */
interface RecoveryLog {
  all(): RuntimeRecoveryRecord[];
  update(key: string, derive: (current: RuntimeRecoveryRecord | undefined) => RuntimeRecoveryRecord): Promise<void>;
}
export const recoveryRecordKey = (record: Pick<RuntimeRecoveryRecord, "intent">): string =>
  JSON.stringify([record.intent.instanceId, record.intent.runnerIncarnation, record.intent.reconnectIntentId]);

function openState(state: RuntimeRecoveryRecord["state"]): boolean {
  return state === "pending" || state === "applied";
}

/**
 * Whether an owner's disposition may replace the durable state: a pending
 * intent ends any way (an establishment conflict only before a manifest, for
 * an establishment intent); an applied one can only be superseded.
 */
function dispositionReplaces(record: RuntimeRecoveryRecord, state: TerminalDisposition, intent: RemoteReconnectIntentSnapshot): boolean {
  if (record.state === "pending") return state !== "establishment_conflict" || (!record.manifest && Boolean(intent.establishment));
  return record.state === "applied" && state === "superseded";
}

/** Immutable retries; these facts alone never grant process or execution authority. */
export class RuntimeRecoveryJournal {
  constructor(private readonly log: RecoveryLog) {}

  current(instanceId: string, runnerIncarnation: string): RuntimeRecoveryRecord | undefined {
    return this.log.all().filter(record => record.intent.instanceId === instanceId && record.intent.runnerIncarnation === runnerIncarnation).at(-1);
  }

  async prepareIntent(candidate: unknown): Promise<void> {
    const intent = RemoteReconnectIntentSnapshotSchema.parse(candidate);
    const intentDigest = computeRemoteReconnectSnapshotDigest(intent);
    await this.log.update(recoveryRecordKey({ intent }), existing => {
      if (existing) return this.requireCurrent(intent, existing);
      const previous = this.current(intent.instanceId, intent.runnerIncarnation);
      if (previous?.state === "pending") throw new RemoteInstanceError("active_work", "Resolve the pending recovery intent before creating another.");
      return { intent, intentDigest, state: "pending", manifest: null, receipt: null, acceptedAt: null };
    });
  }

  async bindManifest(identity: unknown, candidate: unknown): Promise<void> {
    const intent = RemoteReconnectIntentSnapshotSchema.parse(identity);
    const manifest = RemoteInstanceReconciliationManifestSchema.parse(candidate);
    const digest = computeRemoteReconciliationManifestDigest(manifest);
    if (manifest.instanceId !== intent.instanceId || manifest.runnerIncarnation !== intent.runnerIncarnation || manifest.reconnectIntentId !== intent.reconnectIntentId) this.mismatch();
    await this.log.update(recoveryRecordKey({ intent }), existing => {
      const record = this.requireCurrent(intent, existing);
      if (record.manifest) {
        if (record.manifest.digest !== digest) this.changed();
        return record;
      }
      return { ...record, manifest: { manifestId: manifest.manifestId, ownerRevision: manifest.ownerRevision, issuedAt: manifest.issuedAt, applyDeadlineAt: manifest.applyDeadlineAt, digest } };
    });
  }

  /** Caller must prove local actions/evidence before freezing the first receipt. */
  async prepareReceipt(identity: unknown, candidate: unknown): Promise<void> {
    const intent = RemoteReconnectIntentSnapshotSchema.parse(identity);
    const snapshot = RemoteReconciliationReceiptSnapshotSchema.parse(candidate);
    const digest = computeRemoteReconciliationReceiptSnapshotDigest(snapshot);
    await this.log.update(recoveryRecordKey({ intent }), existing => {
      const record = this.requireCurrent(intent, existing);
      if (!record.manifest) throw new RemoteInstanceError("recovery_required", "Recovery has no bound manifest.");
      if (snapshot.instanceId !== intent.instanceId || snapshot.runnerIncarnation !== intent.runnerIncarnation || snapshot.manifestId !== record.manifest.manifestId) this.mismatch();
      if (record.receipt) {
        if (record.receipt.digest !== digest) this.changed();
        return record;
      }
      return { ...record, receipt: { snapshot, digest } };
    });
  }

  /** Only call after the authenticated Core client validates the response. */
  async acceptReceipt(identity: unknown, candidate: unknown): Promise<void> {
    const intent = RemoteReconnectIntentSnapshotSchema.parse(identity);
    const result = RemoteReconciliationAppliedResultSchema.parse(candidate);
    await this.log.update(recoveryRecordKey({ intent }), existing => {
      const record = this.requireCurrent(intent, existing);
      if (!record.receipt) throw new RemoteInstanceError("recovery_required", "Recovery has no durable receipt.");
      if (!allEqual([[result.instanceId, intent.instanceId], [result.runnerIncarnation, intent.runnerIncarnation],
        [result.manifestId, record.manifest?.manifestId], [result.receiptDigest, record.receipt.digest]])) this.mismatch();
      if (record.acceptedAt && record.acceptedAt !== result.acceptedAt) this.changed();
      return { ...record, state: "applied", acceptedAt: result.acceptedAt };
    });
  }

  /** Persist an explicit owner denial/invalidation, never infer it from a timeout. */
  async terminate(identity: unknown, state: TerminalDisposition): Promise<void> {
    const intent = RemoteReconnectIntentSnapshotSchema.parse(identity);
    await this.log.update(recoveryRecordKey({ intent }), existing => {
      const record = this.requireCurrent(intent, existing, true);
      if (record.state === state) return record;
      if (!dispositionReplaces(record, state, intent)) {
        throw new RemoteInstanceError("recovery_required", "Recovery disposition cannot replace this durable state.");
      }
      return { ...record, state };
    });
  }

  private requireCurrent(intent: RemoteReconnectIntentSnapshot, record: RuntimeRecoveryRecord | undefined, allowTerminal = false): RuntimeRecoveryRecord {
    if (!record) throw new RemoteInstanceError("recovery_required", "Recovery intent must be persisted first.");
    if (record.intentDigest !== computeRemoteReconnectSnapshotDigest(intent)) this.changed();
    if (!this.isCurrentIntent(intent) || (!allowTerminal && !openState(record.state))) {
      throw new RemoteInstanceError("reconciliation_replay", "Recovery intent is no longer current.");
    }
    return record;
  }

  private isCurrentIntent(intent: RemoteReconnectIntentSnapshot): boolean {
    return this.current(intent.instanceId, intent.runnerIncarnation)?.intent.reconnectIntentId === intent.reconnectIntentId;
  }

  private changed(): never { throw new RemoteInstanceError("idempotency_conflict", "Recovery semantic identity changed."); }
  private mismatch(): never { throw new RemoteInstanceError("registration_mismatch", "Recovery response belongs to another generation."); }
}
