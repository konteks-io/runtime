import { createInterface } from "node:readline";
import { z } from "zod";
import { connectCodexLocalTransport } from "./codex-local-transport.js";

const loadedPage = z.object({ data: z.array(z.string().uuid()), nextCursor: z.string().uuid().nullable() }).passthrough();
const threadRead = z.object({ thread: z.object({ id: z.string().uuid(), status: z.object({ type: z.enum(["notLoaded", "idle", "systemError", "active"]) }).passthrough() }).passthrough() }).passthrough();
const MAX_LOADED_THREADS = 4096;
const DEADLINE_MS = 15_000;

/** Read only from the verified private owner socket. Any missing evidence fails closed. */
export async function codexLoadedThreadStatuses(socketPath: string): Promise<Map<string, string>> {
  const stream = await connectCodexLocalTransport(socketPath);
  const lines = createInterface({ input: stream, terminal: false });
  let id = 0;
  let closed = false;
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  const fail = () => {
    closed = true;
    pending?.reject(new Error("Codex loaded-thread inventory unavailable"));
    pending = null;
  };
  lines.on("line", line => {
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    try { message = JSON.parse(line); } catch { fail(); return; }
    if (message.method && message.id !== undefined) {
      stream.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported inventory request" } })}\n`);
      return;
    }
    if (!pending || message.id !== pending.id) return;
    const current = pending;
    pending = null;
    if (message.error) current.reject(new Error("Codex loaded-thread inventory request failed"));
    else current.resolve(message.result);
  });
  stream.once("error", fail);
  stream.once("close", fail);
  lines.once("close", fail);
  const timeout = setTimeout(() => { fail(); stream.destroy(); }, DEADLINE_MS);
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed || stream.destroyed) { reject(new Error("Codex loaded-thread inventory unavailable")); return; }
    if (pending) { reject(new Error("Concurrent Codex inventory request")); return; }
    pending = { id: ++id, resolve, reject };
    stream.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) fail(); });
  });
  try {
    await request("initialize", { clientInfo: { name: "konteks_maintenance_inventory", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    stream.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return await threadStatuses(request, await loadedThreadIds(request));
  } finally {
    clearTimeout(timeout);
    lines.close();
    stream.destroy();
  }
}

type InventoryRequest = (method: string, params: unknown) => Promise<unknown>;

/** Every loaded thread, page by page; a repeated cursor or too many threads fails closed. */
async function loadedThreadIds(request: InventoryRequest): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = loadedPage.parse(await request("thread/loaded/list", { limit: 128, ...(cursor ? { cursor } : {}) }));
    for (const threadId of page.data) ids.add(threadId);
    if (ids.size > MAX_LOADED_THREADS || (page.nextCursor && seen.has(page.nextCursor))) throw new Error("Codex loaded-thread inventory exceeded its bound");
    cursor = page.nextCursor;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return ids;
}

async function threadStatuses(request: InventoryRequest, ids: Iterable<string>): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  for (const threadId of ids) {
    const result = threadRead.parse(await request("thread/read", { threadId, includeTurns: false }));
    if (result.thread.id !== threadId) throw new Error("Codex loaded-thread inventory identity changed");
    statuses.set(threadId, result.thread.status.type);
  }
  return statuses;
}

export async function assertCodexThreadsIdle(socketPath: string): Promise<void> {
  const statuses = await codexLoadedThreadStatuses(socketPath);
  for (const status of statuses.values()) if (status !== "idle") throw new Error("Codex has an active or unverified loaded thread");
}
