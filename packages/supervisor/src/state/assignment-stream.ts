import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  AssignmentClaimSchema, AssignmentPullSchema, AssignmentReportSchema,
  AssignmentRequestKindSchema, AssignmentRequestOriginSchema, AssignmentRequestReferenceSchema,
  AssignmentResponseReferenceSchema, AssignmentTransportReplySchema, LogicalAssignmentRequestFrameSchema, LogicalAssignmentReplyFrameSchema,
  PendingClaimRequestSchema, RemoteInstanceError, allEqual, canonicalize, jcsDigest, logicalAssignmentRequestDigest,
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
const AssignmentStreamStateSchema = z.object({
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
type AssignmentStreamState = z.infer<typeof AssignmentStreamStateSchema>;
/**
 * One retained outbound request. A claim additionally binds the exact immutable
 * admission it was chosen for; a pull or report has no admission of its own, so
 * requiring one would force the sender to invent identity it does not have.
 */
const AssignmentRequestRecordFieldsSchema = z.object({
  schemaVersion: z.literal(1), ...scope, frame: LogicalAssignmentRequestFrameSchema, digest,
  admission: LocalAdmissionSchema.optional(), admissionDigest: digest.optional(),
  /** Absent only on historical unowned operation allocations. */
  operationId: id.optional(),
}).strict();
type AssignmentRequestRecordFields = z.infer<typeof AssignmentRequestRecordFieldsSchema>;

/** Why a stored allocation does not bind its frame (and, for a claim, its admission); empty when it does. */
function requestRecordProblems(value: AssignmentRequestRecordFields): string[] {
  const { admission, frame } = value;
  if (value.digest !== logicalAssignmentRequestDigest(frame) || frame.channelId !== `assignment:${value.instanceId}`) {
    return ["Stored allocation must bind its exact immutable frame"];
  }
  const kind = requestKindOf(frame);
  const problems = kind === "claim" && value.operationId !== undefined ? ["Claim ownership belongs to its admission, not an operation"] : [];
  if ((kind === "claim") !== (admission !== undefined)) return [...problems, "Exactly a claim allocation carries its admission"];
  if (admission && !claimBindsAdmission(value, admission)) problems.push("Stored claim allocation must bind its exact immutable admission and frame");
  return problems;
}

function claimBindsAdmission(value: AssignmentRequestRecordFields, admission: NonNullable<AssignmentRequestRecordFields["admission"]>): boolean {
  const body = value.frame.body as z.infer<typeof AssignmentClaimSchema>;
  return allEqual([
    [value.admissionDigest, jcsDigest(admission)], [admission.instanceId, value.instanceId], [admission.workspaceId, value.workspaceId],
    [value.frame.origin.runnerIncarnation, admission.runnerIncarnation], [body.assignmentId, admission.assignmentId],
    [body.attempt, admission.attempt], [body.claimId, admission.claimId], [body.agentId, admission.agentId],
  ]);
}

export const AssignmentRequestRecordSchema = AssignmentRequestRecordFieldsSchema.superRefine((value, context) => {
  for (const message of requestRecordProblems(value)) context.addIssue({ code: "custom", message });
});
export type AssignmentRequestRecord = z.infer<typeof AssignmentRequestRecordSchema>;

/** The operation a retained frame carries; the body's own shape decides it. */
function requestKindOf(frame: z.infer<typeof LogicalAssignmentRequestFrameSchema>): "pull" | "claim" | "report" {
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
const AssignmentOperationSchema = z.discriminatedUnion("kind", [
  z.object({ ...operationBase, kind: z.literal("pull") }).strict(),
  z.object({ ...operationBase, kind: z.literal("report"), report: ReportOperationOwnerSchema, retryAfter: RetryAfterSchema.optional() }).strict(),
]);
type AssignmentOperation = z.infer<typeof AssignmentOperationSchema>;
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
const LOCAL_ASSIGNMENT_ALLOCATION_LIMITS = { maxRequests: 2048, maxBytes: 16 * 1024 * 1024 } as const;
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

type StreamIndex = {
  head?: AssignmentStreamState;
  requests: Map<number, AssignmentRequestRecord>;
  replies: Map<number, StoredAssignmentReplyRecordValue>;
  repliesByRequest: Map<number, StoredAssignmentReplyRecordValue>;
  operations: Map<string, AssignmentOperation>;
  retainedBytes: number;
  receiptBytes: number;
  receiptCount: number;
};
type StreamState = StreamIndex & { head: AssignmentStreamState };
type ExecutionRow<K extends LocalExecutionRecord["kind"]> = Extract<LocalExecutionRecord, { kind: K }>;
type StartRow = ExecutionRow<"admission_start">;
type ReportOperation = Extract<AssignmentOperation, { kind: "report" }>;

function emptyStreamIndex(): StreamIndex {
  return { requests: new Map(), replies: new Map(), repliesByRequest: new Map(), operations: new Map(), retainedBytes: 0, receiptBytes: 0, receiptCount: 0 };
}

function inStreamScope(value: Scope, head: AssignmentStreamState): boolean {
  return value.instanceId === head.instanceId && value.workspaceId === head.workspaceId;
}

/** Every sequence in `from..through` is present. */
function assertContiguous(from: number, through: number, present: (sequence: number) => boolean): void {
  for (let sequence = from; sequence <= through; sequence++) if (!present(sequence)) throw recovery();
}

/** Validate all retained relations before a stream or execution guard can authorize.
 * Only the durable floors permit absent transport records. Required domain
 * evidence below those floors remains fully validated and is never evicted.
 */
export function validateAssignmentStreamRecords(records: readonly LocalExecutionRecord[]): StreamIndex {
  return new StreamValidation(records).validate();
}

/** One pass over the execution log's stream rows, in the order the checks must fail. */
class StreamValidation {
  private readonly enrollment: LocalExecutionRecord | undefined;
  private readonly heads: LocalExecutionRecord[];
  private readonly allocations: LocalExecutionRecord[];
  private readonly handled: LocalExecutionRecord[];
  private readonly starts: StartRow[];
  private readonly operationRows: Array<ExecutionRow<"assignment_operation">>;

  constructor(records: readonly LocalExecutionRecord[]) {
    this.enrollment = records.find(record => record.kind === "enrollment_bound");
    this.heads = records.filter(record => record.kind === "assignment_stream");
    this.allocations = records.filter(record => record.kind === "assignment_request");
    this.handled = records.filter(record => record.kind === "assignment_reply");
    this.starts = records.filter((record): record is StartRow => record.kind === "admission_start");
    this.operationRows = records.filter((record): record is ExecutionRow<"assignment_operation"> => record.kind === "assignment_operation");
  }

  validate(): StreamIndex {
    const enrollment = this.enrollment?.kind === "enrollment_bound" && this.enrollment.value.assignmentStreamVersion === 1 ? this.enrollment.value : null;
    if (enrollment === null) {
      this.assertNoStreamHistory();
      return emptyStreamIndex();
    }
    const head = this.boundHead(enrollment);
    const { requests, retainedBytes } = this.retainedRequests(head);
    this.assertAllocatedStarts(requests);
    const { replies, repliesByRequest } = this.consumedReplies(head, requests);
    const { receiptBytes, receiptCount } = receiptUsage(head, replies);
    this.assertClaimEffects(repliesByRequest);
    const operations = this.retainedOperations(head, requests, repliesByRequest);
    return { head, requests, replies, repliesByRequest, operations, retainedBytes, receiptBytes, receiptCount };
  }

  private assertNoStreamHistory(): void {
    if (this.heads.length || this.allocations.length || this.handled.length || this.operationRows.length ||
      this.starts.some(record => record.value.delivery === "allocated")) throw recovery();
  }

  private boundHead(enrollment: ExecutionRow<"enrollment_bound">["value"]): AssignmentStreamState {
    if (this.heads.length !== 1) throw recovery();
    const head = AssignmentStreamStateSchema.parse(this.heads[0]!.value);
    if (!allEqual([[head.instanceId, enrollment.instanceId], [head.workspaceId, enrollment.workspaceId], [head.enrollmentId, enrollment.enrollmentId]]) ||
      head.allocatedThrough - head.retiredThroughRequestSequence > LOCAL_ASSIGNMENT_ALLOCATION_LIMITS.maxRequests) throw recovery();
    return head;
  }

  private retainedRequests(head: AssignmentStreamState): { requests: Map<number, AssignmentRequestRecord>; retainedBytes: number } {
    const requests = new Map<number, AssignmentRequestRecord>();
    const admissions = new Set<string>();
    let retainedBytes = 0;
    for (const record of this.allocations) {
      const request = AssignmentRequestRecordSchema.parse(record.value);
      if (!inStreamScope(request, head) || request.frame.seq > head.allocatedThrough || requests.has(request.frame.seq)) throw recovery();
      // Only a claim occupies an admission identity; a pull or report names none,
      // so at most one acceptance-unresolved claim exists per admission.
      if (request.admission) this.assertClaimAdmission(request, request.admission, admissions);
      requests.set(request.frame.seq, request);
      if (request.frame.seq > head.retiredThroughRequestSequence) retainedBytes += bytes(request);
    }
    if (retainedBytes > LOCAL_ASSIGNMENT_ALLOCATION_LIMITS.maxBytes) throw recovery();
    assertContiguous(head.retiredThroughRequestSequence + 1, head.allocatedThrough, sequence => requests.has(sequence));
    return { requests, retainedBytes };
  }

  private assertClaimAdmission(request: AssignmentRequestRecord, admission: NonNullable<AssignmentRequestRecord["admission"]>, admissions: Set<string>): void {
    const identity = JSON.stringify([admission.assignmentId, admission.attempt]);
    if (admissions.has(identity)) throw recovery();
    const start = this.starts.find(row => same(row.value.admission, admission));
    if (!start || start.value.delivery !== "allocated" || !same(start.value.allocation, allocationReference(request))) throw recovery();
    admissions.add(identity);
  }

  private assertAllocatedStarts(requests: Map<number, AssignmentRequestRecord>): void {
    for (const start of this.starts) {
      if (start.value.delivery !== "allocated") continue;
      const request = start.value.allocation && requests.get(start.value.allocation.requestSequence);
      if (!request || !same(request.admission, start.value.admission) || !same(allocationReference(request), start.value.allocation)) throw recovery();
    }
  }

  /** Consumed replies are contiguous from 1 and each names a retained request. */
  private consumedReplies(head: AssignmentStreamState, requests: Map<number, AssignmentRequestRecord>): { replies: Map<number, StoredAssignmentReplyRecordValue>; repliesByRequest: Map<number, StoredAssignmentReplyRecordValue> } {
    const replies = new Map<number, StoredAssignmentReplyRecordValue>();
    const repliesByRequest = new Map<number, StoredAssignmentReplyRecordValue>();
    for (const record of this.handled) {
      const value = StoredAssignmentReplyRecordValueSchema.parse(record.value);
      const request = requests.get(value.request.requestSequence);
      if (!request || foreignReply(value, request, head) || replies.has(value.response.sequence) || repliesByRequest.has(value.request.requestSequence)) throw recovery();
      assertReplyIdentity(request, value);
      replies.set(value.response.sequence, value);
      repliesByRequest.set(value.request.requestSequence, value);
    }
    if (head.nativeConsumedReplySequence - head.compactedThroughReplySequence > TRANSPORT_RECEIPT_LIMITS.maxRecords) throw recovery();
    return { replies, repliesByRequest };
  }

  private assertClaimEffects(repliesByRequest: Map<number, StoredAssignmentReplyRecordValue>): void {
    for (const start of this.starts) {
      if (!start.value.claimEffect) continue;
      const receipt = start.value.allocation && repliesByRequest.get(start.value.allocation.requestSequence);
      if (!receipt || !verified(receipt) || receipt.request.requestKind !== "claim" || !same(receipt.response, start.value.claimEffect.response)) throw recovery();
    }
  }

  private retainedOperations(head: AssignmentStreamState, requests: Map<number, AssignmentRequestRecord>, repliesByRequest: Map<number, StoredAssignmentReplyRecordValue>): Map<string, AssignmentOperation> {
    const operations = new Map<string, AssignmentOperation>();
    const reportHeads = new Map<string, ReportOperation>();
    let pendingPulls = 0;
    for (const row of this.operationRows.sort((a, b) => a.value.request.requestSequence - b.value.request.requestSequence)) {
      const operation = AssignmentOperationSchema.parse(row.value);
      const request = operationRequest(operation, requests, head, operations);
      assertOperationEffect(operation.effect, repliesByRequest.get(request.frame.seq));
      if (operation.kind === "pull") pendingPulls += operation.effect.state === "applied" ? 0 : 1;
      else assertReportChain(operation, request, reportHeads, { requests, repliesByRequest });
      operations.set(operation.operationId, operation);
    }
    assertOperationOwners(operations, requests, pendingPulls);
    return operations;
  }
}

/** A stored reply outside the stream's scope, for another request's bytes, or beyond the consumed cursor. */
function foreignReply(value: StoredAssignmentReplyRecordValue, request: AssignmentRequestRecord, head: AssignmentStreamState): boolean {
  return !inStreamScope(value, head) || request.digest !== value.request.requestDigest || value.response.sequence > head.nativeConsumedReplySequence;
}

/** Retained receipts of unretired requests, by bytes and count, within their limits and contiguous past the compaction floor. */
function receiptUsage(head: AssignmentStreamState, replies: Map<number, StoredAssignmentReplyRecordValue>): { receiptBytes: number; receiptCount: number } {
  let receiptBytes = 0;
  let receiptCount = 0;
  for (const value of replies.values()) {
    const retainedRequest = value.request.requestSequence > head.retiredThroughRequestSequence;
    if (value.response.sequence <= head.compactedThroughReplySequence && retainedRequest) throw recovery();
    if (retainedRequest) { receiptBytes += bytes(value); receiptCount++; }
  }
  if (receiptBytes > TRANSPORT_RECEIPT_LIMITS.maxBytes) throw recovery();
  assertContiguous(head.compactedThroughReplySequence + 1, head.nativeConsumedReplySequence, sequence => replies.has(sequence));
  return { receiptBytes, receiptCount };
}

/** The retained request an operation owns, with its exact reference and kind. */
function operationRequest(operation: AssignmentOperation, requests: Map<number, AssignmentRequestRecord>, head: AssignmentStreamState, operations: Map<string, AssignmentOperation>): AssignmentRequestRecord {
  const request = requests.get(operation.request.requestSequence);
  if (operations.has(operation.operationId) || !inStreamScope(operation, head) || !request || request.operationId !== operation.operationId ||
    !same(operation.request, allocationReference(request)) || operation.kind !== requestKindOf(request.frame)) throw recovery();
  return request;
}

/** An effect past pending names the verified reply it applies. */
function assertOperationEffect(effect: AssignmentOperation["effect"], receipt: StoredAssignmentReplyRecordValue | undefined): void {
  if (effect.state !== "pending" && (!receipt || !verified(receipt) || !same(effect.response, receipt.response))) throw recovery();
}

/** A report's operations form one chain: each retry follows the previous attempt's sequence-gap reply with the same body. */
function assertReportChain(operation: ReportOperation, request: AssignmentRequestRecord, reportHeads: Map<string, ReportOperation>, retained: Pick<StreamIndex, "requests" | "repliesByRequest">): void {
  assertReportOwner(operation.report, request.frame.body as z.infer<typeof AssignmentReportSchema>);
  const previous = reportHeads.get(operation.report.reportId);
  if (operation.retryAfter) assertRetryOf(operation, operation.retryAfter, previous, request, retained);
  else if (previous) throw recovery();
  reportHeads.set(operation.report.reportId, operation);
}

function assertRetryOf(operation: ReportOperation, retryAfter: NonNullable<ReportOperation["retryAfter"]>, previous: ReportOperation | undefined, request: AssignmentRequestRecord, retained: Pick<StreamIndex, "requests" | "repliesByRequest">): void {
  if (!previous || !same(previous.report, operation.report) || !same(previous.request, retryAfter.request) ||
    previous.request.requestSequence >= operation.request.requestSequence) throw recovery();
  assertGapReply(previous.request.requestSequence, retryAfter, request, retained);
}

/** The retried attempt's verified reply was a sequence gap, and the retry sends the same report body. */
function assertGapReply(previousSequence: number, retryAfter: NonNullable<ReportOperation["retryAfter"]>, request: AssignmentRequestRecord, retained: Pick<StreamIndex, "requests" | "repliesByRequest">): void {
  const previousReply = retained.repliesByRequest.get(previousSequence);
  if (!previousReply || !verified(previousReply) || !same(previousReply.response, retryAfter.response)) throw recovery();
  if (!isReportGap(previousReply) || !same(retained.requests.get(previousSequence)?.frame.body, request.frame.body)) throw recovery();
}

/** At most one pull in flight, and every operation-owned request is that operation's own. */
function assertOperationOwners(operations: Map<string, AssignmentOperation>, requests: Map<number, AssignmentRequestRecord>, pendingPulls: number): void {
  if (pendingPulls > 1 || operations.size > requests.size) throw recovery();
  for (const request of requests.values()) {
    if (request.operationId && operations.get(request.operationId)?.request.requestSequence !== request.frame.seq) throw recovery();
  }
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
  private indexed: StreamIndex = emptyStreamIndex();
  private readonly limits: z.infer<typeof AllocationLimitsSchema>;
  private readonly receiptLimits: z.infer<typeof ReceiptLimitsSchema>;
  constructor(private readonly log: ExecutionLog, private readonly execution: LocalExecutionJournal,
    limits = { ...LOCAL_ASSIGNMENT_ALLOCATION_LIMITS } as { maxRequests: number; maxBytes: number },
    receiptLimits = { ...TRANSPORT_RECEIPT_LIMITS } as { maxRecords: number; maxBytes: number }) {
    this.limits = AllocationLimitsSchema.parse(limits);
    this.receiptLimits = ReceiptLimitsSchema.parse(receiptLimits);
  }

  private index(scopeInput: Scope): StreamIndex {
    const wanted = ScopeSchema.parse(scopeInput);
    if (this.revision !== this.log.revision) {
      // This also checks existing admission/execution/reference invariants.
      this.execution.coverage(wanted.instanceId, wanted.workspaceId);
      this.indexed = validateAssignmentStreamRecords(this.log.all()); this.revision = this.log.revision;
    }
    if (this.indexed.head && (this.indexed.head.instanceId !== wanted.instanceId || this.indexed.head.workspaceId !== wanted.workspaceId)) throw recovery();
    return this.indexed;
  }

  private state(scopeInput: Scope, allowLegacyForReplay = false): StreamState {
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
      const floor = this.retirementFloor(state);
      const replyFloor = compactionFloor(state, floor);
      const removed = emptyPolls(state, floor, replyFloor);
      if (floor === state.head.retiredThroughRequestSequence && replyFloor === state.head.compactedThroughReplySequence && !removed.requests.size) return undefined;
      const next = this.retiredLog(state, { floor, replyFloor, removed });
      validateAssignmentStreamRecords(next);
      return next;
    });
    assertOriginalAuthority();
  }

  /** The highest request sequence below the explicit ACK whose reply and domain effect are both settled. */
  private retirementFloor(state: StreamState): number {
    let floor = state.head.retiredThroughRequestSequence;
    while (floor < state.head.observedCoreRequestAckSequence && this.retirable(state, floor + 1)) floor++;
    return floor;
  }

  private retirable(state: StreamState, sequence: number): boolean {
    const request = state.requests.get(sequence);
    const receipt = state.repliesByRequest.get(sequence);
    if (!request || !receipt || !verified(receipt) || receipt.response.sequence > state.head.nativeConsumedReplySequence) return false;
    const effect = this.effectOf(state, request);
    // This first slice deliberately blocks on uncertain domain work rather
    // than invent an independent effect archive or imply it was applied.
    return effect?.state === "applied" && same(effect.response, receipt.response);
  }

  /** The domain effect a request's reply drives: its claim's handoff, or its operation's effect. */
  private effectOf(state: StreamState, request: AssignmentRequestRecord): { state: string; response?: unknown } | undefined {
    if (request.admission) return this.execution.start(request.admission.assignmentId, request.admission.attempt)?.claimEffect;
    return request.operationId ? state.operations.get(request.operationId)?.effect : undefined;
  }

  /** The log without the reclaimed pulls, with the head's floors advanced. */
  private retiredLog(state: StreamState, retirement: { floor: number; replyFloor: number; removed: ReclaimedPolls }): LocalExecutionRecord[] {
    const { removed } = retirement;
    return this.log.all().filter(record =>
      !(record.kind === "assignment_request" && removed.requests.has(record.value.frame.seq)) &&
      !(record.kind === "assignment_reply" && removed.replies.has(record.value.response.sequence)) &&
      !(record.kind === "assignment_operation" && removed.operations.has(record.value.operationId)),
    ).map(record => record.kind === "assignment_stream" ? { kind: "assignment_stream", value: {
      ...state.head, retiredThroughRequestSequence: retirement.floor, compactedThroughReplySequence: retirement.replyFloor,
    } } : record);
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
      if (!existing || !verified(existing)) this.assertReceiptRoom(state, existing, input);
      const records = existing ? replayedReply(existing, input) : this.appendedReply(state, request, input);
      accepted = input;
      return records;
    });
    assertOriginalAuthority();
    if (!accepted) throw recovery();
    return structuredClone(accepted);
  }

  private assertReceiptRoom(state: StreamState, existing: StoredAssignmentReplyRecordValue | undefined, input: AssignmentReplyRecordValue): void {
    const nextCount = state.receiptCount + (existing ? 0 : 1);
    const nextBytes = state.receiptBytes - (existing ? bytes(existing) : 0) + bytes(input);
    if (nextCount > this.receiptLimits.maxRecords || nextBytes > this.receiptLimits.maxBytes) {
      throw new RemoteInstanceError("assignment_transport_capacity", "Assignment reply retention is full; authenticated maintenance remains available.");
    }
  }

  /** A new reply: the next consumed sequence, committed with its cursor (and a claim's pending effect). */
  private appendedReply(state: StreamState, request: AssignmentRequestRecord, input: AssignmentReplyRecordValue): LocalExecutionRecord[] {
    if ([...state.replies.values()].some(value => !verified(value))) throw recovery();
    if (state.replies.has(input.response.sequence) || input.response.sequence !== state.head.nativeConsumedReplySequence + 1) throw recovery();
    assertReplyIdentity(request, input);
    return [{ kind: "assignment_stream", value: { ...state.head, nativeConsumedReplySequence: input.response.sequence } },
      { kind: "assignment_reply", value: input },
      ...(request.admission ? [this.execution.prepareClaimEffect(request.admission, { state: "pending", response: input.response })] : [])];
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
      assertOperationInput(state, input, freshPull);
      const { existing, retryAfter } = priorOperation(state, input);
      if (existing) {
        allocated = reallocated(state, input, existing);
        return [{ kind: "assignment_request", value: allocated }];
      }
      const fresh = this.newOperation(state, input, retryAfter);
      allocated = fresh.allocated;
      return fresh.records;
    });
    assertOriginalAuthority();
    if (!allocated) throw recovery();
    return structuredClone(allocated);
  }

  private newOperation(state: StreamState, input: OperationInput, retryAfter: z.infer<typeof RetryAfterSchema> | undefined): { allocated: AssignmentRequestRecord; records: LocalExecutionRecord[] } {
    if (state.operations.has(input.operationId)) throw recovery();
    assertAllocationRoom(state, this.limits);
    const frame = LogicalAssignmentRequestFrameSchema.parse({
      channel: "assignment", direction: "to_core", channelId: state.head.channelId,
      seq: state.head.allocatedThrough + 1, issuedAt: input.issuedAt, origin: input.origin, body: input.body,
    });
    if (requestKindOf(frame) === "claim") throw recovery();
    const allocated = AssignmentRequestRecordSchema.parse({
      schemaVersion: 1, instanceId: state.head.instanceId, workspaceId: state.head.workspaceId,
      frame, digest: logicalAssignmentRequestDigest(frame), operationId: input.operationId,
    });
    if (state.retainedBytes + bytes(allocated) > this.limits.maxBytes) throw recovery();
    const operation = AssignmentOperationSchema.parse({ schemaVersion: 1, instanceId: input.instanceId, workspaceId: input.workspaceId,
      operationId: input.operationId, kind: input.kind, request: allocationReference(allocated), effect: { state: "pending" },
      ...(input.kind === "report" ? { report: input.report, ...(retryAfter ? { retryAfter } : {}) } : {}) });
    return { allocated, records: [{ kind: "assignment_stream", value: { ...state.head, allocatedThrough: frame.seq } },
      { kind: "assignment_request", value: allocated }, { kind: "assignment_operation", value: operation }] };
  }

  operation(scopeInput: Scope, candidate: AssignmentRequestReference): AssignmentOperation {
    const reference = AssignmentRequestReferenceSchema.parse(candidate);
    const state = this.state(scopeInput), request = state.requests.get(reference.requestSequence);
    const operation = request?.operationId ? state.operations.get(request.operationId) : undefined;
    if (!operation || !same(operation.request, reference)) throw recovery();
    return structuredClone(operation);
  }

  /** One ordered stream; claim ownership stays on its complete admission. */
  unresolvedRequests(scopeInput: Scope): AssignmentRequestRecord[] {
    const state = this.state(scopeInput);
    return structuredClone([...state.requests.values()].filter(request => this.unresolved(state, request))
      .sort((a, b) => a.frame.seq - b.frame.seq).slice(0, 32));
  }

  private unresolved(state: StreamState, request: AssignmentRequestRecord): boolean {
    if (request.admission) return this.claimUnresolved(request, request.admission);
    const operation = request.operationId && state.operations.get(request.operationId);
    if (!operation) throw recovery();
    return operation.effect.state !== "applied";
  }

  private claimUnresolved(request: AssignmentRequestRecord, admission: NonNullable<AssignmentRequestRecord["admission"]>): boolean {
    const start = this.execution.start(admission.assignmentId, admission.attempt);
    if (!start || !same(start.allocation, allocationReference(request))) throw recovery();
    return start.claimEffect?.state !== "applied";
  }

  replyForRequest(scopeInput: Scope, candidate: AssignmentRequestReference): AssignmentReplyRecordValue | undefined {
    const reference = AssignmentRequestReferenceSchema.parse(candidate), state = this.state(scopeInput);
    const request = state.requests.get(reference.requestSequence);
    if (!request || !same(allocationReference(request), reference)) throw recovery();
    const receipt = state.repliesByRequest.get(reference.requestSequence);
    if (receipt && !verified(receipt)) throw recovery();
    return receipt && structuredClone(receipt);
  }

  /** A claim request with its durable reply, and its admission's current effect. */
  private claimWithReply(scopeInput: Scope, reference: AssignmentRequestReference) {
    const request = this.request(scopeInput, reference.requestSequence), receipt = this.replyForRequest(scopeInput, reference);
    if (!request?.admission || !receipt) throw recovery();
    const effect = this.execution.start(request.admission.assignmentId, request.admission.attempt)?.claimEffect;
    return { admission: request.admission, receipt, effect };
  }

  async beginClaimEffect(scopeInput: Scope, reference: AssignmentRequestReference, assertCurrent: () => void): Promise<boolean> {
    let apply = false;
    await this.log.batch(() => {
      assertCurrent();
      const { admission, receipt, effect } = this.claimWithReply(scopeInput, reference);
      if (!effect || effect.state === "applying" || !same(effect.response, receipt.response)) throw recovery();
      apply = effect.state === "pending";
      return [this.execution.prepareClaimEffect(admission, { state: apply ? "applying" : "applied", response: receipt.response })];
    });
    assertCurrent(); return apply;
  }

  async finishClaimEffect(scopeInput: Scope, reference: AssignmentRequestReference, assertCurrent: () => void): Promise<void> {
    await this.log.batch(() => {
      assertCurrent();
      const { admission, receipt, effect } = this.claimWithReply(scopeInput, reference);
      if (effect?.state !== "applying") throw recovery();
      return [this.execution.prepareClaimEffect(admission, { state: "applied", response: receipt.response })];
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

  /** An unallocated start with no execution yet, framed by the admission's own runner. */
  private assertClaimAllocatable(start: { delivery: string }, input: z.infer<typeof AllocationInputSchema>): void {
    if (start.delivery !== "unallocated" || this.execution.execution(input.admission) || input.origin.runnerIncarnation !== input.admission.runnerIncarnation) throw recovery();
  }

  private newClaim(state: StreamState, input: z.infer<typeof AllocationInputSchema>): { allocated: AssignmentRequestRecord; records: LocalExecutionRecord[] } {
    const { assignmentId, attempt, claimId, agentId } = input.admission;
    const frame = ClaimFrameSchema.parse({ channel: "assignment", direction: "to_core", channelId: state.head.channelId,
      seq: state.head.allocatedThrough + 1, issuedAt: input.issuedAt, origin: input.origin, body: { assignmentId, attempt, claimId, agentId } });
    const allocated = AssignmentRequestRecordSchema.parse({ schemaVersion: 1, instanceId: state.head.instanceId, workspaceId: state.head.workspaceId,
      frame, digest: logicalAssignmentRequestDigest(frame), admission: input.admission, admissionDigest: jcsDigest(input.admission) });
    if (state.retainedBytes + bytes(allocated) > this.limits.maxBytes) throw recovery();
    const updatedStart = this.execution.prepareAllocatedStart(input.admission, allocationReference(allocated));
    return { allocated, records: [{ kind: "assignment_stream", value: { ...state.head, allocatedThrough: frame.seq } },
      { kind: "assignment_request", value: allocated }, updatedStart] };
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
        allocated = existingClaim(state, start.allocation, input);
        // A retry publishes no new facts, but traverses the same ownership gate.
        return [{ kind: "assignment_request", value: allocated }];
      }
      this.assertClaimAllocatable(start, input);
      assertAllocationRoom(state, this.limits);
      const fresh = this.newClaim(state, input);
      allocated = fresh.allocated;
      return fresh.records;
    });
    assertOriginalAuthority();
    if (!allocated) throw recovery();
    return structuredClone(allocated);
  }
}

type OperationInput = z.infer<typeof OperationInputSchema>;
type ReportInput = Extract<OperationInput, { kind: "report" }>;
type ReclaimedPolls = { requests: Set<number>; replies: Set<number>; operations: Set<string> };

/** The highest consumed reply whose request is retired: everything up to it may be compacted. */
function compactionFloor(state: StreamState, floor: number): number {
  let replyFloor = state.head.compactedThroughReplySequence;
  while (replyFloor < state.head.nativeConsumedReplySequence) {
    const receipt = state.replies.get(replyFloor + 1);
    if (!receipt || !verified(receipt) || receipt.request.requestSequence > floor) break;
    replyFloor++;
  }
  return replyFloor;
}

/** Completed empty polls at or below both floors: the only triples retirement deletes. */
function emptyPolls(state: StreamState, floor: number, replyFloor: number): ReclaimedPolls {
  const removed: ReclaimedPolls = { requests: new Set(), replies: new Set(), operations: new Set() };
  for (const operation of state.operations.values()) {
    const receipt = reclaimablePoll(state, operation, floor, replyFloor);
    if (!receipt) continue;
    removed.requests.add(operation.request.requestSequence);
    removed.replies.add(receipt.response.sequence);
    removed.operations.add(operation.operationId);
  }
  return removed;
}

function reclaimablePoll(state: StreamState, operation: AssignmentOperation, floor: number, replyFloor: number): AssignmentReplyRecordValue | null {
  if (operation.kind !== "pull" || operation.effect.state !== "applied" || operation.request.requestSequence > floor) return null;
  const receipt = state.repliesByRequest.get(operation.request.requestSequence);
  if (!receipt || !verified(receipt) || receipt.response.sequence > replyFloor) return null;
  // A work-bearing pull's durable handoff is not, by itself, a proof
  // that its offered assignment identities survive independent of it.
  // This slice reclaims empty polls only; required offers stay retained.
  return emptyPoll(receipt) ? receipt : null;
}

function emptyPoll(receipt: AssignmentReplyRecordValue): boolean {
  const body = receipt.frame.body;
  return body.requestKind === "pull" && "assignments" in body.body && body.body.assignments.length === 0;
}

/** An exact retry publishes no new facts; changed content is a conflict. Replay upgrades old evidence with its verifiable frame. */
function replayedReply(existing: StoredAssignmentReplyRecordValue, input: AssignmentReplyRecordValue): LocalExecutionRecord[] {
  if (verified(existing)) {
    if (!same(existing, input)) throw recovery();
  } else if (!same(existing.request, input.request) || !allEqual([[existing.response.sequence, input.response.sequence], [existing.response.digest, input.response.digest]]) ||
    !same(existing.body, input.frame.body)) {
    throw recovery();
  }
  // Exact authenticated replay upgrades old evidence with its original
  // verifiable frame; retain the historical cursor, never fabricate time.
  return [{ kind: "assignment_reply", value: input }];
}

function assertOperationInput(state: StreamState, input: OperationInput, freshPull: boolean): void {
  if (input.kind === "pull" && !freshPull && state.head.retiredThroughRequestSequence > 0) throw retired();
  if (input.origin.runnerIncarnation !== input.runnerIncarnation) throw recovery();
  if ([...state.requests.values()].some(request => requestKindOf(request.frame) === input.kind && !request.operationId)) throw recovery();
}

/** The operation this input repeats, if any; for a business retry of a report, the gap it retries after. */
function priorOperation(state: StreamState, input: OperationInput): { existing?: AssignmentOperation | undefined; retryAfter?: z.infer<typeof RetryAfterSchema> } {
  const rows = [...state.operations.values()];
  if (input.kind === "pull") {
    if (input.body.instanceId !== input.instanceId) throw recovery();
    return { existing: rows.find(row => row.kind === "pull" && row.effect.state !== "applied") };
  }
  assertReportOwner(input.report, input.body);
  const owned = rows.filter(row => row.kind === "report" && row.report.reportId === input.report.reportId)
    .sort((a, b) => b.request.requestSequence - a.request.requestSequence);
  const latest = owned[0];
  if (!input.retryAfter) return { existing: latest };
  const existing = owned.find(row => row.kind === "report" && same(row.retryAfter?.request, input.retryAfter));
  return existing ? { existing } : { retryAfter: retryAfterGap(state, latest, input) };
}

function retryAfterGap(state: StreamState, candidate: AssignmentOperation | undefined, input: ReportInput): z.infer<typeof RetryAfterSchema> {
  const latest = retriedReport(candidate, input);
  const receipt = state.repliesByRequest.get(latest.request.requestSequence);
  if (!receipt || !verified(receipt) || !isReportGap(receipt)) throw recovery();
  if (!same(state.requests.get(latest.request.requestSequence)?.frame.body, input.body)) throw recovery();
  return { request: latest.request, response: receipt.response };
}

/** The report's latest attempt, which a business retry must name exactly. */
function retriedReport(latest: AssignmentOperation | undefined, input: ReportInput): ReportOperation {
  if (!latest || latest.kind !== "report" || !same(latest.request, input.retryAfter) || !same(latest.report, input.report)) throw recovery();
  return latest;
}

/** The retained request of an operation this input repeats: same origin and, for a report, the same owner and body. */
function reallocated(state: StreamState, input: OperationInput, existing: AssignmentOperation): AssignmentRequestRecord {
  if (existing.request.requestSequence <= state.head.retiredThroughRequestSequence) throw retired();
  const request = state.requests.get(existing.request.requestSequence);
  if (!request || !same(request.frame.origin, input.origin) || (input.kind === "report" && !sameReport(existing, input, request))) throw recovery();
  return request;
}

function sameReport(existing: AssignmentOperation, input: ReportInput, request: AssignmentRequestRecord): boolean {
  return existing.kind === "report" && same(existing.report, input.report) && same(request.frame.body, input.body);
}

function existingClaim(state: StreamState, allocation: AssignmentRequestReference, input: z.infer<typeof AllocationInputSchema>): AssignmentRequestRecord {
  if (allocation.requestSequence <= state.head.retiredThroughRequestSequence) throw retired();
  const existing = state.requests.get(allocation.requestSequence);
  if (!existing || !same(existing.admission, input.admission) || !same(existing.frame.origin, input.origin) || existing.frame.issuedAt !== input.issuedAt) throw recovery();
  return existing;
}

/** Room for one more request: a safe next sequence and fewer than the retained-request limit above the floor. */
function assertAllocationRoom(state: StreamState, limits: { maxRequests: number }): void {
  if (state.head.allocatedThrough >= Number.MAX_SAFE_INTEGER || state.head.allocatedThrough - state.head.retiredThroughRequestSequence >= limits.maxRequests) throw recovery();
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
  if (kind === "claim") return assertClaimVerdict(request.frame.body as ClaimIdentity, body as ClaimIdentity & { outcome: string });
  if (kind === "report") assertReportAck(request.frame.body as ReportIdentity, body as ReportAckIdentity);
  // A pull result carries no operation identity beyond its correlation, so a
  // concurrent pull cannot consume another's result by sequence alone.
}

type ClaimIdentity = { assignmentId: string; attempt: number; claimId: string };
type ReportIdentity = ClaimIdentity & { reportId: string; reportSequence: number };
type ReportAckIdentity = ClaimIdentity & { acknowledged: { reportId: string; reportSequence: number } };

/** An `already_claimed` may name another claim; any other verdict is for this exact claim. */
function assertClaimVerdict(sent: ClaimIdentity, verdict: ClaimIdentity & { outcome: string }): void {
  if (verdict.assignmentId !== sent.assignmentId || verdict.attempt !== sent.attempt) throw recovery();
  if (verdict.outcome !== "already_claimed" && verdict.claimId !== sent.claimId) throw recovery();
}

function assertReportAck(sent: ReportIdentity, ack: ReportAckIdentity): void {
  if (!allEqual([
    [ack.assignmentId, sent.assignmentId], [ack.attempt, sent.attempt], [ack.claimId, sent.claimId],
    [ack.acknowledged.reportId, sent.reportId], [ack.acknowledged.reportSequence, sent.reportSequence],
  ])) throw recovery();
}
