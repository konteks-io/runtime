import { AgentTurnUsageObservationSchema, RuntimeAgentLoginReportSchema, RuntimeUpdateReportSchema,
  RuntimeUpdateLocalBeginRequestSchema,
  RuntimeUpdateLocalBeginResultSchema,
  allEqual, withoutUndefined,
  directModelSelectionsEqual, createLogger, type Logger, type RuntimeUpdateReport,
  type RuntimeUpdateLocalBeginRequest,
  type RuntimeUpdateLocalBeginResult,
} from "@konteks/remote-common";

import { z } from "zod";
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
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
  NativeExecutionRevisionFenceReceiptSchema,
  NativeExecutionRevisionFenceReceiptRequestSchema,
  NativeExecutionRevisionFenceReceiptResultSchema,
  type NativeCancellationReceipt,
  type NativeCancellationReceiptResult,
  type NativeExecutionRevisionFenceReceipt,
  type NativeExecutionRevisionFenceReceiptRequest,
  type NativeExecutionRevisionFenceReceiptResult,
  RemoteReconciliationAppliedRequestSchema,
  RemoteReconciliationAppliedResultSchema,
  computeRemoteReconciliationReceiptDigest,
  RemoteRecoveryEvidenceSchema,
  RemoteReconciliationConnectionSchema,
  remoteRecoveryEvidenceIdentityKey,
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
  type RemoteRecoveryEvidence,
  type RemoteReconciliationConnection,
  type ReportAck,
  type ToRuntimeRelayFrame,
  type WorkAvailable,
} from "@konteks/remote-common";
import { decodeLeaseClaims } from "../lease/lease.js";

type RuntimeAgentLoginReport = ReturnType<typeof RuntimeAgentLoginReportSchema.parse>;

/**
 * Core's private supervisor endpoints over TLS. Core mounts the
 * `remote-instance-backend` plugin at `/api/remote-instances`; its
 * supervisor-private table is exactly: `jwks`, `activation-exchange`,
 * `:id/provisioning-credential`, `:id/desired-configuration[/ack]`,
 * `:id/readiness`, `:id/heartbeat`, `:id/reconnect`,
 * `:id/runtime-owner/resolve`, `:id/reconciliation/applied`,
 * `:id/execution-revision-controls/receipt`,
 * `:id/assignments/{pull,claim,report}`, `:id/observations`,
 * `:id/permissions/deferred`, and `:id/capability-tokens/redeem`. Every
 * HTTPS-fallback message carries the same schema and idempotency key as its
 * relay channel ("the HTTPS endpoints above remain the semantic definition
 * and the fallback").
 */
const CORE_BASE = "/api/remote-instances/internal/remote-instances";
const instancePath = (instanceId: string, suffix: string): string => `${CORE_BASE}/${encodeURIComponent(instanceId)}/${suffix}`;

const CORE_PATHS = Object.freeze({
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
  /** Core exposes this route for configuration acknowledgements only. */
  controlAck: (instanceId: string) => instancePath(instanceId, "desired-configuration/ack"),
  reconnect: (instanceId: string) => instancePath(instanceId, "reconnect"),
  runtimeOwnerResolve: (instanceId: string) => instancePath(instanceId, "runtime-owner/resolve"),
  reconciliationApplied: (instanceId: string) => instancePath(instanceId, "reconciliation/applied"),
  recoveryEvidence: (instanceId: string) => instancePath(instanceId, "recovery-evidence"),
  executionRevisionControlReceipt: (instanceId: string) => instancePath(instanceId, "execution-revision-controls/receipt"),
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
  // CONTRACT-GAP: the onboarding contract names the App BFF route
  // `POST /api/app/remote-instances/:id/git-keys`, but a runtime holds a lease,
  // not a person's session, and cannot authenticate against an App route. The
  // registration therefore sits on the supervisor-private table beside every
  // other route the runtime calls; Core forwards it to managed-git with the
  // instance id exactly as the contract describes.
  gitKeys: (instanceId: string) => instancePath(instanceId, "git-keys"),
  // A coding agent login the person started from the site.
  agentLoginReport: (instanceId: string) => instancePath(instanceId, "agent-logins/report"),
  runtimeUpdateReport: (instanceId: string) => instancePath(instanceId, "runtime-updates/report"),
  runtimeUpdateLocal: (instanceId: string) => instancePath(instanceId, "runtime-updates/local"),
  acceptedRelease: (instanceId: string) => instancePath(instanceId, "accepted-release"),
  // Uninstall: the runtime removes itself, lease-authenticated like the rest.
  retire: (instanceId: string) => instancePath(instanceId, "retire"),
  gitKey: (instanceId: string, keyRef: string) => instancePath(instanceId, `git-keys/${encodeURIComponent(keyRef)}`),
  // CONTRACT-GAP: `RemoteWorkAssignment` carries no delivery/validation/qa
  // definition, so the supervisor reads it for a CLAIMED assignment from
  // this lease-guarded route (added to Core with this seam).
  workload: (instanceId: string, assignmentId: string) => instancePath(instanceId, `assignments/${encodeURIComponent(assignmentId)}/workload`),
  // CONTRACT-GAP: durable task-checkout affinity had no route
  // for the owner to report a materialization. Added to Core with this seam.
  // CONTRACT-GAP: control-poll and generic session-frame HTTPS routes are not
  // mounted by Core. Lease renewal uses only the signed heartbeat above.
  controlPoll: (instanceId: string) => instancePath(instanceId, "control/poll"),
  sessionOutbound: (instanceId: string) => instancePath(instanceId, "session/outbound"),
  sessionInbound: (instanceId: string) => instancePath(instanceId, "session/inbound"),
});

/**
 * Audience of every instance-key proof (Core's `instanceProof.ts`): the proof
 * bytes are JCS of `{v:'konteks-instance-proof-v1', method, audience:
 * 'konteks:remote-instance', subject, nonce, bodyDigest}`, ES256. The lease
 * itself carries the distinct `REMOTE_INSTANCE_LEASE_AUDIENCE`.
 */
/** The shared instance-proof audience; a local copy is how two sides drift. */
export const CORE_AUDIENCE = REMOTE_INSTANCE_PROOF_AUDIENCE;
export const LEASE_AUDIENCE: string = REMOTE_INSTANCE_LEASE_AUDIENCE;

// CONTRACT-GAP: the shared contract exports the readiness request but no response schema.
// Match ProvisioningService's initial and idempotent response, remaining strict.
const ReadinessResultSchema = z.object({ instanceId: z.string(), administrativeStatus: z.literal("active"), lease: z.string().min(1), leaseExpiresAt: z.string(), leaseMode: RemoteLeaseModeSchema, heartbeatIntervalSeconds: z.number().int().positive() }).strict();
const ControlPollSchema = z.object({ frames: z.array(ToRuntimeRelayFrameSchema).max(64) }).strict();
const ObservationReceiptSchema = z.object({ stored: z.boolean(), observationId: z.string().min(1), observationDigest: z.string().length(43) }).strict();
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
 * toolScopes}`, Core's `TokenService.redeemAgentCapabilityToken`); the supervisor
 * composes the ACP `mcpServers` entry from it and the configured platform MCP
 * URL. The response cannot substitute an MCP endpoint or headers.
 */
export interface CapabilityTokenIssue {
  /** Composed into ACP `mcpServers` in memory only; never journaled. */
  mcpServer: { name: string; url: string; headers: Array<{ name: string; value: string }> };
  expiresAt: string;
}
const WorkloadReadSchema = z.object({ assignmentId: z.string().min(1), attempt: z.number().int().positive(), kind: z.enum(["delivery", "validation", "qa", "assistant_execution", "onboarding", "repository_relocation", "integration"]), workload: BoundedJsonValueSchema }).strict();
type WorkloadRead = z.infer<typeof WorkloadReadSchema>;

/**
 * Managed-git key registration. Core answers with the reference it
 * minted, the fingerprint managed-git stored, and the SSH host this key opens —
 * the runtime cannot know the managed host on its own, and guessing one would
 * make the machine offer its key to whatever answered.
 *
 * CONTRACT-GAP: `ManagedGitKeyRegisterRequest` also carries
 * `userEntityRef`. A runtime does not know which person it belongs to; Core
 * derives it from the instance, which is also what binds the key to this
 * runtime so removing the runtime revokes exactly this key.
 */
/**
 * What Core answers with. Managed git registers a key for the PERSON, so its
 * record names them and the instance and carries no host; a runtime reads the
 * parts it needs and ignores the rest, rather than refusing its own
 * registration as malformed.
 */
const GitKeyRegisterResultSchema = z.object({
  keyRef: z.string().min(1).max(200),
  fingerprint: z.string().min(1).max(256),
  title: z.string().min(1).max(256).optional(),
  userEntityRef: z.string().min(1).max(512).optional(),
  instanceId: z.string().min(1).max(200).optional(),
  host: z.string().min(1).max(255).optional(),
  user: z.string().min(1).max(64).optional(),
  createdAt: z.string().min(1).max(64).optional(),
  revokedAt: z.string().min(1).max(64).optional(),
});
const GitKeyListResultSchema = z.object({
  keys: z.array(z.object({
    keyRef: z.string().min(1).max(200),
    title: z.string().min(1).max(256),
    fingerprint: z.string().min(1).max(256),
    userEntityRef: z.string().min(1).max(512).optional(),
    instanceId: z.string().min(1).max(200).optional(),
    createdAt: z.string().min(1).max(64).optional(),
    revokedAt: z.string().min(1).max(64).optional(),
  })).max(64),
}).strict();

/** Core's `DeferredPermission` (Core's `PendingPermissionService`): what the supervisor posts for a component-raised deferral. */
export type DeferredPermissionBody =
  | { kind: "permission"; sessionId: string; assignmentId: string; attempt: number; agentId: string; requestId: string; permission: { title: string; toolKind?: string; toolCallBinding?: Extract<PendingPermissionView, { kind: "permission" }>["permission"]["toolCallBinding"]; options: Array<{ optionId: string; name: string; kind: string }> } }
  | { kind: "elicitation"; sessionId: string; assignmentId: string; attempt: number; agentId: string; requestId: string; elicitation: { message: string; requestedSchema: BoundedJsonValue; isSignIn: boolean } };

interface CoreClientOptions {
  baseUrl: string;
  clock: Clock;
  key: () => InstanceKeyPair;
  /** Bearer credential for the current phase: the provisioning credential, then the lease. */
  credential: () => string | null;
  fetchFn?: FetchFn;
  /** The platform MCP endpoint agents reach through `mcpServers`; defaults to Core's root MCP surface. */
  platformMcpUrl?: string;
  logger?: Logger;
}

/**
 * How long a key set Core confirmed stays usable while Core's key endpoint
 * cannot be reached (the endpoint timed out for minutes and every prompt
 * was refused). Every use of these keys is paired with a direct Core call over
 * TLS (consumption, check), so a stale set never admits work Core refuses; a
 * set missing the requested key id is never served stale.
 */
export const SIGNING_KEY_STALE_MAX_MS = 24 * 60 * 60_000;
const SIGNING_KEY_RETRY_BASE_MS = 1_000;
const SIGNING_KEY_RETRY_MAX_MS = 60_000;

const RecoveryEvidenceIngressResultSchema = z.object({
  instanceId: z.string().min(1),
  assignmentId: z.string().min(1),
  attempt: z.number().int().positive(),
  claimId: z.string().min(1),
  recoveryEpoch: z.number().int().nonnegative(),
  evidenceDigest: z.string().min(1),
  acceptedAt: z.string().datetime(),
  outcome: z.enum(["accepted", "duplicate"]),
}).strict();
type RecoveryEvidenceIngressResult = z.infer<typeof RecoveryEvidenceIngressResultSchema>;

const SIGNING_KEY_SCHEMA = z.object({ kty: z.literal("RSA"), kid: z.string().min(1).max(256),
  alg: z.literal("RS256").optional(), use: z.literal("sig").optional(),
  n: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/), e: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

/** Distinct RSA keys of at least 2048 bits, by key id. */
function signingKeyMap(jwks: ReadonlyArray<z.infer<typeof SIGNING_KEY_SCHEMA>>): ReadonlyMap<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks) {
    if (keys.has(jwk.kid)) throw new Error("Duplicate signing key");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("Invalid signing key");
    keys.set(jwk.kid, key);
  }
  return keys;
}

function keySetDiagnostic(error: unknown): string {
  if (error instanceof RemoteInstanceError) return error.code;
  return error instanceof z.ZodError ? "schema_invalid" : "invalid_key_set";
}

/** A still-valid key set may be refreshed once for a key id it does not hold. */
function unknownKidRefresh(cached: { keys: ReadonlyMap<string, KeyObject>; unknownKidRefreshUsed: boolean }, expectedKid: string | undefined): boolean {
  return Boolean(expectedKid && !cached.keys.has(expectedKid) && !cached.unknownKidRefreshUsed);
}

/** A failure's code (and diagnostic) for the log, never its message. */
function errorFields(error: unknown): { code: string; diagnostic?: string } {
  if (!(error instanceof RemoteInstanceError)) return { code: "unexpected_error" };
  return { code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}

function configurationAck(ack: unknown): boolean {
  return (
    typeof ack === "object" && ack !== null && "type" in ack && ack.type === "desired_configuration_ack"
  );
}

function supersededAck<T extends { requestDigest: string; appliedRevision?: number | null }>(receipt: T, request: ReturnType<typeof DesiredConfigurationAckSchema.parse>): T {
  if (receipt.requestDigest !== jcsDigest(request as unknown as JsonValue) || (receipt.appliedRevision === request.revision && request.status === "applied")) {
    throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement disposition mismatch");
  }
  return receipt;
}

/** Schema, parser and server messages may contain secret-bearing input: only the code and retryability survive. */
function undeliveredCapability(error: unknown): RemoteInstanceError {
  const transient = error instanceof RemoteInstanceError && error.retryable;
  return new RemoteInstanceError(error instanceof RemoteInstanceError ? error.code : "capability_unavailable", "Capability delivery was not accepted.", { retryable: transient });
}

export class CoreClient {
  private readonly http: JsonClient;
  /** Recovery is authenticated by a machine proof, independent of a predecessor bearer. */
  private readonly proofHttp: JsonClient;
  /** Trusted keys are scoped to this client’s configured Core origin. */
  private signingKeyCache: {
    keys: ReadonlyMap<string, KeyObject>;
    expiresAtMs: number;
    confirmedAtMs: number;
    unknownKidRefreshUsed: boolean;
  } | null = null;
  private signingKeyRefresh: Promise<ReadonlyMap<string, KeyObject>> | null = null;
  /** Consecutive failed key refreshes and when the next may start (backoff). */
  private signingKeyFailures = 0;
  private signingKeyRetryAtMs = 0;
  private readonly logger: Logger;

  constructor(private readonly options: CoreClientOptions) {
    this.logger = options.logger ?? createLogger({ name: "core-client" });
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
      idempotencyKey: `provisioning-refresh:${request.instanceId}:${request.manifestDigest}`, operationPolicy: "renewal" });
  }

  async submitReadiness(request: Omit<RemoteInstanceReadinessRequest, "proof">): Promise<z.infer<typeof ReadinessResultSchema>> {
    return this.http.request({ method: "POST", path: CORE_PATHS.readiness(request.instanceId),
      bodyFactory: () => ({ ...request, proof: this.proof("readiness", request.instanceId, request as unknown as { [key: string]: JsonValue }) }), schema: ReadinessResultSchema,
      idempotencyKey: `readiness:${request.instanceId}:${jcsDigest(request as unknown as JsonValue)}` });
  }

  async registerExecutionReady(instanceId: string, request: Omit<RemoteExecutionReadyRequest, "proof">, deadlineAtMs?: number,
  ): Promise<RemoteExecutionReadyResult> {
    const body = z.record(z.string(), BoundedJsonValueSchema).parse(withoutUndefined({
      ...request,
      modelSelection: request.modelSelection === undefined ? undefined : withoutUndefined(request.modelSelection),
    }));
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.executionReady(instanceId),
      bodyFactory: () => RemoteExecutionReadyRequestSchema.parse({ ...body, proof: this.proof("execution_ready", instanceId, body) }), schema: RemoteExecutionReadyResultSchema,
      idempotencyKey: `execution-ready:${request.assignmentId}:${request.attempt}:${request.claimId}:${request.recoveryEpoch}`,
      operationPolicy: "admissionPreparation",
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) });
    if (!allEqual([
      [result.instanceId, instanceId], [result.assignmentId, request.assignmentId], [result.attempt, request.attempt], [result.claimId, request.claimId],
      [result.recoveryEpoch, request.recoveryEpoch], [result.runnerIncarnation, request.runnerIncarnation], [result.agentId, request.agentId],
      [result.acpSessionRef, request.acpSessionRef],
    ]) ||
      !directModelSelectionsEqual(result.modelSelection, request.modelSelection)
    ) {
      throw new RemoteInstanceError("registration_mismatch", "Execution readiness response does not match the local claim.");
    }
    return result;
  }

  async consumeExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionConsumeRequest, "proof">) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    return this.http.request({ method: "POST", path: CORE_PATHS.executionConsume(instanceId, executionId),
      bodyFactory: () => RemoteExecutionConsumeRequestSchema.parse({ ...request, proof: this.proof("execution_consume", subject, request) }), schema: RemoteExecutionConsumeResultSchema,
      idempotencyKey: `execution-consume:${executionId}:${request.permitId}:${request.operationId}`, operationPolicy: "admissionPreparation" });
  }

  async checkExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionCheckRequest, "proof">, deadlineAtMs?: number) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.executionCheck(instanceId, executionId),
      bodyFactory: () => RemoteExecutionCheckRequestSchema.parse({ ...request, proof: this.proof("execution_check", subject, request) }), schema: RemoteExecutionCheckResultSchema,
      idempotencyKey: `execution-check:${executionId}:${request.executionRevision}`,
      operationPolicy: "executionCheck",
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) });
    if (result.executionId !== executionId || result.executionRevision !== request.executionRevision) {
      throw new RemoteInstanceError("execution_fenced", "Execution check response belongs to another execution.");
    }
    return result;
  }

  async consumeDeliveryExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionConsumeRequest, "proof">) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    return this.http.request({ method: "POST", path: CORE_PATHS.deliveryExecutionConsume(instanceId, executionId),
      bodyFactory: () => RemoteExecutionConsumeRequestSchema.parse({ ...request, proof: this.proof("execution_consume", subject, request) }), schema: RemoteExecutionConsumeResultSchema,
      idempotencyKey: `delivery-execution-consume:${executionId}:${request.permitId}:${request.operationId}`, operationPolicy: "admissionPreparation" });
  }

  async checkDeliveryExecution(instanceId: string, executionId: string, request: Omit<RemoteExecutionCheckRequest, "proof">, deadlineAtMs?: number) {
    const subject = remoteExecutionInstanceProofSubject(instanceId, executionId);
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.deliveryExecutionCheck(instanceId, executionId),
      bodyFactory: () => RemoteExecutionCheckRequestSchema.parse({ ...request, proof: this.proof("execution_check", subject, request) }), schema: RemoteExecutionCheckResultSchema,
      idempotencyKey: `delivery-execution-check:${executionId}:${request.executionRevision}`,
      operationPolicy: "executionCheck",
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) });
    if (result.executionId !== executionId || result.executionRevision !== request.executionRevision) {
      throw new RemoteInstanceError("execution_fenced", "Delivery check response belongs to another execution.");
    }
    return result;
  }

  /** Trust comes only from the configured Core origin, never a token URL/header. */
  async executionSigningKeys(deadlineAtMs?: number, expectedKid?: string): Promise<ReadonlyMap<string, KeyObject>> {
    const cached = this.signingKeyCache;
    const fresh = cached !== null && cached.expiresAtMs > Date.now();
    const refreshUnknownKid = fresh && unknownKidRefresh(cached, expectedKid);
    if (fresh && !refreshUnknownKid) return cached.keys;
    // Stale-while-revalidate during an outage: inside the backoff window after
    // a failed refresh, answer with the last confirmed keys at once instead of
    // making every admission and renewal wait out another timeout.
    const confirmed = this.confirmedSigningKeys(expectedKid);
    if (confirmed && Date.now() < this.signingKeyRetryAtMs) return confirmed;
    this.signingKeyRefresh ??= this.refreshSigningKeys(refreshUnknownKid);
    return this.refreshedOrConfirmed(this.signingKeyRefresh, deadlineAtMs, expectedKid);
  }

  /** The refreshed keys; if Core's keys cannot be read, the last confirmed ones while still within the stale bound. */
  private async refreshedOrConfirmed(refresh: Promise<ReadonlyMap<string, KeyObject>>, deadlineAtMs: number | undefined, expectedKid: string | undefined): Promise<ReadonlyMap<string, KeyObject>> {
    try {
      return await this.waitForSigningKeys(refresh, deadlineAtMs);
    } catch (error) {
      const fallback = this.confirmedSigningKeys(expectedKid);
      if (fallback && error instanceof RemoteInstanceError && error.code === "execution_authority_unavailable") return fallback;
      throw error;
    }
  }

  private refreshSigningKeys(refreshUnknownKid: boolean): Promise<ReadonlyMap<string, KeyObject>> {
    return this.fetchExecutionSigningKeys()
      .then(keys => this.signingKeysRefreshed(keys, refreshUnknownKid), (error: unknown) => this.signingKeysFailed(error))
      .finally(() => { this.signingKeyRefresh = null; });
  }

  private signingKeysRefreshed(keys: ReadonlyMap<string, KeyObject>, refreshUnknownKid: boolean): ReadonlyMap<string, KeyObject> {
    // Core currently does not publish a shorter keyset max-age. Keep the
    // configured-origin cache below the 60-second upper bound.
    const now = Date.now();
    this.signingKeyCache = {
      keys,
      expiresAtMs: now + 60_000,
      confirmedAtMs: now,
      // A signed-operation header can request one refresh of a still-valid
      // configured-origin epoch. Further unknown identifiers fail closed
      // until normal expiry, preventing attacker-controlled fetch loops.
      unknownKidRefreshUsed: refreshUnknownKid,
    };
    if (this.signingKeyFailures > 0) {
      this.logger.info({ event: "execution.signing_keys_recovered", failures: this.signingKeyFailures }, "Core signing keys readable again");
    }
    this.signingKeyFailures = 0;
    this.signingKeyRetryAtMs = 0;
    return keys;
  }

  private signingKeysFailed(error: unknown): never {
    this.signingKeyFailures += 1;
    const retryInMs = Math.min(SIGNING_KEY_RETRY_MAX_MS, SIGNING_KEY_RETRY_BASE_MS * 2 ** (this.signingKeyFailures - 1));
    this.signingKeyRetryAtMs = Date.now() + retryInMs;
    const stale = this.signingKeyCache;
    this.logger.warn({ event: "execution.signing_keys_refresh_failed", failures: this.signingKeyFailures, retryInMs,
      ...errorFields(error),
      servingConfirmedKeys: this.confirmedSigningKeys() !== null,
      ...(stale ? { confirmedAgeMs: Date.now() - stale.confirmedAtMs } : {}) }, "Core signing keys could not be refreshed");
    throw error;
  }

  /** The last key set Core confirmed, if still within the stale bound and holding the requested key. */
  private confirmedSigningKeys(expectedKid?: string): ReadonlyMap<string, KeyObject> | null {
    const cached = this.signingKeyCache;
    if (!cached || Date.now() - cached.confirmedAtMs > SIGNING_KEY_STALE_MAX_MS) return null;
    if (expectedKid && !cached.keys.has(expectedKid)) return null;
    return cached.keys;
  }

  private async fetchExecutionSigningKeys(): Promise<ReadonlyMap<string, KeyObject>> {
    try {
      const result = await this.proofHttp.request({ method: "GET", path: CORE_PATHS.jwks,
        schema: z.object({ keys: z.array(SIGNING_KEY_SCHEMA).min(1).max(32) }).strict(), operationPolicy: "progressRead" });
      return signingKeyMap(result.keys);
    } catch (error) {
      // The cause stays a bounded code for the log; message text never leaves.
      throw new RemoteInstanceError("execution_authority_unavailable", "Core execution signing trust is unavailable.", { diagnostic: keySetDiagnostic(error) });
    }
  }

  private async waitForSigningKeys(refresh: Promise<ReadonlyMap<string, KeyObject>>, deadlineAtMs?: number): Promise<ReadonlyMap<string, KeyObject>> {
    if (deadlineAtMs === undefined) return refresh;
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new RemoteInstanceError("execution_authority_unavailable", "Core execution signing trust is unavailable.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        refresh,
        new Promise<ReadonlyMap<string, KeyObject>>((_, reject) => {
          timer = setTimeout(() => reject(new RemoteInstanceError("execution_authority_unavailable", "Core execution signing trust is unavailable.")), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async fetchDesiredConfiguration(instanceId: string,
    options: { deadlineAtMs?: number } = {},
  ): Promise<DesiredConfigurationEnvelope> {
    const result = await this.http.request({ method: "GET", path: CORE_PATHS.desiredConfiguration(instanceId), schema: DesiredConfigurationEnvelopeSchema,
      ...options,
    });
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
   * Submit an already-durable recovery-evidence stop observation. This route is a private,
   * machine-proof boundary; its acknowledgement records only acceptance of
   * observation bytes and never a terminal result or quiescence decision.
   */
  // The identity key joins its fields with NUL, which no HTTP header may carry:
  // sent raw, fetch refused every submission locally, so a fenced session could
  // never be recovered over HTTPS. The header carries its digest.
  async submitRecoveryEvidence(input: { evidence: RemoteRecoveryEvidence; connection: RemoteReconciliationConnection }): Promise<RecoveryEvidenceIngressResult> {
    const evidence = RemoteRecoveryEvidenceSchema.parse(structuredClone(input.evidence));
    const connection = RemoteReconciliationConnectionSchema.parse(structuredClone(input.connection));
    const request = { evidence, connection };
    const result = await this.proofHttp.request({ method: "POST", path: CORE_PATHS.recoveryEvidence(evidence.instanceId),
      bodyFactory: () => ({ ...request, proof: this.proof("recovery_evidence", evidence.instanceId, request as unknown as { [key: string]: JsonValue }) }),
      schema: RecoveryEvidenceIngressResultSchema,
      idempotencyKey: `recovery-evidence:${jcsDigest(remoteRecoveryEvidenceIdentityKey(evidence))}:${evidence.evidenceDigest}` });
    if (result.instanceId !== evidence.instanceId || result.assignmentId !== evidence.assignmentId || result.attempt !== evidence.attempt ||
        result.claimId !== evidence.claimId || result.recoveryEpoch !== evidence.recoveryEpoch || result.evidenceDigest !== evidence.evidenceDigest) {
      throw new RemoteInstanceError("registration_mismatch", "Recovery evidence response does not match the submitted observation.");
    }
    return result;
  }

  /** Creates one proof-bearing receipt that a durable sender can replay byte-for-byte. */
  createExecutionRevisionFenceReceiptRequest(receipt: NativeExecutionRevisionFenceReceipt): NativeExecutionRevisionFenceReceiptRequest {
    const parsed = NativeExecutionRevisionFenceReceiptSchema.parse(structuredClone(receipt));
    return NativeExecutionRevisionFenceReceiptRequestSchema.parse({
      ...parsed,
      proof: this.proof("execution_revision_fence_receipt", parsed.intent.instanceId, parsed as unknown as { [key: string]: JsonValue }),
    });
  }

  /** Submit an exact, previously durable fence receipt; this never asserts a stop or terminal outcome. */
  async submitExecutionRevisionFenceReceipt(request: NativeExecutionRevisionFenceReceiptRequest): Promise<NativeExecutionRevisionFenceReceiptResult> {
    const parsed = NativeExecutionRevisionFenceReceiptRequestSchema.parse(structuredClone(request));
    const result = await this.proofHttp.request({
      method: "POST",
      path: CORE_PATHS.executionRevisionControlReceipt(parsed.intent.instanceId),
      bodyFactory: () => parsed,
      schema: NativeExecutionRevisionFenceReceiptResultSchema,
      idempotencyKey: `execution-revision-fence-receipt:${parsed.intentDigest}:${parsed.runnerIncarnation}:${parsed.connectionRef}:${parsed.connectionEpoch}`,
    });
    if (!allEqual([
      [result.kind, parsed.kind], [result.intentDigest, parsed.intentDigest], [result.runnerIncarnation, parsed.runnerIncarnation],
      [result.connectionRef, parsed.connectionRef], [result.connectionEpoch, parsed.connectionEpoch], [result.fencedAt, parsed.fencedAt],
      [result.requestNonce, parsed.proof.nonce], [jcsDigest(result.intent), jcsDigest(parsed.intent)],
    ])) {
      throw new RemoteInstanceError("registration_mismatch", "Execution revision fence receipt does not match the submitted fence.");
    }
    return result;
  }

  /**
   * `HeartbeatMessage` plus a detached instance-proof signature binding the
   * heartbeat operation, instance, audience and body digest. Core derives
   * the replay nonce as `seq:<sequence>`, so
   * the message carries no nonce of its own.
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
  async pullControllerDirectives(instanceId: string, candidate: ControllerDirectivePullInput, signal?: AbortSignal): Promise<PlanningControllerDirectivePullResult> {
    const input = ControllerDirectivePullInputSchema.parse(candidate);
    const result = await this.http.request({
      method: "POST",
      path: CORE_PATHS.controllerDirectivesPull(instanceId),
      bodyFactory: () => PlanningControllerDirectivePullRequestSchema.parse({ ...input,
        proof: this.proof("controller_directives_pull", instanceId, input as unknown as { [key: string]: JsonValue }) }),
      schema: PlanningControllerDirectivePullResultSchema,
      ...(signal ? { signal } : {}),
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

  /** The mounted Core route accepts one body, and replies only after commit. */
  async submitObservation(instanceId: string, body: unknown): Promise<void> {
    const observation = AgentTurnUsageObservationSchema.parse(body);
    if (observation.instanceId !== instanceId) throw new RemoteInstanceError("registration_mismatch", "Observation instance mismatch");
    const digest = jcsDigest(observation as unknown as JsonValue);
    const expectedId = `ri:turn:${instanceId}:${observation.assignmentId}:${observation.attempt}:${digest.slice(0, 24)}`;
    const result = await this.http.request({ method: "POST", path: CORE_PATHS.observations(instanceId), body: observation,
      schema: ObservationReceiptSchema, idempotencyKey: `observation:${expectedId}`, operationPolicy: "progressRead" });
    if (result.observationId !== expectedId || result.observationDigest !== digest)
      throw new RemoteInstanceError("registration_mismatch", "Observation receipt does not match submitted bytes");
  }

  async observations(instanceId: string, observations: unknown[]): Promise<number> {
    for (const observation of observations) await this.submitObservation(instanceId, observation);
    return observations.length;
  }

  async controlAck(instanceId: string, ack: unknown): Promise<boolean | Extract<ReturnType<typeof DesiredConfigurationAckResultSchema.parse>, { status: "superseded" }>> {
    // Non-configuration control delivery is not accepted over HTTPS.
    if (!configurationAck(ack)) throw new RemoteInstanceError("protocol_incompatible", "This HTTPS endpoint accepts configuration acknowledgements only");
    const request = DesiredConfigurationAckSchema.parse(ack);
    if (request.instanceId !== instanceId) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement instance mismatch");
    const receipt = await this.http.request({ method: "POST", path: CORE_PATHS.controlAck(instanceId), body: request, schema: DesiredConfigurationAckResultSchema,
      idempotencyKey: `configuration-ack:${instanceId}:${request.revision}:${request.status}` });
    if (receipt.instanceId !== instanceId || receipt.revision !== request.revision) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement receipt mismatch");
    if (receipt.status === "superseded") return supersededAck(receipt, request);
    if (receipt.status !== request.status) throw new RemoteInstanceError("registration_mismatch", "Configuration acknowledgement receipt mismatch");
    return true;
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
      return this.capabilityIssue(issued, deadline);
    } catch (error) {
      throw undeliveredCapability(error);
    }
  }

  private capabilityIssue(issued: { token: string; expiresAt: string }, deadline: number | undefined): CapabilityTokenIssue {
    if ((deadline !== undefined && Date.now() >= deadline) || Date.parse(issued.expiresAt) <= this.options.clock.coreNow()) {
      throw new RemoteInstanceError("capability_unavailable", "Capability delivery has expired.");
    }
    // /api/app/mcp is connection-management REST, not the MCP transport.
    // The real /mcp owner still needs its capability admission integration.
    const url = this.options.platformMcpUrl ?? new URL("/mcp", this.options.baseUrl).toString();
    return { mcpServer: { name: "konteks-platform", url, headers: [{ name: "authorization", value: `Bearer ${issued.token}` }] }, expiresAt: issued.expiresAt };
  }

  /** The claimed assignment's work definition (see `CORE_PATHS.workload`); `not_found` when Core has none. */
  async fetchWorkload(instanceId: string, assignmentId: string): Promise<WorkloadRead> {
    return this.http.request({ method: "GET", path: CORE_PATHS.workload(instanceId, assignmentId), schema: WorkloadReadSchema });
  }

  /**
   * Register this runtime's managed-git public key. Only the public half is
   * ever sent; the private half stays on the machine that generated it.
   */
  /** Only the login's state, the provider link and the device code: never output, never input. */
  async reportAgentLogin(instanceId: string, report: RuntimeAgentLoginReport): Promise<{ accepted: boolean }> {
    const body = RuntimeAgentLoginReportSchema.parse(report);
    return this.http.request({
      method: "POST", path: CORE_PATHS.agentLoginReport(instanceId), body,
      schema: z.object({ accepted: z.boolean() }).strict(),
      idempotencyKey: `agent-login:${body.loginId}:${body.state}:${body.userCode ?? ""}:${body.verificationUrl ? createHash("sha256").update(body.verificationUrl).digest("base64url").slice(0, 16) : ""}`,
    });
  }

  /** Trusted local staging admits execution with an attempt identity, never a command. */
  async beginLocalRuntimeUpdate(
    instanceId: string,
    request: RuntimeUpdateLocalBeginRequest,
    options: { deadlineAtMs?: number } = {},
  ): Promise<RuntimeUpdateLocalBeginResult> {
    const body = RuntimeUpdateLocalBeginRequestSchema.parse(request);
    const result = await this.http.request({
      method: "POST",
      path: CORE_PATHS.runtimeUpdateLocal(instanceId),
      body,
      schema: RuntimeUpdateLocalBeginResultSchema,
      idempotencyKey: `runtime-update-local:${body.attemptId}`,
      ...options,
    });
    if (
      result.update.instanceId !== instanceId ||
      result.update.targetBundle !== body.targetBundle ||
      result.update.manifestDigest !== body.manifestDigest
    ) {
      throw new RemoteInstanceError(
        "registration_mismatch",
        "Local update response belongs to another attempt target.",
      );
    }
    return result;
  }

  async reportRuntimeUpdate(instanceId: string, report: RuntimeUpdateReport,
    options: { deadlineAtMs?: number } = {},
  ): Promise<{ accepted: boolean }> {
    const body = RuntimeUpdateReportSchema.parse(report);
    return this.http.request({
      method: "POST", path: CORE_PATHS.runtimeUpdateReport(instanceId), body,
      schema: z.object({ accepted: z.boolean() }).strict(),
      idempotencyKey: `runtime-update:${body.updateId}:${body.state}`,
      ...options,
    });
  }

  /**
   * The release this Core accepts right now. An update to anything
   * else would be refused by Core and leave the machine offline until it
   * rolls back. Null from a Core that does not say.
   */
  async acceptedRelease(instanceId: string): Promise<{ bundleVersion: string; manifestDigest: string } | null> {
    try {
      return await this.http.request({
        method: "GET", path: CORE_PATHS.acceptedRelease(instanceId),
        schema: z.object({ bundleVersion: z.string().min(1).max(64), manifestDigest: z.string().min(1).max(256) }).strict(),
      });
    } catch (error) {
      if (error instanceof RemoteInstanceError && "status" in error && (error as { status: number }).status === 404) return null;
      if (error instanceof RemoteInstanceError && error.code === "capability_unavailable") return null;
      throw error;
    }
  }

  async registerGitKey(instanceId: string, body: { publicKey: string; title: string }): Promise<z.infer<typeof GitKeyRegisterResultSchema>> {
    return this.http.request({ method: "POST", path: CORE_PATHS.gitKeys(instanceId), body, schema: GitKeyRegisterResultSchema, idempotencyKey: `git-key:${instanceId}:${body.title}` });
  }

  async listGitKeys(instanceId: string): Promise<z.infer<typeof GitKeyListResultSchema>["keys"]> {
    return (await this.http.request({ method: "GET", path: CORE_PATHS.gitKeys(instanceId), schema: GitKeyListResultSchema })).keys;
  }

  /** Revocation is Core's and managed-git's; the local half is dropped after. */
  /** Remove this runtime from its workspace: `draining` while its work finishes, then `removed`. */
  async retire(instanceId: string): Promise<{ outcome: "removed" | "draining" | "already_removed"; activeAssignments: number }> {
    return this.http.request({
      method: "POST",
      path: CORE_PATHS.retire(instanceId),
      body: {},
      schema: z.object({ outcome: z.enum(["removed", "draining", "already_removed"]), activeAssignments: z.number().int().min(0) }).strict(),
    });
  }

  async revokeGitKey(instanceId: string, keyRef: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: CORE_PATHS.gitKey(instanceId, keyRef), schema: z.unknown() });
  }

  /** A policy deferral (session- or component-raised), posted in Core's own `DeferredPermission` shape; Core answers the sanitized `PendingPermissionView`. Idempotent per assignment attempt and request id. */
  async deferPermission(instanceId: string, deferral: DeferredPermissionBody): Promise<PendingPermissionView> {
    return this.http.request({ method: "POST", path: CORE_PATHS.permissionsDeferred(instanceId), body: deferral, schema: PendingPermissionViewSchema,
      idempotencyKey: `permission-deferral:${instanceId}:${deferral.assignmentId}:${deferral.attempt}:${deferral.requestId}` });
  }
}
