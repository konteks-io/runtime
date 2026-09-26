import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createLogger, RemoteInstanceError, type Logger } from "@konteks/remote-common";

/**
 * A session's browser gateway: the HTTP proxy its QA browser is launched
 * with (`--proxy-server`). Chromium sends loopback through a configured
 * proxy too, so every request the page makes arrives here, and the gateway
 * admits exactly one origin: the session's preview while it runs
 * (`http://127.0.0.1:<port>` from preview_status). The allow-list follows
 * the preview: a preview restarted on another port is reachable at once, a
 * stopped one is not.
 *
 * - plain HTTP to the preview origin is forwarded as is (Host included, so
 *   the dev server sees its own origin);
 * - CONNECT (how Chromium tunnels a WebSocket, for hot reload) only to the
 *   preview's host:port;
 * - anything else gets a short plain page saying why: no preview yet ("call
 *   preview_start"), or not this session's preview. No internet, no other
 *   loopback port, no HTTPS.
 *
 * It binds 127.0.0.1 on an ephemeral port and closes with the session.
 */
export interface BrowserGatewayOptions {
  /** The preview origin the browser may reach now, or null when none runs. */
  target: () => string | null;
  /** Browser traffic keeps the preview from stopping on idle. */
  onActivity?: () => void;
  logger?: Logger;
  context?: Record<string, unknown>;
}

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

export const NO_PREVIEW_MESSAGE = "No live preview is running for this session. Call preview_start (the konteks-preview tools), wait until preview_status says running, then open the URL it returns.";

export class PreviewBrowserGateway {
  private server: Server | null = null;
  private closed = false;
  private readonly sockets = new Set<Duplex>();
  private readonly logger: Logger;
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** The admitted origin for an absolute URL, or why it is refused. */
  private admit(raw: string | undefined): { ok: true; target: URL; url: URL } | { ok: false; status: number; message: string } {
    let url: URL;
    try {
      url = new URL(raw ?? "");
    } catch {
      return { ok: false, status: 400, message: "This is the browser's gateway to the session preview, not a page. Open the preview URL from preview_status." };
    }
    const current = this.options.target();
    if (current === null) return { ok: false, status: 404, message: NO_PREVIEW_MESSAGE };
    const target = new URL(current);
    if (url.protocol !== "http:" || normalizeHost(url.hostname) !== normalizeHost(target.hostname) || effectivePort(url) !== effectivePort(target)) {
      return { ok: false, status: 403, message: `This browser opens only this session's live preview (${target.origin}). ${url.protocol === "http:" || url.protocol === "https:" ? url.origin : "That address"} is outside it.` };
    }
    return { ok: true, target, url };
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    if (this.closed) return this.refuse(response, 503, "The session has ended.");
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

  /** CONNECT host:port: a raw tunnel, only to the preview itself (WebSockets for hot reload). */
  private onConnect(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const verdict = this.closed ? { ok: false as const, status: 503, message: "The session has ended." } : this.admit(`http://${request.url ?? ""}`);
    if (!verdict.ok) {
      this.counters.refused += 1;
      socket.end(`HTTP/1.1 ${verdict.status} Refused\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${verdict.message}\n`);
      return;
    }
    this.options.onActivity?.();
    this.counters.tunnels += 1;
    const upstream = this.dial(verdict.target, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
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

  private dial(target: URL, onConnect: () => void): Socket {
    const upstream = connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port: effectivePort(target) }, onConnect);
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
