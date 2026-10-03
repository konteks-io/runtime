import { randomUUID } from "node:crypto";
import {
  RemoteInstanceError,
  allEqual,
  type RemoteAuthorizedOperation,
  type RemoteExecutionOperationPermitClaims,
  ClaimResultSchema,
  RemoteWorkAssignmentSchema,
  ReportAckSchema,
  WorkAvailableSchema,
  CancelDirectiveSchema,
  createLogger,
  createRuntimeAdmissionObservabilityContext,
  computeRemoteRecoveryEvidenceDigest,
  jcsDigest,
  computeRemoteReconciliationManifestDigest,
  parseRfc3339,
  type AgentTurnUsageObservation,
  type AssignmentClaim,
  type AssignmentRequestReference,
  type CancelDirective,
  type ClaimResult,
  type Clock,
  type ConnectedAgentView,
  type JsonValue,
  type Logger,
  type RemoteWorkAssignment,
  type RemoteWorkKind,
  type RemoteInstanceReconciliationManifest,
  type RemoteReconciliationConnection,
  type RemoteRecoveryEvidence,
  type RemoteDeliveryAcceptanceReceipt,
  type RecoveryDecision,
} from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import type { LeaseState } from "../lease/lease.js";
import { placedAgentReady, type RoleBinding, type RoleCapabilityInputs } from "../inventory/roles.js";
import { recoveryEvidenceRecordKey, type SupervisorJournal, type JournalEntry, type RecoveryEvidenceRecord } from "../state/journal.js";
import type { LocalAdmission } from "../state/local-admission.js";
import type { RuntimeRecoveryRecord } from "../state/runtime-recovery.js";
import type { RetainedProcessOwner } from "@konteks/remote-common";
import type { DurableOutbox } from "../state/outbox.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";
import type { RunnerPort } from "../runner-port.js";
import { RelayedSession, type RelayedSessionDeps, type SessionClosedReason } from "../session/relayed-session.js";
import type { PendingHumanRequest } from "../session/permissions.js";
import { intersectEvidencePolicy } from "./evidence.js";
import { ReportSender } from "./report-sender.js";
import type { AssignmentSender } from "./assignment-sender.js";
import { coreChannelId } from "../relay/channel-ids.js";
import { isSearchAssignment, type SearchControllerBoundary } from "./search-assignment-carrier.js";
import { isOnboardWorkAssignment, onboardTerminalResult, type OnboardWorkAssignment, type OnboardWorkCarrier } from "../onboard/carrier.js";
import { continuedSession, logicalSessionId } from "./continued-session.js";
import { integrationTerminalResult, isIntegrationWorkAssignment, type IntegrationWorkAssignment, type IntegrationWorkCarrier } from "../integration/carrier.js";

/**
 * Pull → claim → dispatch → report. Core owns admission and placement; the
 * supervisor validates every assignment locally, claims exactly the agent
 * Core placed, intersects evidence policy most-restrictively, and
 * refuses the closed list of unacceptable work. It never runs peer election
 * or a global balancer.
 */
type ClaimRejection =
  | "unknown_kind"
  | "stale_attempt"
  | "workspace_mismatch"
  | "instance_mismatch"
  | "checkout_owned_elsewhere"
  | "role_not_advertised"
  | "agent_unavailable"
  | "expired"
  | "draining"
  | "lease_invalid"
  | "reconciliation_pending"
  | "no_headroom";

interface OrchestratorDeps {
  clock: Clock;
  journal: SupervisorJournal;
  outbox: DurableOutbox;
  transport: TransportManager;
  assignmentSender?: AssignmentSender;
  /** Independently verify signed Core cancellation; missing trust denies ingress. */
  verifyCancellation?: (directive: CancelDirective) => boolean;
  lease: LeaseState;
  instanceId: () => string;
  runnerIncarnation?: () => string;
  assertOwned?: () => void;
  workspaceId: () => string | null;
  agents: () => ConnectedAgentView[];
  roleBindings: () => RoleBinding[];
  advertisedRoles: () => string[];
  /**
   * Non-agent facts a role depends on (the machine's git). Optional: omitted,
   * no such fact is known, so a role that needs one is refused rather than
   * claimed.
   */
  roleCapabilityInputs?: () => RoleCapabilityInputs;
  acceptedKinds: () => RemoteWorkKind[];
  instanceEvidencePolicy: () => "structured_only" | "selected_artifacts";
  draining: () => boolean;
  reconciliationComplete: () => boolean;
  /** Exact accepted recovery identity; native continuation capture fails closed when omitted. */
  recoveryAuthority?: () => string | null;
  /** Native delivery requires current receipt authority; omission fails closed. */
  reportDeliveryAllowed?: () => boolean;
  /** Private Core boundary for recovery evidence; submission cannot select a terminal winner. */
  recoveryEvidence?: {
    submit(input: { evidence: RemoteRecoveryEvidence; connection: RemoteReconciliationConnection }): Promise<{ outcome: "accepted" | "duplicate"; acceptedAt: string }>;
  };
  /** Machine-proof transport topology, never embedded in the immutable evidence. */
  recoveryEvidenceConnection?: () => RemoteReconciliationConnection;
  /** A former owner retains bytes but must not submit them as a current runtime. */
  canSubmitRecoveryEvidence?: () => boolean;
  /** Recover an already-frozen delivery result before restart recovery can
   * classify the now-gone bridge process as interrupted. The callback must
   * prove the exact admission, retained execution and candidate itself. */
  recoverPendingDeliveryOutput?: (admission: LocalAdmission, execution: {
    acpSessionRef: string | null;
    processOwner: import("@konteks/remote-common").RetainedProcessOwner | undefined;
  }) => Promise<{ acpSessionRef: string; receipt: RemoteDeliveryAcceptanceReceipt } | null>;
  headroom: () => number;
  maxPullItems: number;
  runners: Map<string, RunnerPort>;
  sessionDeps: (assignment: RemoteWorkAssignment, runner: RunnerPort) => Omit<RelayedSessionDeps, "onClosed" | "onUsage">;
  /** Shared-owner status check for an old Codex reference lacking a transport descriptor. */
  inspectLegacyCodexThread?: (reference: string) => Promise<{ unloaded: boolean; ownerGeneration: string }>;
  onUsage: (observation: AgentTurnUsageObservation) => Promise<void>;
  searchController?: SearchControllerBoundary;
  /** Present on a runtime tagged `onboard`; absent, both kinds are refused. */
  onboardCarrier?: Pick<OnboardWorkCarrier, "execute">;
  /** Present when this connector runs integration tasks; absent, `integration` work is refused. */
  integrationCarrier?: IntegrationWorkCarrier;
  /** An idle completed session was released and no other session holds its channel (its preview may go). */
  onSessionReleased?: (sessionId: string) => void;
  logger?: Logger;
}

export class WorkOrchestrator {
  readonly reports: ReportSender;
  private readonly sessions = new Map<string, RelayedSession>();
  private readonly channelOwners = new Map<string, RelayedSession>();
  private readonly pendingClaims = new Map<string, RemoteWorkAssignment>();
  private readonly pendingClaimFences = new Map<string, () => void>();
  private readonly admissionSetups = new Map<string, Promise<void>>();
  private readonly dispatching = new Map<string, Promise<void>>();
  /** Long bridge/materialization work after the durable execution-open handoff. */
  private readonly bootstrapping = new Map<string, Promise<void>>();
  private readonly legacyCodexClaims = new Map<string, string>();
  /** Once a legacy load is admitted, its result may be uncertain even if bootstrap fails. */
  private readonly legacyCodexConsumed = new Set<string>();
  private readonly recoveryStops = new Map<string, Promise<void>>();
  /** Executions whose authority was lost and that are not settled yet, retried until they are. */
  private readonly lostAuthority = new Map<string, LostAuthoritySettlement>();
  /** Single-flight retirements of unfinished executions, by execution generation. */
  private readonly executionRetirements = new Map<string, Promise<boolean>>();
  private readonly recoveryFences = new Set<string>();
  private recoveryEvidenceRetry: Promise<void> | null = null;
  private recoveryEvidenceRetryRequested = false;
  private readonly logger: Logger;
  private pullTask: Promise<void> | null = null;
  readonly counters: Record<ClaimRejection, number> = { unknown_kind: 0, stale_attempt: 0, workspace_mismatch: 0, instance_mismatch: 0, checkout_owned_elsewhere: 0, role_not_advertised: 0, agent_unavailable: 0, expired: 0, draining: 0, lease_invalid: 0, reconciliation_pending: 0, no_headroom: 0 };

  constructor(private readonly deps: OrchestratorDeps) {
    this.logger = deps.logger ?? createLogger({ name: "work" });
    this.reports = new ReportSender({
      journal: deps.journal,
      outbox: deps.outbox,
      transport: deps.transport,
      ...(deps.assignmentSender ? { assignmentSender: deps.assignmentSender } : {}),
      clock: deps.clock,
      instanceId: () => deps.instanceId(),
      canSend: () => deps.reportDeliveryAllowed?.() === true,
      onConflict: async (assignmentId, attempt) => this.abandon(assignmentId, attempt, "assignment_conflict"),
      onTerminalDurable: async (assignmentId, attempt) => this.finish(assignmentId, attempt),
      confirmStopped: async (assignmentId, attempt) => this.confirmSessionStopped(assignmentId, attempt),
    });
  }

  activeAssignmentIds(): string[] {
    return this.deps.journal.activeAssignments().map((entry) => entry.assignmentId);
  }

  activeCount(): number {
    return this.deps.journal.activeAssignments().length;
  }

  /** Logical session ids with an open (not yet closed) session on this machine. */
  liveSessionIds(): Set<string> {
    const live = new Set<string>();
    for (const session of this.sessions.values()) {
      const channelId = session.channelId;
      if (!session.isClosed && channelId?.startsWith("session:")) live.add(channelId.slice("session:".length));
    }
    return live;
  }

  /** Resolve existing original ownership; absent maps never establish authority. */
  capturePendingClaimAuthority(admission: LocalAdmission): () => void {
    const key = `${admission.assignmentId}:${admission.attempt}`;
    const original = this.pendingClaimFences.get(key);
    const retained = this.retainedClaim(key, admission);
    if (!original || !retained || !this.claimMatchesAdmission(retained, admission)) {
      this.fenceLostAuthority(key);
      throw new RemoteInstanceError("recovery_required", "Retained claim has no matching original local owner.");
    }
    const assertOriginal = () => {
      original(); this.requireNativeOwner(); this.deps.journal.execution.assertAdmission(admission);
      if (this.recoveryFences.has(key) || !this.inOwnScope(admission)) throw new RemoteInstanceError("recovery_required", "Claim owner scope changed or its execution was fenced.");
    };
    assertOriginal(); return assertOriginal;
  }

  /** The pending claim's assignment, start and row, while none of them is missing or fenced. */
  private retainedClaim(key: string, admission: LocalAdmission): RetainedClaim | null {
    const assignment = this.pendingClaims.get(key);
    const start = this.deps.journal.execution.start(admission.assignmentId, admission.attempt);
    const current = this.deps.journal.assignments.get(key);
    if (!assignment || !start || !current || this.recoveryFences.has(key)) return null;
    return { assignment, start, current };
  }

  /** The admission is the one this process started, for the pending assignment, and its row is still the initial claimed one. */
  private claimMatchesAdmission({ assignment, start, current }: RetainedClaim, admission: LocalAdmission): boolean {
    return jcsDigest(start.admission) === jcsDigest(admission) && admission.runnerIncarnation === this.deps.runnerIncarnation?.() &&
      allEqual([[assignment.instanceId, admission.instanceId], [assignment.workspaceId, admission.workspaceId], [assignment.agentRoute.agentId, admission.agentId]]) &&
      jcsDigest(current as JsonValue) === jcsDigest(this.journalEntry(assignment, admission.claimId, "claimed", start.projectionCreatedAt, start.evidenceUpload) as JsonValue);
  }

  /** The admission belongs to this instance, workspace and runner incarnation. */
  private inOwnScope(admission: LocalAdmission): boolean {
    return admission.instanceId === this.deps.instanceId() && admission.workspaceId === this.deps.workspaceId() && admission.runnerIncarnation === this.deps.runnerIncarnation?.();
  }

  /** The pull gate: active lease, not draining, reconciliation done, headroom. */
  canPull(): ClaimRejection | null {
    if (!this.deps.reconciliationComplete()) return "reconciliation_pending";
    if (!this.deps.lease.canPullNewWork()) return "lease_invalid";
    if (this.deps.draining()) return "draining";
    if (this.deps.headroom() <= 0) return "no_headroom";
    return null;
  }

  pull(): void {
    // A lost terminal ACK must heal on the ordinary maintenance cadence, even
    // while draining or at capacity. It is not a global admission lock: Core
    // orders successors within their lineage, while unrelated work continues.
    void this.reports.retryDue().catch(error => this.logger.warn({ err: error }, "durable assignment report retry failed"));
    void this.reports.healHaltedConflicts().catch(error => this.logger.warn({ err: error }, "halted claim healing failed"));
    void this.retryRecoveryEvidence().catch(error => this.logger.warn({ err: error }, "durable recovery evidence retry failed"));
    this.retryLostAuthoritySettlements();
    // Existing timer also services retained stream intents during drain/capacity
    // loss. Replaying a request does not authorize admission of returned work.
    if (this.deps.assignmentSender) {
      try { this.deps.assignmentSender.scheduleRetained(message => this.deps.transport.send(message)); }
      catch (error) { this.logger.warn({ err: error }, "retained assignment operations require recovery"); return; }
    }
    const gate = this.canPull();
    if (gate !== null) {
      this.counters[gate] += 1;
      return;
    }
    const body = { instanceId: this.deps.instanceId(), maxItems: Math.min(this.deps.maxPullItems, this.deps.headroom()), acceptedKinds: this.deps.acceptedKinds() };
    if (!this.deps.assignmentSender) {
      this.deps.transport.send({ channel: "assignment", channelId: coreChannelId("assignment", this.deps.instanceId()), body });
      return;
    }
    if (this.pullTask) return;
    const sender = this.deps.assignmentSender;
    const task = (async () => {
      const assertCurrent = new RecoveryAuthority(this.deps.recoveryAuthority).capture("assignment");
      await sender.preparePull(body);
      assertCurrent();
      if (this.canPull() !== null) return;
      sender.scheduleRetained(message => { assertCurrent(); this.deps.transport.send(message); });
    })();
    this.pullTask = task;
    void task.catch(error => this.logger.warn({ err: error }, "prepared pull requires retry or recovery"))
      .finally(() => { if (this.pullTask === task) this.pullTask = null; });
  }

  /** Local validation of an assignment Core returned; the closed refusal list of cp2.md §8. */
  validate(assignment: RemoteWorkAssignment): ClaimRejection | null {
    const gate = this.canPull();
    if (gate !== null) return gate;
    for (const [refused, rejection] of this.claimChecks) if (refused(assignment)) return rejection;
    return null;
  }

  /** The closed refusal list, in the order the first applicable reason is reported. */
  private readonly claimChecks: ReadonlyArray<readonly [(assignment: RemoteWorkAssignment) => boolean, ClaimRejection]> = [
    [assignment => isSearchAssignment(assignment) && !this.deps.searchController, "unknown_kind"],
    // A runtime without the onboard lane composed cannot serve either onboard
    // work kind, whatever Core placed. Refusing here is the same answer as
    // never having advertised the role.
    [assignment => isOnboardWorkAssignment(assignment) && !this.deps.onboardCarrier, "unknown_kind"],
    [assignment => assignment.kind === "integration" && (!this.deps.integrationCarrier || !isIntegrationWorkAssignment(assignment)), "unknown_kind"],
    [assignment => this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`), "stale_attempt"],
    [assignment => this.deps.journal.execution.isCancelled(assignment.id, assignment.attempt), "stale_attempt"],
    [assignment => !this.deps.acceptedKinds().includes(assignment.kind), "unknown_kind"],
    [assignment => assignment.instanceId !== this.deps.instanceId(), "instance_mismatch"],
    [assignment => assignment.workspaceId !== this.deps.workspaceId(), "workspace_mismatch"],
    [assignment => this.staleAttempt(assignment), "stale_attempt"],
    [assignment => parseRfc3339(assignment.expiresAt) <= this.deps.clock.coreNow(), "expired"],
    [assignment => assignment.source.kind === "harness_task_checkout" && assignment.source.ownerInstanceId !== this.deps.instanceId(), "checkout_owned_elsewhere"],
    [assignment => !this.deps.advertisedRoles().includes(assignment.agentRoute.requiredRole), "role_not_advertised"],
    [assignment => !placedAgentReady(this.deps.agents(), assignment.agentRoute.agentId, assignment.agentRoute.requiredRole, this.roleCapabilityInputs()), "agent_unavailable"],
  ];

  /** A later attempt exists, or this attempt is already live here. */
  private staleAttempt(assignment: RemoteWorkAssignment): boolean {
    const latest = this.deps.journal.latestAttempt(assignment.id);
    if (!latest) return false;
    if (latest.attempt > assignment.attempt) return true;
    return latest.attempt === assignment.attempt && latest.state !== "recovery_required" && latest.state !== "cancelled";
  }

  private roleCapabilityInputs(): RoleCapabilityInputs {
    return this.deps.roleCapabilityInputs?.() ?? {};
  }

  /** Inbound `assignment` channel bodies: work available, claim results, report acks, cancel directives. */
  async onAssignmentMessage(body: unknown, reference?: AssignmentRequestReference): Promise<void> {
    if (!reference) {
      const directive = CancelDirectiveSchema.safeParse(body);
      if (directive.success) return this.onCancel(directive.data);
      if (this.deps.assignmentSender) throw new RemoteInstanceError("assignment_channel_invalid", "D143 domain replies require their retained operation reference.");
    } else if (await this.settledByRetainedReply(body, reference)) return;
    return this.routeDomainReply(body, reference);
  }

  /**
   * A reply to a retained operation must be exactly the durable reply. A
   * claim refused (or claimed by another canonical claim) and a refused pull
   * end here; true when the reply needs nothing more.
   */
  private async settledByRetainedReply(body: unknown, reference: AssignmentRequestReference): Promise<boolean> {
    const workspaceId = this.deps.workspaceId();
    const receipt = workspaceId ? this.deps.journal.assignmentStream.replyForRequest({ instanceId: this.deps.instanceId(), workspaceId }, reference) : undefined;
    if (!receipt || jcsDigest(receipt.frame.body.body as JsonValue) !== jcsDigest(body as JsonValue)) throw new RemoteInstanceError("recovery_required", "Domain reply differs from its retained operation.");
    if (receipt.frame.body.requestKind === "claim" && this.nonDispatchingClaim(receipt.frame.body.body, reference, workspaceId!)) {
      await this.onClaimNonDispatch(reference);
      return true;
    }
    if (receipt.frame.body.requestKind === "pull" && "kind" in receipt.frame.body.body) {
      refusedPull(receipt.frame.body.body, this.logger);
      return true;
    }
    return false;
  }

  /** A refusal, or an `already_claimed` naming another canonical claim than this admission's. */
  private nonDispatchingClaim(verdict: object, reference: AssignmentRequestReference, workspaceId: string): boolean {
    if ("kind" in verdict) return true;
    const request = this.deps.journal.assignmentStream.request({ instanceId: this.deps.instanceId(), workspaceId }, reference.requestSequence);
    const claim = verdict as { outcome?: unknown; claimId?: unknown };
    return claim.outcome === "already_claimed" && claim.claimId !== request?.admission?.claimId;
  }

  private async routeDomainReply(body: unknown, reference: AssignmentRequestReference | undefined): Promise<void> {
    const work = WorkAvailableSchema.safeParse(body);
    if (work.success) return this.onWorkAvailable(work.data.assignments);
    const claim = ClaimResultSchema.safeParse(body);
    if (claim.success) return this.onClaimResult(claim.data, reference);
    const ack = ReportAckSchema.safeParse(body);
    if (ack.success) return this.reports.onAck(ack.data, reference);
    const cancel = CancelDirectiveSchema.safeParse(body);
    if (cancel.success) return this.onCancel(cancel.data);
    this.logger.warn("dropped an assignment-channel body that matches no schema");
  }

  private async onWorkAvailable(assignments: unknown[]): Promise<void> {
    for (const raw of assignments) await this.admitOffered(raw);
  }

  private async admitOffered(raw: unknown): Promise<void> {
    const parsed = RemoteWorkAssignmentSchema.safeParse(raw);
    if (!parsed.success) {
      this.counters.unknown_kind += 1;
      return;
    }
    const assignment = parsed.data;
    if (isSearchAssignment(assignment) && !this.deps.searchController) {
      throw new RemoteInstanceError("recovery_required", "Search assignment arrived without its dedicated controller boundary.");
    }
    const retained = this.deps.journal.execution.start(assignment.id, assignment.attempt);
    // Repair is never transport or execution authority.
    if (retained) return this.repairRetained(assignment, retained.assignment);
    const rejection = this.validate(assignment);
    if (rejection !== null) {
      this.counters[rejection] += 1;
      this.logger.info({ assignmentId: assignment.id, rejection }, "assignment not claimed");
      return;
    }
    if (this.pendingClaims.has(`${assignment.id}:${assignment.attempt}`)) return;
    await this.admitClaim(assignment);
  }

  private async repairRetained(assignment: RemoteWorkAssignment, retained: RemoteWorkAssignment): Promise<void> {
    if (jcsDigest(withoutDisplayLabel(retained) as JsonValue) !== jcsDigest(withoutDisplayLabel(assignment) as JsonValue)) throw new RemoteInstanceError("recovery_required", "Retained admission assignment changed.");
    await this.reconstructAdmissionProjections(assignment.id, assignment.attempt);
  }

  /** Durably admit and claim an offered assignment under the authority captured now. */
  private async admitClaim(assignment: RemoteWorkAssignment): Promise<void> {
    const claim: AssignmentClaim = { assignmentId: assignment.id, attempt: assignment.attempt, claimId: randomUUID(), agentId: assignment.agentRoute.agentId };
    const assertAuthority = this.captureNativeAuthority(assignment.id, assignment.attempt);
    const incarnation = this.deps.runnerIncarnation?.();
    const assertCurrent = () => {
      assertAuthority();
      this.requireNativeOwner();
      if (incarnation !== this.deps.runnerIncarnation?.() || assignment.instanceId !== this.deps.instanceId() || assignment.workspaceId !== this.deps.workspaceId() || this.canPull() !== null || this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`)) throw new RemoteInstanceError("recovery_required", "Claim admission authority changed.");
    };
    await this.serializeAdmissionSetup(`${assignment.id}:${assignment.attempt}`, () => this.persistClaim({ assignment, claim, incarnation, assertAuthority, assertCurrent }));
  }

  private async persistClaim({ assignment, claim, incarnation, assertAuthority, assertCurrent }: ClaimAdmission): Promise<void> {
    assertCurrent();
    await this.deps.journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1,
      admission: { instanceId: assignment.instanceId, workspaceId: assignment.workspaceId, runnerIncarnation: incarnation, assignmentId: assignment.id, attempt: assignment.attempt, claimId: claim.claimId, agentId: claim.agentId, executionGeneration: randomUUID(), openedAt: this.deps.clock.nowIso() },
      assignment, evidenceUpload: intersectEvidencePolicy(this.deps.instanceEvidencePolicy(), assignment.policy.evidenceUpload), projectionCreatedAt: this.deps.clock.nowIso(), claimCreatedAt: this.deps.clock.nowIso(),
    }, assertCurrent);
    assertCurrent();
    await this.reconstructAdmissionProjectionsOwned(assignment.id, assignment.attempt, assertCurrent);
    assertCurrent();
    const start = this.deps.journal.execution.start(assignment.id, assignment.attempt)!;
    this.logAdmission(start.admission);
    const initial = this.journalEntry(assignment, claim.claimId, "claimed", start.projectionCreatedAt, start.evidenceUpload);
    const assertPrepared = () => {
      assertCurrent();
      if (!this.initialClaimProjected(assignment, claim, initial, start.claimCreatedAt)) throw new RemoteInstanceError("recovery_required", "Claim projections no longer prove initial prepared admission.");
    };
    if (this.deps.assignmentSender) await this.deps.assignmentSender.prepareClaim(start.admission, assertPrepared);
    else await this.deps.journal.execution.reserveAllocation(start.admission, assertPrepared);
    this.pendingClaims.set(`${assignment.id}:${assignment.attempt}`, assignment);
    this.pendingClaimFences.set(`${assignment.id}:${assignment.attempt}`, assertAuthority);
    assertPrepared();
    if (this.deps.assignmentSender) this.deps.assignmentSender.scheduleRetained(message => { assertAuthority(); this.deps.transport.send(message); });
    else this.deps.transport.send({ channel: "assignment", channelId: coreChannelId("assignment", this.deps.instanceId()), body: claim });
  }

  private logAdmission(admission: LocalAdmission): void {
    const observability = createRuntimeAdmissionObservabilityContext({
      runtimeIncarnationId: admission.runnerIncarnation,
      assignmentId: admission.assignmentId,
      attempt: admission.attempt,
      claimId: admission.claimId,
      executionId: admission.executionGeneration,
    });
    this.logger.info({ event: "runtime.admission.durable", observability }, "native claim admission persisted");
  }

  /** The assignment row is still the initial claimed one and the claim is queued exactly as admitted. */
  private initialClaimProjected(assignment: RemoteWorkAssignment, claim: AssignmentClaim, initial: JournalEntry, claimCreatedAt: string): boolean {
    const current = this.deps.journal.assignments.get(`${assignment.id}:${assignment.attempt}`);
    const queued = this.deps.outbox.all("assignment").find(item => item.id === claim.claimId);
    return current !== undefined && jcsDigest(current as JsonValue) === jcsDigest(initial as JsonValue) && queued !== undefined &&
      allEqual([[queued.key, `claim:${assignment.id}:${assignment.attempt}`], [queued.createdAt, claimCreatedAt]]) && jcsDigest(queued.body as JsonValue) === jcsDigest(claim as JsonValue);
  }

  /** Rebuild only provably missing projections; this never enrolls a pending callback or sends work. */
  async reconstructAdmissionProjections(assignmentId: string, attempt: number): Promise<void> {
    await this.serializeAdmissionSetup(`${assignmentId}:${attempt}`, () => this.reconstructAdmissionProjectionsOwned(assignmentId, attempt));
  }

  /** All production repair/reservation entries use this per-admission lane, never held across network waits. */
  private serializeAdmissionSetup(key: string, operation: () => Promise<void>): Promise<void> {
    const result = (this.admissionSetups.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.admissionSetups.set(key, settled);
    void settled.then(() => { if (this.admissionSetups.get(key) === settled) this.admissionSetups.delete(key); });
    return result;
  }

  private async reconstructAdmissionProjectionsOwned(assignmentId: string, attempt: number, assertContinuation: () => void = () => undefined): Promise<void> {
    const start = this.deps.journal.execution.start(assignmentId, attempt);
    if (!start) throw new RemoteInstanceError("recovery_required", "No complete admission-start projection source.");
    const check = this.projectionRepairCheck(start, assertContinuation);
    check();
    const key = `${assignmentId}:${attempt}`;
    const initial = this.journalEntry(start.assignment, start.admission.claimId, "claimed", start.projectionCreatedAt, start.evidenceUpload);
    const existing = this.deps.journal.assignments.get(key);
    if (existing) verifyProjection(existing, initial);
    if (!existing && start.delivery === "allocation_reserved") throw new RemoteInstanceError("recovery_required", "Reserved admission has unknown assignment projection history.");
    await this.repairClaimOutbox(start, existing, initial, check);
    await this.deps.journal.assignments.update(key, current => {
      check();
      if (current) { verifyProjection(current, initial); return current; }
      if (start.delivery !== "unallocated") throw new RemoteInstanceError("recovery_required", "Unknown reserved assignment history.");
      return initial;
    });
    check();
  }

  /** Repair ownership: the same runner incarnation and scope, the admission current and its start unchanged. */
  private projectionRepairCheck(start: AdmissionStart, assertContinuation: () => void): () => void {
    const incarnation = this.deps.runnerIncarnation?.();
    const { assignmentId, attempt } = start.admission;
    return () => {
      assertContinuation();
      this.requireNativeOwner();
      if (incarnation !== this.deps.runnerIncarnation?.() || start.admission.instanceId !== this.deps.instanceId() || start.admission.workspaceId !== this.deps.workspaceId()) throw new RemoteInstanceError("recovery_required", "Projection repair ownership changed.");
      this.deps.journal.execution.assertAdmission(start.admission);
      const current = this.deps.journal.execution.start(assignmentId, attempt);
      if (!current || jcsDigest(current as JsonValue) !== jcsDigest(start as JsonValue)) throw new RemoteInstanceError("recovery_required", "Complete admission changed during projection repair.");
    };
  }

  /** The admitted claim's outbox item: verified when present, queued again only for an unallocated, still-initial admission. */
  private async repairClaimOutbox(start: AdmissionStart, existing: JournalEntry | undefined, initial: JournalEntry, check: () => void): Promise<void> {
    const { assignmentId, attempt, claimId, agentId } = start.admission;
    const key = `${assignmentId}:${attempt}`;
    const claim: AssignmentClaim = { assignmentId, attempt, claimId, agentId };
    const expected = { id: claimId, channel: "assignment" as const, key: `claim:${key}`, group: `claim:${key}`, order: 0, body: claim, createdAt: start.claimCreatedAt };
    const priorItems = this.deps.outbox.all().filter(item => item.key === expected.key || item.id === expected.id);
    for (const item of priorItems) verifyClaimOutbox(item, expected);
    const initialOnly = !existing || jcsDigest(existing as JsonValue) === jcsDigest(initial as JsonValue);
    if (!priorItems.length && start.delivery === "unallocated" && initialOnly) {
      verifyClaimOutbox(await this.deps.outbox.enqueue(expected), expected);
      check();
    }
  }

  private journalEntry(assignment: RemoteWorkAssignment, claimId: string, state: JournalEntry["state"], createdAt = this.deps.clock.nowIso(), evidenceUpload = intersectEvidencePolicy(this.deps.instanceEvidencePolicy(), assignment.policy.evidenceUpload)): JournalEntry {
    return {
      assignmentId: assignment.id,
      attempt: assignment.attempt,
      claimId,
      kind: assignment.kind,
      placementId: assignment.placementId,
      workspaceId: assignment.workspaceId,
      agentId: assignment.agentRoute.agentId,
      state,
      claimedAt: createdAt,
      recoveryEpoch: 0,
      reports: { nextSequence: 1, durableWatermark: 0 },
      evidenceUpload,
      expiresAt: assignment.expiresAt,
      latestResumeAt: assignment.policy.latestResumeAt,
      updatedAt: createdAt,
    };
  }

  private async onClaimResult(result: ClaimResult, reference?: AssignmentRequestReference): Promise<void> {
    const key = `${result.assignmentId}:${result.attempt}`;
    const pending = this.pendingClaimFor(key, result);
    if (!pending) return;
    const { assignment, assertAuthority } = pending;
    assertAuthority();
    this.requireNativeOwner();
    if (!this.claimResultAdmitted(result, assignment, reference)) return this.unhandledClaim(key);
    // Retire only the correlated claim, not all items sharing its assignment key.
    await this.deps.outbox.ack(result.claimId);
    assertAuthority();
    const entry = this.stillPendingEntry(key, result, assignment);
    if (!entry) return this.unhandledClaim(key);
    if (!claimableState(entry)) {
      this.unhandledClaim(key);
      this.retirePending(key);
      return;
    }
    return this.applyClaimOutcome({ key, result, assignment, entry, assertAuthority });
  }

  /**
   * A claim effect needs an exact current pending admission owner. Without a
   * retained sender a stray result is just ignored; with one it fences the
   * claim for recovery.
   */
  private unhandledClaim(key: string): void {
    if (!this.deps.assignmentSender) return;
    this.fenceLostAuthority(key);
    throw new RemoteInstanceError("recovery_required", "Claim effect has no exact current pending admission owner.");
  }

  /** The pending claim this result answers, with its original fence; null when the result is not this process's to apply. */
  private pendingClaimFor(key: string, result: ClaimResult): { assignment: RemoteWorkAssignment; assertAuthority: () => void } | null {
    if (this.deps.journal.execution.isCancelled(result.assignmentId, result.attempt) || this.recoveryFences.has(key)) return this.unhandledClaimNull(key);
    const assignment = this.pendingClaims.get(key);
    const entry = this.deps.journal.assignments.get(key);
    if (!assignment || !entry || entry.claimId !== result.claimId) {
      if (result.outcome === "claimed") this.logger.warn({ assignmentId: result.assignmentId }, "claim result for an unknown pending claim");
      return this.unhandledClaimNull(key);
    }
    const assertAuthority = this.pendingClaimFences.get(key);
    if (!assertAuthority) { this.fenceLostAuthority(key); throw new RemoteInstanceError("recovery_required", "Pending claim has no original accepted generation."); }
    return { assignment, assertAuthority };
  }

  private unhandledClaimNull(key: string): null {
    this.unhandledClaim(key);
    return null;
  }

  /** The result names this process's current admission of the pending assignment, and its start allows the claim effect. */
  private claimResultAdmitted(result: ClaimResult, assignment: RemoteWorkAssignment, reference: AssignmentRequestReference | undefined): boolean {
    const admission = this.deps.journal.execution.admission(result.assignmentId, result.attempt);
    if (!admission || !allEqual([[admission.claimId, result.claimId], [admission.instanceId, assignment.instanceId], [admission.workspaceId, assignment.workspaceId],
      [admission.agentId, assignment.agentRoute.agentId], [admission.runnerIncarnation, this.deps.runnerIncarnation?.()]])) return false;
    this.deps.journal.execution.assertAdmission(admission);
    return this.startAllowsClaimEffect(this.deps.journal.execution.start(result.assignmentId, result.attempt), reference);
  }

  /** With a retained sender: an allocated start applying exactly this claim reply. Without one: a reserved allocation (or no start). */
  private startAllowsClaimEffect(start: AdmissionStart | undefined, reference: AssignmentRequestReference | undefined): boolean {
    if (!start) return !this.deps.assignmentSender;
    if (!this.deps.assignmentSender) return start.delivery === "allocation_reserved";
    return start.delivery === "allocated" && reference !== undefined && jcsDigest(start.allocation as JsonValue) === jcsDigest(reference) && start.claimEffect?.state === "applying";
  }

  /** The row still belongs to the pending claim after the outbox acknowledgement. */
  private stillPendingEntry(key: string, result: ClaimResult, assignment: RemoteWorkAssignment): JournalEntry | undefined {
    if (this.deps.journal.execution.isCancelled(result.assignmentId, result.attempt) || this.recoveryFences.has(key) || this.pendingClaims.get(key) !== assignment) return undefined;
    const entry = this.deps.journal.assignments.get(key);
    return entry?.claimId === result.claimId ? entry : undefined;
  }

  private retirePending(key: string): void {
    this.pendingClaims.delete(key);
    this.pendingClaimFences.delete(key);
  }

  private async applyClaimOutcome(claimed: PendingClaimResult): Promise<void> {
    switch (claimed.result.outcome) {
      case "claimed":
      case "already_claimed":
        return this.dispatchClaimed(claimed);
      case "agent_unavailable_replaced":
      case "cancelled":
      case "expired":
      case "denied":
        return this.refusedClaim(claimed);
    }
  }

  private async dispatchClaimed({ key, assignment, entry, assertAuthority }: PendingClaimResult): Promise<void> {
    this.retirePending(key);
    // Search remains cloud-controller-owned, but its selected ACP process
    // is local. Reuse the canonical claim-bound RelayedSession bootstrap
    // so readiness, input staging, MCP redemption and the execution
    // session channel are established before the hosted controller can
    // acquire prompt authority.
    if (isSearchAssignment(assignment)) await this.acceptSearchClaim(assignment);
    await this.dispatch(assignment, entry, assertAuthority);
  }

  private async acceptSearchClaim(assignment: Parameters<SearchControllerBoundary["acceptClaimed"]>[0]["assignment"]): Promise<void> {
    if (!this.deps.searchController) throw new RemoteInstanceError("recovery_required", "Search controller boundary became unavailable.");
    const start = this.deps.journal.execution.start(assignment.id, assignment.attempt);
    if (!start) throw new RemoteInstanceError("recovery_required", "Search claim lost its durable admission.");
    await this.deps.searchController.acceptClaimed({ assignment, admission: start.admission });
  }

  private async refusedClaim({ key, result, assignment, entry, assertAuthority }: PendingClaimResult): Promise<void> {
    this.logger.info({ assignmentId: result.assignmentId, outcome: result.outcome, reason: result.reason }, "claim did not succeed");
    await this.deps.journal.assignments.update(key, current => {
      assertAuthority();
      if (this.pendingClaims.get(key) !== assignment || !current || jcsDigest(current as JsonValue) !== jcsDigest(entry as JsonValue)) {
        this.fenceLostAuthority(key);
        throw new RemoteInstanceError("recovery_required", "Negative claim disposition no longer owns the current assignment row.");
      }
      return { ...current, state: "cancelled", updatedAt: this.deps.clock.nowIso() };
    });
    assertAuthority();
    if (this.pendingClaims.get(key) !== assignment) {
      this.fenceLostAuthority(key);
      throw new RemoteInstanceError("recovery_required", "Pending claim changed while saving its disposition.");
    }
    this.retirePending(key);
  }

  /** A genuine refusal/foreign canonical claim is not authority to adopt it. */
  private async onClaimNonDispatch(reference: AssignmentRequestReference): Promise<void> {
    const workspaceId = this.deps.workspaceId();
    const request = workspaceId ? this.deps.journal.assignmentStream.request({ instanceId: this.deps.instanceId(), workspaceId }, reference.requestSequence) : undefined;
    const admission = request?.admission;
    if (!admission) throw new RemoteInstanceError("recovery_required", "Non-dispatching claim has no retained admission.");
    const key = `${admission.assignmentId}:${admission.attempt}`, assignment = this.pendingClaims.get(key), assertOriginal = this.pendingClaimFences.get(key);
    if (!assignment || !assertOriginal) throw new RemoteInstanceError("recovery_required", "Non-dispatching claim lost its original pending owner.");
    assertOriginal(); this.deps.journal.execution.assertAdmission(admission);
    await this.deps.journal.assignments.update(key, current => {
      assertOriginal();
      if (!current || current.claimId !== admission.claimId || this.pendingClaims.get(key) !== assignment || current.state !== "claimed") throw new RemoteInstanceError("recovery_required", "Non-dispatching claim projection changed.");
      return { ...current, state: "recovery_required", recoveryReason: "assignment_conflict", updatedAt: this.deps.clock.nowIso() };
    });
    assertOriginal(); await this.deps.outbox.ack(admission.claimId); assertOriginal();
    if (this.pendingClaims.get(key) !== assignment) throw new RemoteInstanceError("recovery_required", "Pending claim owner changed during disposition.");
    this.pendingClaims.delete(key); this.pendingClaimFences.delete(key);
  }

  private captureNativeAuthority(assignmentId: string, attempt: number): () => void {
    const key = `${assignmentId}:${attempt}`;
    let captured: () => void;
    try { captured = new RecoveryAuthority(this.deps.recoveryAuthority).capture("assignment"); }
    catch (error) { this.fenceLostAuthority(key); throw error; }
    return () => {
      try { captured(); }
      catch (error) { this.fenceLostAuthority(key); throw error; }
    };
  }

  private fenceLostAuthority(key: string): void {
    this.recoveryFences.add(key);
    this.sessions.get(key)?.fenceForRecovery();
  }

  private dispatch(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void): Promise<void> {
    const key = `${assignment.id}:${assignment.attempt}`;
    if (this.recoveryFences.has(key)) return Promise.resolve();
    const existing = this.dispatching.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      if (!this.recoveryFences.has(key)) await this.dispatchImpl(assignment, entry, assertAuthority);
    });
    this.dispatching.set(key, task);
    void task.then(() => this.dispatching.delete(key), () => this.dispatching.delete(key));
    return task;
  }

  private async dispatchImpl(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void): Promise<void> {
    try {
      assertAuthority();
      if (this.deps.onboardCarrier && isOnboardWorkAssignment(assignment)) {
        // Evidence collection and the relocation mirror are deterministic local
        // git work with no model in the loop, so they never open an ACP session
        // and never bind the gateway. An onboarding SESSION turn carries the
        // `conversation` source and does not land here (OB6 §2, §3).
        await this.runOnboardWork(assignment, entry, assertAuthority);
        return;
      }
      if (this.deps.integrationCarrier && isIntegrationWorkAssignment(assignment)) {
        // An integration task runs on its own carrier: discovery and setup
        // are model-free, and a phase task opens its own gated ACP session
        // with a locally built prompt. Nothing is relayed.
        await this.runIntegrationWork(assignment, entry, assertAuthority);
        return;
      }
      await this.startRelayedSession(assignment, entry, assertAuthority);
    } catch (error) {
      await this.handleDispatchFailure(assignment, entry, assertAuthority, error);
    }
  }

  private async handleDispatchFailure(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void, error: unknown): Promise<void> {
    try { assertAuthority(); } catch { /* Capture synchronously fenced the exact uncertain owner. */ }
    if (this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`)) return;
    // Cancellation/recovery may have won while bootstrap or cleanup awaited IO.
    if (!sameDispatchOwner(this.deps.journal.assignments.get(`${assignment.id}:${assignment.attempt}`), entry)) return;
    this.logDispatchFailure(assignment, entry, error);
    if (assignment.kind === "planning" || isSearchAssignment(assignment)) {
      await this.deps.journal.assignments.update(`${assignment.id}:${assignment.attempt}`, latest => {
        if (!sameDispatchOwner(latest, entry)) throw new RemoteInstanceError("recovery_required", "Hosted-controller dispatch ownership changed");
        return { ...latest, state: "recovery_required", recoveryReason: "agent_session_lost", updatedAt: this.deps.clock.nowIso() };
      });
      return;
    }
    // Preserve recovery semantics without copying a native exception into the
    // public report. An ownership refusal is not an agent execution failure.
    const outcome = dispatchFailureOutcome(error);
    await this.reports.submit({ assignmentId: assignment.id, attempt: assignment.attempt, claimId: entry.claimId, draft: { terminal: true, result: { ...outcome, terminalResultHash: jcsDigest(outcome) } } });
  }

  /**
   * Bridge/bootstrap exceptions may contain expanded inputs or credentials.
   * Keep the exact owner and bounded failure code, not arbitrary error text:
   * a refusal names the exact check through its `diagnostic`, since one code
   * (`recovery_required`) is raised from a dozen distinct checks.
   */
  private logDispatchFailure(assignment: RemoteWorkAssignment, entry: JournalEntry, error: unknown): void {
    this.logger.warn({ workspaceId: assignment.workspaceId, instanceId: assignment.instanceId,
      assignmentId: assignment.id, attempt: assignment.attempt, claimId: entry.claimId,
      correlationId: assignment.correlationId, stage: "assignment_dispatch",
      reason: error instanceof RemoteInstanceError ? error.code : "internal",
      ...dispatchFailureDetail(error),
      sessionContinuation: continuedSession(assignment.source)?.acpSessionRef !== undefined,
    }, "dispatch failed; reporting");
  }

  /**
   * Run an onboard assignment to a terminal report on this machine. The report
   * is the whole outcome: there is no session to keep open afterwards, and a
   * refusal the worker turned into an evidence gap is a SUCCESSFUL collection
   * that found a gap, not a failed assignment.
   */
  private async runOnboardWork(assignment: OnboardWorkAssignment, entry: JournalEntry, assertAuthority: () => void): Promise<void> {
    await this.deps.journal.assignments.put({ ...entry, state: "running", updatedAt: this.deps.clock.nowIso() });
    assertAuthority();
    const outcome = await this.deps.onboardCarrier!.execute(assignment, assertAuthority);
    assertAuthority();
    await this.reports.submit({
      assignmentId: assignment.id,
      attempt: assignment.attempt,
      claimId: entry.claimId,
      draft: { terminal: true, result: onboardTerminalResult(outcome) },
    });
  }

  /** Run an integration task to its terminal report; its structured result is the whole outcome. */
  private async runIntegrationWork(assignment: IntegrationWorkAssignment, entry: JournalEntry, assertAuthority: () => void): Promise<void> {
    await this.deps.journal.assignments.put({ ...entry, state: "running", updatedAt: this.deps.clock.nowIso() });
    assertAuthority();
    const outcome = await this.deps.integrationCarrier!.execute(assignment, assertAuthority);
    assertAuthority();
    await this.reports.submit({
      assignmentId: assignment.id,
      attempt: assignment.attempt,
      claimId: entry.claimId,
      draft: { terminal: true, result: integrationTerminalResult(outcome) },
    });
  }

  private async startRelayedSession(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void): Promise<void> {
    const dispatch = this.newNativeDispatch(assignment, entry, assertAuthority);
    dispatch.assertAdmissionCurrent();
    dispatch.assertExecutionOwned();
    await this.settlePredecessorEvidence(dispatch);
    this.assertNoRecoveringPredecessor(assignment);
    const key = `${assignment.id}:${assignment.attempt}`;
    if (this.sessions.has(key)) throw new Error("the assignment already has a local session owner");
    const runner = this.deps.runners.get(assignment.agentRoute.agentId);
    if (!runner) throw new Error("no runner for the placed agent");
    const session = new RelayedSession(assignment, this.relayedSessionDeps(dispatch, runner));
    this.sessions.set(key, session);
    // Bootstrap runs off-lane. Its cloud/file preflight may take arbitrarily
    // long without holding assignment delivery; durable local execution
    // activation happens only after that preflight succeeds.
    const bootstrap = this.bootstrapRelayedSession(session, assignment, entry, dispatch.admission, assertAuthority, dispatch.assertExecutionOwned);
    this.bootstrapping.set(key, bootstrap);
    void bootstrap.catch(error => this.handleDispatchFailure(assignment, entry, assertAuthority, error))
      .finally(() => {
        if (this.bootstrapping.get(key) === bootstrap) this.bootstrapping.delete(key);
        for (const [legacyReference, claimant] of this.legacyCodexClaims) if (claimant === key) this.legacyCodexClaims.delete(legacyReference);
      });
  }

  /** One native dispatch: its admission, the execution reference it binds, and the ownership checks its session runs under. */
  private newNativeDispatch(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void): NativeDispatch {
    const dispatch: NativeDispatch = {
      assignment, entry, assertAuthority,
      admission: this.deps.journal.execution.admission(assignment.id, assignment.attempt),
      reference: undefined, takeover: undefined, executionActivated: false,
      assertAdmissionCurrent: () => this.assertDispatchAdmission(dispatch, true),
      // The session's own recovery stop: the recovery fence is that stop's mark
      // and the accepted generation it dispatched under may already have moved
      // on (a new recovery epoch is usually why it is being stopped), so neither
      // is a refusal here. Ownership of the exact admission still is.
      assertRecoveryOwned: () => this.assertDispatchAdmission(dispatch, false),
      assertExecutionOwned: () => {
        dispatch.assertAdmissionCurrent();
        if (dispatch.executionActivated) this.deps.journal.execution.assertExecutable(dispatch.admission!, dispatch.reference);
      },
    };
    return dispatch;
  }

  private assertDispatchAdmission(dispatch: NativeDispatch, current: boolean): void {
    if (current) dispatch.assertAuthority();
    this.requireNativeOwner();
    if (!this.admissionOwned(dispatch) || (current && this.recoveryFences.has(`${dispatch.assignment.id}:${dispatch.assignment.attempt}`))) {
      throw new RemoteInstanceError("recovery_required", "Native execution has no current durable admission.");
    }
    this.deps.journal.execution.assertAdmission(dispatch.admission!);
  }

  /** The admission is the dispatched claim's, in this process and scope, for the placed agent. */
  private admissionOwned({ assignment, entry, admission }: NativeDispatch): boolean {
    return admission !== undefined && allEqual([
      [this.deps.journal.assignments.get(`${assignment.id}:${assignment.attempt}`)?.claimId, entry.claimId], [admission.claimId, entry.claimId],
      [admission.runnerIncarnation, this.deps.runnerIncarnation?.()], [admission.instanceId, this.deps.instanceId()],
      [admission.workspaceId, this.deps.workspaceId()], [admission.agentId, assignment.agentRoute.agentId],
    ]);
  }

  private async settlePredecessorEvidence(dispatch: NativeDispatch): Promise<void> {
    const pendingEvidence = this.recoveringPredecessors(dispatch.assignment).flatMap(prior => this.pendingRecoveryEvidence(prior));
    if (pendingEvidence.length === 0) return;
    await this.settleRecoveryEvidence(pendingEvidence);
    dispatch.assertExecutionOwned();
  }

  private relayedSessionDeps(dispatch: NativeDispatch, runner: RunnerPort): RelayedSessionDeps {
    const { assignment } = dispatch;
    const { restoreReference, sessionId, retainedReference } = this.sessionContinuation(assignment);
    const mcpLocalTransport = retainedReference && sessionId
      ? this.deps.journal.execution.mcpLocalTransportForReference(retainedReference, sessionId, assignment.agentRoute.agentId)
      : undefined;
    return {
      ...this.deps.sessionDeps(assignment, runner),
      ...(mcpLocalTransport ? { mcpLocalTransport, mcpLocalTransportReference: retainedReference! } : {}),
      assertLegacyCodexThreadUnloaded: legacyReference => this.legacyCodexThreadUnloaded(dispatch, legacyReference),
      assertExecutionOwned: dispatch.assertExecutionOwned,
      assertRecoveryOwned: dispatch.assertRecoveryOwned,
      ...(assignment.kind === "planning" ? this.planningDeps(dispatch) : {}),
      ...(restoreReference !== undefined ? { restoreReference } : {}),
      activateExecution: () => this.activateExecution(dispatch),
      ...this.executionRecordDeps(dispatch),
      reserveChannel: (channelId, owner) => this.reserveChannel(channelId, owner),
      onUsage: this.deps.onUsage,
      onExecutionAuthorityLost: () => this.recoverLostExecutionAuthority(assignment.id, assignment.attempt),
      onClosed: async (closed, reason) => this.onSessionClosed(closed, reason, dispatch.assertAuthority),
    };
  }

  /**
   * A conversation turn or a direct session prompt continues its session. A
   * conversation may have a live local predecessor but still request a fresh
   * turn. Only Core's exact requested reference may carry its old MCP
   * transport into bootstrap; takeover can otherwise stop that predecessor.
   */
  private sessionContinuation(assignment: RemoteWorkAssignment): { restoreReference: string | undefined; sessionId: string | undefined; retainedReference: string | undefined } {
    const continued = continuedSession(assignment.source);
    const restoreReference = continued ? continued.acpSessionRef : undefined;
    const sessionId = logicalSessionId(assignment.source);
    return { restoreReference, sessionId, retainedReference: this.retainedReferenceFor(assignment, sessionId, restoreReference) };
  }

  private retainedReferenceFor(assignment: RemoteWorkAssignment, sessionId: string | undefined, restoreReference: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    const retained = continuedSession(assignment.source) ? restoreReference : this.channelOwners.get(`session:${sessionId}`)?.acpSessionRef ?? restoreReference;
    if (retained || assignment.source.kind !== "harness_delivery") return retained;
    return this.liveContinuationReference(assignment);
  }

  /** A retained live owner of the delivery's session head, when the journal can prove one. */
  private liveContinuationReference(assignment: RemoteWorkAssignment): string | undefined {
    try { return this.deps.journal.execution.liveContinuation(assignment)?.acpSessionRef; }
    catch (error) {
      if (!(error instanceof RemoteInstanceError) || error.code !== "recovery_required") throw error;
      return undefined;
    }
  }

  /** One dispatch at a time may claim a legacy Codex thread, and only one never loaded under its owner generation. */
  private async legacyCodexThreadUnloaded(dispatch: NativeDispatch, legacyReference: string): Promise<boolean> {
    const key = `${dispatch.assignment.id}:${dispatch.assignment.attempt}`;
    const claimant = this.legacyCodexClaims.get(legacyReference);
    if (claimant && claimant !== key) return false;
    this.legacyCodexClaims.set(legacyReference, key);
    try { return await this.bindLegacyCodexThread(dispatch, legacyReference); }
    catch { return false; }
  }

  private async bindLegacyCodexThread(dispatch: NativeDispatch, legacyReference: string): Promise<boolean> {
    const inspection = await this.deps.inspectLegacyCodexThread?.(legacyReference);
    if (!inspection?.unloaded || !inspection.ownerGeneration) return false;
    const scopedReference = `${inspection.ownerGeneration}:${legacyReference}`;
    if (this.legacyCodexConsumed.has(scopedReference) || this.deps.journal.execution.legacyCodexLoadPreviouslyAdmitted(legacyReference, inspection.ownerGeneration, dispatch.admission!.executionGeneration)) return false;
    await this.deps.journal.execution.bindLegacyCodexAdmission(dispatch.admission!, legacyReference, inspection.ownerGeneration, dispatch.assertExecutionOwned);
    this.legacyCodexConsumed.add(scopedReference);
    return true;
  }

  /** A planning turn folds each outbound message into its durable planning journal before transport. */
  private planningDeps(dispatch: NativeDispatch): Pick<RelayedSessionDeps, "beforeSendToCore" | "assertPromptAllowed"> {
    return {
      beforeSendToCore: async (message) => {
        dispatch.assertExecutionOwned();
        const state = await this.deps.journal.planning.append(dispatch.admission!, message);
        dispatch.assertExecutionOwned();
        return state.sourceSequence;
      },
      assertPromptAllowed: () => { dispatch.assertExecutionOwned(); this.deps.journal.planning.assertPromptAllowed(dispatch.admission!); },
    };
  }

  /**
   * Deliberately after input preparation and capability redemption. A
   * transient cloud failure must leave an idle live ACP predecessor untouched
   * and available to the next attempt.
   */
  private async activateExecution(dispatch: NativeDispatch): Promise<{ continueReference?: string; restoreReference?: string }> {
    dispatch.assertAdmissionCurrent();
    const admission = dispatch.admission!;
    const takeover = await this.takeOverCompletedChannel(dispatch.assignment, admission, dispatch.assertAdmissionCurrent);
    dispatch.takeover = takeover;
    if (takeover?.mode === "live") dispatch.reference = takeover.reference;
    if (takeover === undefined) await this.deps.journal.execution.open(admission, dispatch.assertAdmissionCurrent, this.deps.clock.nowIso());
    if (dispatch.assignment.kind === "planning") await this.deps.journal.planning.start(admission, dispatch.entry.recoveryEpoch);
    dispatch.executionActivated = true;
    dispatch.assertExecutionOwned();
    return takeoverReferences(takeover);
  }

  /** The execution's durable bindings, each recorded under the dispatch's ownership checks. */
  private executionRecordDeps(dispatch: NativeDispatch): Pick<RelayedSessionDeps, "recordCompletedSettlement" | "reserveExecutionReference" | "recordExecutionProcessOwner" | "replaceExecutionProcessOwner" | "recordMcpLocalTransport"> {
    const execution = this.deps.journal.execution;
    const owned = dispatch.assertExecutionOwned;
    return {
      recordCompletedSettlement: async (ref: string) => {
        owned();
        await execution.markCompletedTurnSettled(dispatch.admission!, ref, this.deps.clock.nowIso(), owned);
      },
      reserveExecutionReference: async (ref: string) => {
        if (dispatch.takeover?.mode === "live" && ref === dispatch.reference) return void owned();
        await execution.bindReference(dispatch.admission!, ref, owned);
        dispatch.reference = ref;
        owned();
      },
      recordExecutionProcessOwner: async owner => {
        await execution.bindProcessOwner(dispatch.admission!, owner, owned);
        owned();
      },
      replaceExecutionProcessOwner: async (previous, replacement) => {
        await execution.replaceBootstrapProcessOwner(dispatch.admission!, previous, replacement, owned);
        owned();
      },
      recordMcpLocalTransport: async identity => {
        owned();
        await execution.bindMcpLocalTransport(dispatch.admission!, identity, owned);
      },
    };
  }

  /** One local owner per logical session channel; the release only frees it for that owner. */
  private reserveChannel(channelId: string, owner: RelayedSession): () => void {
    if (this.channelOwners.has(channelId)) throw new Error("the logical session channel already has a local owner");
    this.channelOwners.set(channelId, owner);
    return () => {
      if (this.channelOwners.get(channelId) === owner) this.channelOwners.delete(channelId);
    };
  }

  /** Refuse before input preparation, then recheck at activation to close races. */
  private assertNoRecoveringPredecessor(assignment: RemoteWorkAssignment): void {
    const sessionId = logicalSessionId(assignment.source);
    if (sessionId === undefined) return;
    const channelId = `session:${sessionId}`;
    const predecessor = this.channelOwners.get(channelId);
    if (!predecessor) return;
    const prior = this.deps.journal.execution.admission(predecessor.assignment.id, predecessor.assignment.attempt);
    const execution = prior && this.deps.journal.execution.execution(prior);
    if (!execution || execution.phase === "opened") return;
    if (this.releaseRecoveredPredecessor(channelId, predecessor, prior, assignment)) return;
    this.logBlockedSuccessor(assignment, sessionId, predecessor, prior, execution);
    throw new RemoteInstanceError("recovery_required",
      "The previous execution stopped unexpectedly and its background work could not be confirmed stopped. This session requires recovery before retrying.",
      { diagnostic: "predecessor_recovery_unqualified" });
  }

  /**
   * What is still missing before this session can start fresh: a proven
   * process stop, Core's settlement of the claim, Core's answer to the stop
   * observation.
   */
  private logBlockedSuccessor(assignment: RemoteWorkAssignment, sessionId: string, predecessor: RelayedSession, prior: LocalAdmission | undefined, execution: LocalExecution): void {
    const priorEntry = this.deps.journal.assignments.get(`${predecessor.assignment.id}:${predecessor.assignment.attempt}`);
    this.logger.warn({ event: "execution.successor_blocked", assignmentId: assignment.id, attempt: assignment.attempt,
      sessionId, predecessorAssignmentId: predecessor.assignment.id, predecessorAttempt: predecessor.assignment.attempt,
      predecessorClaimId: prior?.claimId, phase: execution.phase, acpSessionRef: execution.acpSessionRef,
      terminalSequence: priorEntry?.reports.terminalSequence ?? null,
      processStopped: execution.processStoppedAt !== undefined,
      ...this.predecessorSettlement(prior),
      lifecycleProfileDigest: execution.lifecycleProfileDigest ?? null,
      executionProfileDigest: execution.executionProfileDigest ?? null,
      diagnostic: "predecessor_recovery_unqualified" }, "Previous execution requires recovery before this session can run again");
  }

  private predecessorSettlement(prior: LocalAdmission | undefined): { terminalAcknowledged: boolean; pendingRecoveryEvidence: number } {
    if (!prior) return { terminalAcknowledged: false, pendingRecoveryEvidence: 0 };
    return {
      terminalAcknowledged: this.reports.acknowledgedTerminalReport(prior.assignmentId, prior.attempt, prior.claimId) !== undefined,
      pendingRecoveryEvidence: this.pendingRecoveryEvidence(prior).length,
    };
  }

  /**
   * A fenced execution is finished with, and its logical session may start a
   * fresh ACP session, once three facts hold: its exact process
   * group is proven gone (`interrupted_unqualified` is written only after that
   * proof), Core acknowledged the claim's terminal report (Core settled the
   * work), and no stop observation for it still awaits Core (accepted, or
   * superseded because Core can never take it). The fenced ACP reference is
   * never resumed and its journal fence stays. Demanding more left the
   * session refusing every later turn until the connector restarted.
   */
  private recoveredExecutionSettled(prior: LocalAdmission): boolean {
    const execution = this.deps.journal.execution.execution(prior);
    return execution?.phase === "interrupted_unqualified" && execution.processStoppedAt !== undefined &&
      this.reports.acknowledgedTerminalReport(prior.assignmentId, prior.attempt, prior.claimId) !== undefined &&
      this.pendingRecoveryEvidence(prior).length === 0;
  }

  private pendingRecoveryEvidence(prior: LocalAdmission): RecoveryEvidenceRecord[] {
    return this.deps.journal.recoveryEvidence.all().filter(record => record.delivery === "pending" &&
      record.evidence.instanceId === prior.instanceId && record.evidence.assignmentId === prior.assignmentId &&
      record.evidence.attempt === prior.attempt && record.evidence.claimId === prior.claimId);
  }

  /** Hand a settled fenced owner's channel to the next turn; false keeps the gate. */
  private releaseRecoveredPredecessor(channelId: string, predecessor: RelayedSession, prior: LocalAdmission | undefined,
    successor: RemoteWorkAssignment): boolean {
    if (!prior || !this.recoveredExecutionSettled(prior)) return false;
    try { predecessor.releaseRecoveredChannel(); }
    catch { return false; }
    const key = `${prior.assignmentId}:${prior.attempt}`;
    if (this.channelOwners.get(channelId) === predecessor) this.channelOwners.delete(channelId);
    if (this.sessions.get(key) === predecessor) this.sessions.delete(key);
    this.logger.info({ event: "execution.recovered_predecessor_released", assignmentId: successor.id, attempt: successor.attempt,
      predecessorAssignmentId: prior.assignmentId, predecessorAttempt: prior.attempt, predecessorClaimId: prior.claimId,
      stage: "channel_handoff", outcome: "fresh_session" },
    "the previous execution was stopped and Core settled it; starting a fresh ACP session");
    return true;
  }

  /** The fenced executions a turn of this logical session would wait on. */
  private recoveringPredecessors(assignment: RemoteWorkAssignment): LocalAdmission[] {
    const source = assignment.source;
    const sessionId = logicalSessionId(source);
    if (sessionId === undefined) return [];
    const owner = this.channelOwners.get(`session:${sessionId}`);
    const candidates = [
      owner && this.deps.journal.execution.admission(owner.assignment.id, owner.assignment.attempt),
      source.kind === "harness_delivery" ? this.deps.journal.execution.headContinuationTip(assignment) : undefined,
    ];
    return candidates.filter((value): value is LocalAdmission => value !== undefined &&
      this.deps.journal.execution.execution(value)?.phase === "interrupted_unqualified");
  }

  /**
   * Let Core answer a fenced predecessor's stop observation now rather than at
   * its next backed-off maintenance retry, so the gate below sees Core's answer.
   * Delivery failures stay on the durable record; the gate decides.
   */
  private async settleRecoveryEvidence(pending: RecoveryEvidenceRecord[]): Promise<void> {
    if (this.recoveryEvidenceRetry) await this.recoveryEvidenceRetry.catch(() => undefined);
    for (const record of pending) {
      const latest = this.deps.journal.recoveryEvidence.get(recoveryEvidenceRecordKey(record));
      if (latest?.delivery !== "pending") continue;
      try { await this.deliverRecoveryEvidence(latest); }
      catch (error) {
        this.logger.warn({ assignmentId: record.evidence.assignmentId, attempt: record.evidence.attempt,
          code: recoveryEvidenceFailureCode(error) }, "Recovery evidence delivery remains pending");
      }
    }
  }

  /**
   * Hand a logical session channel from its retained completed turn to the
   * next admitted turn. The exact prior reference continues the
   * idle live ACP session through the journaled generation transfer; any other
   * turn (for example a delegated planner) gets a fresh session, so the idle
   * one is settled and its process proven stopped first, as bb stops a
   * thread's existing session before starting another. Returns the continued
   * reference, if any.
   */
  private async takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<Takeover | undefined> {
    const sessionId = logicalSessionId(assignment.source);
    if (sessionId === undefined) return undefined;
    const channelId = `session:${sessionId}`;
    await this.awaitClosingOwner(channelId, assertCurrent);
    this.assertNoRecoveringPredecessor(assignment);
    const predecessor = this.channelOwners.get(channelId);
    if (!predecessor) return this.takeOverWithoutLiveOwner(assignment, admission, sessionId, assertCurrent);
    return this.takeOverFromOwner({ assignment, admission, sessionId, channelId, predecessor, assertCurrent });
  }

  /**
   * The channel's owner may be a turn that just closed unfinished and is
   * still proving its process gone: hand over only after that stop settles.
   */
  private async awaitClosingOwner(channelId: string, assertCurrent: () => void): Promise<void> {
    const closing = this.channelOwners.get(channelId);
    const closingAdmission = closing && this.deps.journal.execution.admission(closing.assignment.id, closing.assignment.attempt);
    const retiring = closingAdmission && this.executionRetirements.get(closingAdmission.executionGeneration);
    if (!retiring) return;
    await retiring.catch(() => undefined);
    assertCurrent();
  }

  /**
   * A connector restart removes only the in-memory owner. Core's opaque
   * reference and the runner's credential-volume mapping survive, so the
   * later bootstrap must attempt ACP session/load. The runner fails closed
   * with agent_session_lost if either the mapping or provider state is gone.
   */
  private async takeOverWithoutLiveOwner(assignment: RemoteWorkAssignment, admission: LocalAdmission, sessionId: string, assertCurrent: () => void): Promise<Takeover | undefined> {
    const continued = continuedSession(assignment.source);
    if (continued && continued.acpSessionRef !== undefined) this.logger.info({ assignmentId: assignment.id, attempt: assignment.attempt, stage: "channel_handoff", outcome: "restore_session" },
      "the conversation's previous session is not live here; restoring it from the durable ACP reference");
    if (!harnessDelivery(assignment)) return undefined;
    return this.takeOverHarnessHead(assignment, admission, sessionId, assertCurrent);
  }

  /** A repository role's head: restore or continue its retained session, or start fresh when the journal proves that is safe. */
  private async takeOverHarnessHead(assignment: HarnessAssignment, admission: LocalAdmission, sessionId: string, assertCurrent: () => void): Promise<Takeover | undefined> {
    const pendingRestore = this.deps.journal.execution.pendingRestore(admission, assignment);
    if (pendingRestore) return { reference: pendingRestore, mode: "restore" };
    let retained;
    try {
      retained = this.deps.journal.execution.liveContinuation(assignment);
    } catch (error) {
      if (!(error instanceof RemoteInstanceError) || error.code !== "recovery_required") throw error;
      return this.freshAfterUncontinuableHead(assignment, assertCurrent, error);
    }
    if (!retained) {
      if (assignment.source.turn.predecessor) throw new RemoteInstanceError("assignment_conflict",
        "The repository role's exact predecessor turn is not durably continuable yet.");
      return undefined;
    }
    return this.transferHead(retained, admission, sessionId, assertCurrent);
  }

  /**
   * A continuation that just closed unfinished may still be proving its
   * process gone; decide on the outcome of that stop, not a snapshot.
   */
  private async freshAfterUncontinuableHead(assignment: HarnessAssignment, assertCurrent: () => void, error: RemoteInstanceError): Promise<undefined> {
    const tip = this.deps.journal.execution.headContinuationTip(assignment);
    const retiring = tip && this.executionRetirements.get(tip.executionGeneration);
    if (retiring) await retiring.catch(() => undefined);
    const fresh = this.freshStartReason(assignment);
    if (fresh === null) return this.releaseUnfinishedContinuation(assignment, assertCurrent, tip, error);
    // A settled head is not always this turn's predecessor: a fresh
    // repository anchor deliberately declines generated workspace state.
    // Otherwise the exact predecessor was already fenced or reported as
    // unresumable. In every case its old generation/reference stays
    // fenced; opening below creates a fresh session inside the admitted
    // repository, role, agent and model boundary.
    const { outcome, message } = FRESH_STARTS[fresh];
    this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt, stage: "channel_handoff", outcome }, message);
    return undefined;
  }

  private freshStartReason(assignment: HarnessAssignment): FreshStart | null {
    if (this.canStartFreshRepositoryAnchorAfterSettledHead(assignment)) return "repository_anchor";
    if (this.canStartFreshAfterSettledHarnessPredecessor(assignment)) return "settled_predecessor";
    if (this.canStartFreshAfterUnresumableHarnessPredecessor(assignment) || this.canStartFreshAfterRecoveredHarnessContinuation(assignment)) return "unresumable";
    return null;
  }

  /**
   * Journals written before close-time retirement: a continuation that was
   * cancelled or failed stays `opened` with no live owner, its turn terminal
   * and settled by Core. Prove its process gone now and start fresh, as the
   * live channel path does for an unusable predecessor.
   */
  private async releaseUnfinishedContinuation(assignment: HarnessAssignment, assertCurrent: () => void, tip: LocalAdmission | undefined, error: RemoteInstanceError): Promise<undefined> {
    if (!(await this.retireUnfinishedHarnessContinuation(assignment, assertCurrent))) throw error;
    this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt, predecessorAssignmentId: tip?.assignmentId,
      predecessorAttempt: tip?.attempt, stage: "channel_handoff", outcome: "released_unfinished_continuation" },
    "the role session's last continuation ended unfinished; its process is stopped and a fresh ACP session starts");
    return undefined;
  }

  /** Hand the completed head to this turn: live in the same runner incarnation, else restored under a fresh reference. */
  private async transferHead(retained: NonNullable<ReturnType<SupervisorJournal["execution"]["liveContinuation"]>>, admission: LocalAdmission, sessionId: string, assertCurrent: () => void): Promise<Takeover> {
    const priorEntry = this.deps.journal.assignments.get(`${retained.admission.assignmentId}:${retained.admission.attempt}`);
    if (priorEntry?.reports.terminalSequence === undefined) {
      throw new RemoteInstanceError("assignment_conflict", "The repository role's previous turn has not durably completed.");
    }
    const mode = retained.admission.runnerIncarnation === admission.runnerIncarnation ? "live" : "restore";
    const transfer = { predecessor: retained.admission, successor: admission, sessionId,
      acpSessionRef: retained.acpSessionRef, processOwner: retained.processOwner, continuedAt: this.deps.clock.nowIso() };
    if (mode === "live") await this.deps.journal.execution.transferLiveContinuation(transfer, assertCurrent);
    else await this.deps.journal.execution.transferRestoredContinuation(transfer, assertCurrent);
    return { reference: retained.acpSessionRef, mode };
  }

  private async takeOverFromOwner(handoff: ChannelHandoff): Promise<Takeover | undefined> {
    const { predecessor } = handoff;
    const key = `${predecessor.assignment.id}:${predecessor.assignment.attempt}`;
    if (!predecessor.isClosed) return this.supersedeLiveOwner(handoff, key);
    // Closed but its terminal report is still being journaled: a transient
    // state the next attempt clears, so this stays a refusal.
    if (this.deps.journal.assignments.get(key)?.reports.terminalSequence === undefined) {
      throw new RemoteInstanceError("assignment_conflict", "The conversation's previous turn still owns its session channel.");
    }
    const owner = this.completedOwner(key, predecessor);
    if (owner === null) return this.releaseUnusableOwner(handoff, key);
    return this.continueOrStopOwner(handoff, owner);
  }

  /** The closed owner's admission, reference and retained process, when it can still be continued or proven stopped. */
  private completedOwner(key: string, predecessor: RelayedSession): CompletedOwner | null {
    const prior = this.deps.journal.execution.admission(predecessor.assignment.id, predecessor.assignment.attempt);
    const ref = predecessor.acpSessionRef;
    if (!prior || !ref) return null;
    const processOwner = this.continuableProcess(key, prior, ref);
    return processOwner === null ? null : { key, prior, ref, processOwner };
  }

  /**
   * Core places a conversation turn only while the session has no queued or
   * claimed assignment, so a predecessor that is still live HERE is a turn
   * Core has already cancelled or closed: typically a hosted turn that failed
   * before its prompt ever arrived. The cancellation that would have told us
   * needs a runtime protocol this connector does not speak yet, so the new
   * turn is the cancellation: refusing it instead pinned the conversation on
   * a zombie owner until the connector restarted.
   */
  private async supersedeLiveOwner({ assignment, channelId, predecessor, assertCurrent }: ChannelHandoff, key: string): Promise<undefined> {
    if (harnessDelivery(assignment)) {
      throw new RemoteInstanceError("assignment_conflict",
        "The repository role's previous turn still owns its persistent ACP session.");
    }
    this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt, predecessorAssignmentId: predecessor.assignment.id,
      stage: "channel_handoff", outcome: "superseded_live_predecessor" },
      "Core placed a new turn for this conversation while the previous one is still live here; cancelling it and starting a fresh session");
    await predecessor.close("cancelled");
    assertCurrent();
    if (this.channelOwners.get(channelId) === predecessor) this.channelOwners.delete(channelId);
    if (this.sessions.get(key) === predecessor) this.sessions.delete(key);
    return undefined;
  }

  /** The completed owner's retained process, when its execution is still an opened, settled turn on exactly this reference. */
  private continuableProcess(key: string, prior: LocalAdmission, ref: string): RetainedProcessOwner | null {
    const execution = this.deps.journal.execution.execution(prior);
    if (this.recoveryFences.has(key) || execution?.phase !== "opened" || execution.acpSessionRef !== ref || execution.completedTurnSettledAt === undefined) return null;
    return execution.processOwner ?? null;
  }

  /**
   * Finished, but not continuable: the journal lost or fenced what a
   * continuation (or a proven stop) needs. Refusing here pinned the channel
   * until the connector restarted, because the idle reaper screens on these
   * same facts and could never reclaim it either. Losing in-agent history is
   * the right price; losing the turn is not (bb's behaviour when a thread
   * cannot be restored). If the owner itself refuses release, it is not an
   * idle completion after all and the original refusal stands.
   */
  private releaseUnusableOwner({ assignment, predecessor }: ChannelHandoff, key: string): undefined {
    try {
      predecessor.releaseCompletedChannel();
    } catch {
      throw new RemoteInstanceError("assignment_conflict", "The conversation's previous turn still owns its session channel.");
    }
    if (this.sessions.get(key) === predecessor) this.sessions.delete(key);
    this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt, predecessorAssignmentId: predecessor.assignment.id,
      stage: "channel_handoff", outcome: "released_unusable_predecessor" },
      "the conversation's previous turn cannot be continued or proven stopped; released its channel and started a fresh session");
    return undefined;
  }

  /** Continue the idle completed session when this turn names it, else stop it and start fresh. */
  private async continueOrStopOwner(handoff: ChannelHandoff, owner: CompletedOwner): Promise<Takeover | undefined> {
    const { prior, ref, processOwner } = owner;
    const assertPredecessor = () => {
      handoff.assertCurrent();
      if (this.channelOwners.get(handoff.channelId) !== handoff.predecessor || prior.runnerIncarnation !== this.deps.runnerIncarnation?.()) {
        throw new RemoteInstanceError("recovery_required", "The previous turn's channel owner changed during handoff.");
      }
      this.deps.journal.execution.assertAdmission(prior);
    };
    const release = () => {
      handoff.predecessor.releaseCompletedChannel();
      if (this.sessions.get(owner.key) === handoff.predecessor) this.sessions.delete(owner.key);
    };
    if (this.liveContinuable(handoff, owner) && await this.tryLiveTransfer(handoff, owner, assertPredecessor, release)) return { reference: ref, mode: "live" };
    await this.stopCompletedOwner(prior, ref, processOwner, assertPredecessor);
    release();
    this.logger.info({ assignmentId: handoff.assignment.id, attempt: handoff.assignment.attempt, predecessorAssignmentId: prior.assignmentId, stage: "channel_handoff", outcome: "predecessor_stopped" },
      "stopped the conversation's idle completed session before a fresh turn");
    return undefined;
  }

  /** A delivery head, or the conversation turn that names this reference, on the same agent. */
  private liveContinuable({ assignment, admission }: ChannelHandoff, { prior, ref }: CompletedOwner): boolean {
    return (harnessDelivery(assignment) || continuedSession(assignment.source)?.acpSessionRef === ref) && prior.agentId === admission.agentId;
  }

  /**
   * The transfer is one atomic journal batch, so a refusal wrote nothing. A
   * continuation the journal cannot prove costs in-agent history, not the
   * turn: stop the idle completion (its process stays resident) and start
   * fresh, exactly as an unusable predecessor is handled. False when it could
   * not be continued.
   */
  private async tryLiveTransfer(handoff: ChannelHandoff, owner: CompletedOwner, assertPredecessor: () => void, release: () => void): Promise<boolean> {
    try {
      await this.deps.journal.execution.transferLiveContinuation({ predecessor: owner.prior, successor: handoff.admission, sessionId: handoff.sessionId,
        acpSessionRef: owner.ref, processOwner: owner.processOwner, continuedAt: this.deps.clock.nowIso() }, assertPredecessor);
      release();
      return true;
    } catch (error) {
      if (!(error instanceof RemoteInstanceError) || error.code !== "recovery_required") throw error;
      if (harnessDelivery(handoff.assignment)) throw error;
      this.logger.warn({ assignmentId: handoff.assignment.id, attempt: handoff.assignment.attempt, predecessorAssignmentId: owner.prior.assignmentId,
        stage: "channel_handoff", outcome: "continuation_unprovable", ...(error.diagnostic !== undefined ? { detail: error.diagnostic } : {}) },
        "the conversation's previous session could not be continued; stopping it and starting a fresh session");
      return false;
    }
  }

  /**
   * A fresh Harness session is safe only when every retained attempt for the
   * declared predecessor turn has durably terminated as not_resumable. The
   * repository, task, role, agent and model boundaries stay exact: this is a
   * lifecycle fallback, never permission to substitute placement or work.
   */
  private canStartFreshAfterUnresumableHarnessPredecessor(successor: RemoteWorkAssignment): boolean {
    if (successor.source.kind !== "harness_delivery" || !successor.source.turn.predecessor) return false;
    const expectedTurn = turnIdentity(successor.source.turn.predecessor);
    const matches = this.deps.journal.assignments.all().filter(entry => {
      const predecessor = this.deps.journal.execution.start(entry.assignmentId, entry.attempt)?.assignment;
      if (!predecessor || predecessor.source.kind !== "harness_delivery") return false;
      // Only the identifying fields: a predecessor that itself continued a
      // turn carries its own nested `predecessor`, which the reference omits.
      return sameHarnessRoleSession(predecessor, successor) && turnIdentity(predecessor.source.turn) === expectedTurn;
    });
    // Retries of one logical predecessor retain the assignment id and advance
    // the attempt. A different assignment id for the same turn is ambiguous
    // and must not be guessed across; within one id, only its latest attempt
    // owns the terminal disposition.
    if (matches.length === 0 || new Set(matches.map(entry => entry.assignmentId)).size !== 1) return false;
    const latest = matches.reduce((left, right) => right.attempt > left.attempt ? right : left);
    return latest.reports.terminalSequence !== undefined &&
      latest.reports.terminalResult?.class === "interrupted" &&
      latest.reports.terminalResult.reason === "not_resumable";
  }

  /**
   * The repository role's completed head was continued by a turn that was then
   * fenced, stopped and settled by Core, or that ended unfinished
   * (cancelled, failed) and was retired at close. That session is spent: its
   * head cannot be transferred again and the fenced reference is never
   * resumed. The next turn of the same role session starts a fresh ACP
   * session under the same exact boundaries instead of refusing forever.
   */
  private canStartFreshAfterRecoveredHarnessContinuation(successor: RemoteWorkAssignment): boolean {
    if (!harnessDelivery(successor) || !successor.source.turn.predecessor) return false;
    const tip = this.deps.journal.execution.headContinuationTip(successor);
    const fenced = tip && this.deps.journal.execution.start(tip.assignmentId, tip.attempt)?.assignment;
    if (!tip || !fenced || !continuesSamePredecessor(fenced, successor)) return false;
    return this.recoveredExecutionSettled(tip);
  }

  /**
   * The repository role's last continuation ended unfinished (cancelled,
   * failed, interrupted) and its record was never stopped: it is still
   * `opened` (or a previous stop got part way) while the head it continued is
   * `continued`. Once its claim is terminal, Core acknowledged that report and
   * nothing local owns it any more, its exact process is proven gone and the
   * record is marked as the recovery stop marks it; the next turn then starts
   * a fresh ACP session through the recovered-continuation rule. Any doubt
   * (a local owner, no acknowledgement, a process stop that is not proven)
   * keeps the refusal: two agents must never run on one workspace.
   */
  private async retireUnfinishedHarnessContinuation(successor: RemoteWorkAssignment, assertCurrent: () => void): Promise<boolean> {
    const tip = this.unfinishedContinuationTip(successor);
    if (!tip) return false;
    const key = `${tip.assignmentId}:${tip.attempt}`;
    const unfinished = this.unfinishedButSettled(tip, key);
    if (!unfinished || this.ownedLocally(tip, key)) return false;
    const assertTip = () => {
      assertCurrent();
      this.requireNativeOwner();
      if (tip.instanceId !== this.deps.instanceId() || tip.workspaceId !== this.deps.workspaceId() || this.ownedLocally(tip, key) ||
          this.deps.journal.assignments.get(key)?.claimId !== tip.claimId) {
        throw new RemoteInstanceError("recovery_required", "The unfinished continuation gained a local owner during its stop.");
      }
    };
    this.logger.warn({ event: "execution.unfinished_continuation", assignmentId: successor.id, attempt: successor.attempt,
      predecessorAssignmentId: tip.assignmentId, predecessorAttempt: tip.attempt, predecessorClaimId: tip.claimId,
      phase: unfinished.execution.phase, terminalClass: unfinished.entry.reports.terminalResult?.class ?? null, stage: "channel_handoff" },
    "the role session's last continuation ended unfinished and was never stopped; proving its process gone");
    return this.retireTip(successor, tip, assertTip);
  }

  /** The head's last continuation, when it continued exactly this successor's predecessor turn. */
  private unfinishedContinuationTip(successor: RemoteWorkAssignment): LocalAdmission | undefined {
    if (!harnessDelivery(successor) || !successor.source.turn.predecessor) return undefined;
    const tip = this.deps.journal.execution.headContinuationTip(successor);
    const continuation = tip && this.deps.journal.execution.start(tip.assignmentId, tip.attempt)?.assignment;
    if (!tip || !continuation || !continuesTurn(continuation, successor, successor.source.turn.predecessor)) return undefined;
    return tip;
  }

  /** Still unfinished with a retained process, yet its claim is terminal and Core acknowledged that report. */
  private unfinishedButSettled(tip: LocalAdmission, key: string): { execution: LocalExecution; entry: JournalEntry } | null {
    const execution = this.deps.journal.execution.execution(tip);
    const entry = this.deps.journal.assignments.get(key);
    if (!execution || !UNFINISHED_PHASES.has(execution.phase) || !execution.processOwner || entry?.claimId !== tip.claimId ||
        entry.reports.terminalSequence === undefined || this.reports.acknowledgedTerminalReport(tip.assignmentId, tip.attempt, tip.claimId) === undefined) return null;
    return { execution, entry };
  }

  /** Something in this process still owns the execution (session, bootstrap, dispatch, pending claim, recovery stop or channel). */
  private ownedLocally(tip: LocalAdmission, key: string): boolean {
    return this.sessions.has(key) || this.bootstrapping.has(key) || this.dispatching.has(key) ||
      this.pendingClaims.has(key) || this.recoveryStops.has(key) ||
      [...this.channelOwners.values()].some(owner => owner.assignment.id === tip.assignmentId && owner.assignment.attempt === tip.attempt);
  }

  private async retireTip(successor: RemoteWorkAssignment, tip: LocalAdmission, assertTip: () => void): Promise<boolean> {
    let retired: boolean;
    try { retired = await this.retireUnfinishedExecution(tip, assertTip, "channel_handoff"); }
    catch (error) {
      this.logger.warn({ event: "execution.unfinished_continuation_stop_unconfirmed", assignmentId: successor.id, attempt: successor.attempt,
        predecessorAssignmentId: tip.assignmentId, predecessorAttempt: tip.attempt, stage: "channel_handoff",
        code: error instanceof RemoteInstanceError ? error.code : "unexpected_error" },
      "the unfinished continuation's process could not be confirmed stopped; the role session stays blocked");
      throw new RemoteInstanceError("recovery_required", "The previous turn's agent process could not be confirmed stopped.",
        { diagnostic: "unfinished_continuation_stop_unconfirmed" });
    }
    return retired && this.recoveredExecutionSettled(tip);
  }

  /**
   * A non-completed delivery close (cancelled, failed, lease lost, drain,
   * replay gap) ends that turn for good, but its record stayed `opened`, so
   * the role session's next turn could never start.
   * Once the session's own close has finished (the runner was already asked
   * to close the ACP session and stop its bridge), prove the exact process
   * gone and mark the execution exactly as a retained recovery stop does.
   * Failure only logs: the next turn's handoff retries the same stop.
   */
  private retireAfterClose(session: RelayedSession, reason: SessionClosedReason): void {
    const { id: assignmentId, attempt } = session.assignment;
    const key = `${assignmentId}:${attempt}`;
    const admission = this.deps.journal.execution.admission(assignmentId, attempt);
    if (!admission) return;
    const assertCurrent = () => {
      this.requireNativeOwner();
      if (!this.inOwnScope(admission) || this.recoveryFences.has(key) || this.sessions.has(key) ||
          this.deps.journal.assignments.get(key)?.claimId !== admission.claimId) {
        throw new RemoteInstanceError("recovery_required", "The closed execution changed owner before its process stop.");
      }
    };
    const retirement = this.retireUnfinishedExecution(admission, assertCurrent, "session_close", async () => {
      // This runs from inside the session's close; wait for it (and any
      // bootstrap it interrupted) to finish before touching the record.
      await Promise.allSettled([session.close(reason)]);
      await this.bootstrapping.get(key)?.catch(() => undefined);
    });
    void retirement.catch(error => {
      this.logger.warn({ event: "execution.close_stop_unconfirmed", assignmentId, attempt, claimId: admission.claimId, reason,
        stage: "session_close", code: error instanceof RemoteInstanceError ? error.code : "unexpected_error" },
      "the closed turn's process could not be confirmed stopped; the next turn of its session retries");
    });
  }

  /**
   * Stop an unfinished execution's retained process and mark it `stopping` →
   * `process_stopped` → `interrupted_unqualified`, the retained recovery stop's
   * sequence. The runner's restart-only stop refuses a process identity that
   * is still live under a current local owner. Never touches the workspace:
   * generated changes stay; only the agent's in-session history is lost.
   * Resolves false when there is nothing this can prove (no record, no
   * process owner, a continued record, no stop support).
   */
  private retireUnfinishedExecution(admission: LocalAdmission, assertCurrent: () => void, stage: "session_close" | "channel_handoff",
    before?: () => Promise<void>): Promise<boolean> {
    const generation = admission.executionGeneration;
    const existing = this.executionRetirements.get(generation);
    if (existing) return existing;
    const task = this.retireExecution(admission, assertCurrent, stage, before);
    this.executionRetirements.set(generation, task);
    const clear = () => { if (this.executionRetirements.get(generation) === task) this.executionRetirements.delete(generation); };
    void task.then(clear, clear);
    return task;
  }

  private async retireExecution(admission: LocalAdmission, assertCurrent: () => void, stage: "session_close" | "channel_handoff", before?: () => Promise<void>): Promise<boolean> {
    await before?.();
    const execution = this.deps.journal.execution.execution(admission);
    if (execution?.phase === "interrupted_unqualified") return true;
    const owner = this.retirementOwner(admission, execution);
    if (!owner) return false;
    assertCurrent();
    await this.deps.journal.execution.markStopping(admission, this.deps.clock.nowIso(), assertCurrent);
    if (owner.phase !== "process_stopped") {
      await owner.stop(owner.processOwner);
      assertCurrent();
      await this.deps.journal.execution.markProcessStopped(admission, this.deps.clock.nowIso(), assertCurrent);
    }
    await this.deps.journal.execution.markInterruptedWithoutQuiescence(admission, this.deps.clock.nowIso(), assertCurrent);
    this.logger.info({ event: "execution.unfinished_retired", assignmentId: admission.assignmentId, attempt: admission.attempt,
      claimId: admission.claimId, stage, outcome: "interrupted_without_quiescence" },
    "the unfinished turn's process is gone; its session's next turn starts fresh");
    return true;
  }

  /** An unfinished execution with a retained process, and a runner that can stop it. */
  private retirementOwner(admission: LocalAdmission, execution: LocalExecution | undefined): { phase: LocalExecution["phase"]; processOwner: RetainedProcessOwner; stop: (owner: RetainedProcessOwner) => Promise<unknown> } | null {
    if (!execution || !UNFINISHED_PHASES.has(execution.phase) || !execution.processOwner) return null;
    const runner = this.deps.runners.get(admission.agentId);
    if (!runner?.stopRetainedExecution) return null;
    return { phase: execution.phase, processOwner: execution.processOwner, stop: runner.stopRetainedExecution.bind(runner) };
  }

  /** The idle reaper may settle a completed role session before a later
   * preserved-change review is requested. The review still has to run, but it
   * cannot restore an ACP process that was deliberately retired. Permit a
   * fresh process only for the exact acknowledged head named as predecessor;
   * repository, task, role, agent and model identity remain unchanged. */
  private canStartFreshAfterSettledHarnessPredecessor(successor: RemoteWorkAssignment): boolean {
    if (!harnessDelivery(successor) || !successor.source.turn.predecessor) return false;
    const settled = this.settledRoleHead(successor);
    if (!settled) return false;
    const turn = settled.predecessor.source.turn;
    if (jcsDigest({ invocationId: turn.invocationId, dispatchGeneration: turn.dispatchGeneration } as JsonValue) !==
          jcsDigest(successor.source.turn.predecessor as JsonValue)) return false;
    return this.acknowledgedHead(settled.head);
  }

  /** The role's head, ACP-settled, for the same repository role session as this successor. */
  private settledRoleHead(successor: HarnessAssignment): { head: LocalAdmission; predecessor: HarnessAssignment } | null {
    const head = this.deps.journal.execution.harnessRoleHead(successor);
    if (!head || this.deps.journal.execution.execution(head)?.phase !== "acp_settled") return null;
    const predecessor = this.deps.journal.execution.start(head.assignmentId, head.attempt)?.assignment;
    if (!predecessor || !harnessDelivery(predecessor) || !sameHarnessRoleSession(predecessor, successor)) return null;
    return { head, predecessor };
  }

  private acknowledgedHead(head: LocalAdmission): boolean {
    return this.reports.acknowledgedTerminalReport(head.assignmentId, head.attempt, head.claimId) !== undefined;
  }

  /** A new proposal can deliberately start from the repository rather than
   * reuse generated workspace state. That absence of a predecessor is not a
   * licence to discard preserved changes: only an ACP-settled role head whose
   * exact terminal report Core acknowledged may be left behind. */
  private canStartFreshRepositoryAnchorAfterSettledHead(successor: RemoteWorkAssignment): boolean {
    if (!harnessDelivery(successor) || successor.source.turn.predecessor) return false;
    const settled = this.settledRoleHead(successor);
    return settled !== null && this.acknowledgedHead(settled.head);
  }

  /** Release an idle sealed completion, then journal its proven stop. */
  private async stopCompletedOwner(prior: LocalAdmission, ref: string, processOwner: RetainedProcessOwner, assertCurrent: () => void): Promise<void> {
    const runner = this.deps.runners.get(prior.agentId);
    if (!runner?.releaseSealedSession || !runner.stopRetainedExecution) throw new RemoteInstanceError("recovery_required", "The previous turn's session cannot be stopped by its runner.");
    // Release first: a predecessor that is not an idle sealed completion is
    // refused before its journaled execution changes. Recovery stop is not
    // used here; its ownership check rejects a closed completed owner.
    const released = await runner.releaseSealedSession(ref);
    await this.deps.journal.execution.markStopping(prior, this.deps.clock.nowIso(), assertCurrent);
    if (released?.processRetained) {
      // The runtime kept the idle process resident for the next session, so
      // there is no process exit to prove for this generation: its ACP owner
      // is settled and its reference stays fenced, exactly as after a live
      // recovery stop. Signalling the retained owner here would kill the
      // process the next turn is about to reuse.
      this.logger.info({ assignmentId: prior.assignmentId, attempt: prior.attempt, stage: "channel_handoff", outcome: "process_retained" },
        "the released session's agent process stays resident for the next session");
    } else {
      // The retained process owner proves the whole process group exited.
      await runner.stopRetainedExecution(processOwner);
      await this.deps.journal.execution.markProcessStopped(prior, this.deps.clock.nowIso(), assertCurrent);
    }
    await this.deps.journal.execution.markAcpSettled(prior, ref, this.deps.clock.nowIso(), assertCurrent);
  }

  /**
   * bb's idle reaper: release completed conversation sessions nobody has
   * continued for `idleMs`, so their agent processes do not accumulate. Only
   * a closed, reported, settled completion qualifies; the next turn then
   * starts a fresh session (Konteks supplies the conversation input).
   */
  async reapIdleCompletedSessions(idleMs: number): Promise<number> {
    let reaped = 0;
    const now = this.deps.clock.now();
    for (const [channelId, owner] of [...this.channelOwners]) {
      const idle = this.idleCompletedSession(owner, now, idleMs);
      if (idle && await this.releaseIdleSession(channelId, owner, idle, now)) reaped += 1;
    }
    return reaped;
  }

  /** A closed, reported completion settled at least `idleMs` ago whose execution still holds its process. */
  private idleCompletedSession(owner: RelayedSession, now: number, idleMs: number): IdleCompletedSession | undefined {
    const prior = this.deps.journal.execution.admission(owner.assignment.id, owner.assignment.attempt);
    const ref = owner.acpSessionRef;
    if (!prior || !ref || !this.closedAndReported(owner)) return undefined;
    const settled = this.settledOpenedExecution(prior, ref);
    if (!settled || now - settled.settledAt < idleMs) return undefined;
    return { prior, ref, ...settled };
  }

  private closedAndReported(owner: RelayedSession): boolean {
    const key = `${owner.assignment.id}:${owner.assignment.attempt}`;
    return owner.isClosed && !this.recoveryFences.has(key) && this.deps.journal.assignments.get(key)?.reports.terminalSequence !== undefined;
  }

  /** The still-opened execution of `ref` whose completed turn settled and that still holds its process. */
  private settledOpenedExecution(prior: LocalAdmission, ref: string): { processOwner: RetainedProcessOwner; settledAt: number } | undefined {
    const execution = this.deps.journal.execution.execution(prior);
    if (execution?.phase !== "opened" || execution.acpSessionRef !== ref) return undefined;
    const { completedTurnSettledAt, processOwner } = execution;
    return completedTurnSettledAt && processOwner ? { processOwner, settledAt: Date.parse(completedTurnSettledAt) } : undefined;
  }

  private async releaseIdleSession(channelId: string, owner: RelayedSession, idle: IdleCompletedSession, now: number): Promise<boolean> {
    const { prior, ref, processOwner } = idle;
    const key = `${owner.assignment.id}:${owner.assignment.attempt}`;
    const assertCurrent = () => {
      this.requireNativeOwner();
      if (this.channelOwners.get(channelId) !== owner || prior.runnerIncarnation !== this.deps.runnerIncarnation?.()) {
        throw new RemoteInstanceError("recovery_required", "The idle session's channel owner changed during release.");
      }
      this.deps.journal.execution.assertAdmission(prior);
    };
    const log = { assignmentId: owner.assignment.id, attempt: owner.assignment.attempt, stage: "idle_reaper" };
    try {
      assertCurrent();
      await this.stopCompletedOwner(prior, ref, processOwner, assertCurrent);
      owner.releaseCompletedChannel();
      if (this.sessions.get(key) === owner) this.sessions.delete(key);
      if (!this.channelOwners.has(channelId) && channelId.startsWith("session:")) this.deps.onSessionReleased?.(channelId.slice("session:".length));
      this.logger.info({ ...log, outcome: "released", idleMs: now - idle.settledAt }, "released an idle completed session");
      return true;
    } catch (error) {
      this.logger.warn({ ...log, outcome: "skipped", ...dispatchErrorIdentity(error), ...errorCodeField(error) },
        "idle completed session could not be released");
      return false;
    }
  }

  private async bootstrapRelayedSession(session: RelayedSession, assignment: RemoteWorkAssignment, entry: JournalEntry,
    admission: LocalAdmission | undefined, assertAuthority: () => void, assertExecutionOwned: () => void): Promise<void> {
    const key = `${assignment.id}:${assignment.attempt}`;
    try {
      const { acpSessionRef } = await session.bootstrap();
      assertExecutionOwned();
      if (session.channelId === null) throw new Error("the bootstrapped session has no authorized channel");
      const sessionChannelId = session.channelId;
      await this.deps.journal.assignments.update(key, current => {
        assertExecutionOwned();
        if (!current || current.claimId !== entry.claimId || current.recoveryEpoch !== entry.recoveryEpoch || !["claimed", "running", "checkpointed"].includes(current.state) || session.isClosed) throw new Error("the bootstrapped claim is no longer active");
        return { ...current, state: "running", acpSessionRef, sessionChannelId, updatedAt: this.deps.clock.nowIso() };
      });
      assertExecutionOwned();
    } catch (error) {
      assertAuthority(); // Rejected IO must not outrun the same generation fence.
      if (this.recoveryFences.has(key)) throw error; // Keep the live retry owner.
      try { await session.disposeFailedBootstrap(); }
      finally {
        assertAuthority();
        if (!this.recoveryFences.has(key) && this.sessions.get(key) === session) this.sessions.delete(key);
      }
      throw error;
    }
  }

  private async onSessionClosed(session: RelayedSession, reason: SessionClosedReason, assertAuthority: () => void): Promise<void> {
    assertAuthority();
    const retainCompletedOwner = reason === "completed";
    const key = `${session.assignment.id}:${session.assignment.attempt}`;
    if (this.recoveryFences.has(key) || this.sessions.get(key) !== session) return;
    const entry = this.deps.journal.assignments.get(key);
    assertAuthority();
    // Registered before the report, so a next turn Core places on that report
    // waits for this stop instead of finding the record still `opened`.
    if (retiresOnClose(entry, session, reason)) this.retireAfterClose(session, reason);
    if (!reportsOnClose(entry)) { if (!retainCompletedOwner) this.sessions.delete(key); return; }
    const usage = session.usage();
    await this.reports.submit({
      assignmentId: session.assignment.id,
      attempt: session.assignment.attempt,
      claimId: entry.claimId,
      draft: { terminal: true, result: closedSessionResult(session, reason), ...(usage ? { usage: [usage] } : {}), ...acpSessionRefField(session.acpSessionRef) },
    });
    assertAuthority();
    if (!retainCompletedOwner) this.forgetSession(key, session);
  }

  /** Drop the session unless a recovery fenced its key or another session replaced it. */
  private forgetSession(key: string, session: RelayedSession): void {
    if (!this.recoveryFences.has(key) && this.sessions.get(key) === session) this.sessions.delete(key);
  }

  /** Session-channel frames are routed by channelId to the owning session. */
  async onSessionMessage(channelId: string, body: unknown): Promise<void> {
    const owner = this.channelOwners.get(channelId);
    if (owner) return owner.onToRuntime(body);
    this.logger.warn({ channelId }, "session frame for an unknown channel");
  }

  async onPermissionAnswer(operation: RemoteAuthorizedOperation, claims: RemoteExecutionOperationPermitClaims, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const owner = this.channelOwners.get(claims.channelId);
    if (!owner || operation.message.kind === "acp" || claims.sender.kind !== "core_permission_answer" ||
      owner.assignment.id !== claims.assignmentId || owner.assignment.attempt !== claims.attempt ||
      owner.acpSessionRef !== claims.acpSessionRef) {
      throw new RemoteInstanceError("execution_fenced", "Exact native pending-answer owner is unavailable.");
    }
    await owner.onCorePermissionAnswer(operation, assertCurrent);
    assertCurrent();
  }

  async onRunnerEvent(event: RunnerEvent): Promise<void> {
    for (const session of this.sessions.values()) await session.onRunnerEvent(event);
    await this.deps.integrationCarrier?.onRunnerEvent(event);
  }

  /** A policy-deferred request reached its deadline unanswered: fail it closed. */
  async onPermissionTimeout(request: PendingHumanRequest): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.acpSessionRef === request.acpSessionRef) await session.onDeadline(request);
    }
  }

  /** A channel reset on a session stream closes it with relay_replay_gap. */
  async onChannelReset(channelId: string): Promise<void> {
    let liveOwner = false;
    for (const session of this.sessions.values()) {
      if (session.channelId !== channelId || session.isClosed) continue;
      liveOwner = true;
      this.logger.warn({ event: "session.replay_gap.interrupt", assignmentId: session.assignment.id,
        attempt: session.assignment.attempt, channelId, stage: "relay_recovery", reason: "relay_replay_gap" },
        "unrecoverable session replay gap; stopping local work and reporting interruption");
      try { await session.close("relay_replay_gap"); }
      catch (error) {
        this.logger.error({ err: error, assignmentId: session.assignment.id, attempt: session.assignment.attempt, channelId },
          "session close after a relay replay gap failed");
      }
    }
    if (liveOwner) return;
    // A connector restart intentionally has no in-memory session owners yet.
    // Preserve channels named by an active journal entry so reconciliation can
    // still resume or interrupt that exact work. Everything else is terminal
    // history: keeping it in relay-state makes an expired replay gap poison
    // every future handshake even though no execution could consume it.
    if (this.deps.journal.activeAssignments().some(entry => entry.sessionChannelId === channelId)) return;
    this.deps.transport.closeChannel(channelId);
  }

  async onCancel(directive: CancelDirective): Promise<void> {
    this.assertSignedCancellation(directive);
    const key = `${directive.assignmentId}:${directive.attempt}`;
    const entry = this.deps.journal.assignments.get(key);
    if (!entry || entry.reports.terminalSequence !== undefined) return;
    if (this.recoveryFences.has(key)) return this.cancelFencedExecution(key, directive);
    const session = this.sessions.get(key);
    if (session) {
      await session.close("cancelled");
      return;
    }
    if (entry.kind === "planning") return; // Hosted settlement supplies the directive-bound terminal winner.
    await this.reports.submit({ assignmentId: directive.assignmentId, attempt: directive.attempt, claimId: entry.claimId, draft: { terminal: true, result: { class: "cancelled", reason: directive.reason, terminalResultHash: jcsDigest({ class: "cancelled", reason: directive.reason }) } } });
  }

  private assertSignedCancellation(directive: CancelDirective): void {
    const parsed = CancelDirectiveSchema.safeParse(directive);
    if (!parsed.success || this.deps.verifyCancellation?.(parsed.data) !== true) {
      throw new RemoteInstanceError("permission_denied", "Core cancellation signature is required");
    }
  }

  /**
   * An execution whose authority was lost and that is not settled yet (its
   * stop did not finish): Core's stop ends it the same way, now, with the
   * cancellation as its result; a failure keeps retrying. Any other fence
   * belongs to a recovery that reports the claim itself.
   */
  private async cancelFencedExecution(key: string, directive: CancelDirective): Promise<void> {
    const settlement = this.lostAuthority.get(key);
    if (!settlement) return;
    settlement.nextAt = 0;
    await this.recoverLostExecutionAuthority(directive.assignmentId, directive.attempt, directive.reason).catch(() => undefined);
  }

  /** Drain: no new pulls; open sessions close with `drain` after the caller's grace. */
  async cancelLocalSession(assignmentId: string, attempt: number): Promise<void> {
    await this.sessions.get(`${assignmentId}:${attempt}`)?.close("cancelled");
  }

  /**
   * The session's execution authority was lost: settle that execution on its
   * own. One attempt runs now; a failed attempt (an agent that did not settle
   * its cancelled turn in time, a slow process stop, a journal or Core hiccup)
   * is retried on the maintenance tick with exponential backoff and no cap
   * until the claim has a durable terminal report, so a single failure never
   * leaves the claim open and its delivery deadlocked. Every attempt keeps the fences: the attempt never runs again, its
   * reference is never reused, and nothing reports before the exact process
   * is proven gone.
   */
  private recoverLostExecutionAuthority(assignmentId: string, attempt: number, cancelReason?: CancelDirective["reason"]): Promise<void> {
    const key = `${assignmentId}:${attempt}`;
    let settlement = this.lostAuthority.get(key);
    if (!settlement) {
      settlement = { assignmentId, attempt, failures: 0, nextAt: 0, running: null };
      this.lostAuthority.set(key, settlement);
    }
    if (cancelReason !== undefined) settlement.cancelReason = cancelReason;
    return this.runLostAuthoritySettlement(settlement);
  }

  private runLostAuthoritySettlement(settlement: LostAuthoritySettlement): Promise<void> {
    if (settlement.running) return settlement.running;
    const task = (async () => {
      try {
        await this.settleLostExecutionAuthority(settlement);
      } catch (error) {
        this.lostAuthoritySettlementFailed(settlement, error);
        throw error;
      }
      this.forgetLostAuthority(settlement);
      if (settlement.failures > 0) this.logger.info({ event: "execution.lost_authority_settled", assignmentId: settlement.assignmentId,
        attempt: settlement.attempt, failures: settlement.failures }, "The fenced execution is settled after retrying");
    })();
    settlement.running = task;
    void task.finally(() => { if (settlement.running === task) settlement.running = null; }).catch(() => undefined);
    return task;
  }

  /** Schedule the next attempt, or stop retrying a settlement that is no longer this process's. */
  private lostAuthoritySettlementFailed(settlement: LostAuthoritySettlement, error: unknown): void {
    const { assignmentId, attempt } = settlement;
    settlement.failures += 1;
    const delayMs = lostAuthorityRetryDelayMs(settlement.failures);
    settlement.nextAt = this.deps.clock.now() + delayMs;
    if (this.lostAuthorityStillOwned(settlement)) {
      this.logger.warn({ event: "execution.lost_authority_settlement_retry", assignmentId, attempt, failures: settlement.failures,
        retryInMs: delayMs, ...recoveryFailureFields(error) }, "Settling the fenced execution failed; retrying with backoff");
      return;
    }
    this.logger.warn({ event: "execution.lost_authority_settlement_dropped", assignmentId, attempt, failures: settlement.failures,
      ...recoveryFailureFields(error) }, "The fenced execution is no longer this connector's to settle; stopped retrying");
    this.forgetLostAuthority(settlement);
  }

  private forgetLostAuthority(settlement: LostAuthoritySettlement): void {
    const key = `${settlement.assignmentId}:${settlement.attempt}`;
    if (this.lostAuthority.get(key) === settlement) this.lostAuthority.delete(key);
  }

  /** Whether a settlement that failed is still this process's to retry. */
  private lostAuthorityStillOwned(settlement: LostAuthoritySettlement): boolean {
    const { assignmentId, attempt } = settlement;
    const owned = this.ownedClaim(assignmentId, attempt);
    if (!owned) return false;
    return owned.entry.reports.terminalSequence === undefined || !this.reports.hasDurableTerminalReport(assignmentId, attempt, owned.entry.claimId);
  }

  /** The journaled claim and its admission, while this connector instance and runner incarnation own them. */
  private ownedClaim(assignmentId: string, attempt: number): { admission: LocalAdmission; entry: JournalEntry } | undefined {
    const admission = this.deps.journal.execution.admission(assignmentId, attempt);
    const entry = this.deps.journal.assignments.get(`${assignmentId}:${attempt}`);
    if (!admission || !entry || entry.claimId !== admission.claimId) return undefined;
    return this.admissionOwnedHere(admission) ? { admission, entry } : undefined;
  }

  /** Admitted by this instance and workspace under the current runner incarnation. */
  private admissionOwnedHere(admission: LocalAdmission): boolean {
    return admission.runnerIncarnation === this.deps.runnerIncarnation?.() &&
      admission.instanceId === this.deps.instanceId() && admission.workspaceId === this.deps.workspaceId();
  }

  /** The maintenance tick's half of `recoverLostExecutionAuthority`: run every settlement whose backoff is over. */
  private retryLostAuthoritySettlements(): void {
    const now = this.deps.clock.now();
    for (const settlement of [...this.lostAuthority.values()]) {
      if (settlement.running || settlement.nextAt > now) continue;
      void this.runLostAuthoritySettlement(settlement).catch(() => undefined);
    }
  }

  /** Report the interruption only after independent exact-process proof. */
  private async settleLostExecutionAuthority(settlement: LostAuthoritySettlement): Promise<void> {
    const { assignmentId, attempt } = settlement;
    const observedAdmission = this.deps.journal.execution.admission(assignmentId, attempt);
    if (observedAdmission) await this.recordStopUnconfirmed(observedAdmission);
    await this.stopForRecovery(assignmentId, attempt);
    this.requireNativeOwner();
    const owned = this.ownedClaim(assignmentId, attempt);
    if (!owned || this.deps.journal.execution.execution(owned.admission)?.phase !== "interrupted_unqualified") {
      throw new RemoteInstanceError("recovery_required", "Stopped execution evidence is unavailable.");
    }
    this.deps.journal.execution.assertAdmission(owned.admission);
    const { entry } = owned;
    if (entry.reports.terminalSequence !== undefined) {
      if (!this.reports.hasDurableTerminalReport(assignmentId, attempt, entry.claimId)) {
        throw new RemoteInstanceError("recovery_required", "The interrupted report is not yet durable.");
      }
      return;
    }
    // A planning claim's terminal comes only from its hosted controller's
    // directive; the proven stop is all this connector settles for it.
    if (entry.kind === "planning") return;
    await this.reportLostExecution(settlement, entry);
  }

  /**
   * The negative observation must survive even when cancellation never
   * returns. It is not terminal authority and cannot release resources.
   */
  private async recordStopUnconfirmed(observedAdmission: LocalAdmission): Promise<void> {
    const { assignmentId, attempt } = observedAdmission;
    const assertCurrent = () => {
      this.requireNativeOwner();
      if (!this.admissionOwnedHere(observedAdmission)) {
        throw new RemoteInstanceError("recovery_required", "Recovery observer no longer owns this execution.");
      }
      this.deps.journal.execution.assertAdmission(observedAdmission);
    };
    assertCurrent();
    try {
      await this.recordTurnSettledRecoveryEvidence(observedAdmission, assertCurrent, "stop_unconfirmed", false);
      void this.retryRecoveryEvidence().catch(error => {
        this.logger.warn({ assignmentId, attempt, code: recoveryEvidenceFailureCode(error) }, "Recovery evidence delivery remains pending");
      });
    } catch (error) {
      // Diagnostic durability must never suppress the independent stop path.
      this.logger.error({ event: "execution.recovery_observation_persist_failed", assignmentId, attempt,
        code: recoveryEvidenceFailureCode(error), stopClass: "stop_unconfirmed", capacityReleased: false, err: error },
      "Recovery observation could not be persisted; cancellation will still be attempted");
    }
  }

  /** Core asked for this claim to stop: it ends cancelled, as an unfenced one would; otherwise it ends interrupted. */
  private async reportLostExecution(settlement: LostAuthoritySettlement, entry: JournalEntry): Promise<void> {
    const { assignmentId, attempt } = settlement;
    const result = settlement.cancelReason !== undefined
      ? { class: "cancelled" as const, reason: settlement.cancelReason }
      : { class: "interrupted" as const, reason: "agent_session_lost" as const };
    await this.reports.submit({ assignmentId, attempt, claimId: entry.claimId, draft: {
      terminal: true, acpSessionRef: entry.acpSessionRef,
      result: { ...result, terminalResultHash: jcsDigest(result) },
    } });
    this.logger.warn({ event: "execution.interruption_reported", assignmentId, attempt, claimId: entry.claimId,
      phase: "interrupted_unqualified", resultClass: result.class, quiescenceQualified: false, capacityReleased: false },
    "Execution interruption is durable; uncertain operations and background work remain fenced");
  }

  /** Stop/fence the exact local attempt without choosing its terminal result.
   * This is not evidence of absence and writes no absence tombstone.
   */
  stopForRecovery(assignmentId: string, attempt: number, assertRecoveryCurrent?: () => void): Promise<void> {
    const key = `${assignmentId}:${attempt}`;
    const existing = this.recoveryStops.get(key);
    if (existing) return existing;
    this.recoveryFences.add(key);
    this.pendingClaims.delete(key);
    this.pendingClaimFences.delete(key);
    const session = this.sessions.get(key);
    const dispatch = this.dispatching.get(key);
    // Session fencing is synchronous; the task below is registered before any
    // dispatched claim continuation can create or report this attempt again.
    session?.fenceForRecovery();
    const stop: RecoveryStop = { assignmentId, attempt, key, session, dispatch, assertRecoveryCurrent, retained: !session && !dispatch };
    const task = Promise.resolve().then(() => {
      const admission = this.deps.journal.execution.admission(assignmentId, attempt);
      return stop.retained ? this.stopRetainedForRecovery(stop, admission) : this.stopLiveForRecovery(stop, admission);
    });
    this.recoveryStops.set(key, task);
    void task.catch(() => { if (this.recoveryStops.get(key) === task) this.recoveryStops.delete(key); });
    return task;
  }

  /**
   * The admission checked against the current owner, and that check to repeat
   * after every await. A retained execution is current only under a caller's
   * recovery check; a live one only under the runner incarnation that admitted it.
   */
  private ownedRecoveryAdmission(stop: RecoveryStop, admission: LocalAdmission | undefined, message: string): { admission: LocalAdmission; assertCurrent: () => void } {
    const check = (): LocalAdmission => {
      stop.assertRecoveryCurrent?.();
      this.requireNativeOwner();
      if (!admission || !this.recoveryOwnerCurrent(stop, admission)) throw new RemoteInstanceError("recovery_required", message);
      this.deps.journal.execution.assertAdmission(admission);
      return admission;
    };
    return { admission: check(), assertCurrent: () => { check(); } };
  }

  private recoveryOwnerCurrent(stop: RecoveryStop, admission: LocalAdmission): boolean {
    const ownerCurrent = stop.retained ? stop.assertRecoveryCurrent !== undefined : admission.runnerIncarnation === this.deps.runnerIncarnation?.();
    return ownerCurrent && admission.instanceId === this.deps.instanceId() && admission.workspaceId === this.deps.workspaceId() &&
      this.deps.journal.assignments.get(stop.key)?.claimId === admission.claimId;
  }

  /** No live session or dispatch: stop the retained process the journal names, as restart recovery does. */
  private async stopRetainedForRecovery(stop: RecoveryStop, observed: LocalAdmission | undefined): Promise<void> {
    const noOwner = () => new RemoteInstanceError("recovery_required", "No current local owner can prove that the prior attempt stopped.");
    if (!observed) throw noOwner();
    const execution = this.deps.journal.execution.execution(observed);
    if (!execution) return this.settleAdmissionOnly(stop, observed);
    const target = retainedStopTarget(execution, this.deps.runners.get(observed.agentId));
    if (!target) throw noOwner();
    const { admission, assertCurrent } = this.ownedRecoveryAdmission(stop, observed, "No exact current execution owner can settle this claim.");
    await this.recoverRetainedDeliveryOutput(stop, admission, target, assertCurrent);
    await this.deps.journal.execution.markStopping(admission, this.deps.clock.nowIso(), assertCurrent);
    if (target.phase !== "process_stopped") {
      await target.stopProcess();
      assertCurrent();
      await this.deps.journal.execution.markProcessStopped(admission, this.deps.clock.nowIso(), assertCurrent);
    }
    // The bridge may be only a transport adapter to a user-owned Codex
    // app-server. Process-group exit therefore cannot settle the ACP turn,
    // tool calls, or MCP work, and this is deliberately NOT quiescence:
    // the retained reference stays excluded from reuse and no capacity is
    // released. What it does settle is that this attempt cannot continue,
    // so recovery states that and the claim is reported interrupted.
    // Refusing instead would leave a restarted connector unable to finish
    // startup recovery, and the whole runtime offline.
    await this.deps.journal.execution.markInterruptedWithoutQuiescence(admission, this.deps.clock.nowIso(), assertCurrent);
    this.logger.warn({ assignmentId: stop.assignmentId, attempt: stop.attempt, stage: "retained_execution_recovery", outcome: "interrupted_without_quiescence" },
      "retained execution process is gone; reporting the claim interrupted without certifying background work");
  }

  /**
   * Admission is durable before dispatch and execution is durable before any
   * bridge process is opened. Therefore an admission with no execution record
   * proves that no local agent process ever started. The reconciliation
   * decision may safely publish its terminal result without inventing an
   * impossible process owner after restart.
   */
  private settleAdmissionOnly(stop: RecoveryStop, observed: LocalAdmission): void {
    this.ownedRecoveryAdmission(stop, observed, "No exact current admission owner can settle this claim.");
    this.logger.info({ assignmentId: stop.assignmentId, attempt: stop.attempt, stage: "admission_only_recovery", outcome: "never_opened" },
      "claimed admission never opened local execution; no process stop is required");
  }

  /** A retained delivery whose output is already accepted reports it succeeded before its process is stopped. */
  private async recoverRetainedDeliveryOutput(stop: RecoveryStop, admission: LocalAdmission, target: RetainedStopTarget, assertCurrent: () => void): Promise<void> {
    const entry = this.deps.journal.assignments.get(stop.key);
    if (entry?.kind !== "delivery" || entry.reports.terminalSequence !== undefined || !this.deps.recoverPendingDeliveryOutput) return;
    const recovered = await this.deps.recoverPendingDeliveryOutput(admission, { acpSessionRef: target.acpSessionRef, processOwner: target.processOwner });
    assertCurrent();
    if (!recovered) return;
    const semantic = { class: "succeeded" as const, structuredOutput: { nativeDeliveryAcceptance: recovered.receipt } };
    await this.reports.submit({ assignmentId: stop.assignmentId, attempt: stop.attempt, claimId: admission.claimId, draft: { terminal: true,
      result: { ...semantic, terminalResultHash: jcsDigest({ ...semantic, acpSessionRef: recovered.acpSessionRef }) }, acpSessionRef: recovered.acpSessionRef } });
    assertCurrent();
  }

  /** A live session or dispatch: stop its turn, then prove the exact process gone. */
  private async stopLiveForRecovery(stop: RecoveryStop, observed: LocalAdmission | undefined): Promise<void> {
    const { admission, assertCurrent } = this.ownedRecoveryAdmission(stop, observed, "No exact current execution owner can settle this claim.");
    await this.deps.journal.execution.markStopping(admission, this.deps.clock.nowIso(), assertCurrent);
    const settlement = await this.settleFencedTurn(stop, admission);
    if (settlement.settled) {
      await this.deps.journal.execution.markAcpSettled(admission, settlement.acpSessionRef, this.deps.clock.nowIso(), assertCurrent);
      // Recovery evidence observes the already-durable `acp_settled` boundary. It is
      // neither a terminal report nor proof that background tools have stopped.
      await this.recordTurnSettledRecoveryEvidence(admission, assertCurrent);
    }
    const stopped = this.deps.journal.execution.execution(admission);
    const runner = this.deps.runners.get(admission.agentId);
    const target = stopped && runner ? liveStopTarget(stopped, runner) : undefined;
    if (stopped && target) return this.proveFencedProcessStopped(stop, admission, stopped, target, settlement, assertCurrent);
    if (!settlement.settled) throw settlement.error;
    this.blockFencedRecovery(stop, admission, settlement.owner, stopped);
  }

  /**
   * Stop the fenced session, and any session its dispatch created meanwhile.
   * An agent that did not settle its cancelled turn in time (a loaded computer
   * past the ACP stop deadline) or a failed stop is not terminal: the exact
   * process proof still shows this attempt cannot continue, as restart
   * recovery does, so the claim never stays open with its delivery deadlocked.
   */
  private async settleFencedTurn(stop: RecoveryStop, admission: LocalAdmission): Promise<FencedTurnSettlement> {
    const sessionStop = stop.session?.stopForRecovery();
    void sessionStop?.catch(() => undefined);
    await stop.dispatch;
    let owner: RelayedSession | undefined;
    try {
      await sessionStop;
      owner = await this.stopLateSession(stop);
      if (!owner?.acpSessionRef) throw new RemoteInstanceError("recovery_required", "No confirmed ACP session settlement is available.");
      return { settled: true, owner, acpSessionRef: owner.acpSessionRef };
    } catch (error) {
      this.logger.warn({ event: "execution.acp_settlement_unconfirmed", assignmentId: stop.assignmentId, attempt: stop.attempt,
        claimId: admission.claimId, ...recoveryFailureFields(error) },
      "ACP settlement of the fenced turn is unconfirmed; proving its exact process gone instead");
      return { settled: false, owner, error };
    }
  }

  /** A session the dispatch opened after the fence is stopped too; the fenced turn's owner is that one, else the original. */
  private async stopLateSession(stop: RecoveryStop): Promise<RelayedSession | undefined> {
    const late = this.sessions.get(stop.key);
    if (late && late !== stop.session) await late.stopForRecovery();
    return late ?? stop.session;
  }

  /** Apply the same exact-process proof as restart recovery. This only proves interruption, never background-tool quiescence or safe reuse. */
  private async proveFencedProcessStopped(stop: RecoveryStop, admission: LocalAdmission, stopped: ExecutionState, target: LiveStopTarget,
    settlement: FencedTurnSettlement, assertCurrent: () => void): Promise<void> {
    const { assignmentId, attempt } = stop;
    const stopStartedAt = performance.now();
    try { await target.stopProcess(); }
    catch (error) {
      this.logger.warn({ event: "execution.process_stop_unconfirmed", assignmentId, attempt,
        claimId: admission.claimId, acpSessionRef: settlement.owner?.acpSessionRef ?? stopped.acpSessionRef, phase: stopped.phase,
        elapsedMs: Math.round(performance.now() - stopStartedAt),
        code: error instanceof RemoteInstanceError ? error.code : "unexpected_error" },
      "Exact process stop is unconfirmed; no interruption report or capacity release is authorized");
      throw error;
    }
    assertCurrent();
    await this.deps.journal.execution.markProcessStopped(admission, this.deps.clock.nowIso(), assertCurrent);
    await this.deps.journal.execution.markInterruptedWithoutQuiescence(admission, this.deps.clock.nowIso(), assertCurrent);
    this.logger.warn({ event: "execution.recovery_interrupted", assignmentId, attempt, claimId: admission.claimId,
      acpSessionRef: settlement.owner?.acpSessionRef ?? stopped.acpSessionRef, phase: "interrupted_unqualified", quiescenceQualified: false,
      acpSettled: settlement.settled, capacityReleased: false }, "Exact execution process stopped; background work remains unqualified");
  }

  /**
   * Without independent process proof, ACP settlement alone cannot even
   * qualify the interrupted report. Keep the owner for evidence retries.
   */
  private blockFencedRecovery(stop: RecoveryStop, admission: LocalAdmission, owner: RelayedSession, stopped: ExecutionState | undefined): void {
    this.logger.warn({ event: "execution.recovery_blocked", assignmentId: stop.assignmentId, attempt: stop.attempt, claimId: admission.claimId,
      acpSessionRef: owner.acpSessionRef, ...blockedExecutionFields(stopped),
      diagnostic: "lifecycle_quiescence_unqualified", terminalReported: false, capacityReleased: false },
    "ACP turn settled; background work remains unqualified and the execution stays fenced");
    this.deps.journal.execution.assertQuiescent(admission);
  }

  /** Retry only the exact bytes that were first fsynced with the observation. */
  async retryRecoveryEvidence(maxItems = 4): Promise<void> {
    if (!this.deps.recoveryEvidence || this.deps.canSubmitRecoveryEvidence?.() === false) return;
    if (this.recoveryEvidenceRetry) {
      // Do not lose a retry request that arrives while the current sweep is
      // between its due-record snapshot and single-flight cleanup. The active
      // owner performs one more fresh snapshot before releasing the lock.
      this.recoveryEvidenceRetryRequested = true;
      return this.recoveryEvidenceRetry;
    }
    // Defer the sweep by one microtask so the single-flight slot is installed
    // before any synchronous journal snapshot or immediately-settling submit
    // can complete. Without this, a fast failed submit can leave a settled
    // promise in the slot until its cleanup callback runs; a retry in that
    // window joins work that can no longer observe retryRequested.
    const task = Promise.resolve().then(async () => {
      do {
        this.recoveryEvidenceRetryRequested = false;
        const now = this.deps.clock.coreNow();
        const due = this.deps.journal.recoveryEvidence.all()
          .filter(record => record.delivery === "pending" && Date.parse(record.nextAttemptAt) <= now)
          .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
          .slice(0, maxItems);
        for (const record of due) await this.deliverRecoveryEvidence(record);
      } while (this.recoveryEvidenceRetryRequested);
    });
    this.recoveryEvidenceRetry = task;
    void task.finally(() => { if (this.recoveryEvidenceRetry === task) this.recoveryEvidenceRetry = null; }).catch(() => undefined);
    return task;
  }

  private async recordTurnSettledRecoveryEvidence(admission: LocalAdmission, assertCurrent: () => void,
    stopClass: "turn_settled" | "stop_unconfirmed" = "turn_settled", deliver = true): Promise<void> {
    const execution = this.deps.journal.execution.execution(admission);
    const entry = this.deps.journal.assignments.get(`${admission.assignmentId}:${admission.attempt}`);
    const settledAt = observedSettlement(execution, stopClass);
    if (settledAt === undefined || !entry || entry.claimId !== admission.claimId) {
      throw new RemoteInstanceError("recovery_required", "Durable ACP settlement does not match the current claim.");
    }
    const evidence = stopObservationEvidence(admission, entry.recoveryEpoch, stopClass, settledAt, this.deps.clock.now());
    const record = await this.persistRecoveryEvidence(evidence, assertCurrent);
    if (record && deliver) await this.deliverRecoveryEvidence(record, assertCurrent);
  }

  /**
   * A retry reaches the same identity after time has passed. Reuse the first
   * fsynced bytes rather than recalculating recorded time, age or digest.
   */
  private async persistRecoveryEvidence(evidence: RemoteRecoveryEvidence, assertCurrent: () => void): Promise<RecoveryEvidenceRecord | undefined> {
    const key = recoveryEvidenceRecordKey(evidence);
    const existing = this.deps.journal.recoveryEvidence.get(key);
    if (!existing) {
      await this.deps.journal.recoveryEvidence.put({
        evidence,
        delivery: "pending",
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: evidence.recordedAt,
        acceptedAt: null,
        lastFailureCode: null,
        updatedAt: evidence.recordedAt,
      });
    }
    assertCurrent();
    return existing ?? this.deps.journal.recoveryEvidence.get(key);
  }

  private async deliverRecoveryEvidence(record: RecoveryEvidenceRecord, assertCurrent?: () => void): Promise<void> {
    const client = this.deps.recoveryEvidence;
    if (!client || this.deps.canSubmitRecoveryEvidence?.() === false || record.delivery !== "pending") return;
    const key = recoveryEvidenceRecordKey(record);
    const attemptedAt = this.deps.clock.nowIso();
    await this.deps.journal.recoveryEvidence.update(key, current => {
      const same = sameRecoveryEvidence(current, record, "Recovery evidence record changed before delivery.");
      return { ...same, attempts: same.attempts + 1, lastAttemptAt: attemptedAt, updatedAt: attemptedAt };
    });
    try {
      const result = await client.submit({ evidence: structuredClone(record.evidence), connection: this.recoveryEvidenceConnection() });
      assertCurrent?.();
      const acceptedAt = result.acceptedAt;
      await this.deps.journal.recoveryEvidence.update(key, current => {
        const same = sameRecoveryEvidence(current, record, "Recovery evidence record changed after delivery.");
        return { ...same, delivery: result.outcome, acceptedAt, lastFailureCode: null, updatedAt: this.deps.clock.nowIso() };
      });
      this.logger.info({ ...recoveryEvidenceLog(record), outcome: result.outcome }, "recovery stop observation accepted by Core");
    } catch (error) {
      await this.recoveryEvidenceDeliveryFailed(record, key, error);
    }
  }

  private recoveryEvidenceConnection(): RemoteReconciliationConnection {
    return this.deps.recoveryEvidenceConnection?.() ?? { kind: "https" };
  }

  /** Superseded evidence is kept for audit and no longer sent; anything else is retried with backoff. */
  private async recoveryEvidenceDeliveryFailed(record: RecoveryEvidenceRecord, key: string, error: unknown): Promise<void> {
    const failureCode = recoveryEvidenceFailureCode(error);
    const supersededReason = this.recoveryEvidenceSuperseded(record, error);
    if (supersededReason) {
      const supersededAt = this.deps.clock.nowIso();
      await this.deps.journal.recoveryEvidence.update(key, current => {
        const same = sameRecoveryEvidence(current, record, "Recovery evidence record changed after delivery failure.");
        if (same.delivery !== "pending") return same;
        return { ...same, delivery: "superseded", supersededAt, supersededReason, lastFailureCode: failureCode, updatedAt: supersededAt };
      });
      this.logger.info({ ...recoveryEvidenceLog(record), outcome: "superseded", reason: supersededReason, failureCode },
        "recovery stop observation superseded by Core's settled state; kept for audit, no longer sent");
      return;
    }
    const nextAttemptAt = new Date(this.deps.clock.coreNow() + recoveryEvidenceRetryDelayMs(record.attempts)).toISOString();
    await this.deps.journal.recoveryEvidence.update(key, current => {
      const same = sameRecoveryEvidence(current, record, "Recovery evidence record changed after delivery failure.");
      return { ...same, nextAttemptAt, lastFailureCode: failureCode, updatedAt: this.deps.clock.nowIso() };
    });
    this.logger.warn({ ...recoveryEvidenceLog(record), outcome: "pending", failureCode }, "recovery stop observation remains pending Core acknowledgement");
  }

  /**
   * Core refusals that no retry can change. `reconciliation_replay`
   * for bytes observed by a process that is no longer this one: Core accepts
   * evidence only from the current incarnation, so a retired one's can never
   * land. `assignment_conflict` once Core has acknowledged this exact claim's
   * terminal report: Core closed the claim, and a closed claim takes no more
   * evidence. Anything else stays pending and is retried.
   */
  private recoveryEvidenceSuperseded(record: RecoveryEvidenceRecord, error: unknown): "incarnation_retired" | "claim_settled" | null {
    if (!(error instanceof RemoteInstanceError)) return null;
    const { evidence } = record;
    const current = this.deps.runnerIncarnation?.();
    if (error.code === "reconciliation_replay" && current !== undefined && evidence.runnerIncarnation !== current) return "incarnation_retired";
    if (error.code === "assignment_conflict" &&
        this.reports.acknowledgedTerminalReport(evidence.assignmentId, evidence.attempt, evidence.claimId) !== undefined) return "claim_settled";
    return null;
  }

  /** The same retained log serializes admission and exact absence. */
  async cancelAbsentForRecovery(manifest: RemoteInstanceReconciliationManifest, decision: Extract<RecoveryDecision, { action: "cancel" }>, assertCurrent: () => void): Promise<void> {
    const instanceId = this.deps.instanceId(); const workspaceId = this.deps.workspaceId();
    const runnerIncarnation = this.deps.runnerIncarnation?.();
    if (!workspaceId || !runnerIncarnation) throw new RemoteInstanceError("recovery_required", "Native absence requires exact process and workspace ownership.");
    const scope: AbsenceScope = { instanceId, workspaceId, runnerIncarnation };
    const decisionDigest = jcsDigest(decision);
    const assertAbsent = () => {
      assertCurrent(); this.requireNativeOwner();
      const recovery = this.currentAbsenceRecovery(scope, manifest, decisionDigest);
      if (!recovery) throw new RemoteInstanceError("reconciliation_replay", "Absence cancellation is not the current authorized manifest decision.");
      if (this.knownLocally(decision.assignmentId, recovery)) throw new RemoteInstanceError("recovery_required", "Existing local claim, bootstrap or session is not absence.");
    };
    assertAbsent();
    const existing = this.deps.journal.execution.tombstone({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt });
    await this.deps.journal.execution.cancelAbsent({ instanceId, workspaceId, runnerIncarnation, manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt, decisionDigest, cancelledAt: existing?.cancelledAt ?? this.deps.clock.nowIso() }, assertAbsent);
  }

  /** The pending recovery whose manifest carries exactly this cancel decision, while scope and manifest are still current. */
  private currentAbsenceRecovery(scope: AbsenceScope, manifest: RemoteInstanceReconciliationManifest, decisionDigest: string): RuntimeRecoveryRecord | undefined {
    const recovery = this.deps.journal.recovery.current(scope.instanceId, scope.runnerIncarnation);
    if (!this.absenceScopeCurrent(scope, manifest)) return undefined;
    if (recovery?.state !== "pending" || recovery.manifest?.digest !== computeRemoteReconciliationManifestDigest(manifest)) return undefined;
    return manifest.decisions.some(item => item.action === "cancel" && jcsDigest(item) === decisionDigest) ? recovery : undefined;
  }

  private absenceScopeCurrent(scope: AbsenceScope, manifest: RemoteInstanceReconciliationManifest): boolean {
    return scope.instanceId === this.deps.instanceId() && scope.workspaceId === this.deps.workspaceId() &&
      scope.runnerIncarnation === this.deps.runnerIncarnation?.() &&
      manifest.instanceId === scope.instanceId && manifest.runnerIncarnation === scope.runnerIncarnation;
  }

  /** Any local claim, journal entry, pending claim, session, dispatch, recovery stop or queued report for the assignment. */
  private knownLocally(assignmentId: string, recovery: RuntimeRecoveryRecord): boolean {
    return recovery.intent.claims.some(claim => claim.assignmentId === assignmentId) ||
      this.deps.journal.latestAttempt(assignmentId) !== undefined ||
      [...this.pendingClaims.values()].some(item => item.id === assignmentId) ||
      [...this.sessions.values()].some(item => item.assignment.id === assignmentId) ||
      [...this.dispatching.keys(), ...this.recoveryStops.keys()].some(key => key.startsWith(`${assignmentId}:`)) ||
      this.deps.outbox.all("assignment").some(item => namesAssignment(item.body, assignmentId));
  }

  private requireNativeOwner(): void {
    if (!this.deps.runnerIncarnation?.() || !this.deps.assertOwned) throw new RemoteInstanceError("recovery_required", "Native local ownership is unavailable.");
    this.deps.assertOwned();
  }

  /** Every session is asked to close, even after one refuses; the first refusal is then rethrown. */
  async drainSessions(reason: "drain" | "lease_lost"): Promise<void> {
    let refusal: { error: unknown } | null = null;
    for (const session of [...this.sessions.values()]) {
      try { await session.close(reason); }
      catch (error) { refusal ??= { error }; }
    }
    if (refusal) throw refusal.error;
  }

  private async abandon(assignmentId: string, attempt: number, reason: "assignment_conflict"): Promise<void> {
    const session = this.sessions.get(`${assignmentId}:${attempt}`);
    if (session) await session.close("cancelled");
    this.logger.error({ assignmentId, attempt, reason }, "claim halted into recovery_required");
  }

  /**
   * Before a claim reports itself stop-confirmed, its session must be closed
   * and the agent told to stop any prompt still running on it. No session in
   * this process means nothing of this claim runs here.
   */
  private async confirmSessionStopped(assignmentId: string, attempt: number): Promise<void> {
    const session = this.sessions.get(`${assignmentId}:${attempt}`);
    if (session) await session.confirmStopped();
  }

  private async finish(assignmentId: string, attempt: number): Promise<void> {
    this.pendingClaims.delete(`${assignmentId}:${attempt}`);
    this.pendingClaimFences.delete(`${assignmentId}:${attempt}`);
    await this.deps.journal.prune();
  }

  openSessions(): number {
    return this.sessions.size;
  }
}

/** An unexpected dispatch error's class and system-style code; never its message. */
type AdmissionStart = NonNullable<ReturnType<SupervisorJournal["execution"]["start"]>>;
type RetainedClaim = { assignment: RemoteWorkAssignment; start: AdmissionStart; current: JournalEntry };
type ClaimAdmission = { assignment: RemoteWorkAssignment; claim: AssignmentClaim; incarnation: string | undefined; assertAuthority: () => void; assertCurrent: () => void };
type PendingClaimResult = { key: string; result: ClaimResult; assignment: RemoteWorkAssignment; entry: JournalEntry; assertAuthority: () => void };

const PROJECTED_FIELDS = ["assignmentId", "attempt", "claimId", "kind", "placementId", "workspaceId", "agentId", "evidenceUpload", "expiresAt", "latestResumeAt"] as const;

/** An existing projection must carry the complete admission's identity. */
function verifyProjection(entry: JournalEntry, initial: JournalEntry): void {
  for (const field of PROJECTED_FIELDS) {
    if (entry[field] !== initial[field]) throw new RemoteInstanceError("recovery_required", "Existing projection identity conflicts with complete admission.");
  }
}

/** A claim outbox item is the admitted claim, apart from its delivery attempts. */
function verifyClaimOutbox(item: { attempts?: unknown; lastAttemptAt?: unknown } & Record<string, unknown>, expected: object): void {
  const { attempts: _attempts, lastAttemptAt: _lastAttemptAt, ...identity } = item;
  if (jcsDigest(identity as JsonValue) !== jcsDigest(expected as JsonValue)) throw new RemoteInstanceError("recovery_required", "Existing claim outbox conflicts with complete admission.");
}

/** Core refused the pull: nothing was admitted; an obsolete pull origin needs current recovery. */
function refusedPull(refusal: { kind: string; reason?: unknown }, logger: Logger): void {
  if (refusal.kind === "request_obsolete") throw new RemoteInstanceError("reconciliation_replay", "Pull origin was superseded; current recovery is required.");
  logger.info({ reason: refusal.reason }, "Core refused the pull; no assignments were admitted");
}

/** A claim still before its terminal report, in a state a claim result can act on. */
function claimableState(entry: JournalEntry): boolean {
  return entry.reports.terminalSequence === undefined && ["claimed", "running", "checkpointed"].includes(entry.state);
}

/** The row is still the dispatched claim's, at its recovery epoch, without a terminal report. */
function sameDispatchOwner(current: JournalEntry | undefined, entry: JournalEntry): current is JournalEntry {
  return current !== undefined && current.claimId === entry.claimId && current.recoveryEpoch === entry.recoveryEpoch && current.reports.terminalSequence === undefined;
}

/** An ownership refusal interrupts the attempt; anything else is a failed dispatch (agent sign-in named as such). */
function dispatchFailureOutcome(error: unknown): { class: "interrupted"; reason: "agent_session_lost" | "not_resumable" } | { class: "failed"; reason: "agent_auth_required" | "internal" } {
  if (error instanceof RemoteInstanceError && error.code === "recovery_required") {
    return { class: "interrupted", reason: error.diagnostic === "agent_session_lost" ? "agent_session_lost" : "not_resumable" };
  }
  return { class: "failed", reason: error instanceof RemoteInstanceError && error.code === "agent_auth_required" ? "agent_auth_required" : "internal" };
}

/** Bounded identifiers only, never message text (a RemoteInstanceError message can embed bridge output). */
function dispatchFailureDetail(error: unknown): Record<string, unknown> {
  if (!(error instanceof RemoteInstanceError)) return dispatchErrorIdentity(error);
  return error.diagnostic !== undefined ? { detail: error.diagnostic } : {};
}

type HarnessAssignment = RemoteWorkAssignment & { source: Extract<RemoteWorkAssignment["source"], { kind: "harness_delivery" }> };
type Takeover = { reference: string; mode: "live" | "restore" };
type FreshStart = "repository_anchor" | "settled_predecessor" | "unresumable";
type ChannelHandoff = { assignment: RemoteWorkAssignment; admission: LocalAdmission; sessionId: string; channelId: string; predecessor: RelayedSession; assertCurrent: () => void };
type CompletedOwner = { key: string; prior: LocalAdmission; ref: string; processOwner: RetainedProcessOwner };

function harnessDelivery(assignment: RemoteWorkAssignment): assignment is HarnessAssignment {
  return assignment.source.kind === "harness_delivery";
}

/** Why a repository role starts a fresh ACP session, as logged. */
const FRESH_STARTS: Readonly<Record<FreshStart, { outcome: string; message: string }>> = {
  repository_anchor: { outcome: "fresh_repository_anchor", message: "the new cycle is repository-anchored and the previous role session is settled; starting a fresh ACP session" },
  settled_predecessor: { outcome: "fresh_after_settled_predecessor", message: "the exact predecessor session was durably settled; starting a fresh ACP session to preserve the required review" },
  unresumable: { outcome: "discarded_unresumable_predecessor", message: "the repository role's exact predecessor is not resumable; starting a fresh ACP session" },
};

/** The fenced continuation continued the same predecessor turn this successor names, in the same role session. */
function continuesSamePredecessor(fenced: RemoteWorkAssignment, successor: HarnessAssignment): boolean {
  return harnessDelivery(fenced) && sameHarnessRoleSession(fenced, successor) &&
    jcsDigest((fenced.source.turn.predecessor ?? null) as JsonValue) === jcsDigest(successor.source.turn.predecessor as JsonValue);
}

/** A continuation of the same role session that continued exactly this predecessor turn. */
function continuesTurn(continuation: RemoteWorkAssignment, successor: HarnessAssignment, predecessorTurn: { invocationId: string; dispatchGeneration: number }): boolean {
  return harnessDelivery(continuation) && sameHarnessRoleSession(continuation, successor) &&
    continuation.source.turn.predecessor !== undefined && turnIdentity(continuation.source.turn.predecessor) === turnIdentity(predecessorTurn);
}

/** What a dispatch shares with the session it starts: its admission, chosen reference and ownership checks. */
interface NativeDispatch {
  assignment: RemoteWorkAssignment;
  entry: JournalEntry;
  assertAuthority: () => void;
  admission: LocalAdmission | undefined;
  reference: string | undefined;
  takeover: { reference: string; mode: "live" | "restore" } | undefined;
  executionActivated: boolean;
  assertAdmissionCurrent: () => void;
  assertRecoveryOwned: () => void;
  assertExecutionOwned: () => void;
}

type LocalExecution = NonNullable<ReturnType<SupervisorJournal["execution"]["execution"]>>;

function takeoverReferences(takeover: NativeDispatch["takeover"]): { continueReference?: string; restoreReference?: string } {
  if (takeover === undefined) return {};
  return takeover.mode === "live" ? { continueReference: takeover.reference } : { restoreReference: takeover.reference };
}

export function dispatchErrorIdentity(error: unknown): { errorName?: string; errorCode?: string; schemaIssue?: string } {
  const identity: { errorName?: string; errorCode?: string; schemaIssue?: string } = {};
  const name = errorName(error);
  if (name) identity.errorName = name;
  const code = errorCode(error);
  if (code) identity.errorCode = code;
  const schemaIssue = schemaIssueIdentity(error);
  if (schemaIssue) identity.schemaIssue = schemaIssue;
  return identity;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorName(error: unknown): string | undefined {
  const name = error instanceof Error ? error.name : undefined;
  return name && IDENTIFIER.test(name) ? name : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}

/** A bare `ZodError` would hide which local record was refused. Name the first issue by its code, its field path (identifier
 * segments only) and, for this connector's own refinements, their fixed
 * message. Never a received value or a provider message. */
function schemaIssueIdentity(error: unknown): string | undefined {
  const first = firstSchemaIssue(error);
  if (!first) return undefined;
  const path = schemaIssuePath(first.path);
  return `${first.code}${path ? ` at ${path}` : ""}${schemaIssueMessage(first)}`;
}

interface SchemaIssue { code: string; path?: unknown; message?: unknown }

function firstSchemaIssue(error: unknown): SchemaIssue | undefined {
  if (!(error instanceof Error) || error.name !== "ZodError") return undefined;
  const issues = (error as { issues?: unknown }).issues;
  const first = Array.isArray(issues) ? issues[0] as { code?: unknown } | undefined : undefined;
  return first && typeof first.code === "string" && /^[a-z_]{1,32}$/.test(first.code) ? first as SchemaIssue : undefined;
}

/** Identifier and index segments only; anything else shows as `?`. */
function schemaIssuePath(path: unknown): string {
  if (!Array.isArray(path)) return "";
  return path.map(segment => {
    if (typeof segment === "number") return String(segment);
    return typeof segment === "string" && IDENTIFIER.test(segment) ? segment : "?";
  }).join(".");
}

/** This connector's own refinements carry a fixed message; never a provider one. */
function schemaIssueMessage(issue: SchemaIssue): string {
  const ownMessage = issue.code === "custom" && typeof issue.message === "string" &&
    /^[A-Za-z][A-Za-z ,;'-]{0,119}$/.test(issue.message);
  return ownMessage ? `: ${issue.message as string}` : "";
}

/** Execution phases of a turn that ended without completing and was not yet proven stopped. */
const UNFINISHED_PHASES: ReadonlySet<string> = new Set(["opened", "stopping", "process_stopped"]);

/** A turn's identity for predecessor matching: never its own nested predecessor. */
function turnIdentity(turn: { invocationId: string; dispatchGeneration: number }): string {
  return jcsDigest({ invocationId: turn.invocationId, dispatchGeneration: turn.dispatchGeneration } as JsonValue);
}

/** Same repository role session: instance, task, role, agent, model and repository all exact. */
function sameHarnessRoleSession(predecessor: RemoteWorkAssignment, successor: RemoteWorkAssignment): boolean {
  const before = predecessor.source, after = successor.source;
  if (before.kind !== "harness_delivery" || after.kind !== "harness_delivery") return false;
  return sameRoleRoute(predecessor, successor) &&
    before.ownerInstanceId === after.ownerInstanceId &&
    before.executionSessionId === after.executionSessionId &&
    before.repositoryId === after.repositoryId &&
    jcsDigest(before.modelBinding as JsonValue) === jcsDigest(after.modelBinding as JsonValue);
}

/** Same instance, workspace, task, role, agent and model. */
function sameRoleRoute(predecessor: RemoteWorkAssignment, successor: RemoteWorkAssignment): boolean {
  const before = predecessor.agentRoute, after = successor.agentRoute;
  return predecessor.instanceId === successor.instanceId &&
    predecessor.workspaceId === successor.workspaceId &&
    predecessor.taskId === successor.taskId &&
    before.requiredRole === after.requiredRole &&
    before.agentId === after.agentId &&
    before.sessionConfig?.model === after.sessionConfig?.model;
}

/** A harness delivery that closed without completing retires its execution. */
function retiresOnClose(entry: JournalEntry | undefined, session: RelayedSession, reason: SessionClosedReason): boolean {
  return entry !== undefined && reason !== "completed" && session.assignment.source.kind === "harness_delivery";
}

/**
 * A closed session reports its claim's terminal result unless the claim is
 * gone, already reported, or controller-owned: for planning and search the
 * hosted controller owns the terminal decision, and closure is transcript
 * evidence only.
 */
function reportsOnClose(entry: JournalEntry | undefined): entry is JournalEntry {
  return entry !== undefined && entry.reports.terminalSequence === undefined &&
    entry.kind !== "planning" && entry.kind !== "search_generation";
}

/** Terminal results of a session that closed without completing, with the exact fields each hash covers. */
const UNCOMPLETED_CLOSES = {
  cancelled: { result: { class: "cancelled", reason: "user_cancelled" }, hashed: { class: "cancelled" } },
  agent_exited: { result: { class: "failed", reason: "agent_failed" }, hashed: { class: "failed", reason: "agent_failed" } },
  lease_lost: { result: { class: "interrupted", reason: "lease_lost" }, hashed: { class: "interrupted", reason: "lease_lost" } },
  drain: { result: { class: "interrupted", reason: "drain" }, hashed: { class: "interrupted", reason: "drain" } },
  relay_replay_gap: { result: { class: "interrupted", reason: "relay_replay_gap" }, hashed: { class: "interrupted", reason: "relay_replay_gap" } },
} as const satisfies Record<Exclude<SessionClosedReason, "completed">, { result: object; hashed: JsonValue }>;

function closedSessionResult(session: RelayedSession, reason: SessionClosedReason) {
  if (reason !== "completed") {
    const { result, hashed } = UNCOMPLETED_CLOSES[reason];
    return { ...result, terminalResultHash: jcsDigest(hashed) };
  }
  const receipt = session.deliveryAcceptanceReceipt();
  const semantic = { class: "succeeded" as const, ...(receipt ? { structuredOutput: { nativeDeliveryAcceptance: receipt } } : {}) };
  return { ...semantic, terminalResultHash: jcsDigest({ ...semantic, acpSessionRef: session.acpSessionRef }) };
}

function acpSessionRefField(acpSessionRef: string | null | undefined): { acpSessionRef?: string } {
  return acpSessionRef ? { acpSessionRef } : {};
}

interface AbsenceScope {
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly runnerIncarnation: string;
}

function namesAssignment(body: unknown, assignmentId: string): boolean {
  return typeof body === "object" && body !== null && "assignmentId" in body && body.assignmentId === assignmentId;
}

/**
 * When the observed stop happened: the durable ACP settlement for a settled
 * turn, null (the moment of recording) for an unconfirmed stop, undefined
 * when a settled turn has no durable settlement.
 */
function observedSettlement(execution: ExecutionState | undefined, stopClass: "turn_settled" | "stop_unconfirmed"): string | null | undefined {
  if (!execution) return undefined;
  if (stopClass !== "turn_settled") return null;
  return execution.phase === "acp_settled" && execution.acpSettledAt ? execution.acpSettledAt : undefined;
}

/**
 * One clock for the whole record: the schema requires ageMs to equal
 * recordedAt minus observedAt exactly, and acpSettledAt is host time, so
 * Core's fractional skew estimate never enters it.
 */
function stopObservationEvidence(admission: LocalAdmission, recoveryEpoch: number, stopClass: "turn_settled" | "stop_unconfirmed",
  settledAt: string | null, recordedMs: number): RemoteRecoveryEvidence {
  const settledMs = settledAt === null ? recordedMs : Date.parse(settledAt);
  const observedMs = Number.isFinite(settledMs) ? Math.min(settledMs, recordedMs) : recordedMs;
  const semantic = {
    instanceId: admission.instanceId,
    assignmentId: admission.assignmentId,
    attempt: admission.attempt,
    claimId: admission.claimId,
    runnerIncarnation: admission.runnerIncarnation,
    recoveryEpoch,
    evidenceKind: "stop_observation" as const,
    schemaVersion: "remote-recovery-evidence-v1" as const,
    stopClass,
    reason: "ownership_scope_lost" as const,
    observedAt: new Date(observedMs).toISOString(),
    recordedAt: new Date(recordedMs).toISOString(),
    ageMs: recordedMs - observedMs,
    nextRetryAt: new Date(recordedMs + 5_000).toISOString(),
    safeAction: { kind: "retry_later" as const, instanceId: admission.instanceId, agentId: admission.agentId },
    terminalDisposition: "not_terminal" as const,
    quiescenceAssertion: "not_asserted_by_recovery_evidence" as const,
  };
  return { ...semantic, evidenceDigest: computeRemoteRecoveryEvidenceDigest(semantic) } as RemoteRecoveryEvidence;
}

/** The journaled record, refused when it no longer holds the same evidence bytes. */
function sameRecoveryEvidence(current: RecoveryEvidenceRecord | undefined, record: RecoveryEvidenceRecord, message: string): RecoveryEvidenceRecord {
  if (!current || current.evidence.evidenceDigest !== record.evidence.evidenceDigest) throw new RemoteInstanceError("recovery_required", message);
  return current;
}

function recoveryEvidenceLog(record: RecoveryEvidenceRecord): { assignmentId: string; attempt: number; evidenceDigest: string } {
  const { assignmentId, attempt, evidenceDigest } = record.evidence;
  return { assignmentId, attempt, evidenceDigest };
}

type ExecutionState = NonNullable<ReturnType<SupervisorJournal["execution"]["execution"]>>;

/** One `stopForRecovery` call: the attempt, and the live session and dispatch it found when it fenced the key. */
interface RecoveryStop {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly key: string;
  readonly session: RelayedSession | undefined;
  readonly dispatch: Promise<void> | undefined;
  readonly assertRecoveryCurrent: (() => void) | undefined;
  /** Neither a session nor a dispatch: only the journal's retained execution remains. */
  readonly retained: boolean;
}

interface LiveStopTarget {
  readonly stopProcess: () => Promise<void>;
}

interface RetainedStopTarget extends LiveStopTarget {
  readonly phase: string;
  readonly acpSessionRef: string;
  readonly processOwner: RetainedProcessOwner;
}

type FencedTurnSettlement =
  | { readonly settled: true; readonly owner: RelayedSession; readonly acpSessionRef: string }
  | { readonly settled: false; readonly owner: RelayedSession | undefined; readonly error: unknown };

/** A retained execution its runner can stop: the process owner, its ACP session and the runner's stop. */
function retainedStopTarget(execution: ExecutionState, runner: RunnerPort | undefined): RetainedStopTarget | undefined {
  const { processOwner, acpSessionRef } = execution;
  const stopRetained = runner?.stopRetainedExecution;
  if (!processOwner || !acpSessionRef || !stopRetained) return undefined;
  return { phase: execution.phase, acpSessionRef, processOwner, stopProcess: () => stopRetained.call(runner, processOwner) };
}

function liveStopTarget(execution: ExecutionState, runner: RunnerPort): LiveStopTarget | undefined {
  const { processOwner } = execution;
  const stopRetained = runner.stopRetainedExecution;
  if (!processOwner || !stopRetained) return undefined;
  return { stopProcess: () => stopRetained.call(runner, processOwner) };
}

function blockedExecutionFields(stopped: ExecutionState | undefined) {
  if (!stopped) return { phase: undefined, stoppingAt: undefined, acpSettledAt: undefined, lifecycleProfileDigest: null, executionProfileDigest: null };
  return { phase: stopped.phase, stoppingAt: stopped.stoppingAt, acpSettledAt: stopped.acpSettledAt,
    lifecycleProfileDigest: stopped.lifecycleProfileDigest ?? null, executionProfileDigest: stopped.executionProfileDigest ?? null };
}

interface IdleCompletedSession {
  readonly prior: LocalAdmission;
  readonly ref: string;
  readonly processOwner: RetainedProcessOwner;
  /** Host clock time the completed turn settled. */
  readonly settledAt: number;
}

/** A failure's code, diagnostic and bounded reason for a log line; an unexpected error shows only its identity. */
function recoveryFailureFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof RemoteInstanceError)) return { code: "unexpected_error", ...dispatchErrorIdentity(error) };
  return { code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}), reason: error.message.slice(0, 200) };
}

/** The connector's own error code, when the error carries one. */
function errorCodeField(error: unknown): { code?: string } {
  return error instanceof RemoteInstanceError ? { code: error.code } : {};
}

interface LostAuthoritySettlement {
  readonly assignmentId: string;
  readonly attempt: number;
  failures: number;
  /** Host clock time the next retry is due. */
  nextAt: number;
  running: Promise<void> | null;
  /** Core's durable stop directive arrived meanwhile: the claim ends cancelled. */
  cancelReason?: CancelDirective["reason"];
}

/** Backoff between settlement attempts of a fenced execution: 5 s doubling to a 60 s ceiling, never giving up. */
function lostAuthorityRetryDelayMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
}

/** Exponential backoff for an unanswered stop observation: 5 s doubling to a 60 s ceiling. */
function recoveryEvidenceRetryDelayMs(attemptsBefore: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.min(Math.max(0, attemptsBefore), 4));
}

function recoveryEvidenceFailureCode(error: unknown): string {
  if (error instanceof RemoteInstanceError) return error.code.slice(0, 128);
  return "temporarily_unavailable";
}

/** The session label is display-only and Core may rename it between pulls; it is never admission identity. */
function withoutDisplayLabel(assignment: RemoteWorkAssignment): Omit<RemoteWorkAssignment, "sessionLabel"> {
  const { sessionLabel: _label, ...identity } = assignment;
  return identity;
}
