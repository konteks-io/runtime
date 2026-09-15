import { z } from "zod";
import { RemoteInstanceComponentViewSchema, RemoteInstanceError, createLogger, readSecretFileIfPresent, type Clock, type Logger } from "@konteks/remote-common";
import { componentRefused, componentRequest, type FetchLike } from "./component-http.js";
import type { ComponentInventory } from "../inventory/collector.js";
import type { ComponentAdapter, ComponentCancelOutcome, ComponentCancelReason, ComponentDispatch, ComponentDrainReason, ComponentEraseResult, ComponentPermissionAnswerRequest, ComponentRecoveryOutcome, ComponentRecoveryRefusal, ComponentRecoveryRequest } from "./components.js";

/**
 * The supervisor's side of the Harness component contract
 * (`ai-agent-harness/src/remote-instance/local-protocol.ts`).
 *
 * Routes are the Harness's `COMPONENT_ROUTES`, mounted under
 * `/api/v1/remote-instance/component`, authenticated by the Harness's OWN
 * component identity token: the launcher generates that secret once at
 * install and Compose mounts it into exactly the Harness and the supervisor,
 * so the supervisor presents the same value the Harness verifies
 * (constant-time compare on its side). The token is read from a file and
 * never logged.
 */
export const HARNESS_COMPONENT_MOUNT = "/api/v1/remote-instance/component";
export const HARNESS_COMPONENT_ROUTES = Object.freeze({
  dispatch: "/assignments",
  cancel: (assignmentId: string) => `/assignments/${encodeURIComponent(assignmentId)}/cancel`,
  recoveryDecision: "/recovery-decisions",
  permissionAnswer: "/permission-answers",
  drain: "/drain",
  health: "/health",
  taskCheckoutProjection: "/task-checkout-projections",
} as const);

/** The Harness's `ComponentTaskCheckoutProjectionRequest` (its strict schema). */
export interface HarnessTaskCheckoutProjectionRequest {
  workspaceRef: string;
  requestingAssignmentId: string;
  requestingAttempt: number;
  requestingWorkKind: "validation" | "preview" | "qa";
  requestingInstanceId: string;
  expectedTaskId?: string;
  expectedRevision?: string;
}

/** The Harness's `ComponentTaskCheckoutProjectionResponse`; `readOnlyPath` is a path inside the Harness's own task-checkout root. */
export const HarnessTaskCheckoutProjectionSchema = z
  .object({
    workspaceRef: z.string().min(1),
    taskId: z.string().min(1),
    tenantId: z.string().min(1),
    revision: z.string().min(1).max(256).optional(),
    readOnlyPath: z.string().min(1),
    ownerInstanceId: z.string().min(1),
    lifecycle: z.enum(["materialized", "publishing", "terminal"]),
    contentHash: z.string().min(1).max(128).optional(),
  })
  .strict();
export type HarnessTaskCheckoutProjection = z.infer<typeof HarnessTaskCheckoutProjectionSchema>;

const DispatchOutcomeSchema = z.object({ status: z.enum(["accepted", "already_accepted"]), planId: z.string(), assignmentId: z.string(), attempt: z.number().int() }).strict();
const CancelOutcomeSchema = z.object({ outcome: z.enum(["cancelled", "already_terminal", "unknown"]) }).strict();
const RecoveryOutcomeSchema = z.union([z.object({ applied: z.literal(true), action: z.string() }).strict(), z.object({ applied: z.literal(false), reason: z.string() }).strict()]);
const AnswerOutcomeSchema = z.object({ delivered: z.boolean(), code: z.string().optional() }).strict();
const AcceptedSchema = z.object({ accepted: z.boolean() }).strict();
const HealthSchema = z.object({ instanceId: z.string(), component: RemoteInstanceComponentViewSchema, checks: z.record(z.string(), z.unknown()), utilization: z.unknown(), draining: z.boolean() }).strict();
const AnyBodySchema = z.unknown();

export interface HarnessProtocolOptions {
  baseUrl: string;
  /** The Harness component identity token (the same secret the Harness reads from `KONTEKS_HARNESS_REMOTE_COMPONENT_TOKEN_FILE`). */
  token: () => Promise<string>;
  clock: Clock;
  fetchFn?: FetchLike;
  logger?: Logger;
}

export function tokenFromFile(path: string): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const value = await readSecretFileIfPresent(path);
    if (!value) throw new RemoteInstanceError("temporarily_unavailable", "the Harness component token is not provisioned", { recoveryActions: [{ kind: "run_doctor" }] });
    cached = value;
    return value;
  };
}

export class HarnessProtocolAdapter implements ComponentAdapter {
  readonly kind = "harness" as const;
  private readonly fetchFn: FetchLike;
  private readonly logger: Logger;

  constructor(private readonly options: HarnessProtocolOptions) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.logger = options.logger ?? createLogger({ name: "component-harness" });
  }

  private url(route: string): URL {
    return new URL(`${HARNESS_COMPONENT_MOUNT}${route}`, this.options.baseUrl);
  }

  private async call<T>(method: "GET" | "POST", route: string, body: unknown, schema: { parse(value: unknown): T; safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } } }) {
    const token = await this.options.token();
    return componentRequest("harness", this.fetchFn, { method, url: this.url(route), headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), schema });
  }

  /**
   * `ComponentDispatchRequestEnvelope`: the claimed assignment, the claim,
   * the effective evidence rule, the delivery definition (`workload`, a
   * `PlanSubmissionPayload` read from Core), and the platform MCP entry.
   */
  // CONTRACT-GAP: the envelope's optional `componentToken` (the per-assignment
  // Core-minted component token with the closed VCS-binding/task-checkout/
  // upload scopes) has no supervisor-private Core route to mint it, so it is
  // omitted; the Harness treats an absent token as "no direct Core scope".
  async dispatch(request: ComponentDispatch): Promise<void> {
    if (!request.workload) throw new RemoteInstanceError("assignment_conflict", "the Harness dispatch needs the delivery definition (workload)", { retryable: false });
    const envelope = {
      assignment: request.assignment,
      claim: { claimId: request.claimId, claimedAt: request.claimedAt },
      effectivePolicy: { evidenceUpload: request.effectiveEvidenceUpload },
      workload: request.workload.workload,
      ...(request.platformMcp ? { platformMcp: request.platformMcp } : {}),
    };
    const response = await this.call("POST", HARNESS_COMPONENT_ROUTES.dispatch, envelope, DispatchOutcomeSchema);
    if (!response.ok) throw refusal(response.error.code, componentRefused("harness", "dispatch", response));
    this.logger.info({ assignmentId: request.assignment.id, attempt: request.assignment.attempt, status: response.body?.status }, "dispatched to harness");
  }

  async cancel(assignmentId: string, attempt: number, reason: ComponentCancelReason): Promise<ComponentCancelOutcome> {
    const response = await this.call("POST", HARNESS_COMPONENT_ROUTES.cancel(assignmentId), { attempt, reason, issuedAt: this.options.clock.nowIso() }, CancelOutcomeSchema);
    if (response.status === 404) return "unknown";
    if (!response.ok) throw componentRefused("harness", "cancel", response);
    return response.body?.outcome ?? "unknown";
  }

  /** `ComponentRecoveryDecisionEnvelope`: `{manifestId, decision, checkpoint?}`; 202 applied, 409 refused with the Harness's reason vocabulary. */
  async recoveryDecision(request: ComponentRecoveryRequest): Promise<ComponentRecoveryOutcome> {
    const response = await this.call("POST", HARNESS_COMPONENT_ROUTES.recoveryDecision, { manifestId: request.manifestId, decision: request.decision, ...(request.checkpoint ? { checkpoint: request.checkpoint } : {}) }, AnyBodySchema);
    const outcome = RecoveryOutcomeSchema.safeParse(response.ok ? response.body : undefined);
    if (response.ok && outcome.success && outcome.data.applied) return { applied: true };
    if (response.status === 409) {
      // The route answers the outcome object itself at 409; read the reason from the raw envelope.
      const reason = response.error.code ?? "assignment_conflict";
      return { applied: false, reason: recoveryRefusal(reason) };
    }
    if (response.status === 400) return { applied: false, reason: "schema_invalid" };
    if (!response.ok) throw componentRefused("harness", "recovery decision", response);
    return { applied: false, reason: "assignment_conflict" };
  }

  async answerPermission(request: ComponentPermissionAnswerRequest): Promise<boolean> {
    const response = await this.call("POST", HARNESS_COMPONENT_ROUTES.permissionAnswer, { assignmentId: request.assignmentId, attempt: request.attempt, pendingRef: request.pendingRef, requestDigest: request.requestDigest, answer: request.answer }, AnswerOutcomeSchema);
    if (response.status === 404) return false;
    if (!response.ok) throw componentRefused("harness", "permission answer", response);
    return response.body?.delivered === true;
  }

  /** The Harness acknowledges the directive immediately and reports the result on `/component/harness/stopped`. */
  async drain(request: { reason: ComponentDrainReason; drainDeadline?: string }): Promise<void> {
    const response = await this.call("POST", HARNESS_COMPONENT_ROUTES.drain, { reason: request.reason, ...(request.drainDeadline ? { drainDeadline: request.drainDeadline } : {}) }, AcceptedSchema);
    if (!response.ok) throw componentRefused("harness", "drain", response);
  }

  // CONTRACT-GAP: the Harness mounts no erase route (its assignment rows,
  // report outbox, and task checkouts have no directive-driven erasure), so
  // the supervisor cannot erase Harness-side assignment data. The honest
  // answer names every Harness assignment as failed with `unsupported_scope`;
  // the receipt never claims an erasure that did not happen.
  async erase(_directiveId: string, assignmentIds: string[]): Promise<ComponentEraseResult> {
    return assignmentIds.length === 0 ? { failed: [] } : { failed: [...assignmentIds], reason: "unsupported_scope" };
  }

  async health(): Promise<ComponentInventory | null> {
    try {
      const response = await this.call("GET", HARNESS_COMPONENT_ROUTES.health, undefined, HealthSchema);
      if (!response.ok || !response.body) return null;
      return { ...response.body.component, kind: "harness" };
    } catch {
      return null;
    }
  }

  /** The read-only projection the Validation Runtime asks for; the Harness validates instance, task, revision, lifecycle, and traversal itself. */
  async taskCheckoutProjection(request: HarnessTaskCheckoutProjectionRequest): Promise<HarnessTaskCheckoutProjection> {
    const response = await this.call("POST", HARNESS_COMPONENT_ROUTES.taskCheckoutProjection, request, HarnessTaskCheckoutProjectionSchema);
    if (!response.ok || !response.body) throw refusal(response.error.code, componentRefused("harness", "task-checkout projection", response));
    return response.body;
  }
}

const RECOVERY_REFUSALS: ReadonlySet<ComponentRecoveryRefusal> = new Set(["checkpoint_invalid", "resume_deadline_expired", "agent_session_lost", "not_resumable", "reconciliation_replay", "assignment_conflict", "unknown_assignment", "schema_invalid"]);

function recoveryRefusal(reason: string): ComponentRecoveryRefusal {
  return (RECOVERY_REFUSALS as ReadonlySet<string>).has(reason) ? (reason as ComponentRecoveryRefusal) : "assignment_conflict";
}

/** Keep the component's stable code when it is one the orchestrator maps onto the closed failure taxonomy. */
function refusal(code: string | undefined, fallback: RemoteInstanceError): RemoteInstanceError {
  if (code === "agent_auth_required") return new RemoteInstanceError("agent_auth_required", fallback.message, { retryable: false, recoveryActions: [{ kind: "login_agent" }] });
  if (code === "source_invalid" || code === "task_checkout_escape" || code === "workspace_binding_invalid" || code === "affinity_instance_unavailable") return new RemoteInstanceError("workspace_binding_invalid", fallback.message, { retryable: false });
  return fallback;
}
