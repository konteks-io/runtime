import { describe, expect, it, vi } from "vitest";
import { nullLogger } from "../logger.js";
import { JsonClient } from "../http-client.js";

describe("request-specific Core transport deadline", () => {
  it("bounds the fetch by the shorter request budget", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }); }));
    const client = new JsonClient({ baseUrl: "https://core.example", timeoutMs: 1000, fetchFn, retrySleep: async () => undefined, logger: nullLogger });
    const started = performance.now();
    await expect(client.request({ method: "GET", path: "/", schema: { parse: value => value }, timeoutMs: 10 })).rejects.toMatchObject({ retryable: true });
    expect(performance.now() - started).toBeLessThan(500);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("retries a replay-safe transient response at least three times with exponential backoff", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { headers: { "content-type": "application/json" } }));
    const delays: number[] = [];
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retryBaseDelayMs: 25,
      retrySleep: async delay => { delays.push(delay); }, retryRandom: () => 0.5, logger: nullLogger });
    await expect(client.request({ method: "POST", path: "/operation", idempotencyKey: "stable", body: {},
      schema: { parse: value => value as { accepted: boolean } } })).resolves.toEqual({ accepted: true });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([25, 50, 100]);
  });

  it("does not replay an unsafe POST after an uncertain failure", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("connection reset"); });
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retrySleep: async () => undefined, logger: nullLogger });
    await expect(client.request({ method: "POST", path: "/unsafe", body: {}, schema: { parse: value => value } })).rejects.toMatchObject({ retryable: true });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
