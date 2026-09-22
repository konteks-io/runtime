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
export const NATIVE_EXECUTION_RENEWAL_BUDGET_MS = 5_000;
const RENEWAL_RETRY_DELAY_MS = 1_000;
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
    const keys = await this.options.client.executionSigningKeys(undefined, signedOperationKeyId(envelope.permit));
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

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Owner teardown must observe a failed safety stop; callback failure is not
   * evidence that the bridge stopped or that cancellation succeeded. */
  waitForAuthorityStop(): Promise<void> { return this.authorityStop ?? Promise.resolve(); }

  private localAuthority(claims: RemoteExecutionOperationPermitClaims | RemoteDeliveryOperationPermitClaims | Authority, replay = false): Authority {
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
      : assignment.kind === "assistant_execution" && assignment.source.kind === "conversation" &&
        assignment.source.sessionId === claims.sessionId && assignment.source.turnRef === claims.turnRef;
    if (!entry || !ready || !sourceMatches || entry.kind !== assignment.kind ||
      assignment.workspaceId !== claims.workspaceId || assignment.instanceId !== claims.instanceId ||
      assignment.id !== claims.assignmentId || assignment.attempt !== claims.attempt ||
      entry.workspaceId !== claims.workspaceId || assignment.agentRoute.agentId !== claims.agentId ||
      entry.claimId !== claims.claimId || entry.recoveryEpoch !== claims.recoveryEpoch || entry.agentId !== claims.agentId ||
      claims.runnerIncarnation !== this.options.runnerIncarnation ||
      (!replay && (!["claimed", "running", "checkpointed"].includes(entry.state) || Date.parse(entry.expiresAt) <= this.options.clock.coreNow())) ||
      !Number.isFinite(Date.parse(entry.expiresAt)) || !Number.isFinite(Date.parse(assignment.expiresAt)) ||
      Date.parse(claims.expiresAt) > Date.parse(assignment.expiresAt)) throw fenced();
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
    this.localAuthority(authority);
    // The first check establishes a lease. Every later renewal is bounded by
    // both its five-second I/O policy and the last verified monotonic lease;
    // a slow renewal must not obtain authority after that lease expires.
    const remainingLeaseMs = this.monotonicDeadline > 0
      ? Math.max(0, this.monotonicDeadline - this.monotonic())
      : NATIVE_EXECUTION_RENEWAL_BUDGET_MS;
    const deadlineAtMs = Date.now() + Math.min(NATIVE_EXECUTION_RENEWAL_BUDGET_MS, remainingLeaseMs);
    const keys = await this.options.client.executionSigningKeys(deadlineAtMs);
    this.localAuthority(authority);
    const check = delivery(authority) ? this.options.client.checkDeliveryExecution : this.options.client.checkExecution;
    if (!check) throw unavailable();
    const result = await check.call(this.options.client, authority.instanceId, authority.executionId, {
      executionRevision: authority.executionRevision, readyRevision: authority.readyRevision, runnerIncarnation: authority.runnerIncarnation,
    }, deadlineAtMs);
    this.localAuthority(authority);
    const checkInput = { lease: result.lease, trustedKeys: keys, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000), issuedAtToleranceSeconds: 1 };
    let claims;
    try {
      claims = delivery(authority) ? verifyRemoteDeliveryCheckLease({ ...checkInput, currentAuthority: authority })
        : verifyRemoteExecutionCheckLease({ ...checkInput, currentAuthority: authority });
    } catch (error) {
      this.logger.warn({ event: "execution.check_refused", assignmentId: authority.assignmentId, attempt: authority.attempt,
        claimId: authority.claimId, executionId: authority.executionId, executionRevision: authority.executionRevision,
        diagnostic: verificationReason(error), skewMs: this.options.clock.skewMs(), issuedAtToleranceSeconds: 1 }, "Native execution check refused");
      throw new RemoteInstanceError("execution_fenced", "Invalid execution check lease", { diagnostic: verificationReason(error) });
    }
    if (result.executionId !== authority.executionId || result.executionRevision !== authority.executionRevision || Date.parse(result.expiresAt) !== claims.exp * 1000) throw fenced();
    this.keys = keys;
    this.checkId = claims.checkId;
    const remainingMs = Math.max(0, claims.exp * 1000 - this.options.clock.coreNow());
    this.monotonicDeadline = this.monotonic() + remainingMs;
    this.refreshAfter = Math.max(this.monotonic(), this.monotonicDeadline - NATIVE_EXECUTION_RENEWAL_BUDGET_MS);
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.authority) return;
    try {
      this.assertDispatchCurrent(this.authority);
      if (this.monotonic() >= this.refreshAfter) await this.refresh();
    } catch (error) {
      if (this.stopped) return;
      if (this.canRetryRenewal(error)) {
        this.refreshAfter = Math.min(this.monotonicDeadline, this.monotonic() + RENEWAL_RETRY_DELAY_MS);
        return;
      }
      await this.fenceAuthority();
    }
  }

  private canRetryRenewal(error: unknown): boolean {
    // Optional continuationPolicy claims are intentionally not a local grant
    // yet: runtime has not qualified the exact operation/provider-side-effect
    // fence. A transient failure may retry only within the verified lease.
    return transientLoss(error) && this.monotonic() < this.monotonicDeadline;
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
