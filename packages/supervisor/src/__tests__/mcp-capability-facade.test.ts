import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogger, RemoteInstanceError } from "@konteks/remote-common";
import { McpCapabilityFacade } from "../mcp/capability-facade.js";
import type { CapabilityTokenIssue } from "../core/client.js";

const servers: Server[] = [];
const facades: McpCapabilityFacade[] = [];

afterEach(async () => {
  await Promise.all(facades.splice(0).map(facade => facade.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function upstream(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}/mcp`;
}

function issue(url: string, token: string, expiresAt: number): CapabilityTokenIssue {
  return { mcpServer: { name: "konteks-platform", url, headers: [{ name: "authorization", value: `Bearer ${token}` }] }, expiresAt: new Date(expiresAt).toISOString() };
}

async function started(options: Omit<ConstructorParameters<typeof McpCapabilityFacade>[0], "context"> & { context?: ConstructorParameters<typeof McpCapabilityFacade>[0]["context"] }) {
  const facade = new McpCapabilityFacade({ ...options, context: options.context ?? { assignmentId: "assignment", attempt: 1, sessionId: "session" }, logger: nullLogger });
  facades.push(facade);
  return { facade, entry: await facade.start() };
}

function localHeaders(entry: Awaited<ReturnType<McpCapabilityFacade["start"]>>) {
  return Object.fromEntries(entry.headers.map(header => [header.name, header.value]));
}

describe("native MCP capability facade", () => {
  it("exposes only a loopback credential and forwards with the in-memory cloud bearer", async () => {
    let seenAuthorization = "";
    const url = await upstream((request, response) => {
      seenAuthorization = request.headers.authorization ?? "";
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
    const { entry } = await started({ initial: issue(url, "cloud-secret", Date.now() + 300_000), renew: vi.fn() });
    expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(JSON.stringify(entry)).not.toContain("cloud-secret");
    const response = await fetch(entry.url, { method: "POST", headers: { ...localHeaders(entry), "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(response.status).toBe(200);
    expect(seenAuthorization).toBe("Bearer cloud-secret");
  });

  it("renews once for concurrent requests near expiry and uses the replacement bearer", async () => {
    let now = Date.now();
    const seen: string[] = [];
    const url = await upstream((request, response) => {
      seen.push(request.headers.authorization ?? "");
      response.end("ok");
    });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const renew = vi.fn(async () => {
      await blocked;
      return issue(url, "renewed", now + 300_000);
    });
    const firstExpiry = now + 120_000;
    const { entry } = await started({ initial: issue(url, "initial", firstExpiry), renew, now: () => now });
    now = firstExpiry - 10_000;
    const request = () => fetch(entry.url, { method: "POST", headers: localHeaders(entry), body: "{}" });
    const first = request();
    const second = request();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["Bearer renewed", "Bearer renewed"]);
  });

  it("refreshes and replays exactly once after Core rejects authentication before dispatch", async () => {
    const seen: string[] = [];
    const url = await upstream((request, response) => {
      const authorization = request.headers.authorization ?? "";
      seen.push(authorization);
      if (authorization === "Bearer expired") return void response.writeHead(401).end('{"error":"invalid_token"}');
      response.end("accepted");
    });
    const renew = vi.fn(async () => issue(url, "fresh", Date.now() + 300_000));
    const { entry } = await started({ initial: issue(url, "expired", Date.now() + 300_000), renew });
    const response = await fetch(entry.url, { method: "POST", headers: localHeaders(entry), body: "{}" });
    expect(await response.text()).toBe("accepted");
    expect(seen).toEqual(["Bearer expired", "Bearer fresh"]);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("never replays an ambiguous non-authentication failure", async () => {
    let calls = 0;
    const url = await upstream((_request, response) => {
      calls += 1;
      response.writeHead(503).end("later");
    });
    const renew = vi.fn(async () => issue(url, "fresh", Date.now() + 300_000));
    const { entry } = await started({ initial: issue(url, "current", Date.now() + 300_000), renew });
    const response = await fetch(entry.url, { method: "POST", headers: localHeaders(entry), body: "{}" });
    expect(response.status).toBe(503);
    expect(calls).toBe(1);
    expect(renew).not.toHaveBeenCalled();
  });
});


it('stops renewing and notifies its owner once on a permanent refusal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const renew = vi.fn(async () => { throw new RemoteInstanceError('capability_unavailable', 'No longer owned'); });
  const onUnavailable = vi.fn();
  try {
    const { facade } = await started({ initial: issue('http://127.0.0.1:1/mcp', 'secret', Date.now() + 60_000), renew, onUnavailable });
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    await facade.close();
  } finally { vi.useRealTimers(); }
});


it('bounds transient renewal to the existing capability expiry and stops the owner once', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const renew = vi.fn(async () => { throw new RemoteInstanceError('temporarily_unavailable', 'Offline', { retryable: true }); });
  const onUnavailable = vi.fn();
  try {
    const { facade } = await started({ initial: issue('http://127.0.0.1:1/mcp', 'secret', Date.now() + 60_000), renew, onUnavailable });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    const calls = renew.mock.calls.length;
    expect(calls).toBeGreaterThan(1); expect(calls).toBeLessThan(20);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renew).toHaveBeenCalledTimes(calls);
    await facade.close();
  } finally { vi.useRealTimers(); }
});


it('handles a synchronous ownership refusal through the same cleanup path', async () => {
  const onUnavailable = vi.fn();
  const { facade } = await started({ initial: issue('http://127.0.0.1:1/mcp', 'secret', Date.now() + 60_000),
    renew: () => { throw new RemoteInstanceError('execution_fenced', 'Owner lost'); }, onUnavailable });
  const refresh = () => (facade as unknown as { refresh(force: boolean, reason: string): Promise<unknown> }).refresh(true, 'timer');
  await expect(async () => refresh()).rejects.toThrow('Owner lost');
  expect(onUnavailable).toHaveBeenCalledTimes(1);
});

it("never forwards a still-unexpired bearer after renewal closes the owner", async () => {
  let now = Date.now();
  const calls = vi.fn((_request, response) => response.end("unexpected"));
  const url = await upstream(calls);
  const { facade } = await started({ initial: issue(url, "old", now + 120_000), now: () => now,
    renew: async () => { throw new RemoteInstanceError("execution_fenced", "Owner lost"); } });
  now += 115_000;
  const forward = facade as unknown as { forward(request: { headers: Record<string, never>; url: string }, body: Buffer, refreshed: boolean): Promise<unknown> };
  await expect(forward.forward({ headers: {}, url: "/mcp" }, Buffer.from("{}"), false)).rejects.toThrow("Owner lost");
  expect(calls).not.toHaveBeenCalled();
});

describe("browser access Core opens with environment_open", () => {
  const later = () => new Date(Date.now() + 600_000).toISOString();
  const answer = (id: number, over: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0", id,
    result: { structuredContent: {
      target: { kind: "preview", environmentId: "env-1" },
      signInUrl: "https://session.preview.example.com/__konteks/auth?token=t",
      browserAccess: { sessionId: "session", origins: [{ origin: "https://session.preview.example.com", expiresAt: later() }] },
      ...over,
    } },
  });
  async function facadeAnswering(body: unknown, onBrowserAccess = vi.fn()) {
    const url = await upstream((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(body));
    });
    const { entry } = await started({ initial: issue(url, "cloud", Date.now() + 300_000), renew: vi.fn(), onBrowserAccess });
    const call = (payload: unknown) => fetch(entry.url, { method: "POST", headers: { ...localHeaders(entry), "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { call, onBrowserAccess };
  }
  const open = (id: number, args: Record<string, unknown> = { environmentId: "env-1" }) =>
    ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "platform__quality-assurance__environment_open", arguments: args } });

  it("hands the session's browser what Core answered, and relays the answer unchanged", async () => {
    const body = answer(4);
    const { call, onBrowserAccess } = await facadeAnswering(body);
    const response = await call(open(4));
    expect(await response.json()).toEqual(body);
    expect(onBrowserAccess).toHaveBeenCalledWith({ kind: "cloud_preview", origins: [{ origin: "https://session.preview.example.com", expiresAt: expect.any(String) }] });
  });

  it("grants nothing from anything the agent says: its arguments, another tool, another session, or a mismatched id", async () => {
    const other = await facadeAnswering(answer(5));
    await other.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "platform__catalog__get_system", arguments: { origin: "https://evil.example" } } });
    expect(other.onBrowserAccess).not.toHaveBeenCalled();
    const foreign = await facadeAnswering(answer(6, { browserAccess: { sessionId: "someone-else", origins: [{ origin: "https://x.example", expiresAt: later() }] } }));
    await foreign.call(open(6));
    expect(foreign.onBrowserAccess).not.toHaveBeenCalled();
    const mismatched = await facadeAnswering(answer(99));
    await mismatched.call(open(7, { environmentId: "env-1", browserAccess: { sessionId: "session", origins: [{ origin: "https://evil.example", expiresAt: later() }] } }));
    expect(mismatched.onBrowserAccess).not.toHaveBeenCalled();
    const batch = await facadeAnswering([answer(8)]);
    await batch.call([open(8)]);
    expect(batch.onBrowserAccess).not.toHaveBeenCalled();
  });

  it("drops expired, non-origin and plain-http external entries, and a refusal grants nothing", async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const external = await facadeAnswering(answer(9, {
      target: { kind: "external", registrationId: "reg-1" },
      browserAccess: { sessionId: "session", origins: [
        { origin: "https://app.example.com", expiresAt: later() },
        { origin: "http://app.example.com", expiresAt: later() },
        { origin: "https://app.example.com/login", expiresAt: later() },
        { origin: "https://old.example.com", expiresAt: past },
      ] },
    }));
    await external.call(open(9, { registrationId: "reg-1" }));
    expect(external.onBrowserAccess).toHaveBeenCalledWith({ kind: "external", origins: [{ origin: "https://app.example.com", expiresAt: expect.any(String) }] });
    const refused = await facadeAnswering({ jsonrpc: "2.0", id: 10, result: { structuredContent: { error: { code: "environment_not_ready" } } } });
    await refused.call(open(10));
    expect(refused.onBrowserAccess).not.toHaveBeenCalled();
  });
});
