import { z } from "zod";
import type { SchemaParser } from "./parser.js";
import { RemoteInstanceError, RemoteInstanceErrorCodeSchema, type RecoveryAction } from "./errors.js";
import { redactText } from "./redaction.js";
import { createLogger, type Logger } from "./logger.js";
import { withoutUndefined } from "./defined.js";

/**
 * The Konteks error envelope: stable `code`, redacted `message`, `requestId`,
 * bounded `recoveryActions`. Anything else in an error body is discarded.
 */
const ErrorEnvelopeSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().max(1_024).default(""),
    requestId: z.string().optional(),
    recoveryActions: z.array(z.object({ kind: z.string() }).passthrough()).max(8).optional(),
  })
  .passthrough();

export class CoreResponseError extends RemoteInstanceError {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly wireCode: string;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    recoveryActions?: RecoveryAction[];
  }) {
    const parsed = RemoteInstanceErrorCodeSchema.safeParse(args.code);
    super(parsed.success ? parsed.data : "temporarily_unavailable", redactText(args.message), {
      recoveryActions: args.recoveryActions ?? [],
      // HTTP admission/auth/not-found/conflict responses are authoritative
      // even when an older server emits the generic wire code. Retrying those
      // multiplied load and delayed recovery without any chance of success.
      retryable: args.status >= 500 || args.status === 429 || args.status === 425 || args.status === 408,
    });
    this.name = "CoreResponseError";
    this.status = args.status;
    this.requestId = args.requestId;
    this.wireCode = args.code;
  }
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Bounded retry ownership for the native calls that can affect an ACP
 * operation. Callers retain their immutable idempotency key and may always
 * provide a shorter deadline; a policy never extends that caller budget.
 */
const JsonOperationPolicies = {
  renewal: { totalTimeoutMs: 5_000, perAttemptTimeoutMs: 2_000, maxAttempts: 2, retryBaseDelayMs: 100, retryAfterMaxMs: 1_000, requiresIdempotencyKey: true },
  admissionPreparation: { totalTimeoutMs: 30_000, perAttemptTimeoutMs: 10_000, maxAttempts: 3, retryBaseDelayMs: 100, retryAfterMaxMs: 5_000, requiresIdempotencyKey: true },
  // One exchange may span a busy-host pause. The gate supplies the shorter
  // remaining verified lease; it owns retries rather than overlapping HTTP work.
  executionCheck: { totalTimeoutMs: 12_000, perAttemptTimeoutMs: 12_000, maxAttempts: 1, retryBaseDelayMs: 100, retryAfterMaxMs: 1_000, requiresIdempotencyKey: true },
  progressRead: { totalTimeoutMs: 5_000, perAttemptTimeoutMs: 2_000, maxAttempts: 2, retryBaseDelayMs: 100, retryAfterMaxMs: 1_000, requiresIdempotencyKey: false },
  outputTransfer: { totalTimeoutMs: 120_000, perAttemptTimeoutMs: 30_000, maxAttempts: 4, retryBaseDelayMs: 250, retryAfterMaxMs: 30_000, requiresIdempotencyKey: true },
} as const;

type JsonOperationPolicyName = keyof typeof JsonOperationPolicies;

interface JsonClientOptions {
  baseUrl: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  /** Called with the `Date` header and round-trip of every response — feeds the skew estimate. */
  onServerTime?: (serverTimeMs: number, roundTripMs: number) => void;
  authorization?: () => string | null;
  /** Base delay for replay-safe transient retries. Defaults to 100 ms. */
  retryBaseDelayMs?: number;
  /** Injectable sleep used by focused tests and embedders. */
  retrySleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable entropy for bounded retry jitter. */
  retryRandom?: () => number;
  /** Upper bound for a server-directed Retry-After delay. Defaults to 30 seconds. */
  retryAfterMaxMs?: number;
  logger?: Logger;
}

interface JsonRequest<T> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Rebuilds authentication material immediately before each transport attempt. */
  bodyFactory?: () => unknown;
  /** Structural: inferring through `z.ZodType<T>` is pathological on the piped contract schemas. */
  schema: SchemaParser<T>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** Selects a bounded retry policy for a named ACP operation. */
  operationPolicy?: JsonOperationPolicyName;
  /** Cancels this logical operation and prevents further transport retries. */
  signal?: AbortSignal;
  /** May shorten the client's deadline, never extend it. */
  timeoutMs?: number;
  /** Absolute wall-clock deadline shared with the caller and nested retries. */
  deadlineAtMs?: number;
}

type JsonOperationPolicy = (typeof JsonOperationPolicies)[keyof typeof JsonOperationPolicies];

interface RequestPlan {
  url: URL;
  headers: Record<string, string>;
  policy: JsonOperationPolicy | undefined;
  replaySafe: boolean;
  maxAttempts: number;
  perAttemptTimeoutMs: number;
  deadlineAtMs: number;
  startedAt: number;
}

/** A transient failure to retry: what the recovery and retry lines report. */
interface RetryOutcome {
  kind: "retry";
  classification: string;
  status?: number;
  requestId?: string | undefined;
  retryAfter?: string | null;
  /** Whether the retry line names the status (an HTTP failure does, an unreadable body does not). */
  backoffStatus?: boolean;
}

type AttemptOutcome = { kind: "done"; payload: unknown } | RetryOutcome;

/** The request's named retry policy; one that needs an idempotency key refuses a request without one. */
function operationPolicy<T>(request: JsonRequest<T>): JsonOperationPolicy | undefined {
  if (request.operationPolicy === undefined) return undefined;
  const policy = JsonOperationPolicies[request.operationPolicy];
  if (policy.requiresIdempotencyKey && request.idempotencyKey === undefined) {
    throw new RemoteInstanceError("idempotency_conflict", `${request.operationPolicy} requires an immutable idempotency key`);
  }
  return policy;
}

function requestHeaders<T>(request: JsonRequest<T>): Record<string, string> {
  const hasBody = request.body !== undefined || request.bodyFactory !== undefined;
  return {
    accept: "application/json",
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(request.idempotencyKey === undefined ? {} : { "idempotency-key": request.idempotencyKey }),
    ...(request.headers ?? {}),
  };
}

/** A failed response reduced to the Konteks error envelope. */
function coreResponseError(status: number, text: string): CoreResponseError {
  const envelope = parseErrorEnvelope(text);
  return new CoreResponseError({
    status,
    code: envelope?.code ?? "temporarily_unavailable",
    message: envelope?.message ?? `HTTP ${status}`,
    ...withoutUndefined({ requestId: envelope?.requestId }),
    recoveryActions: (envelope?.recoveryActions ?? []).flatMap((action) => {
      const parsed = z.object({ kind: z.string() }).safeParse(action);
      return parsed.success ? [{ kind: parsed.data.kind } as RecoveryAction] : [];
    }),
  });
}

function parseErrorEnvelope(text: string): z.infer<typeof ErrorEnvelopeSchema> | null {
  try {
    return ErrorEnvelopeSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function statusClassification(status: number): string {
  if (status === 408 || status === 425) return "timeout";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream" : "permanent";
}

/**
 * Minimal JSON client for Core's private endpoints. Every response is parsed
 * with a strict schema; every error body is reduced to the envelope. Bodies
 * are never logged by this client.
 */
export class JsonClient {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retrySleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly retryRandom: () => number;
  private readonly retryAfterMaxMs: number;
  private readonly logger: Logger;

  constructor(private readonly options: JsonClientOptions) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryBaseDelayMs = Math.max(1, Math.floor(options.retryBaseDelayMs ?? 100));
    this.retrySleep = options.retrySleep ?? ((delayMs: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const complete = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
        resolve();
      };
      const cancelled = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
        reject(signal?.reason);
      };
      const timer = setTimeout(complete, delayMs);
      if (signal?.aborted) cancelled();
      else signal?.addEventListener("abort", cancelled, { once: true });
    }));
    this.retryRandom = options.retryRandom ?? Math.random;
    this.retryAfterMaxMs = Math.max(0, Math.floor(options.retryAfterMaxMs ?? 30_000));
    this.logger = options.logger ?? createLogger({ name: "core-http" });
  }

  async request<T>(request: JsonRequest<T>): Promise<T> {
    const plan = this.planRequest(request);
    let recovered: RetryOutcome | undefined;
    // One initial request plus three retries for replay-safe operations.
    for (let attempt = 1; attempt <= plan.maxAttempts; attempt += 1) {
      const outcome = await this.attempt(request, plan, attempt);
      if (outcome.kind === "retry") {
        recovered = outcome;
        await this.backoff(request, attempt, plan, outcome);
        continue;
      }
      if (attempt > 1) this.logRecovered(request, attempt, plan.maxAttempts, plan.startedAt, recovered?.classification, recovered?.status, recovered?.requestId);
      return request.schema.parse(outcome.payload);
    }
    throw new RemoteInstanceError("temporarily_unavailable", "Core request retry exhausted", { retryable: true });
  }

  /** The attempts, timeouts, deadline and headers of one logical request. */
  private planRequest<T>(request: JsonRequest<T>): RequestPlan {
    if (request.body !== undefined && request.bodyFactory !== undefined) throw new Error("JsonRequest cannot provide both body and bodyFactory");
    const url = new URL(request.path, this.options.baseUrl);
    const headers = requestHeaders(request);
    const policy = operationPolicy(request);
    const replaySafe = request.method === "GET" || request.idempotencyKey !== undefined;
    const maxAttempts = replaySafe ? Math.min(4, policy?.maxAttempts ?? 4) : 1;
    const perAttemptTimeoutMs = this.perAttemptTimeoutMs(request, policy);
    return { url, headers, policy, replaySafe, maxAttempts, perAttemptTimeoutMs, deadlineAtMs: this.deadlineAtMs(request, policy, perAttemptTimeoutMs, maxAttempts), startedAt: Date.now() };
  }

  private perAttemptTimeoutMs<T>(request: JsonRequest<T>, policy: JsonOperationPolicy | undefined): number {
    return Math.max(1, Math.floor(Math.min(this.timeoutMs, request.timeoutMs ?? this.timeoutMs, policy?.perAttemptTimeoutMs ?? Number.POSITIVE_INFINITY)));
  }

  /**
   * `timeoutMs` is an attempt timeout. An explicit outer deadline or named
   * operation policy can reduce the total retry budget; neither can extend it.
   */
  private deadlineAtMs<T>(request: JsonRequest<T>, policy: JsonOperationPolicy | undefined, perAttemptTimeoutMs: number, maxAttempts: number): number {
    const retryBudgetMs = perAttemptTimeoutMs * maxAttempts + (policy?.retryBaseDelayMs ?? this.retryBaseDelayMs) * (2 ** (maxAttempts - 1) - 1);
    return Math.min(request.deadlineAtMs ?? Number.POSITIVE_INFINITY, Date.now() + Math.min(policy?.totalTimeoutMs ?? Number.POSITIVE_INFINITY, retryBudgetMs));
  }

  private async attempt<T>(request: JsonRequest<T>, plan: RequestPlan, attempt: number): Promise<AttemptOutcome> {
    this.assertNotCancelled(request.signal);
    const remainingMs = plan.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      if (plan.replaySafe) this.logExhausted(request, Math.max(1, attempt - 1), plan.maxAttempts, "timeout", plan.startedAt);
      throw new RemoteInstanceError("temporarily_unavailable", "Core request deadline expired", { retryable: true });
    }
    // A lease may rotate while a prior attempt is backing off. Resolve the
    // credential immediately before each replay rather than retaining a
    // bearer that Core has already fenced.
    const authorization = this.options.authorization?.();
    if (authorization) plan.headers.authorization = authorization;
    else delete plan.headers.authorization;
    const startedAt = Date.now();
    const init = this.prepareInit(request, plan, attempt, remainingMs);
    let response: Response;
    try {
      response = await this.fetchFn(plan.url, init);
    } catch (error) {
      return this.transportFailure(request, plan, attempt, error);
    }
    this.reportServerTime(response, Date.now() - startedAt);
    if (!response.ok) return this.statusFailure(request, plan, attempt, response);
    if (response.status === 204) return { kind: "done", payload: undefined };
    return this.readPayload(request, plan, attempt, response);
  }

  private prepareInit<T>(request: JsonRequest<T>, plan: RequestPlan, attempt: number, remainingMs: number): RequestInit {
    try {
      const body = request.bodyFactory?.() ?? request.body;
      const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(plan.perAttemptTimeoutMs, remainingMs))));
      // Build the headers here: a value fetch would refuse (a NUL or line
      // break) is a local defect to report once, never a network failure to
      // retry forever.
      new Headers(plan.headers);
      return {
        method: request.method,
        headers: plan.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      };
    } catch (error) {
      this.logger.error({ event: "request_failed", operation: `${request.method} ${request.path}`,
        classification: "request_preparation", attempt, elapsedMs: Date.now() - plan.startedAt,
        ...withoutUndefined({ operationPolicy: request.operationPolicy }) }, "Core request could not be prepared");
      if (error instanceof RemoteInstanceError) throw error;
      throw new RemoteInstanceError("schema_invalid", "Core request could not be prepared", {
        cause: error, diagnostic: "request_preparation_failed",
      });
    }
  }

  private transportFailure<T>(request: JsonRequest<T>, plan: RequestPlan, attempt: number, error: unknown): RetryOutcome {
    if (request.signal?.aborted) throw this.cancelled(request.signal.reason);
    if (attempt === plan.maxAttempts) {
      if (plan.replaySafe) this.logExhausted(request, attempt, plan.maxAttempts, "transport", plan.startedAt, undefined, undefined, transportCode(error));
      throw new RemoteInstanceError("temporarily_unavailable", "Core request failed", {
        cause: error,
        retryable: true,
        recoveryActions: [{ kind: "retry" }],
      });
    }
    return { kind: "retry", classification: "transport" };
  }

  private reportServerTime(response: Response, roundTripMs: number): void {
    const dateHeader = response.headers.get("date");
    if (!dateHeader || !this.options.onServerTime) return;
    const serverTime = Date.parse(dateHeader);
    if (Number.isFinite(serverTime)) this.options.onServerTime(serverTime, roundTripMs);
  }

  private async statusFailure<T>(request: JsonRequest<T>, plan: RequestPlan, attempt: number, response: Response): Promise<RetryOutcome> {
    const failure = coreResponseError(response.status, await response.text().catch(() => ""));
    const classification = statusClassification(response.status);
    if (!failure.retryable || attempt === plan.maxAttempts) {
      if (failure.retryable && plan.replaySafe) this.logExhausted(request, attempt, plan.maxAttempts, classification, plan.startedAt, response.status, failure.requestId);
      throw failure;
    }
    return { kind: "retry", classification, status: response.status, requestId: failure.requestId, retryAfter: response.headers.get("retry-after"), backoffStatus: true };
  }

  private async readPayload<T>(request: JsonRequest<T>, plan: RequestPlan, attempt: number, response: Response): Promise<AttemptOutcome> {
    try {
      return { kind: "done", payload: await response.json() };
    } catch (error) {
      // An interrupted body is uncertain delivery and can be replayed only
      // when the request identity is stable. Invalid JSON is permanent.
      const retryable = !(error instanceof SyntaxError);
      if (!retryable || attempt === plan.maxAttempts) {
        if (retryable && plan.replaySafe) this.logExhausted(request, attempt, plan.maxAttempts, "response_body", plan.startedAt, response.status, undefined, transportCode(error));
        throw new RemoteInstanceError("temporarily_unavailable", "Core response could not be read", { retryable, cause: error });
      }
      return { kind: "retry", classification: "response_body", status: response.status };
    }
  }

  private async backoff<T>(request: JsonRequest<T>, attempt: number, plan: RequestPlan, retry: RetryOutcome): Promise<void> {
    const retryBaseDelayMs = plan.policy?.retryBaseDelayMs ?? this.retryBaseDelayMs;
    const exponentialDelayMs = retryBaseDelayMs * 2 ** (attempt - 1);
    const entropy = Math.min(1, Math.max(0, this.retryRandom()));
    const retryAfterMs = this.retryAfterDelayMs(retry.retryAfter, plan.policy?.retryAfterMaxMs);
    const requestedDelayMs = retryAfterMs ?? Math.max(1, Math.floor(exponentialDelayMs * (0.75 + entropy * 0.5)));
    const delayMs = Math.min(Math.max(0, plan.deadlineAtMs - Date.now()), requestedDelayMs);
    // A body that could not be read keeps its status for the recovery line only.
    const status = retry.backoffStatus ? retry.status : undefined;
    this.logger.warn({ event: "retry_scheduled", operation: `${request.method} ${request.path}`, attempt, retry: attempt, maxAttempts: plan.maxAttempts,
      maxRetries: plan.maxAttempts - 1, delayMs, elapsedMs: Date.now() - plan.startedAt, classification: retry.classification,
      ...withoutUndefined({ operationPolicy: request.operationPolicy, retryAfterMs, status, requestId: retry.requestId }) }, "transient Core request failed; retrying");
    this.assertNotCancelled(request.signal);
    if (delayMs > 0) await this.sleepBeforeRetry(delayMs, request.signal);
    this.assertNotCancelled(request.signal);
  }

  private async sleepBeforeRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.retrySleep(delayMs, signal);
    } catch (error) {
      if (signal?.aborted) throw this.cancelled(error);
      throw error;
    }
  }

  private retryAfterDelayMs(value: string | null | undefined, maxDelayMs: number = this.retryAfterMaxMs): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, Math.floor(seconds * 1_000));
    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs)) return undefined;
    return Math.min(maxDelayMs, Math.max(0, dateMs - Date.now()));
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw this.cancelled(signal.reason);
  }

  private cancelled(cause: unknown): RemoteInstanceError {
    return new RemoteInstanceError("operation_interrupted", "Core request was cancelled by its caller", { cause });
  }

  private logExhausted<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, classification: string, requestStartedAt: number, status?: number, requestId?: string, transportCode?: string): void {
    this.logger.error({ event: "retry_exhausted", operation: `${request.method} ${request.path}`, attempt, retries: attempt - 1,
      maxAttempts, maxRetries: maxAttempts - 1, elapsedMs: Date.now() - requestStartedAt, classification,
      ...withoutUndefined({ transportCode, operationPolicy: request.operationPolicy, status, requestId }) }, "transient Core request retry exhausted");
  }

  private logRecovered<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, requestStartedAt: number, classification?: string, status?: number, requestId?: string): void {
    this.logger.info({ event: "retry_recovered", operation: `${request.method} ${request.path}`, attempt, retries: attempt - 1,
      maxAttempts, maxRetries: maxAttempts - 1, elapsedMs: Date.now() - requestStartedAt, classification: classification ?? "transport",
      ...withoutUndefined({ operationPolicy: request.operationPolicy, status, requestId }) }, "transient Core request recovered");
  }
}

// Never persist raw exception messages, URLs, hostnames, or arbitrary codes.
const ALLOWED_TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

function transportCode(error: unknown): string {
  let current = error;
  const names: string[] = [];
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const known = knownTransportCode(current);
    if (known) return known;
    const token = errorToken(current);
    if (/^[A-Za-z_][A-Za-z0-9_]{0,60}$/u.test(token)) names.push(token);
    current = current.cause;
  }
  return names.length ? `unknown:${names.join(">")}` : "unknown";
}

function knownTransportCode(error: Error): string | undefined {
  if (error.name === "TimeoutError") return "timeout";
  if (error.name === "AbortError") return "aborted";
  const code = (error as NodeJS.ErrnoException).code;
  return code && ALLOWED_TRANSPORT_CODES.has(code) ? code : undefined;
}

/**
 * An error class name (or an undici UND_ERR_* code) is not sensitive and tells
 * a local failure from a network one; a bare "unknown" hid why a request that
 * never reached Core kept being retried.
 */
function errorToken(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^UND_ERR_[A-Z_]{1,40}$/u.test(code) ? code : error.name;
}
