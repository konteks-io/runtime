import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_MCP_SERVER_NAME, PreviewMcpServer, describeStatus } from "../preview/mcp-server.js";
import type { PreviewStatus } from "../preview/process-manager.js";

const running: PreviewStatus = {
  sessionId: "s", state: "running", phase: "serve", url: "http://127.0.0.1:43100", port: 43100, command: "pnpm run dev --host $HOST --port $PORT --strictPort",
  install: null, prepare: null, source: "inferred", explanation: "Inferred from package.json: the \"dev\" script (Vite), run with pnpm (pnpm-lock.yaml).",
  notes: [], message: "Running.", startedAt: "2026-09-26T00:00:00.000Z", readyAt: "2026-09-26T00:00:02.000Z", idleStopMinutes: 30, logTail: ["VITE ready"],
};

let server: PreviewMcpServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

async function started(host = { start: vi.fn(async () => running), stop: vi.fn(async () => ({ ...running, state: "stopped" as const, url: null })), status: vi.fn(() => running) }) {
  server = new PreviewMcpServer(host);
  const entry = await server.start();
  const call = (body: unknown, auth = entry.headers[0]!.value, method = "POST") => fetch(entry.url, { method, headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  return { host, entry, call };
}

describe("session preview tools (loopback MCP)", () => {
  it("binds loopback with a per-session bearer and refuses anything else", async () => {
    const { entry, call } = await started();
    expect(entry).toEqual({ name: PREVIEW_MCP_SERVER_NAME, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) }] });
    expect((await call({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer wrong")).status).toBe(401);
    expect((await call(undefined, entry.headers[0]!.value, "GET")).status).toBe(405);
  });

  it("speaks MCP: initialize, tools/list with argument-free tools, notifications and unknown methods", async () => {
    const { call } = await started();
    const init = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } })).json();
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "konteks-preview" } } });
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: Array<{ name: string; inputSchema: { properties: object } }> } };
    expect(list.result.tools.map(tool => tool.name)).toEqual(["preview_start", "preview_status", "preview_stop"]);
    expect(list.result.tools.every(tool => Object.keys(tool.inputSchema.properties).length === 0)).toBe(true);
    expect(await (await call({ jsonrpc: "2.0", id: 3, method: "resources/list" })).json()).toMatchObject({ id: 3, error: { code: -32601 } });
    const batch = await (await call([{ jsonrpc: "2.0", id: 4, method: "ping" }, { jsonrpc: "2.0", method: "notifications/cancelled" }])).json();
    expect(batch).toEqual([{ jsonrpc: "2.0", id: 4, result: {} }]);
  });

  it("starts, reports and stops only this session's preview, with the URL, command and logs in the answer", async () => {
    const { host, call } = await started();
    const start = await (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start", arguments: { port: 1, command: "rm -rf /" } } })).json() as { result: { content: Array<{ text: string }>; structuredContent: PreviewStatus; isError?: boolean } };
    expect(host.start).toHaveBeenCalledWith();
    expect(start.result.structuredContent).toEqual(running);
    expect(start.result.isError).toBeUndefined();
    expect(start.result.content[0]!.text).toContain("Loopback URL (a browser on this computer): http://127.0.0.1:43100");
    expect(start.result.content[0]!.text).toContain("Inferred from package.json");
    await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "preview_status" } });
    const stop = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "preview_stop" } })).json() as { result: { structuredContent: PreviewStatus } };
    expect(host.status).toHaveBeenCalledOnce();
    expect(stop.result.structuredContent.state).toBe("stopped");
    const unknown = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shell" } })).json() as { result: { isError: boolean } };
    expect(unknown.result.isError).toBe(true);
  });

  it("marks a failed start as a tool error and stops answering once closed", async () => {
    const failed: PreviewStatus = { ...running, state: "failed", url: null, message: "package.json has no dev, start or serve script." };
    const { call } = await started({ start: vi.fn(async () => failed), stop: vi.fn(async () => failed), status: vi.fn(() => failed) });
    const answer = await (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start" } })).json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]!.text).toContain("no dev, start or serve script");
    await server!.close();
    await expect(call({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow();
  });

  it("describes a starting preview with the next step", () => {
    expect(describeStatus({ ...running, state: "starting", phase: "install", url: null })).toContain("Still starting: call preview_status");
  });

  it("points a session that has the QA browser at it, and only then", () => {
    expect(describeStatus(running, { browser: true })).toContain("Open it with konteks-browser browser_navigate");
    expect(describeStatus(running)).not.toContain("konteks-browser");
  });
});
