import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  AssignmentClaimSchema, AssignmentPullSchema, AssignmentReportSchema,
  AssignmentRequestKindSchema, AssignmentRequestOriginSchema, AssignmentRequestReferenceSchema,
  AssignmentResponseReferenceSchema, AssignmentTransportReplySchema, LogicalAssignmentRequestFrameSchema, LogicalAssignmentReplyFrameSchema,
  PendingClaimRequestSchema, RemoteInstanceError, canonicalize, jcsDigest, logicalAssignmentRequestDigest,
  NativeCoreRequestAckSchema,
  logicalAssignmentResponseDigest, type AssignmentRequestReference, type PendingClaimRequest,
} from "@konteks/remote-common";
import { LocalAdmissionSchema } from "./local-admission.js";
import type { LocalExecutionJournal, LocalExecutionRecord, ExecutionLog } from "./local-execution.js";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const scope = { instanceId: id, workspaceId: id };
const ScopeSchema = z.object(scope).strict();
type Scope = z.infer<typeof ScopeSchema>;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ClaimFrameSchema = LogicalAssignmentRequestFrameSchema.safeExtend({ body: AssignmentClaimSchema });
export const AssignmentStreamStateSchema = z.object({
  schemaVersion: z.literal(1), ...scope, enrollmentId: id, channelId: id,
  allocatedThrough: counter,
  // Observation advances only through the explicit authenticated ACK owner.
  observedCoreRequestAckSequence: counter, retiredThroughRequestSequence: counter,
  // Advanced only by the durable reply owner below; still never an ACK or floor.
  nativeConsumedReplySequence: counter,
  // Local deletion prefix, independent of the request floor and never a wire ACK.
  // Old heads lack it and retain their complete reply history from sequence 1.
  compactedThroughReplySequence: counter.default(0),
}).strict().refine(value => value.channelId === `assignment:${value.instanceId}`, "Canonical assignment channel required")
  .refine(value => value.observedCoreRequestAckSequence <= value.allocatedThrough, "Observed ACK exceeds retained allocation history")
  .refine(value => value.retiredThroughRequestSequence <= value.observedCoreRequestAckSequence, "Retirement exceeds explicit ACK")
  .refine(value => value.compactedThroughReplySequence <= value.nativeConsumedReplySequence, "Reply deletion exceeds consumption");
export type AssignmentStreamState = z.infer<typeof AssignmentStreamStateSchema>;
/**
 * One retained outbound request. A claim additionally binds the exact immutable
 * admission it was chosen for; a pull or report has no admission of its own, so
 * requiring one would force the sender to invent identity it does not have.
 */
export const AssignmentRequestRecordSchema = z.object({
  schemaVersion: z.literal(1), ...scope, frame: LogicalAssignmentRequestFrameSchema, digest,
  admission: LocalAdmissionSchema.optional(), admissionDigest: digest.optional(),
  /** Absent only on historical unowned operation allocations. */
  operationId: id.optional(),
}).strict().superRefine((value, context) => {
  const { admission, frame } = value;
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (value.digest !== logicalAssignmentRequestDigest(frame) || frame.channelId !== `assignment:${value.instanceId}`) {
    fail("Stored allocation must bind its exact immutable frame");
    return;
  }
  const kind = requestKindOf(frame);
  if (kind === "claim" && value.operationId !== undefined) fail("Claim ownership belongs to its admission, not an operation");
  if ((kind === "claim") !== (admission !== undefined)) {
    fail("Exactly a claim allocation carries its admission");
    return;
  }
  if (!admission) return;
  const body = frame.body as z.infer<typeof AssignmentClaimSchema>;
  if (value.admissionDigest !== jcsDigest(admission) ||
    admission.instanceId !== value.instanceId || admission.workspaceId !== value.workspaceId ||
    frame.origin.runnerIncarnation !== admission.runnerIncarnation ||
    body.assignmentId !== admission.assignmentId || body.attempt !== admission.attempt ||
    body.claimId !== admission.claimId || body.agentId !== admission.agentId) {
    fail("Stored claim allocation must bind its exact immutable admission and frame");
  }
});
export type AssignmentRequestRecord = z.infer<typeof AssignmentRequestRecordSchema>;

/** The operation a retained frame carries; the body's own shape decides it. */
export function requestKindOf(frame: z.infer<typeof LogicalAssignmentRequestFrameSchema>): "pull" | "claim" | "report" {
  const body = frame.body as Record<string, unknown>;
  if ("maxItems" in body) return "pull";
  if ("reportId" in body) return "report";
  return "claim";
}
/** Historical body-only evidence is readable, but cannot independently prove its digest. */
const LegacyAssignmentReplyRecordValueSchema = z.object({
  ...scope,
  request: z.object({ requestSequence: counter.min(1), requestDigest: digest, requestKind: AssignmentRequestKindSchema }).strict(),
  response: AssignmentResponseReferenceSchema,
  body: AssignmentTransportReplySchema,
}).strict().superRefine((value, context) => {
  if (value.body.requestSequence !== value.request.requestSequence || value.body.requestDigest !== value.request.requestDigest
    || value.body.requestKind !== value.request.requestKind) {
    context.addIssue({ code: "custom", message: "Reply body must correlate to the exact retained request" });
  }
});
/** Core deliveryId is attempt metadata, not the native logical reply identity. */
const LocalResponseReferenceSchema = z.object({ sequence: counter.min(1), digest }).strict();
const ReportOperationOwnerSchema = z.object({ reportId: id, key: id, group: id, order: counter.min(1) }).strict();
const OperationEffectSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.enum(["applying", "applied"]), response: LocalResponseReferenceSchema }).strict(),
]);
const RetryAfterSchema = z.object({ request: AssignmentRequestReferenceSchema, response: LocalResponseReferenceSchema }).strict();
const operationBase = { schemaVersion: z.literal(1), ...scope, operationId: id,
  request: AssignmentRequestReferenceSchema, effect: OperationEffectSchema };
export const AssignmentOperationSchema = z.discriminatedUnion("kind", [
  z.object({ ...operationBase, kind: z.literal("pull") }).strict(),
  z.object({ ...operationBase, kind: z.literal("report"), report: ReportOperationOwnerSchema, retryAfter: RetryAfterSchema.optional() }).strict(),
]);
export type AssignmentOperation = z.infer<typeof AssignmentOperationSchema>;
export const AssignmentOperationRecordSchema = z.object({ kind: z.literal("assignment_operation"), value: AssignmentOperationSchema }).strict();
export const AssignmentReplyRecordValueSchema = z.object({
  schemaVersion: z.literal(2), ...scope,
  request: z.object({ requestSequence: counter.min(1), requestDigest: digest, requestKind: AssignmentRequestKindSchema }).strict(),
  response: LocalResponseReferenceSchema,
  frame: LogicalAssignmentReplyFrameSchema,
}).strict().superRefine((value, context) => {
  const { frame, request, response } = value;
  if (frame.channelId !== `assignment:${value.instanceId}` || frame.seq !== response.sequence ||
    logicalAssignmentResponseDigest(frame) !== response.digest ||
    frame.body.requestSequence !== request.requestSequence || frame.body.requestDigest !== request.requestDigest ||
    frame.body.requestKind !== request.requestKind) {
    context.addIssue({ code: "custom", message: "Complete logical reply must match its channel, digest and request" });
  }
});
export type AssignmentReplyRecordValue = z.infer<typeof AssignmentReplyRecordValueSchema>;
const StoredAssignmentReplyRecordValueSchema = z.union([AssignmentReplyRecordValueSchema, LegacyAssignmentReplyRecordValueSchema]);
type StoredAssignmentReplyRecordValue = z.infer<typeof StoredAssignmentReplyRecordValueSchema>;
function verified(value: StoredAssignmentReplyRecordValue): value is AssignmentReplyRecordValue { return "schemaVersion" in value && value.schemaVersion === 2; }
function replyBody(value: StoredAssignmentReplyRecordValue) { return verified(value) ? value.frame.body : value.body; }
export const AssignmentReplyRecordSchema = z.object({ kind: z.literal("assignment_reply"), value: StoredAssignmentReplyRecordValueSchema }).strict();
export const AssignmentStreamRecordSchema = z.object({ kind: z.literal("assignment_stream"), value: AssignmentStreamStateSchema }).strict();
export const AssignmentAllocationRecordSchema = z.object({ kind: z.literal("assignment_request"), value: AssignmentRequestRecordSchema }).strict();
const AllocationInputSchema = z.object({ admission: LocalAdmissionSchema, origin: AssignmentRequestOriginSchema, issuedAt: z.string().datetime() }).strict();
const operationInputBase = { ...scope, operationId: id, runnerIncarnation: id, origin: AssignmentRequestOriginSchema, issuedAt: z.string().datetime() };
const OperationInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...operationInputBase, kind: z.literal("pull"), body: AssignmentPullSchema }).strict(),
  z.object({ ...operationInputBase, kind: z.literal("report"), body: AssignmentReportSchema, report: ReportOperationOwnerSchema,
    retryAfter: AssignmentRequestReferenceSchema.optional() }).strict(),
]);
const FreshPullInputSchema = z.object({ ...scope, runnerIncarnation: id, origin: AssignmentRequestOriginSchema,
  issuedAt: z.string().datetime(), body: AssignmentPullSchema }).strict();
export const LOCAL_ASSIGNMENT_ALLOCATION_LIMITS = { maxRequests: 2048, maxBytes: 16 * 1024 * 1024 } as const;
const TRANSPORT_RECEIPT_LIMITS = { maxRecords: 16_384, maxBytes: 64 * 1024 * 1024 } as const;
const ReceiptLimitsSchema = z.object({
  maxRecords: z.number().int().min(1).max(TRANSPORT_RECEIPT_LIMITS.maxRecords),
  maxBytes: z.number().int().min(1).max(TRANSPORT_RECEIPT_LIMITS.maxBytes),
}).strict();
const AllocationLimitsSchema = z.object({
  maxRequests: z.number().int().min(1).max(LOCAL_ASSIGNMENT_ALLOCATION_LIMITS.maxRequests),
  maxBytes: z.number().int().min(1).max(LOCAL_ASSIGNMENT_ALLOCATION_LIMITS.maxBytes),
}).strict();

export function assignmentStreamKey(): string { return "assignment_stream"; }
export function assignmentRequestKey(sequence: number): string { return JSON.stringify(["assignment_request", sequence]); }
export function assignmentReplyKey(sequence: number): string { return JSON.stringify(["assignment_reply", sequence]); }
export function assignmentOperationKey(operationId: string): string { return JSON.stringify(["assignment_operation", operationId]); }
export function initialAssignmentStream(binding: Scope & { enrollmentId: string }): AssignmentStreamState {
  return AssignmentStreamStateSchema.parse({ schemaVersion: 1, ...binding, channelId: `assignment:${binding.instanceId}`, allocatedThrough: 0,
    observedCoreRequestAckSequence: 0, retiredThroughRequestSequence: 0, nativeConsumedReplySequence: 0 });
}
export function allocationReference(value: AssignmentRequestRecord): AssignmentRequestReference {
  return { requestSequence: value.frame.seq, requestDigest: value.digest, requestKind: requestKindOf(value.frame) };
}
function same(a: unknown, b: unknown): boolean { return a !== undefined && b !== undefined && canonicalize(a as never) === canonicalize(b as never); }
function bytes(value: unknown): number { return Buffer.byteLength(canonicalize(value as never), "utf8"); }
function recovery(): RemoteInstanceError { return new RemoteInstanceError("recovery_required", "Assignment stream recovery requires complete, consistent retained allocation history."); }
function retired(): RemoteInstanceError { return new RemoteInstanceError("assignment_replay_retired", "The submitted sequence is below the durable retirement floor; no retained digest comparison is asserted."); }

/** Validate all retained relations before a stream or execution guard can authorize.
 * Only the durable floors permit absent transport records. Required domain
 * evidence below those floors remains fully validated and is never evicted.
 */
export function validateAssignmentStreamRecords(records: readonly LocalExecutionRecord[]): { head?: AssignmentStreamState; requests: Map<number, AssignmentRequestRecord>; replies: Map<number, StoredAssignmentReplyRecordValue>; repliesByRequest: Map<number, StoredAssignmentReplyRecordValue>; operations: Map<string, AssignmentOperation>; retainedBytes: number; receiptBytes: number; receiptCount: number } {
  const enrollment = records.find(record => record.kind === "enrollment_bound");
  const heads = records.filter(record => record.kind === "assignment_stream");
  const allocations = records.filter(record => record.kind === "assignment_request");
  const handled = records.filter(record => record.kind === "assignment_reply");
  const starts = records.filter(record => record.kind === "admission_start");
  const operationRows = records.filter(record => record.kind === "assignment_operation");
  const versioned = enrollment?.kind === "enrollment_bound" && enrollment.value.assignmentStreamVersion === 1;
  if (!versioned) {
    if (heads.length || allocations.length || handled.length || operationRows.length || starts.some(record => record.value.delivery === "allocated")) throw recovery();
    return { requests: new Map(), replies: new Map(), repliesByRequest: new Map(), operations: new Map(), retainedBytes: 0, receiptBytes: 0, receiptCount: 0 };
  }
  if (heads.length !== 1) throw recovery();
  const head = AssignmentStreamStateSchema.parse(heads[0]!.value);
  if (head.instanceId !== enrollment.value.instanceId || head.workspaceId !== enrollment.value.workspaceId || head.enrollmentId !== enrollment.value.enrollmentId ||
    head.allocatedThrough - head.retiredThroughRequestSequence > LOCAL_ASSIGNMENT_ALLOCATION_LIMITS.maxRequests) throw recovery();
  const requests = new Map<number, AssignmentRequestRecord>();
  const admissions = new Set<string>();
  let retainedBytes = 0;
  for (const record of allocations) {
    const request = AssignmentRequestRecordSchema.parse(record.value);
    if (request.instanceId !== head.instanceId || request.workspaceId !== head.workspaceId || request.frame.seq > head.allocatedThrough || requests.has(request.frame.seq)) throw recovery();
    // Only a claim occupies an admission identity; a pull or report names none,
    // so at most one acceptance-unresolved claim exists per admission.
    if (request.admission) {
      const identity = JSON.stringify([request.admission.assignmentId, request.admission.attempt]);
      if (admissions.has(identity)) throw recovery();
      const start = starts.find(row => same(row.value.admission, request.admission));
      if (!start || start.value.delivery !== "allocated" || !same(start.value.allocation, allocationReference(request))) throw recovery();
      admissions.add(identity);
    }
    requests.set(request.frame.seq, request);
    if (request.frame.seq > head.retiredThroughRequestSequence) retainedBytes += bytes(request);
  }
  if (retainedBytes > LOCAL_ASSIGNMENT_ALLOCATION_LIMITS.maxBytes) throw recovery();
  for (let sequence = head.retiredThroughRequestSequence + 1; sequence <= head.allocatedThrough; sequence++) if (!requests.has(sequence)) throw recovery();
  for (const start of starts) {
    if (start.value.delivery !== "allocated") continue;
    const request = start.value.allocation && requests.get(start.value.allocation.requestSequence);
    if (!request || !same(request.admission, start.value.admission) || !same(allocationReference(request), start.value.allocation)) throw recovery();
  }
  // Consumed replies are contiguous from 1 and each names a retained request.
  const replies = new Map<number, StoredAssignmentReplyRecordValue>();
  const repliesByRequest = new Map<number, StoredAssignmentReplyRecordValue>();
  const correlated = new Set<number>();
  for (const record of handled) {
    const value = StoredAssignmentReplyRecordValueSchema.parse(record.value);
    const request = requests.get(value.request.requestSequence);
    if (value.instanceId !== head.instanceId || value.workspaceId !== head.workspaceId || !request ||
      request.digest !== value.request.requestDigest || replies.has(value.response.sequence) ||
      correlated.has(value.request.requestSequence) || value.response.sequence > head.nativeConsumedReplySequence) throw recovery();
    assertReplyIdentity(request, value);
    replies.set(value.response.sequence, value); correlated.add(value.request.requestSequence);
    repliesByRequest.set(value.request.requestSequence, value);
  }
  if (head.nativeConsumedReplySequence - head.compactedThroughReplySequence > TRANSPORT_RECEIPT_LIMITS.maxRecords) throw recovery();
  let receiptBytes = 0;
  let receiptCount = 0;
  for (const value of replies.values()) {
    if (value.response.sequence <= head.compactedThroughReplySequence && value.request.requestSequence > head.retiredThroughRequestSequence) throw recovery();
    if (value.request.requestSequence > head.retiredThroughRequestSequence) { receiptBytes += bytes(value); receiptCount++; }
  }
  if (receiptBytes > TRANSPORT_RECEIPT_LIMITS.maxBytes) throw recovery();
  for (let sequence = head.compactedThroughReplySequence + 1; sequence <= head.nativeConsumedReplySequence; sequence++) if (!replies.has(sequence)) throw recovery();
  for (const start of starts) {
    if (!start.value.claimEffect) continue;
    const receipt = start.value.allocation && repliesByRequest.get(start.value.allocation.requestSequence);
    if (!receipt || !verified(receipt) || receipt.request.requestKind !== "claim" || !same(receipt.response, start.value.claimEffect.response)) throw recovery();
  }
  const operations = new Map<string, AssignmentOperation>();
  let pendingPulls = 0;
  const reportHeads = new Map<string, AssignmentOperation>();
  for (const row of operationRows.sort((a, b) => a.value.request.requestSequence - b.value.request.requestSequence)) {
    const operation = AssignmentOperationSchema.parse(row.value);
    const request = requests.get(operation.request.requestSequence);
    if (operations.has(operation.operationId) || operation.instanceId !== head.instanceId || operation.workspaceId !== head.workspaceId ||
      !request || request.operationId !== operation.operationId || !same(operation.request, allocationReference(request)) || operation.kind !== requestKindOf(request.frame)) throw recovery();
    const receipt = repliesByRequest.get(request.frame.seq);
    if (operation.effect.state !== "pending" && (!receipt || !verified(receipt) || !same(operation.effect.response, receipt.response))) throw recovery();
    if (operation.kind === "pull") {
      if (operation.effect.state !== "applied") pendingPulls++;
    } else {
      assertReportOwner(operation.report, request.frame.body as z.infer<typeof AssignmentReportSchema>);
      const previous = reportHeads.get(operation.report.reportId);
      if (operation.retryAfter) {
        if (!previous || previous.kind !== "report" || !same(previous.report, operation.report) || !same(previous.request, operation.retryAfter.request) ||
          previous.request.requestSequence >= operation.request.requestSequence) throw recovery();
        const previousReply = repliesByRequest.get(previous.request.requestSequence);
        if (!previousReply || !verified(previousReply) || !same(previousReply.response, operation.retryAfter.response) || !isReportGap(previousReply) ||
          !same(requests.get(previous.request.requestSequence)?.frame.body, request.frame.body)) throw recovery();
      } else if (previous) throw recovery();
      reportHeads.set(operation.report.reportId, operation);
    }
    operations.set(operation.operationId, operation);
  }
  if (pendingPulls > 1 || operations.size > requests.size) throw recovery();
  for (const request of requests.values()) if (request.operationId && operations.get(request.operationId)?.request.requestSequence !== request.frame.seq) throw recovery();
  return { head, requests, replies, repliesByRequest, operations, retainedBytes, receiptBytes, receiptCount };
}

function assertReportOwner(owner: z.infer<typeof ReportOperationOwnerSchema>, body: z.infer<typeof AssignmentReportSchema>): void {
  const group = `report:${body.assignmentId}:${body.attempt}:${body.claimId}`;
  if (owner.reportId !== body.reportId || owner.order !== body.reportSequence || owner.group !== group || owner.key !== `${group}:${body.reportSequence}`) throw recovery();
}
function isReportGap(reply: AssignmentReplyRecordValue): boolean {
  return reply.frame.body.requestKind === "report" && "outcome" in reply.frame.body.body && reply.frame.body.body.outcome === "sequence_gap";
}

/** Facade on the SAME local execution log; no independent file, lock or send owner. */
export class AssignmentStreamJournal {
  private revision = -1;
  private indexed: ReturnType<typeof validateAssignmentStreamRecords> = { requests: new Map(), replies: new Map(), repliesByRequest: new Map(), operations: new Map(), retainedBytes: 0, receiptBytes: 0, receiptCount: 0 };
  private readonly limits: z.infer<typeof AllocationLimitsSchema>;
  private readonly receiptLimits: z.infer<typeof ReceiptLimitsSchema>;
  constructor(private readonly log: ExecutionLog, private readonly execution: LocalExecutionJournal,
    limits = { ...LOCAL_ASSIGNMENT_ALLOCATION_LIMITS } as { maxRequests: number; maxBytes: number },
    receiptLimits = { ...TRANSPORT_RECEIPT_LIMITS } as { maxRecords: number; maxBytes: number }) {
    this.limits = AllocationLimitsSchema.parse(limits);
    this.receiptLimits = ReceiptLimitsSchema.parse(receiptLimits);
  }

  private index(scopeInput: Scope): ReturnType<typeof validateAssignmentStreamRecords> {
    const wanted = ScopeSchema.parse(scopeInput);
    if (this.revision !== this.log.revision) {
      // This also checks existing admission/execution/reference invariants.
      this.execution.coverage(wanted.instanceId, wanted.workspaceId);
      this.indexed = validateAssignmentStreamRecords(this.log.all()); this.revision = this.log.revision;
    }
    if (this.indexed.head && (this.indexed.head.instanceId !== wanted.instanceId || this.indexed.head.workspaceId !== wanted.workspaceId)) throw recovery();
    return this.indexed;
  }

  private state(scopeInput: Scope, allowLegacyForReplay = false): ReturnType<typeof validateAssignmentStreamRecords> & { head: AssignmentStreamState } {
    const indexed = this.index(scopeInput);
    if (!indexed.head || (!allowLegacyForReplay && [...indexed.replies.values()].some(value => !verified(value)))) throw recovery();
    return { ...indexed, head: indexed.head };
  }

  /**
   * Acceptance-unresolved claim intents for the recovery inventory. An absent
   * or unversioned stream proves an empty inventory; inconsistent retained
   * history still refuses. A durably handled correlated reply makes domain
   * acceptance known — confirmed or denied — and leaves this inventory without
   * erasing its retained transport frame or admission history.
   */
  pendingClaims(scopeInput: Scope): PendingClaimRequest[] {
    const indexed = this.index(scopeInput);
    if ([...indexed.replies.values()].some(value => !verified(value))) throw recovery();
    if (!indexed.head) {
      if (indexed.requests.size) throw recovery();
      return [];
    }
    const resolved = new Set([...indexed.replies.values()].map(value => value.request.requestSequence));
    // Validate the whole stream above before selecting claims. Pulls and reports
    // retain their replay evidence but have no pending admission to reconcile.
    return [...indexed.requests.keys()].sort((a, b) => a - b).filter(sequence =>
      !resolved.has(sequence) && requestKindOf(indexed.requests.get(sequence)!.frame) === "claim",
    ).map(sequence => {
      const record = indexed.requests.get(sequence)!;
      return PendingClaimRequestSchema.parse({ frame: record.frame, requestDigest: record.digest, admission: record.admission, admissionDigest: record.admissionDigest });
    });
  }

  snapshot(scopeInput: Scope): AssignmentStreamState { return structuredClone(this.state(scopeInput).head); }

  /**
   * The caller has verified the explicit ACK's authenticated carrier and exact
   * exchange. Persist its observation, not arbitrary HTTP response counters.
   * This neither consumes replies nor retires any request or execution history.
   */
  async observeCoreRequestAck(scopeInput: Scope, candidate: unknown, assertOriginalAuthority: () => void): Promise<void> {
    const wanted = ScopeSchema.parse(scopeInput);
    const ack = NativeCoreRequestAckSchema.parse(candidate);
    await this.log.batch(() => {
      assertOriginalAuthority();
      const state = this.state(wanted);
      if (ack.channelId !== state.head.channelId || ack.cumulativeSeq > state.head.allocatedThrough) throw recovery();
      return [{ kind: "assignment_stream", value: { ...state.head,
        observedCoreRequestAckSequence: Math.max(state.head.observedCoreRequestAckSequence, ack.cumulativeSeq) } }];
    });
    // A completed observation is historical fact, not permission for a stale
    // continuation to publish a checkpoint after authority moved during fsync.
    assertOriginalAuthority();
  }

  /**
   * Reclaim only completed pull triples. Claims, reports, retry chains and all
   * admission/execution evidence survive, even below the transport floor.
   * Maintenance uses the existing log lane, including when allocation is full.
   */
  async retire(scopeInput: Scope, assertOriginalAuthority: () => void): Promise<void> {
    const wanted = ScopeSchema.parse(scopeInput);
    await this.log.rewrite(() => {
      assertOriginalAuthority();
      const state = this.state(wanted);
      let floor = state.head.retiredThroughRequestSequence;
      while (floor < state.head.observedCoreRequestAckSequence) {
        const request = state.requests.get(floor + 1);
        const receipt = state.repliesByRequest.get(floor + 1);
        if (!request || !receipt || !verified(receipt) || receipt.response.sequence > state.head.nativeConsumedReplySequence) break;
        const effect = request.admission
          ? this.execution.start(request.admission.assignmentId, request.admission.attempt)?.claimEffect
          : request.operationId ? state.operations.get(request.operationId)?.effect : undefined;
        // This first slice deliberately blocks on uncertain domain work rather
        // than invent an independent effect archive or imply it was applied.
        if (effect?.state !== "applied" || !same(effect.response, receipt.response)) break;
        floor++;
      }
      let replyFloor = state.head.compactedThroughReplySequence;
      while (replyFloor < state.head.nativeConsumedReplySequence) {
        const receipt = state.replies.get(replyFloor + 1);
        if (!receipt || !verified(receipt) || receipt.request.requestSequence > floor) break;
        replyFloor++;
      }
      const removedRequests = new Set<number>();
      const removedReplies = new Set<number>();
      const removedOperations = new Set<string>();
      for (const operation of state.operations.values()) {
        if (operation.kind !== "pull" || operation.effect.state !== "applied" || operation.request.requestSequence > floor) continue;
        const receipt = state.repliesByRequest.get(operation.request.requestSequence);
        if (!receipt || !verified(receipt) || receipt.response.sequence > replyFloor) continue;
        // A work-bearing pull's durable handoff is not, by itself, a proof
        // that its offered assignment identities survive independent of it.
        // This slice reclaims empty polls only; required offers stay retained.
        if (receipt.frame.body.requestKind !== "pull" || !("assignments" in receipt.frame.body.body) || receipt.frame.body.body.assignments.length !== 0) continue;
        removedRequests.add(operation.request.requestSequence);
        removedReplies.add(receipt.response.sequence);
        removedOperations.add(operation.operationId);
      }
      if (floor === state.head.retiredThroughRequestSequence && replyFloor === state.head.compactedThroughReplySequence && !removedRequests.size) return undefined;
      const next: LocalExecutionRecord[] = this.log.all().filter(record =>
        !(record.kind === "assignment_request" && removedRequests.has(record.value.frame.seq)) &&
        !(record.kind === "assignment_reply" && removedReplies.has(record.value.response.sequence)) &&
        !(record.kind === "assignment_operation" && removedOperations.has(record.value.operationId)),
      ).map(record => record.kind === "assignment_stream" ? { kind: "assignment_stream", value: {
        ...state.head, retiredThroughRequestSequence: floor, compactedThroughReplySequence: replyFloor,
      } } : record);
      validateAssignmentStreamRecords(next);
      return next;
    });
    assertOriginalAuthority();
  }

  request(scopeInput: Scope, sequence: number): AssignmentRequestRecord | undefined {
    counter.min(1).parse(sequence);
    // Retained request bytes remain available to an independently authorized
    // recovery exchange; this lookup does not grant resend or execution rights.
    const state = this.state(scopeInput, true);
    if (sequence <= state.head.retiredThroughRequestSequence) throw retired();
    const record = state.requests.get(sequence);
    return record && structuredClone(record);
  }

  /** The durably handled reply at a consumed response sequence, if any. */
  handled(scopeInput: Scope, sequence: number): AssignmentReplyRecordValue | undefined {
    counter.min(1).parse(sequence);
    const record = this.state(scopeInput).replies.get(sequence);
    if (record && !verified(record)) throw recovery();
    return record && structuredClone(record);
  }

  /**
   * Durably handle one correlated reply. The receipt, its request disposition
   * and the receive cursor commit together, so a crash either keeps the request
   * unresolved or leaves it handled — never a cursor ahead of its evidence.
   * Accepting the envelope is not domain proof: terminal evidence still needs
   * the owner's own ReportAck, and no local effect is started here.
   */
  async acceptReply(candidate: unknown, assertOriginalAuthority: () => void): Promise<AssignmentReplyRecordValue> {
    const input = AssignmentReplyRecordValueSchema.parse(candidate);
    let accepted: AssignmentReplyRecordValue | undefined;
    await this.log.batch(() => {
      assertOriginalAuthority();
      const state = this.state({ instanceId: input.instanceId, workspaceId: input.workspaceId }, true);
      if (input.request.requestSequence <= state.head.retiredThroughRequestSequence) throw retired();
      const request = state.requests.get(input.request.requestSequence);
      if (!request || request.digest !== input.request.requestDigest) throw recovery();
      assertReplyIdentity(request, input);
      const existing = state.repliesByRequest.get(input.request.requestSequence);
      // New receipts and authority-backed legacy upgrades must fit BEFORE
      // append. Exact verified replay changes no retained facts or byte usage.
      if (!existing || !verified(existing)) {
        const nextCount = state.receiptCount + (existing ? 0 : 1);
        const nextBytes = state.receiptBytes - (existing ? bytes(existing) : 0) + bytes(input);
        if (nextCount > this.receiptLimits.maxRecords || nextBytes > this.receiptLimits.maxBytes) {
          throw new RemoteInstanceError("assignment_transport_capacity", "Assignment reply retention is full; authenticated maintenance remains available.");
        }
      }
      if (existing) {
        // An exact retry publishes no new facts; changed content is a conflict.
        if (verified(existing)) {
          if (!same(existing, input)) throw recovery();
        } else if (!same(existing.request, input.request) || existing.response.sequence !== input.response.sequence ||
          existing.response.digest !== input.response.digest || !same(existing.body, input.frame.body)) {
          throw recovery();
        }
        // Exact authenticated replay upgrades old evidence with its original
        // verifiable frame; retain the historical cursor, never fabricate time.
        accepted = input;
        return [{ kind: "assignment_reply", value: input }];
      }
      if ([...state.replies.values()].some(value => !verified(value))) throw recovery();
      if (state.replies.has(input.response.sequence) || input.response.sequence !== state.head.nativeConsumedReplySequence + 1) throw recovery();
      assertReplyIdentity(request, input);
      accepted = input;
      return [{ kind: "assignment_stream", value: { ...state.head, nativeConsumedReplySequence: input.response.sequence } },
        { kind: "assignment_reply", value: input },
        ...(request.admission ? [this.execution.prepareClaimEffect(request.admission, { state: "pending", response: input.response })] : [])];
    });
    assertOriginalAuthority();
    if (!accepted) throw recovery();
    return structuredClone(accepted);
  }

  /**
   * Durably allocate a pull or report request. Unlike a claim, neither names an
   * admission, so nothing here reserves work: allocation freezes the exact
   * outbound frame and its sequence BEFORE any send, and an uncertain retry
   * retrieves the same frame rather than allocating another identity.
   *
   * A business retry is a different operation from a transport replay: it is
   * the caller's, and it must allocate a NEW sequence only after the prior
   * correlated result is durably handled.
   */
  async allocateOperation(candidate: unknown, assertOriginalAuthority: () => void): Promise<AssignmentRequestRecord> {
    return this.allocateOperationImpl(candidate, assertOriginalAuthority, false);
  }

  /** Fresh intent only: callers cannot reuse a deleted historical operation ID. */
  async allocatePull(candidate: unknown, assertOriginalAuthority: () => void): Promise<AssignmentRequestRecord> {
    const input = FreshPullInputSchema.parse(candidate);
    return this.allocateOperationImpl({ ...input, kind: "pull", operationId: randomUUID() }, assertOriginalAuthority, true);
  }

  private async allocateOperationImpl(candidate: unknown, assertOriginalAuthority: () => void, freshPull: boolean): Promise<AssignmentRequestRecord> {
    const input = OperationInputSchema.parse(candidate);
    let allocated: AssignmentRequestRecord | undefined;
    await this.log.batch(() => {
      assertOriginalAuthority();
      const state = this.state({ instanceId: input.instanceId, workspaceId: input.workspaceId });
      if (input.kind === "pull" && !freshPull && state.head.retiredThroughRequestSequence > 0) throw retired();
      if (input.origin.runnerIncarnation !== input.runnerIncarnation) throw recovery();
      if ([...state.requests.values()].some(request => requestKindOf(request.frame) === input.kind && !request.operationId)) throw recovery();
      const rows = [...state.operations.values()];
      let existing: AssignmentOperation | undefined;
      let retryAfter: z.infer<typeof RetryAfterSchema> | undefined;
      if (input.kind === "pull") {
        if (input.body.instanceId !== input.instanceId) throw recovery();
        existing = rows.find(row => row.kind === "pull" && row.effect.state !== "applied");
      } else {
        assertReportOwner(input.report, input.body);
        const owned = rows.filter(row => row.kind === "report" && row.report.reportId === input.report.reportId)
          .sort((a, b) => b.request.requestSequence - a.request.requestSequence);
        const latest = owned[0];
        if (input.retryAfter) {
          existing = owned.find(row => row.kind === "report" && same(row.retryAfter?.request, input.retryAfter));
          if (!existing) {
            if (!latest || latest.kind !== "report" || !same(latest.request, input.retryAfter) || !same(latest.report, input.report)) throw recovery();
            const receipt = state.repliesByRequest.get(latest.request.requestSequence);
            if (!receipt || !verified(receipt) || !isReportGap(receipt) || !same(state.requests.get(latest.request.requestSequence)?.frame.body, input.body)) throw recovery();
            retryAfter = { request: latest.request, response: receipt.response };
          }
        } else existing = latest;
      }
      if (existing) {
        if (existing.request.requestSequence <= state.head.retiredThroughRequestSequence) throw retired();
        const request = state.requests.get(existing.request.requestSequence);
        if (!request || !same(request.frame.origin, input.origin) ||
          (input.kind === "report" && (existing.kind !== "report" || !same(existing.report, input.report) || !same(request.frame.body, input.body)))) throw recovery();
        allocated = request;
        return [{ kind: "assignment_request", value: request }];
      }
      if (state.operations.has(input.operationId)) throw recovery();
      if (state.head.allocatedThrough >= Number.MAX_SAFE_INTEGER || state.head.allocatedThrough - state.head.retiredThroughRequestSequence >= this.limits.maxRequests) throw recovery();
      const frame = LogicalAssignmentRequestFrameSchema.parse({
        channel: "assignment", direction: "to_core", channelId: state.head.channelId,
        seq: state.head.allocatedThrough + 1, issuedAt: input.issuedAt, origin: input.origin, body: input.body,
      });
      if (requestKindOf(frame) === "claim") throw recovery();
      allocated = AssignmentRequestRecordSchema.parse({
        schemaVersion: 1, instanceId: state.head.instanceId, workspaceId: state.head.workspaceId,
        frame, digest: logicalAssignmentRequestDigest(frame), operationId: input.operationId,
      });
      if (state.retainedBytes + bytes(allocated) > this.limits.maxBytes) throw recovery();
      const operation = AssignmentOperationSchema.parse({ schemaVersion: 1, instanceId: input.instanceId, workspaceId: input.workspaceId,
        operationId: input.operationId, kind: input.kind, request: allocationReference(allocated), effect: { state: "pending" },
        ...(input.kind === "report" ? { report: input.report, ...(retryAfter ? { retryAfter } : {}) } : {}) });
      return [{ kind: "assignment_stream", value: { ...state.head, allocatedThrough: frame.seq } },
        { kind: "assignment_request", value: allocated }, { kind: "assignment_operation", value: operation }];
    });
    assertOriginalAuthority();
    if (!allocated) throw recovery();
    return structuredClone(allocated);
  }

  operation(scopeInput: Scope, candidate: AssignmentRequestReference): AssignmentOperation {
    const reference = AssignmentRequestReferenceSchema.parse(candidate);
    const state = this.state(scopeInput), request = state.requests.get(reference.requestSequence);
    const operation = request?.operationId ? state.operations.get(request.operationId) : undefined;
    if (!operation || !same(operation.request, reference)) throw recovery();
    return structuredClone(operation);
  }

  /** Bounded ordered work on retained intents, independent of domain outbox lifetime. */
  unresolvedOperations(scopeInput: Scope): AssignmentOperation[] {
    return structuredClone([...this.state(scopeInput).operations.values()]
      .filter(operation => operation.effect.state !== "applied")
      .sort((a, b) => a.request.requestSequence - b.request.requestSequence).slice(0, 32));
  }

  /** One ordered stream; claim ownership stays on its complete admission. */
  unresolvedRequests(scopeInput: Scope): AssignmentRequestRecord[] {
    const state = this.state(scopeInput);
    return structuredClone([...state.requests.values()].filter(request => {
      if (request.admission) {
        const start = this.execution.start(request.admission.assignmentId, request.admission.attempt);
        if (!start || !same(start.allocation, allocationReference(request))) throw recovery();
        return start.claimEffect?.state !== "applied";
      }
      const operation = request.operationId && state.operations.get(request.operationId);
      if (!operation) throw recovery();
      return operation.effect.state !== "applied";
    }).sort((a, b) => a.frame.seq - b.frame.seq).slice(0, 32));
  }

  replyForRequest(scopeInput: Scope, candidate: AssignmentRequestReference): AssignmentReplyRecordValue | undefined {
    const reference = AssignmentRequestReferenceSchema.parse(candidate), state = this.state(scopeInput);
    const request = state.requests.get(reference.requestSequence);
    if (!request || !same(allocationReference(request), reference)) throw recovery();
    const receipt = state.repliesByRequest.get(reference.requestSequence);
    if (receipt && !verified(receipt)) throw recovery();
    return receipt && structuredClone(receipt);
  }

  async beginClaimEffect(scopeInput: Scope, reference: AssignmentRequestReference, assertCurrent: () => void): Promise<boolean> {
    let apply = false;
    await this.log.batch(() => {
      assertCurrent();
      const request = this.request(scopeInput, reference.requestSequence), receipt = this.replyForRequest(scopeInput, reference);
      if (!request?.admission || !receipt) throw recovery();
      const start = this.execution.start(request.admission.assignmentId, request.admission.attempt);
      if (!start?.claimEffect || start.claimEffect.state === "applying" || !same(start.claimEffect.response, receipt.response)) throw recovery();
      apply = start.claimEffect.state === "pending";
      return [this.execution.prepareClaimEffect(request.admission, { state: apply ? "applying" : "applied", response: receipt.response })];
    });
    assertCurrent(); return apply;
  }

  async finishClaimEffect(scopeInput: Scope, reference: AssignmentRequestReference, assertCurrent: () => void): Promise<void> {
    await this.log.batch(() => {
      assertCurrent();
      const request = this.request(scopeInput, reference.requestSequence), receipt = this.replyForRequest(scopeInput, reference);
      if (!request?.admission || !receipt) throw recovery();
      const start = this.execution.start(request.admission.assignmentId, request.admission.attempt);
      if (start?.claimEffect?.state !== "applying") throw recovery();
      return [this.execution.prepareClaimEffect(request.admission, { state: "applied", response: receipt.response })];
    });
    assertCurrent();
  }

  operationReply(scopeInput: Scope, reference: AssignmentRequestReference): AssignmentReplyRecordValue | undefined {
    this.operation(scopeInput, reference);
    return this.replyForRequest(scopeInput, reference);
  }

  /** Claim the existing domain handler once; uncertain execution requires recovery. */
  async beginOperationEffect(scopeInput: Scope, reference: AssignmentRequestReference, assertCurrent: () => void): Promise<boolean> {
    let apply = false;
    await this.log.batch(() => {
      assertCurrent();
      const operation = this.operation(scopeInput, reference), receipt = this.operationReply(scopeInput, reference);
      if (!receipt || operation.effect.state === "applying") throw recovery();
      if (operation.effect.state === "applied") return [{ kind: "assignment_operation", value: operation }];
      apply = true;
      return [{ kind: "assignment_operation", value: { ...operation, effect: { state: "applying", response: receipt.response } } }];
    });
    assertCurrent(); return apply;
  }

  async finishOperationEffect(scopeInput: Scope, reference: AssignmentRequestReference, assertCurrent: () => void): Promise<void> {
    await this.log.batch(() => {
      assertCurrent();
      const operation = this.operation(scopeInput, reference), receipt = this.operationReply(scopeInput, reference);
      if (!receipt || operation.effect.state === "pending" || !same(operation.effect.response, receipt.response)) throw recovery();
      return [{ kind: "assignment_operation", value: { ...operation, effect: { state: "applied", response: receipt.response } } }];
    });
    assertCurrent();
  }

  /** Durable allocation only. The caller still owns current send/replay/claim authority. */
  async allocateClaim(candidate: unknown, assertOriginalAuthority: () => void): Promise<AssignmentRequestRecord> {
    const input = AllocationInputSchema.parse(candidate);
    let allocated: AssignmentRequestRecord | undefined;
    await this.log.batch(() => {
      assertOriginalAuthority();
      this.execution.assertAdmission(input.admission);
      const state = this.state({ instanceId: input.admission.instanceId, workspaceId: input.admission.workspaceId });
      const start = this.execution.start(input.admission.assignmentId, input.admission.attempt);
      if (!start) throw recovery();
      if (start.delivery === "allocated" && start.allocation) {
        if (start.allocation.requestSequence <= state.head.retiredThroughRequestSequence) throw retired();
        const existing = state.requests.get(start.allocation.requestSequence);
        if (!existing || !same(existing.admission, input.admission) || !same(existing.frame.origin, input.origin) || existing.frame.issuedAt !== input.issuedAt) throw recovery();
        allocated = existing;
        // A retry publishes no new facts, but traverses the same ownership gate.
        return [{ kind: "assignment_request", value: existing }];
      }
      if (start.delivery !== "unallocated" || this.execution.execution(input.admission) || input.origin.runnerIncarnation !== input.admission.runnerIncarnation ||
        state.head.allocatedThrough >= Number.MAX_SAFE_INTEGER || state.head.allocatedThrough - state.head.retiredThroughRequestSequence >= this.limits.maxRequests) throw recovery();
      const { assignmentId, attempt, claimId, agentId } = input.admission;
      const frame = ClaimFrameSchema.parse({ channel: "assignment", direction: "to_core", channelId: state.head.channelId,
        seq: state.head.allocatedThrough + 1, issuedAt: input.issuedAt, origin: input.origin, body: { assignmentId, attempt, claimId, agentId } });
      allocated = AssignmentRequestRecordSchema.parse({ schemaVersion: 1, instanceId: state.head.instanceId, workspaceId: state.head.workspaceId,
        frame, digest: logicalAssignmentRequestDigest(frame), admission: input.admission, admissionDigest: jcsDigest(input.admission) });
      if (state.retainedBytes + bytes(allocated) > this.limits.maxBytes) throw recovery();
      const updatedStart = this.execution.prepareAllocatedStart(input.admission, allocationReference(allocated));
      return [{ kind: "assignment_stream", value: { ...state.head, allocatedThrough: frame.seq } },
        { kind: "assignment_request", value: allocated }, updatedStart];
    });
    assertOriginalAuthority();
    if (!allocated) throw recovery();
    return structuredClone(allocated);
  }
}

/**
 * The owner body's own identifiers, not merely the transport correlation. A
 * concurrent request must not consume another's result, and an `already_claimed`
 * naming a different canonical claim stays a non-dispatching conflict rather
 * than authority to adopt that claim.
 */
function assertReplyIdentity(request: AssignmentRequestRecord, value: StoredAssignmentReplyRecordValue): void {
  const kind = requestKindOf(request.frame);
  const correlated = replyBody(value);
  if (value.request.requestKind !== kind || correlated.requestKind !== kind) throw recovery();
  const body = correlated.body;
  // A refusal or obsolescence is correlated by the transport reference alone.
  if ("kind" in body) return;
  if (kind === "claim") {
    const sent = request.frame.body as { assignmentId: string; attempt: number; claimId: string };
    const verdict = body as { assignmentId: string; attempt: number; claimId: string; outcome: string };
    if (verdict.assignmentId !== sent.assignmentId || verdict.attempt !== sent.attempt) throw recovery();
    if (verdict.outcome !== "already_claimed" && verdict.claimId !== sent.claimId) throw recovery();
    return;
  }
  if (kind === "report") {
    const sent = request.frame.body as { assignmentId: string; attempt: number; claimId: string; reportId: string; reportSequence: number };
    const ack = body as { assignmentId: string; attempt: number; claimId: string; acknowledged: { reportId: string; reportSequence: number } };
    if (ack.assignmentId !== sent.assignmentId || ack.attempt !== sent.attempt || ack.claimId !== sent.claimId) throw recovery();
    if (ack.acknowledged.reportId !== sent.reportId || ack.acknowledged.reportSequence !== sent.reportSequence) throw recovery();
  }
  // A pull result carries no operation identity beyond its correlation, so a
  // concurrent pull cannot consume another's result by sequence alone.
}
