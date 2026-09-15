import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AgentTurnUsageObservationSchema,
  AssignmentReportSchema,
  RemoteInstanceComponentViewSchema,
  RuntimeUtilizationSchema,
  createLogger,
  type AgentTurnUsageObservation,
  type AssignmentReport,
  type BoundedJsonValue,
  type Logger,
  type ReportAck,
} from "@konteks/remote-common";
import type { ComponentInventory } from "../inventory/collector.js";
import type { DeferredPermissionBody } from "../core/client.js";
import type { ComponentKind } from "../work/components.js";

/**
 * The supervisor's side of the two components' OUTBOUND contracts.
 *
 * The Harness (`ai-agent-harness/src/remote-instance/supervisor-client.ts`)
 * posts under `/component/harness/*`; the Validation Runtime
 * (`validation-runtime/src/remote-instance/supervisor-client.ts`) calls
 * `/component/validation_runtime/assignments/:id/:attempt/*`. Both present
 * their own component identity token as a bearer. Neither ever sees the
 * lease, Core's URL, or another component's secret.
 *
 * Reports are the one place the two contracts disagree with the supervisor's:
 * both components mint an `AssignmentReport` themselves, and the supervisor is
 * the `reportSequence` authority for a claim (D125). The rule applied here is
 * that the component's report is accepted as the PAYLOAD and re-minted by the
 * D125 sender, so a claim keeps exactly one sequence line whichever party
 * observed the fact. The answer is `journaled`; Core's verdict follows on the
 * assignment channel.
 */
export const HARNESS_INBOUND_PREFIX = "/component/harness";
export const VALIDATION_INBOUND_PREFIX = "/component/validation_runtime";

const ComponentViewMessageSchema = z
  .object({ instanceId: z.string().min(1), component: RemoteInstanceComponentViewSchema, utilization: RuntimeUtilizationSchema })
  .passthrough();
const CheckpointMessageSchema = z
  .object({
    assignmentId: z.string().min(1),
    attempt: z.number().int().positive(),
    claimId: z.string().min(1).optional(),
    recoveryEpoch: z.number().int().nonnegative().optional(),
    checkpoint: z.object({ ref: z.string().min(1).max(256), hash: z.string().min(1).max(128), createdAt: z.string() }).strict(),
    acpSessionRef: z.string().min(1).optional(),
    resumable: z.boolean().optional(),
  })
  .strict();
const DeferralOptionSchema = z.object({ optionId: z.string().min(1).max(128), name: z.string().max(256), kind: z.string().max(64) }).strict();
const HarnessDeferralSchema = z
  .object({
    assignmentId: z.string().min(1),
    attempt: z.number().int().positive(),
    agentId: z.string().min(1),
    deferral: z
      .object({
        pendingRef: z.string().min(1).max(256),
        requestId: z.string().min(1).max(256),
        kind: z.enum(["permission", "elicitation"]),
        requestDigest: z.string().min(1).max(128),
        deadlineAt: z.string(),
        title: z.string().max(4_096),
        toolKind: z.string().max(64).optional(),
        options: z.array(DeferralOptionSchema).max(16).optional(),
        requestedSchema: z.record(z.string(), z.unknown()).optional(),
        isSignIn: z.boolean(),
      })
      .strict(),
  })
  .strict();
const ValidationDeferralSchema = z.object({ localJobId: z.string().min(1).max(256), payload: z.unknown() }).strict();
const TaskCheckoutMaterializedSchema = z
  .object({
    assignmentId: z.string().min(1),
    attempt: z.number().int().positive(),
    taskId: z.string().min(1),
    workspaceRef: z.string().min(1),
    ownerInstanceId: z.string().min(1),
    revision: z.string().min(1).max(256).optional(),
    materializedAt: z.string(),
  })
  .strict();
const StoppedSchema = z
  .object({
    instanceId: z.string().min(1),
    reason: z.enum(["user", "limit_loss", "update", "remove"]),
    stoppedAt: z.string(),
    interruptedAssignmentIds: z.array(z.string()).max(256),
    outboxFlushed: z.boolean(),
  })
  .strict();
const ResolveCheckoutSchema = z.object({ workspaceRef: z.string().min(1) }).strict();
const RedeemSchema = z.object({ tokenRef: z.string().min(1) }).strict();

/** The deferral shape Core accepts, composed here from each component's own message. */
export type DeferralForCore = DeferredPermissionBody;

export interface ComponentInboundDeps {
  /** Each component's own identity token, read from the file the supervisor provisioned. */
  token: (kind: ComponentKind) => Promise<string>;
  /** Readiness/health pushes; the inventory prefers a fresh push over its own probe. */
  onComponentView: (kind: ComponentKind, view: ComponentInventory, draining: boolean) => void;
  onComponentStopped: (kind: ComponentKind, message: z.infer<typeof StoppedSchema>) => Promise<void>;
  /** Re-mint a component-minted report through the D125 sender. */
  onReport: (report: AssignmentReport) => Promise<{ status: "journaled" } | { status: "acked"; ack: ReportAck } | { status: "unknown_assignment" }>;
  onCheckpoint: (fact: { assignmentId: string; attempt: number; ref: string; hash: string; createdAt: string; acpSessionRef?: string }) => Promise<void>;
  onDeferral: (kind: ComponentKind, deferral: DeferralForCore, localRef?: string) => Promise<void>;
  onTaskCheckoutMaterialized: (fact: z.infer<typeof TaskCheckoutMaterializedSchema>) => Promise<void>;
  onUsage: (observation: AgentTurnUsageObservation) => Promise<void>;
  /** The claimed assignment's work definition, read from Core. */
  workSpec: (assignmentId: string, attempt: number) => Promise<unknown>;
  /** Ask the Harness for the read-only projection of a checkout it owns. */
  resolveTaskCheckout: (input: { assignmentId: string; attempt: number; workspaceRef: string }) => Promise<unknown>;
  /** Redeem through Core; the Validation Runtime receives the token and the endpoint, never the ref. */
  redeemCapabilityToken: (input: { assignmentId: string; attempt: number; tokenRef: string }) => Promise<{ token: string; platformMcpUrl: string }>;
  logger?: Logger;
}

/**
 * Handles a component request, or answers `false` when the path is not one of
 * theirs so the caller can fall through to the rest of the internal API.
 */
export function componentInboundRoutes(deps: ComponentInboundDeps) {
  const logger = deps.logger ?? createLogger({ name: "component-inbound" });

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = request.url ?? "";
    const kind: ComponentKind | null = url.startsWith(`${HARNESS_INBOUND_PREFIX}/`) ? "harness" : url.startsWith(`${VALIDATION_INBOUND_PREFIX}/`) ? "validation_runtime" : null;
    if (!kind) return false;
    if (!(await authorized(request, await deps.token(kind)))) {
      sendJson(response, 401, { code: "component_unauthorized" });
      return true;
    }
    const method = request.method ?? "GET";
    const route = url.slice(kind === "harness" ? HARNESS_INBOUND_PREFIX.length : VALIDATION_INBOUND_PREFIX.length);
    try {
      const handled = kind === "harness" ? await harness(method, route, request, response) : await validation(method, route, request, response);
      if (!handled) sendJson(response, 404, { code: "not_found" });
    } catch (error) {
      logger.warn({ err: error, kind, route }, "component request failed");
      sendJson(response, 500, { code: "temporarily_unavailable" });
    }
    return true;
  };

  async function harness(method: string, route: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (method !== "POST") return false;
    switch (route) {
      case "/ready":
      case "/health": {
        const parsed = ComponentViewMessageSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        const draining = (parsed.data as { draining?: boolean }).draining === true;
        deps.onComponentView("harness", { ...parsed.data.component, kind: "harness" }, draining);
        sendJson(response, 200, { accepted: true });
        return true;
      }
      case "/reports":
        return report(request, response);
      case "/checkpoints": {
        const parsed = CheckpointMessageSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onCheckpoint({ assignmentId: parsed.data.assignmentId, attempt: parsed.data.attempt, ...parsed.data.checkpoint, ...(parsed.data.acpSessionRef ? { acpSessionRef: parsed.data.acpSessionRef } : {}) });
        sendJson(response, 200, { accepted: true });
        return true;
      }
      case "/permission-deferrals": {
        const parsed = HarnessDeferralSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onDeferral("harness", toCoreDeferral(parsed.data), parsed.data.deferral.pendingRef);
        sendJson(response, 202, { accepted: true });
        return true;
      }
      case "/task-checkouts/materialized": {
        const parsed = TaskCheckoutMaterializedSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onTaskCheckoutMaterialized(parsed.data);
        sendJson(response, 201, { accepted: true });
        return true;
      }
      case "/usage-observations": {
        const parsed = AgentTurnUsageObservationSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onUsage(parsed.data);
        sendJson(response, 202, { accepted: true });
        return true;
      }
      case "/stopped": {
        const parsed = StoppedSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onComponentStopped("harness", parsed.data);
        sendJson(response, 200, { accepted: true });
        return true;
      }
      default:
        return false;
    }
  }

  async function validation(method: string, route: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const target = assignmentRoute(route);
    if (!target) return false;
    const { assignmentId, attempt, tail } = target;
    if (method === "GET" && tail === "/spec") {
      const spec = await deps.workSpec(assignmentId, attempt);
      if (spec === null || spec === undefined) {
        sendJson(response, 404, { code: "not_found" });
        return true;
      }
      sendJson(response, 200, spec);
      return true;
    }
    if (method !== "POST") return false;
    switch (tail) {
      case "/task-checkout/resolve": {
        const parsed = ResolveCheckoutSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        sendJson(response, 200, await deps.resolveTaskCheckout({ assignmentId, attempt, workspaceRef: parsed.data.workspaceRef }));
        return true;
      }
      case "/capability-tokens/redeem": {
        const parsed = RedeemSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        sendJson(response, 200, await deps.redeemCapabilityToken({ assignmentId, attempt, tokenRef: parsed.data.tokenRef }));
        return true;
      }
      case "/reports":
        return report(request, response);
      case "/observations": {
        const parsed = AgentTurnUsageObservationSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onUsage(parsed.data);
        sendJson(response, 202, { accepted: true });
        return true;
      }
      case "/permissions/deferred": {
        const parsed = ValidationDeferralSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        const deferral = toCoreDeferralFromPayload(assignmentId, attempt, parsed.data.payload);
        if (!deferral) return badRequest(response);
        await deps.onDeferral("validation_runtime", deferral, parsed.data.localJobId);
        sendJson(response, 202, { accepted: true });
        return true;
      }
      case "/checkpoints": {
        const parsed = CheckpointMessageSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(response);
        await deps.onCheckpoint({ assignmentId, attempt, ...parsed.data.checkpoint, ...(parsed.data.acpSessionRef ? { acpSessionRef: parsed.data.acpSessionRef } : {}) });
        sendJson(response, 200, { accepted: true });
        return true;
      }
      // CONTRACT-GAP: the supervisor-private route table has no artifact
      // upload-grant endpoint, so the supervisor cannot mint one. Evidence
      // therefore stays structured-only for this component until Core serves
      // grants; answering `unsupported` is honest, a fabricated grant is not.
      case "/artifacts/upload-grants":
        sendJson(response, 501, { code: "unsupported_scope", message: "artifact upload grants are not served by the supervisor" });
        return true;
      default:
        return false;
    }
  }

  async function report(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = AssignmentReportSchema.safeParse(await readJson(request));
    if (!parsed.success) return badRequest(response);
    const outcome = await deps.onReport(parsed.data);
    if (outcome.status === "unknown_assignment") {
      sendJson(response, 404, { code: "not_found" });
      return true;
    }
    sendJson(response, 200, outcome);
    return true;
  }
}

/** `/assignments/:assignmentId/:attempt/<tail>` — the Validation Runtime's whole client surface. */
function assignmentRoute(route: string): { assignmentId: string; attempt: number; tail: string } | null {
  const match = /^\/assignments\/([^/]+)\/(\d+)(\/.*)$/.exec(route);
  const [, id, attempt, tail] = match ?? [];
  if (id === undefined || attempt === undefined || tail === undefined) return null;
  return { assignmentId: decodeURIComponent(id), attempt: Number(attempt), tail };
}

function toCoreDeferral(message: z.infer<typeof HarnessDeferralSchema>): DeferralForCore {
  const { assignmentId, attempt, agentId, deferral } = message;
  // The session a delivery deferral belongs to is the assignment itself: the
  // Harness runs delivery outside a conversation, so the assignment id is the
  // stable reference Core threads the pending permission onto.
  const common = { sessionId: assignmentId, assignmentId, attempt, agentId, requestId: deferral.requestId };
  if (deferral.kind === "permission") {
    return { kind: "permission", ...common, permission: { title: deferral.title, ...(deferral.toolKind ? { toolKind: deferral.toolKind } : {}), options: deferral.options ?? [] } };
  }
  return { kind: "elicitation", ...common, elicitation: { message: deferral.title, requestedSchema: (deferral.requestedSchema ?? {}) as BoundedJsonValue, isSignIn: deferral.isSignIn } };
}

/** The Validation Runtime forwards the ACP deferral payload verbatim; only its closed fields are read. */
function toCoreDeferralFromPayload(assignmentId: string, attempt: number, payload: unknown): DeferralForCore | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as { kind?: string; agentId?: string; requestId?: string; title?: string; message?: string; toolKind?: string; options?: Array<{ optionId: string; name: string; kind: string }>; requestedSchema?: Record<string, unknown>; isSignIn?: boolean };
  if (typeof body.requestId !== "string" || !body.requestId) return null;
  const common = { sessionId: assignmentId, assignmentId, attempt, agentId: body.agentId ?? "unknown", requestId: body.requestId };
  if (body.kind === "elicitation") {
    return { kind: "elicitation", ...common, elicitation: { message: body.message ?? body.title ?? "", requestedSchema: (body.requestedSchema ?? {}) as BoundedJsonValue, isSignIn: body.isSignIn === true } };
  }
  return { kind: "permission", ...common, permission: { title: body.title ?? "", ...(body.toolKind ? { toolKind: body.toolKind } : {}), options: body.options ?? [] } };
}

async function authorized(request: IncomingMessage, expected: string): Promise<boolean> {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

function badRequest(response: ServerResponse): boolean {
  sendJson(response, 400, { code: "schema_invalid" });
  return true;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // Bounded: a component body is a message, never an artifact.
    if (size > 4 * 1024 * 1024) throw new Error("component body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}
