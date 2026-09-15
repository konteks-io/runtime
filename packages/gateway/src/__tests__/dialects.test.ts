import { describe, expect, it } from "vitest";
import { DIALECTS, anthropicDialect, deepseekDialect, googleDialect, openAiDialect } from "../dialects/index.js";
import { decodeJson, encodeJson } from "../dialects/types.js";

const text = (value: unknown): Uint8Array => encodeJson(value);
const sse = (events: Array<{ event?: string; data: unknown }>): Uint8Array =>
  new TextEncoder().encode(
    events
      .map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
      .join(""),
  );

describe("cap rewrite per dialect (provider_enforce)", () => {
  it("anthropic rewrites max_tokens down to the cap and never up", () => {
    const rewritten = anthropicDialect.rewriteMaxOutputTokens(text({ model: "claude-x", max_tokens: 4000, messages: [] }), 100);
    expect(rewritten?.appliedMaxTokens).toBe(100);
    expect(decodeJson(rewritten!.body)).toMatchObject({ model: "claude-x", max_tokens: 100, messages: [] });
    const smaller = anthropicDialect.rewriteMaxOutputTokens(text({ model: "claude-x", max_tokens: 50 }), 100);
    expect(smaller?.appliedMaxTokens).toBe(50);
  });

  it("openai responses rewrites max_output_tokens; chat rewrites max_completion_tokens and forces usage in streams", () => {
    const responses = openAiDialect.rewriteMaxOutputTokens(text({ model: "gpt-x", input: "hi", max_output_tokens: 9000 }), 10);
    expect(decodeJson(responses!.body)).toMatchObject({ max_output_tokens: 10 });
    const chat = openAiDialect.rewriteMaxOutputTokens(text({ model: "gpt-x", messages: [], max_tokens: 9000, stream: true }), 10);
    expect(decodeJson(chat!.body)).toEqual({ model: "gpt-x", messages: [], stream: true, max_completion_tokens: 10, stream_options: { include_usage: true } });
  });

  it("google rewrites generationConfig.maxOutputTokens and reads the model from the path", () => {
    const parsed = googleDialect.parseRequest("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse", text({ contents: [] }));
    expect(parsed).toMatchObject({ model: "gemini-2.5-pro", stream: true, requestedMaxOutputTokens: null });
    const rewritten = googleDialect.rewriteMaxOutputTokens(text({ contents: [], generationConfig: { temperature: 1 } }), 33);
    expect(decodeJson(rewritten!.body)).toEqual({ contents: [], generationConfig: { temperature: 1, maxOutputTokens: 33 } });
  });

  it("deepseek rewrites max_tokens like chat completions", () => {
    const rewritten = deepseekDialect.rewriteMaxOutputTokens(text({ model: "deepseek-chat", messages: [], stream: true }), 7);
    expect(decodeJson(rewritten!.body)).toMatchObject({ max_tokens: 7, stream_options: { include_usage: true } });
  });

  it("returns null (stream-cut degraded mode) when the body is not a JSON object", () => {
    for (const dialect of Object.values(DIALECTS)) {
      expect(dialect.rewriteMaxOutputTokens(new TextEncoder().encode("not json"), 10)).toBeNull();
    }
  });
});

describe("on-wire usage observation", () => {
  it("anthropic reports cache beside input from JSON and from streams", () => {
    const usage = anthropicDialect.parseResponseUsage(
      text({ model: "claude-wire", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }),
    );
    expect(usage).toEqual({ inputSemantics: "cache_beside_input", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, model: "claude-wire" });
    const parser = anthropicDialect.createStreamUsageParser();
    parser.push(sse([{ event: "message_start", data: { message: { model: "claude-wire", usage: { input_tokens: 10, cache_read_input_tokens: 3 } } } }]));
    parser.push(sse([{ event: "message_delta", data: { usage: { output_tokens: 42 } } }]));
    expect(parser.usage()).toMatchObject({ inputTokens: 10, outputTokens: 42, cacheReadTokens: 3, model: "claude-wire" });
    expect(parser.outputTokensSoFar()).toBe(42);
  });

  it("openai reports cache inside total for responses and chat, including streamed completions", () => {
    expect(openAiDialect.parseResponseUsage(text({ object: "response", model: "gpt-wire", usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } }))).toEqual({
      inputSemantics: "cache_inside_total",
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 4,
      model: "gpt-wire",
    });
    const parser = openAiDialect.createStreamUsageParser();
    parser.push(sse([{ event: "response.completed", data: { response: { model: "gpt-wire", usage: { input_tokens: 1, output_tokens: 9 } } } }]));
    expect(parser.usage()).toMatchObject({ outputTokens: 9, model: "gpt-wire" });
    const chat = openAiDialect.createStreamUsageParser();
    chat.push(sse([{ data: { model: "gpt-chat", choices: [] } }, { data: { usage: { prompt_tokens: 3, completion_tokens: 4 } } }, { data: "[DONE]" }]));
    expect(chat.usage()).toMatchObject({ inputTokens: 3, outputTokens: 4, model: "gpt-chat" });
  });

  it("google folds thoughts into output and reads cached content", () => {
    const usage = googleDialect.parseResponseUsage(text({ modelVersion: "gemini-wire", usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, thoughtsTokenCount: 4, cachedContentTokenCount: 1 } }));
    expect(usage).toEqual({ inputSemantics: "cache_inside_total", inputTokens: 5, outputTokens: 10, cacheReadTokens: 1, model: "gemini-wire" });
  });

  it("deepseek maps prompt cache hits to cache reads", () => {
    const usage = deepseekDialect.parseResponseUsage(text({ model: "deepseek-chat", usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 15, prompt_cache_miss_tokens: 5 } }));
    expect(usage).toEqual({ inputSemantics: "cache_inside_total", inputTokens: 20, outputTokens: 3, cacheReadTokens: 15, model: "deepseek-chat" });
  });

  it("unknown is not zero: a response without usage yields null, not zeros", () => {
    expect(anthropicDialect.parseResponseUsage(text({ model: "x" }))).toBeNull();
    expect(openAiDialect.parseResponseUsage(text({ object: "response" }))).toBeNull();
  });
});
