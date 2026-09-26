import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NO_PREVIEW_MESSAGE, PreviewBrowserGateway } from "../preview/browser-gateway.js";

const servers: Array<{ close(): unknown }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function upstream(body: string): Promise<string> {
  const server: Server = createServer((request, response) => response.end(`${body} ${request.url} host=${request.headers.host}`));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function viaProxy(proxyUrl: string, url: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: proxy.hostname, port: proxy.port, method: "GET", path: url, headers: { host: url.startsWith("/") ? proxy.host : new URL(url).host } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function tunnel(proxyUrl: string, authority: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) }, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\nping`));
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString();
      if (data.includes("pong") || data.includes("Refused")) { socket.end(); resolve(data); }
    });
    socket.on("error", reject);
  });
}

async function gateway(target: () => string | null) {
  let activity = 0;
  const gw = new PreviewBrowserGateway({ target, onActivity: () => { activity += 1; } });
  const proxyUrl = await gw.start();
  servers.push({ close: () => void gw.close() });
  return { gw, proxyUrl, activity: () => activity };
}

describe("the QA browser's gateway", () => {
  it("forwards only the session's preview origin, keeping its Host, and counts it as activity", async () => {
    const preview = await upstream("preview");
    const other = await upstream("other");
    const g = await gateway(() => preview);
    await expect(viaProxy(g.proxyUrl, `${preview}/items?a=1`)).resolves.toEqual({ status: 200, body: `preview /items?a=1 host=${new URL(preview).host}` });
    await expect(viaProxy(g.proxyUrl, `http://localhost:${new URL(preview).port}/`)).resolves.toMatchObject({ status: 200 });
    expect(g.activity()).toBe(2);
    const refused = await viaProxy(g.proxyUrl, `${other}/`);
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("This browser opens only this session");
    expect(refused.body).not.toContain("other /");
    expect((await viaProxy(g.proxyUrl, "http://example.com/")).status).toBe(403);
    expect((await viaProxy(g.proxyUrl, "/")).status).toBe(400);
  });

  it("follows the preview: none running says to call preview_start, a restart on a new port is reachable at once", async () => {
    let target: string | null = null;
    const g = await gateway(() => target);
    const first = await viaProxy(g.proxyUrl, "http://127.0.0.1:43100/");
    expect(first.status).toBe(404);
    expect(first.body).toContain(NO_PREVIEW_MESSAGE.slice(0, 40));
    expect(first.body).toContain("preview_start");
    target = await upstream("restarted");
    await expect(viaProxy(g.proxyUrl, `${target}/`)).resolves.toMatchObject({ status: 200, body: expect.stringContaining("restarted") });
  });

  it("tunnels CONNECT (WebSockets) only to the preview's own port", async () => {
    const echo = createTcpServer(socket => socket.on("data", () => socket.write("pong")));
    await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
    servers.push(echo);
    const authority = `127.0.0.1:${(echo.address() as AddressInfo).port}`;
    const g = await gateway(() => `http://${authority}`);
    await expect(tunnel(g.proxyUrl, authority)).resolves.toContain("200 Connection Established");
    await expect(tunnel(g.proxyUrl, "example.com:443")).resolves.toContain("403 Refused");
    expect(g.gw.counters.tunnels).toBe(1);
  });

  it("refuses everything once closed", async () => {
    const preview = await upstream("preview");
    const g = await gateway(() => preview);
    await g.gw.close();
    await expect(viaProxy(g.proxyUrl, `${preview}/`)).rejects.toThrow();
  });
});
