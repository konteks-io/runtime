import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnBridge, type BridgeProcess } from "../bridge/process.js";
import type { BridgeSpawnSpec } from "../bridge/spec.js";

const roots: string[] = [];
const bridges: BridgeProcess[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// A minimal ACP agent that, before answering `initialize`, calls the client
// methods Konteks never offers (OpenCode's ACP
// writes edited files back through `fs/write_text_file` when a client offers
// it) and records what it was answered.
const AGENT = `
const { writeFileSync } = require("node:fs");
const out = process.argv[2];
const answers = {};
let buffer = "", next = 100;
const pending = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const call = (method, params) => new Promise(resolve => { const id = next++; pending.set(id, resolve); send({ id, method, params }); });
process.stdin.on("data", async chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); continue; }
    if (message.method === "initialize") {
      answers.read = await call("fs/read_text_file", { sessionId: "s", path: "/etc/hosts" });
      answers.write = await call("fs/write_text_file", { sessionId: "s", path: "/tmp/konteks-never-written", content: "x" });
      answers.terminal = await call("terminal/create", { sessionId: "s", command: "id" });
      writeFileSync(out, JSON.stringify(answers));
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    }
  }
});
`;

// Every bridge answers the same way; Google Antigravity's included.
it.each(["opencode", "antigravity"])("answers %s's fs and terminal calls with method not found and never acts on them", async agentId => {
  const root = await mkdtemp(join(tmpdir(), "bridge-client-")); roots.push(root);
  const script = join(root, "agent.cjs");
  const out = join(root, "answers.json");
  await writeFile(script, AGENT);
  const bridge = await spawnBridge({
    spec: { family: { agentId }, command: process.execPath, args: [script, out], env: { PATH: process.env.PATH }, cwd: root } as unknown as BridgeSpawnSpec,
    initializeTimeoutMs: 10_000, clientVersion: "test",
    handlers: { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCreateElicitation: async () => ({ action: "cancel" }), onExit: () => undefined },
  });
  bridges.push(bridge);
  const answers = JSON.parse(await readFile(out, "utf8")) as Record<string, { error?: { code: number; message: string }; result?: unknown }>;
  for (const [method, answer] of [["fs/read_text_file", answers.read], ["fs/write_text_file", answers.write], ["terminal/create", answers.terminal]] as const) {
    expect(answer?.result).toBeUndefined();
    expect(answer?.error).toMatchObject({ code: -32601, message: expect.stringContaining(method) });
  }
  await expect(readFile("/tmp/konteks-never-written")).rejects.toThrow();
});
