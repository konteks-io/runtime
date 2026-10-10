import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { PreviewToCoreChunk, RelayChannel } from "@konteks/remote-common";
import { COULD_NOT_START_PREFIX, PreviewForwarder } from "../preview/forwarder.js";
import { PreviewChannel, STARTING_MESSAGE, sessionIdOf } from "../preview/preview-channel.js";
import type { OutboundMessage } from "../transport/transport.js";

let server: Server;
let origin = "";
let handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void = (_request, response) => response.end("ok");

beforeEach(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  handler = (_request, response) => response.end("ok");
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function forwarder(overrides: Partial<ConstructorParameters<typeof PreviewForwarder>[0]> = {}) {
  const sent: PreviewToCoreChunk[] = [];
  const instance = new PreviewForwarder({ origin: () => origin, send: chunk => void sent.push(chunk), ...overrides });
  return { instance, sent };
}

const final = (sent: PreviewToCoreChunk[], streamId: string) => vi.waitFor(() => {
  const last = sent.filter(chunk => chunk.streamId === streamId).at(-1);
  if (!last || !last.final) throw new Error("stream not finished");
  return last;
});

function responseOf(sent: PreviewToCoreChunk[], streamId: string) {
  const chunks = sent.filter((chunk): chunk is Extract<PreviewToCoreChunk, { kind: "response" }> => chunk.streamId === streamId && chunk.kind === "response");
  return {
    status: chunks[0]?.status,
    headers: chunks[0]?.headers as Record<string, string> | undefined,
    body: Buffer.concat(chunks.map(chunk => Buffer.from(chunk.body ?? "", "base64url"))).toString("utf8"),
    chunks: chunks.length,
  };
}

const b64 = (text: string) => Buffer.from(text).toString("base64url");

describe("preview forwarder (loopback only, preview policy on this hop)", () => {
  it("forwards a GET to the session's loopback port and returns the response in bounded chunks with only allowlisted headers", async () => {
    handler = (request, response) => {
      response.setHeader("set-cookie", "leak=1");
      response.setHeader("x-powered-by", "dev");
      response.setHeader("content-type", "text/html");
      response.end(`hello ${request.url} ${request.headers.host}`);
    };
    const { instance, sent } = forwarder({ limits: { maxChunkBytes: 4 } });
    instance.handle({ streamId: "s1", kind: "request", method: "GET", path: "/page?x=1", headers: { accept: "text/html" }, final: true });
    await final(sent, "s1");
    const response = responseOf(sent, "s1");
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "text/html", "content-length": String(Buffer.byteLength(response.body)) });
    expect(response.body).toBe(`hello /page?x=1 ${new URL(origin).host}`);
    expect(response.chunks).toBeGreaterThan(3);
    expect(sent.slice(1).every(chunk => chunk.kind !== "response" || Object.keys(chunk.headers).length === 0)).toBe(true);
    expect(instance.activeStreams).toBe(0);
  });

  it("sends a small response in one frame that carries final itself (D52)", async () => {
    handler = (_request, response) => response.end("{\"ok\":true}");
    const { instance, sent } = forwarder();
    instance.handle({ streamId: "one", kind: "request", method: "GET", path: "/api/session", headers: {}, final: true });
    const last = await final(sent, "one");
    expect(sent.filter(chunk => chunk.streamId === "one")).toHaveLength(1);
    expect(last).toMatchObject({ kind: "response", status: 200, final: true, body: b64("{\"ok\":true}") });
  });

  it("still ends a streamed response that is open when a piece arrives", async () => {
    let finish: (() => void) | undefined;
    handler = (_request, response) => {
      response.write("first");
      finish = () => response.end();
    };
    const { instance, sent } = forwarder();
    instance.handle({ streamId: "sse", kind: "request", method: "GET", path: "/events", headers: {}, final: true });
    await vi.waitFor(() => expect(sent.find(chunk => chunk.streamId === "sse")).toMatchObject({ final: false, body: b64("first") }));
    finish!();
    const last = await final(sent, "sse");
    expect(last).toMatchObject({ kind: "response", final: true });
    expect(responseOf(sent, "sse").body).toBe("first");
  });

  it("logs a slow request by stage with its stream id, never its path", async () => {
    let now = 1_000;
    handler = (_request, response) => { now += 400; response.end("late"); };
    const lines: Array<Record<string, unknown>> = [];
    const logger = { info: (fields: Record<string, unknown>) => void lines.push(fields), warn: () => undefined } as never;
    const { instance, sent } = forwarder({ now: () => now, logger });
    instance.handle({ streamId: "slow", kind: "request", method: "GET", path: "/api/contacts?id=7", headers: {}, final: true });
    await final(sent, "slow");
    await vi.waitFor(() => expect(lines.find(line => line.event === "preview.forward.slow")).toBeDefined());
    const line = lines.find(entry => entry.event === "preview.forward.slow")!;
    expect(line).toMatchObject({ streamId: "slow", method: "GET", status: 200, frames: 1, firstByteMs: 400, totalMs: 400 });
    expect(JSON.stringify(line)).not.toContain("contacts");
  });

  it("reassembles a request body sent across chunks, and refuses one over the cap with 413", async () => {
    handler = (request, response, body) => response.end(`${request.method} ${body.toString()}`);
    const { instance, sent } = forwarder({ limits: { maxRequestBodyBytes: 8 } });
    instance.handle({ streamId: "p", kind: "request", method: "POST", path: "/submit", headers: { "content-type": "text/plain" }, body: b64("abc"), final: false });
    instance.handle({ streamId: "p", kind: "request", method: "POST", path: "/submit", headers: {}, body: b64("def"), final: true });
    await final(sent, "p");
    expect(responseOf(sent, "p").body).toBe("POST abcdef");
    instance.handle({ streamId: "big", kind: "request", method: "POST", path: "/submit", headers: {}, body: b64("0123456789"), final: true });
    expect(responseOf(sent, "big").status).toBe(413);
  });

  it("answers 503 when no preview runs, and never dials an origin that is not loopback", () => {
    const none = forwarder({ origin: () => null });
    none.instance.handle({ streamId: "a", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(responseOf(none.sent, "a").status).toBe(503);
    expect(responseOf(none.sent, "a").body).toContain("No preview is running");
    const remote = forwarder({ origin: () => "http://10.0.0.5:3000" });
    remote.instance.handle({ streamId: "b", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(responseOf(remote.sent, "b").status).toBe(503);
    expect(remote.instance.counters.refusedNoPreview).toBe(1);
  });

  it("refuses a dot-segment path, a forbidden header and a Konteks cookie before dialing", () => {
    const requests = vi.fn();
    handler = (_request, response) => { requests(); response.end(); };
    const { instance, sent } = forwarder();
    instance.handle({ streamId: "dots", kind: "request", method: "GET", path: "/a/%2e%2e/secret", headers: {}, final: true });
    instance.handle({ streamId: "host", kind: "request", method: "GET", path: "/", headers: { host: "evil.example" } as never, final: true });
    instance.handle({ streamId: "konteks", kind: "request", method: "GET", path: "/", headers: { cookie: "sid=1; konteks_preview=t" }, final: true });
    expect(responseOf(sent, "dots").status).toBe(400);
    expect(responseOf(sent, "host").status).toBe(400);
    expect(responseOf(sent, "konteks").status).toBe(400);
    expect(responseOf(sent, "konteks").body).toContain("konteks_cookie");
    expect(instance.counters).toMatchObject({ rejectedPaths: 1, rejectedHeaders: 2 });
    expect(requests).not.toHaveBeenCalled();
  });

  it("hands the app its own cookie and Authorization, and returns its set-cookie host-only to a Core that takes it (D46)", async () => {
    handler = (request, response) => {
      response.setHeader("set-cookie", [
        "sid=new; Domain=127.0.0.1; Path=/; HttpOnly",
        "konteks_preview=forged; Path=/",
        "theme=dark; SameSite=Strict",
      ]);
      response.end(`${request.headers.cookie} | ${request.headers.authorization}`);
    };
    const { instance, sent } = forwarder({ forwardSetCookies: () => true });
    instance.handle({ streamId: "app", kind: "request", method: "GET", path: "/api/session", headers: { cookie: "sid=old; theme=light", authorization: "Bearer app" }, final: true });
    await final(sent, "app");
    expect(responseOf(sent, "app").body).toBe("sid=old; theme=light | Bearer app");
    const head = sent.find(chunk => chunk.streamId === "app" && chunk.kind === "response");
    expect(head).toMatchObject({ setCookie: ["sid=new; Path=/; HttpOnly; SameSite=Lax", "theme=dark; SameSite=Strict"] });
    expect(sent.filter(chunk => chunk.streamId === "app" && "setCookie" in chunk)).toHaveLength(1);
  });

  it("drops the app's set-cookie for a Core that would refuse it", async () => {
    handler = (_request, response) => {
      response.setHeader("set-cookie", "sid=new");
      response.end("ok");
    };
    for (const options of [{}, { forwardSetCookies: () => false }]) {
      const { instance, sent } = forwarder(options);
      instance.handle({ streamId: "old", kind: "request", method: "GET", path: "/", headers: {}, final: true });
      await final(sent, "old");
      expect(sent.some(chunk => "setCookie" in chunk)).toBe(false);
    }
  });

  it("rewrites a redirect to its own loopback origin to origin-form and turns any other absolute redirect into 502", async () => {
    const port = new URL(origin).port;
    handler = (request, response) => {
      response.statusCode = 302;
      response.setHeader("location", request.url === "/own" ? `http://localhost:${port}/next?a=1` : "https://evil.example/steal");
      response.end();
    };
    const { instance, sent } = forwarder();
    instance.handle({ streamId: "own", kind: "request", method: "GET", path: "/own", headers: {}, final: true });
    instance.handle({ streamId: "away", kind: "request", method: "GET", path: "/away", headers: {}, final: true });
    await final(sent, "own");
    await final(sent, "away");
    expect(responseOf(sent, "own")).toMatchObject({ status: 302, headers: { location: "/next?a=1" } });
    expect(responseOf(sent, "away").status).toBe(502);
  });

  it("caps concurrent streams, the response size, and closes idle streams", async () => {
    let release: (() => void) | undefined;
    handler = (request, response) => {
      if (request.url === "/hang") release = () => response.end("late");
      else response.end("x".repeat(64));
    };
    let now = 1_000;
    const { instance, sent } = forwarder({ limits: { maxConcurrentStreams: 1, maxResponseBodyBytes: 16, idleStreamTimeoutMs: 5_000 }, now: () => now });
    instance.handle({ streamId: "hang", kind: "request", method: "GET", path: "/hang", headers: {}, final: true });
    instance.handle({ streamId: "second", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(responseOf(sent, "second").status).toBe(429);
    await vi.waitFor(() => expect(release).toBeDefined());
    now += 6_000;
    (instance as unknown as { sweepIdle(): void }).sweepIdle();
    expect(sent.find(chunk => chunk.streamId === "hang")).toEqual({ streamId: "hang", kind: "close", code: 1001, final: true });
    expect(instance.counters.idleClosed).toBe(1);
    release!();
    instance.handle({ streamId: "large", kind: "request", method: "GET", path: "/large", headers: {}, final: true });
    const last = await final(sent, "large");
    expect(last.kind === "response" ? last.status : last).toBe(502);
    expect(instance.counters.oversized).toBe(1);
  });

  it("stops a response when the channel has no capacity left", async () => {
    handler = (_request, response) => response.end("x".repeat(64));
    const { instance, sent } = forwarder({ limits: { maxChunkBytes: 8 }, waitForCapacity: async () => false });
    instance.handle({ streamId: "w", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    await vi.waitFor(() => expect(instance.activeStreams).toBe(0));
    expect(sent.filter(chunk => chunk.streamId === "w")).toEqual([]);
  });

  it("relays a WebSocket: 101 on upgrade, frames both ways, and the viewer's close", async () => {
    const wss = new WebSocketServer({ server });
    const closed = vi.fn();
    wss.on("connection", socket => {
      socket.on("message", (data, isBinary) => socket.send(isBinary ? data : `echo:${data.toString()}`));
      socket.on("close", code => closed(code));
    });
    try {
      const { instance, sent } = forwarder();
      instance.handle({ streamId: "ws", kind: "request", method: "GET", path: "/hmr", headers: { "sec-websocket-version": "13", "sec-websocket-protocol": "vite-hmr" }, final: true });
      instance.handle({ streamId: "ws", kind: "ws_frame", opcode: "text", body: b64("early"), final: true } as never);
      await vi.waitFor(() => expect(sent.find(chunk => chunk.streamId === "ws" && chunk.kind === "response")).toMatchObject({ status: 101, final: false }));
      await vi.waitFor(() => expect(sent.some(chunk => chunk.kind === "ws_frame" && Buffer.from(chunk.body, "base64url").toString() === "echo:early")).toBe(true));
      instance.handle({ streamId: "ws", kind: "ws_frame", opcode: "text", body: b64("hi"), final: true });
      await vi.waitFor(() => expect(sent.some(chunk => chunk.kind === "ws_frame" && Buffer.from(chunk.body, "base64url").toString() === "echo:hi")).toBe(true));
      instance.handle({ streamId: "ws", kind: "close", code: 1000, final: true });
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(1000));
      expect(instance.activeStreams).toBe(0);
    } finally {
      wss.close();
    }
  });

  it("opens the app's WebSocket with its own cookie", async () => {
    const wss = new WebSocketServer({ server });
    const cookies: Array<string | undefined> = [];
    wss.on("connection", (_socket, request) => void cookies.push(request.headers.cookie));
    try {
      const { instance, sent } = forwarder();
      instance.handle({ streamId: "wsc", kind: "request", method: "GET", path: "/socket", headers: { "sec-websocket-version": "13", cookie: "sid=abc" }, final: true });
      await vi.waitFor(() => expect(sent.find(chunk => chunk.streamId === "wsc" && chunk.kind === "response")).toMatchObject({ status: 101 }));
      expect(cookies).toEqual(["sid=abc"]);
      instance.handle({ streamId: "wsc", kind: "close", code: 1000, final: true });
    } finally {
      wss.close();
    }
  });

  it("tells the viewer when the dev server closes its WebSocket", async () => {
    const wss = new WebSocketServer({ server });
    wss.on("connection", socket => setTimeout(() => socket.close(4001, "bye"), 10));
    try {
      const { instance, sent } = forwarder();
      instance.handle({ streamId: "ws2", kind: "request", method: "GET", path: "/", headers: { "sec-websocket-version": "13" }, final: true });
      await vi.waitFor(() => expect(sent.at(-1)).toEqual({ streamId: "ws2", kind: "close", code: 4001, final: true }));
    } finally {
      wss.close();
    }
  });
});

describe("preview channel on the supervisor", () => {
  function channel(options: { origin?: string | null; canOpen?: boolean; autoStart?: (sessionId: string) => Promise<boolean | { reason: string }>; failureFor?: (sessionId: string) => string | null } = {}) {
    const sent: OutboundMessage[] = [];
    const opened: Array<[string, RelayChannel]> = [];
    const closed: string[] = [];
    const touched: string[] = [];
    let canOpen = options.canOpen ?? true;
    const instance = new PreviewChannel({
      transport: { send: message => void sent.push(message), openChannel: (id, kind) => void opened.push([id, kind]), closeChannel: id => void closed.push(id) },
      lease: { canOpenChannel: () => canOpen },
      previews: {
        originFor: () => options.origin === undefined ? origin : options.origin,
        touch: id => void touched.push(id),
        ...(options.autoStart ? { autoStart: options.autoStart } : {}),
        ...(options.failureFor ? { failureFor: options.failureFor } : {}),
      },
    });
    return { instance, sent, opened, closed, touched, setCanOpen: (value: boolean) => { canOpen = value; } };
  }
  const bodies = (sent: OutboundMessage[]) => sent.map(message => message.body as PreviewToCoreChunk);

  it("answers a frame for a session with no running preview with a clean 503 on its stream", () => {
    const f = channel({ origin: null });
    f.instance.onToRuntime("preview:sess-1", { streamId: "s", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ channel: "preview", channelId: "preview:sess-1", body: { streamId: "s", kind: "response", status: 503, final: true } });
    expect(f.opened).toEqual([["preview:sess-1", "preview"]]);
    expect(f.touched).toEqual(["sess-1"]);
  });

  it("forwards to the running preview, counts viewer traffic as activity and closes streams when the preview stops", async () => {
    let release: (() => void) | undefined;
    handler = (_request, response) => { release = () => response.end("done"); };
    const f = channel();
    f.instance.onToRuntime("preview:sess-2", { streamId: "a", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(f.instance.hasViewer("sess-2")).toBe(true);
    expect(f.instance.activeStreams()).toBe(1);
    f.instance.previewStopped("sess-2");
    expect(bodies(f.sent)).toContainEqual({ streamId: "a", kind: "close", code: 1001, final: true });
    release!();
    f.instance.closeChannel("preview:sess-2");
    expect(f.closed).toEqual(["preview:sess-2"]);
    expect(f.instance.hasViewer("sess-2")).toBe(false);
    // A channel no viewer reached in this process still drops its counts.
    f.instance.closeChannel("preview:sess-9");
    expect(f.closed).toEqual(["preview:sess-2", "preview:sess-9"]);
  });

  it("refuses new preview traffic while the lease is draining and answers a malformed chunk on its stream", () => {
    const f = channel({ canOpen: false });
    f.instance.onToRuntime("preview:s", { streamId: "d", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(bodies(f.sent)[0]).toMatchObject({ streamId: "d", status: 503 });
    f.setCanOpen(true);
    f.instance.onToRuntime("preview:s", { streamId: "m", kind: "request", method: "TRACE", path: "/", headers: {}, final: true });
    expect(bodies(f.sent)[1]).toMatchObject({ streamId: "m", status: 400 });
    expect(f.instance.counters).toEqual({ malformed: 1, refusedDraining: 1, autoStarted: 0, couldNotStart: 0 });
  });

  it("starts the preview for a viewer's first request when nothing runs, and says it is starting", async () => {
    const autoStart = vi.fn(async () => true);
    const f = channel({ origin: null, autoStart });
    f.instance.onToRuntime("preview:sess-3", { streamId: "v", kind: "request", method: "GET", path: "/", headers: { accept: "text/html" }, final: true });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(autoStart).toHaveBeenCalledWith("sess-3");
    const reply = bodies(f.sent)[0] as Extract<PreviewToCoreChunk, { kind: "response" }>;
    expect(reply).toMatchObject({ streamId: "v", kind: "response", status: 503, final: true, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    expect(Buffer.from(reply.body ?? "", "base64url").toString()).toBe(STARTING_MESSAGE);
    expect(STARTING_MESSAGE.startsWith("Starting preview")).toBe(true);
    expect(f.instance.counters.autoStarted).toBe(1);
  });

  it("answers plainly when a viewer may not start it, and never auto-starts for a multi-part body", async () => {
    const autoStart = vi.fn(async () => false);
    const f = channel({ origin: null, autoStart });
    f.instance.onToRuntime("preview:sess-4", { streamId: "n", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const reply = bodies(f.sent)[0] as Extract<PreviewToCoreChunk, { kind: "response" }>;
    expect(reply.status).toBe(503);
    expect(Buffer.from(reply.body ?? "", "base64url").toString()).toMatch(/^No preview is running/);

    autoStart.mockClear();
    f.instance.onToRuntime("preview:sess-4", { streamId: "p", kind: "request", method: "POST", path: "/x", headers: {}, body: b64("part"), final: false });
    expect(autoStart).not.toHaveBeenCalled();
  });

  it("says why a preview could not start instead of \"nothing yet\", for a viewer's page and a multi-part body alike", async () => {
    const reason = "This change has nothing a browser can open (no serve command). Ask the agent to make it runnable.";
    const autoStart = vi.fn(async () => ({ reason }));
    const f = channel({ origin: null, autoStart, failureFor: () => reason });
    f.instance.onToRuntime("preview:sess-5", { streamId: "f", kind: "request", method: "GET", path: "/", headers: { accept: "text/html" }, final: true });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const reply = bodies(f.sent)[0] as Extract<PreviewToCoreChunk, { kind: "response" }>;
    expect(reply).toMatchObject({ streamId: "f", status: 503, final: true, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    expect(Buffer.from(reply.body ?? "", "base64url").toString()).toBe(`Preview could not start: ${reason}`);
    expect(COULD_NOT_START_PREFIX).toBe("Preview could not start: ");
    expect(f.instance.counters).toMatchObject({ autoStarted: 0, couldNotStart: 1 });

    // A body in several parts never auto-starts; the forwarder gives the same reason.
    f.instance.onToRuntime("preview:sess-5", { streamId: "g", kind: "request", method: "POST", path: "/x", headers: {}, body: b64("part"), final: false });
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    const plain = bodies(f.sent)[1] as Extract<PreviewToCoreChunk, { kind: "response" }>;
    expect(plain.status).toBe(503);
    expect(Buffer.from(plain.body ?? "", "base64url").toString()).toBe(`Preview could not start: ${reason}`);
    expect(autoStart).toHaveBeenCalledTimes(1);
  });

  it("reads the session id only from a well-formed preview channel id", () => {
    expect(sessionIdOf("preview:abc-1")).toBe("abc-1");
    expect(sessionIdOf("session:abc")).toBeNull();
    expect(sessionIdOf("preview:")).toBeNull();
  });
});
