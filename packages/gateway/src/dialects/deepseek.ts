import { z } from "zod";
import { SseParser, safeJson } from "./sse.js";
import { chatCompletionsUsageSchema, usageFromChat } from "./openai.js";
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
 * DeepSeek: OpenAI-compatible chat completions with its own cache fields
 * (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`); hits are INSIDE
 * `prompt_tokens` (`cache_inside_total`).
 */
const requestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive().nullish(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const usageSchema = chatCompletionsUsageSchema.extend({
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
});

function usageFrom(parsed: z.infer<typeof usageSchema>, model?: string): ProviderUsage {
  const usage = usageFromChat(parsed, model);
  if (parsed.prompt_cache_hit_tokens !== undefined) usage.cacheReadTokens = parsed.prompt_cache_hit_tokens;
  return usage;
}

export const deepseekDialect: ProviderDialect = {
  provider: "deepseek",
  credentialHeaders: ["authorization"],
  isModelCall(method, path) {
    return method === "POST" && /^\/(?:v1\/)?chat\/completions(?:\?|$)/.test(path);
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
    return {
      body: encodeJson({
        ...parsed.data,
        max_tokens: applied,
        ...(parsed.data.stream === true ? { stream_options: { ...(parsed.data.stream_options ?? {}), include_usage: true } } : {}),
      }),
      appliedMaxTokens: applied,
    };
  },
  stampKey(headers, key) {
    headers.set("authorization", `Bearer ${key}`);
  },
  parseResponseUsage(body) {
    const parsed = z.object({ model: z.string().optional(), usage: usageSchema.optional() }).passthrough().safeParse(decodeJson(body));
    if (!parsed.success || !parsed.data.usage) return null;
    return usageFrom(parsed.data.usage, parsed.data.model);
  },
  createStreamUsageParser(): StreamUsageParser {
    let usage: ProviderUsage | null = null;
    let model: string | undefined;
    const parser = new SseParser(({ data }) => {
      if (data === "[DONE]") return;
      const chunk = z.object({ model: z.string().optional(), usage: usageSchema.nullish() }).passthrough().safeParse(safeJson(data));
      if (!chunk.success) return;
      if (chunk.data.model) model = chunk.data.model;
      if (chunk.data.usage) usage = usageFrom(chunk.data.usage, model);
    });
    return { push: (chunk) => parser.push(chunk), usage: () => usage, outputTokensSoFar: () => usage?.outputTokens ?? null };
  },
};
