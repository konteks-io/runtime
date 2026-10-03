import { z } from "zod";
import { AssignmentRequestReferenceSchema, RemoteInstanceError, RemoteWorkAssignmentSchema, allEqual, canonicalize, jcsDigest, type AssignmentRequestReference, type JsonValue, type RemoteWorkAssignment, type RetainedProcessOwner } from "@konteks/remote-common";
import { LocalAdmissionSchema, type LocalAdmission } from "./local-admission.js";
import { AssignmentAllocationRecordSchema, AssignmentOperationRecordSchema, AssignmentReplyRecordSchema, AssignmentStreamRecordSchema, assignmentOperationKey, assignmentReplyKey, assignmentRequestKey, assignmentStreamKey, initialAssignmentStream, validateAssignmentStreamRecords, type AssignmentReplyRecordValue } from "./assignment-stream.js";
import type { McpLocalTransportIdentity } from "../mcp/capability-facade.js";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const SeedSchema = z.object({ enrollmentId: id, activationId: id, keyDigest: digest, createdAt: z.string().datetime(), assignmentStreamVersion: z.literal(1).optional() }).strict();
const BindingSchema = SeedSchema.extend({ instanceId: id, workspaceId: id, exchangeNonce: id }).strict();
const scope = { instanceId: id, workspaceId: id };
const AdmissionSchema = LocalAdmissionSchema;
const RetainedProcessOwnerSchema = z.object({ version: z.literal(1), platform: z.enum(["darwin", "linux", "win32"]), pid: z.number().int().positive(), processGroupId: z.number().int().positive(), startToken: id, commandDigest: digest }).strict();
const McpLocalTransportIdentitySchema = z.object({ port: z.number().int().min(1).max(65535), credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const LegacyCodexAdmissionSchema = z.object({ reference: id, ownerGeneration: id }).strict();
const LiveContinuationTransferSchema = z.object({ predecessor: AdmissionSchema, successor: AdmissionSchema,
  sessionId: id, acpSessionRef: id, processOwner: RetainedProcessOwnerSchema, continuedAt: z.string().datetime() }).strict();

function objectish(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** A delivery source saved before delivery assignments carried their repository, model binding and turn. */
function retiredDeliverySource(source: Record<string, unknown>): boolean {
  return source.kind === "harness_delivery" &&
    !(typeof source.repositoryId === "string" && objectish(source.modelBinding) && objectish(source.turn));
}

/** The retained claim with a sentinel identity no new Core-issued turn can ever match. */
function retiredDeliveryAssignment(assignment: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const assignmentId = typeof assignment.id === "string" ? assignment.id : "unknown";
  const invocationId = typeof assignment.correlationId === "string" ? assignment.correlationId : `pre-d162-${assignmentId}`;
  const route = objectish(assignment.agentRoute);
  const model = objectish(route?.sessionConfig)?.model;
  const selectedModel = typeof model === "string" ? String(model) : "pre-d162-unrecoverable";
  return {
    ...assignment,
    agentRoute: route ? { ...route, requiredRole: "generator" } : assignment.agentRoute,
    source: {
      ...source,
      repositoryId: `https://pre-d162.invalid/retired/${encodeURIComponent(assignmentId)}`,
      modelBinding: { canonicalProviderId: "pre-d162", canonicalModelId: selectedModel },
      turn: { invocationId, dispatchGeneration: 0 },
    },
  };
}

/** Delivery assignments carry immutable repository/model/turn identity.
 * Older retained claims must remain readable long enough to drain, but their
 * synthetic sentinel identity can never match a new Core-issued turn and is
 * therefore never continuation or execution authority. */
const JournalRemoteWorkAssignmentSchema = z.preprocess((candidate) => {
  const assignment = objectish(candidate);
  const source = objectish(assignment?.source);
  if (!assignment || !source || !retiredDeliverySource(source)) return candidate;
  return retiredDeliveryAssignment(assignment, source);
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
type LocalAdmissionStart = z.infer<typeof StartSchema>;
const CancellationSchema = z.object({ ...scope, runnerIncarnation: id, manifestId: id, assignmentId: id, attempt: AdmissionSchema.shape.attempt, decisionDigest: digest, cancelledAt: z.string().datetime() }).strict();
const ExecutionFieldsSchema = z.object({ schemaVersion: z.literal(1), admission: AdmissionSchema, openedAt: z.string().datetime(), acpSessionRef: id.nullable(), referenceFence: id.nullable(), processOwner: RetainedProcessOwnerSchema.optional(), mcpLocalTransport: McpLocalTransportIdentitySchema.optional(), legacyCodexAdmission: LegacyCodexAdmissionSchema.optional(), phase: z.enum(["opened", "stopping", "process_stopped", "acp_settled", "continued", "interrupted_unqualified"]), stoppingAt: z.string().datetime().nullable(), processStoppedAt: z.string().datetime().optional(), interruptedAt: z.string().datetime().optional(), acpSettledAt: z.string().datetime().nullable(), completedTurnSettledAt: z.string().datetime().optional(), continuedFromGeneration: id.optional(), restoredFromGeneration: id.optional(), restoreAcpSessionRef: id.optional(), continuedToGeneration: id.optional(), continuedAt: z.string().datetime().optional(), lifecycleProfileDigest: z.null(), executionProfileDigest: z.null() }).strict();
type ExecutionFields = z.infer<typeof ExecutionFieldsSchema>;

/** Every field a continued execution must hold, and nothing of a live one. */
function continuedComplete(value: ExecutionFields): boolean {
  return value.acpSessionRef !== null && value.referenceFence === null && Boolean(value.processOwner) && Boolean(value.completedTurnSettledAt) &&
    Boolean(value.continuedToGeneration) && Boolean(value.continuedAt) && value.stoppingAt === null && value.acpSettledAt === null;
}

/** Each way an execution record's phase and fields can disagree. */
const EXECUTION_INCONSISTENCIES: ReadonlyArray<(value: ExecutionFields) => boolean> = [
  value => value.acpSessionRef === null && value.referenceFence !== null,
  value => value.acpSessionRef !== null && value.referenceFence === null && value.phase !== "continued",
  value => value.referenceFence !== null && value.referenceFence !== value.admission.executionGeneration,
  value => value.completedTurnSettledAt !== undefined && value.acpSessionRef === null,
  value => value.phase === "opened" && (value.stoppingAt !== null || value.acpSettledAt !== null),
  value => value.phase !== "opened" && value.phase !== "continued" && value.stoppingAt === null,
  value => value.phase === "stopping" && (value.processStoppedAt !== undefined || value.acpSettledAt !== null),
  // A retained process may be proven gone after its ACP session already settled;
  // the settled instant stays on the record rather than being erased.
  value => value.phase === "process_stopped" && value.processStoppedAt === undefined,
  value => value.phase === "acp_settled" && (value.acpSessionRef === null || value.acpSettledAt === null),
  value => value.phase === "interrupted_unqualified" && (value.processStoppedAt === undefined || value.interruptedAt === undefined),
  value => value.interruptedAt !== undefined && value.phase !== "interrupted_unqualified",
  value => value.phase === "continued" && !continuedComplete(value),
  value => value.phase !== "continued" && (value.continuedToGeneration !== undefined || value.continuedAt !== undefined),
  value => value.continuedFromGeneration !== undefined && (!value.processOwner || value.acpSessionRef === null || value.restoredFromGeneration !== undefined),
  value => (value.restoredFromGeneration === undefined) !== (value.restoreAcpSessionRef === undefined),
  // Restore provenance is permanent, like `continuedFromGeneration`: a
  // restored turn completes, is continued, stopped or settled like any
  // other. Limiting it to `opened` made every later transition of a
  // restored role session throw, so its next review never started and
  // the idle reaper could never release it.
  value => value.restoredFromGeneration !== undefined && (value.continuedFromGeneration !== undefined || value.restoreAcpSessionRef === value.acpSessionRef),
];

const ExecutionSchema = ExecutionFieldsSchema.superRefine((value, context) => {
  if (EXECUTION_INCONSISTENCIES.some(inconsistent => inconsistent(value))) context.addIssue({ code: "custom", message: "Inconsistent local execution phase" });
});
const HarnessSessionHeadSchema = z.object({
  executionSessionId: id, instanceId: id, workspaceId: id, taskId: id,
  repositoryId: z.string().url().max(4096), requiredRole: id, agentId: id,
  selectedModel: z.string().min(1).max(256), canonicalProviderId: z.string().min(1).max(256),
  canonicalModelId: z.string().min(1).max(256), executionGeneration: id,
  turn: z.object({ invocationId: id, dispatchGeneration: z.number().int().nonnegative().safe() }).strict(),
  completedAt: z.string().datetime(),
}).strict();
type LocalExecutionState = z.infer<typeof ExecutionSchema>;
type LocalAbsenceCancellation = z.infer<typeof CancellationSchema>;
interface LiveContinuationCandidate {
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
type RecordOf<K extends LocalExecutionRecord["kind"]> = Extract<LocalExecutionRecord, { kind: K }>;

/** The log key each record kind is stored under. */
const RECORD_KEYS: { [K in LocalExecutionRecord["kind"]]: (record: RecordOf<K>) => string } = {
  enrollment_seed: () => "enrollment",
  enrollment_bound: () => "enrollment",
  assignment_stream: () => assignmentStreamKey(),
  assignment_request: record => assignmentRequestKey(record.value.frame.seq),
  assignment_reply: record => assignmentReplyKey(record.value.response.sequence),
  assignment_operation: record => assignmentOperationKey(record.value.operationId),
  execution: record => JSON.stringify([record.kind, record.value.admission.executionGeneration]),
  harness_session_head: record => JSON.stringify([record.kind, record.value.executionSessionId]),
  admission_start: record => JSON.stringify(["admission", record.value.admission.assignmentId, record.value.admission.attempt]),
  admission: record => JSON.stringify([record.kind, record.value.assignmentId, record.value.attempt]),
  absence_cancelled: record => JSON.stringify([record.kind, record.value.manifestId, record.value.assignmentId, record.value.attempt]),
};

export function localExecutionKey(record: LocalExecutionRecord): string {
  return (RECORD_KEYS[record.kind] as (record: LocalExecutionRecord) => string)(record);
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
      await this.log.batch(() => this.streamEnrollment(value));
      return;
    }
    await this.log.update("enrollment", existing => {
      if (existing?.kind === "enrollment_bound" && equal(existing.value, value)) return existing;
      if (existing?.kind !== "enrollment_seed" || !equal(existing.value, seedOf(value)) || this.index().some(row => row.kind === "admission" || row.kind === "admission_start" || row.kind === "absence_cancelled")) throw conflict();
      return { kind: "enrollment_bound", value };
    });
  }

  /** Binding a stream-versioned enrollment creates its assignment stream in the same batch; a repeat finds that stream. */
  private streamEnrollment(value: z.infer<typeof BindingSchema>): LocalExecutionRecord[] {
    const records = this.index();
    const existing = records.find(record => record.kind === "enrollment_seed" || record.kind === "enrollment_bound");
    if (existing?.kind === "enrollment_bound" && equal(existing.value, value)) return withStreamHead(records, existing);
    if (existing?.kind !== "enrollment_seed" || !equal(existing.value, seedOf(value)) || records.length !== 1) throw conflict();
    return [{ kind: "enrollment_bound", value }, { kind: "assignment_stream", value: initialAssignmentStream({ instanceId: value.instanceId, workspaceId: value.workspaceId, enrollmentId: value.enrollmentId }) }];
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
    this.assertEffectStep(admission, previous.claimEffect, effect);
    const value = StartSchema.parse({ ...previous, claimEffect: effect });
    this.requireStartBytes(value, previous);
    return { kind: "admission_start", value };
  }

  /** A claim effect starts pending (before any execution) and only moves pending → applying → applied, for one reply. */
  private assertEffectStep(admission: LocalAdmission, before: LocalAdmissionStart["claimEffect"], effect: NonNullable<LocalAdmissionStart["claimEffect"]>): void {
    if (!before) {
      if (effect.state !== "pending" || this.execution(admission)) throw conflict();
      return;
    }
    if (!equal(before.response, effect.response) || !claimEffectAdvance(before, effect)) throw conflict();
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

  /** The local transport is reusable only for this exact retained provider session. */
  mcpLocalTransportForReference(ref: string, sessionId: string, agentId: string): McpLocalTransportIdentity | undefined {
    this.index();
    const generation = this.references.get(ref);
    const state = generation && this.executions.get(generation);
    if (!state || !this.transportReusable(state, sessionId, agentId)) return undefined;
    return state.mcpLocalTransport ? structuredClone(state.mcpLocalTransport) : undefined;
  }

  /** An opened execution whose turn completed, in this logical session and for this agent. */
  private transportReusable(state: LocalExecutionState, sessionId: string, agentId: string): boolean {
    const start = this.start(state.admission.assignmentId, state.admission.attempt);
    return state.phase === "opened" && Boolean(state.completedTurnSettledAt) && start !== undefined &&
      logicalSessionId(start.assignment) === sessionId && state.admission.agentId === agentId;
  }

  /** Only a prior admitted load on this exact app-server generation can race a retry. */
  legacyCodexLoadPreviouslyAdmitted(ref: string, ownerGeneration: string, exceptGeneration: string): boolean {
    this.index();
    for (const [generation, execution] of this.executions) {
      if (generation === exceptGeneration || execution.admission.agentId !== "codex") continue;
      if (execution.legacyCodexAdmission?.reference === ref && execution.legacyCodexAdmission.ownerGeneration === ownerGeneration) return true;
    }
    return false;
  }

  async bindLegacyCodexAdmission(admission: LocalAdmission, reference: string, ownerGeneration: string, assertCurrent: () => void): Promise<void> {
    const marker = LegacyCodexAdmissionSchema.parse({ reference, ownerGeneration });
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || existing.phase !== "opened") throw conflict();
      if (existing.legacyCodexAdmission && !equal(existing.legacyCodexAdmission, marker)) throw conflict();
      return existing.legacyCodexAdmission ? existing : { ...existing, legacyCodexAdmission: marker };
    });
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
    if (!continuesHead(head, successor.source.turn.predecessor)) return undefined;
    const state = this.continuableHeadExecution(head);
    const predecessor = this.start(state.admission.assignmentId, state.admission.attempt)?.assignment;
    if (!predecessor || !sameLiveSession(predecessor, successor, state.acpSessionRef)) throw conflict();
    return structuredClone({ admission: state.admission, acpSessionRef: state.acpSessionRef, processOwner: state.processOwner });
  }

  /** The head's execution: opened, its turn completed, with its ACP session and retained process. */
  private continuableHeadExecution(head: HarnessHead): LocalExecutionState & { acpSessionRef: string; processOwner: RetainedProcessOwner } {
    const state = this.executions.get(head.executionGeneration);
    if (!state || state.phase !== "opened" || !state.completedTurnSettledAt || !state.acpSessionRef || !state.processOwner) throw conflict();
    return state as LocalExecutionState & { acpSessionRef: string; processOwner: RetainedProcessOwner };
  }

  /** Current durable owner of a repository-role session head. Read-only: this
   * does not make the head continuable and grants no execution authority. */
  harnessRoleHead(successorAssignment: RemoteWorkAssignment): LocalAdmission | undefined {
    const successor = RemoteWorkAssignmentSchema.parse(successorAssignment);
    if (successor.source.kind !== "harness_delivery") return undefined;
    this.index();
    const head = this.harnessHeads.get(successor.source.executionSessionId);
    const state = head && this.executions.get(head.executionGeneration);
    return state ? structuredClone(state.admission) : undefined;
  }

  /** The execution that last took over a repository-role session head's ACP
   * session, following its live or restored continuation chain. Undefined
   * when the head was never continued. Read-only; grants nothing.
   */
  headContinuationTip(successorAssignment: RemoteWorkAssignment): LocalAdmission | undefined {
    const successor = RemoteWorkAssignmentSchema.parse(successorAssignment);
    if (successor.source.kind !== "harness_delivery") return undefined;
    this.index();
    const head = this.harnessHeads.get(successor.source.executionSessionId);
    if (!head) return undefined;
    const state = this.continuationTip(head.executionGeneration);
    if (!state || state.admission.executionGeneration === head.executionGeneration) return undefined;
    return structuredClone(state.admission);
  }

  /** Follows continued executions from `generation` to the last one (never around a cycle). */
  private continuationTip(generation: string): LocalExecutionState | undefined {
    let state = this.executions.get(generation);
    const seen = new Set<string>();
    while (state?.phase === "continued" && state.continuedToGeneration && !seen.has(state.continuedToGeneration)) {
      seen.add(state.continuedToGeneration);
      state = this.executions.get(state.continuedToGeneration);
    }
    return state;
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
    this.assertRestoredFrom(state.restoredFromGeneration, admission, successor, state.restoreAcpSessionRef);
    return state.restoreAcpSessionRef;
  }

  /** The restore's predecessor was continued into exactly this admission, for the same live session. */
  private assertRestoredFrom(generation: string, admission: LocalAdmission, successor: RemoteWorkAssignment, restoreAcpSessionRef: string): void {
    const predecessor = this.executions.get(generation);
    const predecessorAssignment = predecessor && this.start(predecessor.admission.assignmentId, predecessor.admission.attempt)?.assignment;
    if (!predecessor || !predecessorAssignment || predecessor.phase !== "continued" ||
        predecessor.continuedToGeneration !== admission.executionGeneration ||
        !sameLiveSession(predecessorAssignment, successor, restoreAcpSessionRef)) throw conflict();
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
    const effect = start.claimEffect;
    if (effect?.state !== "applying") throw conflict();
    const row = this.index().find(value => value.kind === "assignment_reply" && value.value.response.sequence === effect.response.sequence);
    if (row?.kind !== "assignment_reply" || !("frame" in row.value) || !claimReplyMatches(row.value, start.allocation, effect.response)) throw conflict();
    assertClaimed(row.value.frame.body.body, start.admission);
  }

  async bindReference(admission: LocalAdmission, ref: string, assertCurrent: () => void): Promise<void> {
    id.parse(ref);
    await this.transition(admission, assertCurrent, existing => {
      this.index();
      if (!existing || existing.phase !== "opened" || existing.acpSessionRef !== null || this.references.has(ref)) throw conflict();
      return { ...existing, acpSessionRef: ref, referenceFence: admission.executionGeneration };
    });
  }

  async bindMcpLocalTransport(admission: LocalAdmission, candidate: McpLocalTransportIdentity, assertCurrent: () => void): Promise<void> {
    const identity = McpLocalTransportIdentitySchema.parse(candidate);
    await this.transition(admission, assertCurrent, existing => {
      if (!existing || existing.phase !== "opened") throw conflict();
      if (existing.mcpLocalTransport && !equal(existing.mcpLocalTransport, identity)) throw conflict();
      return existing.mcpLocalTransport ? existing : { ...existing, mcpLocalTransport: identity };
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
      // An interrupted execution is past settlement; it never goes back.
      return existing.phase === "acp_settled" || existing.phase === "interrupted_unqualified" ? existing : { ...existing, phase: "acp_settled", acpSettledAt: at };
    });
  }

  async markProcessStopped(admission: LocalAdmission, at: string, assertCurrent: () => void): Promise<void> {
    await this.transition(admission, assertCurrent, existing => {
      // `acp_settled` is a predecessor's live recovery that settled the ACP turn but
      // could not certify quiescence. After restart only the retained process can
      // still be proven gone; refusing it here left startup recovery wedged forever.
      // `interrupted_unqualified` already proved it gone: a later recovery (Core's
      // cancel after a restart) finds it there, and refusing that kept the
      // computer offline for good.
      if (!existing || !PROCESS_STOPPABLE.has(existing.phase) || !existing.processOwner) throw conflict();
      return PROCESS_STOPPED.has(existing.phase) ? existing : { ...existing, phase: "process_stopped", processStoppedAt: at };
    });
  }

  /**
   * The exact execution process is proven gone (leader and process group), so
   * the attempt cannot continue and recovery states that instead of blocking
   * startup forever. This is NOT execution quiescence and never says the agent's
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
      const existing = this.settleableExecution(admission, ref);
      const assignment = this.start(admission.assignmentId, admission.attempt)?.assignment;
      const settled = ExecutionSchema.parse(existing.completedTurnSettledAt !== undefined
        ? existing : { ...existing, completedTurnSettledAt: at });
      if (!harnessAssignment(assignment)) return [{ kind: "execution", value: settled }];
      return this.settledWithHead(admission, assignment, settled, at);
    });
    assertCurrent();
  }

  /** The opened execution that owns `ref`. */
  private settleableExecution(admission: LocalAdmission, ref: string): LocalExecutionState {
    const existing = this.execution(admission);
    if (!existing || existing.phase !== "opened" || existing.acpSessionRef !== ref ||
        this.references.get(ref) !== admission.executionGeneration) throw conflict();
    return existing;
  }

  /** A completed repository-role turn also advances its session head, one turn at a time. */
  private settledWithHead(admission: LocalAdmission, assignment: HarnessAssignment, settled: LocalExecutionState, at: string): LocalExecutionRecord[] {
    const source = assignment.source;
    const prior = this.harnessHeads.get(source.executionSessionId);
    const head = harnessHeadOf(assignment, admission, at);
    if (prior && !sameHarnessHead(prior, head)) throw conflict();
    if (prior && equal(prior.turn, head.turn)) {
      if (prior.executionGeneration !== admission.executionGeneration) throw conflict();
      return [{ kind: "execution", value: settled }];
    }
    assertHeadAdvance(prior, source.turn.predecessor);
    return [{ kind: "execution", value: settled }, { kind: "harness_session_head", value: head }];
  }

  /** Atomically hand one still-live, idle ACP owner to the next admitted turn.
   * This is neither load/resume after restart nor execution quiescence: both
   * generations must belong to the same live incarnation, conversation and
   * agent, and the exact process owner remains retained by the successor.
   */
  async transferLiveContinuation(candidate: unknown, assertCurrent: () => void): Promise<void> {
    const value = LiveContinuationTransferSchema.parse(candidate);
    await this.log.batch(() => {
      this.assertTransfer(value, assertCurrent, true);
      const before = this.execution(value.predecessor), after = this.execution(value.successor);
      if (before?.phase === "continued" && after) {
        if (!liveTransferRecorded(before, after, value)) throw conflict();
        return [{ kind: "execution", value: before }, { kind: "execution", value: after }];
      }
      const settled = this.continuablePredecessor(before, after, value);
      this.requireCapacity();
      return [{ kind: "execution", value: continuedPredecessor(settled, value) }, { kind: "execution", value: liveSuccessor(settled, value) }];
    });
    assertCurrent();
  }

  /** Fence a completed owner from a prior connector incarnation and reserve a
   * successor that will load the persisted provider session under a fresh
   * local reference. No old process ownership is transferred or inferred.
   */
  async transferRestoredContinuation(candidate: unknown, assertCurrent: () => void): Promise<void> {
    const value = LiveContinuationTransferSchema.parse(candidate);
    await this.log.batch(() => {
      this.assertTransfer(value, assertCurrent, false);
      const before = this.execution(value.predecessor), after = this.execution(value.successor);
      if (before?.phase === "continued" && after) {
        if (!restoredTransferRecorded(before, after, value)) throw conflict();
        return [{ kind: "execution", value: before }, { kind: "execution", value: after }];
      }
      const settled = this.continuablePredecessor(before, after, value);
      this.requireCapacity();
      return [{ kind: "execution", value: continuedPredecessor(settled, value) }, { kind: "execution", value: restoredSuccessor(settled, value) }];
    });
    assertCurrent();
  }

  /**
   * Both admissions are current and distinct turns of the same instance,
   * workspace and agent (the same incarnation for a live handoff, another for
   * a restore), in the same logical session.
   */
  private assertTransfer(value: LiveContinuationTransfer, assertCurrent: () => void, sameIncarnation: boolean): void {
    const { predecessor, successor } = value;
    assertCurrent(); this.assertAdmission(predecessor); this.assertAdmission(successor);
    if (predecessor.executionGeneration === successor.executionGeneration || predecessor.assignmentId === successor.assignmentId ||
        !allEqual([[predecessor.instanceId, successor.instanceId], [predecessor.workspaceId, successor.workspaceId], [predecessor.agentId, successor.agentId]]) ||
        (predecessor.runnerIncarnation === successor.runnerIncarnation) !== sameIncarnation) throw conflict();
    this.assertTransferStarts(value);
  }

  /**
   * The predecessor's own requested reference is deliberately NOT compared:
   * a turn admitted with a stale reference (its predecessor was not live
   * here) legitimately opened a FRESH session, and the reference it actually
   * opened, asserted on its execution record, is the one a successor
   * continues. Comparing the request made every turn after a fresh-session
   * fallback unprovable.
   */
  private assertTransferStarts(value: LiveContinuationTransfer): void {
    const predecessorStart = this.start(value.predecessor.assignmentId, value.predecessor.attempt);
    const successorStart = this.start(value.successor.assignmentId, value.successor.attempt);
    if (!predecessorStart || !successorStart || !transferStartsMatch(predecessorStart, successorStart, value)) throw conflict();
    if (successorStart.delivery === "allocated") this.assertChosenClaimEffect(successorStart);
  }

  /** The predecessor is opened, completed and still owns the session reference, and the handoff is not before it. */
  private continuablePredecessor(before: LocalExecutionState | undefined, after: LocalExecutionState | undefined, value: LiveContinuationTransfer): SettledExecution {
    this.index();
    if (!before || after || !continuableBefore(before, value) || this.references.get(value.acpSessionRef) !== value.predecessor.executionGeneration) throw conflict();
    if (Date.parse(value.continuedAt) < Math.max(Date.parse(before.openedAt), Date.parse(before.completedTurnSettledAt), Date.parse(value.successor.openedAt))) throw conflict();
    return before;
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
    for (const record of this.records) this.indexRecord(record);
    this.assertUniqueGenerations();
    for (const state of this.executions.values()) this.assertExecutionLinks(state);
    for (const head of this.harnessHeads.values()) this.assertHarnessHead(head);
    validateAssignmentStreamRecords(this.records);
    this.indexedRevision = this.log.revision;
    return this.records;
  }

  private indexRecord(record: LocalExecutionRecord): void {
    if ("instanceId" in record.value) this.scopes.add(JSON.stringify([record.value.instanceId, record.value.workspaceId]));
    switch (record.kind) {
      case "admission":
        this.admissions.set(JSON.stringify([record.value.assignmentId, record.value.attempt]), record.value);
        return;
      case "admission_start":
        return this.indexStart(record.value);
      case "execution":
        return this.indexExecution(record.value);
      case "harness_session_head":
        if (this.harnessHeads.has(record.value.executionSessionId)) throw conflict();
        this.harnessHeads.set(record.value.executionSessionId, record.value);
        return;
      case "absence_cancelled":
        this.cancelled.add(JSON.stringify([record.value.assignmentId, record.value.attempt]));
        this.tombstones.set(JSON.stringify([record.value.manifestId, record.value.assignmentId, record.value.attempt]), record.value);
        return;
      default:
    }
  }

  private indexStart(start: LocalAdmissionStart): void {
    const { admission } = start;
    const key = JSON.stringify([admission.assignmentId, admission.attempt]);
    this.scopes.add(JSON.stringify([admission.instanceId, admission.workspaceId]));
    this.admissions.set(key, admission); this.starts.set(key, start);
    const size = bytes(start); this.startBytes += size;
    if (size > this.byteLimits.startBytes || this.startBytes > this.byteLimits.totalStartBytes) throw conflict();
  }

  /** An execution, and the session reference it holds (each reference by at most one execution). */
  private indexExecution(state: LocalExecutionState): void {
    this.executions.set(state.admission.executionGeneration, state);
    if (state.referenceFence === null) return;
    if (state.acpSessionRef === null) throw conflict();
    if (this.references.has(state.acpSessionRef)) throw conflict();
    this.references.set(state.acpSessionRef, state.admission.executionGeneration);
  }

  private assertUniqueGenerations(): void {
    const generations = new Set<string>();
    for (const admission of this.admissions.values()) {
      if (generations.has(admission.executionGeneration)) throw conflict();
      generations.add(admission.executionGeneration);
    }
  }

  /** An execution matches its admission, follows its start, and its continuation links agree in both directions. */
  private assertExecutionLinks(state: LocalExecutionState): void {
    const key = JSON.stringify([state.admission.assignmentId, state.admission.attempt]);
    if (!equal(this.admissions.get(key), state.admission)) throw conflict();
    const start = this.starts.get(key);
    if (start && start.delivery !== "allocation_reserved" && start.delivery !== "allocated") throw conflict();
    if (state.continuedToGeneration) this.assertContinuedTo(state, state.continuedToGeneration);
    if (state.continuedFromGeneration) this.assertContinuedFrom(state, state.continuedFromGeneration);
    if (state.restoredFromGeneration) this.assertRestoredLink(state, state.restoredFromGeneration);
  }

  private assertContinuedTo(state: LocalExecutionState, generation: string): void {
    const successor = this.executions.get(generation);
    if (!successor || (!liveSuccessorOf(successor, state) && !restoredSuccessorOf(successor, state))) throw conflict();
  }

  private assertContinuedFrom(state: LocalExecutionState, generation: string): void {
    const predecessor = this.executions.get(generation);
    if (!predecessor || predecessor.continuedToGeneration !== state.admission.executionGeneration || predecessor.acpSessionRef !== state.acpSessionRef ||
        !equal(predecessor.processOwner, state.processOwner)) throw conflict();
  }

  private assertRestoredLink(state: LocalExecutionState, generation: string): void {
    const predecessor = this.executions.get(generation);
    if (!predecessor || predecessor.continuedToGeneration !== state.admission.executionGeneration ||
        predecessor.acpSessionRef !== state.restoreAcpSessionRef) throw conflict();
  }

  /** A session head names a completed execution whose delivery assignment it describes exactly. */
  private assertHarnessHead(head: HarnessHead): void {
    const state = this.executions.get(head.executionGeneration);
    // `index()` is already constructing the maps. Calling the public
    // accessor here would recursively re-enter `index()` until stack
    // exhaustion on every retained Harness head.
    const assignment = state && this.starts.get(JSON.stringify([
      state.admission.assignmentId, state.admission.attempt,
    ]))?.assignment;
    if (!state?.completedTurnSettledAt || !harnessAssignment(assignment) || !headDescribes(head, assignment)) throw conflict();
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
  return assignment.source.kind === "conversation" || assignment.source.kind === "direct_session"
    ? assignment.source.sessionId
    : assignment.source.kind === "harness_delivery"
      ? assignment.source.executionSessionId
      : undefined;
}

function sameLiveSession(predecessor: RemoteWorkAssignment, successor: RemoteWorkAssignment, acpSessionRef: string): boolean {
  if (!sameRoute(predecessor, successor)) return false;
  const chat = sameChatSession(predecessor.source, successor.source, acpSessionRef);
  if (chat !== null) return chat;
  return sameHarnessSuccession(predecessor, successor);
}

/** Same instance, workspace, agent, role and model. */
function sameRoute(predecessor: RemoteWorkAssignment, successor: RemoteWorkAssignment): boolean {
  return allEqual([
    [predecessor.instanceId, successor.instanceId], [predecessor.workspaceId, successor.workspaceId],
    [predecessor.agentRoute.agentId, successor.agentRoute.agentId], [predecessor.agentRoute.requiredRole, successor.agentRoute.requiredRole],
    [predecessor.agentRoute.sessionConfig?.model, successor.agentRoute.sessionConfig?.model],
  ]);
}

/** A conversation's or a direct session's next prompt; null for any other pair of sources. */
function sameChatSession(before: RemoteWorkAssignment["source"], after: RemoteWorkAssignment["source"], acpSessionRef: string): boolean | null {
  if (before.kind === "conversation" && after.kind === "conversation") return before.sessionId === after.sessionId && after.acpSessionRef === acpSessionRef;
  // A direct session's next prompt: the same session on the same computer.
  if (before.kind === "direct_session" && after.kind === "direct_session") {
    return before.sessionId === after.sessionId && before.ownerInstanceId === after.ownerInstanceId && after.acpSessionRef === acpSessionRef;
  }
  return null;
}

/** The next turn of the same repository-role session, task and model binding. */
function sameHarnessSuccession(predecessor: RemoteWorkAssignment, successor: RemoteWorkAssignment): boolean {
  const before = predecessor.source, after = successor.source;
  if (before.kind !== "harness_delivery" || after.kind !== "harness_delivery") return false;
  if (!allEqual([[before.executionSessionId, after.executionSessionId], [before.ownerInstanceId, after.ownerInstanceId],
    [before.repositoryId, after.repositoryId], [predecessor.taskId, successor.taskId]]) || !equal(before.modelBinding, after.modelBinding)) return false;
  return nextTurn(before.turn, after.turn);
}

function nextTurn(before: HarnessTurn, after: HarnessTurn): boolean {
  return Boolean(after.predecessor) && equal(after.predecessor, {
    invocationId: before.invocationId,
    dispatchGeneration: before.dispatchGeneration,
  }) && (before.invocationId !== after.invocationId || before.dispatchGeneration !== after.dispatchGeneration);
}

type HarnessHead = z.infer<typeof HarnessSessionHeadSchema>;
type HarnessSource = Extract<RemoteWorkAssignment["source"], { kind: "harness_delivery" }>;
type HarnessAssignment = RemoteWorkAssignment & { source: HarnessSource };
type HarnessTurn = HarnessSource["turn"];
type LiveContinuationTransfer = z.infer<typeof LiveContinuationTransferSchema>;
type SettledExecution = LocalExecutionState & { completedTurnSettledAt: string };

/** Phases a retained process can be proven gone from, and those where it already is. */
const PROCESS_STOPPABLE: ReadonlySet<LocalExecutionState["phase"]> = new Set(["stopping", "acp_settled", "process_stopped", "interrupted_unqualified"]);
const PROCESS_STOPPED: ReadonlySet<LocalExecutionState["phase"]> = new Set(["process_stopped", "interrupted_unqualified"]);

/** A repeated stream-versioned binding still has its assignment stream. */
function withStreamHead(records: LocalExecutionRecord[], existing: LocalExecutionRecord): LocalExecutionRecord[] {
  if (!validateAssignmentStreamRecords(records).head) throw conflict();
  return [existing];
}

function seedOf(binding: z.infer<typeof BindingSchema>): z.infer<typeof SeedSchema> {
  const { instanceId: _instance, workspaceId: _workspace, exchangeNonce: _nonce, ...seed } = binding;
  return seed;
}

function claimEffectAdvance(before: NonNullable<LocalAdmissionStart["claimEffect"]>, effect: NonNullable<LocalAdmissionStart["claimEffect"]>): boolean {
  return (before.state === "pending" && effect.state === "applying") || (before.state === "applying" && effect.state === "applied") || equal(before, effect);
}

function harnessAssignment(assignment: RemoteWorkAssignment | undefined): assignment is HarnessAssignment {
  return assignment?.source.kind === "harness_delivery";
}

/** No head: only a first turn (no predecessor). A head: the successor names its turn as predecessor. */
function continuesHead(head: HarnessHead | undefined, predecessor: HarnessTurn["predecessor"]): head is HarnessHead {
  if (!head) {
    if (predecessor) throw conflict();
    return false;
  }
  if (!predecessor || !equal(head.turn, predecessor)) throw conflict();
  return true;
}

/** A new turn after a head names that head's turn; a first turn names none. */
function assertHeadAdvance(prior: HarnessHead | undefined, predecessor: HarnessTurn["predecessor"]): void {
  if (prior) {
    if (!predecessor || !equal(predecessor, prior.turn)) throw conflict();
  } else if (predecessor) throw conflict();
}

function harnessHeadOf(assignment: HarnessAssignment, admission: LocalAdmission, at: string): HarnessHead {
  const source = assignment.source;
  return HarnessSessionHeadSchema.parse({
    executionSessionId: source.executionSessionId, instanceId: assignment.instanceId,
    workspaceId: assignment.workspaceId, taskId: assignment.taskId, repositoryId: source.repositoryId,
    requiredRole: assignment.agentRoute.requiredRole, agentId: assignment.agentRoute.agentId,
    selectedModel: assignment.agentRoute.sessionConfig?.model,
    canonicalProviderId: source.modelBinding.canonicalProviderId,
    canonicalModelId: source.modelBinding.canonicalModelId,
    executionGeneration: admission.executionGeneration,
    turn: { invocationId: source.turn.invocationId, dispatchGeneration: source.turn.dispatchGeneration }, completedAt: at,
  });
}

/** The head records this assignment's session, role, model and turn. */
function headDescribes(head: HarnessHead, assignment: HarnessAssignment): boolean {
  const source = assignment.source;
  return allEqual([
    [source.executionSessionId, head.executionSessionId], [source.repositoryId, head.repositoryId], [assignment.taskId, head.taskId],
    [assignment.agentRoute.requiredRole, head.requiredRole], [assignment.agentRoute.agentId, head.agentId],
    [assignment.agentRoute.sessionConfig?.model, head.selectedModel], [source.modelBinding.canonicalProviderId, head.canonicalProviderId],
    [source.modelBinding.canonicalModelId, head.canonicalModelId], [source.turn.invocationId, head.turn.invocationId],
    [source.turn.dispatchGeneration, head.turn.dispatchGeneration],
  ]);
}

function liveSuccessorOf(successor: LocalExecutionState, state: LocalExecutionState): boolean {
  return successor.continuedFromGeneration === state.admission.executionGeneration && successor.acpSessionRef === state.acpSessionRef &&
    equal(successor.processOwner, state.processOwner);
}

function restoredSuccessorOf(successor: LocalExecutionState, state: LocalExecutionState): boolean {
  return successor.restoredFromGeneration === state.admission.executionGeneration && successor.restoreAcpSessionRef === state.acpSessionRef;
}

/** The claim reply the effect chose: this allocation's claim request, with this exact response. */
function claimReplyMatches(reply: AssignmentReplyRecordValue, allocation: LocalAdmissionStart["allocation"], response: NonNullable<LocalAdmissionStart["claimEffect"]>["response"]): boolean {
  return reply.frame.body.requestKind === "claim" && equal(reply.request, allocation) && equal(reply.response, response);
}

/** Core claimed (or had already claimed) exactly this admission's claim. */
function assertClaimed(verdict: AssignmentReplyRecordValue["frame"]["body"]["body"], admission: LocalAdmission): void {
  if ("kind" in verdict || !("outcome" in verdict) || (verdict.outcome !== "claimed" && verdict.outcome !== "already_claimed") ||
    !allEqual([[verdict.assignmentId, admission.assignmentId], [verdict.attempt, admission.attempt], [verdict.claimId, admission.claimId]])) throw conflict();
}

/** Both starts are of the transfer's logical session and agents, and the successor reserved or allocated its claim. */
function transferStartsMatch(predecessorStart: LocalAdmissionStart, successorStart: LocalAdmissionStart, value: LiveContinuationTransfer): boolean {
  return logicalSessionId(predecessorStart.assignment) === value.sessionId && logicalSessionId(successorStart.assignment) === value.sessionId &&
    sameLiveSession(predecessorStart.assignment, successorStart.assignment, value.acpSessionRef) &&
    allEqual([[predecessorStart.assignment.agentRoute.agentId, value.predecessor.agentId], [successorStart.assignment.agentRoute.agentId, value.successor.agentId]]) &&
    (successorStart.delivery === "allocation_reserved" || successorStart.delivery === "allocated");
}

/** An opened predecessor that completed its turn, still fenced to this session reference and its retained process. */
function continuableBefore(before: LocalExecutionState, value: LiveContinuationTransfer): before is SettledExecution {
  return before.phase === "opened" && allEqual([[before.acpSessionRef, value.acpSessionRef], [before.referenceFence, value.predecessor.executionGeneration]]) &&
    before.completedTurnSettledAt !== undefined && equal(before.processOwner, value.processOwner);
}

/** A replayed live handoff: both records already say exactly this transfer happened. */
function liveTransferRecorded(before: LocalExecutionState, after: LocalExecutionState, value: LiveContinuationTransfer): boolean {
  return allEqual([
    [before.acpSessionRef, value.acpSessionRef], [before.continuedToGeneration, value.successor.executionGeneration], [before.continuedAt, value.continuedAt],
    [after.acpSessionRef, value.acpSessionRef], [after.referenceFence, value.successor.executionGeneration], [after.continuedFromGeneration, value.predecessor.executionGeneration],
  ]) && equal(before.processOwner, value.processOwner) && equal(after.processOwner, value.processOwner);
}

/** A replayed restore: the successor waits to load the predecessor's session under a fresh reference. */
function restoredTransferRecorded(before: LocalExecutionState, after: LocalExecutionState, value: LiveContinuationTransfer): boolean {
  return allEqual([
    [before.acpSessionRef, value.acpSessionRef], [before.continuedToGeneration, value.successor.executionGeneration], [before.continuedAt, value.continuedAt],
    [after.restoredFromGeneration, value.predecessor.executionGeneration], [after.restoreAcpSessionRef, value.acpSessionRef],
    [after.acpSessionRef, null], [after.referenceFence, null],
  ]) && equal(before.processOwner, value.processOwner);
}

function continuedPredecessor(before: SettledExecution, value: LiveContinuationTransfer): LocalExecutionState {
  return ExecutionSchema.parse({ ...before, phase: "continued", referenceFence: null,
    continuedToGeneration: value.successor.executionGeneration, continuedAt: value.continuedAt });
}

/** The successor takes over the live session and its retained process. */
function liveSuccessor(before: SettledExecution, value: LiveContinuationTransfer): LocalExecutionState {
  return ExecutionSchema.parse({ schemaVersion: 1, admission: value.successor, openedAt: value.continuedAt,
    acpSessionRef: value.acpSessionRef, referenceFence: value.successor.executionGeneration, processOwner: value.processOwner, phase: "opened", stoppingAt: null,
    acpSettledAt: null, continuedFromGeneration: value.predecessor.executionGeneration,
    ...(before.mcpLocalTransport ? { mcpLocalTransport: before.mcpLocalTransport } : {}),
    lifecycleProfileDigest: null, executionProfileDigest: null });
}

/** The successor will load the predecessor's provider session under a fresh local reference. */
function restoredSuccessor(before: SettledExecution, value: LiveContinuationTransfer): LocalExecutionState {
  return ExecutionSchema.parse({ schemaVersion: 1, admission: value.successor, openedAt: value.continuedAt,
    acpSessionRef: null, referenceFence: null, phase: "opened", stoppingAt: null, acpSettledAt: null,
    restoredFromGeneration: value.predecessor.executionGeneration, restoreAcpSessionRef: value.acpSessionRef,
    ...(before.mcpLocalTransport ? { mcpLocalTransport: before.mcpLocalTransport } : {}),
    lifecycleProfileDigest: null, executionProfileDigest: null });
}
