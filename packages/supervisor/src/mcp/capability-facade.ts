import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createLogger, plainRecord, RemoteInstanceError, type Logger } from "@konteks/remote-common";
import type { CapabilityTokenIssue } from "../core/client.js";
import type { McpLocalTransportIdentity } from "./local-transport.js";
import { bearerMatches, readBounded, sendJson } from "../loopback-http.js";

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

/** Core's tool that opens a cloud preview or a registered application in the session's browser. */
const ENVIRONMENT_OPEN_TOOL = "platform__quality-assurance__environment_open";
const MAX_OBSERVED_RESPONSE_BYTES = 1024 * 1024;
/** No Core grant is trusted for longer than a day, whatever it says. */
const MAX_GRANT_MS = 24 * 60 * 60 * 1000;

/** The origins Core opened for this session's browser, as Core answered `environment_open`. */
interface BrowserAccessGrant {
  kind: "cloud_preview" | "external";
  origins: Array<{ origin: string; expiresAt: string }>;
}

/** Local transport continuity only. This credential never grants Core authority. */
export type { McpLocalTransportIdentity } from "./local-transport.js";

interface McpCapabilityFacadeOptions {
  initial: CapabilityTokenIssue;
  renew: () => Promise<CapabilityTokenIssue>;
  localTransport?: McpLocalTransportIdentity;
  /** Bind the retained socket before ownership transfer, but deny it until the transfer commits. */
  initiallyInactive?: boolean;
  context: { assignmentId: string; attempt: number; sessionId: string };
  logger?: Logger;
  now?: () => number;
  onUnavailable?: () => void | Promise<void>;
  /**
   * Core answered `environment_open` for this session: the session's browser
   * may now reach these origins. Read only from Core's response to that one
   * tool, never from anything the agent sent, and only when it names this
   * facade's own session.
   */
  onBrowserAccess?: (grant: BrowserAccessGrant) => void;
}

/**
 * Session-scoped loopback MCP facade.
 *
 * The ACP process receives only the random loopback credential. The upstream
 * bearer remains in this process, is renewed single-flight, and is never
 * persisted or exposed in process arguments. The upstream is fixed by Core's
 * signed capability delivery; this is deliberately not a generic proxy.
 */
export class McpCapabilityFacade {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly localCredential: string;
  private readonly activeRequests = new Set<AbortController>();
  private issue: CapabilityTokenIssue;
  private server: Server | null = null;
  private refreshTask: Promise<CapabilityTokenIssue> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private active: boolean;
  private refreshFailures = 0;
  private renewalDeadline: number | null = null;

  constructor(private readonly options: McpCapabilityFacadeOptions) {
    this.issue = options.initial;
    this.localCredential = options.localTransport?.credential ?? randomBytes(32).toString("base64url");
    this.active = !options.initiallyInactive;
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
      server.listen(this.options.localTransport?.port ?? 0, "127.0.0.1");
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

  localTransportIdentity(): McpLocalTransportIdentity {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new RemoteInstanceError("capability_unavailable", "The local MCP facade has no bound transport.");
    return { port: address.port, credential: this.localCredential };
  }

  enable(): void {
    if (this.closed || !this.server) throw new RemoteInstanceError("execution_fenced", "The local MCP facade is unavailable.");
    this.active = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
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
    const refusal = this.refusal(request);
    if (refusal) {
      if (refusal.status === 405) response.setHeader("Allow", "POST");
      return this.fail(response, refusal.status, refusal.code);
    }
    let body: Buffer;
    try {
      body = await readBounded(request, MAX_REQUEST_BYTES);
    } catch {
      return this.fail(response, 413, "request_too_large");
    }
    try {
      await this.proxy(request, body, response);
    } catch (error) {
      this.proxyFailed(response, error);
    }
  }

  private refusal(request: IncomingMessage): { status: number; code: string } | null {
    if (this.closed) return { status: 503, code: "facade_closed" };
    if (!bearerMatches(request.headers.authorization, this.localCredential)) return { status: 401, code: "invalid_local_credential" };
    if (!this.active) return { status: 503, code: "assignment_not_active" };
    if (request.method !== "POST") return { status: 405, code: "method_not_allowed" };
    return null;
  }

  private async proxy(request: IncomingMessage, body: Buffer, response: ServerResponse): Promise<void> {
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
    const observed = this.options.onBrowserAccess ? environmentOpenRequestId(body) : undefined;
    if (observed !== undefined) await this.writeObserved(upstream.response, upstream.controller, response, observed);
    else await this.writeUpstream(upstream.response, upstream.controller, response);
  }

  private proxyFailed(response: ServerResponse, error: unknown): void {
    if (!response.headersSent) this.fail(response, 503, "upstream_unavailable");
    else response.destroy();
    this.logger.warn({
      event: "mcp_capability.proxy_failed",
      ...this.options.context,
      code: error instanceof RemoteInstanceError ? error.code : "temporarily_unavailable",
    }, "local MCP capability facade request failed");
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
    if (this.closed || !this.active) throw new RemoteInstanceError("execution_fenced", "The local MCP facade lost its assignment.");
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
    copyResponseHeaders(upstream, response);
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

  /**
   * Relay Core's answer to `environment_open` after reading the browser
   * access it grants. Buffered (bounded) because the grant must be in place
   * before the agent's next call opens the link; anything that is not a
   * single JSON answer to that request passes through untouched and grants
   * nothing.
   */
  private async writeObserved(upstream: Response, controller: AbortController, response: ServerResponse, requestId: string | number): Promise<void> {
    if (!observableAnswer(upstream)) return this.writeUpstream(upstream, controller, response);
    let text: string;
    try {
      text = await boundedText(upstream.body!, controller);
    } finally {
      this.activeRequests.delete(controller);
    }
    this.readGrant(text, requestId);
    response.statusCode = upstream.status;
    copyResponseHeaders(upstream, response);
    response.end(text);
  }

  private readGrant(text: string, requestId: string | number): void {
    try {
      const grant = browserAccessFrom(text, requestId, this.options.context.sessionId, this.now());
      if (grant) this.options.onBrowserAccess?.(grant);
    } catch {
      this.logger.warn({ event: "mcp_capability.browser_access_unreadable", ...this.options.context }, "environment_open answer could not be read; the browser gains nothing");
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
    }).catch(error => this.refreshFailed(error, reason, startedAt))
      .finally(() => { this.refreshTask = null; });
    return this.refreshTask;
  }

  private async refreshFailed(error: unknown, reason: "request" | "timer" | "auth_rejection", startedAt: number): Promise<never> {
    this.logger.warn({
      event: "mcp_capability.refresh_exhausted",
      ...this.options.context,
      reason,
      durationMs: this.now() - startedAt,
      code: error instanceof RemoteInstanceError ? error.code : "temporarily_unavailable",
    }, "MCP capability refresh exhausted its bounded retries");
    if (!this.closed) await this.afterRefreshFailure(error);
    throw error;
  }

  /** Retry with backoff until the renewal deadline; a permanent refusal or a missed deadline stops the owner. */
  private async afterRefreshFailure(error: unknown): Promise<void> {
    this.refreshFailures++;
    this.renewalDeadline ??= Math.min(Date.parse(this.issue.expiresAt), this.now() + 60_000);
    const remaining = this.renewalDeadline - this.now();
    const retryable = error instanceof RemoteInstanceError && (error.retryable || error.code === "temporarily_unavailable");
    if (retryable && remaining > 0) {
      const delay = Math.min(remaining, 30_000, REFRESH_RETRY_DELAY_MS * 2 ** Math.min(this.refreshFailures - 1, 3));
      this.scheduleRefresh(Math.min(remaining, delay * (0.8 + Math.random() * 0.2)));
      return;
    }
    await this.stopOwner(retryable ? "renewal_deadline" : "permanent_refusal");
  }

  private async stopOwner(reason: "renewal_deadline" | "permanent_refusal"): Promise<void> {
    this.logger.warn({ event: "mcp_capability.owner_unavailable", ...this.options.context,
      attempts: this.refreshFailures, reason }, "MCP capability owner must stop");
    await this.close();
    try { await this.options.onUnavailable?.(); }
    catch { this.logger.error({ event: "mcp_capability.owner_stop_failed", ...this.options.context }, "MCP capability owner stop failed"); }
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

  private fail(response: ServerResponse, status: number, code: string): void {
    sendJson(response, status, { error: code });
  }
}

/** The JSON-RPC id of a single `tools/call` of `environment_open`, else undefined (batches and everything else pass through). */
function environmentOpenRequestId(body: Buffer): string | number | undefined {
  const message = plainRecord(parsedJson(body.toString("utf8")));
  if (!message) return undefined;
  const params = message.params as { name?: unknown } | undefined;
  if (message.method !== "tools/call" || params?.name !== ENVIRONMENT_OPEN_TOOL) return undefined;
  return typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
}

function parsedJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A single JSON answer with a body: what the grant can be read from. */
function observableAnswer(upstream: Response): boolean {
  return upstream.status === 200 && (upstream.headers.get("content-type") ?? "").toLowerCase().includes("application/json") && upstream.body !== null;
}

/** The whole body, aborting the upstream request once it grows past the observed-answer limit. */
async function boundedText(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_OBSERVED_RESPONSE_BYTES) { controller.abort(); throw new Error("response too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  for (const [name, value] of upstream.headers) {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

/**
 * The browser access in Core's answer to that request, when it names this
 * session: http(s) origins only, each with an expiry in the future (capped
 * at a day). Null when the answer grants nothing.
 */
function browserAccessFrom(text: string, requestId: string | number, sessionId: string, now: number): BrowserAccessGrant | null {
  const content = answerContent(JSON.parse(text), requestId);
  const entries = sessionOrigins(content, sessionId);
  const kind = grantKind(content?.target?.kind);
  if (entries === null || kind === null) return null;
  const origins = grantedOrigins(entries, kind, now);
  return origins.length > 0 ? { kind, origins } : null;
}

type GrantContent = { target?: { kind?: unknown }; browserAccess?: { sessionId?: unknown; origins?: unknown } };
type GrantEntry = { origin?: unknown; expiresAt?: unknown } | null | undefined;

/** The structured answer to exactly this request. */
function answerContent(message: unknown, requestId: string | number): GrantContent | undefined {
  const answer = message as { id?: unknown; result?: { structuredContent?: unknown } } | null;
  if (!answer || answer.id !== requestId) return undefined;
  return answer.result?.structuredContent as GrantContent | undefined;
}

/** The origins granted, when the grant names this session. */
function sessionOrigins(content: GrantContent | undefined, sessionId: string): unknown[] | null {
  const access = content?.browserAccess;
  if (!access || access.sessionId !== sessionId || !Array.isArray(access.origins)) return null;
  return access.origins;
}

function grantKind(target: unknown): BrowserAccessGrant["kind"] | null {
  if (target === "preview") return "cloud_preview";
  return target === "external" ? "external" : null;
}

function grantedOrigins(entries: unknown[], kind: BrowserAccessGrant["kind"], now: number): BrowserAccessGrant["origins"] {
  const origins: BrowserAccessGrant["origins"] = [];
  for (const entry of entries.slice(0, 16) as GrantEntry[]) {
    const origin = grantedOrigin(entry, kind, now);
    if (origin) origins.push(origin);
  }
  return origins;
}

/** An http(s) origin written exactly (https only for an external application), still unexpired; capped at a day. */
function grantedOrigin(entry: GrantEntry, kind: BrowserAccessGrant["kind"], now: number): BrowserAccessGrant["origins"][number] | null {
  if (typeof entry?.origin !== "string" || typeof entry.expiresAt !== "string") return null;
  const url = parsedUrl(entry.origin);
  if (!url || !allowedOrigin(url, entry.origin, kind)) return null;
  const expiresAt = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { origin: url.origin, expiresAt: new Date(Math.min(expiresAt, now + MAX_GRANT_MS)).toISOString() };
}

function parsedUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

function allowedOrigin(url: URL, origin: string, kind: BrowserAccessGrant["kind"]): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && (kind !== "external" || url.protocol === "https:");
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
