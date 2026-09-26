import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { connectCodexLocalTransport } from "../bridge/codex-local-transport.js";
import { readCodexAccount } from "../auth/codex-account.js";
import { RunnerConfigSchema } from "../config.js";
import { findAgentBridge } from "@konteks/remote-release";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "control:literal.sock");
  const server = createServer();
  const ws = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(socket); await once(server, "listening"); await chmod(socket, 0o600);
  cleanup.push(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { root, socket, server, ws };
}
it.skipIf(process.platform === "win32")("frames JSONL over a private Unix socket and leaves the shared server alive", async () => {
  const f = await fixture();
  let extensions: string | undefined;
  f.ws.on("connection", (socket, request) => {
    extensions = request.headers["sec-websocket-extensions"];
    socket.on("message", data => socket.send(data.toString()));
  });
  const stream = await connectCodexLocalTransport(f.socket);
  stream.on("error", () => undefined);
  const response = once(stream, "data");
  stream.write('{"id":1,"method":"thread/read",');
  stream.write('"params":{"threadId":"test"}}\n');
  expect((await response)[0].toString()).toBe('{"id":1,"method":"thread/read","params":{"threadId":"test"}}\n');
  expect(extensions).toBeUndefined();
  stream.destroy();
  expect(f.server.listening).toBe(true);
});
it.skipIf(process.platform === "win32")("rejects a socket directory accessible by another user", async () => {
  const f = await fixture(); await chmod(f.root, 0o755);
  await expect(connectCodexLocalTransport(f.socket)).rejects.toThrow(/private same-user/);
});
it.skipIf(process.platform === "win32")("rejects incomplete and malformed JSON without forwarding it", async () => {
  const f = await fixture();
  const stream = await connectCodexLocalTransport(f.socket);
  const error = once(stream, "error");
  stream.write('not-json\n');
  expect((await error)[0].message).toMatch(/malformed/);
  const next = await connectCodexLocalTransport(f.socket);
  const incomplete = once(next, "error");
  next.end('{"id":');
  expect((await incomplete)[0].message).toMatch(/incomplete/);
});
it.skipIf(process.platform === "win32")("reads the executing shared server account without spawning or stopping another server", async () => {
  const f = await fixture();
  const methods: string[] = [];
  f.ws.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString()); methods.push(message.method);
    if (message.id === 1) socket.send(JSON.stringify({ id: 1, result: { userAgent: "fixture" } }));
    if (message.id === 2) {
      expect(message.params).toEqual({ refreshToken: false });
      socket.send(JSON.stringify({ id: 2, result: { account: { type: "chatgpt", email: "local-owner@example.test" } } }));
    }
  }));
  const spawn = vi.fn(), stop = vi.fn();
  const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_NATIVE_CODEX_SOCKET: f.socket });
  expect(await readCodexAccount(config, findAgentBridge("codex")!, {}, { spawn, stop })).toBe("local-owner@example.test");
  expect(methods).toEqual(["initialize", "initialized", "account/read"]);
  expect(spawn).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(f.server.listening).toBe(true);
});
