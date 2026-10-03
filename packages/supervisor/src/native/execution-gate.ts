import type { KeyObject } from "node:crypto";
import {
  RemoteAuthorizedOperationSchema, RemoteExecutionAuthorityViewSchema, RemoteInstanceError,
  verifyRemoteExecutionOperationSignature, verifyRemoteExecutionAdmission, verifyRemoteExecutionAdmissionEvidence, verifyRemoteExecutionCheckLease,
  RemoteDeliveryExecutionAuthorityViewSchema, verifyRemoteDeliveryOperationSignature, verifyRemoteDeliveryAdmission, verifyRemoteDeliveryAdmissionEvidence, verifyRemoteDeliveryCheckLease,
  allEqual, canonicalize, type JsonValue, type RemoteDeliveryExecutionAuthorityView, type RemoteDeliveryOperationPermitClaims,
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
  /** Durable receipt delivery; failure cannot alter local fence behavior. */
  onFenceApplied?: (receipt: NativeExecutionRevisionFenceReceipt) => Promise<void>;
  monotonicNow?: () => number;
  logger?: Logger;
}
type Authority = RemoteExecutionAuthorityView | RemoteDeliveryExecutionAuthorityView;
const delivery = (value: Authority): value is RemoteDeliveryExecutionAuthorityView => "workloadKind" in value;
interface AuthorizedNativeOperation {
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
 * 30 s) and no attempt cap. Only Core's own answer that
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
    const { key, prior, replay } = this.priorAdmission(envelope);
    const claims = this.verifiedClaims(envelope, keys, prior, replay);
    // A fresh Core-signed delivery permit may carry the turn's renewed lifetime.
    if (!replay && delivery(claims)) await this.followCoreHorizon(Date.parse(claims.expiresAt));
    const authority = this.localAuthority(claims, replay);
    if (replay) return this.replayed({ key, envelope, authority }, prior!, claims);
    return this.consumeAndAdmit({ key, envelope, authority }, claims, keys);
  }

  /**
   * The durable request this operation answers, and its earlier admission.
   * Completed results may replay after permit expiry, but only with the same
   * genuine signed operation; that never grants permission to dispatch.
   */
  private priorAdmission(envelope: RemoteAuthorizedOperation): { key: string; prior: PriorAuthorization | undefined; replay: boolean } {
    const key = this.requestKey(envelope);
    const prior = this.options.journal.pendingRequests.get(key)?.authorization;
    return { key, prior, replay: prior?.state === "completed" || prior?.state === "denied" };
  }

  /** The ACP request this operation is about, by its session and id (or the operation's own id). */
  private requestKey(envelope: RemoteAuthorizedOperation): string {
    const assignment = this.options.assignment;
    const ref = this.options.journal.assignments.get(`${assignment.id}:${assignment.attempt}`)?.executionReady?.acpSessionRef;
    const message = envelope.message;
    return `${ref}:${message.kind === "acp" ? "received" : "issued"}:${"id" in message ? message.id : `operation:${envelope.operationId}`}`;
  }

  /**
   * The permit's verified claims. A retry may not consume a second operation
   * for the same durable ACP request: refuse before Core consumption can
   * create another orphan.
   */
  private verifiedClaims(envelope: RemoteAuthorizedOperation, keys: ReadonlyMap<string, KeyObject>, prior: PriorAuthorization | undefined, replay: boolean): PermitClaims {
    const verifier = this.options.assignment.source.kind === "harness_delivery" ? verifyRemoteDeliveryOperationSignature : verifyRemoteExecutionOperationSignature;
    const claims = verifier({ operation: envelope, trustedKeys: keys,
      issuedAtToleranceSeconds: 1,
      nowSeconds: replay ? prior!.claims.iat : Math.floor(this.options.clock.coreNow() / 1000) });
    if (prior && !samePermit(prior.claims, claims)) {
      throw new RemoteInstanceError("operation_conflict", "The ACP request already has a different durable admission.");
    }
    return claims;
  }

  private replayed(operation: Pick<AuthorizedNativeOperation, "key" | "envelope" | "authority">, prior: PriorAuthorization, claims: PermitClaims): AuthorizedNativeOperation {
    if (!samePermit(prior.claims, claims)) throw fenced();
    if (canonicalize(this.localAuthority(prior.claims, true) as unknown as JsonValue) !==
      canonicalize(operation.authority as unknown as JsonValue)) throw fenced();
    return { ...operation, replay: true, ...(prior.completion ? { replayCompletion: prior.completion } : {}) };
  }

  /** Consume the operation at Core and retain its admission; a receipt that no longer grants authority is kept for a non-dispatch disposition. */
  private async consumeAndAdmit(operation: Pick<AuthorizedNativeOperation, "key" | "envelope" | "authority">, claims: PermitClaims, keys: ReadonlyMap<string, KeyObject>): Promise<AuthorizedNativeOperation> {
    const { envelope, authority } = operation;
    this.assertSameExecution(authority);
    const consume = delivery(authority) ? this.options.client.consumeDeliveryExecution : this.options.client.consumeExecution;
    if (!consume) throw unavailable();
    const consumed = await consume.call(this.options.client, authority.instanceId, authority.executionId, {
      permitId: claims.permitId, operationId: claims.operationId, payloadDigest: claims.payloadDigest,
      runnerIncarnation: authority.runnerIncarnation, executionRevision: authority.executionRevision,
    });
    this.localAuthority(claims);
    const { receipt, admissionFailure } = verifiedAdmission({ operation: envelope, receipt: consumed.receipt,
      admissionId: consumed.admissionId, trustedKeys: keys,
      authenticatedProducer: claims.sender.principal, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000), issuedAtToleranceSeconds: 1 }, authority);
    await this.operations.admit(receipt, consumed.receipt, () => { this.localAuthority(claims); });
    this.logAdmission(claims, receipt.admissionId, admissionFailure);
    this.keys = keys;
    this.authority = authority;
    return { key: admittedOperationKey(receipt), envelope, authority, replay: false, ...(admissionFailure ? { admissionFailure } : {}) };
  }

  /** One execution and revision per gate. */
  private assertSameExecution(authority: Authority): void {
    if (this.authority && (this.authority.executionId !== authority.executionId || this.authority.executionRevision !== authority.executionRevision)) throw fenced();
  }

  private logAdmission(claims: PermitClaims, admissionId: string, admissionFailure: RemoteInstanceError | undefined): void {
    this.logger.info({ event: "execution.admission_retained", assignmentId: claims.assignmentId, attempt: claims.attempt,
      claimId: claims.claimId, executionId: claims.executionId, operationId: claims.operationId, permitId: claims.permitId,
      admissionId, outcome: admissionFailure ? "refused_before_dispatch" : "admitted",
      ...(admissionFailure ? { diagnostic: admissionFailure.diagnostic } : {}) }, "Native operation admission retained");
  }
  /**
   * Core's key endpoint answering slowly must not refuse a prompt and drop the
   * relay socket. Retry with backoff
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
        if (!this.keysRetryAllowed(error, { retry, delayMs, permitExpiresAtMs })) throw error;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, delayMs); timer.unref?.(); });
        this.options.assertOwned();
        if (this.stopped) throw fenced();
      }
    }
  }

  /** Whether a failed key read is retried within the permit's own lifetime; said either way. */
  private keysRetryAllowed(error: unknown, attempt: { retry: number; delayMs: number; permitExpiresAtMs: number | undefined }): boolean {
    const { retry, delayMs, permitExpiresAtMs } = attempt;
    const willRetry = transientLoss(error) && !this.stopped && permitExpiresAtMs !== undefined &&
      this.options.clock.coreNow() + delayMs < permitExpiresAtMs;
    this.logger.warn({ event: "execution.admission_keys_unavailable", assignmentId: this.options.assignment.id,
      attempt: this.options.assignment.attempt, retry, ...errorFields(error),
      willRetry, ...(willRetry ? { retryInMs: delayMs } : {}),
      permitRemainingMs: this.permitRemainingMs(permitExpiresAtMs) },
    willRetry ? "Core signing keys unavailable; retrying admission" : "Core signing keys unavailable; admission refused");
    return willRetry;
  }

  private permitRemainingMs(permitExpiresAtMs: number | undefined): number | null {
    return permitExpiresAtMs === undefined ? null : Math.max(0, permitExpiresAtMs - this.options.clock.coreNow());
  }
  /** Called immediately before the bridge call, after any local preparation IO. */
  async begin(operation: AuthorizedNativeOperation): Promise<boolean> {
    if (operation.replay) return false;
    try {
      return await this.beginDispatch(operation);
    } catch (error) {
      const state = this.options.journal.pendingRequests.get(operation.key)?.authorization?.state;
      if (state === "admitted") await this.operations.denyBeforeDispatch(operation.key);
      throw error;
    }
  }

  private async beginDispatch(operation: AuthorizedNativeOperation): Promise<boolean> {
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
   * already running; Core's answer to the next check does.
   */
  private localAuthority(claims: PermitClaims | Authority, replay = false, deadline = true): Authority {
    this.options.assertOwned();
    if (this.stopped) throw fenced();
    const ready = this.readyEntry(claims, replay, deadline);
    if (READY_FIELDS.some(field => ready[field] !== claims[field])) throw fenced();
    return authorityView(claims);
  }

  /** The assignment's journal entry and its ready record, when the claims name exactly them and the claim is still live. */
  private readyEntry(claims: PermitClaims | Authority, replay: boolean, deadline: boolean) {
    const assignment = this.options.assignment;
    const entry = this.options.journal.assignments.get(`${assignment.id}:${assignment.attempt}`);
    const ready = entry?.executionReady;
    if (!entry || !ready || !sourceMatches(claims, assignment) || !claimsMatchEntry(claims, assignment, entry) ||
      !this.entryCurrent(entry, claims, replay, deadline)) throw fenced();
    return ready;
  }

  /** This runner's claim, still running unless replayed, and inside the assignment's known lifetime. */
  private entryCurrent(entry: JournalEntry, claims: PermitClaims | Authority, replay: boolean, deadline: boolean): boolean {
    if (claims.runnerIncarnation !== this.options.runnerIncarnation) return false;
    if (!replay && !this.claimRunning(entry, deadline)) return false;
    if (!Number.isFinite(Date.parse(entry.expiresAt)) || !Number.isFinite(Date.parse(this.options.assignment.expiresAt))) return false;
    return !(Date.parse(claims.expiresAt) > this.liveUntil());
  }

  private claimRunning(entry: JournalEntry, deadline: boolean): boolean {
    return LIVE_CLAIM_STATES.includes(entry.state) && !(deadline && Date.parse(entry.expiresAt) <= this.options.clock.coreNow());
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
    return this.options.journal.executionRevisionFences.pending().find((record) => allEqual([
      [record.runnerIncarnation, authority.runnerIncarnation],
      [record.connectionRef, connection.connectionRef],
      [record.connectionEpoch, connection.connectionEpoch],
      [record.intent.instanceId, authority.instanceId],
      [record.intent.executionId, authority.executionId],
      [record.intent.executionRevision, authority.executionRevision],
      [record.intent.checkId, checkId],
      [record.intent.connectionRef, connection.connectionRef],
      [record.intent.connectionEpoch, connection.connectionEpoch],
    ])) ?? null;
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
    // clipped to the lease's last milliseconds could only fail.
    const renewal: Renewal = {
      deadlineAtMs: Date.now() + NATIVE_EXECUTION_RENEWAL_BUDGET_MS,
      startedAt: this.monotonic(),
      stage: "signing_keys",
      keysElapsedMs: 0,
      context: { assignmentId: authority.assignmentId, attempt: authority.attempt,
        claimId: authority.claimId, executionId: authority.executionId, executionRevision: authority.executionRevision },
    };
    try {
      await this.renew(authority, renewal);
    } catch (error) {
      this.logger.warn({ event: "execution.renewal_failed", ...renewal.context, stage: renewal.stage,
        elapsedMs: this.monotonic() - renewal.startedAt, keysElapsedMs: renewal.keysElapsedMs,
        budgetMs: NATIVE_EXECUTION_RENEWAL_BUDGET_MS,
        remainingLeaseMs: Math.max(0, this.monotonicDeadline - this.monotonic()),
        code: errorCode(error),
        retryable: transientLoss(error), skewMs: this.options.clock.skewMs() }, "Native execution renewal failed");
      throw error;
    }
  }

  private async renew(authority: Authority, renewal: Renewal): Promise<void> {
    const keys = await this.options.client.executionSigningKeys(renewal.deadlineAtMs);
    renewal.keysElapsedMs = this.monotonic() - renewal.startedAt;
    renewal.stage = "check";
    this.localAuthority(authority, false, false);
    const result = await this.check(authority, renewal.deadlineAtMs);
    this.localAuthority(authority, false, false);
    renewal.stage = "verification";
    const lapsedMs = this.monotonicDeadline > 0 ? Math.max(0, this.monotonic() - this.monotonicDeadline) : 0;
    const claims = this.verifiedCheck(authority, result.lease, keys);
    if (result.executionId !== authority.executionId || result.executionRevision !== authority.executionRevision || Date.parse(result.expiresAt) !== claims.exp * 1000) throw fenced();
    this.keys = keys;
    this.checkId = claims.checkId;
    await this.followRenewedTurn(authority, claims);
    this.acceptLease(claims, renewal, lapsedMs);
  }

  private check(authority: Authority, deadlineAtMs: number) {
    const check = delivery(authority) ? this.options.client.checkDeliveryExecution : this.options.client.checkExecution;
    if (!check) throw unavailable();
    return check.call(this.options.client, authority.instanceId, authority.executionId, {
      executionRevision: authority.executionRevision, readyRevision: authority.readyRevision, runnerIncarnation: authority.runnerIncarnation,
    }, deadlineAtMs);
  }

  /**
   * The check lease's verified claims. A genuine check that a slow Core
   * answered after its own expiry says nothing about the execution: it is
   * asked again rather than stopping the agent.
   */
  private verifiedCheck(authority: Authority, lease: string, keys: ReadonlyMap<string, KeyObject>): CheckClaims {
    const checkInput = { lease, trustedKeys: keys, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000), issuedAtToleranceSeconds: 1 };
    try {
      return delivery(authority) ? verifyRemoteDeliveryCheckLease({ ...checkInput, currentAuthority: renewedView(authority, lease) })
        : verifyRemoteExecutionCheckLease({ ...checkInput, currentAuthority: authority });
    } catch (error) {
      const reason = verificationReason(error);
      this.logger.warn({ event: "execution.check_refused", assignmentId: authority.assignmentId, attempt: authority.attempt,
        claimId: authority.claimId, executionId: authority.executionId, executionRevision: authority.executionRevision,
        diagnostic: reason, skewMs: this.options.clock.skewMs(), issuedAtToleranceSeconds: 1 }, "Native execution check refused");
      if (reason === "expired") throw new RemoteInstanceError("execution_authority_unavailable", "Execution check lease expired in transit", { diagnostic: reason, retryable: true });
      throw new RemoteInstanceError("execution_fenced", "Invalid execution check lease", { diagnostic: reason });
    }
  }

  /** Core renewed this turn: the verified answer is the same authority with a later lifetime, held from now on. */
  private async followRenewedTurn(authority: Authority, claims: CheckClaims): Promise<void> {
    if (!delivery(authority) || !(Date.parse(claims.expiresAt) > Date.parse(authority.expiresAt))) return;
    await this.followCoreHorizon(Date.parse(claims.expiresAt));
    if (this.authority === authority) this.authority = { ...authority, expiresAt: claims.expiresAt };
  }

  private acceptLease(claims: CheckClaims, renewal: Renewal, lapsedMs: number): void {
    const remainingMs = Math.max(0, claims.exp * 1000 - this.options.clock.coreNow());
    this.monotonicDeadline = this.monotonic() + remainingMs;
    this.refreshAfter = Math.max(this.monotonic(), this.monotonicDeadline - Math.min(RENEWAL_LEAD_MS, remainingMs));
    const recoveredAfter = this.renewalFailures;
    this.renewalFailures = 0;
    this.logger.info({ event: "execution.renewal_completed", ...renewal.context,
      elapsedMs: this.monotonic() - renewal.startedAt, keysElapsedMs: renewal.keysElapsedMs,
      remainingLeaseMs: remainingMs, nextRenewalInMs: Math.max(0, this.refreshAfter - this.monotonic()),
      ...(recoveredAfter > 0 ? { recoveredAfterFailures: recoveredAfter } : {}),
      ...(lapsedMs > 0 ? { leaseLapsedMs: Math.round(lapsedMs) } : {}),
      skewMs: this.options.clock.skewMs() }, "Native execution lease verified");
  }
  private async tick(): Promise<void> {
    if (this.stopped || !this.authority) return;
    try {
      await this.checkRunning(this.authority);
    } catch (error) {
      if (this.stopped) return;
      if (transientLoss(error)) return this.scheduleRenewalRetry(error);
      this.logFenced(error);
      await this.fenceAuthority();
    }
  }

  private logFenced(error: unknown): void {
    this.logger.warn({ event: "execution.renewal_fenced", assignmentId: this.authority?.assignmentId,
      attempt: this.authority?.attempt, executionId: this.authority?.executionId,
      remainingLeaseMs: Math.max(0, this.monotonicDeadline - this.monotonic()),
      renewalInFlight: this.refreshing !== null, failuresBefore: this.renewalFailures, ...errorFields(error) },
    "Core answered that this execution is no longer current; stopping it");
  }

  /**
   * The running prompt stays bound to its own local admission and to Core's
   * durable revision fence; an expired lease only holds back new dispatch
   * (assertDispatchCurrent) until Core answers again.
   */
  private async checkRunning(authority: Authority): Promise<void> {
    this.localAuthority(authority, false, false);
    if (this.hasDurableRevisionFence(authority)) throw fenced();
    if (!this.refreshing && this.monotonic() >= this.refreshAfter) await this.refresh();
  }

  /**
   * A transient loss retries with backoff, without an attempt cap: there is
   * no deadline on the person's own agent. While the verified lease still
   * runs, the retry comes before it ends.
   */
  private scheduleRenewalRetry(error: unknown): void {
    this.renewalFailures += 1;
    const now = this.monotonic();
    const delayMs = Math.min(RENEWAL_RETRY_MAX_MS, RENEWAL_RETRY_BASE_MS * 2 ** (this.renewalFailures - 1));
    const leaseExpired = now >= this.monotonicDeadline;
    this.refreshAfter = leaseExpired ? now + delayMs : Math.min(this.monotonicDeadline, now + delayMs);
    this.logger.warn({ event: "execution.renewal_retry_scheduled", assignmentId: this.authority?.assignmentId,
      attempt: this.authority?.attempt, executionId: this.authority?.executionId,
      retry: this.renewalFailures, retryInMs: Math.max(0, Math.round(this.refreshAfter - now)), leaseExpired,
      remainingLeaseMs: Math.max(0, Math.round(this.monotonicDeadline - now)), ...errorFields(error) },
    leaseExpired ? "Execution lease lapsed while Core is unreachable; the agent keeps running and renewal retries" : "Retrying within the verified execution lease");
  }
  /**
   * The latest instant this assignment is known to be live: its own expiry,
   * or later where Core's verified checks have carried the local record
   * (Core renews a live delivery turn past its issued hour).
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

type PermitClaims = RemoteExecutionOperationPermitClaims | RemoteDeliveryOperationPermitClaims;
type CheckClaims = ReturnType<typeof verifyRemoteExecutionCheckLease> | ReturnType<typeof verifyRemoteDeliveryCheckLease>;
type PriorAuthorization = NonNullable<NonNullable<ReturnType<SupervisorJournal["pendingRequests"]["get"]>>["authorization"]>;
type JournalEntry = NonNullable<ReturnType<SupervisorJournal["assignments"]["get"]>>;

/** One renewal's budget, timing and log context, updated as it moves through its stages. */
interface Renewal {
  deadlineAtMs: number;
  startedAt: number;
  stage: string;
  keysElapsedMs: number;
  context: { assignmentId: string; attempt: number; claimId: string; executionId: string; executionRevision: number };
}

/** States in which the claim may still dispatch. */
const LIVE_CLAIM_STATES: readonly string[] = ["claimed", "running", "checkpointed"];
/** Fields the claims must share with the ready record. */
const READY_FIELDS = ["workspaceId", "instanceId", "sessionId", "channelId", "assignmentId", "attempt", "claimId",
  "recoveryEpoch", "runnerIncarnation", "agentId", "acpSessionRef", "readyRevision"] as const;

function errorCode(error: unknown): string {
  return error instanceof RemoteInstanceError ? error.code : "unexpected_error";
}

function errorFields(error: unknown): { code: string; diagnostic?: string } {
  return { code: errorCode(error), ...(error instanceof RemoteInstanceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}

type PermitIdentity = Pick<PermitClaims, "permitId" | "operationId" | "payloadDigest" | "executionId" | "executionRevision">;

/** Same permit, operation, payload, execution and revision. */
function samePermit(prior: PermitIdentity, claims: PermitIdentity): boolean {
  return allEqual([
    [prior.permitId, claims.permitId],
    [prior.operationId, claims.operationId],
    [prior.payloadDigest, claims.payloadDigest],
    [prior.executionId, claims.executionId],
    [prior.executionRevision, claims.executionRevision],
  ]);
}

/**
 * Consumption has already committed in Core. A genuine receipt that arrived
 * too late is retained for a non-dispatch disposition; it must never
 * disappear merely because it no longer grants current authority.
 */
function verifiedAdmission(receiptInput: Omit<Parameters<typeof verifyRemoteExecutionAdmission>[0], "currentAuthority">, authority: Authority) {
  try {
    return { receipt: delivery(authority)
      ? verifyRemoteDeliveryAdmission({ ...receiptInput, currentAuthority: authority })
      : verifyRemoteExecutionAdmission({ ...receiptInput, currentAuthority: authority }) };
  } catch (error) {
    const receipt = delivery(authority)
      ? verifyRemoteDeliveryAdmissionEvidence({ ...receiptInput, currentAuthority: authority })
      : verifyRemoteExecutionAdmissionEvidence({ ...receiptInput, currentAuthority: authority });
    const reason = verificationReason(error);
    const admissionFailure = new RemoteInstanceError(reason === "expired" ? "operation_expired" : "operation_permit_invalid",
      "The operation admission is not currently valid.", { diagnostic: reason });
    return { receipt, admissionFailure };
  }
}

function authorityView(claims: PermitClaims | Authority): Authority {
  const schema = delivery(claims) ? RemoteDeliveryExecutionAuthorityViewSchema : RemoteExecutionAuthorityViewSchema;
  return schema.parse(Object.fromEntries(Object.keys(schema.shape)
    .map(field => [field, Reflect.get(claims, field)])));
}

/** The claims name exactly this assignment's source: its delivery turn and model, or its conversation turn. */
function sourceMatches(claims: PermitClaims | Authority, assignment: RemoteWorkAssignment): boolean {
  return delivery(claims) ? deliverySourceMatches(claims, assignment) : conversationSourceMatches(claims as RemoteExecutionAuthorityView, assignment);
}

function deliverySourceMatches(claims: RemoteDeliveryExecutionAuthorityView, assignment: RemoteWorkAssignment): boolean {
  if (!(assignment.kind === "delivery" || assignment.kind === "validation") || assignment.source.kind !== "harness_delivery") return false;
  const source = assignment.source;
  const identity = claims.deliveryIdentity;
  const model = claims.modelSelection;
  return allEqual([
    [source.executionSessionId, claims.sessionId],
    [source.ownerInstanceId, claims.instanceId],
    [source.turn.invocationId, identity.invocationId],
    [source.turn.dispatchGeneration, identity.dispatchGeneration],
    [assignment.correlationId, identity.invocationId],
    [assignment.taskId, identity.taskId],
    [assignment.agentRoute.requiredRole, identity.requiredRuntimeRole],
    [assignment.agentRoute.agentId, identity.agentId],
    [assignment.agentRoute.sessionConfig?.model, model.selectedValue],
    [source.repositoryId, identity.repositoryId],
    [source.modelBinding.canonicalProviderId, model.canonicalIdentity.canonicalProviderId],
    [source.modelBinding.canonicalModelId, model.canonicalIdentity.canonicalModelId],
    [identity.modelBinding.selectedValue, model.selectedValue],
    [identity.modelBinding.canonicalProviderId, model.canonicalIdentity.canonicalProviderId],
    [identity.modelBinding.canonicalModelId, model.canonicalIdentity.canonicalModelId],
  ]);
}

function conversationSourceMatches(claims: RemoteExecutionAuthorityView, assignment: RemoteWorkAssignment): boolean {
  const source = conversationSource(assignment);
  return source !== null && source.sessionId === claims.sessionId && source.turnRef === claims.turnRef;
}

/** An Assistant turn's conversation, or a person's direct session prompt. */
function conversationSource(assignment: RemoteWorkAssignment) {
  if (assignment.kind === "assistant_execution" && assignment.source.kind === "conversation") return assignment.source;
  if (assignment.kind === "direct" && assignment.source.kind === "direct_session") return assignment.source;
  return null;
}

/** The claims name this assignment, attempt, workspace, runtime and agent, and the journal entry's claim. */
function claimsMatchEntry(claims: PermitClaims | Authority, assignment: RemoteWorkAssignment, entry: JournalEntry): boolean {
  return allEqual([
    [entry.kind, assignment.kind],
    [assignment.workspaceId, claims.workspaceId],
    [assignment.instanceId, claims.instanceId],
    [assignment.id, claims.assignmentId],
    [assignment.attempt, claims.attempt],
    [entry.workspaceId, claims.workspaceId],
    [assignment.agentRoute.agentId, claims.agentId],
    [entry.claimId, claims.claimId],
    [entry.recoveryEpoch, claims.recoveryEpoch],
    [entry.agentId, claims.agentId],
  ]);
}

function verificationReason(error: unknown): string {
  const reason = error && typeof error === "object" && "verificationReason" in error ? error.verificationReason : undefined;
  return typeof reason === "string" && ["signature_or_encoding", "schema", "not_yet_valid", "expired", "authority_mismatch", "operation_mismatch", "invalid_clock"].includes(reason)
    ? reason : "execution_verification_failed";
}

/**
 * The authority a delivery check lease is verified against: the one held,
 * or, when Core's lease names a later `expiresAt`, the same authority with
 * that lifetime (Core renews a live turn). The lease is still verified
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
