import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, isIPv4, isIPv6, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createLogger, RemoteInstanceError, type Logger } from "@konteks/remote-common";
import { BROWSER_ORIGINS_PATH } from "@konteks/remote-agent-runner";

export { BROWSER_ORIGINS_PATH };

/**
 * A session's browser gateway: the HTTP proxy its QA browser is launched
 * with (`--proxy-server`). Chromium sends loopback through a configured
 * proxy too, so every request the page makes arrives here, and the gateway
 * admits exactly:
 *
 * - the session's preview while it runs (`http://127.0.0.1:<port>` from
 *   preview_status). This follows the preview: a preview restarted on
 *   another port is reachable at once, a stopped one is not;
 * - the origins Core issued for this session (`grant`): the session's
 *   signed-in cloud preview and registered applications, which the agent
 *   opens with `environment_open`. They arrive only from Core's answer to
 *   that tool, read by the session's platform MCP facade; the agent has no
 *   way to add one, and each expires when Core said it does.
 *
 * - plain HTTP to an admitted http origin is forwarded as is (Host included,
 *   so the dev server sees its own origin);
 * - CONNECT (how Chromium reaches an https origin, and tunnels a WebSocket
 *   for hot reload) only to an admitted origin's host:port. A registered
 *   application's name must not resolve to this computer (loopback,
 *   link-local or unspecified addresses are refused, and the tunnel dials the
 *   address that was checked);
 * - anything else gets a short plain page saying why: no preview yet ("call
 *   preview_start"), or outside what this session may open.
 *
 * `GET /.konteks/browser-origins` on the gateway itself lists the granted
 * origins, so the browser launcher keeps Playwright's own `--allowed-origins`
 * in step. It binds 127.0.0.1 on an ephemeral port and closes with the
 * session.
 */
export interface BrowserGatewayOptions {
  /** The preview origin the browser may reach now, or null when none runs. */
  target: () => string | null;
  /** Test seam for the registered-application address check. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  now?: () => number;
  /** Browser traffic keeps the preview from stopping on idle. */
  onActivity?: () => void;
  logger?: Logger;
  context?: Record<string, unknown>;
}

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

export const NO_PREVIEW_MESSAGE = "No live preview is running for this session. Call preview_start (the konteks-preview tools), wait until preview_status says running, then open the URL it returns.";

/** What a Core-issued origin is for: a Core-routed cloud preview, or a workspace's registered application. */
export type BrowserGrantKind = "cloud_preview" | "external";

/** At most this many live grants per session; the oldest goes first. */
const MAX_GRANTS = 32;

interface Grant { origin: URL; kind: BrowserGrantKind; expiresAt: number }

type Admitted = { ok: true; target: URL; url: URL; grant: Grant | null };

export class PreviewBrowserGateway {
  private server: Server | null = null;
  private closed = false;
  private readonly sockets = new Set<Duplex>();
  private readonly logger: Logger;
  private readonly grants = new Map<string, Grant>();
  readonly counters = { forwarded: 0, tunnels: 0, refused: 0 };

  constructor(private readonly options: BrowserGatewayOptions) {
    this.logger = options.logger ?? createLogger({ name: "preview-browser-gateway" });
  }

  /** Start listening; returns the proxy URL the browser is launched with. */
  async start(): Promise<string> {
    if (this.server || this.closed) throw new RemoteInstanceError("assignment_conflict", "The browser gateway is already started or closed.");
    const server = createServer((request, response) => this.onRequest(request, response));
    server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => this.onConnect(request, socket, head));
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(request, socket, head));
    server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new RemoteInstanceError("capability_unavailable", "The browser gateway did not bind a loopback port.");
    server.unref();
    return `http://127.0.0.1:${address.port}`;
  }

  /**
   * Admit origins Core issued for this session until their expiry. Only the
   * session's platform MCP facade calls this, with what Core answered to
   * `environment_open`. Returns the origins now admitted.
   */
  grant(entries: ReadonlyArray<{ origin: string; expiresAt: string }>, kind: BrowserGrantKind): string[] {
    const now = this.now();
    const admitted: string[] = [];
    for (const entry of entries) {
      const origin = parseOrigin(entry.origin);
      const expiresAt = Date.parse(entry.expiresAt);
      if (!origin || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
      if (kind === "external" && origin.protocol !== "https:") continue;
      const key = originKey(origin);
      this.grants.delete(key);
      this.grants.set(key, { origin, kind, expiresAt });
      admitted.push(origin.origin);
    }
    while (this.grants.size > MAX_GRANTS) this.grants.delete(this.grants.keys().next().value!);
    if (admitted.length > 0) this.logger.info({ event: "preview.browser_origins_granted", kind, origins: admitted, ...this.options.context }, "Core opened origins for this session's browser");
    return admitted;
  }

  /** The origins Core granted that have not expired. */
  grantedOrigins(): string[] {
    const now = this.now();
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
    return [...this.grants.values()].map(grant => grant.origin.origin);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /**
   * The admitted origin for an absolute URL, or why it is refused. `tunnel`
   * is a CONNECT, which names only host:port: it matches an admitted origin
   * of either scheme on that host and port.
   */
  private admit(raw: string | undefined, tunnel = false): Admitted | { ok: false; status: number; message: string } {
    let url: URL;
    try {
      url = new URL(raw ?? "");
    } catch {
      return { ok: false, status: 400, message: "This is the browser's gateway to the session preview, not a page. Open the preview URL from preview_status." };
    }
    const sameAuthority = (a: URL, b: URL) => normalizeHost(a.hostname) === normalizeHost(b.hostname) && effectivePort(a) === effectivePort(b);
    const current = this.options.target();
    const preview = current === null ? null : new URL(current);
    if (preview && (tunnel || url.protocol === "http:") && sameAuthority(url, preview)) return { ok: true, target: preview, url, grant: null };
    const now = this.now();
    for (const grant of this.grants.values()) {
      if (grant.expiresAt <= now) continue;
      if (!sameAuthority(url, grant.origin)) continue;
      if (!tunnel && url.protocol !== grant.origin.protocol) continue;
      return { ok: true, target: grant.origin, url, grant };
    }
    const granted = this.grantedOrigins();
    if (!preview && granted.length === 0) return { ok: false, status: 404, message: NO_PREVIEW_MESSAGE };
    const allowed = [...(preview ? [`this session's live preview (${preview.origin})`] : []), ...granted].join(", ");
    const asked = url.protocol === "http:" || url.protocol === "https:" ? url.origin : "That address";
    return { ok: false, status: 403, message: `This browser opens only ${allowed}. ${asked} is outside it. A cloud preview or a registered application opens after environment_open (the quality-assurance tools).` };
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    if (this.closed) return this.refuse(response, 503, "The session has ended.");
    if (request.method === "GET" && request.url === BROWSER_ORIGINS_PATH) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
      response.end(JSON.stringify({ origins: this.grantedOrigins() }));
      return;
    }
    const verdict = this.admit(request.url);
    if (!verdict.ok) return this.refuse(response, verdict.status, verdict.message);
    this.options.onActivity?.();
    this.counters.forwarded += 1;
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    const upstream = httpRequest({
      host: verdict.target.hostname.replace(/^\[|\]$/g, ""), port: effectivePort(verdict.target), method: request.method,
      path: `${verdict.url.pathname}${verdict.url.search}`, headers,
    }, answer => {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        out[name] = value;
      }
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, out);
      answer.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) this.refuse(response, 502, "The preview did not answer. Check preview_status (it may have stopped or still be starting).");
      else response.destroy();
    });
    request.pipe(upstream);
  }

  /**
   * CONNECT host:port: a raw tunnel, only to an admitted origin — the preview
   * itself (WebSockets for hot reload) or a Core-granted one (https).
   */
  private onConnect(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, message: string) => {
      this.counters.refused += 1;
      if (status !== 404) this.logger.info({ event: "preview.browser_refused", status, ...this.options.context }, "the QA browser asked for something outside its preview");
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}\n`);
    };
    const verdict = this.closed ? { ok: false as const, status: 503, message: "The session has ended." } : this.admit(`http://${request.url ?? ""}`, true);
    if (!verdict.ok) return refuse(verdict.status, verdict.message);
    socket.on("error", () => undefined);
    void this.address(verdict).then(address => {
      if (address === null) return refuse(403, `${verdict.target.origin} resolves to this computer, which a registered application may not.`);
      if (this.closed) return refuse(503, "The session has ended.");
      this.options.onActivity?.();
      this.counters.tunnels += 1;
      const upstream = this.dial(verdict.target, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      }, address);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    }, () => refuse(502, `${verdict.target.origin} could not be resolved.`));
  }

  /**
   * The address to dial: the target's own host for the preview and a cloud
   * preview (Core composed that origin from its own deployment), and a
   * checked address for a registered application, which must not be this
   * computer. Null when it is.
   */
  private async address(verdict: Admitted): Promise<string | undefined | null> {
    if (verdict.grant?.kind !== "external") return undefined;
    const host = verdict.target.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIPv4(host) || isIPv6(host)
      ? [{ address: host, family: isIPv6(host) ? 6 : 4 }]
      : await (this.options.resolve ?? (name => dnsLookup(name, { all: true })))(host);
    if (addresses.length === 0 || addresses.some(entry => localAddress(entry.address))) return null;
    return addresses[0]!.address;
  }

  /** An absolute-form WebSocket upgrade sent to the proxy (not tunnelled): relay it raw. */
  private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const verdict = this.closed ? { ok: false as const, status: 503, message: "The session has ended." } : this.admit(request.url);
    if (!verdict.ok) {
      this.counters.refused += 1;
      socket.end(`HTTP/1.1 ${verdict.status} Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    this.options.onActivity?.();
    this.counters.tunnels += 1;
    const upstream = this.dial(verdict.target, () => {
      const lines = [`${request.method ?? "GET"} ${verdict.url.pathname}${verdict.url.search} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        if (name.toLowerCase() === "proxy-connection" || name.toLowerCase() === "proxy-authorization") continue;
        lines.push(`${name}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  private dial(target: URL, onConnect: () => void, address?: string): Socket {
    const upstream = connect({ host: address ?? target.hostname.replace(/^\[|\]$/g, ""), port: effectivePort(target) }, onConnect);
    this.sockets.add(upstream);
    upstream.once("close", () => this.sockets.delete(upstream));
    return upstream;
  }

  private refuse(response: ServerResponse, status: number, message: string): void {
    this.counters.refused += 1;
    if (status !== 404) this.logger.info({ event: "preview.browser_refused", status, ...this.options.context }, "the QA browser asked for something outside its preview");
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
    response.end(`<!doctype html><html><head><title>Konteks preview</title></head><body><p>${escapeHtml(message)}</p></body></html>\n`);
  }
}

/** An http(s) origin and nothing else (no path, credentials, query or fragment), or null. */
function parseOrigin(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== raw.replace(/\/$/, "")) return null;
  return new URL(url.origin);
}

function originKey(origin: URL): string {
  return `${origin.protocol}//${normalizeHost(origin.hostname)}:${effectivePort(origin)}`;
}

/** Loopback, link-local, unspecified or multicast: this computer or its link, never a registered application. */
function localAddress(address: string): boolean {
  const bare = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIPv4(bare)) {
    const [a, b] = bare.split(".").map(Number) as [number, number];
    return a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  return bare === "::1" || bare === "::" || /^fe[89ab]/.test(bare) || bare.startsWith("ff");
}

function normalizeHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" ? "127.0.0.1" : bare;
}

function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
