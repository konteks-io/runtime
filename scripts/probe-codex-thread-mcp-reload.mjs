#!/usr/bin/env node
// Disposable, turn-free protocol characterization. It never reads the user's
// Codex profile or starts model execution.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { connectCodexLocalTransport } from "../packages/agent-runner/dist/bridge/codex-local-transport.js";
import { codexLoadedThreadStatuses } from "../packages/agent-runner/src/bridge/codex-thread-inventory.ts";

if (process.argv[2] !== "--isolated-no-turn" || !isAbsolute(process.argv[3] ?? ""))
  throw new Error("Explicit isolated, turn-free probe flag and absolute pinned Codex executable required");
const codexExecutable = process.argv[3];
const root = await mkdtemp(join(tmpdir(), "codex-mcp-reload-"));
const socket = join(root, "app.sock");
const fixture = async name => {
  const methods = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    let message;
    try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    if (typeof message.method === "string") methods.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }
      : { tools: [] };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return { server, methods, url: `http://127.0.0.1:${address.port}/mcp` };
};
const a = await fixture("fixture-A");
const b = await fixture("fixture-B");
let child;
let connection;
const pending = new Map();
let nextId = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
  pending.set(id, { resolve, reject, timer, method });
  connection.write(JSON.stringify({ id, method, params }) + "\n");
});
const loadedSnapshot = async () => {
  const ids = [];
  let cursor;
  do {
    const page = await rpc("thread/loaded/list", { limit: 1, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data) || !page.data.every(id => typeof id === "string") ||
        !(page.nextCursor === null || typeof page.nextCursor === "string"))
      throw new Error(`Unknown loaded-list shape: ${Object.keys(page ?? {}).join(",")}`);
    ids.push(...page.data);
    cursor = page.nextCursor;
    if (ids.length > 100) throw new Error("Loaded-list pagination did not terminate");
  } while (cursor);
  return ids;
};
const threadStatus = result => {
  const status = result?.thread?.status;
  if (!status || !["notLoaded", "idle", "systemError", "active"].includes(status.type))
    throw new Error(`Unknown thread/read status: ${JSON.stringify(status)}`);
  if (status.type === "active" && !Array.isArray(status.activeFlags))
    throw new Error("Active thread/read status omitted activeFlags");
  return status;
};
const waitForFixture = async (fixture, stage) => {
  for (let i = 0; i < 50; i++) {
    if (fixture.methods.includes("initialize") && fixture.methods.includes("tools/list")) return;
    await delay(100);
  }
  throw new Error(`${stage} fixture did not initialize and list tools`);
};
try {
  child = spawn(codexExecutable, ["app-server", "--listen", `unix://${socket}`], {
    cwd: root, env: { ...process.env, CODEX_HOME: root }, stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Isolated app-server exited during startup");
    try {
      const info = await lstat(socket);
      if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error("Unexpected socket owner");
      await chmod(socket, 0o600);
      connection = await connectCodexLocalTransport(socket);
      break;
    } catch { connection?.destroy(); connection = undefined; await delay(100); }
  }
  if (!connection) throw new Error("Isolated app-server socket unavailable");
  const lines = createInterface({ input: connection });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      connection.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Probe rejects host actions" } }) + "\n");
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(`${waiting.method} RPC error ${message.error.code ?? "unknown"}: ${String(message.error.message ?? "").slice(0, 120)}`));
    else waiting.resolve(message.result);
  });
  await rpc("initialize", { clientInfo: { name: "konteks_mcp_reload_probe", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false } });
  connection.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const config = url => ({ mcp_servers: { probe: { url, http_headers: { authorization: "Bearer fixture-only" } } } });
  const started = await rpc("thread/start", { cwd: root, config: config(a.url), approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  await rpc("thread/name/set", { threadId, name: "Disposable MCP reload probe" });
  await waitForFixture(a, "A");
  const before = await rpc("thread/read", { threadId, includeTurns: false });
  const statusBefore = threadStatus(before);
  const second = await rpc("thread/start", { cwd: root, config: config(a.url), approvalPolicy: "never", sandbox: "read-only" });
  const loadedBeforeIds = await loadedSnapshot();
  const loadedBefore = loadedBeforeIds.includes(threadId) && loadedBeforeIds.includes(second.thread.id);
  if (!loadedBefore) throw new Error("Fresh thread was absent from loaded-list; probe setup is inconclusive");
  const productionStatuses = await codexLoadedThreadStatuses(socket);
  if (productionStatuses.get(threadId) !== "idle" || productionStatuses.get(second.thread.id) !== "idle")
    throw new Error("Production loaded-thread inventory did not report both idle fixtures");
  await rpc("thread/unsubscribe", { threadId });
  let loadedAfter = true;
  for (let i = 0; i < 20; i++) {
    loadedAfter = (await loadedSnapshot()).includes(threadId);
    if (!loadedAfter) break;
    await delay(100);
  }
  const statusAfterUnsubscribe = threadStatus(await rpc("thread/read", { threadId, includeTurns: false }));
  let resumed;
  let resumeResult = "ok";
  try { resumed = await rpc("thread/resume", { threadId, cwd: root, config: config(b.url) }); }
  catch (error) {
    if (String(error).includes("no rollout found")) resumeResult = "no_rollout_without_turn";
    else throw error;
  }
  if (resumed) await waitForFixture(b, "B");
  const after = resumed ? await rpc("thread/read", { threadId, includeTurns: false }) : undefined;
  const statusAfterResume = after ? threadStatus(after) : undefined;
  process.stdout.write(JSON.stringify({
    sameThread: resumed ? resumed.thread.id === threadId && after.thread.id === before.thread.id : null,
    sameHistory: resumed ? JSON.stringify(after.thread.turns ?? []) === JSON.stringify(before.thread.turns ?? []) : null,
    loadedBefore, loadedAfterUnsubscribe: loadedAfter,
    loadedBeforeIds, statusBefore, statusAfterUnsubscribe, statusAfterResume,
    productionStatuses: Object.fromEntries(productionStatuses),
    resumeResult,
    fixtureA: a.methods, fixtureB: b.methods,
  }) + "\n");
} finally {
  for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("Probe stopped")); }
  connection?.destroy();
  if (child && child.exitCode === null) {
    const stopped = new Promise(resolve => child.once("close", resolve));
    child.kill("SIGTERM");
    await Promise.race([stopped, delay(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all([a.server, b.server].map(server => new Promise(resolve => server.close(resolve))));
  await rm(root, { recursive: true, force: true });
}
