import { z } from "zod";
import { createPublicKey, type KeyObject } from "node:crypto";
import {
  BoundedJsonValueSchema,
  ClaimResultSchema,
  PlanningControllerDirectivePullRequestSchema,
  PlanningControllerDirectivePullResultSchema,
  HeartbeatResultSchema,
  RemoteAgentCapabilityRedeemRequestSchema,
  RemoteAgentCapabilityRedeemResultSchema,
  DesiredConfigurationAckSchema,
  DesiredConfigurationEnvelopeSchema,
  DesiredConfigurationAckResultSchema,
  RemoteInstanceError,
  RemoteExecutionReadyRequestSchema,
  RemoteExecutionReadyResultSchema,
  RemoteExecutionConsumeRequestSchema,
  RemoteExecutionConsumeResultSchema,
  RemoteExecutionCheckRequestSchema,
  RemoteExecutionCheckResultSchema,
  remoteExecutionInstanceProofSubject,
  type RemoteExecutionConsumeRequest,
  type RemoteExecutionCheckRequest,
  JsonClient,
  PendingPermissionViewSchema,
  REMOTE_INSTANCE_LEASE_AUDIENCE,
  REMOTE_INSTANCE_PROOF_AUDIENCE,
  RemoteInstanceActivationExchangeResultSchema,
  RemoteInstanceProvisioningCredentialRefreshResultSchema,
  RemoteLeaseModeSchema,
  RemoteInstanceReconciliationManifestSchema,
  RemoteInstanceReconnectRequestSchema,
  RemoteRuntimeOwnerResolveRequestSchema,
  RemoteRuntimeOwnerResolveResultSchema,
  NativeAssignmentRequestSchema,
  NativeAssignmentResultSchema,
  NativeAssignmentAckRequestSchema,
  NativeAssignmentAckResultSchema,
  NativeCancellationReceiptSchema,
  NativeCancellationReceiptRequestSchema,
  NativeCancellationReceiptResultSchema,
  type NativeCancellationReceipt,
  type NativeCancellationReceiptResult,
  RemoteReconciliationAppliedRequestSchema,
  RemoteReconciliationAppliedResultSchema,
  computeRemoteReconciliationReceiptDigest,
  ReportAckSchema,
  ToRuntimeRelayFrameSchema,
  WorkAvailableSchema,
  signInstanceProof,
  jcsDigest,
  type AssignmentClaim,
  type AssignmentPull,
  type AssignmentReport,
  type BoundedJsonValue,
  type ClaimResult,
  type PlanningControllerDirectivePullRequest,
  type PlanningControllerDirectivePullResult,
  type LogicalAssignmentRequestFrame,
  type NativeAssignmentResult,
  type NativeAssignmentAckResult,
  type Clock,
  type DesiredConfigurationEnvelope,
  type FetchFn,
  type HeartbeatMessage,
  type HeartbeatResult,
  type InstanceKeyPair,
  type JsonValue,
  type PendingPermissionView,
  type RemoteInstanceActivationExchangeRequest,
  type RemoteInstanceActivationExchangeResult,
  type RemoteInstanceProvisioningCredentialRefreshRequest,
  type RemoteInstanceProvisioningCredentialRefreshResult,
  type RemoteInstanceReadinessRequest,
  type RemoteExecutionReadyRequest,
  type RemoteExecutionReadyResult,
  type RemoteInstanceReconciliationManifest,
  type RemoteInstanceReconnectRequest,
  type RemoteRuntimeOwnerResolveResult,
  type RemoteReconciliationAppliedRequest,
  type RemoteReconciliationAppliedResult,
  type ReportAck,
  type ToRuntimeRelayFrame,
  type WorkAvailable,
} from "@konteks/remote-common";
import { decodeLeaseClaims } from "../lease/lease.js";

/**
 * Core's private supervisor endpoints over TLS. CP3 mounts the
 * `remote-instance-backend` plugin at `/api/remote-instances`; its
 * supervisor-private table is exactly: `jwks`, `activation-exchange`,
 * `:id/provisioning-credential`, `:id/desired-configuration[/ack]`,
 * `:id/readiness`, `:id/heartbeat`, `:id/reconnect`,
 * `:id/runtime-owner/resolve`, `:id/reconciliation/applied`,
 * `:id/assignments/{pull,claim,report}`, `:id/observations`,
 * `:id/permissions/deferred`, and `:id/capability-tokens/redeem`. Every
 * HTTPS-fallback message carries the same schema and idempotency key as its
 * relay channel ("the HTTPS endpoints above remain the semantic definition
 * and the fallback").
 */
const CORE_BASE = "/api/remote-instances/internal/remote-instances";
const instancePath = (instanceId: string, suffix: string): string => `${CORE_BASE}/${encodeURIComponent(instanceId)}/${suffix}`;

export const CORE_PATHS = Object.freeze({
  jwks: `${CORE_BASE}/jwks`,
  activationExchange: `${CORE_BASE}/activation-exchange`,
  provisioningCredential: (instanceId: string) => instancePath(instanceId, "provisioning-credential"),
  readiness: (instanceId: string) => instancePath(instanceId, "readiness"),
  executionReady: (instanceId: string) => instancePath(instanceId, "executions/ready"),
  executionConsume: (instanceId: string, executionId: string) => instancePath(instanceId, `executions/${encodeURIComponent(executionId)}/consume`),
  deliveryExecutionConsume: (instanceId: string, executionId: string) => instancePath(instanceId, `delivery-executions/${encodeURIComponent(executionId)}/consume`),
  deliveryExecutionCheck: (instanceId: string, executionId: string) => instancePath(instanceId, `delivery-executions/${encodeURIComponent(executionId)}/check`),
  executionCheck: (instanceId: string, executionId: string) => instancePath(instanceId, `executions/${encodeURIComponent(executionId)}/check`),
  desiredConfiguration: (instanceId: string) => instancePath(instanceId, "desired-configuration"),
  /** CP3 exposes this route for configuration acknowledgements only. */
  controlAck: (instanceId: string) => instancePath(instanceId, "desired-configuration/ack"),
  reconnect: (instanceId: string) => instancePath(instanceId, "reconnect"),
  runtimeOwnerResolve: (instanceId: string) => instancePath(instanceId, "runtime-owner/resolve"),
  reconciliationApplied: (instanceId: string) => instancePath(instanceId, "reconciliation/applied"),
  heartbeat: (instanceId: string) => instancePath(instanceId, "heartbeat"),
  assignmentStream: (instanceId: string) => instancePath(instanceId, "assignments/stream"),
  assignmentStreamAck: (instanceId: string) => instancePath(instanceId, "assignments/stream/ack"),
  cancellationReceipt: (instanceId: string) => instancePath(instanceId, "cancellations/receipt"),
  controllerDirectivesPull: (instanceId: string) => instancePath(instanceId, "controller-directives/pull"),
  pull: (instanceId: string) => instancePath(instanceId, "assignments/pull"),
  claim: (instanceId: string) => instancePath(instanceId, "assignments/claim"),
  report: (instanceId: string) => instancePath(instanceId, "assignments/report"),
  observations: (instanceId: string) => instancePath(instanceId, "observations"),
  permissionsDeferred: (instanceId: string) => instancePath(instanceId, "permissions/deferred"),
  capabilityTokenRedeem: (instanceId: string) => instancePath(instanceId, "capability-tokens/redeem"),
  // CONTRACT-GAP: `RemoteWorkAssignment` carries no delivery/validation/qa
  // definition, so the supervisor reads it for a CLAIMED assignment from
  // this lease-guarded route (added to Core with this seam) and serves it to
  // the components as the Harness `workload` / the Validation Runtime `spec`.
  workload: (instanceId: string, assignmentId: string) => instancePath(instanceId, `assignments/${encodeURIComponent(assignmentId)}/workload`),
  // CONTRACT-GAP: durable task-checkout affinity (invariant 15) had no route
  // for the owner to report a materialization. Added to Core with this seam.
  taskCheckoutMaterialized: (instanceId: string, assignmentId: string) => instancePath(instanceId, `assignments/${encodeURIComponent(assignmentId)}/task-checkout/materialized`),
  // CONTRACT-GAP: control-poll and generic session-frame HTTPS routes are not
  // mounted by Core. Lease renewal uses only the signed heartbeat above.
  controlPoll: (instanceId: string) => instancePath(instanceId, "control/poll"),
  sessionOutbound: (instanceId: string) => instancePath(instanceId, "session/outbound"),
  sessionInbound: (instanceId: string) => instancePath(instanceId, "session/inbound"),
});

/**
 * Audience of every instance-key proof (CP3 `instanceProof.ts`): the proof
 * bytes are JCS of `{v:'konteks-instance-proof-v1', method, audience:
 * 'konteks:remote-instance', subject, nonce, bodyDigest}`, ES256. The lease
 * itself carries the distinct `REMOTE_INSTANCE_LEASE_AUDIENCE`.
 */
/** The shared instance-proof audience; a local copy is how two sides drift. */
export const CORE_AUDIENCE = REMOTE_INSTANCE_PROOF_AUDIENCE;
export const LEASE_AUDIENCE: string = REMOTE_INSTANCE_LEASE_AUDIENCE;

// CONTRACT-GAP: CP1 exports the readiness request but no response schema.
// Match ProvisioningService's initial and idempotent response, remaining strict.
const ReadinessResultSchema = z.object({ instanceId: z.string(), administrativeStatus: z.literal("active"), lease: z.string().min(1), leaseExpiresAt: z.string(), leaseMode: RemoteLeaseModeSchema, heartbeatIntervalSeconds: z.number().int().positive() }).strict();
export type { HeartbeatResult } from "@konteks/remote-common";
const ControlPollSchema = z.object({ frames: z.array(ToRuntimeRelayFrameSchema).max(64) }).strict();
const ObservationsResultSchema = z.object({ accepted: z.number().int().nonnegative() }).strict();
const AckResultSchema = z.object({ accepted: z.boolean() }).strict();
const ControllerDirectivePullInputSchema = z.object({
  version: PlanningControllerDirectivePullRequestSchema.shape.version,
  afterSequence: PlanningControllerDirectivePullRequestSchema.shape.afterSequence,
  runnerIncarnation: PlanningControllerDirectivePullRequestSchema.shape.runnerIncarnation,
  maxItems: PlanningControllerDirectivePullRequestSchema.shape.maxItems,
  waitSeconds: PlanningControllerDirectivePullRequestSchema.shape.waitSeconds,
}).strict();
type ControllerDirectivePullInput = Omit<PlanningControllerDirectivePullRequest, "proof">;
/**
 * Core answers a redemption with the bearer token itself (`{token, expiresAt,
 * toolScopes}`, CP3 `TokenService.redeemAgentCapabilityToken`); the supervisor
 * composes the ACP `mcpServers` entry from it and the configured platform MCP
 * URL. The response cannot substitute an MCP endpoint or headers.
 */
export interface CapabilityTokenIssue {
  /** Composed into ACP `mcpServers` in memory only; never journaled. */
  mcpServer: { name: string; url: string; headers: Array<{ name: string; value: string }> };
  expiresAt: string;
}
const WorkloadReadSchema = z.object({ assignmentId: z.string().min(1), attempt: z.number().int().positive(), kind: z.enum(["delivery", "validation", "preview", "qa", "assistant_execution"]), workload: BoundedJsonValueSchema }).strict();
export type WorkloadRead = z.infer<typeof WorkloadReadSchema>;
const TaskCheckoutMaterializedResultSchema = z.object({ workspaceRef: z.string().min(1) }).strict();

/** Core's `DeferredPermission` (CP3 `PendingPermissionService`): what the supervisor posts for a component-raised deferral. */
export type DeferredPermissionBody =
  | { kind: "permission"; sessionId: string; assignmentId: string; attempt: number; agentId: string; requestId: string; permission: { title: string; toolKind?: string; options: Array<{ optionId: string; name: string; kind: string }> } }
  | { kind: "elicitation"; sessionId: string; assignmentId: string; attempt: number; agentId: string; requestId: string; elicitation: { message: string; requestedSchema: BoundedJsonValue; isSignIn: boolean } };

export interface CoreClientOptions {
  baseUrl: string;
  clock: Clock;
  key: () => InstanceKeyPair;
  /** Bearer credential for the current phase: the provisioning credential, then the lease. */
  credential: () => string | null;
  fetchFn?: FetchFn;
  /** The platform MCP endpoint agents reach through `mcpServers`; defaults to Core's root MCP surface. */
  platformMcpUrl?: string;
}

export class CoreClient {
  private readonly http: JsonClient;
  /** Recovery is authenticated by a machine proof, independent of a predecessor bearer. */
  private readonly proofHttp: JsonClient;

  constructor(private readonly options: CoreClientOptions) {
    const transport = {
      baseUrl: options.baseUrl,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      onServerTime: (serverTime: number, roundTrip: number) => options.clock.observeCoreTime(serverTime, roundTrip),
    };
    this.proofHttp = new JsonClient(transport);
    this.http = new JsonClient({
      ...transport,
      authorization: () => {
        const credential = options.credential();
        return credential ? `Bearer ${credential}` : null;
      },
    });
  }

  private proof(method: string, subject: string, body: { [key: string]: JsonValue }, nonce?: string) {
    return signInstanceProof(this.options.key(), { method, audience: CORE_AUDIENCE, subject, body }, nonce);
  }

  async activationExchange(request: Omit<RemoteInstanceActivationExchangeRequest, "proof">, nonce: string): Promise<RemoteInstanceActivationExchangeResult> {
    return this.http.request({ method: "POST", path: CORE_PATHS.activationExchange,
      bodyFactory: () => ({ ...request, proof: this.proof("activation_exchange", request.activationId, request as unknown as { [key: string]: JsonValue }) }),
      schema: RemoteInstanceActivationExchangeResultSchema, idempotencyKey: `activation:${request.activationId}:${nonce}` });
  }

  async refreshProvisioningCredential(request: Omit<RemoteInstanceProvisioningCredentialRefreshRequest, "proof">): Promise<RemoteInstanceProvisioningCredentialRefreshResult> {
    return this.http.request({ method: "POST", path: CORE_PATHS.provisioningCredential(request.instanceId),
      bodyFactory: () => ({ ...request, proof: this.proof("provisioning_refresh", request.instanceId, request as unknown as { [key: string]: JsonValue }) }), schema: RemoteInstanceProvisioningCredentialRefreshResultSchema,
      idempotencyKey: `provisioning-refresh:${request.instanceId}:${request.manifestDigest}` });
  }

  async submitReadiness(request: Omit<RemoteInstanceReadinessRequest, "proof">): Promise<z.infer<typeof ReadinessResultSchema>> {
    return this.http.request({ method: "POST", path: CORE_PATHS.readiness(request.instanceId),
      bodyFactory: () => ({ ...request, proof: this.proof("readiness", request.instanceId, request as unknown as { [key: string]: JsonValue }) }), schema: ReadinessResultSchema,
      idempotencyKey: `readiness:${request.instanceId}:${jcsDigest(request as unknown as JsonValue)}` });
  }

  async registerExecutionReady(instanceId: string, request: Omit<RemoteExecutionReadyRequest, "proof">, deadlineAtMs?: number): Promise<RemoteExecutionReadyResult> {
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.executionReady(instanceId),
      bodyFactory: () => RemoteExecutionReadyRequestSchema.parse({ ...request, proof: this.proof("execution_ready", instanceId, request) }), schema: RemoteExecutionReadyResultSchema,
      idempotencyKey: `execution-ready:${request.assignmentId}:${request.attempt}:${request.claimId}:${request.recoveryEpoch}`,
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) });
    if (result.instanceId !== instanceId || result.assignmentId !== request.assignmentId || result.attempt !== request.attempt || result.claimId !== request.claimId || result.recoveryEpoch !== request.recoveryEpoch ||
        result.runnerIncarnation !== request.runnerIncarnation || result.agentId !== request.agentId || result.acpSessionRef !== request.acpSessionRef) {
      throw new RemoteInstanceError("registration_mismatch", "Execution readiness response does not match the local claim.");
    }
    return result;
  }

  async consumeExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionConsumeRequest, "proof">) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    return this.http.request({ method: "POST", path: CORE_PATHS.executionConsume(instanceId, executionId),
      bodyFactory: () => RemoteExecutionConsumeRequestSchema.parse({ ...request, proof: this.proof("execution_consume", subject, request) }), schema: RemoteExecutionConsumeResultSchema,
      idempotencyKey: `execution-consume:${executionId}:${request.permitId}:${request.operationId}` });
  }

  async checkExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionCheckRequest, "proof">) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.executionCheck(instanceId, executionId),
      bodyFactory: () => RemoteExecutionCheckRequestSchema.parse({ ...request, proof: this.proof("execution_check", subject, request) }), schema: RemoteExecutionCheckResultSchema,
      idempotencyKey: `execution-check:${executionId}:${request.executionRevision}` });
    if (result.executionId !== executionId || result.executionRevision !== request.executionRevision) {
      throw new RemoteInstanceError("execution_fenced", "Execution check response belongs to another execution.");
    }
    return result;
  }

  async consumeDeliveryExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionConsumeRequest, "proof">) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    return this.http.request({ method: "POST", path: CORE_PATHS.deliveryExecutionConsume(instanceId, executionId),
      bodyFactory: () => RemoteExecutionConsumeRequestSchema.parse({ ...request, proof: this.proof("execution_consume", subject, request) }), schema: RemoteExecutionConsumeResultSchema,
      idempotencyKey: `delivery-execution-consume:${executionId}:${request.permitId}:${request.operationId}` });
  }

  async checkDeliveryExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionCheckRequest, "proof">) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.deliveryExecutionCheck(instanceId, executionId),
      bodyFactory: () => RemoteExecutionCheckRequestSchema.parse({ ...request, proof: this.proof("execution_check", subject, request) }), schema: RemoteExecutionCheckResultSchema,
      idempotencyKey: `delivery-execution-check:${executionId}:${request.executionRevision}` });
    if (result.executionId !== executionId || result.executionRevision !== request.executionRevision) {
      throw new RemoteInstanceError("execution_fenced", "Delivery check response belongs to another execution.");
    }
    return result;
  }

  /** Trust comes only from the configured Core origin, never a token URL/header. */
  async executionSigningKeys(): Promise<ReadonlyMap<string, KeyObject>> {
    const keySchema = z.object({ kty: z.literal("RSA"), kid: z.string().min(1).max(256),
      alg: z.literal("RS256").optional(), use: z.literal("sig").optional(),
      n: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/), e: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
    }).strict();
    try {
      const result = await this.proofHttp.request({ method: "GET", path: CORE_PATHS.jwks,
        schema: z.object({ keys: z.array(keySchema).min(1).max(32) }).strict() });
      const keys = new Map<string, KeyObject>();
      for (const jwk of result.keys) {
        if (keys.has(jwk.kid)) throw new Error("Duplicate signing key");
        const key = createPublicKey({ key: jwk, format: "jwk" });
        if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("Invalid signing key");
        keys.set(jwk.kid, key);
      }
      return keys;
    } catch {
      throw new RemoteInstanceError("execution_authority_unavailable", "Core execution signing trust is unavailable.");
    }
  }

  async fetchDesiredConfiguration(instanceId: string): Promise<DesiredConfigurationEnvelope> {
    const result = await this.http.request({ method: "GET", path: CORE_PATHS.desiredConfiguration(instanceId), schema: DesiredConfigurationEnvelopeSchema });
    if (result.instanceId !== instanceId) throw new RemoteInstanceError("registration_mismatch", "Configuration response belongs to another instance.");
    return result;
  }

  async reconnect(input: Omit<RemoteInstanceReconnectRequest, "proof">): Promise<{ lease: string; leaseExpiresAt: string; manifest: RemoteInstanceReconciliationManifest }> {
    // Detach before I/O: every retry signs the same intent, and the response is
    // compared against what was signed, never a caller object mutated meanwhile.
    const request = structuredClone(input);
    const manifest = await this.proofHttp.request({ method: "POST", path: CORE_PATHS.reconnect(request.instanceId),
      bodyFactory: () => RemoteInstanceReconnectRequestSchema.parse({ ...request, proof: this.proof("reconnect", request.instanceId, request as unknown as { [key: string]: JsonValue }) }), schema: RemoteInstanceReconciliationManifestSchema,
      idempotencyKey: `reconnect:${request.instanceId}:${request.reconnectIntentId}` });
    if (manifest.instanceId !== request.instanceId || manifest.runnerIncarnation !== request.runnerIncarnation || manifest.reconnectIntentId !== request.reconnectIntentId) throw new RemoteInstanceError("registration_mismatch", "Reconnect response belongs to another recovery intent.");
    const claims = decodeLeaseClaims(manifest.lease, { instanceId: request.instanceId, audience: LEASE_AUDIENCE });
    if (claims.exp * 1000 <= this.options.clock.coreNow()) throw new RemoteInstanceError("recovery_required", "Reconnect lease has expired.");
    // This is an internal scheduling projection, not an HTTP response wrapper.
    // Topology/workspace checks remain in Supervisor's fenced lease adoption.
    return { lease: manifest.lease, leaseExpiresAt: new Date(claims.exp * 1000).toISOString(), manifest };
  }

  /** Read-only owner projection; this neither establishes a process nor persists its CAS. */
  async resolveRuntimeOwner(instanceId: string): Promise<RemoteRuntimeOwnerResolveResult> {
    const unsigned = { instanceId };
    const result = await this.proofHttp.request({ method: "POST", path: CORE_PATHS.runtimeOwnerResolve(instanceId),
      bodyFactory: () => RemoteRuntimeOwnerResolveRequestSchema.parse({ ...unsigned, proof: this.proof("runtime_owner_resolve", instanceId, unsigned) }), schema: RemoteRuntimeOwnerResolveResultSchema,
      idempotencyKey: `runtime-owner-resolve:${instanceId}` });
    if (result.instanceId !== instanceId) throw new RemoteInstanceError("registration_mismatch", "Runtime owner response belongs to another instance.");
    return result;
  }

  /**
   * Submit an already-durable receipt. Caller owns evidence, retry scheduling and
   * the completion gate; this method never changes dispositions or marks local
   * recovery complete. Each explicit retry gets a fresh transport proof.
   */
  async applyReconciliation(input: Omit<RemoteReconciliationAppliedRequest, "proof">): Promise<RemoteReconciliationAppliedResult> {
    // Parse to a detached strict snapshot before I/O: caller mutation while the
    // response is pending cannot change the authority we compare against, and
    // every retry re-signs the same detached receipt.
    const request = structuredClone(input);
    const firstBody = RemoteReconciliationAppliedRequestSchema.parse({ ...request, proof: this.proof("reconciliation_applied", request.instanceId, request as unknown as { [key: string]: JsonValue }) });
    const digest = computeRemoteReconciliationReceiptDigest(firstBody);
    const result = await this.proofHttp.request({ method: "POST", path: CORE_PATHS.reconciliationApplied(request.instanceId),
      bodyFactory: () => RemoteReconciliationAppliedRequestSchema.parse({ ...request, proof: this.proof("reconciliation_applied", request.instanceId, request as unknown as { [key: string]: JsonValue }) }), schema: RemoteReconciliationAppliedResultSchema,
      idempotencyKey: `reconciliation-applied:${request.instanceId}:${request.manifestId}:${digest}` });
    if (result.instanceId !== request.instanceId || result.runnerIncarnation !== request.runnerIncarnation || result.manifestId !== request.manifestId || result.receiptDigest !== digest) {
      throw new RemoteInstanceError("registration_mismatch", "Applied receipt response does not match the submitted recovery generation.");
    }
    return result;
  }

  /**
   * `HeartbeatMessage` plus a detached instance-proof signature binding the
   * heartbeat operation, instance, audience and body digest. Core derives
   * the replay nonce as `seq:<sequence>`, so
   * the message carries no nonce of its own (CP3 integration note).
   */
  async heartbeat(message: HeartbeatMessage & { signature: string }): Promise<HeartbeatResult> {
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.heartbeat(message.instanceId), body: message, schema: HeartbeatResultSchema, idempotencyKey: `heartbeat:${message.instanceId}:${message.sequence}` });
    if (result.instanceId !== message.instanceId) throw new RemoteInstanceError("registration_mismatch", "Heartbeat response belongs to another instance.");
    return result;
  }

  /**
   * Carry one already-allocated logical frame. The frame is immutable: an
   * uncertain retry replays these exact bytes under refreshed authentication,
   * and Core answers with the same committed response rather than repeating
   * the work. The disposition is closed, so the caller never guesses.
   */
  async submitAssignment(instanceId: string, frame: LogicalAssignmentRequestFrame): Promise<NativeAssignmentResult> {
    const semantic = { instanceId, frame };
    return this.proofHttp.request({ method: "POST", path: CORE_PATHS.assignmentStream(instanceId),
      bodyFactory: () => NativeAssignmentRequestSchema.parse({ ...semantic,
        proof: this.proof("assignment_request", instanceId, semantic as unknown as { [key: string]: JsonValue }) }), schema: NativeAssignmentResultSchema,
      idempotencyKey: `assignment-stream:${instanceId}:${frame.channelId}:${frame.seq}` });
  }

  /**
   * Attest the durably observed Core request-ACK prefix and the validated
   * consumed reply prefix. Neither a delivery attempt nor HTTP success attests
   * either, and Core retires only what both cursors cover.
   */
  async acknowledgeAssignments(instanceId: string, cursors: { observedRequestAckSequence: number; consumedReplySequence: number }): Promise<NativeAssignmentAckResult> {
    const semantic = { instanceId, channelId: `assignment:${instanceId}`, ...cursors };
    const attemptedNonces = new Set<string>();
    const result = await this.proofHttp.request({ method: "POST", path: CORE_PATHS.assignmentStreamAck(instanceId), bodyFactory: () => {
      const body = NativeAssignmentAckRequestSchema.parse({ ...semantic,
        proof: this.proof("assignment_ack", instanceId, semantic as unknown as { [key: string]: JsonValue }) });
      attemptedNonces.add(body.proof.nonce);
      return body;
    }, schema: NativeAssignmentAckResultSchema,
      idempotencyKey: `assignment-ack:${instanceId}:${cursors.observedRequestAckSequence}:${cursors.consumedReplySequence}` });
    if (result.instanceId !== semantic.instanceId || result.channelId !== semantic.channelId || !attemptedNonces.has(result.requestNonce)) {
      throw new RemoteInstanceError("registration_mismatch", "Acknowledgement response belongs to another stream or exchange.");
    }
    return result;
  }

  /** Submit only caller-owned durable inbox evidence. This does not mark an
   * inbox handled or an ACP process stopped. Each explicit retry signs afresh. */
  async acknowledgeCancellation(receipt: NativeCancellationReceipt): Promise<NativeCancellationReceiptResult> {
    const semantic = NativeCancellationReceiptSchema.parse(receipt);
    const attemptedNonces = new Set<string>();
    const result = await this.proofHttp.request({ method: "POST", path: CORE_PATHS.cancellationReceipt(semantic.instanceId),
      bodyFactory: () => {
        const body = NativeCancellationReceiptRequestSchema.parse({ ...semantic, proof: this.proof("cancellation_receipt", semantic.instanceId, semantic) });
        attemptedNonces.add(body.proof.nonce);
        return body;
      }, schema: NativeCancellationReceiptResultSchema,
      idempotencyKey: `cancellation-receipt:${semantic.instanceId}:${semantic.intentId}` });
    if (!attemptedNonces.has(result.requestNonce) ||
        Object.entries(semantic).some(([field, value]) => result[field as keyof NativeCancellationReceipt] !== value)) {
      throw new RemoteInstanceError("registration_mismatch", "Cancellation receipt response belongs to another intent or exchange.");
    }
    return result;
  }

  /** Long-poll Core's retained planning terminal intents for this native owner. */
  async pullControllerDirectives(instanceId: string, candidate: ControllerDirectivePullInput): Promise<PlanningControllerDirectivePullResult> {
    const input = ControllerDirectivePullInputSchema.parse(candidate);
    const result = await this.http.request({
      method: "POST",
      path: CORE_PATHS.controllerDirectivesPull(instanceId),
      bodyFactory: () => PlanningControllerDirectivePullRequestSchema.parse({ ...input,
        proof: this.proof("controller_directives_pull", instanceId, input as unknown as { [key: string]: JsonValue }) }),
      schema: PlanningControllerDirectivePullResultSchema,
      idempotencyKey: `controller-directives:${instanceId}:${input.runnerIncarnation}:${input.afterSequence}`,
    });
    if (result.highWater < input.afterSequence || (result.directives.length === 0 && result.highWater > input.afterSequence)) throw new RemoteInstanceError("assignment_conflict", "Controller directive page skipped retained work");
    let expected = input.afterSequence + 1;
    const ids = new Set<string>();
    for (const directive of result.directives) {
      if (directive.directiveSequence !== expected || ids.has(directive.directiveId)) throw new RemoteInstanceError("assignment_conflict", "Controller directive page is not contiguous and unique");
      expected += 1; ids.add(directive.directiveId);
    }
    return result;
  }

  async pull(pull: AssignmentPull): Promise<WorkAvailable> {
    return this.http.request({ method: "POST", path: CORE_PATHS.pull(pull.instanceId), body: pull, schema: WorkAvailableSchema });
  }

  async claim(instanceId: string, claim: AssignmentClaim): Promise<ClaimResult> {
    return this.http.request({ method: "POST", path: CORE_PATHS.claim(instanceId), body: claim, schema: ClaimResultSchema, idempotencyKey: `claim:${claim.claimId}` });
  }

  async report(instanceId: string, report: AssignmentReport): Promise<ReportAck> {
    return this.http.request({ method: "POST", path: CORE_PATHS.report(instanceId), body: report, schema: ReportAckSchema, idempotencyKey: `report:${report.reportId}` });
  }

  async observations(instanceId: string, observations: unknown[]): Promise<number> {
    const body = { observations };
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.observations(instanceId), body, schema: ObservationsResultSchema,
      idempotencyKey: `observations:${instanceId}:${jcsDigest(body as unknown as JsonValue)}` });
    return result.accepted;
  }

  async controlAck(instanceId: string, ack: unknown): Promise<boolean | Extract<ReturnType<typeof DesiredConfigurationAckResultSchema.parse>, { status: "superseded" }>> {
    if (typeof ack === "object" && ack !== null && "type" in ack && ack.type === "desired_configuration_ack") {
      const request = DesiredConfigurationAckSchema.parse(ack);
      if (request.instanceId !== instanceId) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement instance mismatch");
      const receipt = await this.http.request({ method: "POST", path: CORE_PATHS.controlAck(instanceId), body: request, schema: DesiredConfigurationAckResultSchema,
        idempotencyKey: `configuration-ack:${instanceId}:${request.revision}:${request.status}` });
      if (receipt.instanceId !== instanceId || receipt.revision !== request.revision) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement receipt mismatch");
      if (receipt.status === "superseded") {
        if (receipt.requestDigest !== jcsDigest(request as unknown as JsonValue) || (receipt.appliedRevision === request.revision && request.status === "applied")) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement disposition mismatch");
        return receipt;
      }
      if (receipt.status !== request.status) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement receipt mismatch");
      return true;
    }
    // Non-configuration control delivery remains a separate CP3 closure gate.
    throw new RemoteInstanceError("protocol_incompatible", "This HTTPS endpoint accepts configuration acknowledgements only");
  }


  async controlPoll(instanceId: string): Promise<ToRuntimeRelayFrame[]> {
    return (await this.http.request({ method: "GET", path: CORE_PATHS.controlPoll(instanceId), schema: ControlPollSchema })).frames;
  }

  async sessionOutbound(instanceId: string, frames: unknown[]): Promise<void> {
    const body = { frames };
    await this.http.request({ method: "POST", path: CORE_PATHS.sessionOutbound(instanceId), body, schema: AckResultSchema,
      idempotencyKey: `session-outbound:${instanceId}:${jcsDigest(body as unknown as JsonValue)}` });
  }

  async sessionInbound(instanceId: string): Promise<ToRuntimeRelayFrame[]> {
    return (await this.http.request({ method: "GET", path: CORE_PATHS.sessionInbound(instanceId), schema: ControlPollSchema })).frames;
  }

  /** Repeat delivery of one claim's capability; bearer lives only in ACP configuration. */
  async redeemCapabilityToken(instanceId: string, args: { assignmentId: string; attempt: number; mcpCapabilityTokenRef: string }, deadlineAtMs?: number): Promise<CapabilityTokenIssue> {
    const request = { instanceId, ...args };
    // Core restarts and cold local E2E stacks have repeatedly answered valid
    // claim reads in 7-15 seconds. Nine seconds made a healthy, resumable
    // native turn fail during a brief control-plane warm-up. Keep the retry
    // count bounded, but allow each authenticated attempt a useful interval.
    const validated = RemoteAgentCapabilityRedeemRequestSchema.safeParse({ ...request, proof: this.proof("token_redeem", instanceId, request) });
    if (!validated.success) throw new RemoteInstanceError("capability_unavailable", "Capability request is invalid.");
    // Preserve the caller's enclosing authority deadline, but otherwise let
    // JsonClient budget all four 30-second attempts plus bounded backoff.
    const deadline = deadlineAtMs;
    try {
      const issued = await this.http.request({ method: "POST", path: CORE_PATHS.capabilityTokenRedeem(instanceId),
        bodyFactory: () => RemoteAgentCapabilityRedeemRequestSchema.parse({ ...request, proof: this.proof("token_redeem", instanceId, request) }),
        schema: RemoteAgentCapabilityRedeemResultSchema, idempotencyKey: `capability-redeem:${instanceId}:${args.assignmentId}:${args.attempt}:${args.mcpCapabilityTokenRef}`,
        timeoutMs: 30_000, ...(deadline === undefined ? {} : { deadlineAtMs: deadline }) });
      if ((deadline !== undefined && Date.now() >= deadline) || Date.parse(issued.expiresAt) <= this.options.clock.coreNow()) {
        throw new RemoteInstanceError("capability_unavailable", "Capability delivery has expired.");
      }
      // /api/app/mcp is connection-management REST, not the MCP transport.
      // The real /mcp owner still needs its capability admission integration.
      const url = this.options.platformMcpUrl ?? new URL("/mcp", this.options.baseUrl).toString();
      return { mcpServer: { name: "konteks-platform", url, headers: [{ name: "authorization", value: `Bearer ${issued.token}` }] }, expiresAt: issued.expiresAt };
    } catch (error) {
      const transient = error instanceof RemoteInstanceError && error.retryable;
      // Schema/parser/server messages may contain secret-bearing input.
      throw new RemoteInstanceError(error instanceof RemoteInstanceError ? error.code : "capability_unavailable", "Capability delivery was not accepted.", { retryable: transient });
    }
  }

  /** The claimed assignment's work definition (see `CORE_PATHS.workload`); `not_found` when Core has none. */
  async fetchWorkload(instanceId: string, assignmentId: string): Promise<WorkloadRead> {
    return this.http.request({ method: "GET", path: CORE_PATHS.workload(instanceId, assignmentId), schema: WorkloadReadSchema });
  }

  /** The Harness materialized a task checkout here; Core records the owner so exact-checkout work binds to this instance. */
  async recordTaskCheckoutMaterialized(instanceId: string, assignmentId: string, body: { taskId: string; revision?: string }): Promise<{ workspaceRef: string }> {
    return this.http.request({ method: "POST", path: CORE_PATHS.taskCheckoutMaterialized(instanceId, assignmentId), body, schema: TaskCheckoutMaterializedResultSchema,
      idempotencyKey: `task-checkout:${instanceId}:${assignmentId}:${body.taskId}:${body.revision ?? "unversioned"}` });
  }

  /** A policy deferral (session- or component-raised), posted in Core's own `DeferredPermission` shape; Core answers the sanitized `PendingPermissionView`. Idempotent per assignment attempt and request id. */
  async deferPermission(instanceId: string, deferral: DeferredPermissionBody): Promise<PendingPermissionView> {
    return this.http.request({ method: "POST", path: CORE_PATHS.permissionsDeferred(instanceId), body: deferral, schema: PendingPermissionViewSchema,
      idempotencyKey: `permission-deferral:${instanceId}:${deferral.assignmentId}:${deferral.attempt}:${deferral.requestId}` });
  }
}
