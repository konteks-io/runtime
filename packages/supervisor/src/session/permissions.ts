import { z } from "zod";
import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { BoundedJsonValueSchema, createLogger, jcsDigest, RemoteInstanceError, type BoundedJsonValue, type Clock, type JsonValue, type Logger, type PendingPermissionView } from "@konteks/remote-common";
import type { DeferredPermissionBody } from "../core/client.js";
import { isSignInElicitation } from "./policy-responder.js";

/**
 * Sanitized pending-permission facts (D87/D102). The supervisor forwards ONLY
 * these fields for a policy-deferred request — title, tool kind, options, or
 * a bounded elicitation message + schema — plus the `requestDigest` Core and
 * the answerer must echo. Raw tool input, paths, and `_meta` never leave.
 */
export interface SanitizedPermission {
  kind: "permission";
  requestDigest: string;
  params: { title: string; toolKind?: string; options: Array<{ optionId: string; name: string; kind: string }> };
}

export interface SanitizedElicitation {
  kind: "elicitation";
  requestDigest: string;
  isSignIn: boolean;
  params: { message: string; requestedSchema: BoundedJsonValue };
}

const MAX_TITLE = 256;
const MAX_MESSAGE = 4_096;

const OptionSchema = z.object({ optionId: z.string().min(1).max(128), name: z.string().min(1).max(MAX_TITLE), kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]) }).strict();

export function sanitizePermissionRequest(request: RequestPermissionRequest): SanitizedPermission {
  const params: SanitizedPermission["params"] = {
    title: plainText(request.toolCall.title ?? "Tool call", MAX_TITLE),
    options: request.options.slice(0, 16).map((option) => OptionSchema.parse({ optionId: option.optionId, name: plainText(option.name, MAX_TITLE), kind: option.kind })),
  };
  if (request.toolCall.kind) params.toolKind = String(request.toolCall.kind).slice(0, 32);
  return { kind: "permission", requestDigest: jcsDigest(params as unknown as JsonValue), params };
}

export function sanitizeElicitationRequest(request: CreateElicitationRequest): SanitizedElicitation {
  const schema = (request as { requestedSchema?: unknown }).requestedSchema;
  const bounded = BoundedJsonValueSchema.safeParse(schema ?? {});
  const params: SanitizedElicitation["params"] = { message: plainText(request.message, MAX_MESSAGE), requestedSchema: bounded.success ? bounded.data : {} };
  return { kind: "elicitation", requestDigest: jcsDigest(params as unknown as JsonValue), isSignIn: isSignInElicitation(request), params };
}

// eslint-disable-next-line no-control-regex
const CONTROL_AND_DIRECTIONAL = /[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function plainText(value: string, max: number): string {
  return value.replace(CONTROL_AND_DIRECTIONAL, "").slice(0, max);
}

/** Does an answer name a listed option / validate against the schema? Defense in depth over Core's own check. */
export function answerIsValid(pending: SanitizedPermission | SanitizedElicitation, answer: unknown): boolean {
  if (pending.kind === "permission") {
    const parsed = z.object({ outcome: z.union([z.object({ outcome: z.literal("cancelled") }).strict(), z.object({ outcome: z.literal("selected"), optionId: z.string() }).strict()]) }).passthrough().safeParse(answer);
    if (!parsed.success) return false;
    if (parsed.data.outcome.outcome === "cancelled") return true;
    return pending.params.options.some((option) => option.optionId === (parsed.data.outcome as { optionId: string }).optionId);
  }
  if (pending.isSignIn) return false;
  const parsed = z.object({ action: z.enum(["accept", "decline", "cancel"]) }).passthrough().safeParse(answer);
  if (!parsed.success) return false;
  if (parsed.data.action !== "accept") return true;
  const content = (answer as { content?: unknown }).content;
  return content === undefined || content === null || BoundedJsonValueSchema.safeParse(content).success;
}

export interface PendingHumanRequest {
  acpSessionRef: string;
  requestId: string;
  assignmentId: string;
  attempt: number;
  agentId: string;
  sanitized: SanitizedPermission | SanitizedElicitation;
  raisedAt: string;
  deadlineAt: string;
  answered: boolean;
}

/**
 * Tracks policy-deferred requests awaiting a human: exactly one answer is
 * delivered (the first authorized one), and the deadline fails closed.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingHumanRequest>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      clock: Clock;
      deadlineSeconds: () => number;
      onTimeout: (request: PendingHumanRequest) => Promise<void>;
      logger?: Logger;
    },
  ) {
    this.logger = options.logger ?? createLogger({ name: "permissions" });
  }

  get count(): number {
    return this.pending.size;
  }

  private key(acpSessionRef: string, requestId: string): string {
    return `${acpSessionRef}:${requestId}`;
  }

  /** `registeredDeadlineAt` is Core's deadline for the registered view; the earlier of the two wins. */
  defer(args: Omit<PendingHumanRequest, "raisedAt" | "deadlineAt" | "answered">, registeredDeadlineAt?: string): PendingHumanRequest {
    const raisedAt = this.options.clock.nowIso();
    const localDeadline = this.options.clock.now() + this.options.deadlineSeconds() * 1_000;
    const registered = registeredDeadlineAt === undefined ? Number.NaN : Date.parse(registeredDeadlineAt);
    const deadlineMs = Number.isFinite(registered) ? Math.min(localDeadline, registered) : localDeadline;
    const deadlineAt = new Date(deadlineMs).toISOString();
    const request: PendingHumanRequest = { ...args, raisedAt, deadlineAt, answered: false };
    const key = this.key(args.acpSessionRef, args.requestId);
    this.pending.set(key, request);
    const timer = setTimeout(() => {
      const current = this.pending.get(key);
      if (!current || current.answered) return;
      this.pending.delete(key);
      this.logger.info({ requestId: args.requestId }, "permission request timed out; failing closed");
      void this.options.onTimeout(current);
    }, Math.max(0, deadlineMs - this.options.clock.now()));
    timer.unref();
    this.timers.set(key, timer);
    return request;
  }

  /** The first valid answer wins; later ones are rejected as already answered. */
  answer(acpSessionRef: string, requestId: string, answer: unknown): { ok: true; request: PendingHumanRequest } | { ok: false; reason: "unknown_request" | "permission_already_answered" | "permission_schema_mismatch" } {
    const key = this.key(acpSessionRef, requestId);
    const request = this.pending.get(key);
    if (!request) return { ok: false, reason: "unknown_request" };
    if (request.answered) return { ok: false, reason: "permission_already_answered" };
    if (!answerIsValid(request.sanitized, answer)) return { ok: false, reason: "permission_schema_mismatch" };
    request.answered = true;
    this.pending.delete(key);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    return { ok: true, request };
  }

  cancelSession(acpSessionRef: string): PendingHumanRequest[] {
    const cancelled: PendingHumanRequest[] = [];
    for (const [key, request] of [...this.pending]) {
      if (request.acpSessionRef !== acpSessionRef) continue;
      this.pending.delete(key);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
      cancelled.push(request);
    }
    return cancelled;
  }

  list(): PendingHumanRequest[] {
    return [...this.pending.values()];
  }
}

/** Core's `DeferredPermission` for one sanitized request raised on a session. */
export function deferredPermissionBody(args: { sessionId: string; assignmentId: string; attempt: number; agentId: string; requestId: string; sanitized: SanitizedPermission | SanitizedElicitation }): DeferredPermissionBody {
  const common = { sessionId: args.sessionId, assignmentId: args.assignmentId, attempt: args.attempt, agentId: args.agentId, requestId: args.requestId };
  if (args.sanitized.kind === "permission") {
    const { title, toolKind, options } = args.sanitized.params;
    return { kind: "permission", ...common, permission: { title, ...(toolKind ? { toolKind } : {}), options } };
  }
  return { kind: "elicitation", ...common, elicitation: { message: args.sanitized.params.message, requestedSchema: args.sanitized.params.requestedSchema, isSignIn: args.sanitized.isSignIn } };
}

const REGISTRATION_ATTEMPTS = 6;
const REGISTRATION_MIN_DELAY_MS = 100;
const REGISTRATION_MAX_DELAY_MS = 2_000;

/**
 * Register a policy deferral with Core before anyone is asked to answer it.
 * Adapted from bb's host-daemon interactive-request registration: bounded
 * retries for transient failures only (100 ms doubling to 2 s, 5 retries),
 * and the registered record must be the exact request that was raised.
 * Returns null when Core never confirmed it; the caller then fails closed.
 */
export async function registerDeferral(
  register: (body: DeferredPermissionBody) => Promise<PendingPermissionView>,
  body: DeferredPermissionBody,
  options: { sleep?: (ms: number) => Promise<void>; logger?: Logger } = {},
): Promise<PendingPermissionView | null> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); }));
  for (let attempt = 1; attempt <= REGISTRATION_ATTEMPTS; attempt += 1) {
    try {
      const view = await register(body);
      if (view.kind !== body.kind || view.requestId !== body.requestId || view.assignmentId !== body.assignmentId || view.agentId !== body.agentId) {
        options.logger?.warn({ requestId: body.requestId, assignmentId: body.assignmentId, stage: "permission_deferral", outcome: "mismatched" }, "Core registered a different pending request; failing closed");
        return null;
      }
      return view;
    } catch (error) {
      const retryable = error instanceof RemoteInstanceError && error.retryable;
      options.logger?.warn({ requestId: body.requestId, assignmentId: body.assignmentId, stage: "permission_deferral", attempt, retryable,
        ...(error instanceof RemoteInstanceError ? { code: error.code } : { errorName: error instanceof Error ? error.name : "unknown" }) },
        retryable && attempt < REGISTRATION_ATTEMPTS ? "permission deferral registration failed; retrying" : "permission deferral registration failed; failing closed");
      if (!retryable || attempt === REGISTRATION_ATTEMPTS) return null;
      await sleep(Math.min(REGISTRATION_MIN_DELAY_MS * 2 ** (attempt - 1), REGISTRATION_MAX_DELAY_MS));
    }
  }
  return null;
}
