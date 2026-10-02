import type { KeyObject } from "node:crypto";
import {
  RemoteAuthorizedOperationSchema, RemoteExecutionAuthorityViewSchema, RemoteInstanceError,
  verifyRemoteExecutionOperationSignature, verifyRemoteExecutionAdmission, verifyRemoteExecutionAdmissionEvidence, verifyRemoteExecutionCheckLease,
  RemoteDeliveryExecutionAuthorityViewSchema, verifyRemoteDeliveryOperationSignature, verifyRemoteDeliveryAdmission, verifyRemoteDeliveryAdmissionEvidence, verifyRemoteDeliveryCheckLease,
  canonicalize, type JsonValue, type RemoteDeliveryExecutionAuthorityView, type RemoteDeliveryOperationPermitClaims,
  type RemoteAuthorizedOperation, type RemoteExecutionAuthorityView, type RemoteExecutionOperationPermitClaims,
  createLogger, type Logger, type Clock, type RemoteWorkAssignment, type SessionToCoreMessage,
  NativeExecutionRevisionFenceReceiptSchema,
  type NativeExecutionRevisionFenceReceipt,
} from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { SupervisorJournal } from "../state/journal.js";
import { OperationAdmissionJournal, admittedOperationKey } from "../state/operation-admission.js";

export interface NativeExecutionGateOptions {
  assignment: RemoteWorkAssignment;
  journal: SupervisorJournal;
  clock: Clock;
  runnerIncarnation: string;
  client: Pick<CoreClient, "executionSigningKeys" | "consumeExecution" | "checkExecution"> &
    Partial<Pick<CoreClient, "consumeDeliveryExecution" | "checkDeliveryExecution">>;
  assertOwned: () => void;
  onAuthorityLost: () => Promise<void>;
  /** Present only when the live native relay owner can prove its exact socket. */
  currentRevisionFenceConnection?: () => {
    connectionRef: string;
    connectionEpoch: number;
  } | null;
  /** Durable C02 receipt delivery; failure cannot alter local fence behavior. */
  onFenceApplied?: (receipt: NativeExecutionRevisionFenceReceipt) => Promise<void>;
  monotonicNow?: () => number;
  logger?: Logger;
}
type Authority = RemoteExecutionAuthorityView | RemoteDeliveryExecutionAuthorityView;
const delivery = (value: Authority): value is RemoteDeliveryExecutionAuthorityView => "workloadKind" in value;
export interface AuthorizedNativeOperation {
  key: string;
  envelope: RemoteAuthorizedOperation;
  authority: Authority;
  replayCompletion?: SessionToCoreMessage;
  replay: boolean;
  admissionFailure?: RemoteInstanceError;
}
const fenced = () => new RemoteInstanceError("execution_fenced", "Native execution authority is no longer current.");
const unavailable = () => new RemoteInstanceError("execution_authority_unavailable", "Fresh execution authority is unavailable.");
/** The permit's own expiry, read without trust: it only bounds how long admission waits for keys. */
const signedOperationExpiryMs = (permit: string): number | undefined => {
  try {
    const claims = JSON.parse(Buffer.from(permit.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};
const signedOperationKeyId = (permit: string): string | undefined => {
  try {
    const header = JSON.parse(Buffer.from(permit.split(".", 1)[0] ?? "", "base64url").toString("utf8"));
    return typeof header.kid === "string" && header.kid.length > 0 && header.kid.length <= 256
      ? header.kid
      : undefined;
  } catch {
    return undefined;
  }
};
/** The whole trust fetch and signed check exchange share this one budget. */
export const NATIVE_EXECUTION_RENEWAL_BUDGET_MS = 12_000;

/**
 * An unanswered renewal is retried with exponential backoff (1 s, 2 s, 4 s …
 * 30 s) and no attempt cap (D110, owner 09-24). Only Core's own answer that
 * the execution is gone stops the agent; a timeout never does.
 */
const RENEWAL_RETRY_BASE_MS = 1_000;
const RENEWAL_RETRY_MAX_MS = 30_000;
/** Waiting for trust keys during admission never outlives the permit itself. */
const ADMISSION_KEYS_RETRY_BASE_MS = 500;
const ADMISSION_KEYS_RETRY_MAX_MS = 8_000;
// Begin while a full busy-host event-loop pause can still elapse before the
// verified lease expires. A collaboration/Core restart has produced a 19 s
// pause in practice; a 25 s renewal lead avoids lengthening the
// authority Core issued. Retries remain fenced by the original monotonic
// deadline, so this changes availability rather than trust semantics.
const RENEWAL_LEAD_MS = 25_000;
const transientLoss = (error: unknown): boolean =>
  error instanceof RemoteInstanceError &&
  (error.code === "execution_authority_unavailable" || error.code === "temporarily_unavailable" || error.retryable);

/** Native's independent admission boundary, required by native Assistant and delivery
 * sessions. Legacy appliance and planning-controller protocols remain separate. */
export class NativeExecutionGate {
  private readonly operations: OperationAdmissionJournal;
  private keys: ReadonlyMap<string, KeyObject> | null = null;
  private authority: Authority | null = null;
  /** The fresh, signed Core check that the next revision fence must name. */
  private checkId: string | null = null;
  private monotonicDeadline = 0;
  private refreshAfter = 0;
  /** Consecutive unanswered renewals; reset by Core's next fresh check. */
  private renewalFailures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private stopped = false;
  private authorityStop: Promise<void> | null = null;
  private readonly monotonic: () => number;
  private readonly logger: Logger;

  constructor(private readonly options: NativeExecutionGateOptions) {
    this.logger = options.logger ?? createLogger({ name: "native-execution-gate" });
    this.operations = new OperationAdmissionJournal(options.journal, options.clock);
    this.monotonic = options.monotonicNow ?? (() => performance.now());
  }

  async admit(raw: unknown): Promise<AuthorizedNativeOperation> {
    try { return await this.admitImpl(raw); }
    catch (error) {
      this.logger.warn({ event: "execution.admission_refused", assignmentId: this.options.assignment.id,
        attempt: this.options.assignment.attempt, diagnostic: error instanceof RemoteInstanceError ? error.diagnostic ?? error.code : verificationReason(error) }, "Native operation admission refused");
      throw error;
    }
  }

  private async admitImpl(raw: unknown): Promise<AuthorizedNativeOperation> {
    const parsed = RemoteAuthorizedOperationSchema.safeParse(raw);
    if (!parsed.success) throw new RemoteInstanceError("operation_permit_required", "A signed execution operation is required.");
    const envelope = parsed.data;
    this.options.assertOwned();
    if (this.stopped) throw fenced();
    // Fetch only the configured Core trust. No token header may select a URL.
    const keys = await this.signingKeysForAdmission(envelope.permit);
    this.options.assertOwned();
    const ref = this.options.journal.assignments.get(`${this.options.assignment.id}:${this.options.assignment.attempt}`)?.executionReady?.acpSessionRef;
    const message = envelope.message;
    const key = `${ref}:${message.kind === "acp" ? "received" : "issued"}:${"id" in message ? message.id : `operation:${envelope.operationId}`}`;
    const prior = this.options.journal.pendingRequests.get(key)?.authorization;
    // Completed results may replay after permit expiry, but only with the same
    // genuine signed operation. This branch never grants permission to dispatch.
    const replay = prior?.state === "completed" || prior?.state === "denied";
    const verifier = this.options.assignment.source.kind === "harness_delivery" ? verifyRemoteDeliveryOperationSignature : verifyRemoteExecutionOperationSignature;
    const claims = verifier({ operation: envelope, trustedKeys: keys,
      issuedAtToleranceSeconds: 1,
      nowSeconds: replay ? prior.claims.iat : Math.floor(this.options.clock.coreNow() / 1000) });
    // A retry may not consume a second operation for the same durable ACP
    // request. Refuse before Core consumption can create another orphan.
    if (prior && (prior.claims.permitId !== claims.permitId || prior.claims.operationId !== claims.operationId ||
      prior.claims.payloadDigest !== claims.payloadDigest || prior.claims.executionId !== claims.executionId ||
      prior.claims.executionRevision !== claims.executionRevision)) {
      throw new RemoteInstanceError("operation_conflict", "The ACP request already has a different durable admission.");
    }
    // A fresh Core-signed delivery permit may carry the turn's renewed lifetime (D115).
    if (!replay && delivery(claims)) await this.followCoreHorizon(Date.parse(claims.expiresAt));
    const authority = this.localAuthority(claims, replay);
    if (replay) {
      if (prior.claims.permitId !== claims.permitId || prior.claims.operationId !== claims.operationId ||
        prior.claims.payloadDigest !== claims.payloadDigest || prior.claims.executionId !== claims.executionId ||
        prior.claims.executionRevision !== claims.executionRevision) throw fenced();
      if (canonicalize(this.localAuthority(prior.claims, true) as unknown as JsonValue) !==
        canonicalize(authority as unknown as JsonValue)) throw fenced();
      return { key, envelope, authority, replay: true, ...(prior.completion ? { replayCompletion: prior.completion } : {}) };
    }
    if (this.authority && (this.authority.executionId !== authority.executionId || this.authority.executionRevision !== authority.executionRevision)) throw fenced();
    const consume = delivery(authority) ? this.options.client.consumeDeliveryExecution : this.options.client.consumeExecution;
    if (!consume) throw unavailable();
    const consumed = await consume.call(this.options.client, authority.instanceId, authority.executionId, {
      permitId: claims.permitId, operationId: claims.operationId, payloadDigest: claims.payloadDigest,
      runnerIncarnation: authority.runnerIncarnation, executionRevision: authority.executionRevision,
    });
    this.localAuthority(claims);
    const receiptInput = { operation: envelope, receipt: consumed.receipt,
      admissionId: consumed.admissionId, trustedKeys: keys,
      authenticatedProducer: claims.sender.principal, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000), issuedAtToleranceSeconds: 1 };
    let receipt;
    let admissionFailure: RemoteInstanceError | undefined;
    try {
      receipt = delivery(authority)
        ? verifyRemoteDeliveryAdmission({ ...receiptInput, currentAuthority: authority })
        : verifyRemoteExecutionAdmission({ ...receiptInput, currentAuthority: authority });
    } catch (error) {
      // Consumption has already committed in Core. A genuine receipt that
      // arrived too late is retained for a non-dispatch disposition; it must
      // never disappear merely because it no longer grants current authority.
      receipt = delivery(authority)
        ? verifyRemoteDeliveryAdmissionEvidence({ ...receiptInput, currentAuthority: authority })
        : verifyRemoteExecutionAdmissionEvidence({ ...receiptInput, currentAuthority: authority });
      const reason = verificationReason(error);
      admissionFailure = new RemoteInstanceError(reason === "expired" ? "operation_expired" : "operation_permit_invalid",
        "The operation admission is not currently valid.", { diagnostic: reason });
    }
    await this.operations.admit(receipt, consumed.receipt, () => { this.localAuthority(claims); });
    this.logger.info({ event: "execution.admission_retained", assignmentId: claims.assignmentId, attempt: claims.attempt,
      claimId: claims.claimId, executionId: claims.executionId, operationId: claims.operationId, permitId: claims.permitId,
      admissionId: receipt.admissionId, outcome: admissionFailure ? "refused_before_dispatch" : "admitted",
      ...(admissionFailure ? { diagnostic: admissionFailure.diagnostic } : {}) }, "Native operation admission retained");
    this.keys = keys;
    this.authority = authority;
    return { key: admittedOperationKey(receipt), envelope, authority, replay: false, ...(admissionFailure ? { admissionFailure } : {}) };
  }

  /**
   * Core's key endpoint answering slowly must not refuse a prompt and drop the
   * relay socket (D110: three refusals cost four minutes). Retry with backoff
   * while the permit is still valid; the client also serves its last confirmed
   * keys during an outage, so this matters only before any key was ever read.
   */
  private async signingKeysForAdmission(permit: string): Promise<ReadonlyMap<string, KeyObject>> {
    const kid = signedOperationKeyId(permit);
    const permitExpiresAtMs = signedOperationExpiryMs(permit);
    for (let retry = 1; ; retry += 1) {
      try {
        return await this.options.client.executionSigningKeys(undefined, kid);
      } catch (error) {
        const delayMs = Math.min(ADMISSION_KEYS_RETRY_MAX_MS, ADMISSION_KEYS_RETRY_BASE_MS * 2 ** (retry - 1));
        const code = error instanceof RemoteInstanceError ? error.code : "unexpected_error";
        const willRetry = transientLoss(error) && !this.stopped && permitExpiresAtMs !== undefined &&
          this.options.clock.coreNow() + delayMs < permitExpiresAtMs;
        this.logger.warn({ event: "execution.admission_keys_unavailable", assignmentId: this.options.assignment.id,
          attempt: this.options.assignment.attempt, retry, code,
          ...(error instanceof RemoteInstanceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          willRetry, ...(willRetry ? { retryInMs: delayMs } : {}),
          permitRemainingMs: permitExpiresAtMs === undefined ? null : Math.max(0, permitExpiresAtMs - this.options.clock.coreNow()) },
        willRetry ? "Core signing keys unavailable; retrying admission" : "Core signing keys unavailable; admission refused");
        if (!willRetry) throw error;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, delayMs); timer.unref?.(); });
        this.options.assertOwned();
        if (this.stopped) throw fenced();
      }
    }
  }

  /** Called immediately before the bridge call, after any local preparation IO. */
  async begin(operation: AuthorizedNativeOperation): Promise<boolean> {
    if (operation.replay) return false;
    try {
      if (operation.admissionFailure) throw operation.admissionFailure;
      // A fence is scoped to one signed check, so establish that check before
      // deciding whether the durable control record applies to this dispatch.
      await this.refresh();
      const fence = this.durableRevisionFence(operation.authority);
      if (fence) {
        await this.fenceAuthority();
        this.recordAppliedFence(fence);
        throw fenced();
      }
      const started = await this.operations.begin(operation.key, () => this.assertDispatchCurrent(operation.authority));
      this.assertDispatchCurrent(operation.authority);
      if (started && !this.timer) {
        this.timer = setInterval(() => { void this.tick(); }, 1000);
        this.timer.unref();
      }
      return started;
    } catch (error) {
      const state = this.options.journal.pendingRequests.get(operation.key)?.authorization?.state;
      if (state === "admitted") await this.operations.denyBeforeDispatch(operation.key);
      throw error;
    }
  }

  complete(key: string, completion?: SessionToCoreMessage): Promise<void> {
    return this.operations.complete(key, completion);
  }

  denyBeforeDispatch(key: string, completion?: SessionToCoreMessage): Promise<void> {
    return this.operations.denyBeforeDispatch(key, completion);
  }

  /** The runner refused a begun operation before it reached the agent. */
  refuseAtDispatch(key: string, completion: SessionToCoreMessage): Promise<void> {
    return this.operations.refuseAtDispatch(key, completion);
  }

  /** Whether this process began the operation and has not settled it yet. */
  isDispatching(key: string): boolean {
    return this.operations.isDispatching(key);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Owner teardown must observe a failed safety stop; callback failure is not
   * evidence that the bridge stopped or that cancellation succeeded. */
  waitForAuthorityStop(): Promise<void> { return this.authorityStop ?? Promise.resolve(); }

  /**
   * `deadline: false` for the renewal path and the running prompt's tick: the
   * local record of the assignment's lifetime never stops an agent that is
   * already running; Core's answer to the next check does (D110, D115).
   */
  private localAuthority(claims: RemoteExecutionOperationPermitClaims | RemoteDeliveryOperationPermitClaims | Authority, replay = false, deadline = true): Authority {
    this.options.assertOwned();
    if (this.stopped) throw fenced();
    const assignment = this.options.assignment;
    const entry = this.options.journal.assignments.get(`${assignment.id}:${assignment.attempt}`);
    const ready = entry?.executionReady;
    const sourceMatches = delivery(claims)
      ? (assignment.kind === "delivery" || assignment.kind === "validation") && assignment.source.kind === "harness_delivery" &&
        assignment.source.executionSessionId === claims.sessionId && assignment.source.ownerInstanceId === claims.instanceId &&
        assignment.source.turn.invocationId === claims.deliveryIdentity.invocationId &&
        assignment.source.turn.dispatchGeneration === claims.deliveryIdentity.dispatchGeneration &&
        assignment.correlationId === claims.deliveryIdentity.invocationId &&
        assignment.taskId === claims.deliveryIdentity.taskId &&
        assignment.agentRoute.requiredRole === claims.deliveryIdentity.requiredRuntimeRole &&
        assignment.agentRoute.agentId === claims.deliveryIdentity.agentId &&
        assignment.agentRoute.sessionConfig?.model === claims.modelSelection.selectedValue &&
        assignment.source.repositoryId === claims.deliveryIdentity.repositoryId &&
        assignment.source.modelBinding.canonicalProviderId === claims.modelSelection.canonicalIdentity.canonicalProviderId &&
        assignment.source.modelBinding.canonicalModelId === claims.modelSelection.canonicalIdentity.canonicalModelId &&
        claims.deliveryIdentity.modelBinding.selectedValue === claims.modelSelection.selectedValue &&
        claims.deliveryIdentity.modelBinding.canonicalProviderId === claims.modelSelection.canonicalIdentity.canonicalProviderId &&
        claims.deliveryIdentity.modelBinding.canonicalModelId === claims.modelSelection.canonicalIdentity.canonicalModelId
      // An Assistant turn, or a person's direct session prompt (runtime-view R16).
      : ((assignment.kind === "assistant_execution" && assignment.source.kind === "conversation") ||
          (assignment.kind === "direct" && assignment.source.kind === "direct_session")) &&
        assignment.source.sessionId === claims.sessionId && assignment.source.turnRef === claims.turnRef;
    if (!entry || !ready || !sourceMatches || entry.kind !== assignment.kind ||
      assignment.workspaceId !== claims.workspaceId || assignment.instanceId !== claims.instanceId ||
      assignment.id !== claims.assignmentId || assignment.attempt !== claims.attempt ||
      entry.workspaceId !== claims.workspaceId || assignment.agentRoute.agentId !== claims.agentId ||
      entry.claimId !== claims.claimId || entry.recoveryEpoch !== claims.recoveryEpoch || entry.agentId !== claims.agentId ||
      claims.runnerIncarnation !== this.options.runnerIncarnation ||
      (!replay && (!["claimed", "running", "checkpointed"].includes(entry.state) || (deadline && Date.parse(entry.expiresAt) <= this.options.clock.coreNow()))) ||
      !Number.isFinite(Date.parse(entry.expiresAt)) || !Number.isFinite(Date.parse(assignment.expiresAt)) ||
      Date.parse(claims.expiresAt) > this.liveUntil()) throw fenced();
    for (const field of ["workspaceId", "instanceId", "sessionId", "channelId", "assignmentId", "attempt", "claimId",
      "recoveryEpoch", "runnerIncarnation", "agentId", "acpSessionRef", "readyRevision"] as const) {
      if (ready[field] !== claims[field]) throw fenced();
    }
    const schema = delivery(claims) ? RemoteDeliveryExecutionAuthorityViewSchema : RemoteExecutionAuthorityViewSchema;
    return schema.parse(Object.fromEntries(Object.keys(schema.shape)
      .map(field => [field, Reflect.get(claims, field)])));
  }

  private assertDispatchCurrent(authority: Authority): void {
    this.localAuthority(authority);
    if (this.authority?.executionId !== authority.executionId || this.authority.executionRevision !== authority.executionRevision ||
      this.monotonicDeadline <= this.monotonic()) throw unavailable();
    if (this.hasDurableRevisionFence(authority)) throw fenced();
  }

  /**
   * The receiver verified the Core signature and exact live socket before
   * persisting this record. The gate still requires the same current local
   * runner and socket before it suppresses work, so a retained old-socket fact
   * cannot fence a replacement execution.
   */
  private hasDurableRevisionFence(authority: Authority): boolean {
    return this.durableRevisionFence(authority) !== null;
  }

  private durableRevisionFence(authority: Authority) {
    const connection = this.options.currentRevisionFenceConnection?.();
    const checkId = this.checkId;
    if (!connection || !checkId) return null;
    return this.options.journal.executionRevisionFences.pending().find(
      (record) =>
        record.runnerIncarnation === authority.runnerIncarnation &&
        record.connectionRef === connection.connectionRef &&
        record.connectionEpoch === connection.connectionEpoch &&
        record.intent.instanceId === authority.instanceId &&
        record.intent.executionId === authority.executionId &&
        record.intent.executionRevision === authority.executionRevision &&
        record.intent.checkId === checkId &&
        record.intent.connectionRef === connection.connectionRef &&
        record.intent.connectionEpoch === connection.connectionEpoch,
    ) ?? null;
  }

  private recordAppliedFence(record: ReturnType<NativeExecutionGate["durableRevisionFence"]>): void {
    if (!record || !this.options.onFenceApplied) return;
    const receipt = NativeExecutionRevisionFenceReceiptSchema.parse({
      kind: "execution_revision_fenced",
      intent: record.intent,
      intentDigest: record.intentDigest,
      runnerIncarnation: record.runnerIncarnation,
      connectionRef: record.connectionRef,
      connectionEpoch: record.connectionEpoch,
      fencedAt: this.options.clock.nowIso(),
    });
    void this.options.onFenceApplied(receipt).catch(() => undefined);
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const task = this.refreshImpl();
    this.refreshing = task;
    void task.then(() => { this.refreshing = null; }, () => { this.refreshing = null; });
    return task;
  }

  private async refreshImpl(): Promise<void> {
    const authority = this.authority;
    if (!authority || !this.keys) throw unavailable();
    this.localAuthority(authority, false, false);
    // Every renewal gets its whole bounded I/O budget, even near or past the
    // last verified lease: Core's fresh signed check is what grants authority
    // (it answers execution_fenced once the execution is gone), and a budget
    // clipped to the lease's last milliseconds could only fail (D110).
    const deadlineAtMs = Date.now() + NATIVE_EXECUTION_RENEWAL_BUDGET_MS;
    const startedAt = this.monotonic();
    let stage = "signing_keys";
    let keysElapsedMs = 0;
    const context = { assignmentId: authority.assignmentId, attempt: authority.attempt,
      claimId: authority.claimId, executionId: authority.executionId, executionRevision: authority.executionRevision };
    try {
      const keys = await this.options.client.executionSigningKeys(deadlineAtMs);
      keysElapsedMs = this.monotonic() - startedAt;
      stage = "check";
      this.localAuthority(authority, false, false);
      const check = delivery(authority) ? this.options.client.checkDeliveryExecution : this.options.client.checkExecution;
      if (!check) throw unavailable();
      const result = await check.call(this.options.client, authority.instanceId, authority.executionId, {
        executionRevision: authority.executionRevision, readyRevision: authority.readyRevision, runnerIncarnation: authority.runnerIncarnation,
      }, deadlineAtMs);
      this.localAuthority(authority, false, false);
      stage = "verification";
      const lapsedMs = this.monotonicDeadline > 0 ? Math.max(0, this.monotonic() - this.monotonicDeadline) : 0;
      const checkInput = { lease: result.lease, trustedKeys: keys, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000), issuedAtToleranceSeconds: 1 };
      let claims;
      try {
        claims = delivery(authority) ? verifyRemoteDeliveryCheckLease({ ...checkInput, currentAuthority: renewedView(authority, result.lease) })
          : verifyRemoteExecutionCheckLease({ ...checkInput, currentAuthority: authority });
      } catch (error) {
        const reason = verificationReason(error);
        this.logger.warn({ event: "execution.check_refused", assignmentId: authority.assignmentId, attempt: authority.attempt,
          claimId: authority.claimId, executionId: authority.executionId, executionRevision: authority.executionRevision,
          diagnostic: reason, skewMs: this.options.clock.skewMs(), issuedAtToleranceSeconds: 1 }, "Native execution check refused");
        // A genuine check that a slow Core answered after its own expiry says
        // nothing about the execution; ask again rather than stop the agent.
        if (reason === "expired") throw new RemoteInstanceError("execution_authority_unavailable", "Execution check lease expired in transit", { diagnostic: reason, retryable: true });
        throw new RemoteInstanceError("execution_fenced", "Invalid execution check lease", { diagnostic: reason });
      }
      if (result.executionId !== authority.executionId || result.executionRevision !== authority.executionRevision || Date.parse(result.expiresAt) !== claims.exp * 1000) throw fenced();
      this.keys = keys;
      this.checkId = claims.checkId;
      if (delivery(authority) && Date.parse(claims.expiresAt) > Date.parse(authority.expiresAt)) {
        // Core renewed this turn (D115): the verified answer is the same
        // authority with a later lifetime; hold that from now on.
        await this.followCoreHorizon(Date.parse(claims.expiresAt));
        if (this.authority === authority) this.authority = { ...authority, expiresAt: claims.expiresAt };
      }
      const remainingMs = Math.max(0, claims.exp * 1000 - this.options.clock.coreNow());
      this.monotonicDeadline = this.monotonic() + remainingMs;
      this.refreshAfter = Math.max(this.monotonic(), this.monotonicDeadline - Math.min(RENEWAL_LEAD_MS, remainingMs));
      const recoveredAfter = this.renewalFailures;
      this.renewalFailures = 0;
      this.logger.info({ event: "execution.renewal_completed", ...context,
        elapsedMs: this.monotonic() - startedAt, keysElapsedMs,
        remainingLeaseMs: remainingMs, nextRenewalInMs: Math.max(0, this.refreshAfter - this.monotonic()),
        ...(recoveredAfter > 0 ? { recoveredAfterFailures: recoveredAfter } : {}),
        ...(lapsedMs > 0 ? { leaseLapsedMs: Math.round(lapsedMs) } : {}),
        skewMs: this.options.clock.skewMs() }, "Native execution lease verified");
    } catch (error) {
      this.logger.warn({ event: "execution.renewal_failed", ...context, stage,
        elapsedMs: this.monotonic() - startedAt, keysElapsedMs,
        budgetMs: NATIVE_EXECUTION_RENEWAL_BUDGET_MS,
        remainingLeaseMs: Math.max(0, this.monotonicDeadline - this.monotonic()),
        code: error instanceof RemoteInstanceError ? error.code : "unexpected_error",
        retryable: transientLoss(error), skewMs: this.options.clock.skewMs() }, "Native execution renewal failed");
      throw error;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.authority) return;
    try {
      // The running prompt stays bound to its own local admission and to
      // Core's durable revision fence; an expired lease only holds back new
      // dispatch (assertDispatchCurrent) until Core answers again.
      this.localAuthority(this.authority, false, false);
      if (this.hasDurableRevisionFence(this.authority)) throw fenced();
      if (!this.refreshing && this.monotonic() >= this.refreshAfter) await this.refresh();
    } catch (error) {
      if (this.stopped) return;
      if (transientLoss(error)) {
        // D110: one unanswered renewal (Core slow, a heartbeat took 87 s)
        // killed the agent. The owner's rule: no deadline on the person's own
        // agent; a transient loss retries with backoff, without an attempt cap.
        this.renewalFailures += 1;
        const now = this.monotonic();
        const delayMs = Math.min(RENEWAL_RETRY_MAX_MS, RENEWAL_RETRY_BASE_MS * 2 ** (this.renewalFailures - 1));
        const leaseExpired = now >= this.monotonicDeadline;
        // While the verified lease still runs, retry before it ends.
        this.refreshAfter = leaseExpired ? now + delayMs : Math.min(this.monotonicDeadline, now + delayMs);
        this.logger.warn({ event: "execution.renewal_retry_scheduled", assignmentId: this.authority?.assignmentId,
          attempt: this.authority?.attempt, executionId: this.authority?.executionId,
          retry: this.renewalFailures, retryInMs: Math.max(0, Math.round(this.refreshAfter - now)), leaseExpired,
          remainingLeaseMs: Math.max(0, Math.round(this.monotonicDeadline - now)),
          code: error instanceof RemoteInstanceError ? error.code : "unexpected_error",
          ...(error instanceof RemoteInstanceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) },
        leaseExpired ? "Execution lease lapsed while Core is unreachable; the agent keeps running and renewal retries" : "Retrying within the verified execution lease");
        return;
      }
      this.logger.warn({ event: "execution.renewal_fenced", assignmentId: this.authority?.assignmentId,
        attempt: this.authority?.attempt, executionId: this.authority?.executionId,
        remainingLeaseMs: Math.max(0, this.monotonicDeadline - this.monotonic()),
        renewalInFlight: this.refreshing !== null, failuresBefore: this.renewalFailures,
        code: error instanceof RemoteInstanceError ? error.code : "unexpected_error",
        ...(error instanceof RemoteInstanceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) },
      "Core answered that this execution is no longer current; stopping it");
      await this.fenceAuthority();
    }
  }

  /**
   * The latest instant this assignment is known to be live: its own expiry,
   * or later where Core's verified checks have carried the local record
   * (D115: Core renews a live delivery turn past its issued hour).
   */
  liveUntil(): number {
    const assignment = this.options.assignment;
    const entry = this.options.journal.assignments.get(`${assignment.id}:${assignment.attempt}`);
    const recorded = entry ? Date.parse(entry.expiresAt) : Number.NaN;
    const issued = Date.parse(assignment.expiresAt);
    return Number.isFinite(recorded) && recorded > issued ? recorded : issued;
  }

  /** A verified check lease reaching past the local record of the assignment's lifetime moves it there, forward only. */
  private async followCoreHorizon(untilMs: number): Promise<void> {
    const assignment = this.options.assignment;
    const key = `${assignment.id}:${assignment.attempt}`;
    const entry = this.options.journal.assignments.get(key);
    if (!entry || !(untilMs > Date.parse(entry.expiresAt))) return;
    await this.options.journal.assignments.update(key, current => {
      if (!current) throw fenced();
      return untilMs > Date.parse(current.expiresAt) ? { ...current, expiresAt: new Date(untilMs).toISOString() } : current;
    });
  }

  private async fenceAuthority(): Promise<void> {
    this.stop();
    this.authorityStop = Promise.resolve().then(() => this.options.onAuthorityLost());
    await this.authorityStop.catch(() => undefined); // Retained for owner teardown.
  }
}

function verificationReason(error: unknown): string {
  const reason = error && typeof error === "object" && "verificationReason" in error ? error.verificationReason : undefined;
  return typeof reason === "string" && ["signature_or_encoding", "schema", "not_yet_valid", "expired", "authority_mismatch", "operation_mismatch", "invalid_clock"].includes(reason)
    ? reason : "execution_verification_failed";
}

/**
 * The authority a delivery check lease is verified against: the one held,
 * or, when Core's lease names a later `expiresAt`, the same authority with
 * that lifetime (D115: Core renews a live turn). The lease is still verified
 * in full against it, signature and every other field, so nothing but the
 * lifetime can move this way, and only forward.
 */
function renewedView<T extends { expiresAt: string }>(held: T, lease: string): T {
  try {
    const body = JSON.parse(Buffer.from(lease.split(".")[1] ?? "", "base64url").toString("utf8")) as { expiresAt?: unknown };
    return typeof body.expiresAt === "string" && Date.parse(body.expiresAt) > Date.parse(held.expiresAt)
      ? { ...held, expiresAt: body.expiresAt } : held;
  } catch {
    return held;
  }
}
