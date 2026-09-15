import { z } from "zod";
import { SseParser, safeJson } from "./sse.js";
import {
  decodeJson,
  encodeJson,
  estimateTokensFromBytes,
  type ParsedProviderRequest,
  type ProviderDialect,
  type ProviderUsage,
  type StreamUsageParser,
} from "./types.js";

/**
 * Anthropic Messages API. `max_tokens` is required by the provider, so a
 * rewrite is always expressible. Usage reports cache tokens BESIDE
 * `input_tokens` (`cache_beside_input`).
 */
const requestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().nullish(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const responseSchema = z
  .object({ model: z.string().optional(), usage: usageSchema.optional() })
  .passthrough();

function usageFrom(parsed: z.infer<typeof usageSchema>, model?: string): ProviderUsage {
  const usage: ProviderUsage = { inputSemantics: "cache_beside_input" };
  if (parsed.input_tokens !== undefined) usage.inputTokens = parsed.input_tokens;
  if (parsed.output_tokens !== undefined) usage.outputTokens = parsed.output_tokens;
  if (parsed.cache_read_input_tokens != null) usage.cacheReadTokens = parsed.cache_read_input_tokens;
  if (parsed.cache_creation_input_tokens != null) usage.cacheWriteTokens = parsed.cache_creation_input_tokens;
  if (model !== undefined) usage.model = model;
  return usage;
}

export const anthropicDialect: ProviderDialect = {
  provider: "anthropic",
  credentialHeaders: ["x-api-key", "authorization"],
  isModelCall(method, path) {
    return method === "POST" && /^\/v1\/messages(?:\?|$)/.test(path);
  },
  parseRequest(_path, body): ParsedProviderRequest | null {
    const parsed = requestSchema.safeParse(decodeJson(body));
    if (!parsed.success) return null;
    return {
      model: parsed.data.model,
      stream: parsed.data.stream === true,
      requestedMaxOutputTokens: parsed.data.max_tokens ?? null,
      estimatedInputTokens: estimateTokensFromBytes(body.byteLength),
    };
  },
  rewriteMaxOutputTokens(body, cap) {
    const parsed = requestSchema.safeParse(decodeJson(body));
    if (!parsed.success) return null;
    const applied = Math.max(1, Math.min(parsed.data.max_tokens ?? cap, cap));
    return { body: encodeJson({ ...parsed.data, max_tokens: applied }), appliedMaxTokens: applied };
  },
  stampKey(headers, key) {
    headers.set("x-api-key", key);
  },
  parseResponseUsage(body) {
    const parsed = responseSchema.safeParse(decodeJson(body));
    if (!parsed.success || parsed.data.usage === undefined) return null;
    return usageFrom(parsed.data.usage, parsed.data.model);
  },
  createStreamUsageParser(): StreamUsageParser {
    let usage: ProviderUsage | null = null;
    const parser = new SseParser(({ event, data }) => {
      const payload = safeJson(data);
      if (event === "message_start") {
        const message = z.object({ message: responseSchema }).safeParse(payload);
        if (message.success && message.data.message.usage) {
          usage = usageFrom(message.data.message.usage, message.data.message.model);
        }
      } else if (event === "message_delta") {
        const delta = z.object({ usage: usageSchema }).safeParse(payload);
        if (delta.success) {
          const next = usageFrom(delta.data.usage);
          usage = { ...(usage ?? { inputSemantics: "cache_beside_input" }), ...stripUndefined(next) };
        }
      }
    });
    return {
      push: (chunk) => parser.push(chunk),
      usage: () => usage,
      outputTokensSoFar: () => usage?.outputTokens ?? null,
    };
  },
};

function stripUndefined(usage: ProviderUsage): Partial<ProviderUsage> {
  const out: Partial<ProviderUsage> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
