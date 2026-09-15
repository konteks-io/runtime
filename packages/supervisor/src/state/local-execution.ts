import { z } from "zod";
import { AssignmentRequestReferenceSchema, RemoteInstanceError, RemoteWorkAssignmentSchema, canonicalize, jcsDigest, type AssignmentRequestReference, type JsonValue, type RemoteWorkAssignment, type RetainedProcessOwner } from "@konteks/remote-common";
import { LocalAdmissionSchema, type LocalAdmission } from "./local-admission.js";
import { AssignmentAllocationRecordSchema, AssignmentOperationRecordSchema, AssignmentReplyRecordSchema, AssignmentStreamRecordSchema, assignmentOperationKey, assignmentReplyKey, assignmentRequestKey, assignmentStreamKey, initialAssignmentStream, validateAssignmentStreamRecords } from "./assignment-stream.js";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const SeedSchema = z.object({ enrollmentId: id, activationId: id, keyDigest: digest, createdAt: z.string().datetime(), assignmentStreamVersion: z.literal(1).optional() }).strict();
const BindingSchema = SeedSchema.extend({ instanceId: id, workspaceId: id, exchangeNonce: id }).strict();
const scope = { instanceId: id, workspaceId: id };
const AdmissionSchema = LocalAdmissionSchema;
const RetainedProcessOwnerSchema = z.object({ version: z.literal(1), platform: z.literal("darwin"), pid: z.number().int().positive(), processGroupId: z.number().int().positive(), startToken: id, commandDigest: digest }).strict();
const LiveContinuationTransferSchema = z.object({ predecessor: AdmissionSchema, successor: AdmissionSchema,
  sessionId: id, acpSessionRef: id, processOwner: RetainedProcessOwnerSchema, continuedAt: z.string().datetime() }).strict();

/** D162 added immutable repository/model/turn identity to delivery assignments.
 * Old retained claims must remain readable long enough to drain, but their
 * synthetic sentinel identity can never match a new Core-issued turn and is
 * therefore never continuation or execution authority. */
const JournalRemoteWorkAssignmentSchema = z.preprocess((candidate) => {
  if (!candidate || typeof candidate !== "object") return candidate;
  const assignment = candidate as Record<string, unknown>;
  const source = assignment.source;
  if (!source || typeof source !== "object") return candidate;
  const value = source as Record<string, unknown>;
  if (value.kind !== "harness_delivery" ||
      (typeof value.repositoryId === "string" && value.modelBinding && typeof value.modelBinding === "object" && value.turn && typeof value.turn === "object")) return candidate;
  const assignmentId = typeof assignment.id === "string" ? assignment.id : "unknown";
  const invocationId = typeof assignment.correlationId === "string" ? assignment.correlationId : `pre-d162-${assignmentId}`;
  const selectedModel = assignment.agentRoute && typeof assignment.agentRoute === "object" &&
    (assignment.agentRoute as Record<string, unknown>).sessionConfig && typeof (assignment.agentRoute as Record<string, unknown>).sessionConfig === "object" &&
    typeof ((assignment.agentRoute as Record<string, unknown>).sessionConfig as Record<string, unknown>).model === "string"
      ? String(((assignment.agentRoute as Record<string, unknown>).sessionConfig as Record<string, unknown>).model)
      : "pre-d162-unrecoverable";
  return {
    ...assignment,
    agentRoute: assignment.agentRoute && typeof assignment.agentRoute === "object"
      ? { ...(assignment.agentRoute as Record<string, unknown>), requiredRole: "generator" }
      : assignment.agentRoute,
    source: {
      ...value,
      repositoryId: `https://pre-d162.invalid/retired/${encodeURIComponent(assignmentId)}`,
      modelBinding: { canonicalProviderId: "pre-d162", canonicalModelId: selectedModel },
      turn: { invocationId, dispatchGeneration: 0 },
    },
  };
}, RemoteWorkAssignmentSchema);

const StartInputSchema = z.object({ schemaVersion: z.literal(1), mandatoryOpenVersion: z.literal(1), admission: AdmissionSchema, assignment: JournalRemoteWorkAssignmentSchema,
  evidenceUpload: z.enum(["structured_only", "selected_artifacts"]), projectionCreatedAt: z.string().datetime(), claimCreatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const { admission: a, assignment: work } = value;
  if (a.assignmentId !== work.id || a.attempt !== work.attempt || a.instanceId !== work.instanceId || a.workspaceId !== work.workspaceId || a.agentId !== work.agentRoute.agentId ||
    (value.evidenceUpload === "selected_artifacts" && work.policy.evidenceUpload !== "selected_artifacts")) context.addIssue({ code: "custom", message: "Complete start identity or policy mismatch" });
});
const StartSchema = StartInputSchema.safeExtend({ delivery: z.enum(["unallocated", "allocation_reserved", "allocated"]),
  allocation: AssignmentRequestReferenceSchema.extend({ requestKind: z.literal("claim") }).optional(),
  claimEffect: z.object({ state: z.enum(["pending", "applying", "applied"]), response: z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest }).strict() }).strict().optional(),
}).superRefine((value, context) => {
  if ((value.delivery === "allocated") !== (value.allocation !== undefined)) context.addIssue({ code: "custom", message: "Allocated admission requires exactly its immutable request reference" });
  if (value.claimEffect && value.delivery !== "allocated") context.addIssue({ code: "custom", message: "Only an allocated admission owns a claim reply effect" });
});
export type LocalAdmissionStart = z.infer<typeof StartSchema>;
const CancellationSchema = z.object({ ...scope, runnerIncarnation: id, manifestId: id, assignmentId: id, attempt: AdmissionSchema.shape.attempt, decisionDigest: digest, cancelledAt: z.string().datetime() }).strict();
const ExecutionSchema = z.object({ schemaVersion: z.literal(1), admission: AdmissionSchema, openedAt: z.string().datetime(), acpSessionRef: id.nullable(), referenceFence: id.nullable(), processOwner: RetainedProcessOwnerSchema.optional(), phase: z.enum(["opened", "stopping", "process_stopped", "acp_settled", "continued", "interrupted_unqualified"]), stoppingAt: z.string().datetime().nullable(), processStoppedAt: z.string().datetime().optional(), interruptedAt: z.string().datetime().optional(), acpSettledAt: z.string().datetime().nullable(), completedTurnSettledAt: z.string().datetime().optional(), continuedFromGeneration: id.optional(), restoredFromGeneration: id.optional(), restoreAcpSessionRef: id.optional(), continuedToGeneration: id.optional(), continuedAt: z.string().datetime().optional(), lifecycleProfileDigest: z.null(), executionProfileDigest: z.null() }).strict().superRefine((value, context) => {
  if ((value.acpSessionRef === null && value.referenceFence !== null) ||
      (value.acpSessionRef !== null && value.referenceFence === null && value.phase !== "continued") ||
      (value.referenceFence !== null && value.referenceFence !== value.admission.executionGeneration) ||
      (value.completedTurnSettledAt !== undefined && value.acpSessionRef === null) ||
      (value.phase === "opened" && (value.stoppingAt !== null || value.acpSettledAt !== null)) ||
      (value.phase !== "opened" && value.phase !== "continued" && value.stoppingAt === null) ||
      (value.phase === "stopping" && (value.processStoppedAt !== undefined || value.acpSettledAt !== null)) ||
      (value.phase === "process_stopped" && (value.processStoppedAt === undefined || value.acpSettledAt !== null)) ||
      (value.phase === "acp_settled" && (value.acpSessionRef === null || value.acpSettledAt === null)) ||
      (value.phase === "interrupted_unqualified" && (value.processStoppedAt === undefined || value.interruptedAt === undefined || value.acpSettledAt !== null)) ||
      (value.interruptedAt !== undefined && value.phase !== "interrupted_unqualified") ||
      (value.phase === "continued" && (value.acpSessionRef === null || value.referenceFence !== null || !value.processOwner || !value.completedTurnSettledAt || !value.continuedToGeneration || !value.continuedAt || value.stoppingAt !== null || value.acpSettledAt !== null)) ||
      (value.phase !== "continued" && (value.continuedToGeneration !== undefined || value.continuedAt !== undefined)) ||
      (value.continuedFromGeneration !== undefined && (!value.processOwner || value.acpSessionRef === null || value.restoredFromGeneration !== undefined)) ||
      ((value.restoredFromGeneration === undefined) !== (value.restoreAcpSessionRef === undefined)) ||
      (value.restoredFromGeneration !== undefined && (value.phase !== "opened" || value.continuedFromGeneration !== undefined || value.restoreAcpSessionRef === value.acpSessionRef))) context.addIssue({ code: "custom", message: "Inconsistent local execution phase" });
});
const HarnessSessionHeadSchema = z.object({
  executionSessionId: id, instanceId: id, workspaceId: id, taskId: id,
  repositoryId: z.string().url().max(4096), requiredRole: id, agentId: id,
  selectedModel: z.string().min(1).max(256), canonicalProviderId: z.string().min(1).max(256),
  canonicalModelId: z.string().min(1).max(256), executionGeneration: id,
  turn: z.object({ invocationId: id, dispatchGeneration: z.number().int().nonnegative().safe() }).strict(),
  completedAt: z.string().datetime(),
}).strict();
export type LocalExecutionState = z.infer<typeof ExecutionSchema>;
export type { LocalAdmission } from "./local-admission.js";
export type LocalAbsenceCancellation = z.infer<typeof CancellationSchema>;
export interface LiveContinuationCandidate {
  admission: LocalAdmission;
  acpSessionRef: string;
  processOwner: RetainedProcessOwner;
}
export const LocalExecutionRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enrollment_seed"), value: SeedSchema }).strict(),
  z.object({ kind: z.literal("enrollment_bound"), value: BindingSchema }).strict(),
  z.object({ kind: z.literal("admission"), value: AdmissionSchema }).strict(),
  z.object({ kind: z.literal("admission_start"), value: StartSchema }).strict(),
  z.object({ kind: z.literal("execution"), value: ExecutionSchema }).strict(),
  z.object({ kind: z.literal("harness_session_head"), value: HarnessSessionHeadSchema }).strict(),
  z.object({ kind: z.literal("absence_cancelled"), value: CancellationSchema }).strict(),
  AssignmentStreamRecordSchema,
  AssignmentAllocationRecordSchema,
  AssignmentReplyRecordSchema,
  AssignmentOperationRecordSchema,
]);
export type LocalExecutionRecord = z.infer<typeof LocalExecutionRecordSchema>;
export function localExecutionKey(record: LocalExecutionRecord): string {
  if (record.kind === "enrollment_seed" || record.kind === "enrollment_bound") return "enrollment";
  if (record.kind === "assignment_stream") return assignmentStreamKey();
  if (record.kind === "assignment_request") return assignmentRequestKey(record.value.frame.seq);
  if (record.kind === "assignment_reply") return assignmentReplyKey(record.value.response.sequence);
  if (record.kind === "assignment_operation") return assignmentOperationKey(record.value.operationId);
  if (record.kind === "execution") return JSON.stringify([record.kind, record.value.admission.executionGeneration]);
  if (record.kind === "harness_session_head") return JSON.stringify([record.kind, record.value.executionSessionId]);
  if (record.kind === "admission_start") return JSON.stringify(["admission", record.value.admission.assignmentId, record.value.admission.attempt]);
  return JSON.stringify(record.kind === "admission" ? [record.kind, record.value.assignmentId, record.value.attempt] : [record.kind, record.value.manifestId, record.value.assignmentId, record.value.attempt]);
}
export interface ExecutionLog {
  readonly revision: number;
  all(): LocalExecutionRecord[];
  update(key: string, derive: (existing: LocalExecutionRecord | undefined) => LocalExecutionRecord): Promise<void>;
  batch(derive: () => LocalExecutionRecord[]): Promise<void>;
  /** Atomic complete-state replacement on the same serialized log owner. */
  rewrite(derive: () => LocalExecutionRecord[] | undefined): Promise<void>;
}
/** One fsync-backed log and serialization lane. ACP settlement is recorded only
 * by the live session owner; no quiescence is inferred, and admissions remain.
 */
export class LocalExecutionJournal {
  private indexedRevision = -1;
  private records: LocalExecutionRecord[] = [];
  private readonly admissions = new Map<string, LocalAdmission>();
  private readonly starts = new Map<string, LocalAdmissionStart>();
  private startBytes = 0;
  private readonly cancelled = new Set<string>();
  private readonly tombstones = new Map<string, LocalAbsenceCancellation>();
  private readonly scopes = new Set<string>();
  private readonly executions = new Map<string, LocalExecutionState>();
  private readonly harnessHeads = new Map<string, z.infer<typeof HarnessSessionHeadSchema>>();
  private readonly references = new Map<string, string>();
  constructor(private readonly log: ExecutionLog, private readonly capacity = 50_000, private readonly byteLimits = { startBytes: 1024 * 1024, totalStartBytes: 64 * 1024 * 1024 }) {}

  enrollment(): z.infer<typeof SeedSchema> | z.infer<typeof BindingSchema> | undefined {
    const record = this.index().find(row => row.kind === "enrollment_seed" || row.kind === "enrollment_bound");
    return record?.kind === "enrollment_seed" || record?.kind === "enrollment_bound" ? structuredClone(record.value) : undefined;
  }

  coverage(instanceId: string, workspaceId: string): "complete_from_enrollment" | "legacy_unknown" {
    return this.index().some(row => row.kind === "enrollment_bound" && row.value.instanceId === instanceId && row.value.workspaceId === workspaceId) ? "complete_from_enrollment" : "legacy_unknown";
  }

  /** ONLY the exclusive mkdir enrollment path may seed a newly created root. */
  async seedEnrollment(candidate: unknown): Promise<void> {
    const value = SeedSchema.parse(candidate);
    await this.log.update("enrollment", existing => {
      if (existing) {
        if (existing.kind !== "enrollment_seed" || !equal(existing.value, value)) throw conflict();
        return existing;
      }
      if (this.index().length) throw conflict();
      return { kind: "enrollment_seed", value };
    });
  }

  async bindEnrollment(candidate: unknown): Promise<void> {
    const value = BindingSchema.parse(candidate);
    if (value.assignmentStreamVersion === 1) {
      await this.log.batch(() => {
        const records = this.index();
        const existing = records.find(record => record.kind === "enrollment_seed" || record.kind === "enrollment_bound");
        if (existing?.kind === "enrollment_bound" && equal(existing.value, value)) {
          const state = validateAssignmentStreamRecords(records);
          if (!state.head) throw conflict();
          return [existing];
        }
        const { instanceId: _instance, workspaceId: _workspace, exchangeNonce: _nonce, ...seed } = value;
        if (existing?.kind !== "enrollment_seed" || !equal(existing.value, seed) || records.length !== 1) throw conflict();
        return [{ kind: "enrollment_bound", value }, { kind: "assignment_stream", value: initialAssignmentStream({ instanceId: value.instanceId, workspaceId: value.workspaceId, enrollmentId: value.enrollmentId }) }];
      });
      return;
    }
    await this.log.update("enrollment", existing => {
      if (existing?.kind === "enrollment_bound" && equal(existing.value, value)) return existing;
      const { instanceId: _instance, workspaceId: _workspace, exchangeNonce: _nonce, ...seed } = value;
      if (existing?.kind !== "enrollment_seed" || !equal(existing.value, seed) || this.index().some(row => row.kind === "admission" || row.kind === "admission_start" || row.kind === "absence_cancelled")) throw conflict();
      return { kind: "enrollment_bound", value };
    });
  }

  admission(assignmentId: string, attempt: number): LocalAdmission | undefined {
    this.index();
    const record = this.admissions.get(JSON.stringify([assignmentId, attempt]));
    return record && structuredClone(record);
  }

  isCancelled(assignmentId: string, attempt: number): boolean {
    this.index(); return this.cancelled.has(JSON.stringify([assignmentId, attempt]));
  }

  tombstone(identity: Pick<LocalAbsenceCancellation, "manifestId" | "assignmentId" | "attempt">): LocalAbsenceCancellation | undefined {
    this.index();
    const record = this.tombstones.get(JSON.stringify([identity.manifestId, identity.assignmentId, identity.attempt]));
    return record && structuredClone(record);
  }

  async admit(candidate: unknown, assertCurrent: () => void): Promise<void> {
    const value = AdmissionSchema.parse(candidate);
    await this.log.update(localExecutionKey({ kind: "admission", value }), existing => {
      assertCurrent(); this.assertScope(value);
      if (this.isCancelled(value.assignmentId, value.attempt)) throw conflict();
      if (existing) {
        if (existing.kind !== "admission" || !equal(existing.value, value)) throw conflict();
        return existing;
      }
      if ([...this.admissions.values()].some(row => row.executionGeneration === value.executionGeneration)) throw conflict();
      this.requireCapacity();
      return { kind: "admission", value };
    });
    assertCurrent();
  }

  start(assignmentId: string, attempt: number): LocalAdmissionStart | undefined {
    this.index(); const value = this.starts.get(JSON.stringify([assignmentId, attempt]));
    return value && structuredClone(value);
  }

  async beginAdmission(candidate: unknown, assertCurrent: () => void): Promise<void> {
    const input = StartInputSchema.parse(candidate);
    const value = StartSchema.parse({ ...input, delivery: "unallocated" });
    await this.log.update(localExecutionKey({ kind: "admission_start", value }), existing => {
      assertCurrent(); this.assertScope(value.admission);
      if (this.isCancelled(value.admission.assignmentId, value.admission.attempt)) throw conflict();
      if (existing) {
        if (existing.kind !== "admission_start") throw conflict();
        const { delivery: _delivery, allocation: _allocation, claimEffect: _claimEffect, ...original } = existing.value;
        if (!equal(original, input)) throw conflict();
        this.requireStartBytes(existing.value, existing.value);
        return existing;
      }
      if ([...this.admissions.values()].some(row => row.executionGeneration === value.admission.executionGeneration)) throw conflict();
      this.requireCapacity(); this.requireStartBytes(value);
      return { kind: "admission_start", value };
    });
    assertCurrent();
  }

  /** Single-use permission to enter today's allocator, not proof of allocation or delivery. */
  async reserveAllocation(admission: LocalAdmission, assertCurrent: () => void): Promise<void> {
    await this.log.update(JSON.stringify(["admission", admission.assignmentId, admission.attempt]), existing => {
      assertCurrent(); this.assertAdmission(admission);
      if (existing?.kind !== "admission_start" || existing.value.delivery !== "unallocated" || this.execution(admission)) throw conflict();
      const value: LocalAdmissionStart = { ...existing.value, delivery: "allocation_reserved" };
      this.requireStartBytes(value, existing.value);
      return { kind: "admission_start", value };
    });
    assertCurrent();
  }

  /** Called only inside the shared log batch: derive, never independently write. */
  prepareAllocatedStart(admission: LocalAdmission, reference: AssignmentRequestReference): Extract<LocalExecutionRecord, { kind: "admission_start" }> {
    this.assertAdmission(admission);
    const previous = this.start(admission.assignmentId, admission.attempt);
    if (!previous || previous.delivery !== "unallocated" || this.execution(admission)) throw conflict();
    const value = StartSchema.parse({ ...previous, delivery: "allocated", allocation: reference });
    this.requireStartBytes(value, previous); this.requireCapacity();
    return { kind: "admission_start", value };
  }

  /** Derive within the SAME reply/effect batch; preserve complete-start budgets. */
  prepareClaimEffect(admission: LocalAdmission, effect: NonNullable<LocalAdmissionStart["claimEffect"]>): Extract<LocalExecutionRecord, { kind: "admission_start" }> {
    this.assertAdmission(admission);
    const previous = this.start(admission.assignmentId, admission.attempt);
    if (!previous || previous.delivery !== "allocated") throw conflict();
    const before = previous.claimEffect;
    if (!before) {
      if (effect.state !== "pending" || this.execution(admission)) throw conflict();
    } else if (!equal(before.response, effect.response) ||
      !((before.state === "pending" && effect.state === "applying") || (before.state === "applying" && effect.state === "applied") || equal(before, effect))) throw conflict();
    const value = StartSchema.parse({ ...previous, claimEffect: effect });
    this.requireStartBytes(value, previous);
    return { kind: "admission_start", value };
  }

  private requireStartBytes(value: LocalAdmissionStart, previous?: LocalAdmissionStart): void {
    this.index();
    if (bytes(value) > this.byteLimits.startBytes || this.startBytes - (previous ? bytes(previous) : 0) + bytes(value) > this.byteLimits.totalStartBytes) throw new RemoteInstanceError("recovery_required", "Retained complete admission history is full; claim admission remains blocked.");
  }

  assertAdmission(value: LocalAdmission): void {
    this.assertScope(value);
    if (this.isCancelled(value.assignmentId, value.attempt) || !equal(this.admission(value.assignmentId, value.attempt), value)) throw conflict();
  }

  execution(admission: LocalAdmission): LocalExecutionState | undefined {
    this.index(); const state = this.executions.get(admission.executionGeneration);
    if (state && !equal(state.admission, admission)) throw conflict();
    return state && structuredClone(state);
  }

  /** Recover the one retained, completed ACP owner for a repository-role
   * session after the connector process itself restarted. The exact agent and
   * actual model selection are part of compatibility: a new preference can
   * never substitute the process behind an existing ACP session.
   */
  liveContinuation(successorAssignment: RemoteWorkAssignment): LiveContinuationCandidate | undefined {
    const successor = RemoteWorkAssignmentSchema.parse(successorAssignment);
    if (successor.source.kind !== "harness_delivery") return undefined;
    this.index();
    const head = this.harnessHeads.get(successor.source.executionSessionId);
    if (!head) {
      if (successor.source.turn.predecessor) throw conflict();
      return undefined;
    }
    if (!successor.source.turn.predecessor ||
        !equal(head.turn, successor.source.turn.predecessor)) throw conflict();
    const state = this.executions.get(head.executionGeneration);
    if (!state || state.phase !== "opened" || !state.completedTurnSettledAt ||
        !state.acpSessionRef || !state.processOwner) throw conflict();
    const predecessor = this.start(state.admission.assignmentId, state.admission.attempt)?.assignment;
    if (!predecessor || !sameLiveSession(predecessor, successor, state.acpSessionRef)) throw conflict();
    return structuredClone({ admission: state.admission, acpSessionRef: state.acpSessionRef, processOwner: state.processOwner });
  }

  /** Exact retry of a restore handoff whose provider load has not yet reserved
   * its fresh local reference. Once beforeCreate binds that reference, normal
   * recovery owns the uncertain side effect instead of replaying load.
   */
  pendingRestore(admission: LocalAdmission, successorAssignment: RemoteWorkAssignment): string | undefined {
    const successor = RemoteWorkAssignmentSchema.parse(successorAssignment);
    this.assertAdmission(admission);
    const state = this.execution(admission);
    if (!state?.restoredFromGeneration || !state.restoreAcpSessionRef || state.acpSessionRef !== null) return undefined;
    const predecessor = this.executions.get(state.restoredFromGeneration);
    const predecessorAssignment = predecessor && this.start(predecessor.admission.assignmentId, predecessor.admission.attempt)?.assignment;
    if (!predecessor || !predecessorAssignment || predecessor.phase !== "continued" ||
        predecessor.continuedToGeneration !== admission.executionGeneration ||
        !sameLiveSession(predecessorAssignment, successor, state.restoreAcpSessionRef)) throw conflict();
    return state.restoreAcpSessionRef;
  }

  async open(admission: LocalAdmission, assertCurrent: () => void, openedAt: string): Promise<void> {
    await this.transition(admission, assertCurrent, existing => {
      // A new dispatcher cannot reconstruct a live input/bootstrap owner from
      // a retained opened row, even when the reference is still unknown.
      if (existing) throw conflict();
      const start = this.start(admission.assignmentId, admission.attempt);
      if (start && start.delivery !== "allocation_reserved" && start.delivery !== "allocated") throw conflict();
      if (start?.delivery === "allocated") this.assertChosenClaimEffect(start);
      this.requireCapacity();
      return { schemaVersion: 1, admission, openedAt, acpSessionRef: null, referenceFence: null, phase: "opened", stoppingAt: null, acpSettledAt: null, lifecycleProfileDigest: null, executionProfileDigest: null };
    });
  }

  private assertChosenClaimEffect(start: LocalAdmissionStart): void {
    if (start.claimEffect?.state !== "applying") throw conflict();
    const row = this.index().find(value => value.kind === "assignment_reply" && value.value.response.sequence === start.claimEffect!.response.sequence);
    if (row?.kind !== "assignment_reply" || !("frame" in row.value) || row.value.frame.body.requestKind !== "claim" ||
      !equal(row.value.request, start.allocation) || !equal(row.value.response, start.claimEffect.response)) throw conflict();
    const verdict = row.value.frame.body.body, admission = start.admission;
    if ("kind" in verdict || (verdict.outcome !== "claimed" && verdict.outcome !== "already_claimed") ||
      verdict.assignmentId !== admission.assignmentId || verdict.attempt !== admission.attempt || verdict.claimId !== admission.claimId) throw conflict();
  }

  async bindReference(admission: LocalAdmission, ref: string, assertCurrent: () => void): Promise<void> {
    id.parse(ref);
    await this.transition(admission, assertCurrent, existing => {
      this.index();
      if (!existing || existing.phase !== "opened" || existing.acpSessionRef !== null || this.references.has(ref)) throw conflict();
      return { ...existing, acpSessionRef: ref, referenceFence: admission.executionGeneration };
    });
  }

  async bindProcessOwner(admission: LocalAdmission, owner: RetainedProcessOwner, assertCurrent: () => void): Promise<void> {
    const parsed = RetainedProcessOwnerSchema.parse(owner);
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || existing.phase !== "opened" || existing.acpSessionRef === null) throw conflict();
      if (existing.processOwner && !equal(existing.processOwner, parsed)) throw conflict();
      return existing.processOwner ? existing : { ...existing, processOwner: parsed };
    });
  }

  /**
   * Atomic, fsync-backed owner rotation for an ACP bootstrap retry. The caller
   * has confirmed the exact previous process stopped; this transition is
   * available only while the execution is opened and has never completed a
   * prompt. It cannot rotate a continued, stopping, or settled execution.
   */
  async replaceBootstrapProcessOwner(
    admission: LocalAdmission,
    previous: RetainedProcessOwner,
    replacement: RetainedProcessOwner,
    assertCurrent: () => void,
  ): Promise<void> {
    const expected = RetainedProcessOwnerSchema.parse(previous);
    const next = RetainedProcessOwnerSchema.parse(replacement);
    if (equal(expected, next)) throw conflict();
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || existing.phase !== "opened" || existing.acpSessionRef === null ||
          existing.completedTurnSettledAt !== undefined || !existing.processOwner || !equal(existing.processOwner, expected)) throw conflict();
      return { ...existing, processOwner: next };
    });
  }

  assertExecutable(admission: LocalAdmission, ref?: string): void {
    this.assertAdmission(admission);
    const state = this.execution(admission);
    if (!state || state.phase !== "opened" || (ref !== undefined && (state.acpSessionRef !== ref || this.references.get(ref) !== admission.executionGeneration))) throw conflict();
  }

  async markStopping(admission: LocalAdmission, at: string, assertCurrent: () => void): Promise<void> {
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || existing.phase === "continued") throw conflict();
      return existing.phase === "opened" ? { ...existing, phase: "stopping", stoppingAt: at } : existing;
    });
  }

  async markAcpSettled(admission: LocalAdmission, ref: string, at: string, assertCurrent: () => void): Promise<void> {
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || existing.phase === "opened" || existing.acpSessionRef !== ref || existing.referenceFence !== admission.executionGeneration || this.references.get(ref) !== admission.executionGeneration) throw conflict();
      return existing.phase === "acp_settled" ? existing : { ...existing, phase: "acp_settled", acpSettledAt: at };
    });
  }

  async markProcessStopped(admission: LocalAdmission, at: string, assertCurrent: () => void): Promise<void> {
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || (existing.phase !== "stopping" && existing.phase !== "process_stopped") || !existing.processOwner) throw conflict();
      return existing.phase === "process_stopped" ? existing : { ...existing, phase: "process_stopped", processStoppedAt: at };
    });
  }

  /**
   * The exact execution process is proven gone (leader and process group), so
   * the attempt cannot continue and recovery states that instead of blocking
   * startup forever. This is NOT D139 quiescence and never says the agent's
   * tool or MCP work drained: the retained reference stays excluded from
   * reuse, no capacity is released, and the claim is reported interrupted.
   */
  async markInterruptedWithoutQuiescence(admission: LocalAdmission, at: string, assertCurrent: () => void): Promise<void> {
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || (existing.phase !== "process_stopped" && existing.phase !== "interrupted_unqualified") || !existing.processOwner) throw conflict();
      return existing.phase === "interrupted_unqualified" ? existing : { ...existing, phase: "interrupted_unqualified", interruptedAt: at };
    });
  }

  assertQuiescent(admission: LocalAdmission): never {
    this.assertAdmission(admission);
    // No authenticated lifecycle/tool configuration profile is qualified yet.
    throw new RemoteInstanceError("recovery_required", "ACP settlement is not qualified execution quiescence.");
  }

  /** A live completed-turn receipt, not a recovery/finalization permission.
   * Retain reference ownership and do not reconstruct this from terminal reports.
   */
  async markCompletedTurnSettled(admission: LocalAdmission, ref: string, at: string, assertCurrent: () => void): Promise<void> {
    await this.log.batch(() => {
      assertCurrent(); this.assertAdmission(admission);
      const existing = this.execution(admission);
      if (!existing || existing.phase !== "opened" || existing.acpSessionRef !== ref ||
          this.references.get(ref) !== admission.executionGeneration) throw conflict();
      const start = this.start(admission.assignmentId, admission.attempt);
      const assignment = start?.assignment;
      const settled = ExecutionSchema.parse(existing.completedTurnSettledAt !== undefined
        ? existing : { ...existing, completedTurnSettledAt: at });
      if (assignment?.source.kind !== "harness_delivery") return [{ kind: "execution", value: settled }];
      const source = assignment.source;
      const prior = this.harnessHeads.get(source.executionSessionId);
      const head = HarnessSessionHeadSchema.parse({
        executionSessionId: source.executionSessionId, instanceId: assignment.instanceId,
        workspaceId: assignment.workspaceId, taskId: assignment.taskId, repositoryId: source.repositoryId,
        requiredRole: assignment.agentRoute.requiredRole, agentId: assignment.agentRoute.agentId,
        selectedModel: assignment.agentRoute.sessionConfig?.model,
        canonicalProviderId: source.modelBinding.canonicalProviderId,
        canonicalModelId: source.modelBinding.canonicalModelId,
        executionGeneration: admission.executionGeneration,
        turn: { invocationId: source.turn.invocationId, dispatchGeneration: source.turn.dispatchGeneration }, completedAt: at,
      });
      if (prior && !sameHarnessHead(prior, head)) throw conflict();
      if (prior && equal(prior.turn, head.turn)) {
        if (prior.executionGeneration !== admission.executionGeneration) throw conflict();
        return [{ kind: "execution", value: settled }];
      }
      if (prior) {
        if (!source.turn.predecessor || !equal(source.turn.predecessor, prior.turn)) throw conflict();
      } else if (source.turn.predecessor) throw conflict();
      return [{ kind: "execution", value: settled }, { kind: "harness_session_head", value: head }];
    });
    assertCurrent();
  }

  /** Atomically hand one still-live, idle ACP owner to the next admitted turn.
   * This is neither load/resume after restart nor D142 quiescence: both
   * generations must belong to the same live incarnation, conversation and
   * agent, and the exact process owner remains retained by the successor.
   */
  async transferLiveContinuation(candidate: unknown, assertCurrent: () => void): Promise<void> {
    const value = LiveContinuationTransferSchema.parse(candidate);
    const { predecessor, successor, sessionId, acpSessionRef, processOwner, continuedAt } = value;
    await this.log.batch(() => {
      assertCurrent(); this.assertAdmission(predecessor); this.assertAdmission(successor);
      if (predecessor.executionGeneration === successor.executionGeneration || predecessor.assignmentId === successor.assignmentId ||
          predecessor.instanceId !== successor.instanceId || predecessor.workspaceId !== successor.workspaceId ||
          predecessor.runnerIncarnation !== successor.runnerIncarnation || predecessor.agentId !== successor.agentId) throw conflict();
      const predecessorStart = this.start(predecessor.assignmentId, predecessor.attempt);
      const successorStart = this.start(successor.assignmentId, successor.attempt);
      // The predecessor's own requested reference is deliberately NOT compared:
      // a turn admitted with a stale reference (its predecessor was not live
      // here) legitimately opened a FRESH session, and the reference it
      // actually opened — asserted on its execution record below — is the one
      // a successor continues. Comparing the request made every turn after a
      // fresh-session fallback unprovable.
      if (!predecessorStart || !successorStart || logicalSessionId(predecessorStart.assignment) !== sessionId ||
          logicalSessionId(successorStart.assignment) !== sessionId ||
          !sameLiveSession(predecessorStart.assignment, successorStart.assignment, acpSessionRef) ||
          predecessorStart.assignment.agentRoute.agentId !== predecessor.agentId || successorStart.assignment.agentRoute.agentId !== successor.agentId ||
          (successorStart.delivery !== "allocation_reserved" && successorStart.delivery !== "allocated")) throw conflict();
      if (successorStart.delivery === "allocated") this.assertChosenClaimEffect(successorStart);
      const before = this.execution(predecessor), after = this.execution(successor);
      if (before?.phase === "continued" && after) {
        if (before.acpSessionRef !== acpSessionRef || before.continuedToGeneration !== successor.executionGeneration || before.continuedAt !== continuedAt ||
            after.acpSessionRef !== acpSessionRef || after.referenceFence !== successor.executionGeneration || after.continuedFromGeneration !== predecessor.executionGeneration ||
            !equal(before.processOwner, processOwner) || !equal(after.processOwner, processOwner)) throw conflict();
        return [{ kind: "execution", value: before }, { kind: "execution", value: after }];
      }
      this.index();
      if (!before || after || before.phase !== "opened" || before.acpSessionRef !== acpSessionRef || before.referenceFence !== predecessor.executionGeneration ||
          before.completedTurnSettledAt === undefined || !equal(before.processOwner, processOwner) || this.references.get(acpSessionRef) !== predecessor.executionGeneration) throw conflict();
      if (Date.parse(continuedAt) < Math.max(Date.parse(before.openedAt), Date.parse(before.completedTurnSettledAt), Date.parse(successor.openedAt))) throw conflict();
      this.requireCapacity();
      const prior = ExecutionSchema.parse({ ...before, phase: "continued", referenceFence: null,
        continuedToGeneration: successor.executionGeneration, continuedAt });
      const next = ExecutionSchema.parse({ schemaVersion: 1, admission: successor, openedAt: continuedAt,
        acpSessionRef, referenceFence: successor.executionGeneration, processOwner, phase: "opened", stoppingAt: null,
        acpSettledAt: null, continuedFromGeneration: predecessor.executionGeneration,
        lifecycleProfileDigest: null, executionProfileDigest: null });
      return [{ kind: "execution", value: prior }, { kind: "execution", value: next }];
    });
    assertCurrent();
  }

  /** Fence a completed owner from a prior connector incarnation and reserve a
   * successor that will load the persisted provider session under a fresh
   * local reference. No old process ownership is transferred or inferred.
   */
  async transferRestoredContinuation(candidate: unknown, assertCurrent: () => void): Promise<void> {
    const value = LiveContinuationTransferSchema.parse(candidate);
    const { predecessor, successor, sessionId, acpSessionRef, processOwner, continuedAt } = value;
    await this.log.batch(() => {
      assertCurrent(); this.assertAdmission(predecessor); this.assertAdmission(successor);
      if (predecessor.executionGeneration === successor.executionGeneration || predecessor.assignmentId === successor.assignmentId ||
          predecessor.instanceId !== successor.instanceId || predecessor.workspaceId !== successor.workspaceId ||
          predecessor.runnerIncarnation === successor.runnerIncarnation || predecessor.agentId !== successor.agentId) throw conflict();
      const predecessorStart = this.start(predecessor.assignmentId, predecessor.attempt);
      const successorStart = this.start(successor.assignmentId, successor.attempt);
      if (!predecessorStart || !successorStart || logicalSessionId(predecessorStart.assignment) !== sessionId ||
          logicalSessionId(successorStart.assignment) !== sessionId ||
          !sameLiveSession(predecessorStart.assignment, successorStart.assignment, acpSessionRef) ||
          predecessorStart.assignment.agentRoute.agentId !== predecessor.agentId || successorStart.assignment.agentRoute.agentId !== successor.agentId ||
          (successorStart.delivery !== "allocation_reserved" && successorStart.delivery !== "allocated")) throw conflict();
      if (successorStart.delivery === "allocated") this.assertChosenClaimEffect(successorStart);
      const before = this.execution(predecessor), after = this.execution(successor);
      if (before?.phase === "continued" && after) {
        if (before.acpSessionRef !== acpSessionRef || before.continuedToGeneration !== successor.executionGeneration || before.continuedAt !== continuedAt ||
            after.restoredFromGeneration !== predecessor.executionGeneration || after.restoreAcpSessionRef !== acpSessionRef ||
            after.acpSessionRef !== null || after.referenceFence !== null || !equal(before.processOwner, processOwner)) throw conflict();
        return [{ kind: "execution", value: before }, { kind: "execution", value: after }];
      }
      this.index();
      if (!before || after || before.phase !== "opened" || before.acpSessionRef !== acpSessionRef || before.referenceFence !== predecessor.executionGeneration ||
          before.completedTurnSettledAt === undefined || !equal(before.processOwner, processOwner) || this.references.get(acpSessionRef) !== predecessor.executionGeneration) throw conflict();
      if (Date.parse(continuedAt) < Math.max(Date.parse(before.openedAt), Date.parse(before.completedTurnSettledAt), Date.parse(successor.openedAt))) throw conflict();
      this.requireCapacity();
      const prior = ExecutionSchema.parse({ ...before, phase: "continued", referenceFence: null,
        continuedToGeneration: successor.executionGeneration, continuedAt });
      const next = ExecutionSchema.parse({ schemaVersion: 1, admission: successor, openedAt: continuedAt,
        acpSessionRef: null, referenceFence: null, phase: "opened", stoppingAt: null, acpSettledAt: null,
        restoredFromGeneration: predecessor.executionGeneration, restoreAcpSessionRef: acpSessionRef,
        lifecycleProfileDigest: null, executionProfileDigest: null });
      return [{ kind: "execution", value: prior }, { kind: "execution", value: next }];
    });
    assertCurrent();
  }

  private async transition(admission: LocalAdmission, assertCurrent: () => void, derive: (existing: LocalExecutionState | undefined) => LocalExecutionState): Promise<void> {
    await this.log.update(JSON.stringify(["execution", admission.executionGeneration]), existing => {
      assertCurrent(); this.assertAdmission(admission);
      if (existing && (existing.kind !== "execution" || !equal(existing.value.admission, admission))) throw conflict();
      return { kind: "execution", value: ExecutionSchema.parse(derive(existing?.kind === "execution" ? existing.value : undefined)) };
    });
    assertCurrent();
  }

  async cancelAbsent(candidate: unknown, assertAbsentAndCurrent: () => void): Promise<void> {
    const value = CancellationSchema.parse(candidate);
    await this.log.update(localExecutionKey({ kind: "absence_cancelled", value }), existing => {
      assertAbsentAndCurrent(); this.assertScope(value);
      if (this.coverage(value.instanceId, value.workspaceId) !== "complete_from_enrollment") throw conflict();
      if ([...this.admissions.values()].some(row => row.assignmentId === value.assignmentId)) throw conflict();
      if (this.index().some(row => row.kind === "absence_cancelled" && row.value.assignmentId === value.assignmentId && row.value.attempt !== value.attempt)) throw conflict();
      if (existing) {
        if (existing.kind !== "absence_cancelled" || !equal(existing.value, value)) throw conflict();
        return existing;
      }
      this.requireCapacity();
      return { kind: "absence_cancelled", value };
    });
    assertAbsentAndCurrent();
  }

  private assertScope(value: { instanceId: string; workspaceId: string }): void {
    this.index();
    if (this.scopes.size > 1 || (this.scopes.size === 1 && !this.scopes.has(JSON.stringify([value.instanceId, value.workspaceId])))) throw conflict();
  }
  private requireCapacity(): void {
    if (this.index().length >= this.capacity) throw new RemoteInstanceError("recovery_required", "Retained local execution history is full; admission remains blocked until authorized retention is available.");
  }

  private index(): LocalExecutionRecord[] {
    if (this.indexedRevision === this.log.revision) return this.records;
    this.records = this.log.all();
    this.admissions.clear(); this.cancelled.clear(); this.tombstones.clear(); this.scopes.clear(); this.executions.clear(); this.references.clear();
    this.starts.clear(); this.harnessHeads.clear(); this.startBytes = 0;
    for (const record of this.records) {
      if ("instanceId" in record.value) this.scopes.add(JSON.stringify([record.value.instanceId, record.value.workspaceId]));
      if (record.kind === "admission") this.admissions.set(JSON.stringify([record.value.assignmentId, record.value.attempt]), record.value);
      if (record.kind === "admission_start") {
        const { admission } = record.value;
        const key = JSON.stringify([admission.assignmentId, admission.attempt]);
        this.scopes.add(JSON.stringify([admission.instanceId, admission.workspaceId]));
        this.admissions.set(key, admission); this.starts.set(key, record.value);
        const size = bytes(record.value); this.startBytes += size;
        if (size > this.byteLimits.startBytes || this.startBytes > this.byteLimits.totalStartBytes) throw conflict();
      }
      if (record.kind === "execution") {
        const state = record.value;
        this.executions.set(state.admission.executionGeneration, state);
        if (state.referenceFence !== null) {
          if (state.acpSessionRef === null) throw conflict();
          if (this.references.has(state.acpSessionRef)) throw conflict();
          this.references.set(state.acpSessionRef, state.admission.executionGeneration);
        }
      }
      if (record.kind === "harness_session_head") {
        if (this.harnessHeads.has(record.value.executionSessionId)) throw conflict();
        this.harnessHeads.set(record.value.executionSessionId, record.value);
      }
      if (record.kind === "absence_cancelled") {
        this.cancelled.add(JSON.stringify([record.value.assignmentId, record.value.attempt]));
        this.tombstones.set(JSON.stringify([record.value.manifestId, record.value.assignmentId, record.value.attempt]), record.value);
      }
    }
    const generations = new Set<string>();
    for (const admission of this.admissions.values()) {
      if (generations.has(admission.executionGeneration)) throw conflict();
      generations.add(admission.executionGeneration);
    }
    for (const state of this.executions.values()) {
      if (!equal(this.admissions.get(JSON.stringify([state.admission.assignmentId, state.admission.attempt])), state.admission)) throw conflict();
      const start = this.starts.get(JSON.stringify([state.admission.assignmentId, state.admission.attempt]));
      if (start && start.delivery !== "allocation_reserved" && start.delivery !== "allocated") throw conflict();
      if (state.continuedToGeneration) {
        const successor = this.executions.get(state.continuedToGeneration);
        const live = successor?.continuedFromGeneration === state.admission.executionGeneration && successor.acpSessionRef === state.acpSessionRef &&
          equal(successor.processOwner, state.processOwner);
        const restored = successor?.restoredFromGeneration === state.admission.executionGeneration && successor.restoreAcpSessionRef === state.acpSessionRef;
        if (!successor || (!live && !restored)) throw conflict();
      }
      if (state.continuedFromGeneration) {
        const predecessor = this.executions.get(state.continuedFromGeneration);
        if (!predecessor || predecessor.continuedToGeneration !== state.admission.executionGeneration || predecessor.acpSessionRef !== state.acpSessionRef ||
            !equal(predecessor.processOwner, state.processOwner)) throw conflict();
      }
      if (state.restoredFromGeneration) {
        const predecessor = this.executions.get(state.restoredFromGeneration);
        if (!predecessor || predecessor.continuedToGeneration !== state.admission.executionGeneration ||
            predecessor.acpSessionRef !== state.restoreAcpSessionRef) throw conflict();
      }
    }
    for (const head of this.harnessHeads.values()) {
      const state = this.executions.get(head.executionGeneration);
      // `index()` is already constructing the maps. Calling the public
      // accessor here would recursively re-enter `index()` until stack
      // exhaustion on every retained Harness head.
      const assignment = state && this.starts.get(JSON.stringify([
        state.admission.assignmentId, state.admission.attempt,
      ]))?.assignment;
      if (!state?.completedTurnSettledAt || assignment?.source.kind !== "harness_delivery" ||
          assignment.source.executionSessionId !== head.executionSessionId ||
          assignment.source.repositoryId !== head.repositoryId || assignment.taskId !== head.taskId ||
          assignment.agentRoute.requiredRole !== head.requiredRole || assignment.agentRoute.agentId !== head.agentId ||
          assignment.agentRoute.sessionConfig?.model !== head.selectedModel ||
          assignment.source.modelBinding.canonicalProviderId !== head.canonicalProviderId ||
          assignment.source.modelBinding.canonicalModelId !== head.canonicalModelId ||
          assignment.source.turn.invocationId !== head.turn.invocationId ||
          assignment.source.turn.dispatchGeneration !== head.turn.dispatchGeneration) throw conflict();
    }
    validateAssignmentStreamRecords(this.records);
    this.indexedRevision = this.log.revision;
    return this.records;
  }
}
function equal(a: unknown, b: unknown): boolean { return a !== undefined && b !== undefined && jcsDigest(a as never) === jcsDigest(b as never); }
function sameHarnessHead(
  left: z.infer<typeof HarnessSessionHeadSchema>,
  right: z.infer<typeof HarnessSessionHeadSchema>,
): boolean {
  const stable = (value: z.infer<typeof HarnessSessionHeadSchema>) => ({
    executionSessionId: value.executionSessionId, instanceId: value.instanceId,
    workspaceId: value.workspaceId, taskId: value.taskId, repositoryId: value.repositoryId,
    requiredRole: value.requiredRole, agentId: value.agentId, selectedModel: value.selectedModel,
    canonicalProviderId: value.canonicalProviderId, canonicalModelId: value.canonicalModelId,
  });
  return equal(stable(left), stable(right));
}
function bytes(value: LocalAdmissionStart): number { return Buffer.byteLength(canonicalize(value as JsonValue), "utf8"); }
function conflict(): RemoteInstanceError { return new RemoteInstanceError("recovery_required", "Local execution history cannot prove this admission or absence.", { diagnostic: "local_execution_unprovable" }); }

function logicalSessionId(assignment: RemoteWorkAssignment): string | undefined {
  return assignment.source.kind === "conversation"
    ? assignment.source.sessionId
    : assignment.source.kind === "harness_delivery"
      ? assignment.source.executionSessionId
      : undefined;
}

function sameLiveSession(predecessor: RemoteWorkAssignment, successor: RemoteWorkAssignment, acpSessionRef: string): boolean {
  if (predecessor.instanceId !== successor.instanceId || predecessor.workspaceId !== successor.workspaceId ||
      predecessor.agentRoute.agentId !== successor.agentRoute.agentId ||
      predecessor.agentRoute.requiredRole !== successor.agentRoute.requiredRole ||
      predecessor.agentRoute.sessionConfig?.model !== successor.agentRoute.sessionConfig?.model) return false;
  if (predecessor.source.kind === "conversation" && successor.source.kind === "conversation") {
    return predecessor.source.sessionId === successor.source.sessionId && successor.source.acpSessionRef === acpSessionRef;
  }
  if (predecessor.source.kind !== "harness_delivery" || successor.source.kind !== "harness_delivery") return false;
  if (predecessor.source.executionSessionId !== successor.source.executionSessionId ||
      predecessor.source.ownerInstanceId !== successor.source.ownerInstanceId ||
      predecessor.source.repositoryId !== successor.source.repositoryId ||
      !equal(predecessor.source.modelBinding, successor.source.modelBinding) ||
      predecessor.taskId !== successor.taskId) return false;
  const before = predecessor.source.turn, after = successor.source.turn;
  return Boolean(after.predecessor) && equal(after.predecessor, {
    invocationId: before.invocationId,
    dispatchGeneration: before.dispatchGeneration,
  }) && (before.invocationId !== after.invocationId || before.dispatchGeneration !== after.dispatchGeneration);
}
