import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createLogger, RemoteInstanceError, type Logger } from "@konteks/remote-common";
import { BROWSER_MCP_SERVER_NAME } from "@konteks/remote-agent-runner";
import type { PreviewStarter, PreviewStatus } from "./process-manager.js";
import { CONVERSATION_HAS_NO_APP, CONVERSATION_HAS_NO_APP_AGENT_NOTE } from "./config.js";
import { bearerMatches, negotiatedProtocolVersion, readJsonBody, sendJson } from "../loopback-http.js";

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
  /** The loopback origin of the session's preview while it answers (what its browser may reach), else null. */
  origin?(sessionId: string): string | null;
  /** Where Playwright's own Chromium is installed when this computer has no Chrome; absent = no browsers. */
  browsersPath?: string;
}

/**
 * Work kinds whose agent may run a preview, and also gets a browser on it
 * whenever the connector has one: code that changes, is validated or is
 * checked. The validator checks the work in its UI; a QA-mode conversation is
 * an `assistant_execution` turn whose agent exercises the preview and reports
 * the run (`run_submit`); the executor and an ordinary chat can look at what
 * they build. The browser reaches only the session's own preview, and it
 * starts only when a tool is first used.
 */
export const PREVIEW_WORK_KINDS: ReadonlySet<string> = new Set(["delivery", "validation", "qa", "assistant_execution"]);

interface PreviewToolHost {
  start(): Promise<PreviewStatus>;
  stop(): Promise<PreviewStatus>;
  status(): PreviewStatus;
}

const NO_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false } as const;

const PREVIEW_TOOLS = [
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
type ToolAnswer = { content: Array<{ type: "text"; text: string }>; structuredContent?: PreviewStatus; isError?: boolean };

const BROWSER_INSTRUCTIONS = `Use preview_start to run this session's live preview (no arguments), preview_status to see its URL, command and logs, and preview_stop when done. Open the returned http://127.0.0.1 URL with the ${BROWSER_MCP_SERVER_NAME} tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_take_screenshot): that browser reaches only this preview, plus a cloud preview or registered application you open with the quality-assurance environment_open tool (browser_navigate to the signInUrl or url it returns).`;
const PLAIN_INSTRUCTIONS = "Use preview_start to run this session's live preview (no arguments), preview_status to see its URL, command and logs, and preview_stop when done. A browser on this computer can open the returned http://127.0.0.1 URL.";

function validRequest(request: JsonRpcRequest): boolean {
  return Boolean(request) && typeof request === "object" && typeof request.method === "string";
}

function toolName(params: unknown): string {
  const name = (params as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : "";
}

function textAnswer(text: string): ToolAnswer {
  return { content: [{ type: "text", text }], isError: true };
}

export class PreviewMcpServer {
  private readonly credential = randomBytes(32).toString("base64url");
  private readonly logger: Logger;
  private server: Server | null = null;
  private closed = false;

  constructor(private readonly host: PreviewToolHost, private readonly options: { logger?: Logger; context?: Record<string, unknown>; browser?: boolean } = {}) {
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
    if (!bearerMatches(request.headers.authorization, this.credential)) return this.fail(response, 401, "invalid_local_credential");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return this.fail(response, 405, "method_not_allowed");
    }
    const payload = await readJsonBody(request, MAX_REQUEST_BYTES);
    if (payload === null) return sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    const batch = Array.isArray(payload.value);
    const answers = await this.answerAll((batch ? payload.value : [payload.value]) as JsonRpcRequest[]);
    if (answers.length === 0) {
      response.statusCode = 202;
      return void response.end();
    }
    return sendJson(response, 200, batch ? answers : answers[0]);
  }

  private async answerAll(requests: JsonRpcRequest[]): Promise<unknown[]> {
    const answers: unknown[] = [];
    for (const item of requests) {
      const answer = await this.safeDispatch(item);
      if (answer !== null) answers.push(answer);
    }
    return answers;
  }

  private async safeDispatch(item: JsonRpcRequest): Promise<unknown | null> {
    try {
      return await this.dispatch(item);
    } catch {
      return { jsonrpc: "2.0", id: (item as JsonRpcRequest | null)?.id ?? null, error: { code: -32603, message: "Internal error" } };
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown | null> {
    if (!validRequest(request)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    const id = request.id;
    // A notification (no id) never gets an answer.
    if (id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (request.method) {
      case "initialize":
        return reply(this.initializeResult(request.params));
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: PREVIEW_TOOLS });
      case "tools/call":
        return reply(await this.call(toolName(request.params)));
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }

  private initializeResult(params: unknown): Record<string, unknown> {
    return {
      protocolVersion: negotiatedProtocolVersion(params, SUPPORTED_PROTOCOL_VERSIONS),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: PREVIEW_MCP_SERVER_NAME, title: "Konteks live preview", version: "1.0.0" },
      instructions: this.options.browser ? BROWSER_INSTRUCTIONS : PLAIN_INSTRUCTIONS,
    };
  }

  private async call(name: string): Promise<ToolAnswer> {
    const run = this.tool(name);
    if (run === null) return textAnswer(`Unknown tool ${name}. The preview tools are preview_start, preview_status and preview_stop.`);
    let status: PreviewStatus;
    try {
      status = await run();
    } catch (error) {
      this.logger.warn({ event: "preview.tool_failed", tool: name, ...this.options.context, code: error instanceof RemoteInstanceError ? error.code : "unexpected" }, "preview tool call failed");
      return textAnswer(`The preview tool failed: ${error instanceof Error ? error.message.slice(0, 300) : "unexpected error"}.`);
    }
    this.logger.info({ event: "preview.tool_called", tool: name, state: status.state, ...this.options.context }, "preview tool called");
    return { content: [{ type: "text", text: describeStatus(status, { browser: this.options.browser === true }) }], structuredContent: status, ...(name === "preview_start" && status.state === "failed" ? { isError: true } : {}) };
  }

  private tool(name: string): (() => Promise<PreviewStatus> | PreviewStatus) | null {
    switch (name) {
      case "preview_start": return () => this.host.start();
      case "preview_stop": return () => this.host.stop();
      case "preview_status": return () => this.host.status();
      default: return null;
    }
  }

  private fail(response: ServerResponse, status: number, code: string): void {
    sendJson(response, status, { error: code });
  }
}

/** The plain-text answer an agent reads; the same facts are in structuredContent. */
export function describeStatus(status: PreviewStatus, options: { browser?: boolean } = {}): string {
  const lines = [`Preview: ${status.state}${status.phase && status.state === "starting" ? ` (${status.phase})` : ""}`, status.message];
  for (const describe of STATUS_LINES) lines.push(...describe(status, options.browser === true));
  if (status.logTail.length > 0) lines.push("Recent log lines:", ...status.logTail.slice(-20).map(line => `  ${line}`));
  return lines.join("\n");
}

type StatusLines = (status: PreviewStatus, browser: boolean) => string[];

function lineIf(condition: unknown, line: () => string): string[] {
  return condition ? [line()] : [];
}

const STARTED_BY: Readonly<Record<PreviewStarter, string>> = {
  viewer: "Started by a viewer who opened the preview in Konteks.",
  agent: "Started by the agent (preview_start).",
};

const STATUS_LINES: readonly StatusLines[] = [
  status => lineIf(status.message === CONVERSATION_HAS_NO_APP, () => CONVERSATION_HAS_NO_APP_AGENT_NOTE),
  status => (status.startedBy === null ? [] : [STARTED_BY[status.startedBy]]),
  status => lineIf(status.url, () => `Loopback URL (a browser on this computer): ${status.url}`),
  (status, browser) => lineIf(status.url && browser, () => `Open it with ${BROWSER_MCP_SERVER_NAME} browser_navigate; that browser reaches only this URL (and what environment_open opens).`),
  status => lineIf(status.command, () => `Command: ${status.command}${status.explanation ? ` — ${status.explanation}` : ""}`),
  status => lineIf(status.install, () => `Install step: ${status.install}`),
  status => lineIf(status.prepare, () => `Prepare step: ${status.prepare}`),
  status => status.notes.map(note => `Note: ${note}`),
  status => lineIf(status.state === "starting", () => "Still starting: call preview_status in a little while."),
  status => lineIf(status.state === "running" || status.state === "starting", () => `Stops by itself after ${status.idleStopMinutes} minutes with no viewer and no agent activity.`),
];
