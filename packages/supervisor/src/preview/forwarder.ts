import { request as httpRequest, type IncomingMessage } from "node:http";
import { WebSocket as NodeWebSocket } from "ws";
import {
  PREVIEW_LIMITS,
  createLogger,
  rewritePreviewLocation,
  sanitizePreviewHeaders,
  validatePreviewHeaders,
  validatePreviewPath,
  type Logger,
  type PreviewToCoreChunk,
  type PreviewToRuntimeChunk,
} from "@konteks/remote-common";

/**
 * Maps one `preview:<sessionId>` channel's `PreviewToRuntimeChunk`s onto the
 * loopback port the supervisor spawned for that session's preview, and
 * returns `PreviewToCoreChunk`s (adapted from bb `tunnel-client/session.ts`
 * stream mechanics: per-stream body accumulation, chunked responses and a
 * WebSocket relay, with the D125 policy in place of an open passthrough).
 *
 * The forwarder never lets a viewer name a host: the origin comes only from
 * the process manager and must be a loopback address. It never follows a
 * redirect, validates what arrives (receiver mode) and sanitizes what it
 * emits (sender mode), and caps bodies, frames, streams and idle time.
 */
export interface PreviewForwarderOptions {
  /** The running preview's loopback origin (`http://127.0.0.1:<port>`), or null when none runs. */
  origin: () => string | null;
  send: (chunk: PreviewToCoreChunk) => void;
  /**
   * Flow control: resolves true once the channel may take more response
   * bytes, false when the stream should give up (the channel closed).
   */
  waitForCapacity?: () => Promise<boolean>;
  /** Viewer traffic keeps the preview from being stopped as idle. */
  onActivity?: () => void;
  createWebSocket?: (url: string, protocols: string[] | undefined) => NodeWebSocket;
  requestFn?: typeof httpRequest;
  logger?: Logger;
  now?: () => number;
  limits?: Partial<PreviewForwarderLimits>;
}

export interface PreviewForwarderLimits {
  maxConcurrentStreams: number;
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
  maxWsFrameBytes: number;
  maxChunkBytes: number;
  idleStreamTimeoutMs: number;
}

export const DEFAULT_PREVIEW_FORWARDER_LIMITS: PreviewForwarderLimits = Object.freeze({
  maxConcurrentStreams: PREVIEW_LIMITS.maxConcurrentStreams,
  maxRequestBodyBytes: PREVIEW_LIMITS.maxRequestBodyBytes,
  maxResponseBodyBytes: PREVIEW_LIMITS.maxResponseBodyBytes,
  // A ws_frame travels in exactly one chunk, so one chunk is the real ceiling.
  maxWsFrameBytes: Math.min(PREVIEW_LIMITS.maxWsFrameBytes, PREVIEW_LIMITS.maxChunkBytes),
  maxChunkBytes: PREVIEW_LIMITS.maxChunkBytes,
  idleStreamTimeoutMs: PREVIEW_LIMITS.idleStreamTimeoutSeconds * 1_000,
});

type RequestChunk = Extract<PreviewToRuntimeChunk, { kind: "request" }>;
type WsFrameChunk = Extract<PreviewToRuntimeChunk, { kind: "ws_frame" }>;

interface HttpStream {
  kind: "http";
  chunks: Buffer[];
  bytes: number;
  method: RequestChunk["method"];
  path: string;
  headers: Record<string, string>;
  /** Tears down the loopback request/response; set once the request is dialed. */
  cancel: () => void;
  cancelled: boolean;
  executing: boolean;
  lastActivityAt: number;
}

interface WsStream {
  kind: "ws";
  socket: NodeWebSocket;
  open: boolean;
  buffered: WsFrameChunk[];
  lastActivityAt: number;
}

export interface PreviewForwarderCounters {
  streams: number;
  rejectedPaths: number;
  rejectedHeaders: number;
  refusedNoPreview: number;
  refusedStreamCap: number;
  oversized: number;
  idleClosed: number;
  upstreamFailures: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PreviewForwarder {
  private readonly streams = new Map<string, HttpStream | WsStream>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly limits: PreviewForwarderLimits;
  private sweeper: NodeJS.Timeout | null = null;
  private disposed = false;
  readonly counters: PreviewForwarderCounters = { streams: 0, rejectedPaths: 0, rejectedHeaders: 0, refusedNoPreview: 0, refusedStreamCap: 0, oversized: 0, idleClosed: 0, upstreamFailures: 0 };

  constructor(private readonly options: PreviewForwarderOptions) {
    this.logger = options.logger ?? createLogger({ name: "preview-forwarder" });
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_PREVIEW_FORWARDER_LIMITS, ...options.limits };
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), Math.min(10_000, Math.max(1_000, Math.floor(this.limits.idleStreamTimeoutMs / 4))));
    this.sweeper.unref();
  }

  /** Close every stream (the preview stopped or the channel reset); each viewer stream is told. */
  closeAll(code = 1001): void {
    for (const id of [...this.streams.keys()]) {
      this.drop(id, code, "preview stopped");
      this.options.send({ streamId: id, kind: "close", code, final: true });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const id of [...this.streams.keys()]) this.drop(id, 1001, "forwarder closed");
  }

  handle(chunk: PreviewToRuntimeChunk): void {
    this.options.onActivity?.();
    switch (chunk.kind) {
      case "request":
        this.onRequest(chunk);
        return;
      case "ws_frame":
        this.onWsFrame(chunk);
        return;
      case "close":
        this.drop(chunk.streamId, chunk.code ?? 1000, "closed by viewer");
        return;
    }
  }

  private onRequest(chunk: RequestChunk): void {
    const existing = this.streams.get(chunk.streamId);
    if (existing) {
      // A continuation chunk of a request body; anything else on a live
      // stream id (a second request, a request on a WebSocket) is refused.
      if (existing.kind !== "http" || existing.executing) {
        this.drop(chunk.streamId, 1002, "unexpected request chunk");
        return this.reply(chunk.streamId, 400, "unexpected request chunk on an open stream");
      }
      if (!this.appendBody(chunk.streamId, existing, chunk)) return;
      if (chunk.final) void this.execute(chunk.streamId, existing);
      return;
    }
    const origin = this.loopbackOrigin();
    if (origin === null) {
      this.counters.refusedNoPreview += 1;
      return this.reply(chunk.streamId, 503, "No preview is running for this session. Ask the agent to start one with preview_start.");
    }
    if (this.streams.size >= this.limits.maxConcurrentStreams) {
      this.counters.refusedStreamCap += 1;
      return this.reply(chunk.streamId, 429, "Too many concurrent preview requests; retry shortly.");
    }
    const path = validatePreviewPath(chunk.path);
    if (!path.ok) {
      this.counters.rejectedPaths += 1;
      return this.reply(chunk.streamId, 400, `Preview path refused (${path.reason}).`);
    }
    const headers = chunk.headers as Record<string, string>;
    const rejected = validatePreviewHeaders("request", headers);
    if (rejected) {
      this.counters.rejectedHeaders += 1;
      return this.reply(chunk.streamId, 400, `Preview request header refused (${rejected.reason}).`);
    }
    this.counters.streams += 1;
    if (chunk.method === "GET" && headers["sec-websocket-version"] !== undefined) {
      this.openWebSocket(chunk.streamId, origin, path.path, headers);
      return;
    }
    const stream: HttpStream = { kind: "http", chunks: [], bytes: 0, method: chunk.method, path: path.path, headers, cancel: () => { stream.cancelled = true; }, cancelled: false, executing: false, lastActivityAt: this.now() };
    this.streams.set(chunk.streamId, stream);
    if (!this.appendBody(chunk.streamId, stream, chunk)) return;
    if (chunk.final) void this.execute(chunk.streamId, stream);
  }

  private appendBody(streamId: string, stream: HttpStream, chunk: RequestChunk): boolean {
    stream.lastActivityAt = this.now();
    if (chunk.body === undefined || chunk.body.length === 0) return true;
    const bytes = Buffer.from(chunk.body, "base64url");
    stream.bytes += bytes.byteLength;
    if (stream.bytes > this.limits.maxRequestBodyBytes) {
      this.counters.oversized += 1;
      this.streams.delete(streamId);
      this.reply(streamId, 413, "The request body exceeds the preview limit.");
      return false;
    }
    stream.chunks.push(bytes);
    return true;
  }

  private async execute(streamId: string, stream: HttpStream): Promise<void> {
    stream.executing = true;
    const origin = this.loopbackOrigin();
    if (origin === null) {
      this.streams.delete(streamId);
      this.counters.refusedNoPreview += 1;
      return this.reply(streamId, 503, "No preview is running for this session.");
    }
    const requestFn = this.options.requestFn ?? httpRequest;
    const body = stream.chunks.length > 0 ? Buffer.concat(stream.chunks) : undefined;
    stream.chunks = [];
    const url = new URL(stream.path, origin);
    const outgoing: Record<string, string> = { ...stream.headers, host: url.host };
    if (body) outgoing["content-length"] = String(body.byteLength);
    else if (stream.method !== "GET" && stream.method !== "HEAD") outgoing["content-length"] = "0";
    let response: IncomingMessage;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        if (stream.cancelled) return reject(new Error("cancelled"));
        const req = requestFn(url, { method: stream.method, headers: outgoing }, resolve);
        // Persistent: a teardown after the response arrived still emits here.
        req.on("error", reject);
        stream.cancel = () => { stream.cancelled = true; req.destroy(); };
        req.end(body);
      });
    } catch (error) {
      this.streams.delete(streamId);
      if (!stream.cancelled) {
        this.counters.upstreamFailures += 1;
        this.logger.warn({ event: "preview.forward.unreachable", code: (error as { code?: string }).code }, "loopback preview request failed");
        this.reply(streamId, 502, "The preview dev server did not answer.");
      }
      return;
    }
    response.on("error", () => undefined);
    const dialed = stream.cancel;
    stream.cancel = () => { dialed(); response.destroy(); };
    if (stream.cancelled) { response.destroy(); return; }
    const status = response.statusCode ?? 502;
    const headers = sanitizePreviewHeaders("response", response.headers as Record<string, string | string[] | undefined>);
    if (REDIRECT_STATUSES.has(status) && headers.location !== undefined) {
      const rewrite = rewritePreviewLocation(loopbackLocation(headers.location, origin), origin);
      if (rewrite.kind === "replace_with_502") {
        response.resume();
        this.streams.delete(streamId);
        return this.reply(streamId, 502, "The preview redirected somewhere other than itself.");
      }
      headers.location = rewrite.location;
    } else if (headers.location !== undefined && !REDIRECT_STATUSES.has(status)) {
      delete headers.location;
    }
    if (validatePreviewHeaders("response", headers)) {
      // sanitizePreviewHeaders only emits allowlisted, bounded headers; this is the belt.
      this.counters.rejectedHeaders += 1;
      for (const name of Object.keys(headers)) delete headers[name];
    }
    let sent = 0;
    let headSent = false;
    const emit = (piece: string | undefined, final: boolean): void => {
      this.options.send({ streamId, kind: "response", status, headers: (headSent ? {} : headers) as never, ...(piece === undefined ? {} : { body: piece }), final });
      headSent = true;
    };
    try {
      for await (const raw of response) {
        if (!this.streams.has(streamId)) { stream.cancel(); return; }
        const value = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        sent += value.byteLength;
        if (sent > this.limits.maxResponseBodyBytes) {
          this.counters.oversized += 1;
          stream.cancel();
          this.streams.delete(streamId);
          if (!headSent) return this.reply(streamId, 502, "The preview response exceeds the preview limit.");
          this.options.send({ streamId, kind: "close", code: 1009, final: true });
          return;
        }
        for (let offset = 0; offset < value.byteLength; offset += this.limits.maxChunkBytes) {
          if (this.options.waitForCapacity && !(await this.options.waitForCapacity())) {
            stream.cancel();
            this.streams.delete(streamId);
            return;
          }
          if (!this.streams.has(streamId)) { stream.cancel(); return; }
          emit(value.subarray(offset, Math.min(offset + this.limits.maxChunkBytes, value.byteLength)).toString("base64url"), false);
          stream.lastActivityAt = this.now();
        }
      }
      if (!this.streams.has(streamId)) return;
      emit(undefined, true);
    } catch (error) {
      if (!stream.cancelled) {
        this.counters.upstreamFailures += 1;
        this.logger.warn({ event: "preview.forward.stream_failed", code: (error as { code?: string }).code }, "loopback preview stream failed");
        if (!headSent) this.reply(streamId, 502, "The preview dev server stream failed.");
        else this.options.send({ streamId, kind: "close", code: 1011, final: true });
      }
    } finally {
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId);
    }
  }

  private openWebSocket(streamId: string, origin: string, path: string, headers: Record<string, string>): void {
    const protocols = headers["sec-websocket-protocol"]?.split(",").map(value => value.trim()).filter(value => value.length > 0);
    const target = `${origin.replace(/^http/, "ws")}${path}`;
    let socket: NodeWebSocket;
    try {
      socket = (this.options.createWebSocket ?? ((url, subprotocols) => new NodeWebSocket(url, subprotocols, { perMessageDeflate: false, followRedirects: false, maxPayload: this.limits.maxWsFrameBytes })))(target, protocols);
    } catch {
      this.counters.upstreamFailures += 1;
      return this.reply(streamId, 502, "The preview dev server refused the WebSocket.");
    }
    const stream: WsStream = { kind: "ws", socket, open: false, buffered: [], lastActivityAt: this.now() };
    this.streams.set(streamId, stream);
    socket.on("open", () => {
      if (this.streams.get(streamId) !== stream) return void socket.close(1000);
      stream.open = true;
      const responseHeaders: Record<string, string> = {};
      if (socket.protocol) responseHeaders["sec-websocket-protocol"] = socket.protocol;
      this.options.send({ streamId, kind: "response", status: 101, headers: sanitizePreviewHeaders("response", responseHeaders) as never, final: false });
      const buffered = stream.buffered;
      stream.buffered = [];
      for (const frame of buffered) this.onWsFrame(frame);
    });
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const payload = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (payload.byteLength > this.limits.maxWsFrameBytes) {
        this.counters.oversized += 1;
        this.drop(streamId, 1009, "frame too large");
        this.options.send({ streamId, kind: "close", code: 1009, final: true });
        return;
      }
      stream.lastActivityAt = this.now();
      this.options.send({ streamId, kind: "ws_frame", opcode: isBinary ? "binary" : "text", body: payload.toString("base64url"), final: true });
    });
    socket.on("ping", (data: Buffer) => {
      stream.lastActivityAt = this.now();
      if (data.byteLength <= this.limits.maxWsFrameBytes) this.options.send({ streamId, kind: "ws_frame", opcode: "ping", body: data.toString("base64url"), final: true });
    });
    socket.on("unexpected-response", (_request, response: IncomingMessage) => {
      response.resume();
      if (this.streams.get(streamId) !== stream) return;
      this.streams.delete(streamId);
      this.reply(streamId, 502, "The preview dev server did not upgrade the WebSocket.");
    });
    socket.on("close", (code: number) => {
      if (this.streams.get(streamId) !== stream) return;
      this.streams.delete(streamId);
      if (stream.open) this.options.send({ streamId, kind: "close", code: sendableCloseCode(code), final: true });
      else this.reply(streamId, 502, "The preview dev server closed the WebSocket.");
    });
    socket.on("error", (error: Error) => {
      this.logger.warn({ event: "preview.forward.ws_error", code: (error as { code?: string }).code }, "loopback preview websocket error");
    });
  }

  private onWsFrame(chunk: WsFrameChunk): void {
    const stream = this.streams.get(chunk.streamId);
    if (!stream || stream.kind !== "ws") return;
    if (!stream.open) {
      if (stream.buffered.length >= 64) {
        this.drop(chunk.streamId, 1008, "too many frames before open");
        this.options.send({ streamId: chunk.streamId, kind: "close", code: 1008, final: true });
        return;
      }
      stream.buffered.push(chunk);
      return;
    }
    const payload = Buffer.from(chunk.body, "base64url");
    if (payload.byteLength > this.limits.maxWsFrameBytes) {
      this.counters.oversized += 1;
      this.drop(chunk.streamId, 1009, "frame too large");
      this.options.send({ streamId: chunk.streamId, kind: "close", code: 1009, final: true });
      return;
    }
    stream.lastActivityAt = this.now();
    try {
      if (chunk.opcode === "ping") stream.socket.ping(payload);
      else if (chunk.opcode === "pong") stream.socket.pong(payload);
      else stream.socket.send(chunk.opcode === "binary" ? payload : payload.toString("utf8"));
    } catch {
      this.drop(chunk.streamId, 1011, "send failed");
    }
  }

  private drop(streamId: string, code: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (stream.kind === "http") stream.cancel();
    else {
      try { stream.socket.close(clientCloseCode(code), reason); } catch { stream.socket.terminate(); }
    }
  }

  private reply(streamId: string, status: number, message: string): void {
    this.options.send({ streamId, kind: "response", status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: Buffer.from(message).toString("base64url"), final: true });
  }

  /** Only a loopback origin the process manager handed out is ever dialed. */
  private loopbackOrigin(): string | null {
    if (this.disposed) return null;
    const origin = this.options.origin();
    if (origin === null) return null;
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.port === "" || url.pathname !== "/" || url.username || url.password) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.limits.idleStreamTimeoutMs;
    for (const [id, stream] of [...this.streams]) {
      if (stream.lastActivityAt >= cutoff) continue;
      this.counters.idleClosed += 1;
      this.drop(id, 1001, "idle");
      this.options.send({ streamId: id, kind: "close", code: 1001, final: true });
    }
  }
}

/**
 * Dev servers commonly redirect to `http://localhost:<port>/…` while the
 * forwarder dialed `127.0.0.1`. Any loopback spelling of the SAME port is the
 * preview's own origin; everything else stays absolute and becomes a 502.
 */
function loopbackLocation(location: string, origin: string): string {
  if (location.startsWith("/")) return location;
  try {
    const target = new URL(location);
    const own = new URL(origin);
    if ((target.protocol === "http:" || target.protocol === "ws:") && LOOPBACK_HOSTS.has(target.hostname) && target.port === own.port) {
      return `${own.origin}${target.pathname}${target.search}`;
    }
  } catch { /* not absolute; the policy decides */ }
  return location;
}

/** A close code the wire schema accepts (1000–4999) that also means something to a browser. */
function sendableCloseCode(code: number): number {
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

/** `ws` refuses to send reserved codes; map everything else onto 1000. */
function clientCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : code === 1001 || code === 1008 || code === 1009 || code === 1011 ? code : 1000;
}
