import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createLogger, RemoteInstanceError, type Logger } from "@konteks/remote-common";
import type { CapabilityTokenIssue } from "../core/client.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MIN_REFRESH_LEAD_MS = 30_000;
const MAX_REFRESH_LEAD_MS = 120_000;
const REFRESH_RETRY_DELAY_MS = 5_000;
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "mcp-session-id",
  "retry-after",
]);

export interface McpCapabilityFacadeOptions {
  initial: CapabilityTokenIssue;
  renew: () => Promise<CapabilityTokenIssue>;
  context: { assignmentId: string; attempt: number; sessionId: string };
  logger?: Logger;
  now?: () => number;
  onUnavailable?: () => void | Promise<void>;
}

/**
 * Session-scoped loopback MCP facade (D165).
 *
 * The ACP process receives only the random loopback credential. The upstream
 * bearer remains in this process, is renewed single-flight, and is never
 * persisted or exposed in process arguments. The upstream is fixed by Core's
 * signed capability delivery; this is deliberately not a generic proxy.
 */
export class McpCapabilityFacade {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly localCredential = randomBytes(32).toString("base64url");
  private readonly activeRequests = new Set<AbortController>();
  private issue: CapabilityTokenIssue;
  private server: Server | null = null;
  private refreshTask: Promise<CapabilityTokenIssue> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private refreshFailures = 0;
  private renewalDeadline: number | null = null;

  constructor(private readonly options: McpCapabilityFacadeOptions) {
    this.issue = options.initial;
    this.logger = options.logger ?? createLogger({ name: "mcp-capability-facade" });
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> {
    if (this.server) throw new RemoteInstanceError("assignment_conflict", "The local MCP facade is already started.");
    if (this.closed) throw new RemoteInstanceError("assignment_conflict", "The local MCP facade is closed.");
    this.assertIssue(this.issue);
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new RemoteInstanceError("capability_unavailable", "The local MCP facade did not bind a TCP port.");
    server.unref();
    this.scheduleRefresh();
    this.logger.info({ event: "mcp_capability.facade_started", ...this.options.context, upstreamExpiresAt: this.issue.expiresAt }, "local MCP capability facade started");
    return {
      name: this.issue.mcpServer.name,
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: "authorization", value: `Bearer ${this.localCredential}` }],
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    this.logger.info({ event: "mcp_capability.facade_closed", ...this.options.context }, "local MCP capability facade closed");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (this.closed) return this.fail(response, 503, "facade_closed");
    if (!this.authorized(request.headers.authorization)) return this.fail(response, 401, "invalid_local_credential");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return this.fail(response, 405, "method_not_allowed");
    }
    let body: Buffer;
    try {
      body = await readBounded(request, MAX_REQUEST_BYTES);
    } catch {
      return this.fail(response, 413, "request_too_large");
    }
    try {
      let upstream = await this.forward(request, body, false);
      // Core's native MCP ingress authenticates before parsing or dispatching
      // the body. Its 401 therefore proves that replay has no tool side effect.
      if (upstream.response.status === 401) {
        upstream.controller.abort();
        this.activeRequests.delete(upstream.controller);
        this.logger.warn({ event: "mcp_capability.auth_rejected", ...this.options.context, action: "refresh_and_replay" }, "upstream MCP capability was rejected before dispatch");
        await this.refresh(true, "auth_rejection");
        upstream = await this.forward(request, body, true);
      }
      await this.writeUpstream(upstream.response, upstream.controller, response);
    } catch (error) {
      if (!response.headersSent) this.fail(response, 503, "upstream_unavailable");
      else response.destroy();
      this.logger.warn({
        event: "mcp_capability.proxy_failed",
        ...this.options.context,
        code: error instanceof RemoteInstanceError ? error.code : "temporarily_unavailable",
      }, "local MCP capability facade request failed");
    }
  }

  private async forward(request: IncomingMessage, body: Buffer, refreshedAfterRejection: boolean) {
    let issue: CapabilityTokenIssue;
    try {
      issue = await this.refresh(false, "request");
    } catch (error) {
      // A proactive renewal outage must not discard a bearer that Core still
      // accepts. The request may use it once; a 401 then follows the safe
      // pre-dispatch forced-refresh path below.
      if (this.closed || Date.parse(this.issue.expiresAt) <= this.now()) throw error;
      issue = this.issue;
      this.logger.warn({ event: "mcp_capability.refresh_deferred", ...this.options.context, expiresAt: issue.expiresAt }, "MCP request is using the still-live capability after refresh exhaustion");
    }
    const upstream = new URL(issue.mcpServer.url);
    const local = new URL(request.url ?? "/mcp", "http://127.0.0.1");
    upstream.search = local.search;
    const headers = forwardedHeaders(request.headers);
    headers.set("authorization", authorization(issue));
    const controller = new AbortController();
    this.activeRequests.add(controller);
    try {
      const response = await fetch(upstream, { method: "POST", headers, body: body.toString("utf8"), signal: controller.signal });
      this.logger.info({
        event: "mcp_capability.proxy_returned",
        ...this.options.context,
        status: response.status,
        refreshedAfterRejection,
      }, "upstream MCP request returned");
      return { response, controller };
    } catch (error) {
      this.activeRequests.delete(controller);
      throw error;
    }
  }

  private async writeUpstream(upstream: Response, controller: AbortController, response: ServerResponse): Promise<void> {
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
    }
    try {
      if (!upstream.body) return void response.end();
      await new Promise<void>((resolve, reject) => {
        const stream = Readable.fromWeb(upstream.body as never);
        stream.once("error", reject);
        response.once("error", reject);
        response.once("finish", resolve);
        stream.pipe(response);
      });
    } finally {
      this.activeRequests.delete(controller);
    }
  }

  private refresh(force: boolean, reason: "request" | "timer" | "auth_rejection"): Promise<CapabilityTokenIssue> {
    if (this.closed) return Promise.reject(new RemoteInstanceError("capability_unavailable", "The local MCP facade is closed."));
    if (!force && !this.refreshDue()) return Promise.resolve(this.issue);
    if (this.refreshTask) return this.refreshTask;
    const previousExpiry = this.issue.expiresAt;
    const startedAt = this.now();
    this.logger.info({ event: "mcp_capability.refresh_started", ...this.options.context, reason, previousExpiry }, "MCP capability refresh started");
    this.refreshTask = Promise.resolve().then(() => this.options.renew()).then(issue => {
      this.assertIssue(issue);
      if (this.closed) throw new RemoteInstanceError("capability_unavailable", "The local MCP facade is closed.");
      this.issue = issue;
      this.refreshFailures = 0;
      this.renewalDeadline = null;
      this.logger.info({ event: "mcp_capability.refresh_recovered", ...this.options.context, reason, expiresAt: issue.expiresAt, durationMs: this.now() - startedAt }, "MCP capability refresh succeeded");
      this.scheduleRefresh(this.refreshDue() ? REFRESH_RETRY_DELAY_MS : undefined);
      return issue;
    }).catch(async error => {
      this.logger.warn({
        event: "mcp_capability.refresh_exhausted",
        ...this.options.context,
        reason,
        durationMs: this.now() - startedAt,
        code: error instanceof RemoteInstanceError ? error.code : "temporarily_unavailable",
      }, "MCP capability refresh exhausted its bounded retries");
      if (!this.closed) {
        this.refreshFailures++;
        this.renewalDeadline ??= Math.min(Date.parse(this.issue.expiresAt), this.now() + 60_000);
        const remaining = this.renewalDeadline - this.now();
        const retryable = error instanceof RemoteInstanceError && (error.retryable || error.code === "temporarily_unavailable");
        if (retryable && remaining > 0) {
          const delay = Math.min(remaining, 30_000, REFRESH_RETRY_DELAY_MS * 2 ** Math.min(this.refreshFailures - 1, 3));
          this.scheduleRefresh(Math.min(remaining, delay * (0.8 + Math.random() * 0.2)));
        } else {
          this.logger.warn({ event: "mcp_capability.owner_unavailable", ...this.options.context,
            attempts: this.refreshFailures, reason: retryable ? "renewal_deadline" : "permanent_refusal" }, "MCP capability owner must stop");
          await this.close();
          try { await this.options.onUnavailable?.(); }
          catch { this.logger.error({ event: "mcp_capability.owner_stop_failed", ...this.options.context }, "MCP capability owner stop failed"); }
        }
      }
      throw error;
    }).finally(() => { this.refreshTask = null; });
    return this.refreshTask;
  }

  private refreshDue(): boolean {
    const expiresAt = Date.parse(this.issue.expiresAt);
    return !Number.isFinite(expiresAt) || this.now() >= expiresAt - refreshLead(expiresAt - this.now());
  }

  private scheduleRefresh(delayOverride?: number): void {
    if (this.closed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const expiresAt = Date.parse(this.issue.expiresAt);
    const delay = delayOverride ?? Math.max(0, expiresAt - this.now() - refreshLead(expiresAt - this.now()));
    this.logger.info({ event: "mcp_capability.refresh_scheduled", ...this.options.context, delayMs: Math.max(1, delay), expiresAt }, "MCP capability refresh scheduled");
    this.refreshTimer = setTimeout(() => void this.refresh(true, "timer").catch(() => undefined), Math.max(1, delay));
    this.refreshTimer.unref();
  }

  private assertIssue(issue: CapabilityTokenIssue): void {
    const url = new URL(issue.mcpServer.url);
    if (!/^https?:$/.test(url.protocol) || !Number.isFinite(Date.parse(issue.expiresAt)) || Date.parse(issue.expiresAt) <= this.now()) {
      throw new RemoteInstanceError("capability_unavailable", "Core returned an unusable MCP capability.");
    }
    authorization(issue);
  }

  private authorized(value: string | undefined): boolean {
    if (!value?.startsWith("Bearer ")) return false;
    const received = Buffer.from(value.slice(7));
    const expected = Buffer.from(this.localCredential);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private fail(response: ServerResponse, status: number, code: string): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: code }));
  }
}

function refreshLead(remainingMs: number): number {
  return Math.min(MAX_REFRESH_LEAD_MS, Math.max(MIN_REFRESH_LEAD_MS, Math.floor(remainingMs / 5)));
}

function authorization(issue: CapabilityTokenIssue): string {
  const value = issue.mcpServer.headers.find(header => header.name.toLowerCase() === "authorization")?.value;
  if (!value?.startsWith("Bearer ")) throw new RemoteInstanceError("capability_unavailable", "Core returned an unusable MCP capability.");
  return value;
}

function forwardedHeaders(input: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    output.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return output;
}

async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
