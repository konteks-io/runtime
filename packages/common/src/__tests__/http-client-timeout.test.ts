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

  it.each([400, 401, 403, 404, 409])("never retries permanent HTTP %s even when an old server uses a transient wire code", async status => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ code: "temporarily_unavailable", message: "generic" }), { status }));
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retrySleep: async () => undefined, logger: nullLogger });
    await expect(client.request({ method: "GET", path: "/operation", schema: { parse: value => value } }))
      .rejects.toMatchObject({ retryable: false, status });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rebuilds proof-bearing bodies for each retry while retaining the idempotency identity", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })));
    let nonce = 0;
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn,
      retrySleep: async () => undefined, logger: nullLogger });
    await client.request({ method: "POST", path: "/signed", idempotencyKey: "semantic-operation",
      bodyFactory: () => ({ operationId: "stable", proof: { nonce: `nonce-${++nonce}` } }),
      schema: { parse: value => value } });
    const bodies = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map(body => body.operationId)).toEqual(["stable", "stable"]);
    expect(bodies.map(body => body.proof.nonce)).toEqual(["nonce-1", "nonce-2"]);
    expect(fetchFn.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["idempotency-key"]))
      .toEqual(["semantic-operation", "semantic-operation"]);
  });

  it("clips retry backoff to the caller's absolute outer deadline", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })));
    const delays: number[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retryBaseDelayMs: 100,
        retrySleep: async delay => { delays.push(delay); }, retryRandom: () => 0.5, logger: nullLogger });
      await client.request({ method: "POST", path: "/operation", idempotencyKey: "stable", body: {}, deadlineAtMs: 1_050,
        schema: { parse: value => value } });
      expect(delays).toEqual([50]);
    } finally { now.mockRestore(); }
  });

  it("does not replay an unsafe POST after an uncertain failure", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("connection reset"); });
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retrySleep: async () => undefined, logger: nullLogger });
    await expect(client.request({ method: "POST", path: "/unsafe", body: {}, schema: { parse: value => value } })).rejects.toMatchObject({ retryable: true });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("stops a replay-safe request when its caller cancels the shared operation", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retrySleep: async () => undefined, logger: nullLogger });

    await expect(client.request({ method: "POST", path: "/operation", idempotencyKey: "stable", body: {},
      schema: { parse: value => value }, signal: controller.signal })).rejects.toMatchObject({ code: "operation_interrupted", retryable: false });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled retry instead of retaining a sleeping operation", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
    let retryStarted!: () => void;
    const retryStartedPromise = new Promise<void>(resolve => { retryStarted = resolve; });
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, logger: nullLogger,
      retrySleep: async (_delay, signal) => new Promise<void>((_resolve, reject) => {
        retryStarted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) });
    const request = client.request({ method: "POST", path: "/operation", idempotencyKey: "stable", body: {},
      schema: { parse: value => value }, signal: controller.signal });

    await retryStartedPromise;
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "operation_interrupted", retryable: false });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("honors a bounded Retry-After before replaying a stable operation", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })));
    const delays: number[] = [];
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retryBaseDelayMs: 25, retryAfterMaxMs: 75,
      retrySleep: async delay => { delays.push(delay); }, retryRandom: () => 0.5, logger: nullLogger });

    await expect(client.request({ method: "POST", path: "/operation", idempotencyKey: "stable", body: {},
      schema: { parse: value => value } })).resolves.toEqual({ accepted: true });
    expect(delays).toEqual([75]);
  });

  it("applies the five-second renewal retry budget only when the caller selects that policy", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
    const client = new JsonClient({ baseUrl: "https://core.example", fetchFn, retrySleep: async () => undefined, logger: nullLogger });

    await expect(client.request({ method: "POST", path: "/renew", idempotencyKey: "stable", body: {}, operationPolicy: "renewal",
      schema: { parse: value => value } })).rejects.toMatchObject({ retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
