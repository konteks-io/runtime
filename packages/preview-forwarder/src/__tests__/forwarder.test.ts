import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewToCoreChunk } from "@konteks/remote-common";
import { PreviewForwarder } from "../forwarder.js";

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

async function startOrigin(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function collect(): { chunks: PreviewToCoreChunk[]; send: (chunk: PreviewToCoreChunk) => void; done: (predicate: (chunks: PreviewToCoreChunk[]) => boolean) => Promise<PreviewToCoreChunk[]> } {
  const chunks: PreviewToCoreChunk[] = [];
  const waiters: Array<{ predicate: (chunks: PreviewToCoreChunk[]) => boolean; resolve: (chunks: PreviewToCoreChunk[]) => void }> = [];
  return {
    chunks,
    send: (chunk) => {
      chunks.push(chunk);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(chunks)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(chunks);
        }
      }
    },
    done: (predicate) => new Promise((resolve) => (predicate(chunks) ? resolve(chunks) : waiters.push({ predicate, resolve }))),
  };
}

const finalResponse = (chunks: PreviewToCoreChunk[]): boolean => chunks.some((chunk) => chunk.kind === "response" && chunk.final);

describe("preview forwarder (D124/D125)", () => {
  it("forwards a request to the fixed loopback origin with allowlisted headers and returns a sanitized response", async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    const port = await startOrigin((request, response) => {
      seenHeaders = request.headers;
      response.setHeader("content-type", "text/html");
      response.setHeader("set-cookie", "session=leak");
      response.setHeader("x-powered-by", "leak");
      response.end("<h1>preview</h1>");
    });
    const out = collect();
    const forwarder = new PreviewForwarder({ loopbackOrigin: () => `http://127.0.0.1:${port}`, enabled: () => true, send: out.send });
    forwarder.handle({ streamId: "s1", kind: "request", method: "GET", path: "/index.html?x=1", headers: { accept: "text/html" }, final: true });
    const chunks = await out.done(finalResponse);
    expect(seenHeaders.accept).toBe("text/html");
    expect(seenHeaders.cookie).toBeUndefined();
    const first = chunks[0];
    expect(first).toMatchObject({ streamId: "s1", kind: "response", status: 200, headers: { "content-type": "text/html" } });
    expect(JSON.stringify(chunks)).not.toMatch(/set-cookie|x-powered-by/);
    const body = chunks.filter((chunk) => chunk.kind === "response").map((chunk) => (chunk.kind === "response" && chunk.body ? Buffer.from(chunk.body, "base64url").toString() : "")).join("");
    expect(body).toBe("<h1>preview</h1>");
    expect(forwarder.activeStreams).toBe(0);
  });

  it("never follows a redirect: rewrites a same-origin location and replaces a foreign one with 502", async () => {
    const port = await startOrigin((request, response) => {
      response.statusCode = 302;
      response.setHeader("location", request.url === "/same" ? `http://127.0.0.1:${port}/next` : "https://accounts.example/login");
      response.end();
    });
    const out = collect();
    const forwarder = new PreviewForwarder({ loopbackOrigin: () => `http://127.0.0.1:${port}`, enabled: () => true, send: out.send });
    forwarder.handle({ streamId: "same", kind: "request", method: "GET", path: "/same", headers: {}, final: true });
    forwarder.handle({ streamId: "foreign", kind: "request", method: "GET", path: "/foreign", headers: {}, final: true });
    const chunks = await out.done((all) => all.filter((chunk) => chunk.kind === "response" && chunk.final).length === 2);
    const same = chunks.find((chunk) => chunk.streamId === "same");
    const foreign = chunks.find((chunk) => chunk.streamId === "foreign");
    expect(same).toMatchObject({ kind: "response", status: 302, headers: { location: "/next" } });
    expect(foreign).toMatchObject({ kind: "response", status: 502 });
  });

  it("rejects a forbidden header, an absolute-form path, and a disallowed method locally", async () => {
    const out = collect();
    const forwarder = new PreviewForwarder({ loopbackOrigin: () => "http://127.0.0.1:1", enabled: () => true, send: out.send });
    forwarder.handle({ streamId: "h", kind: "request", method: "GET", path: "/", headers: { cookie: "a=b" } as never, final: true });
    forwarder.handle({ streamId: "p", kind: "request", method: "GET", path: "http://evil/", headers: {}, final: true });
    forwarder.handle({ streamId: "m", kind: "request", method: "CONNECT" as never, path: "/", headers: {}, final: true });
    expect(out.chunks.map((chunk) => (chunk.kind === "response" ? [chunk.streamId, chunk.status] : null))).toEqual([["h", 400], ["p", 400], ["m", 405]]);
  });

  it("answers 503 while preview is disabled or has no grant-backed port", () => {
    const out = collect();
    const forwarder = new PreviewForwarder({ loopbackOrigin: () => null, enabled: () => false, send: out.send });
    forwarder.handle({ streamId: "x", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(out.chunks[0]).toMatchObject({ kind: "response", status: 503 });
  });
});
