import { randomUUID } from "node:crypto";
import {
  RemoteInstanceError,
  type RemoteAuthorizedOperation,
  type RemoteExecutionOperationPermitClaims,
  ClaimResultSchema,
  RemoteWorkAssignmentSchema,
  ReportAckSchema,
  WorkAvailableSchema,
  CancelDirectiveSchema,
  createLogger,
  jcsDigest,
  computeRemoteReconciliationManifestDigest,
  parseRfc3339,
  type AgentTurnUsageObservation,
  type AssignmentClaim,
  type AssignmentReport,
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
  type RemoteDeliveryAcceptanceReceipt,
  type RecoveryDecision,
} from "@konteks/remote-common";
import type { RunnerEvent } from "@konteks/remote-agent-runner";
import type { LeaseState } from "../lease/lease.js";
import { placedAgentReady, type RoleBinding, type RoleCapabilityInputs } from "../inventory/roles.js";
import type { SupervisorJournal, JournalEntry } from "../state/journal.js";
import type { LocalAdmission } from "../state/local-admission.js";
import type { RetainedProcessOwner } from "@konteks/remote-common";
import type { DurableOutbox } from "../state/outbox.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";
import type { RunnerPort } from "../runner-port.js";
import { RelayedSession, type RelayedSessionDeps, type SessionClosedReason } from "../session/relayed-session.js";
import type { PendingHumanRequest } from "../session/permissions.js";
import { componentForKind, type ComponentAdapter, type ComponentDispatch, type PlatformMcpEntry, type WorkloadDefinition } from "./components.js";
import { intersectEvidencePolicy } from "./evidence.js";
import { ReportSender } from "./report-sender.js";
import type { AssignmentSender } from "./assignment-sender.js";
import { coreChannelId } from "../relay/channel-ids.js";
import { isSearchAssignment, type SearchControllerBoundary } from "./search-assignment-carrier.js";
import { isOnboardWorkAssignment, onboardTerminalResult, type OnboardWorkAssignment, type OnboardWorkCarrier } from "../onboard/carrier.js";

/**
 * Pull → claim → dispatch → report. Core owns admission and placement; the
 * supervisor validates every assignment locally, claims exactly the agent
 * Core placed (D100), intersects evidence policy most-restrictively, and
 * refuses the closed list of unacceptable work. It never runs peer election
 * or a global balancer.
 */
export type ClaimRejection =
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

export interface OrchestratorDeps {
  deploymentKind?: "appliance" | "native_connector";
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
  browserToolAvailable: () => boolean;
  /**
   * Non-agent facts a role depends on (the browser tool, the machine's git).
   * Optional: omitted, only the browser-tool fact is known, so a role that
   * needs anything else is refused rather than claimed.
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
  /** Recover an already-frozen delivery result before restart recovery can
   * classify the now-gone bridge process as interrupted. The callback must
   * prove the exact admission, retained execution and candidate itself. */
  recoverPendingDeliveryOutput?: (admission: LocalAdmission, execution: {
    acpSessionRef: string | null;
    processOwner: import("@konteks/remote-common").RetainedProcessOwner | undefined;
  }) => Promise<{ acpSessionRef: string; receipt: RemoteDeliveryAcceptanceReceipt } | null>;
  headroom: () => number;
  maxPullItems: number;
  components: Partial<Record<"harness" | "validation_runtime", ComponentAdapter>>;
  /** The instance's soft concurrency ceiling, carried into each component's effective policy. */
  softMaxConcurrent: () => number | undefined;
  /** The pinned bridge digest the runner serves for a placed agent, from the verified release manifest. */
  bridgeDigest: (agentId: string) => string | undefined;
  /** Redeems `mcpCapabilityTokenRef` at dispatch. The entry lives in memory and in the component's dispatch body only — never journaled. */
  redeemPlatformMcp: (assignment: RemoteWorkAssignment) => Promise<PlatformMcpEntry | undefined>;
  /** Reads the claimed assignment's work definition from Core (the Harness needs it in the envelope). */
  fetchWorkload: (assignment: RemoteWorkAssignment) => Promise<WorkloadDefinition>;
  runners: Map<string, RunnerPort>;
  sessionDeps: (assignment: RemoteWorkAssignment, runner: RunnerPort) => Omit<RelayedSessionDeps, "onClosed" | "onUsage">;
  onUsage: (observation: AgentTurnUsageObservation) => Promise<void>;
  gatewayBind: (agentId: string, assignment: RemoteWorkAssignment) => Promise<void>;
  gatewayRelease: (agentId: string) => Promise<void>;
  searchController?: SearchControllerBoundary;
  /** Present on a runtime tagged `onboard`; absent, both kinds are refused. */
  onboardCarrier?: Pick<OnboardWorkCarrier, "execute">;
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
  private readonly recoveryStops = new Map<string, Promise<void>>();
  private readonly recoveryFences = new Set<string>();
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
      canSend: () => deps.deploymentKind !== "native_connector" || deps.reportDeliveryAllowed?.() === true,
      onConflict: async (assignmentId, attempt) => this.abandon(assignmentId, attempt, "assignment_conflict"),
      onTerminalDurable: async (assignmentId, attempt) => this.finish(assignmentId, attempt),
    });
  }

  activeAssignmentIds(): string[] {
    return this.deps.journal.activeAssignments().map((entry) => entry.assignmentId);
  }

  activeCount(): number {
    return this.deps.journal.activeAssignments().length;
  }

  /** Resolve existing original ownership; absent maps never establish authority. */
  capturePendingClaimAuthority(admission: LocalAdmission): () => void {
    const key = `${admission.assignmentId}:${admission.attempt}`;
    const original = this.pendingClaimFences.get(key), assignment = this.pendingClaims.get(key);
    const start = this.deps.journal.execution.start(admission.assignmentId, admission.attempt);
    const current = this.deps.journal.assignments.get(key);
    if (!original || !assignment || !start || !current || this.recoveryFences.has(key) ||
      jcsDigest(start.admission) !== jcsDigest(admission) || admission.runnerIncarnation !== this.deps.runnerIncarnation?.() ||
      assignment.instanceId !== admission.instanceId || assignment.workspaceId !== admission.workspaceId || assignment.agentRoute.agentId !== admission.agentId ||
      jcsDigest(current as JsonValue) !== jcsDigest(this.journalEntry(assignment, admission.claimId, "claimed", start.projectionCreatedAt, start.evidenceUpload) as JsonValue)) {
      this.fenceLostAuthority(key);
      throw new RemoteInstanceError("recovery_required", "Retained claim has no matching original local owner.");
    }
    const assertOriginal = () => {
      original(); this.requireNativeOwner(); this.deps.journal.execution.assertAdmission(admission);
      if (this.recoveryFences.has(key) || admission.instanceId !== this.deps.instanceId() || admission.workspaceId !== this.deps.workspaceId() || admission.runnerIncarnation !== this.deps.runnerIncarnation?.()) throw new RemoteInstanceError("recovery_required", "Claim owner scope changed or its execution was fenced.");
    };
    assertOriginal(); return assertOriginal;
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
    if (isSearchAssignment(assignment) && !this.deps.searchController) return "unknown_kind";
    // A runtime without the onboard lane composed cannot serve either onboard
    // work kind, whatever Core placed. Refusing here is the same answer as
    // never having advertised the role.
    if (isOnboardWorkAssignment(assignment) && !this.deps.onboardCarrier) return "unknown_kind";
    if (this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`)) return "stale_attempt";
    if (this.deps.journal.execution.isCancelled(assignment.id, assignment.attempt)) return "stale_attempt";
    if (!this.deps.acceptedKinds().includes(assignment.kind)) return "unknown_kind";
    if (assignment.instanceId !== this.deps.instanceId()) return "instance_mismatch";
    if (assignment.workspaceId !== this.deps.workspaceId()) return "workspace_mismatch";
    const latest = this.deps.journal.latestAttempt(assignment.id);
    if (latest && latest.attempt > assignment.attempt) return "stale_attempt";
    if (latest && latest.attempt === assignment.attempt && latest.state !== "recovery_required" && latest.state !== "cancelled") return "stale_attempt";
    if (parseRfc3339(assignment.expiresAt) <= this.deps.clock.coreNow()) return "expired";
    if (assignment.source.kind === "harness_task_checkout" && assignment.source.ownerInstanceId !== this.deps.instanceId()) return "checkout_owned_elsewhere";
    if (!this.deps.advertisedRoles().includes(assignment.agentRoute.requiredRole)) return "role_not_advertised";
    if (!placedAgentReady(this.deps.agents(), assignment.agentRoute.agentId, assignment.agentRoute.requiredRole, this.roleCapabilityInputs())) return "agent_unavailable";
    return null;
  }

  private roleCapabilityInputs(): RoleCapabilityInputs {
    return this.deps.roleCapabilityInputs?.() ?? { browserToolAvailable: this.deps.browserToolAvailable() };
  }

  /** Inbound `assignment` channel bodies: work available, claim results, report acks, cancel directives. */
  async onAssignmentMessage(body: unknown, reference?: AssignmentRequestReference): Promise<void> {
    if (!reference) {
      const directive = CancelDirectiveSchema.safeParse(body);
      if (directive.success) return this.onCancel(directive.data);
    }
    if (this.deps.assignmentSender && !reference) throw new RemoteInstanceError("assignment_channel_invalid", "D143 domain replies require their retained operation reference.");
    if (reference) {
      const workspaceId = this.deps.workspaceId();
      const receipt = workspaceId ? this.deps.journal.assignmentStream.replyForRequest({ instanceId: this.deps.instanceId(), workspaceId }, reference) : undefined;
      if (!receipt || jcsDigest(receipt.frame.body.body as JsonValue) !== jcsDigest(body as JsonValue)) throw new RemoteInstanceError("recovery_required", "Domain reply differs from its retained operation.");
      if (receipt.frame.body.requestKind === "claim") {
        const request = this.deps.journal.assignmentStream.request({ instanceId: this.deps.instanceId(), workspaceId: workspaceId! }, reference.requestSequence);
        const verdict = receipt.frame.body.body;
        if ("kind" in verdict || (verdict.outcome === "already_claimed" && verdict.claimId !== request?.admission?.claimId)) return this.onClaimNonDispatch(reference);
      }
      if (receipt.frame.body.requestKind === "pull" && "kind" in receipt.frame.body.body) {
        if (receipt.frame.body.body.kind === "request_obsolete") throw new RemoteInstanceError("reconciliation_replay", "Pull origin was superseded; current recovery is required.");
        this.logger.info({ reason: receipt.frame.body.body.reason }, "Core refused the pull; no assignments were admitted");
        return;
      }
    }
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
    for (const raw of assignments) {
      const parsed = RemoteWorkAssignmentSchema.safeParse(raw);
      if (!parsed.success) {
        this.counters.unknown_kind += 1;
        continue;
      }
      const assignment = parsed.data;
      if (isSearchAssignment(assignment) && !this.deps.searchController) {
        throw new RemoteInstanceError("recovery_required", "Search assignment arrived without its dedicated controller boundary.");
      }
      const retained = this.deps.deploymentKind === "native_connector" ? this.deps.journal.execution.start(assignment.id, assignment.attempt) : undefined;
      if (retained) {
        if (jcsDigest(retained.assignment as JsonValue) !== jcsDigest(assignment as JsonValue)) throw new RemoteInstanceError("recovery_required", "Retained admission assignment changed.");
        await this.reconstructAdmissionProjections(assignment.id, assignment.attempt);
        continue; // Repair is never transport or execution authority.
      }
      const rejection = this.validate(assignment);
      if (rejection !== null) {
        this.counters[rejection] += 1;
        this.logger.info({ assignmentId: assignment.id, rejection }, "assignment not claimed");
        continue;
      }
      if (this.pendingClaims.has(`${assignment.id}:${assignment.attempt}`)) continue;
      const claim: AssignmentClaim = { assignmentId: assignment.id, attempt: assignment.attempt, claimId: randomUUID(), agentId: assignment.agentRoute.agentId };
      const assertAuthority = this.captureNativeAuthority(assignment.id, assignment.attempt);
      const incarnation = this.deps.runnerIncarnation?.();
      const assertCurrent = () => {
        if (this.deps.deploymentKind !== "native_connector") return;
        assertAuthority();
        this.requireNativeOwner();
        if (incarnation !== this.deps.runnerIncarnation?.() || assignment.instanceId !== this.deps.instanceId() || assignment.workspaceId !== this.deps.workspaceId() || this.canPull() !== null || this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`)) throw new RemoteInstanceError("recovery_required", "Claim admission authority changed.");
      };
      if (this.deps.deploymentKind === "native_connector") {
        await this.serializeAdmissionSetup(`${assignment.id}:${assignment.attempt}`, async () => {
          assertCurrent();
          await this.deps.journal.execution.beginAdmission({ schemaVersion: 1, mandatoryOpenVersion: 1,
            admission: { instanceId: assignment.instanceId, workspaceId: assignment.workspaceId, runnerIncarnation: incarnation, assignmentId: assignment.id, attempt: assignment.attempt, claimId: claim.claimId, agentId: claim.agentId, executionGeneration: randomUUID(), openedAt: this.deps.clock.nowIso() },
            assignment, evidenceUpload: intersectEvidencePolicy(this.deps.instanceEvidencePolicy(), assignment.policy.evidenceUpload), projectionCreatedAt: this.deps.clock.nowIso(), claimCreatedAt: this.deps.clock.nowIso(),
          }, assertCurrent);
          assertCurrent();
          await this.reconstructAdmissionProjectionsOwned(assignment.id, assignment.attempt, assertCurrent);
          assertCurrent();
          const start = this.deps.journal.execution.start(assignment.id, assignment.attempt)!;
          const initial = this.journalEntry(assignment, claim.claimId, "claimed", start.projectionCreatedAt, start.evidenceUpload);
          const assertPrepared = () => {
            assertCurrent();
            const current = this.deps.journal.assignments.get(`${assignment.id}:${assignment.attempt}`);
            const queued = this.deps.outbox.all("assignment").find(item => item.id === claim.claimId);
            if (!current || jcsDigest(current as JsonValue) !== jcsDigest(initial as JsonValue) || !queued || queued.key !== `claim:${assignment.id}:${assignment.attempt}` || queued.createdAt !== start.claimCreatedAt || jcsDigest(queued.body as JsonValue) !== jcsDigest(claim as JsonValue)) throw new RemoteInstanceError("recovery_required", "Claim projections no longer prove initial prepared admission.");
          };
          if (this.deps.assignmentSender) await this.deps.assignmentSender.prepareClaim(start.admission, assertPrepared);
          else await this.deps.journal.execution.reserveAllocation(start.admission, assertPrepared);
          this.pendingClaims.set(`${assignment.id}:${assignment.attempt}`, assignment);
          this.pendingClaimFences.set(`${assignment.id}:${assignment.attempt}`, assertAuthority);
          assertPrepared();
          if (this.deps.assignmentSender) this.deps.assignmentSender.scheduleRetained(message => { assertAuthority(); this.deps.transport.send(message); });
          else this.deps.transport.send({ channel: "assignment", channelId: coreChannelId("assignment", this.deps.instanceId()), body: claim });
        });
        continue;
      }
      this.pendingClaims.set(`${assignment.id}:${assignment.attempt}`, assignment);
      await this.deps.outbox.enqueue({ id: claim.claimId, channel: "assignment", key: `claim:${assignment.id}:${assignment.attempt}`, group: `claim:${assignment.id}:${assignment.attempt}`, order: 0, body: claim, createdAt: this.deps.clock.nowIso() });
      assertCurrent();
      await this.deps.journal.assignments.put(this.journalEntry(assignment, claim.claimId, "claimed"));
      assertCurrent();
      this.deps.transport.send({ channel: "assignment", channelId: coreChannelId("assignment", this.deps.instanceId()), body: claim });
    }
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
    const incarnation = this.deps.runnerIncarnation?.();
    const check = () => {
      assertContinuation();
      this.requireNativeOwner();
      if (incarnation !== this.deps.runnerIncarnation?.() || start.admission.instanceId !== this.deps.instanceId() || start.admission.workspaceId !== this.deps.workspaceId()) throw new RemoteInstanceError("recovery_required", "Projection repair ownership changed.");
      this.deps.journal.execution.assertAdmission(start.admission);
      const current = this.deps.journal.execution.start(assignmentId, attempt);
      if (!current || jcsDigest(current as JsonValue) !== jcsDigest(start as JsonValue)) throw new RemoteInstanceError("recovery_required", "Complete admission changed during projection repair.");
    };
    check();
    const { assignment, admission } = start;
    const key = `${assignmentId}:${attempt}`;
    const initial = this.journalEntry(assignment, admission.claimId, "claimed", start.projectionCreatedAt, start.evidenceUpload);
    const verify = (entry: JournalEntry) => {
      for (const field of ["assignmentId", "attempt", "claimId", "kind", "placementId", "workspaceId", "agentId", "evidenceUpload", "expiresAt", "latestResumeAt"] as const) {
        if (entry[field] !== initial[field]) throw new RemoteInstanceError("recovery_required", "Existing projection identity conflicts with complete admission.");
      }
    };
    const existing = this.deps.journal.assignments.get(key);
    if (existing) verify(existing);
    if (!existing && start.delivery === "allocation_reserved") throw new RemoteInstanceError("recovery_required", "Reserved admission has unknown assignment projection history.");
    const claim: AssignmentClaim = { assignmentId, attempt, claimId: admission.claimId, agentId: admission.agentId };
    const expected = { id: admission.claimId, channel: "assignment" as const, key: `claim:${key}`, group: `claim:${key}`, order: 0, body: claim, createdAt: start.claimCreatedAt };
    const verifyOutbox = (item: ReturnType<DurableOutbox["all"]>[number]) => {
      const { attempts: _attempts, lastAttemptAt: _lastAttemptAt, ...identity } = item;
      if (jcsDigest(identity as JsonValue) !== jcsDigest(expected as JsonValue)) throw new RemoteInstanceError("recovery_required", "Existing claim outbox conflicts with complete admission.");
    };
    const priorItems = this.deps.outbox.all().filter(item => item.key === expected.key || item.id === expected.id);
    for (const item of priorItems) verifyOutbox(item);
    const initialOnly = !existing || jcsDigest(existing as JsonValue) === jcsDigest(initial as JsonValue);
    if (!priorItems.length && start.delivery === "unallocated" && initialOnly) {
      verifyOutbox(await this.deps.outbox.enqueue(expected));
      check();
    }
    await this.deps.journal.assignments.update(key, current => {
      check();
      if (current) { verify(current); return current; }
      if (start.delivery !== "unallocated") throw new RemoteInstanceError("recovery_required", "Unknown reserved assignment history.");
      return initial;
    });
    check();
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
    const unhandled = () => {
      if (this.deps.assignmentSender) {
        this.fenceLostAuthority(key);
        throw new RemoteInstanceError("recovery_required", "Claim effect has no exact current pending admission owner.");
      }
    };
    if (this.deps.journal.execution.isCancelled(result.assignmentId, result.attempt) || this.recoveryFences.has(key)) return unhandled();
    const assignment = this.pendingClaims.get(key);
    let entry = this.deps.journal.assignments.get(key);
    if (!assignment || !entry || entry.claimId !== result.claimId) {
      if (result.outcome === "claimed") this.logger.warn({ assignmentId: result.assignmentId }, "claim result for an unknown pending claim");
      return unhandled();
    }
    const assertAuthority = this.deps.deploymentKind === "native_connector" ? this.pendingClaimFences.get(key) : () => undefined;
    if (!assertAuthority) { this.fenceLostAuthority(key); throw new RemoteInstanceError("recovery_required", "Pending claim has no original accepted generation."); }
    assertAuthority();
    if (this.deps.deploymentKind === "native_connector") {
      this.requireNativeOwner();
      const admission = this.deps.journal.execution.admission(result.assignmentId, result.attempt);
      if (!admission || admission.claimId !== result.claimId || admission.instanceId !== assignment.instanceId || admission.workspaceId !== assignment.workspaceId || admission.agentId !== assignment.agentRoute.agentId || admission.runnerIncarnation !== this.deps.runnerIncarnation?.()) return unhandled();
      this.deps.journal.execution.assertAdmission(admission);
      const start = this.deps.journal.execution.start(result.assignmentId, result.attempt);
      if (start && (this.deps.assignmentSender ? start.delivery !== "allocated" || !reference ||
        jcsDigest(start.allocation as JsonValue) !== jcsDigest(reference) || start.claimEffect?.state !== "applying" : start.delivery !== "allocation_reserved")) return unhandled();
      if (this.deps.assignmentSender && !start) return unhandled();
    }
    // Retire only the correlated claim, not all items sharing its assignment key.
    await this.deps.outbox.ack(result.claimId);
    assertAuthority();
    if (this.deps.journal.execution.isCancelled(result.assignmentId, result.attempt) || this.recoveryFences.has(key) || this.pendingClaims.get(key) !== assignment || this.deps.journal.assignments.get(key)?.claimId !== result.claimId) return unhandled();
    entry = this.deps.journal.assignments.get(key)!;
    const retirePending = () => { this.pendingClaims.delete(key); this.pendingClaimFences.delete(key); };
    if (entry.reports.terminalSequence !== undefined || !["claimed", "running", "checkpointed"].includes(entry.state)) { unhandled(); retirePending(); return; }
    switch (result.outcome) {
      case "claimed":
      case "already_claimed":
        retirePending();
        if (isSearchAssignment(assignment)) {
          if (!this.deps.searchController) throw new RemoteInstanceError("recovery_required", "Search controller boundary became unavailable.");
          const start = this.deps.journal.execution.start(assignment.id, assignment.attempt);
          if (!start) throw new RemoteInstanceError("recovery_required", "Search claim lost its durable admission.");
          await this.deps.searchController.acceptClaimed({ assignment, admission: start.admission });
          // Search remains cloud-controller-owned, but its selected ACP process
          // is local. Reuse the canonical claim-bound RelayedSession bootstrap
          // so readiness, input staging, MCP redemption and the execution
          // session channel are established before the hosted controller can
          // acquire prompt authority.
          await this.dispatch(assignment, entry, assertAuthority);
          return;
        }
        await this.dispatch(assignment, entry, assertAuthority);
        return;
      case "agent_unavailable_replaced":
      case "cancelled":
      case "expired":
      case "denied":
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
        retirePending();
        return;
    }
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
    if (this.deps.deploymentKind !== "native_connector") return () => undefined;
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
    const target = this.deps.deploymentKind === "native_connector" || isSearchAssignment(assignment)
      ? "agent_runner"
      : componentForKind(assignment.kind);
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
      if (this.deps.deploymentKind === "native_connector" || target === "agent_runner") {
        await this.startRelayedSession(assignment, entry, assertAuthority);
      } else {
        const component = this.deps.components[target];
        if (!component) throw new Error("local domain component is not installed");
        await component.dispatch(await this.dispatchRequest(assignment, entry, target));
        await this.deps.journal.assignments.put({ ...entry, state: "running", updatedAt: this.deps.clock.nowIso() });
      }
      if (this.deps.deploymentKind !== "native_connector") await this.deps.gatewayBind(assignment.agentRoute.agentId, assignment);
    } catch (error) {
      await this.handleDispatchFailure(assignment, entry, assertAuthority, error);
    }
  }

  private async handleDispatchFailure(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void, error: unknown): Promise<void> {
    try { assertAuthority(); } catch { /* Capture synchronously fenced the exact uncertain owner. */ }
    if (this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`)) return;
    const current = this.deps.journal.assignments.get(`${assignment.id}:${assignment.attempt}`);
    // Cancellation/recovery may have won while bootstrap or cleanup awaited IO.
    if (!current || current.claimId !== entry.claimId || current.recoveryEpoch !== entry.recoveryEpoch || current.reports.terminalSequence !== undefined) return;
    // Bridge/bootstrap exceptions may contain expanded inputs or credentials.
    // Keep the exact owner and bounded failure code, not arbitrary error text.
    this.logger.warn({ workspaceId: assignment.workspaceId, instanceId: assignment.instanceId,
      assignmentId: assignment.id, attempt: assignment.attempt, claimId: entry.claimId,
      correlationId: assignment.correlationId, stage: "assignment_dispatch",
      reason: error instanceof RemoteInstanceError ? error.code : "internal",
      // Bounded identifiers only (never message text — a RemoteInstanceError
      // message can embed bridge output): a refusal names the exact check
      // through its `diagnostic`, since one code (`recovery_required`) is
      // raised from a dozen distinct checks.
      ...(error instanceof RemoteInstanceError
        ? (error.diagnostic !== undefined ? { detail: error.diagnostic } : {})
        : dispatchErrorIdentity(error)),
      sessionContinuation: assignment.source.kind === "conversation" && assignment.source.acpSessionRef !== undefined,
    }, "dispatch failed; reporting");
    if (assignment.kind === "planning" || isSearchAssignment(assignment)) {
      await this.deps.journal.assignments.update(`${assignment.id}:${assignment.attempt}`, latest => {
        if (!latest || latest.claimId !== entry.claimId || latest.recoveryEpoch !== entry.recoveryEpoch || latest.reports.terminalSequence !== undefined) throw new RemoteInstanceError("recovery_required", "Hosted-controller dispatch ownership changed");
        return { ...latest, state: "recovery_required", recoveryReason: "agent_session_lost", updatedAt: this.deps.clock.nowIso() };
      });
      return;
    }
    // Preserve recovery semantics without copying a native exception into the
    // public report. An ownership refusal is not an agent execution failure.
    const outcome = error instanceof RemoteInstanceError && error.code === "recovery_required"
      ? { class: "interrupted" as const, reason: error.diagnostic === "agent_session_lost" ? "agent_session_lost" as const : "not_resumable" as const }
      : { class: "failed" as const, reason: error instanceof RemoteInstanceError && error.code === "agent_auth_required" ? "agent_auth_required" as const : "internal" as const };
    await this.reports.submit({ assignmentId: assignment.id, attempt: assignment.attempt, claimId: entry.claimId, draft: { terminal: true, result: { ...outcome, terminalResultHash: jcsDigest(outcome) } } });
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

  /**
   * Every supervisor-held fact a component may need, assembled once. Each
   * adapter takes the subset its component's envelope declares; the Harness
   * needs the work definition inline, the Validation Runtime asks for its
   * specification lazily, so the workload is read only for the Harness.
   */
  private async dispatchRequest(assignment: RemoteWorkAssignment, entry: JournalEntry, target: "harness" | "validation_runtime"): Promise<ComponentDispatch> {
    const lease = this.deps.lease.current();
    if (!lease) throw new Error("dispatch requires a lease");
    const agent = this.deps.agents().find(view => view.agentId === assignment.agentRoute.agentId);
    if (!agent) throw new Error("the placed agent is no longer connected");
    const platformMcp = await this.deps.redeemPlatformMcp(assignment);
    const bridgeDigest = this.deps.bridgeDigest(assignment.agentRoute.agentId);
    const softMaxConcurrent = this.deps.softMaxConcurrent();
    const workload = target === "harness" ? await this.deps.fetchWorkload(assignment) : undefined;
    return {
      assignment,
      claimId: entry.claimId,
      claimedAt: entry.claimedAt ?? entry.updatedAt,
      effectiveEvidenceUpload: entry.evidenceUpload,
      recoveryEpoch: entry.recoveryEpoch,
      lease: { mode: lease.mode, expiresAt: lease.expiresAt, ...(lease.drainDeadline ? { drainDeadline: lease.drainDeadline } : {}) },
      policy: {
        permissionResponderDeadlineSeconds: assignment.policy.permissionResponderDeadlineSeconds,
        humanDeferralAllowed: assignment.policy.humanDeferralAllowed,
        ...(softMaxConcurrent === undefined ? {} : { softMaxConcurrent }),
      },
      agent,
      browserToolHealthy: this.deps.browserToolAvailable(),
      ...(bridgeDigest ? { bridgeDigest } : {}),
      ...(platformMcp ? { platformMcp } : {}),
      ...(workload ? { workload } : {}),
    };
  }

  private async startRelayedSession(assignment: RemoteWorkAssignment, entry: JournalEntry, assertAuthority: () => void): Promise<void> {
    const admission = this.deps.journal.execution.admission(assignment.id, assignment.attempt);
    let reference: string | undefined;
    let takeover: { reference: string; mode: "live" | "restore" } | undefined;
    let executionActivated = this.deps.deploymentKind !== "native_connector";
    const assertAdmissionCurrent = () => {
      if (this.deps.deploymentKind !== "native_connector") return;
      assertAuthority();
      this.requireNativeOwner();
      if (!admission || this.deps.journal.assignments.get(`${assignment.id}:${assignment.attempt}`)?.claimId !== entry.claimId || admission.claimId !== entry.claimId || admission.runnerIncarnation !== this.deps.runnerIncarnation?.() || admission.instanceId !== this.deps.instanceId() || admission.workspaceId !== this.deps.workspaceId() || admission.agentId !== assignment.agentRoute.agentId || this.recoveryFences.has(`${assignment.id}:${assignment.attempt}`)) throw new RemoteInstanceError("recovery_required", "Native execution has no current durable admission.");
      this.deps.journal.execution.assertAdmission(admission);
    };
    assertAdmissionCurrent();
    const assertExecutionOwned = () => {
      assertAdmissionCurrent();
      if (this.deps.deploymentKind === "native_connector" && executionActivated) this.deps.journal.execution.assertExecutable(admission!, reference);
    };
    assertExecutionOwned();
    const key = `${assignment.id}:${assignment.attempt}`;
    if (this.sessions.has(key)) throw new Error("the assignment already has a local session owner");
    const runner = this.deps.runners.get(assignment.agentRoute.agentId);
    if (!runner) throw new Error("no runner for the placed agent");
    const restoreReference = reference === undefined && assignment.source.kind === "conversation" ? assignment.source.acpSessionRef : undefined;
    const session = new RelayedSession(assignment, {
      ...this.deps.sessionDeps(assignment, runner),
      assertExecutionOwned,
      ...(assignment.kind === "planning" ? {
        beforeSendToCore: async (message) => {
          assertExecutionOwned();
          const state = await this.deps.journal.planning.append(admission!, message);
          assertExecutionOwned();
          return state.sourceSequence;
        },
        assertPromptAllowed: () => { assertExecutionOwned(); this.deps.journal.planning.assertPromptAllowed(admission!); },
      } : {}),
      ...(this.deps.deploymentKind === "native_connector" && restoreReference !== undefined ? { restoreReference } : {}),
      ...(this.deps.deploymentKind === "native_connector" ? { activateExecution: async () => {
        assertAdmissionCurrent();
        // Deliberately after input preparation and capability redemption. A
        // transient cloud failure must leave an idle live ACP predecessor
        // untouched and available to the next attempt.
        takeover = await this.takeOverCompletedChannel(assignment, admission!, assertAdmissionCurrent);
        if (takeover?.mode === "live") reference = takeover.reference;
        if (takeover === undefined) await this.deps.journal.execution.open(admission!, assertAdmissionCurrent, this.deps.clock.nowIso());
        if (assignment.kind === "planning") await this.deps.journal.planning.start(admission!, entry.recoveryEpoch);
        executionActivated = true;
        assertExecutionOwned();
        return {
          ...(takeover?.mode === "live" ? { continueReference: takeover.reference } : {}),
          ...(takeover?.mode === "restore" ? { restoreReference: takeover.reference } : {}),
        };
      } } : {}),
      ...(this.deps.deploymentKind === "native_connector" ? { recordCompletedSettlement: async (ref: string) => {
        assertExecutionOwned();
        await this.deps.journal.execution.markCompletedTurnSettled(admission!, ref, this.deps.clock.nowIso(), assertExecutionOwned);
      }, reserveExecutionReference: async (ref: string) => {
        if (takeover?.mode === "live" && ref === reference) return void assertExecutionOwned();
        await this.deps.journal.execution.bindReference(admission!, ref, assertExecutionOwned);
        reference = ref;
        assertExecutionOwned();
      }, recordExecutionProcessOwner: async owner => {
        await this.deps.journal.execution.bindProcessOwner(admission!, owner, assertExecutionOwned);
        assertExecutionOwned();
      }, replaceExecutionProcessOwner: async (previous, replacement) => {
        await this.deps.journal.execution.replaceBootstrapProcessOwner(admission!, previous, replacement, assertExecutionOwned);
        assertExecutionOwned();
      } } : {}),
      reserveChannel: (channelId, owner) => {
        if (this.channelOwners.has(channelId)) throw new Error("the logical session channel already has a local owner");
        this.channelOwners.set(channelId, owner);
        return () => {
          if (this.channelOwners.get(channelId) === owner) this.channelOwners.delete(channelId);
        };
      },
      onUsage: this.deps.onUsage,
      onExecutionAuthorityLost: () => this.stopForRecovery(assignment.id, assignment.attempt),
      onClosed: async (closed, reason) => this.onSessionClosed(closed, reason, assertAuthority),
    });
    this.sessions.set(key, session);
    // Bootstrap runs off-lane. Its cloud/file preflight may take arbitrarily
    // long without holding assignment delivery; durable local execution
    // activation happens only after that preflight succeeds.
    const bootstrap = this.bootstrapRelayedSession(session, assignment, entry, admission, assertAuthority, assertExecutionOwned);
    this.bootstrapping.set(key, bootstrap);
    void bootstrap.catch(error => this.handleDispatchFailure(assignment, entry, assertAuthority, error))
      .finally(() => { if (this.bootstrapping.get(key) === bootstrap) this.bootstrapping.delete(key); });
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
  private async takeOverCompletedChannel(assignment: RemoteWorkAssignment, admission: LocalAdmission, assertCurrent: () => void): Promise<{ reference: string; mode: "live" | "restore" } | undefined> {
    const source = assignment.source;
    if (source.kind !== "conversation" && source.kind !== "harness_delivery") return undefined;
    const logicalSessionId = source.kind === "conversation" ? source.sessionId : source.executionSessionId;
    const channelId = `session:${logicalSessionId}`;
    const predecessor = this.channelOwners.get(channelId);
    if (!predecessor) {
      // A connector restart removes only the in-memory owner. Core's opaque
      // reference and the runner's credential-volume mapping survive, so the
      // later bootstrap must attempt ACP session/load. The runner fails closed
      // with agent_session_lost if either the mapping or provider state is gone.
      if (source.kind === "conversation" && source.acpSessionRef !== undefined) this.logger.info({ assignmentId: assignment.id, attempt: assignment.attempt, stage: "channel_handoff", outcome: "restore_session" },
        "the conversation's previous session is not live here; restoring it from the durable ACP reference");
      if (source.kind === "harness_delivery") {
        const pendingRestore = this.deps.journal.execution.pendingRestore(admission, assignment);
        if (pendingRestore) return { reference: pendingRestore, mode: "restore" };
        let retained;
        try {
          retained = this.deps.journal.execution.liveContinuation(assignment);
        } catch (error) {
          if (!(error instanceof RemoteInstanceError) || error.code !== "recovery_required" ||
              !this.canStartFreshAfterUnresumableHarnessPredecessor(assignment)) throw error;
          // The exact predecessor has already durably reported that it cannot
          // resume, and no qualified session head exists to transfer. Its old
          // generation/reference remain fenced in the execution journal; do
          // not turn the explicit interruption into a permanent channel
          // conflict. Opening below gives this successor a fresh session/new
          // in the same repository worktree and admitted local boundary.
          this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt,
            stage: "channel_handoff", outcome: "discarded_unresumable_predecessor" },
          "the repository role's exact predecessor is not resumable; starting a fresh ACP session");
          return undefined;
        }
        if (!retained) {
          if (source.turn.predecessor) throw new RemoteInstanceError("assignment_conflict",
            "The repository role's exact predecessor turn is not durably continuable yet.");
          return undefined;
        }
        const priorEntry = this.deps.journal.assignments.get(`${retained.admission.assignmentId}:${retained.admission.attempt}`);
        if (priorEntry?.reports.terminalSequence === undefined) {
          throw new RemoteInstanceError("assignment_conflict", "The repository role's previous turn has not durably completed.");
        }
        const mode = retained.admission.runnerIncarnation === admission.runnerIncarnation ? "live" : "restore";
        const transfer = { predecessor: retained.admission, successor: admission, sessionId: logicalSessionId,
          acpSessionRef: retained.acpSessionRef, processOwner: retained.processOwner, continuedAt: this.deps.clock.nowIso() };
        if (mode === "live") await this.deps.journal.execution.transferLiveContinuation(transfer, assertCurrent);
        else await this.deps.journal.execution.transferRestoredContinuation(transfer, assertCurrent);
        return { reference: retained.acpSessionRef, mode };
      }
      return undefined;
    }
    const key = `${predecessor.assignment.id}:${predecessor.assignment.attempt}`;
    const prior = this.deps.journal.execution.admission(predecessor.assignment.id, predecessor.assignment.attempt);
    const execution = prior ? this.deps.journal.execution.execution(prior) : undefined;
    const ref = predecessor.acpSessionRef;
    if (!predecessor.isClosed) {
      if (source.kind === "harness_delivery") {
        throw new RemoteInstanceError("assignment_conflict",
          "The repository role's previous turn still owns its persistent ACP session.");
      }
      // Core places a conversation turn only while the session has no queued or
      // claimed assignment (AssistantTurnAdmissionService), so a predecessor
      // that is still live HERE is a turn Core has already cancelled or closed
      // — typically a hosted turn that failed before its prompt ever arrived.
      // The cancellation that would have told us needs runtime protocol 2.0,
      // which this connector does not speak yet, so the new turn is the
      // cancellation: refusing it instead pinned the conversation on a zombie
      // owner until the connector restarted (live 2026-09-12).
      this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt, predecessorAssignmentId: predecessor.assignment.id,
        stage: "channel_handoff", outcome: "superseded_live_predecessor" },
        "Core placed a new turn for this conversation while the previous one is still live here; cancelling it and starting a fresh session");
      await predecessor.close("cancelled");
      assertCurrent();
      if (this.channelOwners.get(channelId) === predecessor) this.channelOwners.delete(channelId);
      if (this.sessions.get(key) === predecessor) this.sessions.delete(key);
      return undefined;
    }
    // Closed but its terminal report is still being journaled: a transient
    // state the next attempt clears, so this stays a refusal.
    if (this.deps.journal.assignments.get(key)?.reports.terminalSequence === undefined) {
      throw new RemoteInstanceError("assignment_conflict", "The conversation's previous turn still owns its session channel.");
    }
    // Finished, but not continuable: the journal lost or fenced what a
    // continuation (or a proven stop) needs. Refusing here pinned the channel
    // until the connector restarted, because the idle reaper screens on these
    // same facts and could never reclaim it either. Losing in-agent history is
    // the right price; losing the turn is not — this is bb's behaviour when a
    // thread cannot be restored. If the owner itself refuses release, it is not
    // an idle completion after all and the original refusal stands.
    if (!prior || !ref || this.recoveryFences.has(key) || execution?.phase !== "opened" ||
        execution.acpSessionRef !== ref || execution.completedTurnSettledAt === undefined || !execution.processOwner) {
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
    const processOwner = execution.processOwner;
    const assertPredecessor = () => {
      assertCurrent();
      if (this.channelOwners.get(channelId) !== predecessor || prior.runnerIncarnation !== this.deps.runnerIncarnation?.()) {
        throw new RemoteInstanceError("recovery_required", "The previous turn's channel owner changed during handoff.");
      }
      this.deps.journal.execution.assertAdmission(prior);
    };
    const release = () => {
      predecessor.releaseCompletedChannel();
      if (this.sessions.get(key) === predecessor) this.sessions.delete(key);
    };
    if ((source.kind === "harness_delivery" || source.acpSessionRef === ref) && prior.agentId === admission.agentId) {
      try {
        await this.deps.journal.execution.transferLiveContinuation({ predecessor: prior, successor: admission, sessionId: logicalSessionId,
          acpSessionRef: ref, processOwner, continuedAt: this.deps.clock.nowIso() }, assertPredecessor);
        release();
        return { reference: ref, mode: "live" };
      } catch (error) {
        // The transfer is one atomic journal batch, so a refusal wrote nothing.
        // A continuation the journal cannot prove costs in-agent history, not
        // the turn: stop the idle completion (its process stays resident) and
        // start fresh, exactly as an unusable predecessor is handled above.
        if (!(error instanceof RemoteInstanceError) || error.code !== "recovery_required") throw error;
        if (source.kind === "harness_delivery") throw error;
        this.logger.warn({ assignmentId: assignment.id, attempt: assignment.attempt, predecessorAssignmentId: prior.assignmentId,
          stage: "channel_handoff", outcome: "continuation_unprovable", ...(error.diagnostic !== undefined ? { detail: error.diagnostic } : {}) },
          "the conversation's previous session could not be continued; stopping it and starting a fresh session");
      }
    }
    await this.stopCompletedOwner(prior, ref, processOwner, assertPredecessor);
    release();
    this.logger.info({ assignmentId: assignment.id, attempt: assignment.attempt, predecessorAssignmentId: prior.assignmentId, stage: "channel_handoff", outcome: "predecessor_stopped" },
      "stopped the conversation's idle completed session before a fresh turn");
    return undefined;
  }

  /**
   * A fresh Harness session is safe only when every retained attempt for the
   * declared predecessor turn has durably terminated as not_resumable. The
   * repository, task, role, agent and model boundaries stay exact: this is a
   * lifecycle fallback, never permission to substitute placement or work.
   */
  private canStartFreshAfterUnresumableHarnessPredecessor(successor: RemoteWorkAssignment): boolean {
    if (successor.source.kind !== "harness_delivery" || !successor.source.turn.predecessor) return false;
    // Preserve the discriminant across the filter callback; TypeScript cannot
    // assume a mutable object parameter keeps its narrowed union member.
    const successorSource = successor.source;
    const expectedTurn = successorSource.turn.predecessor;
    const matches = this.deps.journal.assignments.all().filter(entry => {
      const predecessor = this.deps.journal.execution.start(entry.assignmentId, entry.attempt)?.assignment;
      if (!predecessor || predecessor.source.kind !== "harness_delivery") return false;
      return predecessor.instanceId === successor.instanceId &&
        predecessor.workspaceId === successor.workspaceId &&
        predecessor.taskId === successor.taskId &&
        predecessor.agentRoute.requiredRole === successor.agentRoute.requiredRole &&
        predecessor.agentRoute.agentId === successor.agentRoute.agentId &&
        predecessor.agentRoute.sessionConfig?.model === successor.agentRoute.sessionConfig?.model &&
        predecessor.source.ownerInstanceId === successorSource.ownerInstanceId &&
        predecessor.source.executionSessionId === successorSource.executionSessionId &&
        predecessor.source.repositoryId === successorSource.repositoryId &&
        jcsDigest(predecessor.source.modelBinding as JsonValue) === jcsDigest(successorSource.modelBinding as JsonValue) &&
        jcsDigest(predecessor.source.turn as JsonValue) === jcsDigest(expectedTurn as JsonValue);
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
    if (this.deps.deploymentKind !== "native_connector") return 0;
    let reaped = 0;
    const now = this.deps.clock.now();
    for (const [channelId, owner] of [...this.channelOwners]) {
      const key = `${owner.assignment.id}:${owner.assignment.attempt}`;
      const prior = this.deps.journal.execution.admission(owner.assignment.id, owner.assignment.attempt);
      const execution = prior ? this.deps.journal.execution.execution(prior) : undefined;
      const ref = owner.acpSessionRef;
      if (!prior || !ref || !owner.isClosed || this.recoveryFences.has(key) || this.deps.journal.assignments.get(key)?.reports.terminalSequence === undefined ||
          execution?.phase !== "opened" || execution.acpSessionRef !== ref || !execution.completedTurnSettledAt || !execution.processOwner ||
          now - Date.parse(execution.completedTurnSettledAt) < idleMs) continue;
      const assertCurrent = () => {
        this.requireNativeOwner();
        if (this.channelOwners.get(channelId) !== owner || prior.runnerIncarnation !== this.deps.runnerIncarnation?.()) {
          throw new RemoteInstanceError("recovery_required", "The idle session's channel owner changed during release.");
        }
        this.deps.journal.execution.assertAdmission(prior);
      };
      try {
        assertCurrent();
        await this.stopCompletedOwner(prior, ref, execution.processOwner, assertCurrent);
        owner.releaseCompletedChannel();
        if (this.sessions.get(key) === owner) this.sessions.delete(key);
        reaped += 1;
        this.logger.info({ assignmentId: owner.assignment.id, attempt: owner.assignment.attempt, stage: "idle_reaper", outcome: "released",
          idleMs: now - Date.parse(execution.completedTurnSettledAt) }, "released an idle completed session");
      } catch (error) {
        this.logger.warn({ assignmentId: owner.assignment.id, attempt: owner.assignment.attempt, stage: "idle_reaper", outcome: "skipped",
          ...dispatchErrorIdentity(error), ...(error instanceof RemoteInstanceError ? { code: error.code } : {}) }, "idle completed session could not be released");
      }
    }
    return reaped;
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
    const retainCompletedOwner = this.deps.deploymentKind === "native_connector" && reason === "completed";
    const key = `${session.assignment.id}:${session.assignment.attempt}`;
    if (this.recoveryFences.has(key)) return;
    if (this.sessions.get(key) !== session) return;
    const entry = this.deps.journal.assignments.get(key);
    if (this.deps.deploymentKind !== "native_connector") await this.deps.gatewayRelease(session.assignment.agentRoute.agentId);
    assertAuthority();
    if (!entry || entry.reports.terminalSequence !== undefined) { if (!retainCompletedOwner) this.sessions.delete(key); return; }
    if (entry.kind === "planning" || entry.kind === "search_generation") {
      // The hosted controller owns the terminal decision. Session closure is
      // transcript evidence only and cannot independently choose a report.
      if (!retainCompletedOwner) this.sessions.delete(key);
      return;
    }
    const usage = session.usage();
    const draft = (() => {
      switch (reason) {
        case "completed":
          { const receipt = session.deliveryAcceptanceReceipt();
            const semantic = { class: "succeeded" as const, ...(receipt ? { structuredOutput: { nativeDeliveryAcceptance: receipt } } : {}) };
            return { ...semantic, terminalResultHash: jcsDigest({ ...semantic, acpSessionRef: session.acpSessionRef }) }; }
        case "cancelled":
          return { class: "cancelled" as const, reason: "user_cancelled" as const, terminalResultHash: jcsDigest({ class: "cancelled" }) };
        case "agent_exited":
          return { class: "failed" as const, reason: "agent_failed" as const, terminalResultHash: jcsDigest({ class: "failed", reason: "agent_failed" }) };
        case "lease_lost":
          return { class: "interrupted" as const, reason: "lease_lost" as const, terminalResultHash: jcsDigest({ class: "interrupted", reason: "lease_lost" }) };
        case "drain":
          return { class: "interrupted" as const, reason: "drain" as const, terminalResultHash: jcsDigest({ class: "interrupted", reason: "drain" }) };
        case "relay_replay_gap":
          return { class: "interrupted" as const, reason: "relay_replay_gap" as const, terminalResultHash: jcsDigest({ class: "interrupted", reason: "relay_replay_gap" }) };
      }
    })();
    await this.reports.submit({
      assignmentId: session.assignment.id,
      attempt: session.assignment.attempt,
      claimId: entry.claimId,
      draft: { terminal: true, result: draft, ...(usage ? { usage: [usage] } : {}), ...(session.acpSessionRef ? { acpSessionRef: session.acpSessionRef } : {}) },
    });
    assertAuthority();
    if (!retainCompletedOwner && !this.recoveryFences.has(key) && this.sessions.get(key) === session) this.sessions.delete(key);
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
  }

  /** A policy-deferred request reached its deadline unanswered: fail it closed (D87). */
  async onPermissionTimeout(request: PendingHumanRequest): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.acpSessionRef === request.acpSessionRef) await session.onDeadline(request);
    }
  }

  /** A channel reset on a session stream closes it with relay_replay_gap (D99/D107). */
  async onChannelReset(channelId: string): Promise<void> {
    let liveOwner = false;
    for (const session of this.sessions.values()) {
      if (session.channelId !== channelId || session.isClosed) continue;
      liveOwner = true;
      await session.close("relay_replay_gap");
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
    const parsed = CancelDirectiveSchema.safeParse(directive);
    if (!parsed.success || this.deps.verifyCancellation?.(parsed.data) !== true) {
      throw new RemoteInstanceError("permission_denied", "Core cancellation signature is required");
    }
    const key = `${directive.assignmentId}:${directive.attempt}`;
    if (this.recoveryFences.has(key)) return;
    const entry = this.deps.journal.assignments.get(key);
    if (!entry || entry.reports.terminalSequence !== undefined) return;
    const session = this.sessions.get(key);
    if (session) {
      await session.close("cancelled");
      return;
    }
    if (entry.kind === "planning") return; // Hosted settlement supplies the directive-bound terminal winner.
    const target = componentForKind(entry.kind);
    if (target !== "agent_runner" && this.deps.deploymentKind !== "native_connector") await this.deps.components[target]?.cancel(directive.assignmentId, directive.attempt, directive.reason).catch(() => undefined);
    await this.reports.submit({ assignmentId: directive.assignmentId, attempt: directive.attempt, claimId: entry.claimId, draft: { terminal: true, result: { class: "cancelled", reason: directive.reason, terminalResultHash: jcsDigest({ class: "cancelled", reason: directive.reason }) } } });
  }

  /** Drain: no new pulls; open sessions close with `drain` after the caller's grace. */
  async cancelLocalSession(assignmentId: string, attempt: number): Promise<void> {
    await this.sessions.get(`${assignmentId}:${attempt}`)?.close("cancelled");
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
    const task = Promise.resolve().then(async () => {
      const admission = this.deps.journal.execution.admission(assignmentId, attempt);
      const retained = !session && !dispatch;
      const retainedExecution = retained && admission ? this.deps.journal.execution.execution(admission) : undefined;
      const retainedRunner = retained && admission ? this.deps.runners.get(admission.agentId) : undefined;
      if (retained && admission && !retainedExecution) {
        const assertCurrent = () => {
          assertRecoveryCurrent?.();
          this.requireNativeOwner();
          if (!assertRecoveryCurrent || admission.instanceId !== this.deps.instanceId() || admission.workspaceId !== this.deps.workspaceId() || this.deps.journal.assignments.get(key)?.claimId !== admission.claimId) throw new RemoteInstanceError("recovery_required", "No exact current admission owner can settle this claim.");
          this.deps.journal.execution.assertAdmission(admission);
        };
        assertCurrent();
        // Admission is durable before dispatch and execution is durable before
        // any bridge process is opened. Therefore an admission with no
        // execution record proves that no local agent process ever started.
        // The reconciliation decision may safely publish its terminal result
        // without inventing an impossible process owner after restart.
        this.logger.info({ assignmentId, attempt, stage: "admission_only_recovery", outcome: "never_opened" },
          "claimed admission never opened local execution; no process stop is required");
        return;
      }
      if (retained && (!admission || !retainedExecution?.processOwner || !retainedExecution.acpSessionRef || !retainedRunner?.stopRetainedExecution)) {
        throw new RemoteInstanceError("recovery_required", "No current local owner can prove that the prior attempt stopped.");
      }
      const assertCurrent = () => {
        assertRecoveryCurrent?.();
        this.requireNativeOwner();
        if (!admission || admission.instanceId !== this.deps.instanceId() || admission.workspaceId !== this.deps.workspaceId() || (!retained && admission.runnerIncarnation !== this.deps.runnerIncarnation?.()) || (retained && !assertRecoveryCurrent) || this.deps.journal.assignments.get(key)?.claimId !== admission.claimId) throw new RemoteInstanceError("recovery_required", "No exact current execution owner can settle this claim.");
        this.deps.journal.execution.assertAdmission(admission);
      };
      assertCurrent();
      const recoveryEntry = this.deps.journal.assignments.get(key);
      if (retained && recoveryEntry?.kind === "delivery" && recoveryEntry.reports.terminalSequence === undefined && this.deps.recoverPendingDeliveryOutput) {
        const recovered = await this.deps.recoverPendingDeliveryOutput(admission!, {
          acpSessionRef: retainedExecution!.acpSessionRef,
          processOwner: retainedExecution!.processOwner,
        });
        assertCurrent();
        if (recovered) {
          const semantic = { class: "succeeded" as const, structuredOutput: { nativeDeliveryAcceptance: recovered.receipt } };
          await this.reports.submit({ assignmentId, attempt, claimId: admission!.claimId, draft: { terminal: true,
            result: { ...semantic, terminalResultHash: jcsDigest({ ...semantic, acpSessionRef: recovered.acpSessionRef }) }, acpSessionRef: recovered.acpSessionRef } });
          assertCurrent();
        }
      }
      await this.deps.journal.execution.markStopping(admission!, this.deps.clock.nowIso(), assertCurrent);
      if (retained) {
        if (retainedExecution!.phase !== "process_stopped") {
          await retainedRunner!.stopRetainedExecution!(retainedExecution!.processOwner!);
          assertCurrent();
          await this.deps.journal.execution.markProcessStopped(admission!, this.deps.clock.nowIso(), assertCurrent);
        }
        // The bridge may be only a transport adapter to a user-owned Codex
        // app-server. Process-group exit therefore cannot settle the ACP turn,
        // tool calls, or MCP work, and this is deliberately NOT D139 quiescence:
        // the retained reference stays excluded from reuse and no capacity is
        // released. What it does settle is that this attempt cannot continue,
        // so recovery states that and the claim is reported interrupted.
        // Refusing instead left a restarted connector unable to finish startup
        // recovery at all, so the whole runtime stayed offline permanently.
        await this.deps.journal.execution.markInterruptedWithoutQuiescence(admission!, this.deps.clock.nowIso(), assertCurrent);
        this.logger.warn({ assignmentId, attempt, stage: "retained_execution_recovery", outcome: "interrupted_without_quiescence" },
          "retained execution process is gone; reporting the claim interrupted without certifying background work");
        return;
      }
      const sessionStop = session?.stopForRecovery();
      void sessionStop?.catch(() => undefined);
      await dispatch;
      await sessionStop;
      const late = this.sessions.get(key);
      if (late && late !== session) await late.stopForRecovery();
      const owner = late ?? session;
      if (!owner?.acpSessionRef) throw new RemoteInstanceError("recovery_required", "No confirmed ACP session settlement is available.");
      await this.deps.journal.execution.markAcpSettled(admission!, owner.acpSessionRef, this.deps.clock.nowIso(), assertCurrent);
      // Finalization and D139 require a pinned qualified lifecycle profile.
      // None exists yet. Keep the fenced owner for write retries, never report
      // interrupted/cancelled work merely because ACP has settled.
      this.deps.journal.execution.assertQuiescent(admission!);
    });
    this.recoveryStops.set(key, task);
    void task.catch(() => { if (this.recoveryStops.get(key) === task) this.recoveryStops.delete(key); });
    return task;
  }

  /** D141: the same retained log serializes admission and exact absence. */
  async cancelAbsentForRecovery(manifest: RemoteInstanceReconciliationManifest, decision: Extract<RecoveryDecision, { action: "cancel" }>, assertCurrent: () => void): Promise<void> {
    const instanceId = this.deps.instanceId(); const workspaceId = this.deps.workspaceId();
    const runnerIncarnation = this.deps.runnerIncarnation?.();
    if (!workspaceId || !runnerIncarnation) throw new RemoteInstanceError("recovery_required", "Native absence requires exact process and workspace ownership.");
    const decisionDigest = jcsDigest(decision);
    const assertAbsent = () => {
      assertCurrent(); this.requireNativeOwner();
      const recovery = this.deps.journal.recovery.current(instanceId, runnerIncarnation);
      if (instanceId !== this.deps.instanceId() || workspaceId !== this.deps.workspaceId() || runnerIncarnation !== this.deps.runnerIncarnation?.() || manifest.instanceId !== instanceId || manifest.runnerIncarnation !== runnerIncarnation || recovery?.state !== "pending" || recovery.manifest?.digest !== computeRemoteReconciliationManifestDigest(manifest) || !manifest.decisions.some(item => item.action === "cancel" && jcsDigest(item) === decisionDigest)) throw new RemoteInstanceError("reconciliation_replay", "Absence cancellation is not the current authorized manifest decision.");
      if (recovery.intent.claims.some(claim => claim.assignmentId === decision.assignmentId) || this.deps.journal.latestAttempt(decision.assignmentId) || [...this.pendingClaims.values()].some(item => item.id === decision.assignmentId) || [...this.sessions.values()].some(item => item.assignment.id === decision.assignmentId) || [...this.dispatching.keys(), ...this.recoveryStops.keys()].some(key => key.startsWith(`${decision.assignmentId}:`)) || this.deps.outbox.all("assignment").some(item => typeof item.body === "object" && item.body !== null && "assignmentId" in item.body && item.body.assignmentId === decision.assignmentId)) throw new RemoteInstanceError("recovery_required", "Existing local claim, bootstrap or session is not absence.");
    };
    assertAbsent();
    const existing = this.deps.journal.execution.tombstone({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt });
    await this.deps.journal.execution.cancelAbsent({ instanceId, workspaceId, runnerIncarnation, manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt, decisionDigest, cancelledAt: existing?.cancelledAt ?? this.deps.clock.nowIso() }, assertAbsent);
  }

  private requireNativeOwner(): void {
    if (this.deps.deploymentKind !== "native_connector" || !this.deps.runnerIncarnation?.() || !this.deps.assertOwned) throw new RemoteInstanceError("recovery_required", "Native local ownership is unavailable.");
    this.deps.assertOwned();
  }

  async drainSessions(reason: "drain" | "lease_lost"): Promise<void> {
    for (const session of [...this.sessions.values()]) await session.close(reason);
  }

  private async abandon(assignmentId: string, attempt: number, reason: "assignment_conflict"): Promise<void> {
    const session = this.sessions.get(`${assignmentId}:${attempt}`);
    if (session) await session.close("cancelled");
    this.logger.error({ assignmentId, attempt, reason }, "claim halted into recovery_required");
  }

  private async finish(assignmentId: string, attempt: number): Promise<void> {
    this.pendingClaims.delete(`${assignmentId}:${attempt}`);
    this.pendingClaimFences.delete(`${assignmentId}:${attempt}`);
    await this.deps.journal.prune();
  }

  /** Terminal/progress/checkpoint facts posted by Harness/Validation through the internal API. */
  async onComponentTerminal(fact: { assignmentId: string; attempt: number; result: NonNullable<Parameters<ReportSender["submit"]>[0]["draft"]["result"]>; artifacts?: Parameters<ReportSender["submit"]>[0]["draft"]["artifacts"] | undefined; acpSessionRef?: string | undefined }): Promise<void> {
    const entry = this.deps.journal.assignments.get(`${fact.assignmentId}:${fact.attempt}`);
    if (!entry || entry.reports.terminalSequence !== undefined) return;
    await this.deps.gatewayRelease(entry.agentId);
    await this.reports.submit({ assignmentId: fact.assignmentId, attempt: fact.attempt, claimId: entry.claimId, draft: { terminal: true, result: fact.result, ...(fact.artifacts ? { artifacts: fact.artifacts } : {}), ...(fact.acpSessionRef ? { acpSessionRef: fact.acpSessionRef } : {}) } });
  }

  /**
   * A report the component minted itself (both domain components run their own
   * outbox). The supervisor is the `reportSequence` authority for a claim, so
   * the component's identity fields are dropped and the report is re-minted
   * here: one strictly consecutive sequence line per claim, whichever party
   * observed the fact.
   */
  async onComponentReport(report: AssignmentReport): Promise<{ status: "journaled" } | { status: "unknown_assignment" }> {
    const entry = this.deps.journal.assignments.get(`${report.assignmentId}:${report.attempt}`);
    if (!entry) return { status: "unknown_assignment" };
    // A closed claim swallows late reports rather than reopening it; the
    // component's outbox stops resending once it is answered.
    if (entry.reports.terminalSequence !== undefined) return { status: "journaled" };
    const { reportId: _reportId, reportSequence: _reportSequence, payloadDigest: _payloadDigest, reportedAt: _reportedAt, assignmentId: _assignmentId, attempt: _attempt, claimId: _claimId, ...draft } = report;
    if (report.terminal) await this.deps.gatewayRelease(entry.agentId);
    await this.reports.submit({ assignmentId: report.assignmentId, attempt: report.attempt, claimId: entry.claimId, draft });
    return { status: "journaled" };
  }

  async onComponentProgress(fact: { assignmentId: string; attempt: number; structuredOutput?: JsonValue | undefined }): Promise<void> {
    const entry = this.deps.journal.assignments.get(`${fact.assignmentId}:${fact.attempt}`);
    if (!entry || entry.reports.terminalSequence !== undefined) return;
    await this.reports.submit({ assignmentId: fact.assignmentId, attempt: fact.attempt, claimId: entry.claimId, draft: { terminal: false } });
  }

  async onComponentCheckpoint(fact: { assignmentId: string; attempt: number; ref: string; hash: string; createdAt: string }): Promise<void> {
    const entry = this.deps.journal.assignments.get(`${fact.assignmentId}:${fact.attempt}`);
    if (!entry) return;
    await this.deps.journal.assignments.put({ ...entry, state: "checkpointed", checkpoint: { ref: fact.ref, hash: fact.hash, createdAt: fact.createdAt }, updatedAt: this.deps.clock.nowIso() });
  }

  openSessions(): number {
    return this.sessions.size;
  }
}

/** An unexpected dispatch error's class and system-style code; never its message. */
export function dispatchErrorIdentity(error: unknown): { errorName?: string; errorCode?: string } {
  const identity: { errorName?: string; errorCode?: string } = {};
  const name = error instanceof Error ? error.name : undefined;
  if (name && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) identity.errorName = name;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) identity.errorCode = code;
  return identity;
}
