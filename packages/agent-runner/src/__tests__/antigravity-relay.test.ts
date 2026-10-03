import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GEMINI_API_ORIGIN, geminiRelayRoute, startAntigravityRelay, type AntigravityRelay } from "../host/antigravity-relay.js";
import { geminiMeasuredTurn } from "../sessions/usage-label.js";

/**
 * The Gemini API key relay against a fake Google endpoint on
 * loopback: the per-process token is required, only Gemini model paths reach
 * Google, the real key replaces the token and nothing else is sent, answers
 * stream through, and Google's usageMetadata is counted per model and turn.
 */
const KEY = "AIzaSyFAKE-relay-test-key-0123456789abc";

interface Seen { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }

const servers: Server[] = [];
const relays: AntigravityRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
});

const USAGE_1 = { promptTokenCount: 12_480, cachedContentTokenCount: 8_192, candidatesTokenCount: 412, thoughtsTokenCount: 1_536, totalTokenCount: 14_428 };

async function fakeGoogle(): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname.includes("broken")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" }, usageMetadata: { promptTokenCount: 5 } }));
      } else if (url.pathname.endsWith(":streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-internal": "never forwarded" });
        // Running totals: each event repeats the usage so far.
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }] } }], usageMetadata: { promptTokenCount: 12_480, cachedContentTokenCount: 8_192 } })}\r\n\r\n`);
        await new Promise(resolve => setTimeout(resolve, 15));
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] } }], usageMetadata: { ...USAGE_1, candidatesTokenCount: 200 } })}\r\n\r\n`);
        await new Promise(resolve => setTimeout(resolve, 15));
        res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }], usageMetadata: USAGE_1, modelVersion: "gemini-3.8-flash" })}\r\n\r\n`);
      } else if (url.pathname.endsWith(":generateContent")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, totalTokenCount: 107 } }));
      } else if (url.pathname.endsWith(":countTokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ totalTokens: 10, usageMetadata: { promptTokenCount: 999_999 } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash" }] }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function call(relay: AntigravityRelay, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string; chunks: number }> {
  return new Promise((resolve, reject) => {
    const req = request(`${relay.url}${path}`, { method: options.method ?? "POST", headers: options.headers ?? {} }, res => {
      let body = "";
      let chunks = 0;
      res.on("data", chunk => { body += chunk; chunks += 1; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, chunks }));
    });
    req.on("error", reject);
    req.end(options.body ?? "");
  });
}

describe("the Gemini API key relay", () => {
  it("listens on loopback only and forwards to Google unless a test replaces the upstream", async () => {
    const relay = await startAntigravityRelay({ key: KEY });
    relays.push(relay);
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(relay.token).not.toBe(KEY);
    expect(relay.token.length).toBeGreaterThanOrEqual(40);
    expect(GEMINI_API_ORIGIN).toBe("https://generativelanguage.googleapis.com");
    const other = await startAntigravityRelay({ key: KEY });
    relays.push(other);
    expect(other.token).not.toBe(relay.token);
    expect(other.url).not.toBe(relay.url);
  });

  it("refuses anything without this process's token, and anything but a Gemini model path, without reaching Google", async () => {
    const google = await fakeGoogle();
    const relay = await startAntigravityRelay({ key: KEY, upstream: { origin: google.origin } });
    relays.push(relay);
    const path = "/v1beta/models/gemini-3.8-flash:generateContent";
    expect((await call(relay, path)).status).toBe(401);
    expect((await call(relay, path, { headers: { "x-goog-api-key": KEY } })).status).toBe(401);
    expect((await call(relay, path, { headers: { "x-goog-api-key": `${relay.token}x` } })).status).toBe(401);
    expect((await call(relay, path, { headers: { authorization: `Bearer ${relay.token}` } })).status).toBe(401);
    const token = { "x-goog-api-key": relay.token };
    for (const [method, other] of [["POST", "/v1beta/files"], ["POST", "/v1beta/models/gemini-3.8-flash:embedContent"], ["DELETE", "/v1beta/models/gemini-3.8-flash"],
      ["POST", "/v1beta/models/..%2F..%2Ftuning:generateContent"], ["POST", "/v1beta/tunedModels/x:generateContent"], ["GET", "/upload/v1beta/files"], ["POST", "/v1beta/models"]] as const) {
      expect((await call(relay, other, { method, headers: token })).status, `${method} ${other}`).toBe(404);
    }
    expect(google.seen).toEqual([]);
    expect(geminiRelayRoute("GET", "/v1beta/models")).toEqual({});
    expect(geminiRelayRoute("POST", "/v1/models/gemini-3.1-pro-preview:streamGenerateContent")).toEqual({ model: "gemini-3.1-pro-preview", action: "streamGenerateContent" });
  });

  it("puts the real key on the forwarded request and nothing else of the caller's: no token, no other query, no credentials", async () => {
    const google = await fakeGoogle();
    const relay = await startAntigravityRelay({ key: KEY, upstream: { origin: google.origin } });
    relays.push(relay);
    const answer = await call(relay, `/v1beta/models/gemini-3.8-flash:generateContent?key=${relay.token}&alt=json&callback=evil`, {
      headers: { "content-type": "application/json", authorization: "Bearer owner", cookie: "sid=owner", "x-goog-api-client": "genai-py/1.0", "accept-encoding": "gzip" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).candidates[0].content.parts[0].text).toBe("ok");
    const forwarded = google.seen[0]!;
    expect(forwarded.url).toBe("/v1beta/models/gemini-3.8-flash:generateContent?alt=json");
    expect(forwarded.headers["x-goog-api-key"]).toBe(KEY);
    expect(forwarded.headers["x-goog-api-client"]).toBe("genai-py/1.0");
    expect(forwarded.headers["accept-encoding"]).toBe("identity");
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(JSON.stringify(forwarded)).not.toContain(relay.token);
    expect(JSON.parse(forwarded.body)).toEqual({ contents: [{ parts: [{ text: "hi" }] }] });
  });

  it("streams an answer through as it comes and counts its tokens once, per model, for the span a turn reads", async () => {
    const google = await fakeGoogle();
    const relay = await startAntigravityRelay({ key: KEY, upstream: { origin: google.origin } });
    relays.push(relay);
    const token = { "x-goog-api-key": relay.token, "content-type": "application/json" };
    const before = relay.meter.mark();
    await call(relay, "/v1beta/models", { method: "GET", headers: token });
    const streamed = await call(relay, "/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse", { headers: token, body: "{}" });
    expect(streamed.status).toBe(200);
    expect(streamed.headers["content-type"]).toBe("text/event-stream");
    expect(streamed.headers["x-internal"]).toBeUndefined();
    expect(streamed.body.match(/^data: /gm)).toHaveLength(3);
    expect(streamed.chunks).toBeGreaterThan(1);
    await call(relay, "/v1beta/models/gemini-3.8-flash:countTokens", { headers: token, body: "{}" });
    await call(relay, "/v1beta/models/broken:generateContent", { headers: token, body: "{}" });
    await call(relay, "/v1beta/models/gemini-3.1-flash-lite-preview:generateContent", { headers: token, body: "{}" });
    expect(relay.meter.since(before)).toEqual([
      { model: "gemini-3.8-flash", requests: 1, usage: { ...USAGE_1, toolUsePromptTokenCount: 0 } },
      { model: "gemini-3.1-flash-lite-preview", requests: 1, usage: { promptTokenCount: 100, candidatesTokenCount: 7, totalTokenCount: 107, thoughtsTokenCount: 0, cachedContentTokenCount: 0, toolUsePromptTokenCount: 0 } },
    ]);
    const next = relay.meter.mark();
    expect(relay.meter.since(next)).toEqual([]);
    await call(relay, "/v1beta/models/gemini-3.8-flash:generateContent", { headers: token, body: "{}" });
    expect(relay.meter.since(next)).toEqual([{ model: "gemini-3.8-flash", requests: 1, usage: expect.objectContaining({ promptTokenCount: 100 }) }]);
  });

  it("says plainly when Google cannot be reached, and never logs the key, the token or a body", async () => {
    const lines: unknown[] = [];
    const logger = { info: (...args: unknown[]) => { lines.push(args); }, warn: (...args: unknown[]) => { lines.push(args); } };
    const relay = await startAntigravityRelay({ key: KEY, logger, upstream: { origin: "http://127.0.0.1:1" } });
    relays.push(relay);
    const answer = await call(relay, "/v1beta/models/gemini-3.8-flash:generateContent", { headers: { "x-goog-api-key": relay.token }, body: "{\"secret\":\"prompt\"}" });
    expect(answer.status).toBe(502);
    expect(answer.body).toContain("could not reach Google");
    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    for (const secret of [KEY, relay.token, "prompt"]) expect(logged).not.toContain(secret);
  });
});

const haveOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("the relay behind a proxy", () => {
  it.runIf(haveOpenssl)("reaches Google through HTTPS_PROXY's CONNECT tunnel with its own TLS session, and straight when NO_PROXY covers the host", async () => {
    const certDir = await mkdtemp(join(tmpdir(), "agy-relay-cert-"));
    const sockets: Socket[] = [];
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
        "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
      const cert = await readFile(join(certDir, "cert.pem"), "utf8");
      const seen: Array<{ url?: string; key?: string }> = [];
      const google = createHttpsServer({ key: await readFile(join(certDir, "key.pem")), cert }, (req, res) => {
        seen.push({ url: req.url, key: req.headers["x-goog-api-key"] as string | undefined });
        req.resume();
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } })); });
      });
      servers.push(google as unknown as Server);
      await new Promise<void>(resolve => google.listen(0, "127.0.0.1", resolve));
      const port = (google.address() as AddressInfo).port;
      const connects: string[] = [];
      const proxy = createServer();
      proxy.on("connect", (req, client: Socket, head) => {
        connects.push(req.url ?? "");
        const [, target] = (req.url ?? "").split(":");
        const upstream = netConnect(Number(target), "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        sockets.push(client, upstream);
        upstream.on("error", () => client.destroy());
      });
      servers.push(proxy);
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const origin = `https://localhost:${port}`;

      const proxied = await startAntigravityRelay({ key: KEY, upstream: { origin, ca: cert }, env: { HTTPS_PROXY: proxyUrl } });
      relays.push(proxied);
      const body = JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] });
      const answer = await call(proxied, "/v1beta/models/gemini-3.8-flash:generateContent", { headers: { "x-goog-api-key": proxied.token, "content-type": "application/json" }, body });
      expect(answer.status).toBe(200);
      expect(connects).toEqual([`localhost:${port}`]);
      expect(seen).toEqual([{ url: "/v1beta/models/gemini-3.8-flash:generateContent", key: KEY }]);
      expect(proxied.meter.since(0)).toEqual([expect.objectContaining({ model: "gemini-3.8-flash", usage: expect.objectContaining({ promptTokenCount: 3 }) })]);

      const direct = await startAntigravityRelay({ key: KEY, upstream: { origin, ca: cert }, env: { HTTPS_PROXY: proxyUrl, NO_PROXY: "localhost" } });
      relays.push(direct);
      expect((await call(direct, "/v1beta/models/gemini-3.8-flash:countTokens", { headers: { "x-goog-api-key": direct.token }, body })).status).toBe(200);
      expect(connects).toHaveLength(1);
      expect(seen).toHaveLength(2);

      // A proxy that cannot be reached is a plain 502, never a direct connection.
      const dead = await startAntigravityRelay({ key: KEY, upstream: { origin, ca: cert }, env: { HTTPS_PROXY: "http://127.0.0.1:9" } });
      relays.push(dead);
      const refused = await call(dead, "/v1beta/models/gemini-3.8-flash:generateContent", { headers: { "x-goog-api-key": dead.token }, body });
      expect(refused.status).toBe(502);
      expect(refused.body).toContain("through the proxy");
      expect(seen).toHaveLength(2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await rm(certDir, { recursive: true, force: true });
    }
  });
});

describe("an API-key turn's money", () => {
  it("is Google's usage at the catalogue's list price, named as an estimate of the model that did the work", () => {
    const turn = geminiMeasuredTurn([{ model: "gemini-3.8-flash", requests: 3, usage: { ...USAGE_1, toolUsePromptTokenCount: 0 } }]);
    expect(turn).toMatchObject({
      provider: "google", model: "gemini-3.8-flash",
      inputTokens: 12_480, cacheReadTokens: 8_192, outputTokens: 412, thoughtTokens: 1_536, totalTokens: 14_428,
      estimate: { amountMicros: 11_135, pricingSnapshotId: expect.stringMatching(/^known-models:models\.dev@[0-9a-f]+:google\/gemini-3\.8-flash$/) },
    });
  });

  it("sums every model the turn used, and leaves the cost out when one of them has no price", () => {
    const flash = { model: "gemini-3.8-flash", requests: 1, usage: { ...USAGE_1, toolUsePromptTokenCount: 0 } };
    const both = geminiMeasuredTurn([flash, { model: "gemini-3.8-flash", requests: 1, usage: { ...USAGE_1, toolUsePromptTokenCount: 0 } }]);
    expect(both?.estimate?.amountMicros).toBe(22_270);
    const unpriced = geminiMeasuredTurn([flash, { model: "gemini-9-unknown", requests: 1, usage: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 0, cachedContentTokenCount: 0, toolUsePromptTokenCount: 0, totalTokenCount: 11 } }]);
    expect(unpriced).toMatchObject({ model: "gemini-3.8-flash", totalTokens: 14_439 });
    expect(unpriced?.estimate).toBeUndefined();
    expect(geminiMeasuredTurn([])).toBeNull();
  });
});
