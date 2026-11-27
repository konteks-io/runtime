import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  RemoteDeliveryAcceptanceReceiptSchema,
  RemoteDeliveryResultCandidateSchema,
  SessionToCoreMessageSchema,
  canonicalize,
  createLogger,
  sha256Hex,
  type Logger,
  type RemoteDeliveryAcceptanceReceipt,
  type RemoteDeliveryResultCandidate,
  type SessionToCoreMessage,
} from "@konteks/remote-common";
import { readFully } from "../read-fully.js";
import { innerDiagnostic, LoggedRefusal } from "./named-refusal.js";

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const RecordSchema = z.discriminatedUnion("state", [
  z.object({ version: z.literal(1), state: z.literal("pending"), candidate: RemoteDeliveryResultCandidateSchema, completion: SessionToCoreMessageSchema }).strict(),
  z.object({ version: z.literal(1), state: z.literal("accepted"), candidate: RemoteDeliveryResultCandidateSchema, completion: SessionToCoreMessageSchema, receipt: RemoteDeliveryAcceptanceReceiptSchema }).strict(),
])
  .refine(record => record.completion.kind === "acp_result" && record.completion.method === "session/prompt", "Output completion must be a successful ACP prompt result")
  .refine(record => record.state !== "accepted" || receiptMatches(record.receipt, record.candidate), "Output acceptance must match the frozen candidate");
export type NativeOutputRecord = z.infer<typeof RecordSchema>;
const TurnIdentitySchema = z.object({ sessionId: z.string().min(1).max(256), invocationId: z.string().min(1).max(256), claimId: z.string().min(1).max(256) }).strict();
const ExpectedAcceptanceSchema = TurnIdentitySchema.omit({ sessionId: true }).extend({ acceptanceId: z.string().min(1).max(256), resultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
/** Core's signed acceptance of the latest turn when this computer holds no
 * receipt for it: proven by a restored checkpoint (`checkpointDigest`), or by
 * the exact candidate retained here when the acceptance reply was lost. */
const RecoveredAcceptanceSchema = z.object({ acceptance: ExpectedAcceptanceSchema, checkpointDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }).strict();
const SessionHeadSchema = z.object({ version: z.literal(1), recovered: RecoveredAcceptanceSchema.optional(), latest: TurnIdentitySchema.optional(),
  pending: TurnIdentitySchema.optional(), cleanup: TurnIdentitySchema.optional() }).strict()
  .refine(value => value.latest !== undefined || value.pending !== undefined,
    "An output session head must retain an accepted or pending turn");
type TurnIdentity = z.infer<typeof TurnIdentitySchema>;
/** Each refusal names its check; identifiers only, never paths or record contents. */
const unavailable = (diagnostic: string) => new LoggedRefusal("capability_unavailable", "Durable generated output state is unavailable.", diagnostic);

/** One private, atomic record per stable-session turn, outside its Git worktree.
 * Candidate bytes survive response loss/restart and superseded accepted turns
 * are removed only after the exact successor has itself been accepted. */
export class NativeOutputStore {
  private readonly path: string;
  private readonly turn: TurnIdentity | undefined;
  private readonly logger: Logger;
  constructor(container: string, turn?: { sessionId: string; invocationId: string; claimId: string }, exactPath?: string, options: { logger?: Logger } = {}) {
    this.turn = turn ? TurnIdentitySchema.parse(turn) : undefined;
    this.path = exactPath ?? join(container, this.turn
      ? `.delivery-output-${sha256Hex(canonicalize(this.turn))}.json`
      : "delivery-output.json");
    this.logger = options.logger ?? createLogger({ name: "native-output-store" });
  }

  static retained(path: string): NativeOutputStore {
    return new NativeOutputStore(dirname(path), undefined, path);
  }

  async read(): Promise<NativeOutputRecord | null> {
    try {
      const before = await lstat(this.path);
      if (!privateRecordFile(before, MAX_RECORD_BYTES)) throw unavailable("output_record_not_private");
      const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const bytes = await readUnchanged(handle, before);
        return RecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      } finally { await handle.close(); }
    } catch (error) {
      if (missing(error)) return null;
      throw unavailable(innerDiagnostic(error, "output_record_unreadable"));
    }
  }

  async savePending(candidate: RemoteDeliveryResultCandidate, completion: SessionToCoreMessage): Promise<void> {
    const parsed = RemoteDeliveryResultCandidateSchema.parse(candidate);
    const parsedCompletion = SessionToCoreMessageSchema.parse(completion);
    if (parsedCompletion.kind !== "acp_result" || parsedCompletion.method !== "session/prompt") throw unavailable("output_completion_not_prompt_result");
    if (this.turn && !candidateOfTurn(parsed, this.turn)) throw unavailable("output_candidate_other_turn");
    const existing = await this.read();
    if (existing) {
      if (!sameCandidate(existing, parsed, parsedCompletion)) throw unavailable("output_candidate_conflict");
      return;
    }
    await this.write({ version: 1, state: "pending", candidate: parsed, completion: parsedCompletion });
  }

  async saveAccepted(candidate: RemoteDeliveryResultCandidate, receipt: RemoteDeliveryAcceptanceReceipt): Promise<void> {
    const existing = await this.read();
    if (!existing) throw unavailable("output_accept_without_record");
    const record = RecordSchema.parse({ version: 1, state: "accepted", candidate, completion: existing.completion, receipt });
    if (record.state !== "accepted" || !receiptMatches(record.receipt, record.candidate)) throw unavailable("output_receipt_mismatch");
    if (canonicalize(existing.candidate as never) !== canonicalize(record.candidate as never)) throw unavailable("output_accept_candidate_changed");
    if (existing.state === "accepted") {
      if (canonicalize(existing.receipt as never) !== canonicalize(record.receipt as never)) throw unavailable("output_receipt_conflict");
      return;
    }
    await this.write(record);
  }

  async removeAccepted(expected: { invocationId: string; claimId: string; acceptanceId: string; resultDigest: string }): Promise<void> {
    const record = await this.read();
    if (!record || record.state !== "accepted" || record.receipt.invocationRef !== expected.invocationId ||
        record.receipt.claimId !== expected.claimId || record.receipt.acceptanceId !== expected.acceptanceId ||
        record.receipt.resultDigest !== expected.resultDigest) throw unavailable("output_remove_receipt_mismatch");
    await this.remove();
  }

  /** Keep another workspace's accepted record of this exact turn here, unchanged. */
  async adopt(record: NativeOutputRecord): Promise<void> {
    if (record.state !== "accepted" || (this.turn && !candidateOfTurn(record.candidate, this.turn))) throw unavailable("output_adopt_not_accepted");
    const existing = await this.read();
    if (existing) {
      if (canonicalize(existing as never) !== canonicalize(record as never)) throw unavailable("output_adopt_conflict");
      return;
    }
    await this.write(record);
  }

  async removePending(): Promise<void> {
    const record = await this.read();
    if (!record || record.state !== "pending") throw unavailable("output_remove_not_pending");
    await this.remove();
  }

  private async write(record: NativeOutputRecord): Promise<void> {
    const startedAt = Date.now();
    const bytes = Buffer.from(JSON.stringify(RecordSchema.parse(record)) + "\n");
    if (bytes.byteLength > MAX_RECORD_BYTES) throw unavailable("output_record_too_large");
    const temporary = join(dirname(this.path), `.delivery-output-${randomUUID()}.tmp`);
    let fsyncStartedAt = 0;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.chmod(0o600); fsyncStartedAt = Date.now(); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.path);
      if (process.platform !== "win32") { const directory = await open(dirname(this.path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
      this.logger.info({ event: "native.output.persisted", correlationId: record.candidate.invocationRef, stage: "store", outcome: record.state,
        bytes: bytes.byteLength, resultDigest: record.candidate.resultDigest, fsyncDurationMs: Date.now() - fsyncStartedAt,
        durationMs: Date.now() - startedAt }, "native delivery output persisted");
    } catch { throw unavailable("output_record_write_failed"); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async remove(): Promise<void> {
    await rm(this.path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
}

/** O(1), crash-repairable accepted-output retention for one stable ACP Session. */
export class NativeOutputSessionHeadStore {
  private readonly path: string;
  constructor(private readonly root: string, private readonly sessionId: string) {
    this.path = join(root, `.delivery-session-${sha256Hex(canonicalize({ sessionId }))}.json`);
  }

  record(identity: Omit<TurnIdentity, "sessionId">): NativeOutputStore {
    return new NativeOutputStore(this.root, { sessionId: this.sessionId, ...identity });
  }

  /** Journal the sole in-flight output turn before bytes are captured. A
   * later Core-fenced turn may discard an abandoned pending record, but never
   * an accepted record whose head promotion may merely have lost its fsync. */
  async begin(current: Omit<TurnIdentity, "sessionId">): Promise<void> {
    const identity = TurnIdentitySchema.parse({ sessionId: this.sessionId, ...current });
    const settled = await this.settled();
    const pending = settled?.pending;
    if (pending && sameTurn(pending, identity)) return;
    if (pending) await this.discardAbandoned(pending);
    await this.write({ version: 1, ...latestOf(settled), pending: identity });
  }

  /** The head after any finished cleanup it still records. */
  private async settled(): Promise<SessionHead | null> {
    const before = await this.read();
    if (before) await this.cleanup(before);
    return this.read();
  }

  /** An abandoned pending record may go; an accepted one may only have lost its head promotion, and refuses. */
  private async discardAbandoned(pending: TurnIdentity): Promise<void> {
    const abandoned = await this.record(pending).read();
    if (abandoned?.state === "accepted") throw unavailable("output_abandoned_turn_accepted");
    if (abandoned) await rmRecord(this.record(pending));
  }

  /** The caller has verified the restored checkpoint and Core's signed
   * expected acceptance. This retains historical lineage, never a fabricated
   * candidate, completion or new delivery acceptance. Existing records stay. */
  async recoverVerifiedAcceptance(expected: ExpectedAcceptance, current: Omit<TurnIdentity, "sessionId">, checkpointDigest: string): Promise<void> {
    const recovered = RecoveredAcceptanceSchema.parse({ acceptance: expected, checkpointDigest });
    const before = await this.settled();
    if (turnIs(before?.latest, current)) { await this.verifyExpected(expected, current); return; }
    const pending = await this.pendingFor(before?.pending, current);
    assertRecoveryCompatible(before ? { ...before, pending } : null, expected, current);
    if (before?.latest) await this.assertAccepted(expected);
    const latest = TurnIdentitySchema.parse({ sessionId: this.sessionId, invocationId: expected.invocationId, claimId: expected.claimId });
    await this.write({ version: 1, latest, recovered, ...(pending ? { pending } : {}) });
  }

  /**
   * The pending turn a Core-fenced turn keeps: its own, or none once another
   * turn's abandoned pending record is discarded as `begin` discards it. An
   * accepted record may only have lost its promotion, and still refuses.
   */
  private async pendingFor(pending: TurnIdentity | undefined, current: Omit<TurnIdentity, "sessionId">): Promise<TurnIdentity | undefined> {
    if (!pending || turnIs(pending, current)) return pending;
    await this.discardAbandoned(pending);
    return undefined;
  }

  /** The output this session's last accepted turn produced here, when this computer still records one. Read-only. */
  async latestAccepted(): Promise<{ treeDigest: string; deletions: string[]; files: RemoteDeliveryResultCandidate["files"] } | null> {
    const head = await this.read();
    if (!head?.latest) return null;
    const record = await this.record({ invocationId: head.latest.invocationId, claimId: head.latest.claimId }).read();
    if (record?.state !== "accepted" && !retainedLostAcceptance(head, record)) return null;
    return { treeDigest: record.candidate.files.treeDigest, deletions: [...record.candidate.deletions], files: record.candidate.files };
  }

  async verifyExpected(expected: ExpectedAcceptance, current: Omit<TurnIdentity, "sessionId">): Promise<void> {
    let head = await this.required();
    await this.cleanup(head);
    head = await this.required();
    if (turnIs(head.pending, expected)) head = await this.settleExpectedPending(head, expected);
    if (turnIs(head.latest, current)) {
      const replay = await this.record(current).read();
      if (replay?.state === "accepted") return;
      throw unavailable("output_replay_not_accepted");
    }
    if (!turnIs(head.latest, expected)) throw unavailable("output_head_unexpected_turn");
    await this.assertAccepted(expected);
  }

  /** Core's signed selection names the pending turn as its accepted result. */
  private async settleExpectedPending(head: SessionHead, expected: ExpectedAcceptance): Promise<SessionHead> {
    const turn = { invocationId: expected.invocationId, claimId: expected.claimId };
    const record = await this.record(turn).read();
    if (record?.state === "pending" && record.candidate.resultDigest === expected.resultDigest) {
      const next = SessionHeadSchema.parse({ version: 1, latest: head.pending, recovered: { acceptance: expected },
        ...(head.latest ? { cleanup: head.latest } : {}) });
      await this.write(next);
      await this.cleanup(next);
      return this.required();
    }
    await this.assertAccepted(expected);
    await this.promote(turn);
    return this.required();
  }

  private async required(): Promise<SessionHead> {
    const head = await this.read();
    if (!head) throw unavailable("output_head_missing");
    return head;
  }

  private async assertAccepted(expected: ExpectedAcceptance): Promise<void> {
    if (recoveredAcceptanceMatches(await this.read(), expected)) return;
    const record = await this.record({ invocationId: expected.invocationId, claimId: expected.claimId }).read();
    if (!record || record.state !== "accepted" || record.receipt.acceptanceId !== expected.acceptanceId ||
        record.receipt.resultDigest !== expected.resultDigest) throw unavailable("output_expected_not_accepted");
  }

  /**
   * The session's agent changed on this computer (D206 rebind): its accepted
   * output is recorded in the previous agent's workspace, and this one had
   * none, so every continuation refused (A44, 2026-10-21). Adopt exactly the
   * head that names Core's expected accepted turn and that turn's accepted
   * record, unchanged. Nothing is adopted when this workspace already has a
   * head, and `verifyExpected` still checks everything adopted.
   */
  async adoptFromSibling(siblingRoots: ReadonlyArray<string>, expected: ExpectedAcceptance): Promise<boolean> {
    if (await this.read()) return false;
    const turn = { invocationId: expected.invocationId, claimId: expected.claimId };
    for (const root of siblingRoots) {
      const sibling = new NativeOutputSessionHeadStore(root, this.sessionId);
      const head = await sibling.read().catch(() => null);
      if (!head?.latest || !turnIs(head.latest, expected)) continue;
      const record = await sibling.record(turn).read().catch(() => null);
      if (!acceptedAs(record, expected)) continue;
      await this.record(turn).adopt(record);
      await this.write({ version: 1, latest: head.latest });
      return true;
    }
    return false;
  }

  async promote(current: Omit<TurnIdentity, "sessionId">): Promise<void> {
    const identity = TurnIdentitySchema.parse({ sessionId: this.sessionId, ...current });
    const before = await this.read();
    if (isTurn(before?.latest, identity)) {
      await this.cleanup(before!);
      return;
    }
    if (!isTurn(before?.pending, identity)) throw unavailable("output_promote_not_pending");
    const record = await this.record(current).read();
    if (record?.state !== "accepted") throw unavailable("output_promote_not_accepted");
    const next = SessionHeadSchema.parse({ version: 1, latest: identity, ...(before!.latest ? { cleanup: before!.latest } : {}) });
    await this.releaseLostAcceptance(before!);
    await this.write(next);
    await this.cleanup(next);
  }

  /** The retained candidate of a lost acceptance reply goes once a successor is accepted. */
  private async releaseLostAcceptance(head: SessionHead): Promise<void> {
    if (!head.latest) return;
    const store = this.record(head.latest);
    if (retainedLostAcceptance(head, await store.read())) await store.removePending();
  }

  private async cleanup(head: z.infer<typeof SessionHeadSchema>): Promise<void> {
    if (!head.cleanup) return;
    const record = new NativeOutputStore(this.root, head.cleanup);
    const retained = await record.read();
    if (retained?.state === "pending") throw unavailable("output_cleanup_pending");
    if (retained) await record.removeAccepted({ invocationId: retained.receipt.invocationRef,
      claimId: retained.receipt.claimId, acceptanceId: retained.receipt.acceptanceId,
      resultDigest: retained.receipt.resultDigest });
    await this.write({ version: 1, ...latestOf(head), ...(head.pending ? { pending: head.pending } : {}) });
  }

  private async read(): Promise<SessionHead | null> {
    try {
      const before = await lstat(this.path);
      if (!privateRecordFile(before, 16 * 1024)) throw unavailable("output_head_not_private");
      const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { return SessionHeadSchema.parse(JSON.parse(await handle.readFile("utf8"))); }
      finally { await handle.close(); }
    } catch (error) {
      if (missing(error)) return null;
      throw unavailable(innerDiagnostic(error, "output_head_unreadable"));
    }
  }

  private async write(value: z.infer<typeof SessionHeadSchema>): Promise<void> {
    const temporary = `${this.path}.new-${randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(SessionHeadSchema.parse(value))); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.path);
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  }
}

type SessionHead = z.infer<typeof SessionHeadSchema>;
type ExpectedAcceptance = z.infer<typeof ExpectedAcceptanceSchema>;

/** A private, singly linked regular file of at most `maxBytes`, readable and writable by its owner only. */
function privateRecordFile(info: Stats, maxBytes: number): boolean {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) return false;
  return process.platform === "win32" || (info.mode & 0o7777) === 0o600;
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** The opened file's bytes, when it is the file inspected and did not change while it was read. */
async function readUnchanged(handle: FileHandle, before: Stats): Promise<Buffer> {
  const stat = await handle.stat();
  if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw unavailable("output_record_replaced");
  const bytes = Buffer.alloc(stat.size + 1);
  const offset = await readFully(handle, bytes);
  const after = await handle.stat();
  if (offset !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw unavailable("output_record_changed_while_read");
  return bytes.subarray(0, offset);
}

function candidateOfTurn(candidate: RemoteDeliveryResultCandidate, turn: TurnIdentity): boolean {
  return candidate.binding.sessionId === turn.sessionId && candidate.invocationRef === turn.invocationId && candidate.claimId === turn.claimId;
}

/** The record already holds exactly this candidate and completion. */
function sameCandidate(existing: NativeOutputRecord, candidate: RemoteDeliveryResultCandidate, completion: SessionToCoreMessage): boolean {
  return canonicalize(existing.candidate as never) === canonicalize(candidate as never) && canonicalize(existing.completion as never) === canonicalize(completion as never);
}

function latestOf(head: SessionHead | null): Pick<SessionHead, "latest" | "recovered"> {
  return { ...(head?.latest ? { latest: head.latest } : {}), ...(head?.recovered ? { recovered: head.recovered } : {}) };
}

/** An accepted record of exactly the turn, acceptance and result Core expects. */
function acceptedAs(record: NativeOutputRecord | null, expected: ExpectedAcceptance): record is NativeOutputRecord & { state: "accepted" } {
  return record?.state === "accepted" && record.receipt.acceptanceId === expected.acceptanceId &&
    record.receipt.resultDigest === expected.resultDigest;
}

/** Whether a head entry names this invocation and claim. */
function turnIs(turn: TurnIdentity | undefined, expected: Omit<TurnIdentity, "sessionId">): boolean {
  return turn?.invocationId === expected.invocationId && turn.claimId === expected.claimId;
}

function isTurn(turn: TurnIdentity | undefined, identity: TurnIdentity): boolean {
  return turn !== undefined && sameTurn(turn, identity);
}

function sameTurn(left: TurnIdentity, right: TurnIdentity): boolean {
  return left.sessionId === right.sessionId && left.invocationId === right.invocationId && left.claimId === right.claimId;
}

async function rmRecord(store: NativeOutputStore): Promise<void> {
  const record = await store.read();
  if (!record || record.state !== "pending") throw unavailable("output_discard_not_pending");
  await store.removePending();
}

function receiptMatches(receipt: RemoteDeliveryAcceptanceReceipt, candidate: RemoteDeliveryResultCandidate): boolean {
  return receipt.invocationRef === candidate.invocationRef && receipt.claimId === candidate.claimId && receipt.resultId === candidate.resultId &&
    receipt.resultDigest === candidate.resultDigest && receipt.inputSelectionDigest === candidate.inputSelectionDigest && receipt.baseRevision === candidate.baseRevision &&
    canonicalize(receipt.binding as never) === canonicalize(candidate.binding as never);
}

/**
 * Harness accepted the latest turn's output, but the acceptance reply never
 * reached this computer (a fenced relay, D112c; TKT-4, 2026-11-16), so its
 * exact candidate is still pending here with no receipt. Core's signed
 * acceptance is the proof, as a verified checkpoint's is; no receipt is
 * invented, and the candidate stays the previous output the next turn
 * captures against.
 */
function retainedLostAcceptance(head: SessionHead, record: NativeOutputRecord | null): record is NativeOutputRecord {
  return Boolean(record?.state === "pending" && head.recovered && head.latest && !head.recovered.checkpointDigest &&
    turnIs(head.latest, head.recovered.acceptance) && candidateOfTurn(record.candidate, head.latest) &&
    record.candidate.resultDigest === head.recovered.acceptance.resultDigest);
}

function recoveredAcceptanceMatches(head: SessionHead | null, expected: ExpectedAcceptance): boolean {
  return Boolean(head?.recovered && turnIs(head.latest, expected) &&
    canonicalize(head.recovered.acceptance) === canonicalize(expected));
}

function assertRecoveryCompatible(head: SessionHead | null, expected: ExpectedAcceptance, current: Omit<TurnIdentity, "sessionId">): void {
  if (head?.latest && !turnIs(head.latest, expected)) throw unavailable("output_recovery_latest_mismatch");
  if (head?.pending && !turnIs(head.pending, current)) throw unavailable("output_recovery_pending_mismatch");
}
