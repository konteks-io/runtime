import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { httpsProxyFor, openHttpsProxyTunnel, type Logger } from "@konteks/remote-common";

/**
 * The Gemini API key relay. One relay per
 * Google Antigravity process that signs in with a Gemini API key, living in
 * the runner:
 * - it listens on 127.0.0.1 only, on a random port, and the server reaches it
 *   through `GOOGLE_GEMINI_BASE_URL`;
 * - the server holds only a random per-process token (sent to it through ACP
 *   `authenticate` `_meta["api-key"]`, never the environment), which is all a
 *   command in the agent's shell could ever find; the relay refuses anything
 *   without that token;
 * - the relay swaps the token for the person's real key and forwards only to
 *   `https://generativelanguage.googleapis.com`, only on the Gemini model
 *   paths (`models`, `:generateContent`, `:streamGenerateContent`,
 *   `:countTokens`), streaming the answer back as it comes;
 * - it reads Google's `usageMetadata` from each answer and records the tokens
 *   and the real model name, because the server itself reports no usage;
 *   the runner prices a turn from them;
 * - behind a proxy (`HTTPS_PROXY`/`ALL_PROXY`, `NO_PROXY`, from the
 *   connector's own environment, never the agent's) it reaches Google
 *   through a CONNECT tunnel with its own TLS session, as the download does;
 *   a proxy it cannot use is a plain 502, never a direct connection.
 * No request or answer body, header, token or key is ever logged.
 */

export const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";

/** Gemini's `usageMetadata` fields the relay keeps (tokens only). */
export interface GeminiUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  cachedContentTokenCount: number;
  toolUsePromptTokenCount: number;
  totalTokenCount: number;
}

/** What one model answered in a span of requests. */
export interface GeminiModelUsage {
  /** The model id in the request path (`gemini-3.8-flash`), as Google was asked for it. */
  model: string;
  usage: GeminiUsage;
  requests: number;
}

const USAGE_FIELDS = ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount", "totalTokenCount"] as const;
const emptyUsage = (): GeminiUsage => ({ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0, toolUsePromptTokenCount: 0, totalTokenCount: 0 });

/**
 * Every answered model request of one relay, in order. A turn marks where it
 * started and reads what came after; one Antigravity process runs one session
 * at a time, so that span is the turn's.
 */
export class GeminiUsageMeter {
  private readonly entries: Array<{ model: string; usage: GeminiUsage }> = [];
  private dropped = 0;

  record(model: string, usage: GeminiUsage): void {
    this.entries.push({ model, usage });
    // Bounded: a relay lives as long as its process; old spans are never read again.
    if (this.entries.length > 4_096) { this.entries.shift(); this.dropped += 1; }
  }

  /** The position a later `since` counts from. */
  mark(): number {
    return this.dropped + this.entries.length;
  }

  /** Usage per model recorded after `mark`, largest first; empty when none. */
  since(mark: number): GeminiModelUsage[] {
    const start = Math.max(0, mark - this.dropped);
    const byModel = new Map<string, GeminiModelUsage>();
    for (const entry of this.entries.slice(start)) {
      const current = byModel.get(entry.model) ?? { model: entry.model, usage: emptyUsage(), requests: 0 };
      for (const field of USAGE_FIELDS) current.usage[field] += entry.usage[field];
      current.requests += 1;
      byModel.set(entry.model, current);
    }
    return [...byModel.values()].sort((a, b) => b.usage.totalTokenCount - a.usage.totalTokenCount);
  }
}

/** Where the relay forwards; only tests (a fake Google on loopback) replace it. */
export interface GeminiRelayUpstream {
  origin: string;
  ca?: string | Buffer;
}

interface AntigravityRelayOptions {
  /** The person's Gemini API key (read from the connector's store, never from the environment). */
  key: string;
  logger?: Pick<Logger, "info" | "warn">;
  /** Test seam only: a fake Google endpoint. */
  upstream?: GeminiRelayUpstream;
  /** Largest request body forwarded (default 64 MiB: prompts may carry images). */
  maxRequestBytes?: number;
  /**
   * Where the proxy variables are read from (default: the connector's own
   * environment). `HTTPS_PROXY`/`ALL_PROXY` with `NO_PROXY` are honoured for
   * Google's endpoint through an HTTP CONNECT tunnel, like
   * the download; the TLS session to Google runs inside it.
   */
  env?: NodeJS.ProcessEnv;
}

export interface AntigravityRelay {
  /** `http://127.0.0.1:<port>`: the server's `GOOGLE_GEMINI_BASE_URL`. */
  readonly url: string;
  /** The per-process token the server sends as its key; never the real key. */
  readonly token: string;
  readonly meter: GeminiUsageMeter;
  close(): Promise<void>;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIONS = new Set(["generateContent", "streamGenerateContent", "countTokens"]);
const VERSIONS = new Set(["v1", "v1beta", "v1alpha"]);
const FORWARDED_QUERY = new Set(["alt", "pageSize", "pageToken"]);
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "user-agent", "x-goog-api-client", "content-length"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "retry-after", "x-goog-api-client"];
/** Answers this large are passed on but not read for usage (a JSON answer is parsed whole). */
const MAX_PARSED_BYTES = 16 * 1024 * 1024;

/** A Gemini API path the relay forwards, with the model it names and the action, or null for anything else. */
export function geminiRelayRoute(method: string | undefined, pathname: string): { model?: string; action?: string } | null {
  const parts = pathname.split("/");
  if (!modelsPath(parts)) return null;
  if (parts.length === 3) return method === "GET" ? {} : null;
  if (parts.length !== 4 || !parts[3]) return null;
  return modelRoute(method, parts[3]);
}

/** `/<version>/models...` */
function modelsPath(parts: readonly string[]): boolean {
  return parts[0] === "" && VERSIONS.has(parts[1] ?? "") && parts[2] === "models";
}

/** `<model>` (GET) or `<model>:<action>` (POST, a forwarded action only). */
function modelRoute(method: string | undefined, segment: string): { model: string; action?: string } | null {
  const [model, action, ...rest] = decodeURIComponentSafe(segment).split(":");
  if (rest.length > 0 || !model || !MODEL_ID.test(model)) return null;
  if (action === undefined) return method === "GET" ? { model } : null;
  return method === "POST" && ACTIONS.has(action) ? { model, action } : null;
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function tokenMatches(presented: string | undefined, token: Buffer): boolean {
  if (typeof presented !== "string") return false;
  const candidate = Buffer.from(presented);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

const REFUSAL_STATUS: ReadonlyMap<number, string> = new Map([[401, "UNAUTHENTICATED"], [404, "NOT_FOUND"], [413, "INVALID_ARGUMENT"]]);

function refuse(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  const body = JSON.stringify({ error: { code: status, message, status: REFUSAL_STATUS.get(status) ?? "UNAVAILABLE" } });
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Reads Gemini's `usageMetadata` out of an answer as it streams past: every
 * `data:` event of a server-sent stream, or the whole JSON body. A streamed
 * answer repeats running totals, so each field keeps its largest value.
 */
class UsageReader {
  private readonly usage = emptyUsage();
  private seen = false;
  private pending = "";
  private bytes = 0;
  private readonly chunks: Buffer[] = [];
  private overflow = false;

  constructor(private readonly streamed: boolean) {}

  push(chunk: Buffer): void {
    if (this.overflow) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_PARSED_BYTES) { this.overflow = true; this.chunks.length = 0; this.pending = ""; return; }
    if (!this.streamed) { this.chunks.push(chunk); return; }
    const lines = (this.pending + chunk.toString("utf8")).split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  finish(): GeminiUsage | null {
    if (!this.overflow) {
      if (this.streamed) { if (this.pending) this.line(this.pending); }
      else this.parse(Buffer.concat(this.chunks).toString("utf8"));
    }
    return this.seen ? this.usage : null;
  }

  private line(line: string): void {
    if (line.startsWith("data:")) this.parse(line.slice(5).trim());
  }

  private parse(text: string): void {
    for (const item of jsonItems(text)) {
      const metadata = (item as { usageMetadata?: unknown } | null)?.usageMetadata;
      if (!metadata || typeof metadata !== "object") continue;
      this.seen = true;
      this.keepLargest(metadata as Record<string, unknown>);
    }
  }

  private keepLargest(metadata: Record<string, unknown>): void {
    for (const field of USAGE_FIELDS) {
      const count = metadata[field];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) this.usage[field] = Math.max(this.usage[field], count);
    }
  }
}

/** The answer's JSON items (a streamed event or a whole body may hold one or a list); none when it is not JSON. */
function jsonItems(text: string): unknown[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch { return []; }
}

/** What every forwarded request of one relay shares. */
interface RelayContext {
  options: AntigravityRelayOptions;
  upstream: URL;
  secure: boolean;
  meter: GeminiUsageMeter;
  maxRequestBytes: number;
}

/** One admitted request on its way to Google. */
interface RelayExchange {
  request: IncomingMessage;
  response: ServerResponse;
  route: { model?: string; action?: string };
  path: string;
  headers: Record<string, string>;
}

/** Start one relay on 127.0.0.1 with a fresh random port and token. */
export async function startAntigravityRelay(options: AntigravityRelayOptions): Promise<AntigravityRelay> {
  const token = randomBytes(32).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const meter = new GeminiUsageMeter();
  const upstream = new URL(options.upstream?.origin ?? GEMINI_API_ORIGIN);
  const secure = upstream.protocol === "https:";
  if (!options.upstream && upstream.origin !== GEMINI_API_ORIGIN) throw new Error("the relay forwards to Google only");
  const context: RelayContext = { options, upstream, secure, meter, maxRequestBytes: options.maxRequestBytes ?? 64 * 1024 * 1024 };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const admitted = admitRequest(request, response, tokenBytes, context.maxRequestBytes);
    if (!admitted) return;
    const exchange: RelayExchange = {
      request, response, route: admitted.route,
      path: upstreamPath(upstream, admitted.target),
      headers: forwardedRequestHeaders(request, options.key),
    };
    forwardThroughProxy(context, exchange);
  };

  const server: Server = createServer(handle);
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    meter,
    close: () => {
      closing ??= new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/**
 * The request's path and route, when it carries this process's token, names
 * a Gemini model path and is within the size bound; refused otherwise.
 */
function admitRequest(request: IncomingMessage, response: ServerResponse, tokenBytes: Buffer, maxRequestBytes: number): { target: URL; route: { model?: string; action?: string } } | null {
  let target: URL;
  try { target = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { refuse(response, 404, "Not a Gemini API path."); request.resume(); return null; }
  const verdict = requestVerdict(request, target, tokenBytes, maxRequestBytes);
  if (!("route" in verdict)) {
    request.resume();
    refuse(response, verdict.status, verdict.message);
    return null;
  }
  return { target, route: verdict.route };
}

function requestVerdict(request: IncomingMessage, target: URL, tokenBytes: Buffer, maxRequestBytes: number): { status: number; message: string } | { route: { model?: string; action?: string } } {
  if (!tokenMatches(presentedKey(request, target), tokenBytes)) return { status: 401, message: "The Konteks relay refused a request without this process's token." };
  const route = geminiRelayRoute(request.method, target.pathname);
  if (route === null) return { status: 404, message: "The Konteks relay forwards only Gemini model requests." };
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxRequestBytes) return { status: 413, message: "The request is too large for the Konteks relay." };
  return { route };
}

/** The token the server sends as its key: the `x-goog-api-key` header, else the `key` query parameter. */
function presentedKey(request: IncomingMessage, target: URL): string | undefined {
  const presented = request.headers["x-goog-api-key"];
  return typeof presented === "string" ? presented : target.searchParams.get("key") ?? undefined;
}

function upstreamPath(upstream: URL, target: URL): string {
  const query = new URLSearchParams();
  for (const [name, value] of target.searchParams) if (FORWARDED_QUERY.has(name)) query.append(name, value);
  return `${upstream.pathname.replace(/\/$/, "")}${target.pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;
}

/** The real key and the forwarded headers only; plain bytes back, so the answer can be read for usage as it passes. */
function forwardedRequestHeaders(request: IncomingMessage, key: string): Record<string, string> {
  const headers: Record<string, string> = { "x-goog-api-key": key };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

/** Straight to Google, or through the connector's proxy tunnel; a proxy that cannot be used is a 502. */
function forwardThroughProxy(context: RelayContext, exchange: RelayExchange): void {
  const { request, response } = exchange;
  const failed = (event: string, message: string) => {
    request.resume();
    context.options.logger?.warn({ event }, message);
    refuse(response, 502, "The Konteks relay could not reach Google through the proxy.");
  };
  let proxy: URL | null;
  try { proxy = context.secure ? httpsProxyFor(context.upstream, context.options.env ?? process.env) : null; } catch {
    failed("antigravity.relay.proxy_invalid", "the proxy setting is not usable for the Gemini API key relay");
    return;
  }
  if (proxy === null) { forwardToGoogle(context, exchange); return; }
  // The body waits while the tunnel opens.
  request.pause();
  openHttpsProxyTunnel(proxy, context.upstream, 60_000).then(tunnel => {
    if (response.writableEnded || response.destroyed) { tunnel.destroy(); return; }
    forwardToGoogle(context, exchange, tunnel);
    request.resume();
  }, () => failed("antigravity.relay.proxy_failed", "the Gemini API key relay could not reach Google through the proxy"));
}

function forwardToGoogle(context: RelayContext, exchange: RelayExchange, tunnel?: Socket): void {
  const { request, response } = exchange;
  const outgoing = (context.secure ? httpsRequest : httpRequest)(upstreamRequestOptions(context, exchange, tunnel), answer => relayAnswer(context, exchange, answer));
  outgoing.setTimeout(10 * 60_000, () => outgoing.destroy(new Error("Google stopped answering")));
  outgoing.on("error", () => {
    context.options.logger?.warn({ event: "antigravity.relay.upstream_failed" }, "the Gemini API key relay could not reach Google");
    refuse(response, 502, "The Konteks relay could not reach Google.");
  });
  let received = 0;
  request.on("data", (chunk: Buffer) => {
    received += chunk.byteLength;
    if (received > context.maxRequestBytes) { outgoing.destroy(); request.destroy(); return; }
    outgoing.write(chunk);
  });
  request.on("end", () => outgoing.end());
  request.on("error", () => outgoing.destroy());
  response.on("close", () => { if (!response.writableFinished) outgoing.destroy(); });
}

function upstreamRequestOptions(context: RelayContext, exchange: RelayExchange, tunnel: Socket | undefined) {
  const { upstream, secure } = context;
  const ca = context.options.upstream?.ca;
  return {
    protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (secure ? 443 : 80), method: exchange.request.method, path: exchange.path, headers: exchange.headers,
    ...(ca === undefined ? {} : { ca }),
    // Through the proxy: our own TLS session to Google inside the tunnel.
    ...(tunnel === undefined ? {} : {
      agent: false,
      createConnection: () => tlsConnect({ socket: tunnel, servername: upstream.hostname, ...(ca === undefined ? {} : { ca }) }),
    }),
  };
}

/** Streams Google's answer back, reading a counted model answer's usage as it passes. */
function relayAnswer(context: RelayContext, exchange: RelayExchange, answer: IncomingMessage): void {
  const { response, route } = exchange;
  const status = answer.statusCode ?? 502;
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = answer.headers[name];
    if (typeof value === "string") forwarded[name] = value;
  }
  response.writeHead(status, forwarded);
  const reader = countedAnswer(status, route) ? new UsageReader(route.action === "streamGenerateContent") : null;
  answer.on("data", (chunk: Buffer) => { reader?.push(chunk); response.write(chunk); });
  answer.on("end", () => {
    const usage = reader?.finish();
    if (usage && route.model) context.meter.record(route.model, usage);
    response.end();
  });
  answer.on("error", () => response.destroy());
}

function countedAnswer(status: number, route: { model?: string; action?: string }): boolean {
  return status >= 200 && status < 300 && route.model !== undefined && (route.action === "generateContent" || route.action === "streamGenerateContent");
}
