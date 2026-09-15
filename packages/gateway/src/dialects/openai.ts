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
 * OpenAI Responses API and Chat Completions, both Bearer-authenticated. Cache
 * tokens are INSIDE the input total (`cache_inside_total`). The Responses API
 * cap is `max_output_tokens`; chat completions use `max_completion_tokens`
 * (legacy `max_tokens`). Streaming chat completions only report usage when
 * `stream_options.include_usage` is set, so the gateway sets it on rewrite.
 */
const responsesRequestSchema = z
  .object({
    model: z.string().min(1),
    max_output_tokens: z.number().int().positive().nullish(),
    stream: z.boolean().optional(),
  })
  .passthrough();

const chatRequestSchema = z
  .object({
    model: z.string().min(1),
    max_completion_tokens: z.number().int().positive().nullish(),
    max_tokens: z.number().int().positive().nullish(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const responsesUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
  })
  .passthrough();

const chatUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
  })
  .passthrough();

function isResponsesPath(path: string): boolean {
  return /^\/v1\/responses(?:\?|$)/.test(path);
}

function isChatPath(path: string): boolean {
  return /^\/v1\/chat\/completions(?:\?|$)/.test(path);
}

function usageFromResponses(parsed: z.infer<typeof responsesUsageSchema>, model?: string): ProviderUsage {
  const usage: ProviderUsage = { inputSemantics: "cache_inside_total" };
  if (parsed.input_tokens !== undefined) usage.inputTokens = parsed.input_tokens;
  if (parsed.output_tokens !== undefined) usage.outputTokens = parsed.output_tokens;
  if (parsed.input_tokens_details?.cached_tokens !== undefined) usage.cacheReadTokens = parsed.input_tokens_details.cached_tokens;
  if (model !== undefined) usage.model = model;
  return usage;
}

export function usageFromChat(parsed: z.infer<typeof chatUsageSchema>, model?: string): ProviderUsage {
  const usage: ProviderUsage = { inputSemantics: "cache_inside_total" };
  if (parsed.prompt_tokens !== undefined) usage.inputTokens = parsed.prompt_tokens;
  if (parsed.completion_tokens !== undefined) usage.outputTokens = parsed.completion_tokens;
  if (parsed.prompt_tokens_details?.cached_tokens !== undefined) usage.cacheReadTokens = parsed.prompt_tokens_details.cached_tokens;
  if (model !== undefined) usage.model = model;
  return usage;
}

export const chatCompletionsUsageSchema = chatUsageSchema;

export function createChatStreamUsageParser(): StreamUsageParser {
  let usage: ProviderUsage | null = null;
  let model: string | undefined;
  const parser = new SseParser(({ data }) => {
    if (data === "[DONE]") return;
    const chunk = z.object({ model: z.string().optional(), usage: chatUsageSchema.nullish() }).passthrough().safeParse(safeJson(data));
    if (!chunk.success) return;
    if (chunk.data.model) model = chunk.data.model;
    if (chunk.data.usage) usage = usageFromChat(chunk.data.usage, model);
  });
  return { push: (chunk) => parser.push(chunk), usage: () => usage, outputTokensSoFar: () => usage?.outputTokens ?? null };
}

export const openAiDialect: ProviderDialect = {
  provider: "openai",
  credentialHeaders: ["authorization", "openai-organization", "openai-project"],
  isModelCall(method, path) {
    return method === "POST" && (isResponsesPath(path) || isChatPath(path));
  },
  parseRequest(path, body): ParsedProviderRequest | null {
    if (isResponsesPath(path)) {
      const parsed = responsesRequestSchema.safeParse(decodeJson(body));
      if (!parsed.success) return null;
      return {
        model: parsed.data.model,
        stream: parsed.data.stream === true,
        requestedMaxOutputTokens: parsed.data.max_output_tokens ?? null,
        estimatedInputTokens: estimateTokensFromBytes(body.byteLength),
      };
    }
    const parsed = chatRequestSchema.safeParse(decodeJson(body));
    if (!parsed.success) return null;
    return {
      model: parsed.data.model,
      stream: parsed.data.stream === true,
      requestedMaxOutputTokens: parsed.data.max_completion_tokens ?? parsed.data.max_tokens ?? null,
      estimatedInputTokens: estimateTokensFromBytes(body.byteLength),
    };
  },
  rewriteMaxOutputTokens(body, cap) {
    const raw = decodeJson(body);
    const responses = responsesRequestSchema.safeParse(raw);
    if (responses.success && "input" in responses.data) {
      const applied = Math.max(1, Math.min(responses.data.max_output_tokens ?? cap, cap));
      return { body: encodeJson({ ...responses.data, max_output_tokens: applied }), appliedMaxTokens: applied };
    }
    const chat = chatRequestSchema.safeParse(raw);
    if (!chat.success) return null;
    const applied = Math.max(1, Math.min(chat.data.max_completion_tokens ?? chat.data.max_tokens ?? cap, cap));
    const { max_tokens: _legacy, ...rest } = chat.data;
    const rewritten = {
      ...rest,
      max_completion_tokens: applied,
      ...(chat.data.stream === true
        ? { stream_options: { ...(chat.data.stream_options ?? {}), include_usage: true } }
        : {}),
    };
    return { body: encodeJson(rewritten), appliedMaxTokens: applied };
  },
  stampKey(headers, key) {
    headers.set("authorization", `Bearer ${key}`);
  },
  parseResponseUsage(body) {
    const raw = decodeJson(body);
    const responses = z.object({ model: z.string().optional(), usage: responsesUsageSchema.optional(), object: z.string().optional() }).passthrough().safeParse(raw);
    if (responses.success && responses.data.object === "response" && responses.data.usage) {
      return usageFromResponses(responses.data.usage, responses.data.model);
    }
    const chat = z.object({ model: z.string().optional(), usage: chatUsageSchema.optional() }).passthrough().safeParse(raw);
    if (chat.success && chat.data.usage) return usageFromChat(chat.data.usage, chat.data.model);
    return null;
  },
  createStreamUsageParser(): StreamUsageParser {
    let usage: ProviderUsage | null = null;
    const chat = createChatStreamUsageParser();
    const parser = new SseParser(({ event, data }) => {
      if (event === "response.completed" || event === "response.incomplete") {
        const payload = z.object({ response: z.object({ model: z.string().optional(), usage: responsesUsageSchema.optional() }).passthrough() }).safeParse(safeJson(data));
        if (payload.success && payload.data.response.usage) {
          usage = usageFromResponses(payload.data.response.usage, payload.data.response.model);
        }
      }
    });
    return {
      push: (chunk) => {
        parser.push(chunk);
        chat.push(chunk);
      },
      usage: () => usage ?? chat.usage(),
      outputTokensSoFar: () => (usage ?? chat.usage())?.outputTokens ?? null,
    };
  },
};
