import { request as httpRequest, type IncomingMessage } from "node:http";
import { WebSocket as NodeWebSocket } from "ws";
import {
  PREVIEW_CAPS,
  applyPreviewRequestHeaderPolicy,
  applyPreviewResponseHeaderPolicy,
  createLogger,
  isPreviewMethod,
  isRedirectStatus,
  rewritePreviewLocation,
  validatePreviewPath,
  type Logger,
  type PreviewToCoreChunk,
  type PreviewToRuntimeChunk,
} from "@konteks/remote-common";

/**
 * Maps `PreviewToRuntimeChunk`s onto the FIXED loopback preview origin and
 * returns `PreviewToCoreChunk`s (adapted from bb `tunnel-client/session.ts`
 * stream mechanics: per-stream body accumulation, chunked responses, and WS
 * relay — with the D124/D125 policy in place of bb's open header passthrough).
 *
 * The forwarder never follows a redirect, never lets the viewer name a host,
 * enforces the header allowlists in receiver mode on what arrives and sender
 * mode on what it emits, and caps bodies, streams, and idle time.
 */
export interface ForwarderOptions {
  loopbackOrigin: () => string | null;
  enabled: () => boolean;
  send: (chunk: PreviewToCoreChunk) => void;
  createWebSocket?: (url: string, protocols: string[] | undefined) => NodeWebSocket;
  requestFn?: typeof httpRequest;
  logger?: Logger;
  now?: () => number;
}

interface HttpStream {
  kind: "http";
  chunks: Buffer[];
  bytes: number;
  method: Extract<PreviewToRuntimeChunk, { kind: "request" }>["method"];
  path: string;
  headers: Record<string, string>;
  abort: AbortController;
  lastActivityAt: number;
}

interface WsStream {
  kind: "ws";
  socket: NodeWebSocket;
  open: boolean;
  buffered: PreviewToRuntimeChunk[];
  lastActivityAt: number;
}

export class PreviewForwarder {
  private readonly streams = new Map<string, HttpStream | WsStream>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly options: ForwarderOptions) {
    this.logger = options.logger ?? createLogger({ name: "preview-forwarder" });
    this.now = options.now ?? Date.now;
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  start(): void {
    this.sweeper = setInterval(() => this.sweepIdle(), 10_000);
    this.sweeper.unref();
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const id of [...this.streams.keys()]) this.drop(id, 1001, "forwarder closed");
  }

  handle(chunk: PreviewToRuntimeChunk): void {
    if (!this.options.enabled() || this.options.loopbackOrigin() === null) {
      this.reply(chunk.streamId, 503, "preview is not enabled on this runtime");
      return;
    }
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

  private onRequest(chunk: Extract<PreviewToRuntimeChunk, { kind: "request" }>): void {
    const existing = this.streams.get(chunk.streamId);
    if (existing && existing.kind === "http") {
      this.appendBody(existing, chunk);
      if (chunk.final) void this.execute(chunk.streamId, existing);
      return;
    }
    if (this.streams.size >= PREVIEW_CAPS.maxConcurrentStreams) {
      this.reply(chunk.streamId, 429, "too many concurrent preview streams");
      return;
    }
    if (!isPreviewMethod(chunk.method)) {
      this.reply(chunk.streamId, 405, "method not allowed");
      return;
    }
    const path = validatePreviewPath(chunk.path);
    if (!path.ok) {
      this.reply(chunk.streamId, 400, path.reason);
      return;
    }
    const headers = applyPreviewRequestHeaderPolicy(chunk.headers, "receiver");
    if (!headers.ok) {
      this.reply(chunk.streamId, 400, headers.reason);
      return;
    }
    if ("sec-websocket-version" in headers.headers) {
      this.openWebSocket(chunk.streamId, path.path, headers.headers);
      return;
    }
    const stream: HttpStream = { kind: "http", chunks: [], bytes: 0, method: chunk.method, path: path.path, headers: headers.headers, abort: new AbortController(), lastActivityAt: this.now() };
    this.streams.set(chunk.streamId, stream);
    this.appendBody(stream, chunk);
    if (chunk.final) void this.execute(chunk.streamId, stream);
  }

  private appendBody(stream: HttpStream, chunk: Extract<PreviewToRuntimeChunk, { kind: "request" }>): void {
    stream.lastActivityAt = this.now();
    if (chunk.body === undefined) return;
    const bytes = Buffer.from(chunk.body, "base64url");
    stream.bytes += bytes.byteLength;
    if (stream.bytes > PREVIEW_CAPS.maxRequestBodyBytes) {
      this.streams.delete(stream === this.streams.get(streamIdOf(this.streams, stream)) ? streamIdOf(this.streams, stream) : "");
      this.reply(streamIdOf(this.streams, stream) || "", 413, "request body exceeds the preview cap");
      return;
    }
    stream.chunks.push(bytes);
  }

  private async execute(streamId: string, stream: HttpStream): Promise<void> {
    const origin = this.options.loopbackOrigin();
    if (origin === null) {
      this.streams.delete(streamId);
      this.reply(streamId, 503, "preview is not enabled");
      return;
    }
    const requestFn = this.options.requestFn ?? httpRequest;
    const body = stream.chunks.length > 0 ? Buffer.concat(stream.chunks) : undefined;
    const url = new URL(stream.path, origin);
    let response: IncomingMessage;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = requestFn(url, { method: stream.method, headers: { ...stream.headers, host: url.host, ...(body ? { "content-length": String(body.byteLength) } : {}) }, signal: stream.abort.signal }, resolve);
        req.once("error", reject);
        req.end(body);
      });
    } catch (error) {
      this.streams.delete(streamId);
      if (!stream.abort.signal.aborted) {
        this.logger.warn({ err: error }, "loopback preview request failed");
        this.reply(streamId, 502, "preview origin unreachable");
      }
      return;
    }
    const status = response.statusCode ?? 502;
    const sanitized = applyPreviewResponseHeaderPolicy(response.headers as Record<string, string | string[] | undefined>, "sender");
    const headers = sanitized.ok ? sanitized.headers : {};
    if (isRedirectStatus(status) && headers.location !== undefined) {
      const rewrite = rewritePreviewLocation(headers.location, origin);
      if (rewrite.kind === "replace_with_502") {
        response.resume();
        this.streams.delete(streamId);
        this.reply(streamId, 502, "redirect target is not the preview origin");
        return;
      }
      headers.location = rewrite.location;
    }
    let sent = 0;
    let headSent = false;
    const sendHead = (final: boolean, bodyChunk?: string): void => {
      this.options.send({ streamId, kind: "response", status, headers: headers as never, ...(bodyChunk === undefined ? {} : { body: bodyChunk }), final });
      headSent = true;
    };
    try {
      for await (const raw of response) {
        const value = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        sent += value.byteLength;
        if (sent > PREVIEW_CAPS.maxResponseBodyBytes) {
          stream.abort.abort();
          break;
        }
        for (let offset = 0; offset < value.byteLength; offset += PREVIEW_CAPS.maxChunkBytes) {
          const piece = value.subarray(offset, Math.min(offset + PREVIEW_CAPS.maxChunkBytes, value.byteLength)).toString("base64url");
          if (!headSent) sendHead(false, piece);
          else this.options.send({ streamId, kind: "response", status, headers: {}, body: piece, final: false });
        }
        stream.lastActivityAt = this.now();
      }
      if (!headSent) sendHead(true);
      else this.options.send({ streamId, kind: "response", status, headers: {}, final: true });
    } catch (error) {
      if (!stream.abort.signal.aborted) this.logger.warn({ err: error }, "loopback preview stream failed");
      if (!headSent) this.reply(streamId, 502, "preview origin stream failed");
      else this.options.send({ streamId, kind: "close", code: 1011, final: true });
    } finally {
      this.streams.delete(streamId);
    }
  }

  private openWebSocket(streamId: string, path: string, headers: Record<string, string>): void {
    const origin = this.options.loopbackOrigin();
    if (origin === null) {
      this.reply(streamId, 503, "preview is not enabled");
      return;
    }
    const wsOrigin = origin.replace(/^http/, "ws");
    const protocols = headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
    let socket: NodeWebSocket;
    try {
      socket = (this.options.createWebSocket ?? ((url, subprotocols) => new NodeWebSocket(url, subprotocols)))(`${wsOrigin}${path}`, protocols);
    } catch (error) {
      this.logger.warn({ err: error }, "loopback preview websocket failed to open");
      this.reply(streamId, 502, "preview origin websocket unavailable");
      return;
    }
    const stream: WsStream = { kind: "ws", socket, open: false, buffered: [], lastActivityAt: this.now() };
    this.streams.set(streamId, stream);
    socket.on("open", () => {
      stream.open = true;
      const responseHeaders: Record<string, string> = {};
      if (socket.protocol) responseHeaders["sec-websocket-protocol"] = socket.protocol;
      this.options.send({ streamId, kind: "response", status: 101, headers: responseHeaders as never, final: false });
      for (const buffered of stream.buffered) this.onWsFrame(buffered as Extract<PreviewToRuntimeChunk, { kind: "ws_frame" }>);
      stream.buffered = [];
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (payload.byteLength > PREVIEW_CAPS.maxWsFrameBytes) {
        this.drop(streamId, 1009, "frame too large");
        return;
      }
      stream.lastActivityAt = this.now();
      this.options.send({ streamId, kind: "ws_frame", opcode: isBinary ? "binary" : "text", body: payload.toString("base64url"), final: true });
    });
    socket.on("close", (code: number) => {
      if (this.streams.delete(streamId)) this.options.send({ streamId, kind: "close", code: code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, final: true });
    });
    socket.on("error", (error: Error) => {
      this.logger.warn({ err: error }, "loopback preview websocket error");
    });
  }

  private onWsFrame(chunk: Extract<PreviewToRuntimeChunk, { kind: "ws_frame" }>): void {
    const stream = this.streams.get(chunk.streamId);
    if (!stream || stream.kind !== "ws") return;
    if (!stream.open) {
      stream.buffered.push(chunk);
      return;
    }
    const payload = Buffer.from(chunk.body, "base64url");
    if (payload.byteLength > PREVIEW_CAPS.maxWsFrameBytes) {
      this.drop(chunk.streamId, 1009, "frame too large");
      return;
    }
    stream.lastActivityAt = this.now();
    if (chunk.opcode === "ping") stream.socket.ping(payload);
    else if (chunk.opcode === "pong") stream.socket.pong(payload);
    else stream.socket.send(chunk.opcode === "binary" ? payload : payload.toString("utf8"));
  }

  private drop(streamId: string, code: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (stream.kind === "http") stream.abort.abort();
    else stream.socket.close(code, reason);
  }

  private reply(streamId: string, status: number, message: string): void {
    this.options.send({ streamId, kind: "response", status, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from(message).toString("base64url"), final: true });
  }

  private sweepIdle(): void {
    const cutoff = this.now() - PREVIEW_CAPS.idleStreamTimeoutMs;
    for (const [id, stream] of this.streams) {
      if (stream.lastActivityAt < cutoff) {
        this.drop(id, 1001, "idle");
        this.options.send({ streamId: id, kind: "close", code: 1001, final: true });
      }
    }
  }
}

function streamIdOf(streams: Map<string, HttpStream | WsStream>, target: HttpStream | WsStream): string {
  for (const [id, stream] of streams) if (stream === target) return id;
  return "";
}
