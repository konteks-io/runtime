import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { RemoteInstanceError, createLogger, type Logger } from "@konteks/remote-common";
import type { BrowserSessions } from "./browser.js";

/**
 * The browser tool as an MCP server (streamable HTTP) on the internal
 * network. The runner composes it into `mcpServers` for qa-role sessions; the
 * container itself has no provider route. Tools are deliberately few and
 * return bounded text/PNG results.
 */
export interface BrowserToolServerOptions {
  port: number;
  sessions: BrowserSessions;
  logger?: Logger;
}

function buildMcpServer(sessions: BrowserSessions, mcpSessionId: string): McpServer {
  const server = new McpServer({ name: "konteks-browser-tool", version: "0.1.0" });
  const snapshotOutput = { url: z.string(), title: z.string(), text: z.string(), truncated: z.boolean() };
  const asResult = (value: { url: string; title: string; text: string; truncated: boolean }) => ({
    content: [{ type: "text" as const, text: `${value.title}\n${value.url}\n\n${value.text}${value.truncated ? "\n[truncated]" : ""}` }],
    structuredContent: value,
  });
  server.registerTool(
    "browser_navigate",
    { description: "Open a URL in the QA browser and return a text snapshot of the page.", inputSchema: { url: z.string().url() }, outputSchema: snapshotOutput },
    async ({ url }) => asResult(await sessions.navigate(mcpSessionId, url)),
  );
  server.registerTool("browser_snapshot", { description: "Return the current page text snapshot.", inputSchema: {}, outputSchema: snapshotOutput }, async () =>
    asResult(await sessions.snapshot(mcpSessionId)),
  );
  server.registerTool(
    "browser_click",
    { description: "Click an element by CSS selector.", inputSchema: { selector: z.string().min(1).max(512) }, outputSchema: snapshotOutput },
    async ({ selector }) => asResult(await sessions.click(mcpSessionId, selector)),
  );
  server.registerTool(
    "browser_type",
    {
      description: "Fill an input by CSS selector, optionally pressing Enter.",
      inputSchema: { selector: z.string().min(1).max(512), text: z.string().max(8_192), submit: z.boolean().default(false) },
      outputSchema: snapshotOutput,
    },
    async ({ selector, text, submit }) => asResult(await sessions.type(mcpSessionId, selector, text, submit)),
  );
  server.registerTool(
    "browser_wait_for",
    { description: "Wait for a CSS selector to appear.", inputSchema: { selector: z.string().min(1).max(512) }, outputSchema: snapshotOutput },
    async ({ selector }) => asResult(await sessions.waitFor(mcpSessionId, selector)),
  );
  server.registerTool("browser_screenshot", { description: "Capture a PNG screenshot of the viewport.", inputSchema: {} }, async () => {
    const shot = await sessions.screenshot(mcpSessionId);
    return { content: [{ type: "image" as const, data: shot.base64, mimeType: "image/png" }] };
  });
  return server;
}

export function startBrowserToolServer(options: BrowserToolServerOptions): Promise<Server> {
  const logger = options.logger ?? createLogger({ name: "browser-tool" });
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.warn({ err: error }, "browser tool request failed");
      if (!response.headersSent) {
        response.statusCode = error instanceof RemoteInstanceError ? 400 : 500;
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, activeContexts: options.sessions.activeContexts(), mcpSessions: transports.size }));
      return;
    }
    if (request.url !== "/mcp") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (request.method !== "POST") {
        response.statusCode = 400;
        response.end();
        return;
      }
      const newId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
        onsessionclosed: (closed) => {
          transports.delete(closed);
          void options.sessions.close(closed);
        },
      });
      transports.set(newId, transport);
      const server = buildMcpServer(options.sessions, newId);
      // The SDK transport type is not exact-optional clean; the shape is the SDK's own.
      await server.connect(transport as Parameters<typeof server.connect>[0]);
    }
    await transport.handleRequest(request, response);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      logger.info({ port: options.port }, "browser tool listening");
      resolve(server);
    });
  });
}
