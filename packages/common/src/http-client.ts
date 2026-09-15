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
      retryable: args.status >= 500 || args.status === 429 || args.status === 408,
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
  /** Structural: inferring through `z.ZodType<T>` is pathological on the piped contract schemas. */
  schema: SchemaParser<T>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** May shorten the client's deadline, never extend it. */
  timeoutMs?: number;
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
    const url = new URL(request.path, this.options.baseUrl);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      ...(request.idempotencyKey === undefined ? {} : { "idempotency-key": request.idempotencyKey }),
      ...(request.headers ?? {}),
    };
    const replaySafe = request.method === "GET" || request.idempotencyKey !== undefined;
    // One initial request plus three retries for replay-safe operations.
    const maxAttempts = replaySafe ? 4 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // A lease may rotate while a prior attempt is backing off. Resolve the
      // credential immediately before each replay rather than retaining a
      // bearer that Core has already fenced.
      const authorization = this.options.authorization?.();
      if (authorization) headers.authorization = authorization;
      else delete headers.authorization;
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(this.timeoutMs, request.timeoutMs ?? this.timeoutMs)))),
        });
      } catch (error) {
        const failure = new RemoteInstanceError("temporarily_unavailable", "Core request failed", {
          cause: error,
          retryable: true,
          recoveryActions: [{ kind: "retry" }],
        });
        if (attempt === maxAttempts) {
          if (replaySafe) this.logExhausted(request, attempt, maxAttempts, "transport");
          throw failure;
        }
        await this.backoff(request, attempt, maxAttempts, "transport");
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
        const classification = response.status === 408 ? "timeout" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "upstream" : "permanent";
        if (!failure.retryable || attempt === maxAttempts) {
          if (failure.retryable && replaySafe) this.logExhausted(request, attempt, maxAttempts, classification, response.status, failure.requestId);
          throw failure;
        }
        await this.backoff(request, attempt, maxAttempts, classification, response.status, failure.requestId);
        continue;
      }
      if (response.status === 204) return request.schema.parse(undefined);
      let payload: unknown;
      try { payload = await response.json(); }
      catch (error) {
        // An interrupted body is uncertain delivery and can be replayed only
        // when the request identity is stable. Invalid JSON is permanent.
        const retryable = !(error instanceof SyntaxError);
        const failure = new RemoteInstanceError("temporarily_unavailable", "Core response could not be read", { retryable });
        if (!retryable || attempt === maxAttempts) {
          if (retryable && replaySafe) this.logExhausted(request, attempt, maxAttempts, "response_body");
          throw failure;
        }
        await this.backoff(request, attempt, maxAttempts, "response_body");
        continue;
      }
      return request.schema.parse(payload);
    }
    throw new RemoteInstanceError("temporarily_unavailable", "Core request retry exhausted", { retryable: true });
  }

  private async backoff<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, classification: string, status?: number, requestId?: string): Promise<void> {
    const exponentialDelayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const entropy = Math.min(1, Math.max(0, this.retryRandom()));
    const delayMs = Math.max(1, Math.floor(exponentialDelayMs * (0.75 + entropy * 0.5)));
    this.logger.warn({ operation: `${request.method} ${request.path}`, attempt, retry: attempt, maxAttempts,
      maxRetries: maxAttempts - 1, delayMs, classification,
      ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) }, "transient Core request failed; retrying");
    await this.retrySleep(delayMs);
  }

  private logExhausted<T>(request: JsonRequest<T>, attempt: number, maxAttempts: number, classification: string, status?: number, requestId?: string): void {
    this.logger.error({ operation: `${request.method} ${request.path}`, attempt, retries: attempt - 1,
      maxAttempts, maxRetries: maxAttempts - 1, classification,
      ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) }, "transient Core request retry exhausted");
  }
}
