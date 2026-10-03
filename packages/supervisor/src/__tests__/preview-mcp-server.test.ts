import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_MCP_SERVER_NAME, PreviewMcpServer, describeStatus } from "../preview/mcp-server.js";
import { CONVERSATION_HAS_NO_APP, CONVERSATION_HAS_NO_APP_AGENT_NOTE } from "../preview/config.js";
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

  it("logs failed starts with session and bounded diagnostics, never the preview answer", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const failed: PreviewStatus = { ...running, state: "failed", url: null, message: "private-message-canary", logTail: ["private-output-canary"],
      failure: { code: "step_failed", phase: "install", exitCode: 7, timedOut: false } };
    server = new PreviewMcpServer({ start: async () => failed, stop: async () => failed, status: () => failed },
      { logger: { info, warn } as never, context: { assignmentId: "assignment", attempt: 2 } });
    const entry = await server.start();
    const response = await fetch(entry.url, { method: "POST", headers: { authorization: entry.headers[0]!.value, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start" } }) });
    expect(await response.json()).toMatchObject({ result: { isError: true } });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "preview.tool_called", assignmentId: "assignment", attempt: 2, sessionId: "s", state: "failed", failureCode: "step_failed", phase: "install", exitCode: 7, timedOut: false }), "preview tool called");
    expect(info).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-message-canary|private-output-canary|Bearer|pnpm run/);
  });

  it("exports the failed preview call under its diagnostic parent without private payloads", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    const parent = { schemaVersion: "observability-context-v1", traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01", assignmentId: "assignment", attempt: 2 };
    const failed: PreviewStatus = { ...running, state: "failed", url: null, message: "private-message-canary", logTail: ["private-output-canary"], failure: { code: "step_failed", phase: "install", exitCode: 7, timedOut: false } };
    try {
      server = new PreviewMcpServer({ start: async () => failed, stop: async () => running, status: () => running },
        { context: { assignmentId: "assignment", attempt: 2 }, observability: () => parent } as never);
      const entry = await server.start();
      const response = await fetch(entry.url, { method: "POST", headers: { authorization: entry.headers[0]!.value, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start" } }) });
      expect(await response.json()).toMatchObject({ result: { isError: true } });
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("native.preview.tool");
      expect(spans[0]!.spanContext().traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(spans[0]!.parentSpanContext?.spanId).toBe("0123456789abcdef");
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0]!.attributes).toMatchObject({ "konteks.outcome": "failed", "konteks.error.code": "step_failed", "process.exit.code": 7 });
      expect(JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events, status: span.status })))).not.toMatch(/private-message-canary|private-output-canary|pnpm run|Bearer/);
    } finally {
      await provider.shutdown(); trace.disable(); context.disable(); propagation.disable();
    }
  });

  it("captures refused credentials without starting the preview or retaining the credential", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    const start = vi.fn(async () => running);
    try {
      server = new PreviewMcpServer({ start, stop: async () => running, status: () => running });
      const entry = await server.start();
      const response = await fetch(entry.url, { method: "POST", headers: { authorization: "Bearer private-credential-canary", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start" } }) });
      expect(response.status).toBe(401);
      expect(start).not.toHaveBeenCalled();
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("native.preview.request");
      expect(spans[0]!.attributes).toMatchObject({ "konteks.outcome": "refused", "konteks.error.code": "invalid_local_credential", "http.response.status_code": 401 });
      expect(JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events, status: span.status })))).not.toContain("private-credential-canary");
    } finally { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable(); }
  });

  it("describes a starting preview with the next step", () => {
    expect(describeStatus({ ...running, state: "starting", phase: "install", url: null })).toContain("Still starting: call preview_status");
    // Only the agent is told what to say when a conversation has no app of its own (09-30).
    expect(describeStatus({ ...running, state: "failed", url: null, message: CONVERSATION_HAS_NO_APP })).toContain(CONVERSATION_HAS_NO_APP_AGENT_NOTE);
    expect(CONVERSATION_HAS_NO_APP).not.toContain("Tell the person");
  });

  it("points a session that has the QA browser at it, and only then", () => {
    expect(describeStatus(running, { browser: true })).toContain("Open it with konteks-browser browser_navigate");
    expect(describeStatus(running)).not.toContain("konteks-browser");
  });
});


it("keeps a retained preview endpoint inactive until its owner is enabled", async () => {
  const host = { start: vi.fn(async () => running), stop: vi.fn(async () => running), status: vi.fn(() => running) };
  server = new PreviewMcpServer(host, { initiallyInactive: true });
  const entry = await server.start();
  const call = () => fetch(entry.url, { method: "POST", headers: { authorization: entry.headers[0]!.value, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start" } }) });
  expect((await call()).status).toBe(503);
  expect(host.start).not.toHaveBeenCalled();
  server.enable();
  expect((await call()).status).toBe(200);
  expect(host.start).toHaveBeenCalledOnce();
  await server.close();
  expect(() => server!.enable()).toThrow();
});
