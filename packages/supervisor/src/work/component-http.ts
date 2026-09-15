import type { SchemaParser } from "@konteks/remote-common";
import { RemoteInstanceError } from "@konteks/remote-common";
import { ComponentErrorEnvelopeSchema, type ComponentKind } from "./components.js";

/**
 * The one HTTP primitive both protocol modules use against a component's
 * local routes. It never logs a body or a header (the Harness bearer and
 * the Validation dispatch signature travel here), converts transport
 * failures into a retryable `temporarily_unavailable`, and hands the
 * caller the status plus the parsed body so each adapter maps the
 * component's own status/`code` vocabulary onto the closed adapter outcomes.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ComponentHttpRequest<T> {
  method: "GET" | "POST" | "PUT";
  url: URL;
  headers: Record<string, string>;
  /** Already-serialized JSON body (the Validation HMAC signs exactly these bytes). */
  body?: string;
  /** Structural on purpose: see `@konteks/remote-common` `SchemaParser`. */
  schema: SchemaParser<T>;
  timeoutMs?: number;
}

export interface ComponentHttpResponse<T> {
  status: number;
  ok: boolean;
  /** Parsed with `schema` when `ok`, otherwise `undefined`. */
  body: T | undefined;
  /** The component's error envelope (`code`/`error`/`message`/`detail`) when `!ok` and it sent one. */
  error: { code: string | undefined; message: string | undefined };
}

export async function componentRequest<T>(kind: ComponentKind, fetchFn: FetchLike, request: ComponentHttpRequest<T>): Promise<ComponentHttpResponse<T>> {
  let response: Response;
  try {
    response = await fetchFn(request.url, {
      method: request.method,
      headers: { accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new RemoteInstanceError("temporarily_unavailable", `${kind} is unreachable`, { cause: error, retryable: true, recoveryActions: [{ kind: "run_doctor" }] });
  }
  const text = await response.text().catch(() => "");
  const json = safeJson(text);
  if (response.ok) {
    const parsed = request.schema.safeParse(json === undefined ? {} : json);
    if (!parsed.success) throw new RemoteInstanceError("temporarily_unavailable", `${kind} answered ${request.method} ${request.url.pathname} with a body outside its contract`, { retryable: false, recoveryActions: [{ kind: "run_doctor" }] });
    return { status: response.status, ok: true, body: parsed.data, error: { code: undefined, message: undefined } };
  }
  const envelope = ComponentErrorEnvelopeSchema.safeParse(json);
  const code = envelope.success ? (envelope.data.code ?? envelope.data.error ?? envelope.data.reason) : undefined;
  const message = envelope.success ? (envelope.data.message ?? envelope.data.detail) : undefined;
  return { status: response.status, ok: false, body: undefined, error: { code, message } };
}

/** A component refusal the caller cannot map: surfaced with the component's code, never its message verbatim in a log. */
export function componentRefused(kind: ComponentKind, operation: string, response: ComponentHttpResponse<unknown>): RemoteInstanceError {
  const retryable = response.status >= 500 || response.status === 429;
  return new RemoteInstanceError(retryable ? "temporarily_unavailable" : "assignment_conflict", `${kind} refused ${operation} (HTTP ${response.status}${response.error.code ? `, ${response.error.code}` : ""})`, { retryable, recoveryActions: retryable ? [{ kind: "retry" }] : [] });
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
