import { z } from "zod";
import { BoundedJsonValueSchema, ConnectedAgentViewSchema, type AssignmentReport, type BoundedJsonValue, type ConnectedAgentView, type RecoveryDecision, type RemoteLeaseMode, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { ComponentInventory } from "../inventory/collector.js";
import type { EvidenceUpload } from "./evidence.js";

/**
 * Typed dispatch to the domain components. Harness serves `delivery`;
 * Validation Runtime serves `validation`, `preview`, and `qa`; the agent
 * runner serves `assistant_execution` through the relayed session channel.
 *
 * The supervisor speaks EACH COMPONENT'S OWN local contract: the Harness's
 * `src/remote-instance/local-protocol.ts` (bearer = the Harness's component
 * identity token) and the Validation Runtime's `src/api/component/routes.ts`
 * (HMAC over `<timestamp>.<raw body>` with the shared dispatch secret). This
 * module holds the supervisor-side facts and the closed adapter interface;
 * `harness-protocol.ts` and `validation-protocol.ts` map them onto each
 * component's routes and envelopes, and `internal/component-routes.ts`
 * serves each component's client. See `work/README.md` for the converged
 * protocol table.
 */
export type ComponentKind = "harness" | "validation_runtime";

/** The one Konteks-issued secret an agent may receive (D94), in ACP `mcpServers` shape. Never journaled. */
export interface PlatformMcpEntry {
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

/**
 * The definition of the work an assignment names, read from Core for the
 * claimed assignment (`GET …/assignments/:assignmentId/workload`): a
 * `PlanSubmissionPayload` for `delivery`; the Validation Runtime's
 * `ComponentWorkSpec` bodies for `validation` / `preview` / `qa`.
 */
export interface WorkloadDefinition {
  assignmentId: string;
  attempt: number;
  kind: RemoteWorkAssignment["kind"];
  workload: BoundedJsonValue;
}

/** Every fact the supervisor holds at dispatch time; each adapter picks what its component's envelope needs. */
export interface ComponentDispatch {
  assignment: RemoteWorkAssignment;
  claimId: string;
  claimedAt: string;
  effectiveEvidenceUpload: EvidenceUpload;
  recoveryEpoch: number;
  lease: { mode: RemoteLeaseMode; expiresAt: string; drainDeadline?: string };
  policy: { permissionResponderDeadlineSeconds: number; humanDeferralAllowed: boolean; softMaxConcurrent?: number };
  /** The placed agent's current sanitized readiness (Core placed it; the supervisor never substitutes, D100). */
  agent: ConnectedAgentView;
  browserToolHealthy: boolean;
  /** `sha256:<64hex>` of the pinned bridge the agent runner serves for the placed agent (from the verified release manifest). */
  bridgeDigest?: string;
  /** Redeemed from `mcpCapabilityTokenRef` at dispatch; lives only in memory and in the component's dispatch body. */
  platformMcp?: PlatformMcpEntry;
  /** Present for the Harness (its envelope requires it); the Validation Runtime asks for it lazily through `spec`. */
  workload?: WorkloadDefinition;
}

export type ComponentCancelReason = NonNullable<Extract<NonNullable<AssignmentReport["result"]>, { class: "cancelled" }>["reason"]>;

export type ComponentCancelOutcome = "cancelled" | "already_terminal" | "unknown";

export type ComponentDrainReason = "user" | "limit_loss" | "update" | "remove";

export interface ComponentRecoveryRequest {
  manifestId: string;
  decision: RecoveryDecision;
  /** The supervisor-journaled checkpoint; the component verifies its own ref/hash against it. */
  checkpoint?: { ref: string; hash: string };
  /** The journal attempt the decision addresses (a `restart_new_attempt_same_instance` names only the prior assignment). */
  attempt: number;
  /** The component's local job reference when it reported one (Validation Runtime). */
  localRef?: string;
}

export type ComponentRecoveryRefusal = "checkpoint_invalid" | "resume_deadline_expired" | "agent_session_lost" | "not_resumable" | "reconciliation_replay" | "assignment_conflict" | "unknown_assignment" | "schema_invalid";

export type ComponentRecoveryOutcome = { applied: true } | { applied: false; reason: ComponentRecoveryRefusal };

export type ComponentPermissionAnswer = { kind: "permission"; optionId: string } | { kind: "elicitation"; content: Record<string, unknown> } | { kind: "decline" };

export interface ComponentPermissionAnswerRequest {
  assignmentId: string;
  attempt: number;
  /** The component's own pending reference (Harness `pendingRef`; Validation Runtime `pendingRef` inside its local job). */
  pendingRef: string;
  requestDigest: string;
  /** The Validation Runtime addresses answers by local job id; the Harness by assignment. */
  localRef?: string;
  answer: ComponentPermissionAnswer;
}


export interface ComponentEraseResult {
  failed: string[];
  reason?: "data_in_use" | "local_io_failure" | "unsupported_scope";
}

/**
 * The supervisor → component operations, one implementation per kind. Every
 * method maps onto a route the component actually mounts; where a component
 * has no route for an operation the adapter answers honestly (see the
 * `// CONTRACT-GAP:` markers in each protocol module) rather than pretending.
 */
export interface ComponentAdapter {
  readonly kind: ComponentKind;
  dispatch(request: ComponentDispatch): Promise<void>;
  cancel(assignmentId: string, attempt: number, reason: ComponentCancelReason): Promise<ComponentCancelOutcome>;
  /** Hand down exactly the supervisor's current recovery decision; the component verifies ref/hash/epoch itself. */
  recoveryDecision(request: ComponentRecoveryRequest): Promise<ComponentRecoveryOutcome>;
  /** Deliver the first authorized answer to a deferred permission/elicitation exactly once. */
  answerPermission(request: ComponentPermissionAnswerRequest): Promise<boolean>;
  drain(request: { reason: ComponentDrainReason; drainDeadline?: string }): Promise<void>;
  erase(directiveId: string, assignmentIds: string[]): Promise<ComponentEraseResult>;
  /** The component's self-reported health projection, or null when unreachable. */
  health(): Promise<ComponentInventory | null>;
}

/**
 * The internal normalized form of everything a component reports back. The
 * per-kind inbound routes translate each component's messages into these
 * facts; nothing downstream (orchestrator, report sender, journal) knows a
 * component's wire shape. A component-minted `AssignmentReport` is handled
 * separately (`WorkOrchestrator.onComponentReport`) because it needs the
 * D125 verdict answered synchronously.
 */
export const ComponentFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), assignmentId: z.string().min(1), attempt: z.number().int().positive(), structuredOutput: BoundedJsonValueSchema.optional() }).strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      assignmentId: z.string().min(1),
      attempt: z.number().int().positive(),
      ref: z.string().min(1).max(256),
      hash: z.string().min(1).max(128),
      createdAt: z.string(),
      acpSessionRef: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("terminal"),
      assignmentId: z.string().min(1),
      attempt: z.number().int().positive(),
      result: z.discriminatedUnion("class", [
        z.object({ class: z.literal("succeeded"), structuredOutput: BoundedJsonValueSchema.optional(), terminalResultHash: z.string().min(1) }).strict(),
        z
          .object({
            class: z.literal("failed"),
            reason: z.enum(["agent_failed", "provider_failure", "agent_auth_required", "policy_denied", "permission_timeout", "budget_exhausted", "timeout", "validation_failed", "source_invalid", "task_checkout_escape", "evidence_policy_violation", "internal"]),
            structuredOutput: BoundedJsonValueSchema.optional(),
            terminalResultHash: z.string().min(1),
          })
          .strict(),
      ]),
      artifacts: z.array(z.object({ artifactId: z.string(), kind: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string(), uploadId: z.string().optional() }).strict()).max(256).optional(),
      acpSessionRef: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("permission_request"),
      component: z.enum(["harness", "validation_runtime"]),
      assignmentId: z.string().min(1),
      attempt: z.number().int().positive(),
      /** The component's pending reference; echoed on the answer. */
      pendingRef: z.string().min(1).max(256),
      /** The Validation Runtime's local job id (absent for the Harness). */
      localRef: z.string().min(1).max(256).optional(),
      requestId: z.string().min(1).max(256),
      requestKind: z.enum(["permission", "elicitation"]),
      requestDigest: z.string().min(1).max(128),
      deadlineAt: z.string(),
      title: z.string().max(4_096),
      toolKind: z.string().max(64).optional(),
      options: z.array(z.object({ optionId: z.string().min(1).max(128), name: z.string().max(256), kind: z.string().max(64) }).strict()).max(16).optional(),
      requestedSchema: BoundedJsonValueSchema.optional(),
      isSignIn: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_checkout_materialized"),
      assignmentId: z.string().min(1),
      attempt: z.number().int().positive(),
      taskId: z.string().min(1),
      workspaceRef: z.string().min(1),
      ownerInstanceId: z.string().min(1),
      revision: z.string().min(1).max(256).optional(),
      materializedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("component_health"),
      component: z.enum(["harness", "validation_runtime"]),
      view: z.object({ kind: z.string(), version: z.string(), healthStatus: z.enum(["healthy", "degraded", "unhealthy"]), capabilities: z.array(z.string()), lastProbeAt: z.string() }).strict(),
      draining: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("component_stopped"),
      component: z.enum(["harness", "validation_runtime"]),
      reason: z.enum(["user", "limit_loss", "update", "remove"]),
      stoppedAt: z.string(),
      interruptedAssignmentIds: z.array(z.string()).max(1_024),
      outboxFlushed: z.boolean(),
    })
    .strict(),
]);
export type ComponentFact = z.infer<typeof ComponentFactSchema>;

/** The agent readiness the supervisor pushes to the Validation Runtime so it advertises `qa` honestly. */
export const AgentReadinessPushSchema = z
  .object({ agents: z.array(ConnectedAgentViewSchema).max(32), browserToolHealthy: z.boolean(), previewOperatorOptIn: z.boolean(), observedAt: z.string() })
  .strict();
export type AgentReadinessPush = z.infer<typeof AgentReadinessPushSchema>;

export function componentForKind(kind: RemoteWorkAssignment["kind"]): ComponentKind | "agent_runner" {
  switch (kind) {
    case "planning":
      return "agent_runner";
    case "delivery":
      return "harness";
    case "validation":
    case "preview":
    case "qa":
      return "validation_runtime";
    case "assistant_execution":
      return "agent_runner";
    case "search_generation":
      throw new Error("search generation requires its dedicated carrier owner");
    case "operations":
      throw new Error("operations requires its dedicated carrier owner");
    case "onboarding":
    case "repository_relocation":
      // The onboard lane is not a domain component: evidence collection and the
      // relocation mirror run in the supervisor itself (onboarding-mode OB6).
      throw new Error("onboard work requires its dedicated carrier owner");
  }
}

export type TerminalResult = NonNullable<AssignmentReport["result"]>;
export type RecoveryDecisionFor = RecoveryDecision;

/** The stable `code` every component answers with on a refusal; anything else is a transport failure. */
export const ComponentErrorEnvelopeSchema = z.object({ code: z.string().optional(), error: z.string().optional(), reason: z.string().optional(), message: z.string().optional(), detail: z.string().optional() }).passthrough();
