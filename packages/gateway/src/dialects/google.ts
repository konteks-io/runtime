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
 * Google Generative Language API. The model is on the PATH
 * (`/v1beta/models/{model}:generateContent|streamGenerateContent`), the cap
 * is `generationConfig.maxOutputTokens`, the key is `x-goog-api-key` (a
 * `?key=` query form is stripped and never forwarded), and usage is
 * `usageMetadata` with cached tokens INSIDE the prompt total.
 */
const MODEL_PATH = /^\/v1(?:beta)?\/models\/([^/:?]+):(generateContent|streamGenerateContent)(?:\?|$)/;

const requestSchema = z
  .object({
    generationConfig: z.object({ maxOutputTokens: z.number().int().positive().optional() }).passthrough().optional(),
  })
  .passthrough();

const usageSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    cachedContentTokenCount: z.number().int().nonnegative().optional(),
    thoughtsTokenCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const responseSchema = z.object({ usageMetadata: usageSchema.optional(), modelVersion: z.string().optional() }).passthrough();

function usageFrom(parsed: z.infer<typeof usageSchema>, model?: string): ProviderUsage {
  const usage: ProviderUsage = { inputSemantics: "cache_inside_total" };
  if (parsed.promptTokenCount !== undefined) usage.inputTokens = parsed.promptTokenCount;
  if (parsed.candidatesTokenCount !== undefined) {
    usage.outputTokens = parsed.candidatesTokenCount + (parsed.thoughtsTokenCount ?? 0);
  }
  if (parsed.cachedContentTokenCount !== undefined) usage.cacheReadTokens = parsed.cachedContentTokenCount;
  if (model !== undefined) usage.model = model;
  return usage;
}

export function googleModelFromPath(path: string): { model: string; stream: boolean } | null {
  const match = MODEL_PATH.exec(path);
  if (!match) return null;
  return { model: decodeURIComponent(match[1] ?? ""), stream: match[2] === "streamGenerateContent" };
}

export const googleDialect: ProviderDialect = {
  provider: "google",
  credentialHeaders: ["x-goog-api-key", "authorization"],
  isModelCall(method, path) {
    return method === "POST" && MODEL_PATH.test(path);
  },
  parseRequest(path, body): ParsedProviderRequest | null {
    const fromPath = googleModelFromPath(path);
    if (!fromPath) return null;
    const parsed = requestSchema.safeParse(decodeJson(body));
    return {
      model: fromPath.model,
      stream: fromPath.stream,
      requestedMaxOutputTokens: parsed.success ? (parsed.data.generationConfig?.maxOutputTokens ?? null) : null,
      estimatedInputTokens: estimateTokensFromBytes(body.byteLength),
    };
  },
  rewriteMaxOutputTokens(body, cap) {
    const parsed = requestSchema.safeParse(decodeJson(body));
    if (!parsed.success) return null;
    const applied = Math.max(1, Math.min(parsed.data.generationConfig?.maxOutputTokens ?? cap, cap));
    return {
      body: encodeJson({ ...parsed.data, generationConfig: { ...(parsed.data.generationConfig ?? {}), maxOutputTokens: applied } }),
      appliedMaxTokens: applied,
    };
  },
  stampKey(headers, key) {
    headers.set("x-goog-api-key", key);
  },
  parseResponseUsage(body) {
    const parsed = responseSchema.safeParse(decodeJson(body));
    if (!parsed.success || !parsed.data.usageMetadata) return null;
    return usageFrom(parsed.data.usageMetadata, parsed.data.modelVersion);
  },
  createStreamUsageParser(): StreamUsageParser {
    let usage: ProviderUsage | null = null;
    const parser = new SseParser(({ data }) => {
      const parsed = responseSchema.safeParse(safeJson(data));
      if (parsed.success && parsed.data.usageMetadata) usage = usageFrom(parsed.data.usageMetadata, parsed.data.modelVersion);
    });
    return { push: (chunk) => parser.push(chunk), usage: () => usage, outputTokensSoFar: () => usage?.outputTokens ?? null };
  },
};
