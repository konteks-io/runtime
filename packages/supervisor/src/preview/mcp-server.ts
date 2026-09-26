import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createLogger, RemoteInstanceError, type Logger } from "@konteks/remote-common";
import type { PreviewStatus } from "./process-manager.js";

/**
 * The session's preview tools, as a connector-local loopback MCP server
 * (streamable HTTP, JSON responses) next to the platform MCP facade. The
 * agent can start, stop and inspect ITS session's preview and nothing else:
 * the tools take no arguments, so no port, command or folder can be named;
 * the command comes from the working copy (`.konteks/preview.yaml` or the
 * inferred default) and the process runs inside the session's worktree.
 *
 * The ACP process only receives a random per-session bearer; the server
 * binds 127.0.0.1 on an ephemeral port and closes with the session.
 */
export const PREVIEW_MCP_SERVER_NAME = "konteks-preview";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_REQUEST_BYTES = 256 * 1024;

/** What a session may do with this machine's previews: only its own, in its own worktree. */
export interface SessionPreviewAccess {
  start(sessionId: string, cwd: string): Promise<PreviewStatus>;
  stop(sessionId: string, reason: string): Promise<PreviewStatus>;
  status(sessionId: string): PreviewStatus;
  touch(sessionId: string): void;
  /**
   * The session's worktree may be previewed: a viewer opening the preview in
   * Konteks starts it when nothing runs. Remembered until `forget`.
   */
  permit?(sessionId: string, cwd: string): void;
  /** The session ended: no viewer starts its preview any more. */
  forget?(sessionId: string): void;
}

/** Work kinds whose agent may run a preview: code that changes, is validated or is checked. */
export const PREVIEW_WORK_KINDS: ReadonlySet<string> = new Set(["delivery", "validation", "qa", "assistant_execution"]);

export interface PreviewToolHost {
  start(): Promise<PreviewStatus>;
  stop(): Promise<PreviewStatus>;
  status(): PreviewStatus;
}

const NO_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false } as const;

export const PREVIEW_TOOLS = [
  {
    name: "preview_start",
    title: "Start the live preview",
    description: "Start (or reuse) the live preview of this session's working copy: a dev server this computer runs from the session's worktree. Takes no arguments. The command comes from .konteks/preview.yaml (serve.command, install, prepare, healthPath, env) or is inferred (the package.json dev/start script with the project's package manager, Django, Rails); the connector picks a free port and passes it as $PORT with HOST=127.0.0.1. Returns the state, the loopback URL (for a browser on this computer), the command used or inferred and the last log lines. People open the preview from the session in Konteks. It stops by itself after a long idle period.",
    inputSchema: NO_ARGUMENTS,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "preview_status",
    title: "Preview status",
    description: "Report this session's live preview: state (not_started, starting, running, failed, stopped), the loopback URL while it runs, the command and where it came from (preview.yaml or inferred), why it failed or stopped, and the last log lines. Takes no arguments.",
    inputSchema: NO_ARGUMENTS,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "preview_stop",
    title: "Stop the live preview",
    description: "Stop this session's live preview dev server and everything it started. Takes no arguments.",
    inputSchema: NO_ARGUMENTS,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }

export class PreviewMcpServer {
  private readonly credential = randomBytes(32).toString("base64url");
  private readonly logger: Logger;
  private server: Server | null = null;
  private closed = false;

  constructor(private readonly host: PreviewToolHost, private readonly options: { logger?: Logger; context?: Record<string, unknown> } = {}) {
    this.logger = options.logger ?? createLogger({ name: "preview-mcp" });
  }

  async start(): Promise<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> {
    if (this.server || this.closed) throw new RemoteInstanceError("assignment_conflict", "The preview tools are already started or closed.");
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new RemoteInstanceError("capability_unavailable", "The preview tools did not bind a loopback port.");
    server.unref();
    return { name: PREVIEW_MCP_SERVER_NAME, url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "authorization", value: `Bearer ${this.credential}` }] };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    this.server = null;
    if (server) {
      const done = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await done;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (this.closed) return this.fail(response, 503, "closed");
    if (!this.authorized(request.headers.authorization)) return this.fail(response, 401, "invalid_local_credential");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return this.fail(response, 405, "method_not_allowed");
    }
    let payload: unknown;
    try {
      payload = JSON.parse((await readBounded(request, MAX_REQUEST_BYTES)).toString("utf8"));
    } catch {
      return this.json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const batch = Array.isArray(payload);
    const requests = (batch ? payload : [payload]) as JsonRpcRequest[];
    const answers: unknown[] = [];
    for (const item of requests) {
      let answer: unknown | null;
      try {
        answer = await this.dispatch(item);
      } catch {
        answer = { jsonrpc: "2.0", id: (item as JsonRpcRequest | null)?.id ?? null, error: { code: -32603, message: "Internal error" } };
      }
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      response.statusCode = 202;
      return void response.end();
    }
    return this.json(response, 200, batch ? answers : answers[0]);
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown | null> {
    if (!request || typeof request !== "object" || typeof request.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const id = request.id;
    // A notification (no id) never gets an answer.
    if (id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (request.method) {
      case "initialize": {
        const asked = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        return reply({
          protocolVersion: typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: PREVIEW_MCP_SERVER_NAME, title: "Konteks live preview", version: "1.0.0" },
          instructions: "Use preview_start to run this session's live preview (no arguments), preview_status to see its URL, command and logs, and preview_stop when done. A browser on this computer can open the returned http://127.0.0.1 URL.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: PREVIEW_TOOLS });
      case "tools/call": {
        const name = (request.params as { name?: unknown } | undefined)?.name;
        return reply(await this.call(typeof name === "string" ? name : ""));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }

  private async call(name: string): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: PreviewStatus; isError?: boolean }> {
    let status: PreviewStatus;
    try {
      switch (name) {
        case "preview_start": status = await this.host.start(); break;
        case "preview_stop": status = await this.host.stop(); break;
        case "preview_status": status = this.host.status(); break;
        default: return { content: [{ type: "text", text: `Unknown tool ${name}. The preview tools are preview_start, preview_status and preview_stop.` }], isError: true };
      }
    } catch (error) {
      this.logger.warn({ event: "preview.tool_failed", tool: name, ...this.options.context, code: error instanceof RemoteInstanceError ? error.code : "unexpected" }, "preview tool call failed");
      return { content: [{ type: "text", text: `The preview tool failed: ${error instanceof Error ? error.message.slice(0, 300) : "unexpected error"}.` }], isError: true };
    }
    this.logger.info({ event: "preview.tool_called", tool: name, state: status.state, ...this.options.context }, "preview tool called");
    return { content: [{ type: "text", text: describeStatus(status) }], structuredContent: status, ...(name === "preview_start" && status.state === "failed" ? { isError: true } : {}) };
  }

  private authorized(value: string | undefined): boolean {
    if (!value?.startsWith("Bearer ")) return false;
    const received = Buffer.from(value.slice(7));
    const expected = Buffer.from(this.credential);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  }

  private fail(response: ServerResponse, status: number, code: string): void {
    this.json(response, status, { error: code });
  }
}

/** The plain-text answer an agent reads; the same facts are in structuredContent. */
export function describeStatus(status: PreviewStatus): string {
  const lines = [`Preview: ${status.state}${status.phase && status.state === "starting" ? ` (${status.phase})` : ""}`, status.message];
  if (status.startedBy === "viewer") lines.push("Started by a viewer who opened the preview in Konteks.");
  else if (status.startedBy === "agent") lines.push("Started by the agent (preview_start).");
  if (status.url) lines.push(`Loopback URL (a browser on this computer): ${status.url}`);
  if (status.command) lines.push(`Command: ${status.command}${status.explanation ? ` — ${status.explanation}` : ""}`);
  if (status.install) lines.push(`Install step: ${status.install}`);
  if (status.prepare) lines.push(`Prepare step: ${status.prepare}`);
  for (const note of status.notes) lines.push(`Note: ${note}`);
  if (status.state === "starting") lines.push("Still starting: call preview_status in a little while.");
  if (status.state === "running" || status.state === "starting") lines.push(`Stops by itself after ${status.idleStopMinutes} minutes with no viewer and no agent activity.`);
  if (status.logTail.length > 0) lines.push("Recent log lines:", ...status.logTail.slice(-20).map(line => `  ${line}`));
  return lines.join("\n");
}

async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
