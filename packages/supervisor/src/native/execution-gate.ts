import type { KeyObject } from "node:crypto";
import {
  RemoteAuthorizedOperationSchema, RemoteExecutionAuthorityViewSchema, RemoteInstanceError,
  verifyRemoteExecutionOperationSignature, verifyRemoteExecutionAdmission, verifyRemoteExecutionCheckLease,
  RemoteDeliveryExecutionAuthorityViewSchema, verifyRemoteDeliveryOperationSignature, verifyRemoteDeliveryAdmission, verifyRemoteDeliveryCheckLease,
  canonicalize, type JsonValue, type RemoteDeliveryExecutionAuthorityView, type RemoteDeliveryOperationPermitClaims,
  type RemoteAuthorizedOperation, type RemoteExecutionAuthorityView, type RemoteExecutionOperationPermitClaims,
  type Clock, type RemoteWorkAssignment, type SessionToCoreMessage,
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
  monotonicNow?: () => number;
}
type Authority = RemoteExecutionAuthorityView | RemoteDeliveryExecutionAuthorityView;
const delivery = (value: Authority): value is RemoteDeliveryExecutionAuthorityView => "workloadKind" in value;
export interface AuthorizedNativeOperation {
  key: string;
  envelope: RemoteAuthorizedOperation;
  authority: Authority;
  replayCompletion?: SessionToCoreMessage;
  replay: boolean;
}
const fenced = () => new RemoteInstanceError("execution_fenced", "Native execution authority is no longer current.");
const unavailable = () => new RemoteInstanceError("execution_authority_unavailable", "Fresh execution authority is unavailable.");
/** How long a running turn outlives its check lease while Core is only slow or
 * unreachable. Long enough to ride out a Core restart (~2.5 min observed); a
 * definitive refusal still stops it at once, and no new operation is admitted
 * without a fresh check. */
export const NATIVE_CHECK_GRACE_MS = 300_000;
/** Only Core saying no, or the local claim no longer matching, ends a turn.
 * A late, failed or unreadable renewal is not evidence that authority moved. */
const transientLoss = (error: unknown): boolean =>
  error instanceof RemoteInstanceError &&
  (error.code === "execution_authority_unavailable" || error.code === "temporarily_unavailable" || error.retryable);

/** Native's independent admission boundary, required by native Assistant and delivery
 * sessions. Legacy appliance and planning-controller protocols remain separate. */
export class NativeExecutionGate {
  private readonly operations: OperationAdmissionJournal;
  private keys: ReadonlyMap<string, KeyObject> | null = null;
  private authority: Authority | null = null;
  private checkDeadline = 0;
  private monotonicDeadline = 0;
  private refreshAfter = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private stopped = false;
  private authorityStop: Promise<void> | null = null;
  private readonly monotonic: () => number;

  constructor(private readonly options: NativeExecutionGateOptions) {
    this.operations = new OperationAdmissionJournal(options.journal, options.clock);
    this.monotonic = options.monotonicNow ?? (() => performance.now());
  }

  async admit(raw: unknown): Promise<AuthorizedNativeOperation> {
    const parsed = RemoteAuthorizedOperationSchema.safeParse(raw);
    if (!parsed.success) throw new RemoteInstanceError("operation_permit_required", "A signed execution operation is required.");
    const envelope = parsed.data;
    this.options.assertOwned();
    if (this.stopped) throw fenced();
    // Fetch only the configured Core trust. No token header may select a URL.
    const keys = await this.options.client.executionSigningKeys();
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
      nowSeconds: replay ? prior.claims.iat : Math.floor(this.options.clock.coreNow() / 1000) });
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
      authenticatedProducer: claims.sender.principal, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000) };
    const receipt = delivery(authority)
      ? verifyRemoteDeliveryAdmission({ ...receiptInput, currentAuthority: authority })
      : verifyRemoteExecutionAdmission({ ...receiptInput, currentAuthority: authority });
    await this.operations.admit(receipt, consumed.receipt, () => { this.localAuthority(claims); });
    this.keys = keys;
    this.authority = authority;
    return { key: admittedOperationKey(receipt), envelope, authority, replay: false };
  }

  /** Called immediately before the bridge call, after any local preparation IO. */
  async begin(operation: AuthorizedNativeOperation): Promise<boolean> {
    if (operation.replay) return false;
    try {
      await this.refresh();
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
      this.checkDeadline <= this.options.clock.coreNow() || this.monotonicDeadline <= this.monotonic()) throw unavailable();
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
    const keys = await this.options.client.executionSigningKeys();
    this.localAuthority(authority);
    const check = delivery(authority) ? this.options.client.checkDeliveryExecution : this.options.client.checkExecution;
    if (!check) throw unavailable();
    const result = await check.call(this.options.client, authority.instanceId, authority.executionId, {
      executionRevision: authority.executionRevision, readyRevision: authority.readyRevision, runnerIncarnation: authority.runnerIncarnation,
    });
    this.localAuthority(authority);
    const checkInput = { lease: result.lease, trustedKeys: keys, nowSeconds: Math.floor(this.options.clock.coreNow() / 1000) };
    const claims = delivery(authority) ? verifyRemoteDeliveryCheckLease({ ...checkInput, currentAuthority: authority })
      : verifyRemoteExecutionCheckLease({ ...checkInput, currentAuthority: authority });
    if (result.executionId !== authority.executionId || result.executionRevision !== authority.executionRevision || Date.parse(result.expiresAt) !== claims.exp * 1000) throw fenced();
    this.keys = keys;
    this.checkDeadline = claims.exp * 1000;
    this.monotonicDeadline = this.monotonic() + Math.max(0, this.checkDeadline - this.options.clock.coreNow());
    this.refreshAfter = this.monotonic() + 10_000;
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.authority) return;
    try {
      let current = true;
      try { this.assertDispatchCurrent(this.authority); } catch (error) {
        if (!this.withinGrace(error)) throw error;
        current = false;
      }
      if (!current || this.monotonic() >= this.refreshAfter) await this.refresh();
    } catch (error) {
      if (this.stopped) return;
      // A renewal that is merely late (Core answered checks in ~16s under
      // load, past a 30s lease renewed every 10s) used to kill a finished
      // turn whose result was about to be reported. It keeps renewing through
      // a bounded grace instead; begin() stays strict meanwhile, and a
      // definitive refusal still stops the turn at once.
      if (this.withinGrace(error)) return;
      this.stop();
      this.authorityStop = Promise.resolve().then(() => this.options.onAuthorityLost());
      await this.authorityStop.catch(() => undefined); // Retained for owner teardown.
    }
  }

  private withinGrace(error: unknown): boolean {
    return transientLoss(error) && this.monotonic() < this.monotonicDeadline + NATIVE_CHECK_GRACE_MS;
  }
}
