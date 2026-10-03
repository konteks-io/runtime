import { randomUUID } from "node:crypto";
import { RemoteInstanceError, RemoteInstanceReconciliationManifestSchema, allEqual, RemoteReconnectIntentSnapshotSchema, computeRemoteReconciliationManifestDigest, createLogger, jcsDigest, parseRfc3339, type AgentModelOfferedValuesSnapshot, type Clock, type Logger, type RecoveryDecision, type RemoteReconciliationDecisionResult, type PendingClaimRequest, type RemoteReconnectIntentSnapshot, type RemoteReconciliationConnection, type RemoteInstanceReconciliationManifest, type RemoteInstanceReconnectRequest } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { SupervisorJournal, JournalEntry } from "../state/journal.js";
import type { ReportSender } from "../work/report-sender.js";
import type { LeaseAcquisition } from "../lease/lease.js";
import type { RuntimeRecoveryRecord } from "../state/runtime-recovery.js";

/**
 * Reconnect and recovery. On process/host reconnect the
 * supervisor signs a snapshot of its journal, obtains a renewed lease and a
 * reconciliation manifest, journals each decision BEFORE acting, and rejects
 * wrong-instance/attempt/epoch/expired decisions. No new work is pulled and
 * no channel other than `control` opens until reconciliation completes.
 */
export interface ReconciliationDeps {
  clock: Clock;
  journal: SupervisorJournal;
  core: CoreClient;
  instanceId: () => string;
  runnerIncarnation: () => string;
  assertOwned: () => void;
  connection?: () => RemoteReconciliationConnection;
  bundleVersion: string;
  protocolVersion: string;
  lastHeartbeatSequence: () => Promise<number>;
  modelCapabilitySnapshots?: () => readonly AgentModelOfferedValuesSnapshot[];
  reserveHeartbeatFloor: (floor: number) => Promise<unknown>;
  /** Resolves only when this exact local work can no longer execute. */
  stopLocalWork: (assignmentId: string, attempt: number, assertCurrent: () => void) => Promise<void>;
  /** Actual retained-log owner; omission keeps unknown local work pending. */
  cancelAbsentLocalWork?: (manifest: RemoteInstanceReconciliationManifest, decision: Extract<RecoveryDecision, { action: "cancel" }>, assertCurrent: () => void) => Promise<void>;
  reports: ReportSender;
  onLease: (lease: string, expiresAt: string, assertCurrent: () => void) => Promise<void>;
  /** Optional pending inventory/renewal, after establishment and outside the lease lane. */
  afterEstablishment?: (assertCurrent: () => void) => Promise<void>;
  /** Captured before network I/O; invalidated by suspension, revocation or shutdown. */
  captureLeaseFence?: () => () => void;
  withLeaseAcquisition?: LeaseAcquisition;
  logger?: Logger;
}

type DecisionOutcome = "executed" | "interrupted" | "rejected_wrong_instance" | "rejected_unknown_assignment" | "rejected_wrong_attempt" | "rejected_stale_epoch" | "rejected_conflicting_decision" | "rejected_report_missing" | "duplicate";
type SettledOutcome = "executed" | "interrupted" | "duplicate";
type DecisionRecord = NonNullable<ReturnType<SupervisorJournal["decisions"]["get"]>>;
type ClaimSnapshot = RemoteReconnectIntentSnapshot["claims"][number];
type ReconnectRequest = Omit<RemoteInstanceReconnectRequest, "proof">;

function settledOutcome(outcome: DecisionOutcome): outcome is SettledOutcome {
  return outcome === "executed" || outcome === "interrupted" || outcome === "duplicate";
}

/** Assignment id, then attempt: the order Core expects claim and result lists in. */
function byAssignment(a: { assignmentId: string; attempt: number }, b: { assignmentId: string; attempt: number }): number {
  if (a.assignmentId !== b.assignmentId) return a.assignmentId < b.assignmentId ? -1 : 1;
  return a.attempt - b.attempt;
}

/** The claim a decision addresses: a restart names the prior attempt, not the new attempt's future claim. */
function decisionIdentity(decision: RecoveryDecision): { assignmentId: string; attempt: number } {
  return decision.action === "restart_new_attempt_same_instance"
    ? { assignmentId: decision.priorAssignmentId, attempt: decision.newAttempt - 1 }
    : { assignmentId: decision.assignmentId, attempt: decision.attempt };
}

function claimSnapshot(entry: JournalEntry): ClaimSnapshot {
  return {
    assignmentId: entry.assignmentId,
    attempt: entry.attempt,
    claimId: entry.claimId,
    state: entry.state as "claimed" | "running" | "checkpointed" | "terminal_pending_report",
    recoveryEpoch: entry.recoveryEpoch,
    ...(entry.acpSessionRef ? { acpSessionRef: entry.acpSessionRef } : {}),
    ...(entry.checkpoint ? { checkpoint: entry.checkpoint } : {}),
    ...(entry.terminalResultHash ? { terminalResultHash: entry.terminalResultHash } : {}),
  };
}

/** Core's explicit refusal of a reconnect, as the durable disposition it ends the intent with. */
function refusalDisposition(error: unknown, request: ReconnectRequest): "establishment_conflict" | "expired" | "superseded" | undefined {
  if (!(error instanceof RemoteInstanceError)) return undefined;
  if (error.code === "conflict" && request.establishment) return "establishment_conflict";
  if (error.code === "resume_deadline_expired") return "expired";
  return error.code === "reconciliation_replay" ? "superseded" : undefined;
}

/** The snapshot's terminal hash for a terminal replay differs from the local claim's. */
function terminalHashDiffers(decision: RecoveryDecision, snapshot: ClaimSnapshot | undefined, entry: JournalEntry): boolean {
  return decision.action === "replay_terminal" && Boolean(snapshot?.terminalResultHash) && snapshot!.terminalResultHash !== entry.terminalResultHash;
}

/** A decision already journaled for this claim must be this same decision, on its claim and epoch. */
function journaledRefusal(journaled: DecisionRecord, entry: JournalEntry, decisionDigest: string): DecisionOutcome | null {
  if (journaled.decisionDigest !== decisionDigest) return "rejected_conflicting_decision";
  if (journaled.claimId && journaled.claimId !== entry.claimId) return "rejected_wrong_attempt";
  return journaled.recoveryEpoch < entry.recoveryEpoch ? "rejected_stale_epoch" : null;
}

function absentConflict(existing: DecisionRecord, decisionDigest: string): boolean {
  return Boolean(existing.claimId) || existing.decisionDigest !== decisionDigest || (existing.result !== undefined && existing.result.disposition !== "absent_local_cancelled");
}

function replayedAbsence(existing: DecisionRecord, absenceTombstoneDigest: string): DecisionOutcome {
  return existing.absenceTombstoneDigest === absenceTombstoneDigest && existing.result?.disposition === "absent_local_cancelled" ? "duplicate" : "rejected_conflicting_decision";
}

/** The claim state a recovery decision leaves: a restart cancels unreported work; a served resume runs again. */
function projectedState(current: JournalEntry, decision: RecoveryDecision, result: RemoteReconciliationDecisionResult): JournalEntry["state"] {
  if (decision.action === "restart_new_attempt_same_instance") return current.reports.terminalSequence === undefined ? "cancelled" : current.state;
  if (decision.action !== "resume_from_checkpoint" || result.disposition === "interrupted") return current.state;
  if (current.reports.terminalSequence !== undefined) throw new RemoteInstanceError("recovery_required", "Checkpoint claim became terminal during recovery.");
  return "running";
}

function dispositionOf(outcome: SettledOutcome): "interrupted" | "already_applied" | "applied" {
  if (outcome === "interrupted") return "interrupted";
  return outcome === "duplicate" ? "already_applied" : "applied";
}

export class Reconciliation {
  private readonly logger: Logger;
  private complete = false;
  private confirmedManifestId: string | null = null;
  private applicationEpoch = 0;
  private applying: Promise<void> = Promise.resolve();
  private preparingIntent: Promise<RemoteReconnectIntentSnapshot> | undefined;

  constructor(private readonly deps: ReconciliationDeps) {
    this.logger = deps.logger ?? createLogger({ name: "reconciliation" });
  }

  get isComplete(): boolean {
    if (!this.complete) return false;
    const current = this.deps.journal.recovery.current(this.deps.instanceId(), this.deps.runnerIncarnation());
    return current?.state === "applied" && current.manifest?.manifestId === this.confirmedManifestId && current.acceptedAt !== null;
  }

  private beginApplication(assertLifecycle: () => void = () => undefined): () => void {
    this.complete = false;
    this.confirmedManifestId = null;
    const epoch = ++this.applicationEpoch;
    return () => {
      assertLifecycle();
      if (epoch !== this.applicationEpoch) throw new RemoteInstanceError("recovery_required", "Reconciliation was superseded locally.");
    };
  }

  /** The signed recovery snapshot: journal facts only, no checkpoint content. */
  async buildRequest(): Promise<Omit<RemoteInstanceReconnectRequest, "proof">> {
    this.deps.assertOwned();
    if (!this.preparingIntent) {
      const operation = this.prepareIntent();
      this.preparingIntent = operation;
      void operation.finally(() => { if (this.preparingIntent === operation) this.preparingIntent = undefined; }).catch(() => undefined);
    }
    const intent = await this.preparingIntent;
    this.deps.assertOwned();
    return { ...structuredClone(intent), connection: this.connection() };
  }

  private connection(): RemoteReconciliationConnection {
    return this.deps.connection?.() ?? { kind: "https" };
  }

  private async prepareIntent(): Promise<RemoteReconnectIntentSnapshot> {
    const instanceId = this.deps.instanceId();
    const runnerIncarnation = this.deps.runnerIncarnation();
    const assertCurrent = this.intentGuard(instanceId, runnerIncarnation);
    assertCurrent();
    const existing = this.deps.journal.recovery.current(instanceId, runnerIncarnation);
    if (existing) {
      if (existing.state !== "pending" && existing.state !== "applied") throw new RemoteInstanceError("reconciliation_replay", "Explicit recovery disposition requires a new recovery request.");
      return existing.intent;
    }
    const owner = await this.deps.core.resolveRuntimeOwner(instanceId);
    assertCurrent();
    if (owner.instanceId !== instanceId) throw new RemoteInstanceError("registration_mismatch", "Owner response belongs to another instance.");
    const lastHeartbeatSequence = await this.deps.lastHeartbeatSequence();
    assertCurrent();
    const intent = this.newIntent({ instanceId, runnerIncarnation, lastHeartbeatSequence }, owner);
    assertCurrent();
    await this.deps.journal.recovery.prepareIntent(intent);
    assertCurrent();
    return intent;
  }

  /** The lease fence and this process's identity, both unchanged since the intent began. */
  private intentGuard(instanceId: string, runnerIncarnation: string): () => void {
    const lifecycle = this.deps.captureLeaseFence?.() ?? (() => undefined);
    return () => {
      lifecycle();
      this.deps.assertOwned();
      if (instanceId !== this.deps.instanceId() || runnerIncarnation !== this.deps.runnerIncarnation()) throw new RemoteInstanceError("reconciliation_replay", "Recovery process identity changed.");
    };
  }

  private newIntent(identity: { instanceId: string; runnerIncarnation: string; lastHeartbeatSequence: number }, owner: { ownerRevision: number; currentIncarnation: string | null }): RemoteReconnectIntentSnapshot {
    const { instanceId, runnerIncarnation } = identity;
    const pendingClaims = this.pendingClaims(instanceId);
    // An acceptance-unresolved intent is not a claim Core is known to hold. The
    // two inventories must stay disjoint: its local `claimed` label alone
    // cannot promote the same identity into the ordinary decision engine.
    const unresolved = new Set(pendingClaims.map(pending => `${pending.admission.assignmentId}:${pending.admission.attempt}`));
    const claims = this.deps.journal.activeAssignments().filter(entry => !unresolved.has(`${entry.assignmentId}:${entry.attempt}`)).map(claimSnapshot).sort(byAssignment);
    return RemoteReconnectIntentSnapshotSchema.parse({
      instanceId, runnerIncarnation, reconnectIntentId: randomUUID(),
      establishment: owner.currentIncarnation === runnerIncarnation ? null : { expectedOwnerRevision: owner.ownerRevision, expectedCurrentIncarnation: owner.currentIncarnation },
      lastHeartbeatSequence: identity.lastHeartbeatSequence,
      bundleVersion: this.deps.bundleVersion,
      protocolVersion: this.deps.protocolVersion,
      claims,
      pendingClaims,
      ...(this.deps.modelCapabilitySnapshots ? { modelCapabilitySnapshots: this.deps.modelCapabilitySnapshots() } : {}),
    });
  }

  /**
   * Acceptance-unresolved claim intents retained by the durable allocator. An
   * instance whose enrollment never bound the assignment stream proves an empty
   * inventory; inconsistent retained history still refuses recovery.
   */
  private pendingClaims(instanceId: string): PendingClaimRequest[] {
    const enrollment = this.deps.journal.execution.enrollment();
    if (!enrollment || !("instanceId" in enrollment) || enrollment.instanceId !== instanceId) return [];
    return this.deps.journal.assignmentStream.pendingClaims({ instanceId, workspaceId: enrollment.workspaceId });
  }

  /** Full reconnect: snapshot → Core → renewed lease + manifest → journal + execute decisions. */
  async run(): Promise<RemoteInstanceReconciliationManifest> {
    const assertApplication = this.beginApplication();
    const acquire = this.deps.withLeaseAcquisition ?? (operation => operation());
    let assertCurrent = () => {};
    const result = await acquire(async () => {
      const assertLease = this.deps.captureLeaseFence?.() ?? (() => undefined);
      assertCurrent = () => { assertApplication(); assertLease(); this.deps.assertOwned(); };
      return this.establish(assertCurrent);
    });
    // Recovery may touch an agent or a large journal. It never holds the
    // lease-acquisition lane needed for periodic authority renewal.
    await this.deps.afterEstablishment?.(assertCurrent);
    assertCurrent();
    await this.applyManifest(result.manifest, assertCurrent);
    assertCurrent();
    if (!this.complete) throw new RemoteInstanceError("recovery_required", "Reconciliation has unresolved decisions.");
    return result.manifest;
  }

  /** Reconnect to Core and bind the renewed lease and manifest it answers with, inside the lease-acquisition lane. */
  private async establish(assertCurrent: () => void) {
    assertCurrent();
    const request = await this.buildRequest();
    assertCurrent();
    let response;
    try { response = await this.deps.core.reconnect(request); }
    catch (error) {
      assertCurrent();
      await this.recordRefusal(request, error);
      throw error;
    }
    assertCurrent();
    const { connection: _connection, ...intent } = request;
    await this.deps.journal.recovery.bindManifest(intent, response.manifest);
    assertCurrent();
    await this.deps.reserveHeartbeatFloor(response.manifest.heartbeatSequenceFloor);
    assertCurrent();
    await this.deps.onLease(response.lease, response.leaseExpiresAt, assertCurrent);
    assertCurrent();
    return response;
  }

  private async recordRefusal(request: ReconnectRequest, error: unknown): Promise<void> {
    const disposition = refusalDisposition(error, request);
    if (!disposition) return;
    const { connection: _connection, ...intent } = request;
    await this.deps.journal.recovery.terminate(intent, disposition);
  }

  /** Apply a manifest (from HTTPS reconnect or the control channel); duplicate delivery converges. */
  async apply(candidate: unknown, assertCurrent = this.deps.captureLeaseFence?.() ?? (() => undefined)): Promise<Map<string, DecisionOutcome>> {
    return this.applyManifest(candidate, this.beginApplication(assertCurrent));
  }

  private async applyManifest(candidate: unknown, assertCurrent: () => void): Promise<Map<string, DecisionOutcome>> {
    assertCurrent();
    this.deps.assertOwned();
    const manifest = RemoteInstanceReconciliationManifestSchema.parse(candidate);
    // No local pending-claim adoption or qualified pre-execution fence owner
    // exists: no pre-execution profile is approved, so an issued pending
    // classification must refuse rather than manufacture fenced evidence.
    if (manifest.pendingClaimDecisions.length) throw new RemoteInstanceError("recovery_required", "Pending claim classifications have no local adoption owner.");
    this.boundRecovery(manifest);
    // Validate the whole identity set before any local effect. Restart decisions
    // address the prior assignment, not the new assignment's future claim.
    const identities = manifest.decisions.map(decision => decisionIdentity(decision).assignmentId);
    if (new Set(identities).size !== identities.length) throw new RemoteInstanceError("recovery_required", "Reconciliation repeats an assignment identity.");
    const operation = this.applying.then(() => this.applyBound(manifest, assertCurrent));
    this.applying = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Apply each decision of the bound manifest, then freeze and confirm the receipt once every one is settled. */
  private async applyBound(manifest: RemoteInstanceReconciliationManifest, assertCurrent: () => void): Promise<Map<string, DecisionOutcome>> {
    assertCurrent();
    const outcomes = new Map<string, DecisionOutcome>();
    const recovery = this.boundRecovery(manifest);
    if (recovery.receipt) {
      for (const decision of manifest.decisions) outcomes.set(decisionKey(decision), "duplicate");
      await this.confirmReceipt(manifest, assertCurrent);
      return outcomes;
    }
    if (parseRfc3339(manifest.applyDeadlineAt) <= this.deps.clock.coreNow()) throw new RemoteInstanceError("resume_deadline_expired", "Recovery application deadline expired.");
    const manifestDigest = computeRemoteReconciliationManifestDigest(manifest);
    // First-seen append order survives journal reload/compaction. Never update
    // an existing record: replay cannot make a historical manifest current.
    if (!this.knownManifest(manifest, manifestDigest)) await this.deps.journal.manifests.put({ manifestId: manifest.manifestId, instanceId: manifest.instanceId, manifestDigest });
    for (const decision of manifest.decisions) {
      assertCurrent();
      const outcome = await this.applyDecision(manifest, decision, assertCurrent);
      assertCurrent();
      outcomes.set(decisionKey(decision), outcome);
      this.logger.info({ manifestId: manifest.manifestId, action: decision.action, outcome }, "recovery decision");
    }
    assertCurrent();
    if (![...outcomes.values()].every(settledOutcome)) return outcomes;
    await this.deps.journal.recovery.prepareReceipt(recovery.intent, { instanceId: manifest.instanceId, runnerIncarnation: manifest.runnerIncarnation, manifestId: manifest.manifestId, decisionResults: this.decisionResults(manifest), pendingClaimResults: [] });
    assertCurrent();
    await this.confirmReceipt(manifest, assertCurrent);
    return outcomes;
  }

  /** Whether this manifest was seen before, which must then be exactly it and still the latest. */
  private knownManifest(manifest: RemoteInstanceReconciliationManifest, manifestDigest: string): boolean {
    const existing = this.deps.journal.manifests.get(manifest.manifestId);
    if (!existing && this.deps.journal.decisions.all().some(record => record.manifestId === manifest.manifestId)) {
      throw new RemoteInstanceError("recovery_required", "Historical reconciliation lacks a complete manifest identity.");
    }
    if (existing && (existing.manifestDigest !== manifestDigest || this.deps.journal.manifests.all().at(-1)?.manifestId !== manifest.manifestId)) {
      throw new RemoteInstanceError("recovery_required", "Reconciliation manifest changed or was superseded.");
    }
    return existing !== undefined;
  }

  private decisionResults(manifest: RemoteInstanceReconciliationManifest): RemoteReconciliationDecisionResult[] {
    return manifest.decisions.map(decision => {
      const record = this.deps.journal.decisions.get(`${manifest.manifestId}:${decisionKey(decision)}`);
      if (!record?.result) throw new RemoteInstanceError("recovery_required", "Recovery decision lacks durable outcome evidence.");
      return record.result;
    }).sort(byAssignment);
  }

  private boundRecovery(manifest: RemoteInstanceReconciliationManifest): RuntimeRecoveryRecord {
    const recovery = this.deps.journal.recovery.current(this.deps.instanceId(), this.deps.runnerIncarnation());
    if (!recovery || !this.manifestBindsRecovery(manifest, recovery)) {
      throw new RemoteInstanceError("registration_mismatch", "Manifest is not the current bound process recovery generation.");
    }
    return recovery;
  }

  private manifestBindsRecovery(manifest: RemoteInstanceReconciliationManifest, recovery: RuntimeRecoveryRecord): boolean {
    return manifest.instanceId === this.deps.instanceId() && manifest.runnerIncarnation === this.deps.runnerIncarnation() &&
      (recovery.state === "pending" || recovery.state === "applied") && recovery.intent.reconnectIntentId === manifest.reconnectIntentId &&
      recovery.manifest?.digest === computeRemoteReconciliationManifestDigest(manifest);
  }

  private async confirmReceipt(manifest: RemoteInstanceReconciliationManifest, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    this.deps.assertOwned();
    const recovery = this.boundRecovery(manifest);
    if (!recovery.receipt) throw new RemoteInstanceError("recovery_required", "Recovery has no durable receipt.");
    let accepted;
    try {
      accepted = await this.deps.core.applyReconciliation({ ...recovery.receipt.snapshot, connection: this.connection() });
    } catch (error) {
      assertCurrent();
      await this.recordReceiptRefusal(recovery, error);
      throw error;
    }
    assertCurrent();
    this.deps.assertOwned();
    this.boundRecovery(manifest);
    await this.deps.journal.recovery.acceptReceipt(recovery.intent, accepted);
    assertCurrent();
    this.deps.assertOwned();
    this.boundRecovery(manifest);
    this.confirmedManifestId = manifest.manifestId;
    this.complete = true;
  }

  /** Core said the receipt expired or was superseded: that ends this recovery intent durably. */
  private async recordReceiptRefusal(recovery: RuntimeRecoveryRecord, error: unknown): Promise<void> {
    if (!(error instanceof RemoteInstanceError) || (error.code !== "resume_deadline_expired" && error.code !== "reconciliation_replay")) return;
    await this.deps.journal.recovery.terminate(recovery.intent, error.code === "resume_deadline_expired" ? "expired" : "superseded");
  }

  private async applyDecision(manifest: RemoteInstanceReconciliationManifest, decision: RecoveryDecision, assertCurrent: () => void): Promise<DecisionOutcome> {
    const identity = decisionIdentity(decision);
    const entry = this.deps.journal.assignments.get(`${identity.assignmentId}:${identity.attempt}`);
    if (!entry) return this.applyToAbsent(manifest, decision, assertCurrent);
    const journaled = this.deps.journal.decisions.get(`${manifest.manifestId}:${identity.assignmentId}:${identity.attempt}`);
    const decisionDigest = jcsDigest(decision);
    const refusal = this.entryRefusal(decision, entry, identity) ?? this.journalRefusal(entry, journaled, decisionDigest);
    if (refusal) return refusal;
    if (journaled?.executedAt) return this.replayJournaled(decision, entry, journaled, assertCurrent);
    if ("recoveryEpoch" in decision && decision.recoveryEpoch <= entry.recoveryEpoch) return "rejected_stale_epoch";
    return this.journalAndExecute({ manifestId: manifest.manifestId, decision, entry, identity, decisionDigest }, assertCurrent);
  }

  /** Only a cancel, with an owner for absent local work, applies to a claim this computer does not hold. */
  private async applyToAbsent(manifest: RemoteInstanceReconciliationManifest, decision: RecoveryDecision, assertCurrent: () => void): Promise<DecisionOutcome> {
    if (decision.action !== "cancel" || !this.deps.cancelAbsentLocalWork) return "rejected_unknown_assignment";
    return this.applyAbsentCancellation(manifest, decision, assertCurrent);
  }

  /** The local claim differs from the one Core's snapshot and decision name. */
  private entryRefusal(decision: RecoveryDecision, entry: JournalEntry, identity: { assignmentId: string; attempt: number }): DecisionOutcome | null {
    const snapshot = this.deps.journal.recovery.current(this.deps.instanceId(), this.deps.runnerIncarnation())?.intent.claims.find(claim => claim.assignmentId === identity.assignmentId && claim.attempt === identity.attempt);
    if (snapshot && snapshot.claimId !== entry.claimId) return "rejected_wrong_attempt";
    if (terminalHashDiffers(decision, snapshot, entry)) return "rejected_report_missing";
    if ("attempt" in decision && decision.attempt !== entry.attempt) return "rejected_wrong_attempt";
    return null;
  }

  private journalRefusal(entry: JournalEntry, journaled: DecisionRecord | undefined, decisionDigest: string): DecisionOutcome | null {
    if (journaled) {
      const refusal = journaledRefusal(journaled, entry, decisionDigest);
      if (refusal) return refusal;
    }
    if (entry.reports.terminalSequence !== undefined && !this.deps.reports.hasDurableTerminalReport(entry.assignmentId, entry.attempt, entry.claimId)) return "rejected_report_missing";
    return null;
  }

  private async replayJournaled(decision: RecoveryDecision, entry: JournalEntry, journaled: DecisionRecord, assertCurrent: () => void): Promise<DecisionOutcome> {
    if (!journaled.result) return "rejected_conflicting_decision";
    await this.projectDecision(decision, entry, journaled.result);
    assertCurrent();
    return "duplicate";
  }

  /** Journal the decision BEFORE dispatch, execute it, then record its durable result and project it onto the claim. */
  private async journalAndExecute(applied: { manifestId: string; decision: RecoveryDecision; entry: JournalEntry; identity: { assignmentId: string; attempt: number }; decisionDigest: string }, assertCurrent: () => void): Promise<DecisionOutcome> {
    const { manifestId, decision, entry, identity, decisionDigest } = applied;
    const record = { manifestId, assignmentId: identity.assignmentId, attempt: identity.attempt, claimId: entry.claimId, action: decision.action,
      recoveryEpoch: "recoveryEpoch" in decision ? decision.recoveryEpoch : entry.recoveryEpoch, decisionDigest };
    await this.deps.journal.decisions.put({ ...record, journaledAt: this.deps.clock.nowIso(), executedAt: null });
    assertCurrent();
    const outcome = await this.execute(decision, entry, assertCurrent);
    assertCurrent();
    if (!settledOutcome(outcome)) return outcome;
    const result = this.decisionResult(decision, entry, outcome);
    await this.deps.journal.decisions.put({ ...record, journaledAt: this.deps.clock.nowIso(), executedAt: this.deps.clock.nowIso(), result });
    assertCurrent();
    await this.projectDecision(decision, entry, result);
    assertCurrent();
    return outcome;
  }

  private async applyAbsentCancellation(manifest: RemoteInstanceReconciliationManifest, decision: Extract<RecoveryDecision, { action: "cancel" }>, assertCurrent: () => void): Promise<DecisionOutcome> {
    const key = `${manifest.manifestId}:${decision.assignmentId}:${decision.attempt}`;
    const existing = this.deps.journal.decisions.get(key);
    const decisionDigest = jcsDigest(decision);
    if (existing && absentConflict(existing, decisionDigest)) return "rejected_conflicting_decision";
    if (!existing) await this.deps.journal.decisions.put({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt, action: "cancel", recoveryEpoch: 0, decisionDigest, journaledAt: this.deps.clock.nowIso(), executedAt: null });
    assertCurrent();
    await this.deps.cancelAbsentLocalWork!(manifest, decision, assertCurrent);
    assertCurrent(); this.boundRecovery(manifest);
    const absenceTombstoneDigest = this.exactTombstone(manifest, decision, decisionDigest);
    if (existing?.executedAt) return replayedAbsence(existing, absenceTombstoneDigest);
    await this.deps.journal.decisions.put({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt, action: "cancel", recoveryEpoch: 0, decisionDigest, journaledAt: existing?.journaledAt ?? this.deps.clock.nowIso(), executedAt: this.deps.clock.nowIso(), absenceTombstoneDigest, result: { assignmentId: decision.assignmentId, attempt: decision.attempt, disposition: "absent_local_cancelled" } });
    assertCurrent();
    return "executed";
  }

  /** The tombstone the absent-work owner left for exactly this decision and process; its digest. */
  private exactTombstone(manifest: RemoteInstanceReconciliationManifest, decision: Extract<RecoveryDecision, { action: "cancel" }>, decisionDigest: string): string {
    const tombstone = this.deps.journal.execution.tombstone({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt });
    if (!tombstone || !allEqual([[tombstone.instanceId, manifest.instanceId], [tombstone.runnerIncarnation, manifest.runnerIncarnation], [tombstone.decisionDigest, decisionDigest]]) ||
      this.deps.journal.latestAttempt(decision.assignmentId)) throw new RemoteInstanceError("recovery_required", "Absence cancellation has no exact durable tombstone.");
    return jcsDigest(tombstone);
  }

  /** Outcome is durable first; this projection can be repaired after a crash. */
  private async projectDecision(decision: RecoveryDecision, entry: JournalEntry, result: RemoteReconciliationDecisionResult): Promise<void> {
    if (!("recoveryEpoch" in decision)) return;
    await this.deps.journal.assignments.update(`${entry.assignmentId}:${entry.attempt}`, current => {
      if (!current || current.claimId !== entry.claimId || current.recoveryEpoch > decision.recoveryEpoch) throw new RemoteInstanceError("recovery_required", "Claim changed before recovery projection.");
      return { ...current, state: projectedState(current, decision, result), recoveryEpoch: decision.recoveryEpoch, updatedAt: this.deps.clock.nowIso() };
    });
  }

  private async stopAndRead(entry: JournalEntry, assertCurrent: () => void): Promise<JournalEntry> {
    const read = () => {
      assertCurrent();
      const current = this.deps.journal.assignments.get(`${entry.assignmentId}:${entry.attempt}`);
      if (!current || current.claimId !== entry.claimId) throw new RemoteInstanceError("recovery_required", "Claim changed while stopping local recovery work.");
      return current;
    };
    read();
    await this.deps.stopLocalWork(entry.assignmentId, entry.attempt, assertCurrent);
    return read();
  }

  private decisionResult(decision: RecoveryDecision, entry: JournalEntry, outcome: SettledOutcome): RemoteReconciliationDecisionResult {
    const identity = { assignmentId: entry.assignmentId, attempt: entry.attempt };
    if (decision.action === "restart_new_attempt_same_instance" || (decision.action === "resume_from_checkpoint" && outcome !== "interrupted")) return { ...identity, disposition: outcome === "duplicate" ? "already_applied" : "applied" };
    return this.terminalEvidenceResult(entry, identity, dispositionOf(outcome));
  }

  /** The terminal report behind a settled decision: queued, or acknowledged by Core. */
  private terminalEvidenceResult(entry: JournalEntry, identity: { assignmentId: string; attempt: number }, disposition: "interrupted" | "already_applied" | "applied"): RemoteReconciliationDecisionResult {
    const report = this.deps.reports.queuedTerminalReport(entry.assignmentId, entry.attempt, entry.claimId);
    if (report?.result) return { ...identity, disposition, terminalReportId: report.reportId, terminalEvidence: { kind: "queued", reportSequence: report.reportSequence, payloadDigest: report.payloadDigest, terminalResultHash: report.result.terminalResultHash } };
    const ack = this.deps.reports.acknowledgedTerminalReport(entry.assignmentId, entry.attempt, entry.claimId);
    if (ack) return { ...identity, disposition, terminalReportId: ack.acknowledged.reportId, terminalEvidence: { kind: "acknowledged", ack } };
    throw new RemoteInstanceError("recovery_required", "Recovery has no actual terminal report evidence.");
  }

  private async execute(decision: RecoveryDecision, entry: JournalEntry, assertCurrent: () => void): Promise<DecisionOutcome> {
    switch (decision.action) {
      case "resume_from_checkpoint":
        return this.resumeFromCheckpoint(decision, entry, assertCurrent);
      case "replay_terminal":
        if (!this.deps.reports.hasDurableTerminalReport(entry.assignmentId, entry.attempt, entry.claimId)) return "rejected_report_missing";
        await this.deps.reports.flushAll();
        return "executed";
      case "restart_new_attempt_same_instance":
        await this.stopAndRead(entry, assertCurrent);
        // Not executable work: record the disposition; the new attempt arrives through ordinary pull/claim.
        return "executed";
      case "report_interrupted":
        return this.interrupt(entry, decision.reason, assertCurrent);
      case "cancel":
        return this.cancel(decision, entry, assertCurrent);
    }
  }

  private resumeFromCheckpoint(decision: Extract<RecoveryDecision, { action: "resume_from_checkpoint" }>, entry: JournalEntry, assertCurrent: () => void): Promise<DecisionOutcome> {
    if (parseRfc3339(decision.latestResumeAt) <= this.deps.clock.coreNow()) return this.interrupt(entry, "deadline_expired", assertCurrent, true);
    // A native connector has no domain component that could resume from a
    // checkpoint. An ACP session resume counts as a checkpoint only where
    // the bridge proves it; without one the attempt is agent_session_lost.
    return this.interrupt(entry, entry.acpSessionRef || entry.checkpoint ? "agent_session_lost" : "checkpoint_invalid", assertCurrent, true);
  }

  private async cancel(decision: Extract<RecoveryDecision, { action: "cancel" }>, current: JournalEntry, assertCurrent: () => void): Promise<DecisionOutcome> {
    const entry = await this.stopAndRead(current, assertCurrent);
    if (entry.reports.terminalSequence !== undefined) return this.terminalReplayOutcome(entry);
    assertCurrent();
    await this.deps.reports.submit({ assignmentId: entry.assignmentId, attempt: entry.attempt, claimId: entry.claimId, draft: { terminal: true, result: { class: "cancelled", reason: decision.reason, terminalResultHash: jcsDigest({ class: "cancelled", reason: decision.reason }) } } });
    return "executed";
  }

  private async interrupt(entry: JournalEntry, reason: "not_resumable" | "checkpoint_invalid" | "deadline_expired" | "agent_session_lost" | "relay_replay_gap", assertCurrent: () => void, asResume = false): Promise<DecisionOutcome> {
    entry = await this.stopAndRead(entry, assertCurrent);
    if (entry.reports.terminalSequence !== undefined) {
      if (!asResume) return this.terminalReplayOutcome(entry);
      const result = this.deps.reports.terminalResult(entry.assignmentId, entry.attempt, entry.claimId);
      if (result?.class === "interrupted" && result.reason === reason) return "interrupted";
      throw new RemoteInstanceError("recovery_required", "Pre-existing terminal cannot prove this checkpoint interruption.");
    }
    await this.deps.reports.submit({ assignmentId: entry.assignmentId, attempt: entry.attempt, claimId: entry.claimId, draft: { terminal: true, result: { class: "interrupted", reason, terminalResultHash: jcsDigest({ class: "interrupted", reason }) } } });
    return "interrupted";
  }

  private terminalReplayOutcome(entry: JournalEntry): DecisionOutcome {
    return this.deps.reports.hasDurableTerminalReport(entry.assignmentId, entry.attempt, entry.claimId) ? "duplicate" : "rejected_report_missing";
  }
}

function decisionKey(decision: RecoveryDecision): string {
  const { assignmentId, attempt } = decisionIdentity(decision);
  return `${assignmentId}:${attempt}`;
}
