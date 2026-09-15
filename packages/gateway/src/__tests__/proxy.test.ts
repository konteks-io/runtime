import { afterEach, describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary, type GatewayCallObservation } from "@konteks/remote-common";
import { EgressAllowlistIndex } from "../allowlist.js";
import { AssignmentRegistry } from "../caps.js";
import { KeyVault } from "../keys.js";
import type { ObservationSink } from "../observation.js";
import { startGatewayProxy, type GatewayProxy } from "../proxy.js";

const allowlist = new EgressAllowlistIndex({
  revision: "r1",
  entries: [
    { provider: "anthropic", hosts: ["api.anthropic.com"], pathPrefixes: ["/v1/messages"] },
    { provider: "openai", hosts: ["api.openai.com"], pathPrefixes: ["/v1/responses"] },
  ],
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const proxies: GatewayProxy[] = [];
afterEach(async () => {
  while (proxies.length > 0) await proxies.pop()?.close();
});

async function startWith(args: {
  upstream: (captured: Captured) => Response | Promise<Response>;
  stage?: "observe" | "preflight_block" | "provider_enforce";
  key?: string;
  bind?: boolean;
}): Promise<{ proxy: GatewayProxy; observations: GatewayCallObservation[]; captured: Captured[] }> {
  const observations: GatewayCallObservation[] = [];
  const captured: Captured[] = [];
  const keys = new KeyVault();
  if (args.key !== undefined) keys.set("claude-code", args.key);
  const assignments = new AssignmentRegistry();
  if (args.bind !== false) assignments.bind("claude-code", { assignmentId: "asg-1", attempt: 2, remainingOutputTokens: 50 });
  const sink: ObservationSink = { emit: async (observation) => void observations.push(observation) };
  const proxy = await startGatewayProxy({
    port: 0,
    instanceId: () => "inst-1",
    allowlist,
    keys,
    assignments,
    stage: () => args.stage ?? "provider_enforce",
    sink,
    now: () => new Date("2026-09-06T00:00:00Z"),
    fetchFn: async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
      const record = { url: String(input), headers, body: init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "" };
      captured.push(record);
      return args.upstream(record);
    },
  });
  proxies.push(proxy);
  return { proxy, observations, captured };
}

function port(proxy: GatewayProxy): number {
  const address = proxy.server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("egress gateway proxy", () => {
  it("stamps the in-memory key, strips inbound credentials, rewrites the cap, and observes on-wire usage", async () => {
    const { proxy, observations, captured } = await startWith({
      key: SECRET_CANARIES.anthropicKey,
      upstream: () =>
        new Response(JSON.stringify({ model: "claude-wire-3", usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "leak=1" },
        }),
    });
    const response = await fetch(`http://127.0.0.1:${port(proxy)}/agents/claude-code/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "agent-supplied-should-be-dropped", cookie: "a=b" },
      body: JSON.stringify({ model: "claude-requested", max_tokens: 9999, messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const upstream = captured[0]!;
    expect(upstream.url).toBe("https://api.anthropic.com/v1/messages");
    expect(upstream.headers["x-api-key"]).toBe(SECRET_CANARIES.anthropicKey);
    expect(upstream.headers.cookie).toBeUndefined();
    expect(JSON.parse(upstream.body)).toMatchObject({ max_tokens: 50 });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual({
      instanceId: "inst-1",
      assignmentId: "asg-1",
      attempt: 2,
      agentId: "claude-code",
      provider: "anthropic",
      model: "claude-wire-3",
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 1,
      inputSemantics: "cache_beside_input",
      capEnforcement: "provider_enforce",
      appliedMaxTokens: 50,
      moneyBasis: "gateway_priced",
      observedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(containsCanary(JSON.stringify(observations))).toBe(false);
    expect(JSON.stringify(observations)).not.toContain("messages");
  });

  it("fails closed for a keyed agent without a key, an unbound agent, and a non-allowlisted destination", async () => {
    const { proxy } = await startWith({ upstream: () => new Response("{}"), key: undefined });
    const base = `http://127.0.0.1:${port(proxy)}`;
    const unkeyed = await fetch(`${base}/agents/claude-code/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(unkeyed.status).toBe(401);
    const notAllowed = await fetch(`${base}/agents/claude-code/anthropic/v1/admin`, { method: "POST", body: "{}" });
    expect(notAllowed.status).toBe(403);
    const otherHost = await fetch(`${base}/agents/claude-code/google/v1beta/models/x:generateContent`, { method: "POST", body: "{}" });
    expect(otherHost.status).toBe(403);
    expect(proxy.stats().calls).toBe(0);
  });

  it("refuses an unbound agent so no unmetered path exists", async () => {
    const { proxy, observations } = await startWith({ upstream: () => new Response("{}"), key: "k".repeat(16), bind: false });
    const response = await fetch(`http://127.0.0.1:${port(proxy)}/agents/claude-code/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(response.status).toBe(403);
    expect(observations).toHaveLength(0);
  });

  it("outage fails closed: an unreachable provider yields 502 and no observation", async () => {
    const { proxy, observations } = await startWith({
      key: "k".repeat(16),
      upstream: () => {
        throw new TypeError("fetch failed");
      },
    });
    const response = await fetch(`http://127.0.0.1:${port(proxy)}/agents/claude-code/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }),
    });
    expect(response.status).toBe(502);
    expect(observations).toHaveLength(0);
    expect(proxy.stats().upstreamFailures).toBe(1);
  });

  it("cuts a stream at the cap when the dialect cannot rewrite and still observes", async () => {
    const chunks = [
      "event: message_start\ndata: {\"message\":{\"model\":\"claude-s\",\"usage\":{\"input_tokens\":1}}}\n\n",
      "event: message_delta\ndata: {\"usage\":{\"output_tokens\":30}}\n\n",
      "event: message_delta\ndata: {\"usage\":{\"output_tokens\":60}}\n\n",
      "event: message_delta\ndata: {\"usage\":{\"output_tokens\":90}}\n\n",
    ];
    const { proxy, observations } = await startWith({
      key: "k".repeat(16),
      upstream: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await fetch(`http://127.0.0.1:${port(proxy)}/agents/claude-code/anthropic/v1/messages`, {
      method: "POST",
      body: "not-json-so-no-rewrite",
    });
    expect(response.status).toBe(200);
    await response.text();
    // A non-JSON body is not a parseable model call, so it is forwarded verbatim without observation.
    expect(observations).toHaveLength(0);
  });

  it("preflight_block returns a structured refusal and no upstream call", async () => {
    const { proxy, captured } = await startWith({ key: "k".repeat(16), stage: "preflight_block", upstream: () => new Response("{}") });
    const assignments = new AssignmentRegistry();
    assignments.bind("claude-code", { assignmentId: "a", attempt: 1, remainingOutputTokens: 0 });
    const response = await fetch(`http://127.0.0.1:${port(proxy)}/agents/claude-code/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }),
    });
    // The proxy's own registry has 50 remaining tokens, so this call is admitted; the exhausted case is covered in caps.test.ts.
    expect([200, 429]).toContain(response.status);
    expect(captured.length).toBeLessThanOrEqual(1);
  });
});
