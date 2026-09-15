import { z } from "zod";
import type { SchemaParser } from "./parser.js";
import { RemoteInstanceError, RemoteInstanceErrorCodeSchema, type RecoveryAction } from "./errors.js";
import { redactText } from "./redaction.js";
import { createLogger, type Logger } from "./logger.js";

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

export interface JsonClientOptions {
  baseUrl: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  /** Called with the `Date` header and round-trip of every response — feeds the skew estimate. */
  onServerTime?: (serverTimeMs: number, roundTripMs: number) => void;
  authorization?: () => string | null;
  /** Base delay for replay-safe transient retries. Defaults to 100 ms. */
  retryBaseDelayMs?: number;
  /** Injectable sleep used by focused tests and embedders. */
  retrySleep?: (delayMs: number) => Promise<void>;
  /** Injectable entropy for bounded retry jitter. */
  retryRandom?: () => number;
  logger?: Logger;
}

export interface JsonRequest<T> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Rebuilds authentication material immediately before each transport attempt. */
  bodyFactory?: () => unknown;
  /** Structural: inferring through `z.ZodType<T>` is pathological on the piped contract schemas. */
  schema: SchemaParser<T>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** May shorten the client's deadline, never extend it. */
  timeoutMs?: number;
  /** Absolute wall-clock deadline shared with the caller and nested retries. */
  deadlineAtMs?: number;
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
  private readonly retrySleep: (delayMs: number) => Promise<void>;
  private readonly retryRandom: () => number;
  private readonly logger: Logger;

  constructor(private readonly options: JsonClientOptions) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryBaseDelayMs = Math.max(1, Math.floor(options.retryBaseDelayMs ?? 100));
    this.retrySleep = options.retrySleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    this.retryRandom = options.retryRandom ?? Math.random;
    this.logger = options.logger ?? createLogger({ name: "core-http" });
  }

  async request<T>(request: JsonRequest<T>): Promise<T> {
    if (request.body !== undefined && request.bodyFactory !== undefined) throw new Error("JsonRequest cannot provide both body and bodyFactory");
    const url = new URL(request.path, this.options.baseUrl);
    const hasBody = request.body !== undefined || request.bodyFactory !== undefined;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(request.idempotencyKey === undefined ? {} : { "idempotency-key": request.idempotencyKey }),
      ...(request.headers ?? {}),
    };
    const replaySafe = request.method === "GET" || request.idempotencyKey !== undefined;
    const maxAttempts = replaySafe ? 4 : 1;
    const perAttemptTimeoutMs = Math.max(1, Math.floor(Math.min(this.timeoutMs, request.timeoutMs ?? this.timeoutMs)));
    // `timeoutMs` is an attempt timeout. Only an explicit outer deadline may
    // reduce the promised initial attempt plus three replay-safe retries.
    const deadlineAtMs = request.deadlineAtMs ?? (Date.now() + perAttemptTimeoutMs * maxAttempts
      + this.retryBaseDelayMs * (2 ** (maxAttempts - 1) - 1));
    const requestStartedAt = Date.now();
    let recoveredClassification: string | undefined;
    let recoveredStatus: number | undefined;
    let recoveredRequestId: string | undefined;
    // One initial request plus three retries for replay-safe operations.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        if (replaySafe) this.logExhausted(request, Math.max(1, attempt - 1), maxAttempts, "timeout", requestStartedAt);
        throw new RemoteInstanceError("temporarily_unavailable", "Core request deadline expired", { retryable: true });
      }
      // A lease may rotate while a prior attempt is backing off. Resolve the
      // credential immediately before each replay rather than retaining a
      // bearer that Core has already fenced.
      const authorization = this.options.authorization?.();
      if (authorization) headers.authorization = authorization;
      else delete headers.authorization;
      const startedAt = Date.now();
      let response: Response;
      try {
        const body = request.bodyFactory?.() ?? request.body;
        response = await this.fetchFn(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(perAttemptTimeoutMs, remainingMs)))),
        });
      } catch (error) {
        const failure = new RemoteInstanceError("temporarily_unavailable", "Core request failed", {
          cause: error,
          retryable: true,
          recoveryActions: [{ kind: "retry" }],
        });
        if (attempt === maxAttempts) {
          if (replaySafe) this.logExhausted(request, attempt, maxAttempts, "transport", requestStartedAt);
          throw failure;
        }
        recoveredClassification = "transport"; recoveredStatus = undefined; recoveredRequestId = undefined;
        await this.backoff(request, attempt, maxAttempts, "transport", deadlineAtMs, requestStartedAt);
        continue;
      }
      const roundTripMs = Date.now() - startedAt;
      const dateHeader = response.headers.get("date");
      if (dateHeader && this.options.onServerTime) {
        const serverTime = Date.parse(dateHeader);
        if (Number.isFinite(serverTime)) this.options.onServerTime(serverTime, roundTripMs);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let envelope: z.infer<typeof ErrorEnvelopeSchema> | null = null;
        try {
          envelope = ErrorEnvelopeSchema.parse(JSON.parse(text));
        } catch {
          envelope = null;
        }
        const failure = new CoreResponseError({
          status: response.status,
          code: envelope?.code ?? "temporarily_unavailable",
          message: envelope?.message ?? `HTTP ${response.status}`,
          ...(envelope?.requestId === undefined ? {} : { requestId: envelope.requestId }),
          recoveryActions: (envelope?.recoveryActions ?? []).flatMap((action) => {
            const parsed = z.object({ kind: z.string() }).safeParse(action);
            return parsed.success ? [{ kind: parsed.data.kind } as RecoveryAction] : [];
          }),
        });
        const classification = response.status === 408 || response.status === 425 ? "timeout" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "upstream" : "permanent";
        if (!failure.retryable || attempt === maxAttempts) {
          if (failure.retryable && replaySafe) this.logExhausted(request, attempt, maxAttempts, classification, requestStartedAt, response.status, failure.requestId);
          throw failure;
        }
        recoveredClassification = classification; recoveredStatus = response.status; recoveredRequestId = failure.requestId;
        await this.backoff(request, attempt, maxAttempts, classification, deadlineAtMs, requestStartedAt, response.status, failure.requestId);
        continue;
      }
      if (response.status === 204) {
        if (attempt > 1) this.logRecovered(request, attempt, maxAttempts, requestStartedAt, recoveredClassification, recoveredStatus, recoveredRequestId);
        return request.schema.parse(undefined);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch (error) {
        // An interrupted body is uncertain delivery and can be replayed only
        // when the request identity is stable. Invalid JSON is permanent.
        const retryable = !(error instanceof SyntaxError);
        const failure = new RemoteInstanceError("temporarily_unavailable", "Core response could not be read", { retryable });
        if (!retryable || attempt === maxAttempts) {
          if (retryable && replaySafe) this.logExhausted(request, attempt, maxAttempts, "response_body", requestStartedAt);
          throw failure;
        }
        recoveredClassification = "response_body"; recoveredStatus = response.status; recoveredRequestId = undefined;
        await this.backoff(request, attempt, maxAttempts, "response_body", deadlineAtMs, requestStartedAt);
        continue;
      }
      if (attempt > 1) this.logRecovered(request, attempt, maxAttempts, requestStartedAt, recoveredClassification, recoveredStatus, recoveredRequestId);
      return request.schema.parse(payload);
    }
    throw new RemoteInstanceError("temporarily_unavailable", "Core request retry exhausted", { retryable: true });
  }

  private async backoff<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, classification: string, deadlineAtMs: number, requestStartedAt: number, status?: number, requestId?: string): Promise<void> {
    const exponentialDelayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const entropy = Math.min(1, Math.max(0, this.retryRandom()));
    const delayMs = Math.min(Math.max(0, deadlineAtMs - Date.now()), Math.max(1, Math.floor(exponentialDelayMs * (0.75 + entropy * 0.5))));
    this.logger.warn({ event: "retry_scheduled", operation: `${request.method} ${request.path}`, attempt, retry: attempt, maxAttempts,
      maxRetries: maxAttempts - 1, delayMs, elapsedMs: Date.now() - requestStartedAt, classification,
      ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) }, "transient Core request failed; retrying");
    if (delayMs > 0) await this.retrySleep(delayMs);
  }

  private logExhausted<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, classification: string, requestStartedAt: number, status?: number, requestId?: string): void {
    this.logger.error({ event: "retry_exhausted", operation: `${request.method} ${request.path}`, attempt, retries: attempt - 1,
      maxAttempts, maxRetries: maxAttempts - 1, elapsedMs: Date.now() - requestStartedAt, classification,
      ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) }, "transient Core request retry exhausted");
  }

  private logRecovered<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, requestStartedAt: number, classification?: string, status?: number, requestId?: string): void {
    this.logger.info({ event: "retry_recovered", operation: `${request.method} ${request.path}`, attempt, retries: attempt - 1,
      maxAttempts, maxRetries: maxAttempts - 1, elapsedMs: Date.now() - requestStartedAt, classification: classification ?? "transport",
      ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) }, "transient Core request recovered");
  }
}
