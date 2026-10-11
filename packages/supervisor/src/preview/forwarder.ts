import { request as httpRequest, type IncomingMessage } from "node:http";
import { WebSocket as NodeWebSocket } from "ws";
import {
  PREVIEW_LIMITS,
  createLogger,
  previewAppSetCookies,
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
 * WebSocket relay, with the preview policy in place of an open passthrough).
 *
 * The forwarder never lets a viewer name a host: the origin comes only from
 * the process manager and must be a loopback address. It never follows a
 * redirect, validates what arrives (receiver mode) and sanitizes what it
 * emits (sender mode), and caps bodies, frames, streams and idle time.
 *
 * The app's own session passes (D46): Core sends its `cookie` (never a
 * Konteks cookie, which is refused here too) and `authorization`, and the
 * app's `set-cookie` goes back as `setCookie`, host-only and never naming a
 * Konteks cookie, to a Core that accepts it.
 */
export interface PreviewForwarderOptions {
  /** The running preview's loopback origin (`http://127.0.0.1:<port>`), or null when none runs. */
  origin: () => string | null;
  /** While none runs because the last start failed: the person's reason (what is wrong, what to do). */
  failure?: () => string | null;
  send: (chunk: PreviewToCoreChunk) => void;
  /**
   * Flow control: resolves true once the channel may take more response
   * bytes, false when the stream should give up (the channel closed).
   */
  waitForCapacity?: () => Promise<boolean>;
  /** Viewer traffic keeps the preview from being stopped as idle. */
  onActivity?: () => void;
  /**
   * Whether Core takes a response's `setCookie` (its contract is at least
   * `REMOTE_PREVIEW_APP_CREDENTIALS_MIN_CORE_CONTRACT_VERSION`). Absent or
   * false, the app's `set-cookie` is dropped: an older Core refuses the chunk.
   */
  forwardSetCookies?: () => boolean;
  createWebSocket?: (url: string, protocols: string[] | undefined, headers: Record<string, string>) => NodeWebSocket;
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

const DEFAULT_PREVIEW_FORWARDER_LIMITS: PreviewForwarderLimits = Object.freeze({
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
  /** When the first chunk of the request arrived, for the timing log. */
  receivedAt: number;
}

interface WsStream {
  kind: "ws";
  socket: NodeWebSocket;
  open: boolean;
  buffered: WsFrameChunk[];
  lastActivityAt: number;
}

interface PreviewForwarderCounters {
  streams: number;
  rejectedPaths: number;
  rejectedHeaders: number;
  refusedNoPreview: number;
  refusedStreamCap: number;
  oversized: number;
  idleClosed: number;
  upstreamFailures: number;
}

/**
 * How a viewer is told a preview failed to start, followed by the reason.
 * Konteks may recognise the phrase (a 503, plain text, no-store); unlike
 * "No preview is running" it means nothing will appear until something changes.
 */
export const COULD_NOT_START_PREFIX = "Preview could not start: ";

/** The plain 503 body for a session whose preview cannot be served: why it failed when it did, else that none runs. */
export function notRunningMessage(failure: string | null, fallback: string): string {
  return failure ? `${COULD_NOT_START_PREFIX}${failure}` : fallback;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** A request that spends this long on this computer is logged with its stages. */
const SLOW_REQUEST_MS = 250;

/** The dev server's response has fully arrived and nothing of it is left to read. */
function responseEnded(response: IncomingMessage): boolean {
  return response.complete && response.readableLength === 0;
}
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

  /** Whether a viewer stream is open (a continuation chunk belongs to it). */
  hasStream(streamId: string): boolean {
    return this.streams.has(streamId);
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
    if (existing) return this.continueRequest(chunk, existing);
    const admitted = this.admitRequest(chunk);
    if (!admitted) return;
    this.counters.streams += 1;
    if (chunk.method === "GET" && admitted.headers["sec-websocket-version"] !== undefined) {
      this.openWebSocket(chunk.streamId, admitted.origin, admitted.path, admitted.headers);
      return;
    }
    const stream: HttpStream = { kind: "http", chunks: [], bytes: 0, method: chunk.method, path: admitted.path, headers: admitted.headers, cancel: () => { stream.cancelled = true; }, cancelled: false, executing: false, lastActivityAt: this.now(), receivedAt: this.now() };
    this.streams.set(chunk.streamId, stream);
    this.receiveBody(chunk, stream);
  }

  /**
   * A continuation chunk of a request body; anything else on a live stream
   * id (a second request, a request on a WebSocket) is refused.
   */
  private continueRequest(chunk: RequestChunk, existing: HttpStream | WsStream): void {
    if (existing.kind !== "http" || existing.executing) {
      this.drop(chunk.streamId, 1002, "unexpected request chunk");
      return this.reply(chunk.streamId, 400, "unexpected request chunk on an open stream");
    }
    this.receiveBody(chunk, existing);
  }

  private receiveBody(chunk: RequestChunk, stream: HttpStream): void {
    if (!this.appendBody(chunk.streamId, stream, chunk)) return;
    if (chunk.final) void this.execute(chunk.streamId, stream);
  }

  /** A new request the forwarder may serve: a preview runs, a stream is free, and its path and headers pass; else it is answered here. */
  private admitRequest(chunk: RequestChunk): { origin: string; path: string; headers: Record<string, string> } | null {
    const origin = this.loopbackOrigin();
    if (origin === null) {
      this.counters.refusedNoPreview += 1;
      this.reply(chunk.streamId, 503, notRunningMessage(this.options.failure?.() ?? null, "No preview is running for this session. Ask the agent to start one with preview_start."));
      return null;
    }
    if (this.streams.size >= this.limits.maxConcurrentStreams) {
      this.counters.refusedStreamCap += 1;
      this.reply(chunk.streamId, 429, "Too many concurrent preview requests; retry shortly.");
      return null;
    }
    const path = validatePreviewPath(chunk.path);
    if (!path.ok) {
      this.counters.rejectedPaths += 1;
      this.reply(chunk.streamId, 400, `Preview path refused (${path.reason}).`);
      return null;
    }
    const headers = chunk.headers as Record<string, string>;
    const rejected = validatePreviewHeaders("request", headers);
    if (rejected) {
      this.counters.rejectedHeaders += 1;
      this.reply(chunk.streamId, 400, `Preview request header refused (${rejected.reason}).`);
      return null;
    }
    return { origin, path: path.path, headers };
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
      return this.reply(streamId, 503, notRunningMessage(this.options.failure?.() ?? null, "No preview is running for this session."));
    }
    const dialAt = this.now();
    const response = await this.dial(streamId, stream, origin);
    if (response === null) return;
    const headersAt = this.now();
    const status = response.statusCode ?? 502;
    const headers = this.responseHeaders(streamId, response, status, origin);
    if (headers === null) return;
    const sink = new ResponseSink(this.options.send, streamId, status, headers, this.appSetCookies(response));
    await this.relayBody(streamId, stream, response, sink);
    this.logTiming(streamId, stream, { dialAt, headersAt, status, frames: sink.frames });
  }

  /**
   * A request that took long on this computer, by stage: waiting for its
   * body, the dev server's answer (first byte), and sending the body back to
   * the relay. The stream id is the one Core and the relay log (D52).
   */
  private logTiming(streamId: string, stream: HttpStream, at: { dialAt: number; headersAt: number; status: number; frames: number }): void {
    const endedAt = this.now();
    if (endedAt - stream.receivedAt < SLOW_REQUEST_MS) return;
    this.logger.info({
      event: "preview.forward.slow",
      streamId,
      method: stream.method,
      status: at.status,
      frames: at.frames,
      requestMs: at.dialAt - stream.receivedAt,
      firstByteMs: at.headersAt - at.dialAt,
      bodyMs: endedAt - at.headersAt,
      totalMs: endedAt - stream.receivedAt,
    }, "a preview request was slow on this computer");
  }

  /** The app's own `set-cookie` values for a Core that takes them (D46); none otherwise. */
  private appSetCookies(response: IncomingMessage): string[] {
    return this.options.forwardSetCookies?.() === true ? previewAppSetCookies(response.headers["set-cookie"]) : [];
  }

  /** Sends the buffered request to the preview; null when it could not be sent or was cancelled meanwhile. */
  private async dial(streamId: string, stream: HttpStream, origin: string): Promise<IncomingMessage | null> {
    const requestFn = this.options.requestFn ?? httpRequest;
    const body = stream.chunks.length > 0 ? Buffer.concat(stream.chunks) : undefined;
    stream.chunks = [];
    const url = new URL(stream.path, origin);
    const outgoing = outgoingHeaders(stream, url, body);
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
      return null;
    }
    response.on("error", () => undefined);
    const dialed = stream.cancel;
    stream.cancel = () => { dialed(); response.destroy(); };
    if (stream.cancelled) { response.destroy(); return null; }
    return response;
  }

  /** The response headers the viewer may see; null (answered 502) when the preview redirects anywhere but itself. */
  private responseHeaders(streamId: string, response: IncomingMessage, status: number, origin: string): Record<string, string> | null {
    const headers = sanitizePreviewHeaders("response", response.headers as Record<string, string | string[] | undefined>);
    if (!rewriteLocation(headers, status, origin)) {
      response.resume();
      this.streams.delete(streamId);
      this.reply(streamId, 502, "The preview redirected somewhere other than itself.");
      return null;
    }
    if (validatePreviewHeaders("response", headers)) {
      // sanitizePreviewHeaders only emits allowlisted, bounded headers; this is the belt.
      this.counters.rejectedHeaders += 1;
      for (const name of Object.keys(headers)) delete headers[name];
    }
    return headers;
  }

  private async relayBody(streamId: string, stream: HttpStream, response: IncomingMessage, sink: ResponseSink): Promise<void> {
    try {
      if (await this.relayChunks(streamId, stream, response, sink) && !sink.finalSent) sink.emit(undefined, true);
    } catch (error) {
      if (!stream.cancelled) this.streamFailed(streamId, sink, error);
    } finally {
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId);
    }
  }

  /** Streams the body in bounded chunks; true when it ended with the stream still open. */
  private async relayChunks(streamId: string, stream: HttpStream, response: IncomingMessage, sink: ResponseSink): Promise<boolean> {
    let sent = 0;
    for await (const raw of response) {
      if (!this.streams.has(streamId)) { stream.cancel(); return false; }
      const value = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      sent += value.byteLength;
      if (sent > this.limits.maxResponseBodyBytes) {
        this.oversizedResponse(streamId, stream, sink);
        return false;
      }
      if (!await this.sendPieces(streamId, stream, value, sink, responseEnded(response))) return false;
    }
    return this.streams.has(streamId);
  }

  private oversizedResponse(streamId: string, stream: HttpStream, sink: ResponseSink): void {
    this.counters.oversized += 1;
    stream.cancel();
    this.streams.delete(streamId);
    if (!sink.headSent) return this.reply(streamId, 502, "The preview response exceeds the preview limit.");
    this.options.send({ streamId, kind: "close", code: 1009, final: true });
  }

  /**
   * Sends one body piece in bounded chunks. When the response has already
   * ended, the last chunk carries `final` itself: one frame fewer per
   * response, and every frame is a hop through the relay (D52).
   */
  private async sendPieces(streamId: string, stream: HttpStream, value: Buffer, sink: ResponseSink, ended: boolean): Promise<boolean> {
    for (let offset = 0; offset < value.byteLength; offset += this.limits.maxChunkBytes) {
      if (this.options.waitForCapacity && !(await this.options.waitForCapacity())) {
        stream.cancel();
        this.streams.delete(streamId);
        return false;
      }
      if (!this.streams.has(streamId)) { stream.cancel(); return false; }
      const end = Math.min(offset + this.limits.maxChunkBytes, value.byteLength);
      sink.emit(value.subarray(offset, end).toString("base64url"), ended && end === value.byteLength);
      stream.lastActivityAt = this.now();
    }
    return true;
  }

  private streamFailed(streamId: string, sink: ResponseSink, error: unknown): void {
    this.counters.upstreamFailures += 1;
    this.logger.warn({ event: "preview.forward.stream_failed", code: (error as { code?: string }).code }, "loopback preview stream failed");
    if (!sink.headSent) this.reply(streamId, 502, "The preview dev server stream failed.");
    else this.options.send({ streamId, kind: "close", code: 1011, final: true });
  }

  private openWebSocket(streamId: string, origin: string, path: string, headers: Record<string, string>): void {
    const protocols = headers["sec-websocket-protocol"]?.split(",").map(value => value.trim()).filter(value => value.length > 0);
    const target = `${origin.replace(/^http/, "ws")}${path}`;
    let socket: NodeWebSocket;
    try {
      socket = (this.options.createWebSocket ?? ((url, subprotocols, appHeaders) => new NodeWebSocket(url, subprotocols, { headers: appHeaders, perMessageDeflate: false, followRedirects: false, maxPayload: this.limits.maxWsFrameBytes })))(target, protocols, appCredentials(headers));
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
      if (payload.byteLength > this.limits.maxWsFrameBytes) return this.frameTooLarge(streamId);
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
    if (!stream.open) return this.bufferWsFrame(chunk, stream);
    const payload = Buffer.from(chunk.body, "base64url");
    if (payload.byteLength > this.limits.maxWsFrameBytes) return this.frameTooLarge(chunk.streamId);
    stream.lastActivityAt = this.now();
    try {
      sendToSocket(stream.socket, chunk.opcode, payload);
    } catch {
      this.drop(chunk.streamId, 1011, "send failed");
    }
  }

  private bufferWsFrame(chunk: WsFrameChunk, stream: WsStream): void {
    if (stream.buffered.length >= 64) {
      this.drop(chunk.streamId, 1008, "too many frames before open");
      this.options.send({ streamId: chunk.streamId, kind: "close", code: 1008, final: true });
      return;
    }
    stream.buffered.push(chunk);
  }

  private frameTooLarge(streamId: string): void {
    this.counters.oversized += 1;
    this.drop(streamId, 1009, "frame too large");
    this.options.send({ streamId, kind: "close", code: 1009, final: true });
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
    return origin === null ? null : loopbackOriginOf(origin);
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
  if (SENDABLE_CLOSE_CODES.has(code) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

const SENDABLE_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1001, 1002, 1003]);

/** A plain `http://<loopback>:<port>/` origin, else null. */
function loopbackOriginOf(origin: string): string | null {
  let url: URL;
  try { url = new URL(origin); } catch { return null; }
  return plainLoopbackUrl(url) ? url.origin : null;
}

function plainLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port !== "" && url.pathname === "/" && !url.username && !url.password;
}

/** The app's own `cookie` and `authorization`, for a WebSocket the app may authenticate. */
function appCredentials(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers.cookie !== undefined) out.cookie = headers.cookie;
  if (headers.authorization !== undefined) out.authorization = headers.authorization;
  return out;
}

function outgoingHeaders(stream: HttpStream, url: URL, body: Buffer | undefined): Record<string, string> {
  const outgoing: Record<string, string> = { ...stream.headers, host: url.host };
  if (body) outgoing["content-length"] = String(body.byteLength);
  else if (stream.method !== "GET" && stream.method !== "HEAD") outgoing["content-length"] = "0";
  return outgoing;
}

/**
 * A redirect keeps a `Location` only when it points at the preview itself
 * (rewritten for the viewer); any other response drops it. False when a
 * redirect leads elsewhere.
 */
function rewriteLocation(headers: Record<string, string>, status: number, origin: string): boolean {
  if (headers.location === undefined) return true;
  if (!REDIRECT_STATUSES.has(status)) {
    delete headers.location;
    return true;
  }
  const rewrite = rewritePreviewLocation(loopbackLocation(headers.location, origin), origin);
  if (rewrite.kind === "replace_with_502") return false;
  headers.location = rewrite.location;
  return true;
}

function sendToSocket(socket: NodeWebSocket, opcode: WsFrameChunk["opcode"], payload: Buffer): void {
  if (opcode === "ping") socket.ping(payload);
  else if (opcode === "pong") socket.pong(payload);
  else socket.send(opcode === "binary" ? payload : payload.toString("utf8"));
}

/** One HTTP response to the viewer: the status and headers go with the first piece only. */
class ResponseSink {
  headSent = false;
  finalSent = false;
  frames = 0;

  constructor(
    private readonly send: PreviewForwarderOptions["send"],
    private readonly streamId: string,
    private readonly status: number,
    private readonly headers: Record<string, string>,
    private readonly setCookie: string[] = [],
  ) {}

  emit(piece: string | undefined, final: boolean): void {
    const head = !this.headSent && this.setCookie.length > 0 ? { setCookie: this.setCookie } : {};
    this.send({ streamId: this.streamId, kind: "response", status: this.status, headers: (this.headSent ? {} : this.headers) as never, ...head, ...(piece === undefined ? {} : { body: piece }), final });
    this.headSent = true;
    this.finalSent = final;
    this.frames += 1;
  }
}

/** `ws` refuses to send reserved codes; map everything else onto 1000. */
function clientCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : code === 1001 || code === 1008 || code === 1009 || code === 1011 ? code : 1000;
}
