import { createHmac } from "node:crypto";
import { z } from "zod";
import { RemoteInstanceComponentViewSchema, RemoteInstanceError, createLogger, readSecretFileIfPresent, type Clock, type Logger } from "@konteks/remote-common";
import { componentRefused, componentRequest, type FetchLike } from "./component-http.js";
import type { ComponentInventory } from "../inventory/collector.js";
import type { AgentReadinessPush, ComponentAdapter, ComponentCancelOutcome, ComponentCancelReason, ComponentDispatch, ComponentDrainReason, ComponentEraseResult, ComponentPermissionAnswerRequest, ComponentRecoveryOutcome, ComponentRecoveryRefusal, ComponentRecoveryRequest } from "./components.js";

/**
 * The supervisor's side of the Validation Runtime component contract
 * (`validation-runtime/src/api/component/routes.ts`, mounted at
 * `/api/v1/component`, `remote_instance` mode only).
 *
 * Every request is authenticated the way that component verifies it
 * (`src/remote-instance/dispatch-auth.ts`): `x-konteks-dispatch-timestamp`
 * (unix seconds) and `x-konteks-dispatch-signature` = hex HMAC-SHA256 over
 * `<timestamp>.<raw body>` with the dispatch secret the launcher generated at
 * install and Compose mounted into exactly the Validation Runtime and the
 * supervisor. A GET signs the empty body. The secret is never logged.
 */
export const VALIDATION_COMPONENT_MOUNT = "/api/v1/component";
export const VALIDATION_COMPONENT_ROUTES = Object.freeze({
  dispatch: "/assignments",
  cancel: (assignmentId: string, attempt: number) => `/assignments/${encodeURIComponent(assignmentId)}/${attempt}/cancel`,
  recoveryDecision: (assignmentId: string, attempt: number) => `/assignments/${encodeURIComponent(assignmentId)}/${attempt}/recovery-decision`,
  permissionAnswers: (assignmentId: string, attempt: number) => `/assignments/${encodeURIComponent(assignmentId)}/${attempt}/permission-answers`,
  recoverySnapshot: "/recovery-snapshot",
  drain: "/drain",
  erase: "/erase",
  agents: "/agents",
  status: "/status",
} as const);

export const DISPATCH_SIGNATURE_HEADER = "x-konteks-dispatch-signature";
export const DISPATCH_TIMESTAMP_HEADER = "x-konteks-dispatch-timestamp";

export function signDispatch(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

const DispatchAcceptedSchema = z.object({ accepted: z.literal(true), assignmentId: z.string(), attempt: z.number().int(), state: z.string(), localJobId: z.string().nullable() }).strict();
const CancelOutcomeSchema = z.object({ outcome: z.enum(["cancelled", "already_terminal", "unknown"]) }).strict();
const RecoveryAppliedSchema = z.object({ applied: z.string() }).strict();
const AnswerAcceptedSchema = z.object({ accepted: z.boolean() }).strict();
const DrainOutcomeSchema = z.object({ stopped: z.boolean(), waitedMs: z.number(), finished: z.number(), cancelled: z.number(), residue: z.array(z.object({ assignmentId: z.string(), attempt: z.number(), state: z.string() }).strict()) }).strict();
const EraseFactsSchema = z.object({ status: z.enum(["completed", "partially_completed", "failed"]), failedAssignmentIds: z.array(z.string()), residue: z.array(z.string()) }).strict();
const StatusSchema = z.object({ component: RemoteInstanceComponentViewSchema, health: z.unknown(), utilizationContribution: z.number(), roles: z.object({ qa: z.boolean() }).strict(), previews: z.array(z.unknown()) }).strict();
const RecoverySnapshotSchema = z.object({ claims: z.array(z.unknown()) }).strict();
const EmptySchema = z.unknown();

export interface ValidationProtocolOptions {
  baseUrl: string;
  /** The shared dispatch secret (`REMOTE_INSTANCE_SUPERVISOR_DISPATCH_SECRET_FILE` on the component). */
  secret: () => Promise<string>;
  clock: Clock;
  fetchFn?: FetchLike;
  logger?: Logger;
}

export function secretFromFile(path: string, what = "the Validation Runtime dispatch secret"): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const value = await readSecretFileIfPresent(path);
    if (!value) throw new RemoteInstanceError("temporarily_unavailable", `${what} is not provisioned`, { recoveryActions: [{ kind: "run_doctor" }] });
    cached = value;
    return value;
  };
}

export class ValidationProtocolAdapter implements ComponentAdapter {
  readonly kind = "validation_runtime" as const;
  private readonly fetchFn: FetchLike;
  private readonly logger: Logger;

  constructor(private readonly options: ValidationProtocolOptions) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.logger = options.logger ?? createLogger({ name: "component-validation" });
  }

  private url(route: string): URL {
    return new URL(`${VALIDATION_COMPONENT_MOUNT}${route}`, this.options.baseUrl);
  }

  private async call<T>(method: "GET" | "POST" | "PUT", route: string, body: unknown, schema: { parse(value: unknown): T; safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } } }) {
    const secret = await this.options.secret();
    const raw = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(this.options.clock.now() / 1_000));
    const headers = { [DISPATCH_TIMESTAMP_HEADER]: timestamp, [DISPATCH_SIGNATURE_HEADER]: signDispatch(secret, timestamp, raw) };
    return componentRequest("validation_runtime", this.fetchFn, { method, url: this.url(route), headers, ...(body === undefined ? {} : { body: raw }), schema });
  }

  /**
   * `SupervisorDispatch` (`assignment-guard.ts`): the assignment, the claim,
   * the lease the claim runs under, the most-restrictive effective policy,
   * the placed agent's readiness, the browser tool's health, the pinned
   * bridge digest for `qa`, and the recovery epoch. The component fetches
   * its work specification lazily through `GET …/spec` on the supervisor.
   */
  async dispatch(request: ComponentDispatch): Promise<void> {
    const envelope = {
      dispatchId: `${request.claimId}:e${request.recoveryEpoch}`,
      assignment: request.assignment,
      claimId: request.claimId,
      lease: { mode: request.lease.mode, expiresAt: request.lease.expiresAt, ...(request.lease.drainDeadline ? { drainDeadline: request.lease.drainDeadline } : {}) },
      effectivePolicy: {
        evidenceUpload: request.effectiveEvidenceUpload,
        permissionResponderDeadlineSeconds: request.policy.permissionResponderDeadlineSeconds,
        humanDeferralAllowed: request.policy.humanDeferralAllowed,
        ...(request.policy.softMaxConcurrent === undefined ? {} : { softMaxConcurrent: request.policy.softMaxConcurrent }),
      },
      agent: request.agent,
      browserToolHealthy: request.browserToolHealthy,
      ...(request.bridgeDigest ? { agentRunner: { bridgeDigest: request.bridgeDigest, ...(request.platformMcp ? { platformMcpUrl: request.platformMcp.url } : {}) } } : {}),
      recoveryEpoch: request.recoveryEpoch,
      issuedAt: this.options.clock.nowIso(),
    };
    const response = await this.call("POST", VALIDATION_COMPONENT_ROUTES.dispatch, envelope, DispatchAcceptedSchema);
    if (!response.ok) throw refusal(response.error.code, componentRefused("validation_runtime", "dispatch", response));
    this.logger.info({ assignmentId: request.assignment.id, attempt: request.assignment.attempt, state: response.body?.state }, "dispatched to validation runtime");
  }

  async cancel(assignmentId: string, attempt: number, reason: ComponentCancelReason): Promise<ComponentCancelOutcome> {
    const response = await this.call("POST", VALIDATION_COMPONENT_ROUTES.cancel(assignmentId, attempt), { reason }, CancelOutcomeSchema);
    if (response.status === 404) return "unknown";
    if (!response.ok) throw componentRefused("validation_runtime", "cancel", response);
    return response.body?.outcome ?? "unknown";
  }

  /** The body is the contract's `RecoveryDecision` itself; the component validates row/instance/epoch/checkpoint before it executes. */
  async recoveryDecision(request: ComponentRecoveryRequest): Promise<ComponentRecoveryOutcome> {
    const assignmentId = request.decision.action === "restart_new_attempt_same_instance" ? request.decision.priorAssignmentId : request.decision.assignmentId;
    const response = await this.call("POST", VALIDATION_COMPONENT_ROUTES.recoveryDecision(assignmentId, request.attempt), request.decision, RecoveryAppliedSchema);
    if (response.ok) return { applied: true };
    if (response.status === 400) return { applied: false, reason: "schema_invalid" };
    if (response.status === 409) return { applied: false, reason: recoveryRefusal(response.error.code ?? "assignment_conflict") };
    throw componentRefused("validation_runtime", "recovery decision", response);
  }

  /** Answers are addressed by the component's local job id (carried on its deferral) plus the `AcpPermissionDeferralAnswer` it expects. */
  async answerPermission(request: ComponentPermissionAnswerRequest): Promise<boolean> {
    if (!request.localRef) return false;
    const response = await this.call("POST", VALIDATION_COMPONENT_ROUTES.permissionAnswers(request.assignmentId, request.attempt), { localJobId: request.localRef, answer: { pendingRef: request.pendingRef, requestDigest: request.requestDigest, answer: request.answer } }, AnswerAcceptedSchema);
    if (response.status === 409) return false;
    if (!response.ok) throw componentRefused("validation_runtime", "permission answer", response);
    return response.body?.accepted === true;
  }

  /** Synchronous: the component finishes or cancels bounded work to the deadline, flushes its outbox, and answers the drain outcome. */
  async drain(request: { reason: ComponentDrainReason; drainDeadline?: string }): Promise<void> {
    const response = await this.call("POST", VALIDATION_COMPONENT_ROUTES.drain, { reason: request.reason, ...(request.drainDeadline ? { deadline: request.drainDeadline } : {}) }, DrainOutcomeSchema);
    if (!response.ok) throw componentRefused("validation_runtime", "drain", response);
    this.logger.info({ reason: request.reason, stopped: response.body?.stopped, residue: response.body?.residue.length ?? 0 }, "validation runtime drained");
  }

  async erase(directiveId: string, assignmentIds: string[]): Promise<ComponentEraseResult> {
    if (assignmentIds.length === 0) return { failed: [] };
    const response = await this.call("POST", VALIDATION_COMPONENT_ROUTES.erase, { directiveId, scope: "assignment_data", assignmentIds }, EraseFactsSchema);
    if (!response.ok || !response.body) return { failed: [...assignmentIds], reason: "local_io_failure" };
    return response.body.failedAssignmentIds.length > 0 ? { failed: response.body.failedAssignmentIds, reason: "local_io_failure" } : { failed: [] };
  }

  async health(): Promise<ComponentInventory | null> {
    try {
      const response = await this.call("GET", VALIDATION_COMPONENT_ROUTES.status, undefined, StatusSchema);
      if (!response.ok || !response.body) return null;
      return { ...response.body.component, kind: "validation_runtime" };
    } catch {
      return null;
    }
  }

  /** The component advertises `qa` only from the readiness the supervisor last pushed (stale ⇒ no ready agent). */
  async pushAgents(push: AgentReadinessPush): Promise<void> {
    const response = await this.call("PUT", VALIDATION_COMPONENT_ROUTES.agents, push, EmptySchema);
    if (!response.ok) throw componentRefused("validation_runtime", "agent readiness push", response);
  }

  /** The component's recovery material (`ReconnectClaim[]`), read on reconnect. */
  async recoverySnapshot(): Promise<unknown[]> {
    const response = await this.call("GET", VALIDATION_COMPONENT_ROUTES.recoverySnapshot, undefined, RecoverySnapshotSchema);
    if (!response.ok || !response.body) throw componentRefused("validation_runtime", "recovery snapshot", response);
    return response.body.claims;
  }
}

const RECOVERY_REFUSALS: ReadonlySet<ComponentRecoveryRefusal> = new Set(["checkpoint_invalid", "resume_deadline_expired", "agent_session_lost", "not_resumable", "reconciliation_replay", "assignment_conflict", "unknown_assignment", "schema_invalid"]);

function recoveryRefusal(reason: string): ComponentRecoveryRefusal {
  return (RECOVERY_REFUSALS as ReadonlySet<string>).has(reason) ? (reason as ComponentRecoveryRefusal) : "assignment_conflict";
}

function refusal(code: string | undefined, fallback: RemoteInstanceError): RemoteInstanceError {
  if (code === "agent_auth_required") return new RemoteInstanceError("agent_auth_required", fallback.message, { retryable: false, recoveryActions: [{ kind: "login_agent" }] });
  if (code === "workspace_binding_invalid" || code === "affinity_instance_unavailable" || code === "runtime_target_ineligible") return new RemoteInstanceError("workspace_binding_invalid", fallback.message, { retryable: false });
  if (code === "agent_capability_missing" || code === "capability_unavailable" || code === "agent_unavailable") return new RemoteInstanceError("capability_unavailable", fallback.message, { retryable: false });
  return fallback;
}
