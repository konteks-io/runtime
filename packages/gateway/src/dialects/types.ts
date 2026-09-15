/**
 * A provider dialect knows how one provider family shapes its request body,
 * its authentication header, its `max_tokens`-equivalent, and its usage
 * report (JSON and streamed). Adapted from bb's account-pool provider
 * adapters and request-body parsing, narrowed to what the gateway needs:
 * matching, key stamping, cap rewrite, and on-wire usage observation.
 */
export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";

export type InputSemantics = "cache_inside_total" | "cache_beside_input" | "unknown";

export interface ParsedProviderRequest {
  /** Model as written on the wire (body or path); never self-reported by the agent. */
  model: string;
  stream: boolean;
  /** The request's own output-token cap, when it names one. */
  requestedMaxOutputTokens: number | null;
  /** Rough on-wire input size for `preflight_block`; null when the body is opaque. */
  estimatedInputTokens: number | null;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputSemantics: InputSemantics;
  /** Model the provider reported in the response, when it does. */
  model?: string;
}

export interface StreamUsageParser {
  /** Feed raw response bytes as they arrive (before they are forwarded). */
  push(chunk: Uint8Array): void;
  /** Best-known usage so far; final after the stream ends. */
  usage(): ProviderUsage | null;
  /** Output tokens observed so far, for stream cutting. */
  outputTokensSoFar(): number | null;
}

export interface RewriteResult {
  body: Uint8Array;
  appliedMaxTokens: number;
}

export interface ProviderDialect {
  provider: ProviderId;
  /** Header names that may carry credentials inbound and must be stripped. */
  credentialHeaders: readonly string[];
  /** Whether this endpoint carries a model call the gateway must observe (vs. e.g. model listing). */
  isModelCall(method: string, path: string): boolean;
  parseRequest(path: string, body: Uint8Array): ParsedProviderRequest | null;
  /** Returns null when the dialect cannot express a rewrite for this request shape. */
  rewriteMaxOutputTokens(body: Uint8Array, cap: number): RewriteResult | null;
  stampKey(headers: Headers, key: string): void;
  parseResponseUsage(body: Uint8Array): ProviderUsage | null;
  createStreamUsageParser(): StreamUsageParser;
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
