import { randomUUID } from "node:crypto";
import { RemoteInstanceError, RemoteInstanceReconciliationManifestSchema, RemoteReconnectIntentSnapshotSchema, computeRemoteReconciliationManifestDigest, createLogger, jcsDigest, parseRfc3339, type AgentModelOfferedValuesSnapshot, type Clock, type Logger, type RecoveryDecision, type RemoteReconciliationDecisionResult, type PendingClaimRequest, type RemoteReconnectIntentSnapshot, type RemoteReconciliationConnection, type RemoteInstanceReconciliationManifest, type RemoteInstanceReconnectRequest } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { SupervisorJournal, JournalEntry } from "../state/journal.js";
import type { ComponentAdapter, ComponentRecoveryRefusal } from "../work/components.js";
import { componentForKind } from "../work/components.js";
import type { ReportSender } from "../work/report-sender.js";
import type { LeaseAcquisition } from "../lease/lease.js";

/**
 * Reconnect and recovery (invariants 21/22). On process/host reconnect the
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
  components: Partial<Record<"harness" | "validation_runtime", ComponentAdapter>>;
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

export type DecisionOutcome = "executed" | "interrupted" | "rejected_wrong_instance" | "rejected_unknown_assignment" | "rejected_wrong_attempt" | "rejected_stale_epoch" | "rejected_conflicting_decision" | "rejected_report_missing" | "duplicate";

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
    return { ...structuredClone(intent), connection: this.deps.connection?.() ?? { kind: "https" } };
  }

  private async prepareIntent(): Promise<RemoteReconnectIntentSnapshot> {
    const instanceId = this.deps.instanceId();
    const runnerIncarnation = this.deps.runnerIncarnation();
    const lifecycle = this.deps.captureLeaseFence?.() ?? (() => undefined);
    const assertCurrent = () => {
      lifecycle();
      this.deps.assertOwned();
      if (instanceId !== this.deps.instanceId() || runnerIncarnation !== this.deps.runnerIncarnation()) throw new RemoteInstanceError("reconciliation_replay", "Recovery process identity changed.");
    };
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
    const pendingClaims = this.pendingClaims(instanceId);
    // An acceptance-unresolved intent is not a claim Core is known to hold. The
    // two inventories must stay disjoint: its local `claimed` label alone
    // cannot promote the same identity into the ordinary decision engine.
    const unresolved = new Set(pendingClaims.map(pending => `${pending.admission.assignmentId}:${pending.admission.attempt}`));
    const claims = this.deps.journal.activeAssignments().filter(entry => !unresolved.has(`${entry.assignmentId}:${entry.attempt}`)).map((entry) => ({
      assignmentId: entry.assignmentId,
      attempt: entry.attempt,
      claimId: entry.claimId,
      state: entry.state as "claimed" | "running" | "checkpointed" | "terminal_pending_report",
      recoveryEpoch: entry.recoveryEpoch,
      ...(entry.acpSessionRef ? { acpSessionRef: entry.acpSessionRef } : {}),
      ...(entry.checkpoint ? { checkpoint: entry.checkpoint } : {}),
      ...(entry.terminalResultHash ? { terminalResultHash: entry.terminalResultHash } : {}),
    })).sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : a.attempt - b.attempt);
    const intent = RemoteReconnectIntentSnapshotSchema.parse({
      instanceId, runnerIncarnation, reconnectIntentId: randomUUID(),
      establishment: owner.currentIncarnation === runnerIncarnation ? null : { expectedOwnerRevision: owner.ownerRevision, expectedCurrentIncarnation: owner.currentIncarnation },
      lastHeartbeatSequence,
      bundleVersion: this.deps.bundleVersion,
      protocolVersion: this.deps.protocolVersion,
      claims,
      pendingClaims,
      ...(this.deps.modelCapabilitySnapshots ? { modelCapabilitySnapshots: this.deps.modelCapabilitySnapshots() } : {}),
    });
    assertCurrent();
    await this.deps.journal.recovery.prepareIntent(intent);
    assertCurrent();
    return intent;
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
      assertCurrent();
      const request = await this.buildRequest();
      assertCurrent();
      let response;
      try { response = await this.deps.core.reconnect(request); }
      catch (error) {
        assertCurrent();
        if (error instanceof RemoteInstanceError) {
          const disposition = error.code === "conflict" && request.establishment ? "establishment_conflict" : error.code === "resume_deadline_expired" ? "expired" : error.code === "reconciliation_replay" ? "superseded" : undefined;
          if (disposition) {
            const { connection: _connection, ...intent } = request;
            await this.deps.journal.recovery.terminate(intent, disposition);
          }
        }
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
    const outcomes = new Map<string, DecisionOutcome>();
    this.boundRecovery(manifest);
    // Validate the whole identity set before any local effect. Restart decisions
    // address the prior assignment, not the new assignment's future claim.
    const identities = manifest.decisions.map(decision => decision.action === "restart_new_attempt_same_instance" ? decision.priorAssignmentId : decision.assignmentId);
    if (new Set(identities).size !== identities.length) throw new RemoteInstanceError("recovery_required", "Reconciliation repeats an assignment identity.");
    const operation = this.applying.then(async () => {
      assertCurrent();
      const recovery = this.boundRecovery(manifest);
      if (recovery.receipt) {
        for (const decision of manifest.decisions) outcomes.set(decisionKey(decision), "duplicate");
        await this.confirmReceipt(manifest, assertCurrent);
        return outcomes;
      }
      if (parseRfc3339(manifest.applyDeadlineAt) <= this.deps.clock.coreNow()) throw new RemoteInstanceError("resume_deadline_expired", "Recovery application deadline expired.");
      const manifestDigest = computeRemoteReconciliationManifestDigest(manifest);
      const existing = this.deps.journal.manifests.get(manifest.manifestId);
      if (!existing && this.deps.journal.decisions.all().some(record => record.manifestId === manifest.manifestId)) {
        throw new RemoteInstanceError("recovery_required", "Historical reconciliation lacks a complete manifest identity.");
      }
      if (existing && (existing.manifestDigest !== manifestDigest || this.deps.journal.manifests.all().at(-1)?.manifestId !== manifest.manifestId)) {
        throw new RemoteInstanceError("recovery_required", "Reconciliation manifest changed or was superseded.");
      }
      // First-seen append order survives journal reload/compaction. Never update
      // an existing record: replay cannot make a historical manifest current.
      if (!existing) await this.deps.journal.manifests.put({ manifestId: manifest.manifestId, instanceId: manifest.instanceId, manifestDigest });
      for (const decision of manifest.decisions) {
        assertCurrent();
        const key = decisionKey(decision);
        const outcome = await this.applyDecision(manifest, decision, assertCurrent);
        assertCurrent();
        outcomes.set(key, outcome);
        this.logger.info({ manifestId: manifest.manifestId, action: decision.action, outcome }, "recovery decision");
      }
      assertCurrent();
      if (![...outcomes.values()].every(outcome => outcome === "executed" || outcome === "duplicate" || outcome === "interrupted")) return outcomes;
      const decisionResults = manifest.decisions.map(decision => {
        const record = this.deps.journal.decisions.get(`${manifest.manifestId}:${decisionKey(decision)}`);
        if (!record?.result) throw new RemoteInstanceError("recovery_required", "Recovery decision lacks durable outcome evidence.");
        return record.result;
      }).sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : a.attempt - b.attempt);
      await this.deps.journal.recovery.prepareReceipt(recovery.intent, { instanceId: manifest.instanceId, runnerIncarnation: manifest.runnerIncarnation, manifestId: manifest.manifestId, decisionResults, pendingClaimResults: [] });
      assertCurrent();
      await this.confirmReceipt(manifest, assertCurrent);
      return outcomes;
    });
    this.applying = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private boundRecovery(manifest: RemoteInstanceReconciliationManifest) {
    const recovery = this.deps.journal.recovery.current(this.deps.instanceId(), this.deps.runnerIncarnation());
    if (manifest.instanceId !== this.deps.instanceId() || manifest.runnerIncarnation !== this.deps.runnerIncarnation() ||
      !recovery || (recovery.state !== "pending" && recovery.state !== "applied") || recovery.intent.reconnectIntentId !== manifest.reconnectIntentId ||
      recovery.manifest?.digest !== computeRemoteReconciliationManifestDigest(manifest)) {
      throw new RemoteInstanceError("registration_mismatch", "Manifest is not the current bound process recovery generation.");
    }
    return recovery;
  }

  private async confirmReceipt(manifest: RemoteInstanceReconciliationManifest, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    this.deps.assertOwned();
    const recovery = this.boundRecovery(manifest);
    if (!recovery.receipt) throw new RemoteInstanceError("recovery_required", "Recovery has no durable receipt.");
    let accepted;
    try {
      accepted = await this.deps.core.applyReconciliation({ ...recovery.receipt.snapshot, connection: this.deps.connection?.() ?? { kind: "https" } });
    } catch (error) {
      assertCurrent();
      if (error instanceof RemoteInstanceError && (error.code === "resume_deadline_expired" || error.code === "reconciliation_replay")) {
        await this.deps.journal.recovery.terminate(recovery.intent, error.code === "resume_deadline_expired" ? "expired" : "superseded");
      }
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

  private async applyDecision(manifest: RemoteInstanceReconciliationManifest, decision: RecoveryDecision, assertCurrent: () => void): Promise<DecisionOutcome> {
    const manifestId = manifest.manifestId;
    const assignmentId = decision.action === "restart_new_attempt_same_instance" ? decision.priorAssignmentId : decision.assignmentId;
    const attempt = decision.action === "restart_new_attempt_same_instance" ? decision.newAttempt - 1 : decision.attempt;
    const entry = this.deps.journal.assignments.get(`${assignmentId}:${attempt}`);
    if (!entry) {
      if (decision.action !== "cancel" || !this.deps.cancelAbsentLocalWork) return "rejected_unknown_assignment";
      return this.applyAbsentCancellation(manifest, decision, assertCurrent);
    }
    const snapshot = this.deps.journal.recovery.current(this.deps.instanceId(), this.deps.runnerIncarnation())?.intent.claims.find(claim => claim.assignmentId === assignmentId && claim.attempt === attempt);
    if (snapshot && snapshot.claimId !== entry.claimId) return "rejected_wrong_attempt";
    if (decision.action === "replay_terminal" && snapshot?.terminalResultHash && snapshot.terminalResultHash !== entry.terminalResultHash) return "rejected_report_missing";
    if ("attempt" in decision && decision.attempt !== entry.attempt) return "rejected_wrong_attempt";
    const journaled = this.deps.journal.decisions.get(`${manifestId}:${assignmentId}:${attempt}`);
    const decisionDigest = jcsDigest(decision);
    if (journaled && journaled.decisionDigest !== decisionDigest) return "rejected_conflicting_decision";
    if (journaled?.claimId && journaled.claimId !== entry.claimId) return "rejected_wrong_attempt";
    if (journaled && journaled.recoveryEpoch < entry.recoveryEpoch) return "rejected_stale_epoch";
    if (entry.reports.terminalSequence !== undefined && !this.deps.reports.hasDurableTerminalReport(entry.assignmentId, entry.attempt, entry.claimId)) return "rejected_report_missing";
    if (journaled?.executedAt) {
      if (!journaled.result) return "rejected_conflicting_decision";
      await this.projectDecision(decision, entry, journaled.result);
      assertCurrent();
      return "duplicate";
    }
    if ("recoveryEpoch" in decision && decision.recoveryEpoch <= entry.recoveryEpoch) return "rejected_stale_epoch";
    // Journal BEFORE dispatch (invariant: decision journaled before execution).
    await this.deps.journal.decisions.put({ manifestId, assignmentId, attempt, claimId: entry.claimId, action: decision.action, recoveryEpoch: "recoveryEpoch" in decision ? decision.recoveryEpoch : entry.recoveryEpoch, decisionDigest, journaledAt: this.deps.clock.nowIso(), executedAt: null });
    assertCurrent();
    const outcome = await this.execute(decision, entry, manifestId, assertCurrent);
    assertCurrent();
    if (outcome !== "executed" && outcome !== "interrupted" && outcome !== "duplicate") return outcome;
    const result = this.decisionResult(decision, entry, outcome);
    await this.deps.journal.decisions.put({ manifestId, assignmentId, attempt, claimId: entry.claimId, action: decision.action, recoveryEpoch: "recoveryEpoch" in decision ? decision.recoveryEpoch : entry.recoveryEpoch, decisionDigest, journaledAt: this.deps.clock.nowIso(), executedAt: this.deps.clock.nowIso(), result });
    assertCurrent();
    await this.projectDecision(decision, entry, result);
    assertCurrent();
    return outcome;
  }

  private async applyAbsentCancellation(manifest: RemoteInstanceReconciliationManifest, decision: Extract<RecoveryDecision, { action: "cancel" }>, assertCurrent: () => void): Promise<DecisionOutcome> {
    const key = `${manifest.manifestId}:${decision.assignmentId}:${decision.attempt}`;
    const existing = this.deps.journal.decisions.get(key);
    const decisionDigest = jcsDigest(decision);
    if (existing && (existing.claimId || existing.decisionDigest !== decisionDigest || (existing.result && existing.result.disposition !== "absent_local_cancelled"))) return "rejected_conflicting_decision";
    if (!existing) await this.deps.journal.decisions.put({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt, action: "cancel", recoveryEpoch: 0, decisionDigest, journaledAt: this.deps.clock.nowIso(), executedAt: null });
    assertCurrent();
    await this.deps.cancelAbsentLocalWork!(manifest, decision, assertCurrent);
    assertCurrent(); this.boundRecovery(manifest);
    const tombstone = this.deps.journal.execution.tombstone({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt });
    if (!tombstone || tombstone.instanceId !== manifest.instanceId || tombstone.runnerIncarnation !== manifest.runnerIncarnation || tombstone.decisionDigest !== decisionDigest || this.deps.journal.latestAttempt(decision.assignmentId)) throw new RemoteInstanceError("recovery_required", "Absence cancellation has no exact durable tombstone.");
    const absenceTombstoneDigest = jcsDigest(tombstone);
    if (existing?.executedAt) {
      if (existing.absenceTombstoneDigest !== absenceTombstoneDigest || existing.result?.disposition !== "absent_local_cancelled") return "rejected_conflicting_decision";
      return "duplicate";
    }
    await this.deps.journal.decisions.put({ manifestId: manifest.manifestId, assignmentId: decision.assignmentId, attempt: decision.attempt, action: "cancel", recoveryEpoch: 0, decisionDigest, journaledAt: existing?.journaledAt ?? this.deps.clock.nowIso(), executedAt: this.deps.clock.nowIso(), absenceTombstoneDigest, result: { assignmentId: decision.assignmentId, attempt: decision.attempt, disposition: "absent_local_cancelled" } });
    assertCurrent();
    return "executed";
  }

  /** Outcome is durable first; this projection can be repaired after a crash. */
  private async projectDecision(decision: RecoveryDecision, entry: JournalEntry, result: RemoteReconciliationDecisionResult): Promise<void> {
    if (!("recoveryEpoch" in decision)) return;
    await this.deps.journal.assignments.update(`${entry.assignmentId}:${entry.attempt}`, current => {
      if (!current || current.claimId !== entry.claimId || current.recoveryEpoch > decision.recoveryEpoch) throw new RemoteInstanceError("recovery_required", "Claim changed before recovery projection.");
      let state = current.state;
      if (decision.action === "restart_new_attempt_same_instance" && current.reports.terminalSequence === undefined) state = "cancelled";
      if (decision.action === "resume_from_checkpoint" && result.disposition !== "interrupted") {
        if (current.reports.terminalSequence !== undefined) throw new RemoteInstanceError("recovery_required", "Checkpoint claim became terminal during recovery.");
        state = "running";
      }
      return { ...current, state, recoveryEpoch: decision.recoveryEpoch, updatedAt: this.deps.clock.nowIso() };
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

  private decisionResult(decision: RecoveryDecision, entry: JournalEntry, outcome: "executed" | "interrupted" | "duplicate"): RemoteReconciliationDecisionResult {
    const identity = { assignmentId: entry.assignmentId, attempt: entry.attempt };
    const disposition = outcome === "interrupted" ? "interrupted" : outcome === "duplicate" ? "already_applied" : "applied";
    if (decision.action === "restart_new_attempt_same_instance" || (decision.action === "resume_from_checkpoint" && outcome !== "interrupted")) return { ...identity, disposition: outcome === "duplicate" ? "already_applied" : "applied" };
    const report = this.deps.reports.queuedTerminalReport(entry.assignmentId, entry.attempt, entry.claimId);
    if (report?.result) return { ...identity, disposition, terminalReportId: report.reportId, terminalEvidence: { kind: "queued", reportSequence: report.reportSequence, payloadDigest: report.payloadDigest, terminalResultHash: report.result.terminalResultHash } };
    const ack = this.deps.reports.acknowledgedTerminalReport(entry.assignmentId, entry.attempt, entry.claimId);
    if (ack) return { ...identity, disposition, terminalReportId: ack.acknowledged.reportId, terminalEvidence: { kind: "acknowledged", ack } };
    throw new RemoteInstanceError("recovery_required", "Recovery has no actual terminal report evidence.");
  }

  private async execute(decision: RecoveryDecision, entry: JournalEntry, manifestId: string, assertCurrent: () => void): Promise<DecisionOutcome> {
    switch (decision.action) {
      case "resume_from_checkpoint": {
        if (parseRfc3339(decision.latestResumeAt) <= this.deps.clock.coreNow()) return this.interrupt(entry, "deadline_expired", assertCurrent, true);
        const target = componentForKind(entry.kind);
        if (target === "agent_runner" || !entry.checkpoint) {
          // An ACP session resume counts as a checkpoint only where the bridge proves it; without a proven checkpoint this is agent_session_lost.
          return this.interrupt(entry, entry.acpSessionRef ? "agent_session_lost" : "checkpoint_invalid", assertCurrent, true);
        }
        // The component owns checkpoint verification: it holds the artifact and
        // compares ref/hash/epoch itself, so the decision is handed down whole
        // rather than re-verified here and dispatched a second time.
        const component = this.deps.components[target];
        if (!component) return this.interrupt(entry, "agent_session_lost", assertCurrent, true);
        const outcome = await component.recoveryDecision({
          manifestId,
          decision,
          checkpoint: { ref: entry.checkpoint.ref, hash: entry.checkpoint.hash },
          attempt: entry.attempt,
        });
        assertCurrent();
        if (!outcome.applied) return this.interrupt(entry, resumeRefusal(outcome.reason), assertCurrent, true);
        return "executed";
      }
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
      case "cancel": {
        entry = await this.stopAndRead(entry, assertCurrent);
        if (entry.reports.terminalSequence !== undefined) return this.terminalReplayOutcome(entry);
        assertCurrent();
        await this.deps.reports.submit({ assignmentId: entry.assignmentId, attempt: entry.attempt, claimId: entry.claimId, draft: { terminal: true, result: { class: "cancelled", reason: decision.reason, terminalResultHash: jcsDigest({ class: "cancelled", reason: decision.reason }) } } });
        return "executed";
      }
    }
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

/**
 * A component's refusal to resume, stated in the interrupted-report
 * vocabulary. Anything the component names outside the resumable reasons is
 * `not_resumable`: the attempt cannot continue, and the report says so
 * instead of inventing a cause.
 */
function resumeRefusal(reason: ComponentRecoveryRefusal): "not_resumable" | "checkpoint_invalid" | "deadline_expired" | "agent_session_lost" {
  switch (reason) {
    case "checkpoint_invalid":
      return "checkpoint_invalid";
    case "resume_deadline_expired":
      return "deadline_expired";
    case "agent_session_lost":
      return "agent_session_lost";
    default:
      return "not_resumable";
  }
}

function decisionKey(decision: RecoveryDecision): string {
  return decision.action === "restart_new_attempt_same_instance" ? `${decision.priorAssignmentId}:${decision.newAttempt - 1}` : `${decision.assignmentId}:${decision.attempt}`;
}
