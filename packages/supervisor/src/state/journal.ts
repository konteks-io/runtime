import { open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SchemaParser } from "@konteks/remote-common";
import { join } from "node:path";
import { z } from "zod";
import { AssignmentReportSchema, canonicalize, isFsErrorWithCode, RemoteExecutionReadyResultSchema, RemoteReconciliationReceiptSnapshotSchema, ReportAckSchema,
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

/**
 * The bounded assignment recovery journal. Contains only IDs, attempt, claim,
 * component state, recovery epoch, ACP session reference, checkpoint
 * ref/hash/time, and terminal result hash — never checkpoint content, agent
 * stdio, or a payload. Append-only JSON lines with periodic compaction, so a
 * crash mid-write leaves at most one unparseable trailing line.
 */
export const JournalEntrySchema = z
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
    /** Report ordering state for this claim (D125). */
    reports: z.object({ nextSequence: z.number().int().positive(), durableWatermark: z.number().int().nonnegative(), terminalSequence: z.number().int().positive().optional(), terminalControllerDirectiveId: z.string().min(1).max(256).optional(), terminalAck: ReportAckSchema.optional(), terminalResult: AssignmentReportSchema.shape.result }).strict(),
    evidenceUpload: z.enum(["structured_only", "selected_artifacts"]),
    expiresAt: z.string(),
    latestResumeAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.reports.terminalResult && (!entry.reports.terminalSequence || entry.reports.terminalResult.terminalResultHash !== entry.terminalResultHash)) {
      ctx.addIssue({ code: "custom", path: ["reports", "terminalResult"], message: "Saved terminal result must match this terminal pointer" });
    }
    if ((entry.kind === "planning" && entry.reports.terminalSequence !== undefined) !== (entry.reports.terminalControllerDirectiveId !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["reports", "terminalControllerDirectiveId"], message: "Planning terminal reports require exactly one controller directive" });
    }
    const ack = entry.reports.terminalAck;
    if (!ack) return;
    if (ack.assignmentId !== entry.assignmentId || ack.attempt !== entry.attempt || ack.claimId !== entry.claimId ||
      !entry.terminalResultHash || ack.terminalSequence !== entry.reports.terminalSequence || ack.terminalSequence !== ack.acknowledged.reportSequence ||
      ack.durableWatermark < ack.acknowledged.reportSequence || entry.reports.durableWatermark < ack.durableWatermark ||
      (ack.outcome !== "accepted" && ack.outcome !== "duplicate")) {
      ctx.addIssue({ code: "custom", path: ["reports", "terminalAck"], message: "Terminal ACK must cover this exact claim and terminal sequence" });
    }
  });
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

const CurrentPendingRequestSchema = z
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
  .strict().superRefine((entry, ctx) => {
    const authorization = entry.authorization;
    if (!authorization) return;
    const { claims, completion } = authorization;
    const id = claims.requestId ?? `operation:${claims.operationId}`;
    if (claims.acpSessionRef !== entry.acpSessionRef || claims.method !== entry.method || id !== entry.id ||
      (claims.kind === "acp" ? "received" : "issued") !== entry.direction ||
      (completion && (!["completed", "denied"].includes(authorization.state) ||
        (authorization.state === "denied" && completion.kind !== "acp_error") || !("id" in completion) || completion.id !== entry.id ||
        !("method" in completion) || completion.method !== entry.method || !["acp_result", "acp_error"].includes(completion.kind)))) {
      ctx.addIssue({ code: "custom", message: "Operation admission and disposition must match the durable request" });
    }
  });
/** Pre-D162 delivery admission evidence lacks the immutable repository, role,
 * agent and model tuple. It may remain as transcript history, but stripping
 * its expired authorization makes it incapable of resuming or dispatching. */
export const PendingRequestSchema = z.preprocess((candidate) => {
  if (!candidate || typeof candidate !== "object") return candidate;
  const entry = candidate as Record<string, unknown>;
  const authorization = entry.authorization;
  if (!authorization || typeof authorization !== "object") return candidate;
  const claims = (authorization as Record<string, unknown>).claims;
  if (!claims || typeof claims !== "object") return candidate;
  const claim = claims as Record<string, unknown>;
  const identity = claim.deliveryIdentity;
  if (claim.workloadKind !== "harness_delivery" || !identity || typeof identity !== "object") return candidate;
  const delivery = identity as Record<string, unknown>;
  if (typeof delivery.repositoryId === "string" && typeof delivery.requiredRuntimeRole === "string" &&
      typeof delivery.agentId === "string" && delivery.modelBinding && typeof delivery.modelBinding === "object") return candidate;
  const { authorization: _legacyAuthority, ...displayOnly } = entry;
  return displayOnly;
}, CurrentPendingRequestSchema);
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

export const DecisionRecordSchema = z
  .object({ manifestId: z.string().min(1), assignmentId: z.string().min(1), attempt: z.number().int(), action: z.string().min(1), recoveryEpoch: z.number().int().nonnegative(), journaledAt: z.string(), executedAt: z.string().nullable(),
    /** Hash only: recovery authorization bytes never enter the journal. Older records cannot prove exact replay. */
    decisionDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    claimId: z.string().min(1).optional(),
    absenceTombstoneDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    /** Actual local disposition/evidence, frozen before receipt delivery. */
    result: RemoteReconciliationReceiptSnapshotSchema.shape.decisionResults.element.optional(),
  })
  .strict().superRefine((record, ctx) => {
    const absence = record.action === "cancel" && record.result?.disposition === "absent_local_cancelled" && record.absenceTombstoneDigest && !record.claimId;
    if ((record.absenceTombstoneDigest && !absence) || (record.result?.disposition === "absent_local_cancelled" && !absence) || (record.result && ((!record.claimId && !absence) || !record.executedAt || record.result.assignmentId !== record.assignmentId || record.result.attempt !== record.attempt))) {
      ctx.addIssue({ code: "custom", path: ["result"], message: "Decision result must match a durably applied identity" });
    }
  });
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** First-seen manifest identity, never its renewable lease or decision authorization. */
export const ReconciliationManifestRecordSchema = z.object({
  manifestId: z.string().min(1), instanceId: z.string().min(1),
  manifestDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type ReconciliationManifestRecord = z.infer<typeof ReconciliationManifestRecordSchema>;

export const EraseRecordSchema = z
  .object({ directiveId: z.string().min(1), scope: z.enum(["assignment_data", "all_konteks_data"]), status: z.enum(["pending", "completed", "partially_completed", "failed"]), receiptSent: z.boolean(), updatedAt: z.string() })
  .strict();
export type EraseRecord = z.infer<typeof EraseRecordSchema>;

/**
 * An immutable C03 observation and its local delivery watermark. This is
 * intentionally separate from terminal reports: accepting it cannot settle
 * work, assert quiescence, or release a workspace owner.
 */
export const RecoveryEvidenceRecordSchema = z.object({
  evidence: RemoteRecoveryEvidenceSchema,
  delivery: z.enum(["pending", "accepted", "duplicate"]),
  attempts: z.number().int().nonnegative(),
  lastAttemptAt: z.string().nullable(),
  nextAttemptAt: z.string(),
  acceptedAt: z.string().nullable(),
  lastFailureCode: z.string().min(1).max(128).nullable(),
  updatedAt: z.string(),
}).strict().superRefine((record, ctx) => {
  if ((record.delivery === "accepted" || record.delivery === "duplicate") !== (record.acceptedAt !== null)) {
    ctx.addIssue({ code: "custom", path: ["acceptedAt"], message: "Accepted recovery evidence requires its immutable acceptance timestamp" });
  }
});
export type RecoveryEvidenceRecord = z.infer<typeof RecoveryEvidenceRecordSchema>;
export const recoveryEvidenceRecordKey = (record: Pick<RecoveryEvidenceRecord, "evidence"> | RemoteRecoveryEvidence): string =>
  remoteRecoveryEvidenceIdentityKey("evidence" in record ? record.evidence : record);

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
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) throw error;
      this.loaded = true;
      return;
    }
    const restored = new Map<string, T>();
    const completeLength = raw.lastIndexOf("\n") + 1;
    for (const line of raw.slice(0, completeLength).split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Journal contains a corrupt complete record");
      }
      const entries = this.table.atomicBatches && parsed !== null && typeof parsed === "object" && "kind" in parsed && parsed.kind === "journal_batch"
        ? this.parseBatch(parsed).entries : [this.table.schema.parse(parsed)];
      // Validate the complete batch before exposing any of its keyed mutations.
      for (const entry of entries) restored.set(this.table.key(entry), entry);
    }
    if (completeLength !== raw.length) {
      const file = await open(this.path, "r+");
      try { await file.truncate(Buffer.byteLength(raw.slice(0, completeLength))); await file.sync(); }
      finally { await file.close(); }
    }
    this.entries.clear();
    for (const [key, entry] of restored) this.entries.set(key, entry);
    this.committedRevision += 1;
    this.loaded = true;
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
      // Bound encoding memory without one syscall per row. An individually
      // larger validated record is written alone, never combined with a chunk.
      let chunk: string[] = [];
      let chunkBytes = 0;
      for (const entry of entries.values()) {
        const line = `${JSON.stringify(entry)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (chunkBytes > 0 && chunkBytes + lineBytes > COMPACTION_CHUNK_BYTES) {
          await file.writeFile(chunk.join("")); chunk = []; chunkBytes = 0;
        }
        if (lineBytes >= COMPACTION_CHUNK_BYTES) await file.writeFile(line);
        else { chunk.push(line); chunkBytes += lineBytes; }
      }
      if (chunkBytes > 0) await file.writeFile(chunk.join(""));
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
  readonly planning: PlanningTerminalJournal;
  private readonly planningLog: AppendLog<PlanningTerminalRecord>;
  readonly cancellations: CancellationInbox;
  private readonly cancellationLog: AppendLog<CancellationInboxRecord>;
  /** C02 pre-fence evidence; not a provider-stop or terminal result. */
  readonly executionRevisionFences: ExecutionRevisionFenceInbox;
  private readonly executionRevisionFenceLog: AppendLog<ExecutionRevisionFenceInboxRecord>;

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
    this.recoveryEvidence = new AppendLog(dir, { name: "recovery-evidence", schema: RecoveryEvidenceRecordSchema, key: recoveryEvidenceRecordKey }, MAX_JOURNAL_ENTRIES, mutate);
    this.planningLog = new AppendLog(dir, { name: "planning-terminal", schema: PlanningTerminalRecordSchema, key: planningTerminalRecordKey, atomicBatches: true }, MAX_JOURNAL_ENTRIES * 4, mutate);
    this.planning = new PlanningTerminalJournal(this.planningLog);
  }

  async load(): Promise<void> {
    await Promise.all([this.assignments.load(), this.pendingRequests.load(), this.decisions.load(), this.manifests.load(), this.erase.load(), this.recoveryEvidence.load(), this.recoveryLog.load(), this.executionLog.load(), this.planningLog.load(), this.cancellationLog.load(), this.executionRevisionFenceLog.load()]);
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
