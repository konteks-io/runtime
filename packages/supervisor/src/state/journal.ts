import { open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SchemaParser } from "@konteks/remote-common";
import { join } from "node:path";
import { z } from "zod";
import { AssignmentReportSchema, allEqual, canonicalize, isFsErrorWithCode, RemoteExecutionReadyResultSchema, RemoteReconciliationReceiptSnapshotSchema, ReportAckSchema,
  RemoteExecutionAdmissionClaimsSchema, RemoteDeliveryAdmissionClaimsSchema, SessionToCoreMessageSchema, RemoteWorkKindSchema, RemoteRecoveryEvidenceSchema,
  remoteRecoveryEvidenceIdentityKey, type RemoteRecoveryEvidence } from "@konteks/remote-common";
import { unrestrictedStateMutation, type StateMutation } from "./mutation-gate.js";
import { RuntimeRecoveryJournal, RuntimeRecoveryRecordSchema, recoveryRecordKey, type RuntimeRecoveryRecord } from "./runtime-recovery.js";
import { LocalExecutionJournal, LocalExecutionRecordSchema, localExecutionKey, type LocalExecutionRecord } from "./local-execution.js";
import { AssignmentStreamJournal } from "./assignment-stream.js";
import { PlanningTerminalJournal, PlanningTerminalRecordSchema, planningTerminalRecordKey, type PlanningTerminalRecord } from "./planning-terminal.js";
import { CancellationInbox, CancellationInboxRecordSchema, type CancellationInboxRecord } from "./cancellation-inbox.js";
import {
  ExecutionRevisionFenceInbox,
  ExecutionRevisionFenceInboxRecordSchema,
  type ExecutionRevisionFenceInboxRecord,
} from "./execution-revision-fence-inbox.js";
import {
  DiagnosticCompanionInbox,
  DiagnosticCompanionInboxRecordSchema,
  type DiagnosticCompanionInboxRecord,
} from "./diagnostic-companion-inbox.js";

/**
 * The bounded assignment recovery journal. Contains only IDs, attempt, claim,
 * component state, recovery epoch, ACP session reference, checkpoint
 * ref/hash/time, and terminal result hash — never checkpoint content, agent
 * stdio, or a payload. Append-only JSON lines with periodic compaction, so a
 * crash mid-write leaves at most one unparseable trailing line.
 */
const JournalEntryFieldsSchema = z
  .object({
    assignmentId: z.string().min(1),
    attempt: z.number().int().positive(),
    claimId: z.string().min(1),
    /** When Core confirmed the claim; the Harness envelope carries it. Absent on journals written before the local component protocol. */
    claimedAt: z.string().optional(),
    kind: RemoteWorkKindSchema,
    placementId: z.string().min(1),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    state: z.enum(["claimed", "running", "checkpointed", "terminal_pending_report", "completed", "recovery_required", "cancelled"]),
    recoveryEpoch: z.number().int().nonnegative(),
    acpSessionRef: z.string().min(1).optional(),
    sessionChannelId: z.string().min(1).optional(),
    executionReady: RemoteExecutionReadyResultSchema.optional(),
    checkpoint: z.object({ ref: z.string().min(1), hash: z.string().min(1), createdAt: z.string() }).strict().optional(),
    terminalResultHash: z.string().min(1).optional(),
    recoveryReason: z
      .enum(["instance_removed", "instance_revoked", "checkpoint_invalid", "resume_deadline_expired", "not_resumable", "assignment_conflict", "policy_denied", "limit_exceeded", "ownership_scope_lost", "agent_session_lost", "relay_replay_gap"])
      .optional(),
    /** Report ordering state for this claim. */
    reports: z.object({ nextSequence: z.number().int().positive(), durableWatermark: z.number().int().nonnegative(), terminalSequence: z.number().int().positive().optional(), terminalControllerDirectiveId: z.string().min(1).max(256).optional(), terminalAck: ReportAckSchema.optional(), terminalResult: AssignmentReportSchema.shape.result }).strict(),
    evidenceUpload: z.enum(["structured_only", "selected_artifacts"]),
    expiresAt: z.string(),
    latestResumeAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
type JournalEntryFields = z.infer<typeof JournalEntryFieldsSchema>;

/** A saved terminal result belongs to the terminal report this entry points at. */
function terminalResultMismatch(entry: JournalEntryFields): boolean {
  const result = entry.reports.terminalResult;
  if (!result) return false;
  return !entry.reports.terminalSequence || result.terminalResultHash !== entry.terminalResultHash;
}

/** A planning claim's terminal report names exactly one controller directive; no other report names one. */
function planningDirectiveMismatch(entry: JournalEntryFields): boolean {
  return (entry.kind === "planning" && entry.reports.terminalSequence !== undefined) !== (entry.reports.terminalControllerDirectiveId !== undefined);
}

/** A saved terminal ACK covers this exact claim and terminal sequence. */
function terminalAckMismatch(entry: JournalEntryFields): boolean {
  const ack = entry.reports.terminalAck;
  if (!ack) return false;
  return !allEqual([
    [ack.assignmentId, entry.assignmentId], [ack.attempt, entry.attempt], [ack.claimId, entry.claimId],
    [ack.terminalSequence, entry.reports.terminalSequence], [ack.terminalSequence, ack.acknowledged.reportSequence],
  ]) || !entry.terminalResultHash || ack.durableWatermark < ack.acknowledged.reportSequence || entry.reports.durableWatermark < ack.durableWatermark ||
    (ack.outcome !== "accepted" && ack.outcome !== "duplicate");
}

export const JournalEntrySchema = JournalEntryFieldsSchema.superRefine((entry, ctx) => {
  if (terminalResultMismatch(entry)) {
    ctx.addIssue({ code: "custom", path: ["reports", "terminalResult"], message: "Saved terminal result must match this terminal pointer" });
  }
  if (planningDirectiveMismatch(entry)) {
    ctx.addIssue({ code: "custom", path: ["reports", "terminalControllerDirectiveId"], message: "Planning terminal reports require exactly one controller directive" });
  }
  if (terminalAckMismatch(entry)) {
    ctx.addIssue({ code: "custom", path: ["reports", "terminalAck"], message: "Terminal ACK must cover this exact claim and terminal sequence" });
  }
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

const CurrentPendingRequestFieldsSchema = z
  .object({
    acpSessionRef: z.string().min(1),
    id: z.string().min(1),
    method: z.enum(["session/prompt", "session/cancel", "session/set_mode", "session/set_config_option", "session/request_permission", "elicitation/create"]),
    direction: z.enum(["received", "issued"]),
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    deadlineAt: z.string().nullable(),
    requestDigest: z.string().nullable(),
    /** Short-lived Core admission evidence, never a human/provider bearer. */
    authorization: z.object({
      claims: z.union([RemoteExecutionAdmissionClaimsSchema, RemoteDeliveryAdmissionClaimsSchema]),
      receipt: z.string().min(1).max(16384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      state: z.enum(["admitted", "dispatch_started", "completed", "interrupted", "denied"]),
      completion: SessionToCoreMessageSchema.optional(),
    }).strict().optional(),
  })
  .strict();
type PendingRequestFields = z.infer<typeof CurrentPendingRequestFieldsSchema>;
type PendingAuthorization = NonNullable<PendingRequestFields["authorization"]>;

/** The admission names this request, and a recorded completion settles it as completed or denied. */
function admissionMatches(entry: PendingRequestFields, authorization: PendingAuthorization): boolean {
  const { claims, completion } = authorization;
  const id = claims.requestId ?? `operation:${claims.operationId}`;
  return allEqual([
    [claims.acpSessionRef, entry.acpSessionRef], [claims.method, entry.method], [id, entry.id],
    [claims.kind === "acp" ? "received" : "issued", entry.direction],
  ]) && (!completion || completionMatches(entry, authorization.state, completion));
}

function completionMatches(entry: PendingRequestFields, state: PendingAuthorization["state"], completion: z.infer<typeof SessionToCoreMessageSchema>): boolean {
  if (!["completed", "denied"].includes(state) || (state === "denied" && completion.kind !== "acp_error")) return false;
  if (!["acp_result", "acp_error"].includes(completion.kind)) return false;
  return "id" in completion && completion.id === entry.id && "method" in completion && completion.method === entry.method;
}

const CurrentPendingRequestSchema = CurrentPendingRequestFieldsSchema.superRefine((entry, ctx) => {
  if (entry.authorization && !admissionMatches(entry, entry.authorization)) {
    ctx.addIssue({ code: "custom", message: "Operation admission and disposition must match the durable request" });
  }
});

function objectish(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** A harness delivery admission saved without the immutable repository, role, agent and model tuple. */
function legacyDeliveryAdmission(candidate: unknown): boolean {
  const claim = objectish(objectish(objectish(candidate)?.authorization)?.claims);
  const delivery = objectish(claim?.deliveryIdentity);
  if (claim?.workloadKind !== "harness_delivery" || !delivery) return false;
  return !completeDeliveryTuple(delivery);
}

function completeDeliveryTuple(delivery: Record<string, unknown>): boolean {
  return typeof delivery.repositoryId === "string" && typeof delivery.requiredRuntimeRole === "string" &&
    typeof delivery.agentId === "string" && objectish(delivery.modelBinding) !== undefined;
}

/** Older delivery admission evidence lacks the immutable repository, role,
 * agent and model tuple. It may remain as transcript history, but stripping
 * its expired authorization makes it incapable of resuming or dispatching. */
export const PendingRequestSchema = z.preprocess((candidate) => {
  if (!legacyDeliveryAdmission(candidate)) return candidate;
  const { authorization: _legacyAuthority, ...displayOnly } = candidate as Record<string, unknown>;
  return displayOnly;
}, CurrentPendingRequestSchema);
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

const DecisionRecordFieldsSchema = z
  .object({ manifestId: z.string().min(1), assignmentId: z.string().min(1), attempt: z.number().int(), action: z.string().min(1), recoveryEpoch: z.number().int().nonnegative(), journaledAt: z.string(), executedAt: z.string().nullable(),
    /** Hash only: recovery authorization bytes never enter the journal. Older records cannot prove exact replay. */
    decisionDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    claimId: z.string().min(1).optional(),
    absenceTombstoneDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    /** Actual local disposition/evidence, frozen before receipt delivery. */
    result: RemoteReconciliationReceiptSnapshotSchema.shape.decisionResults.element.optional(),
  })
  .strict();
type DecisionRecordFields = z.infer<typeof DecisionRecordFieldsSchema>;

/** A cancel of work this computer never had: a tombstone, no claim, and an absent-and-cancelled result. */
function absenceRecord(record: DecisionRecordFields): boolean {
  return record.action === "cancel" && record.result?.disposition === "absent_local_cancelled" && Boolean(record.absenceTombstoneDigest) && !record.claimId;
}

/** A result (or a tombstone) must match a durably applied identity. */
function decisionInconsistent(record: DecisionRecordFields): boolean {
  const absence = absenceRecord(record);
  if (!absence && (record.absenceTombstoneDigest || record.result?.disposition === "absent_local_cancelled")) return true;
  return resultInconsistent(record, absence);
}

/** A result needs its claim (or an absence tombstone), its execution time and the decision's own identity. */
function resultInconsistent(record: DecisionRecordFields, absence: boolean): boolean {
  const result = record.result;
  if (!result) return false;
  return (!record.claimId && !absence) || !record.executedAt || !allEqual([[result.assignmentId, record.assignmentId], [result.attempt, record.attempt]]);
}

const DecisionRecordSchema = DecisionRecordFieldsSchema.superRefine((record, ctx) => {
  if (decisionInconsistent(record)) {
    ctx.addIssue({ code: "custom", path: ["result"], message: "Decision result must match a durably applied identity" });
  }
});
type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** First-seen manifest identity, never its renewable lease or decision authorization. */
const ReconciliationManifestRecordSchema = z.object({
  manifestId: z.string().min(1), instanceId: z.string().min(1),
  manifestDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
type ReconciliationManifestRecord = z.infer<typeof ReconciliationManifestRecordSchema>;

const EraseRecordSchema = z
  .object({ directiveId: z.string().min(1), scope: z.enum(["assignment_data", "all_konteks_data"]), status: z.enum(["pending", "completed", "partially_completed", "failed"]), receiptSent: z.boolean(), updatedAt: z.string() })
  .strict();
type EraseRecord = z.infer<typeof EraseRecordSchema>;

/**
 * An immutable recovery observation and its local delivery watermark. This is
 * intentionally separate from terminal reports: accepting it cannot settle
 * work, assert quiescence, or release a workspace owner.
 */
export const RecoveryEvidenceRecordSchema = z.object({
  evidence: RemoteRecoveryEvidenceSchema,
  // `superseded`: Core can never accept these bytes (their process retired, or
  // Core already settled the claim) and says so. The record is kept for audit;
  // it is simply no longer sent.
  delivery: z.enum(["pending", "accepted", "duplicate", "superseded"]),
  attempts: z.number().int().nonnegative(),
  lastAttemptAt: z.string().nullable(),
  nextAttemptAt: z.string(),
  acceptedAt: z.string().nullable(),
  lastFailureCode: z.string().min(1).max(128).nullable(),
  supersededAt: z.string().optional(),
  supersededReason: z.enum(["incarnation_retired", "claim_settled"]).optional(),
  updatedAt: z.string(),
}).strict().superRefine((record, ctx) => {
  if ((record.delivery === "accepted" || record.delivery === "duplicate") !== (record.acceptedAt !== null)) {
    ctx.addIssue({ code: "custom", path: ["acceptedAt"], message: "Accepted recovery evidence requires its immutable acceptance timestamp" });
  }
  if ((record.delivery === "superseded") !== (record.supersededAt !== undefined && record.supersededReason !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["supersededAt"], message: "Superseded recovery evidence requires when and why Core settled it" });
  }
});
export type RecoveryEvidenceRecord = z.infer<typeof RecoveryEvidenceRecordSchema>;
export const recoveryEvidenceRecordKey = (record: Pick<RecoveryEvidenceRecord, "evidence"> | RemoteRecoveryEvidence): string =>
  remoteRecoveryEvidenceIdentityKey("evidence" in record ? record.evidence : record);

/**
 * One consumed integration write grant (external-integration CP2): the gate
 * records it BEFORE it answers `allow_once`, so a nonce allows at most one
 * provider call even across a crash or a repeated assignment. Identifiers and
 * digests only, never arguments or credentials (N05: the attempt journal
 * survives restart without storing credentials).
 */
export const IntegrationWriteRecordSchema = z.object({
  nonce: z.string().min(1).max(256),
  taskId: z.string().min(1).max(256),
  actionId: z.string().min(1).max(256),
  attemptId: z.string().min(1).max(256),
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  toolCallId: z.string().min(1).max(256),
  consumedAt: z.string(),
}).strict();
export type IntegrationWriteRecord = z.infer<typeof IntegrationWriteRecordSchema>;

const MAX_JOURNAL_ENTRIES = 2_000;
const COMPACT_EVERY_APPENDS = 500;

interface LogTable<T extends { [key: string]: unknown }> {
  name: string;
  schema: SchemaParser<T>;
  key: (entry: T) => string;
  /** Opt-in only: one local ownership log may commit several keyed rows together. */
  atomicBatches?: boolean;
}

const BatchEnvelopeSchema = z.object({ kind: z.literal("journal_batch"), schemaVersion: z.literal(1), entries: z.array(z.unknown()).min(1).max(64) }).strict();
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const COMPACTION_CHUNK_BYTES = 256 * 1024;

/**
 * One record per line, in bounded chunks: encoding memory stays bounded
 * without one syscall per row. An individually larger validated record is
 * written alone, never combined with a chunk.
 */
async function writeChunked(file: FileHandle, entries: Iterable<unknown>): Promise<void> {
  let chunk: string[] = [];
  let chunkBytes = 0;
  for (const entry of entries) {
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (chunkBytes > 0 && chunkBytes + lineBytes > COMPACTION_CHUNK_BYTES) {
      await file.writeFile(chunk.join("")); chunk = []; chunkBytes = 0;
    }
    if (lineBytes >= COMPACTION_CHUNK_BYTES) await file.writeFile(line);
    else { chunk.push(line); chunkBytes += lineBytes; }
  }
  if (chunkBytes > 0) await file.writeFile(chunk.join(""));
}

function parsedRecord(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Journal contains a corrupt complete record");
  }
}

function journalBatch(parsed: unknown): boolean {
  return parsed !== null && typeof parsed === "object" && "kind" in parsed && parsed.kind === "journal_batch";
}

/** A small append-only table with in-memory index and file compaction. */
class AppendLog<T extends { [key: string]: unknown }> {
  private readonly entries = new Map<string, T>();
  private appends = 0;
  private loaded = false;
  private writes: Promise<void> = Promise.resolve();
  private writeUncertain = false;
  private committedRevision = 0;
  /** Derived indexes may refresh after committed memory changes, never before fsync. */
  get revision(): number {
    if (this.writeUncertain) throw new Error("Journal write outcome requires recovery");
    return this.committedRevision;
  }

  constructor(private readonly dir: string, private readonly table: LogTable<T>, private readonly bound: number, private readonly mutate: StateMutation) {}

  private get path(): string {
    return join(this.dir, `${this.table.name}.jsonl`);
  }

  private serialized<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.writes.then(() => this.mutate(operation));
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  load(): Promise<void> { return this.serialized(() => this.loadInternal()); }

  private async loadInternal(): Promise<void> {
    if (this.writeUncertain) throw new Error("Journal write outcome requires recovery");
    if (this.loaded) return;
    const raw = await this.readJournal();
    if (raw === null) {
      this.loaded = true;
      return;
    }
    const completeLength = raw.lastIndexOf("\n") + 1;
    const restored = this.restore(raw.slice(0, completeLength));
    if (completeLength !== raw.length) await this.truncateTo(Buffer.byteLength(raw.slice(0, completeLength)));
    this.entries.clear();
    for (const [key, entry] of restored) this.entries.set(key, entry);
    this.committedRevision += 1;
    this.loaded = true;
  }

  /** The journal's text; null when there is no journal yet. */
  private async readJournal(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) throw error;
      return null;
    }
  }

  /** Every complete record, by key; a corrupt complete record fails the load. */
  private restore(complete: string): Map<string, T> {
    const restored = new Map<string, T>();
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      // Validate the complete batch before exposing any of its keyed mutations.
      for (const entry of this.recordEntries(parsedRecord(line))) restored.set(this.table.key(entry), entry);
    }
    return restored;
  }

  private recordEntries(parsed: unknown): T[] {
    return this.table.atomicBatches && journalBatch(parsed) ? this.parseBatch(parsed).entries : [this.table.schema.parse(parsed)];
  }

  /** Drops a torn final record left by a write that did not complete. */
  private async truncateTo(bytes: number): Promise<void> {
    const file = await open(this.path, "r+");
    try { await file.truncate(bytes); await file.sync(); }
    finally { await file.close(); }
  }

  all(): T[] {
    if (this.writeUncertain) throw new Error("Journal write outcome requires recovery");
    return structuredClone([...this.entries.values()]);
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async put(entry: T): Promise<void> {
    const parsed = this.table.schema.parse(structuredClone(entry));
    return this.serialized(async () => {
      await this.loadInternal();
      await this.append(parsed);
      this.entries.set(this.table.key(parsed), parsed);
      this.committedRevision += 1;
      await this.maybeCompact();
    });
  }

  /** Derive from current committed state under the serialized ownership gate. */
  async update(key: string, derive: (current: T | undefined) => T): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      const parsed = this.table.schema.parse(derive(this.get(key)));
      if (this.table.key(parsed) !== key) throw new Error("Journal update cannot change identity");
      await this.append(parsed);
      this.entries.set(key, parsed);
      this.committedRevision += 1;
      await this.maybeCompact();
    });
  }

  private parseBatch(input: unknown): { kind: "journal_batch"; schemaVersion: 1; entries: T[] } {
    if (!this.table.atomicBatches) throw new Error("Atomic journal batch is not enabled");
    const parsed = BatchEnvelopeSchema.safeParse(input);
    if (!parsed.success) throw new Error("Atomic journal batch has an invalid envelope or entry count");
    const envelope = parsed.data;
    if (Buffer.byteLength(canonicalize(envelope as never), "utf8") > MAX_BATCH_BYTES) throw new Error("Atomic journal batch exceeds byte capacity");
    const entries = envelope.entries.map(entry => this.table.schema.parse(structuredClone(entry)));
    const keys = entries.map(entry => this.table.key(entry));
    if (new Set(keys).size !== keys.length) throw new Error("Atomic journal batch contains duplicate keys");
    return { ...envelope, entries };
  }

  /** One derive/append/fsync/publication boundary on the same lane as update(). */
  async batch(derive: () => T[]): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      const batch = this.parseBatch({ kind: "journal_batch", schemaVersion: 1, entries: derive() });
      await this.append(batch);
      for (const entry of batch.entries) this.entries.set(this.table.key(entry), entry);
      this.committedRevision += 1;
      await this.maybeCompact();
    });
  }

  async remove(key: string): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      if (!this.entries.has(key)) return;
      const next = new Map(this.entries); next.delete(key);
      await this.compactInternal(next);
      this.entries.delete(key);
      this.committedRevision += 1;
    });
  }

  /** Validate every replacement row before one fsync/rename publication. */
  async rewrite(derive: () => T[] | undefined): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      const candidates = derive();
      if (!candidates) return;
      const next = new Map<string, T>();
      for (const candidate of candidates) {
        const parsed = this.table.schema.parse(structuredClone(candidate));
        const key = this.table.key(parsed);
        if (next.has(key)) throw new Error("Journal rewrite contains duplicate keys");
        next.set(key, parsed);
      }
      await this.compactInternal(next);
      this.entries.clear();
      for (const [key, entry] of next) this.entries.set(key, entry);
      this.committedRevision += 1;
    });
  }

  async compact(): Promise<void> {
    return this.serialized(async () => { await this.loadInternal(); await this.compactInternal(); });
  }

  private async append(entry: T | { kind: "journal_batch"; schemaVersion: 1; entries: T[] }): Promise<void> {
    const file = await open(this.path, "a+", 0o600);
    const size = (await file.stat()).size;
    try {
      await file.writeFile(`${JSON.stringify(entry)}\n`);
      await file.sync();
      if (size === 0) await this.syncDirectory();
    } catch (error) {
      try { await file.truncate(size); await file.sync(); }
      catch { this.writeUncertain = true; }
      throw error;
    } finally { await file.close(); }
    this.appends += 1;
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === "win32") return; // Native Windows crash proof remains a separate gate.
    const directory = await open(this.dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async maybeCompact(): Promise<void> {
    // The append is already durable; optimization failure must not negate it.
    if (this.appends >= COMPACT_EVERY_APPENDS || this.entries.size > this.bound) await this.compactInternal().catch(() => undefined);
  }

  private async compactInternal(entries = this.entries): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    let renamed = false;
    try {
      await writeChunked(file, entries.values());
      await file.sync(); await file.close();
      await rename(tmp, this.path); renamed = true;
      await this.syncDirectory(); this.appends = 0;
    } catch (error) {
      if (renamed) this.writeUncertain = true;
      throw error;
    } finally { await file.close(); await rm(tmp, { force: true }); }
  }

  async clear(): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      await this.compactInternal(new Map());
      this.entries.clear();
      this.committedRevision += 1;
    });
  }
}

export class SupervisorJournal {
  readonly execution: LocalExecutionJournal;
  readonly assignmentStream: AssignmentStreamJournal;
  private readonly executionLog: AppendLog<LocalExecutionRecord>;
  readonly recovery: RuntimeRecoveryJournal;
  private readonly recoveryLog: AppendLog<RuntimeRecoveryRecord>;
  readonly assignments: AppendLog<JournalEntry>;
  readonly pendingRequests: AppendLog<PendingRequest>;
  readonly decisions: AppendLog<DecisionRecord>;
  readonly manifests: AppendLog<ReconciliationManifestRecord>;
  readonly erase: AppendLog<EraseRecord>;
  /** C03 local durable evidence. Never use this table as a terminal owner. */
  readonly recoveryEvidence: AppendLog<RecoveryEvidenceRecord>;
  /** Consumed integration write nonces (external-integration CP2); never pruned with assignments. */
  readonly integrationWrites: AppendLog<IntegrationWriteRecord>;
  readonly planning: PlanningTerminalJournal;
  private readonly planningLog: AppendLog<PlanningTerminalRecord>;
  readonly cancellations: CancellationInbox;
  private readonly cancellationLog: AppendLog<CancellationInboxRecord>;
  /** C02 pre-fence evidence; not a provider-stop or terminal result. */
  readonly executionRevisionFences: ExecutionRevisionFenceInbox;
  private readonly executionRevisionFenceLog: AppendLog<ExecutionRevisionFenceInboxRecord>;
  /** C01 diagnostic-only evidence; it never changes delivery or authority. */
  readonly diagnosticCompanions: DiagnosticCompanionInbox;
  private readonly diagnosticCompanionLog: AppendLog<DiagnosticCompanionInboxRecord>;

  constructor(dir: string, mutate: StateMutation = unrestrictedStateMutation) {
    this.cancellationLog = new AppendLog(dir, { name: "cancellation-inbox", schema: CancellationInboxRecordSchema,
      key: record => record.intent.intentId }, MAX_JOURNAL_ENTRIES, mutate);
    this.cancellations = new CancellationInbox(this.cancellationLog);
    this.executionRevisionFenceLog = new AppendLog(dir, {
      name: "execution-revision-fence-inbox",
      schema: ExecutionRevisionFenceInboxRecordSchema,
      key: record => record.intent.intentId,
    }, MAX_JOURNAL_ENTRIES, mutate);
    this.executionRevisionFences = new ExecutionRevisionFenceInbox(this.executionRevisionFenceLog);
    this.diagnosticCompanionLog = new AppendLog(dir, {
      name: "diagnostic-companion-inbox",
      schema: DiagnosticCompanionInboxRecordSchema,
      key: record => record.companion.deliveryId,
    }, MAX_JOURNAL_ENTRIES, mutate);
    this.diagnosticCompanions = new DiagnosticCompanionInbox(this.diagnosticCompanionLog);
    this.executionLog = new AppendLog(dir, { name: "local-execution", schema: LocalExecutionRecordSchema, key: localExecutionKey, atomicBatches: true }, 50_000, mutate);
    this.execution = new LocalExecutionJournal(this.executionLog);
    this.assignmentStream = new AssignmentStreamJournal(this.executionLog, this.execution);
    this.recoveryLog = new AppendLog(dir, { name: "runtime-recovery", schema: RuntimeRecoveryRecordSchema, key: recoveryRecordKey }, MAX_JOURNAL_ENTRIES, mutate);
    this.recovery = new RuntimeRecoveryJournal(this.recoveryLog);
    this.assignments = new AppendLog(dir, { name: "assignments", schema: JournalEntrySchema, key: (entry) => `${entry.assignmentId}:${entry.attempt}` }, MAX_JOURNAL_ENTRIES, mutate);
    this.pendingRequests = new AppendLog(dir, { name: "pending-requests", schema: PendingRequestSchema, key: (entry) => `${entry.acpSessionRef}:${entry.direction}:${entry.id}` }, MAX_JOURNAL_ENTRIES * 4, mutate);
    this.decisions = new AppendLog(dir, { name: "decisions", schema: DecisionRecordSchema, key: (entry) => `${entry.manifestId}:${entry.assignmentId}:${entry.attempt}` }, MAX_JOURNAL_ENTRIES, mutate);
    this.manifests = new AppendLog(dir, { name: "reconciliation-manifests", schema: ReconciliationManifestRecordSchema, key: entry => entry.manifestId }, MAX_JOURNAL_ENTRIES, mutate);
    this.erase = new AppendLog(dir, { name: "erase", schema: EraseRecordSchema, key: (entry) => entry.directiveId }, 500, mutate);
    this.integrationWrites = new AppendLog(dir, { name: "integration-writes", schema: IntegrationWriteRecordSchema, key: entry => entry.nonce }, MAX_JOURNAL_ENTRIES * 4, mutate);
    this.recoveryEvidence = new AppendLog(dir, { name: "recovery-evidence", schema: RecoveryEvidenceRecordSchema, key: recoveryEvidenceRecordKey }, MAX_JOURNAL_ENTRIES, mutate);
    this.planningLog = new AppendLog(dir, { name: "planning-terminal", schema: PlanningTerminalRecordSchema, key: planningTerminalRecordKey, atomicBatches: true }, MAX_JOURNAL_ENTRIES * 4, mutate);
    this.planning = new PlanningTerminalJournal(this.planningLog);
  }

  async load(): Promise<void> {
    await Promise.all([this.assignments.load(), this.pendingRequests.load(), this.decisions.load(), this.manifests.load(), this.erase.load(), this.recoveryEvidence.load(), this.integrationWrites.load(), this.recoveryLog.load(), this.executionLog.load(), this.planningLog.load(), this.cancellationLog.load(), this.executionRevisionFenceLog.load(), this.diagnosticCompanionLog.load()]);
  }

  /** Bounded pruning: completed/cancelled entries beyond the bound go first, oldest first. */
  async prune(): Promise<void> {
    const entries = this.assignments.all();
    if (entries.length <= MAX_JOURNAL_ENTRIES) return;
    const terminal = entries.filter((entry) => entry.state === "completed" || entry.state === "cancelled").sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    for (const entry of terminal.slice(0, entries.length - MAX_JOURNAL_ENTRIES)) {
      await this.assignments.remove(`${entry.assignmentId}:${entry.attempt}`);
    }
  }

  activeAssignments(): JournalEntry[] {
    return this.assignments.all().filter((entry) => entry.state === "claimed" || entry.state === "running" || entry.state === "checkpointed" || entry.state === "terminal_pending_report");
  }

  recoveryRequired(): JournalEntry[] {
    return this.assignments.all().filter((entry) => entry.state === "recovery_required");
  }

  latestAttempt(assignmentId: string): JournalEntry | undefined {
    return this.assignments
      .all()
      .filter((entry) => entry.assignmentId === assignmentId)
      .sort((a, b) => b.attempt - a.attempt)[0];
  }

  openRequests(acpSessionRef: string): PendingRequest[] {
    return this.pendingRequests.all().filter((request) => request.acpSessionRef === acpSessionRef && request.closedAt === null);
  }
}
