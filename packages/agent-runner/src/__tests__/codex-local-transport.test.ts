import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { connectCodexLocalTransport } from "../bridge/codex-local-transport.js";
import { assertCodexThreadsIdle, codexLoadedThreadStatuses, interruptOrphanedCodexTurns } from "../bridge/codex-thread-inventory.js";
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
it.skipIf(process.platform === "win32")("reads every loaded Codex page and its runtime statuses through the private transport", async () => {
  const f = await fixture();
  const first = "00000000-0000-7000-8000-000000000001", second = "00000000-0000-7000-8000-000000000002";
  const calls: string[] = [];
  f.ws.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    calls.push(message.method);
    if (message.method === "initialize") expect(message.params.capabilities.experimentalApi).toBe(true);
    const result = message.method === "thread/loaded/list"
      ? message.params.cursor ? { data: [second], nextCursor: null } : { data: [first], nextCursor: first }
      : message.method === "thread/read" ? { thread: { id: message.params.threadId, status: { type: message.params.threadId === first ? "idle" : "active", activeFlags: [] } } } : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  expect(Object.fromEntries(await codexLoadedThreadStatuses(f.socket))).toEqual({ [first]: "idle", [second]: "active" });
  expect(calls).toEqual(["initialize", "thread/loaded/list", "thread/loaded/list", "thread/read", "thread/read"]);
});
it.skipIf(process.platform === "win32")("rejects a disconnect between loaded-list pages without hanging", async () => {
  const f = await fixture();
  const first = "00000000-0000-7000-8000-000000000001";
  f.ws.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "thread/loaded/list") {
      if (!message.params.cursor) socket.send(JSON.stringify({ id: message.id, result: { data: [first], nextCursor: first } }));
      else socket.close();
    }
  }));
  await expect(codexLoadedThreadStatuses(f.socket)).rejects.toThrow(/inventory unavailable/);
});

/** 10-15, taufan-mac: a turn left waiting on an approval after its session ended blocked every update. */
function orphanServer(f: Awaited<ReturnType<typeof fixture>>, threads: Record<string, { status: { type: string; activeFlags?: string[] }; updatedAt: number; turn?: string }>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  f.ws.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    calls.push({ method: message.method, params: message.params });
    const thread = threads[message.params?.threadId];
    const result = message.method === "thread/loaded/list" ? { data: Object.keys(threads), nextCursor: null }
      : message.method === "thread/read" ? { thread: { id: message.params.threadId, status: thread!.status, updatedAt: thread!.updatedAt,
        ...(message.params.includeTurns ? { turns: [{ id: "turn-old", status: "completed" }, ...(thread!.turn ? [{ id: thread!.turn, status: "inProgress" }] : [])] } : {}) } }
      : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  return calls;
}
const ids = { idle: "00000000-0000-7000-8000-00000000000a", orphan: "00000000-0000-7000-8000-00000000000b", running: "00000000-0000-7000-8000-00000000000c", fresh: "00000000-0000-7000-8000-00000000000d" };
const NOW = Date.parse("2026-10-15T08:40:00Z");
const threads = {
  [ids.idle]: { status: { type: "idle" }, updatedAt: NOW / 1000 - 3600 },
  [ids.orphan]: { status: { type: "active", activeFlags: ["waitingOnApproval"] }, updatedAt: Date.parse("2026-10-14T17:02:14Z") / 1000, turn: "turn-orphan" },
  [ids.running]: { status: { type: "active", activeFlags: [] }, updatedAt: NOW / 1000 - 3600, turn: "turn-running" },
  [ids.fresh]: { status: { type: "active", activeFlags: ["waitingOnUserInput"] }, updatedAt: NOW / 1000 - 30, turn: "turn-fresh" },
};
it.skipIf(process.platform === "win32")("refuses maintenance as active work, naming what still waits and since when", async () => {
  const f = await fixture();
  orphanServer(f, { [ids.idle]: threads[ids.idle]!, [ids.orphan]: threads[ids.orphan]! });
  await expect(assertCodexThreadsIdle(f.socket)).rejects.toMatchObject({
    code: "active_work", message: `Codex has an active or unverified loaded thread: ${ids.orphan} active (waitingOnApproval) since 2026-10-14T17:02:14.000Z`,
  });
});
it.skipIf(process.platform === "win32")("interrupts only stale turns waiting on a person, while nothing owns them", async () => {
  const f = await fixture();
  const calls = orphanServer(f, threads);
  const interrupted = await interruptOrphanedCodexTurns(f.socket, { unowned: () => true, staleAfterMs: 15 * 60_000, now: () => NOW });
  expect(interrupted).toEqual([{ threadId: ids.orphan, turnId: "turn-orphan", flags: ["waitingOnApproval"], updatedAt: threads[ids.orphan]!.updatedAt }]);
  // A running turn ends by itself; a question asked 30 s ago may still be answered.
  expect(calls.filter(call => call.method === "turn/interrupt").map(call => call.params)).toEqual([{ threadId: ids.orphan, turnId: "turn-orphan" }]);
});
it.skipIf(process.platform === "win32")("interrupts nothing once Konteks work owns the computer again", async () => {
  const f = await fixture();
  const calls = orphanServer(f, threads);
  expect(await interruptOrphanedCodexTurns(f.socket, { unowned: () => false, now: () => NOW })).toEqual([]);
  expect(calls.some(call => call.method === "turn/interrupt")).toBe(false);
});

/** Codex 0.159+ binds in its own private directory and links the path it was given. */
async function linked(daemonMode = 0o700) {
  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), "codex-link-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await chmod(home, daemonMode);
  const link = join(home, "s");
  await symlink(f.socket, link);
  return { ...f, link };
}
it.skipIf(process.platform === "win32")("connects through the link a newer Codex leaves at its socket path", async () => {
  const f = await linked();
  f.ws.on("connection", socket => socket.on("message", data => socket.send(data.toString())));
  const stream = await connectCodexLocalTransport(f.link);
  stream.on("error", () => undefined);
  const response = once(stream, "data");
  stream.write('{"id":1,"method":"thread/read","params":{"threadId":"test"}}\n');
  expect((await response)[0].toString()).toBe('{"id":1,"method":"thread/read","params":{"threadId":"test"}}\n');
  stream.destroy();
});
it.skipIf(process.platform === "win32")("refuses a link whose socket lives where another user can reach it", async () => {
  const f = await linked();
  await chmod(f.root, 0o755);
  await expect(connectCodexLocalTransport(f.link)).rejects.toThrow(/private same-user/);
});
