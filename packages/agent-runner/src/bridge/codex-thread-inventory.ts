import { createInterface } from "node:readline";
import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";
import { connectCodexLocalTransport } from "./codex-local-transport.js";

const loadedPage = z.object({ data: z.array(z.string().uuid()), nextCursor: z.string().uuid().nullable() }).passthrough();
const threadStatus = z.object({ type: z.enum(["notLoaded", "idle", "systemError", "active"]), activeFlags: z.array(z.string()).optional() }).passthrough();
const threadRead = z.object({ thread: z.object({ id: z.string().uuid(), status: threadStatus, updatedAt: z.number().optional() }).passthrough() }).passthrough();
const threadTurns = z.object({ thread: z.object({ id: z.string().uuid(), turns: z.array(z.object({ id: z.string().min(1), status: z.string() }).passthrough()).optional() }).passthrough() }).passthrough();
const MAX_LOADED_THREADS = 4096;
const DEADLINE_MS = 15_000;

/** A loaded thread as the shared owner reports it; `updatedAt` is its last activity, in epoch seconds. */
export interface CodexLoadedThread { id: string; status: string; flags: string[]; updatedAt: number | null }

/** Read only from the verified private owner socket. Any missing evidence fails closed. */
export async function codexLoadedThreadStatuses(socketPath: string): Promise<Map<string, string>> {
  const threads = await withCodexInventory(socketPath, request => loadedThreads(request));
  return new Map(threads.map(thread => [thread.id, thread.status]));
}

async function withCodexInventory<T>(socketPath: string, use: (request: InventoryRequest) => Promise<T>): Promise<T> {
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
    return await use(request);
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

async function loadedThreads(request: InventoryRequest): Promise<CodexLoadedThread[]> {
  const threads: CodexLoadedThread[] = [];
  for (const threadId of await loadedThreadIds(request)) {
    const { thread } = threadRead.parse(await request("thread/read", { threadId, includeTurns: false }));
    if (thread.id !== threadId) throw new Error("Codex loaded-thread inventory identity changed");
    threads.push({ id: threadId, status: thread.status.type, flags: thread.status.activeFlags ?? [], updatedAt: thread.updatedAt ?? null });
  }
  return threads;
}

/**
 * Every loaded thread must be idle. A refusal names what is still loaded and
 * since when, as `active_work`: an update waits for it instead of failing.
 */
export async function assertCodexThreadsIdle(socketPath: string): Promise<void> {
  const busy = (await withCodexInventory(socketPath, request => loadedThreads(request))).filter(thread => thread.status !== "idle");
  if (busy.length > 0) throw new RemoteInstanceError("active_work", `Codex has an active or unverified loaded thread: ${busy.slice(0, 3).map(describeThread).join("; ")}`);
}

function describeThread(thread: CodexLoadedThread): string {
  const state = thread.flags.length > 0 ? `${thread.status} (${thread.flags.join(", ")})` : thread.status;
  const since = thread.updatedAt === null ? "" : ` since ${new Date(thread.updatedAt * 1_000).toISOString()}`;
  return `${thread.id} ${state}${since}`;
}

export interface OrphanedCodexTurn { threadId: string; turnId: string; flags: string[]; updatedAt: number | null }

/**
 * Interrupts in-progress turns that no Konteks session can own any more.
 * The shared app-server outlives its ACP clients, so a turn whose client was
 * retired without quiescence (10-14: a lease renewal lost to Core 503s) keeps
 * waiting on an approval nobody can answer, and blocked every update and stop.
 * Only turns waiting on a person are touched; the caller proves no Konteks
 * work runs (`unowned`, checked again before each interrupt), and
 * `staleAfterMs` spares a question that was only just asked.
 */
export async function interruptOrphanedCodexTurns(socketPath: string, options: {
  unowned: () => boolean; staleAfterMs?: number; now?: () => number;
}): Promise<OrphanedCodexTurn[]> {
  const now = options.now ?? Date.now;
  return withCodexInventory(socketPath, async request => {
    const interrupted: OrphanedCodexTurn[] = [];
    for (const thread of await loadedThreads(request)) {
      if (!waitingOnPerson(thread) || !stale(thread, options.staleAfterMs ?? 0, now())) continue;
      const turnId = await inProgressTurn(request, thread.id);
      if (turnId === null || !options.unowned()) continue;
      await request("turn/interrupt", { threadId: thread.id, turnId });
      interrupted.push({ threadId: thread.id, turnId, flags: thread.flags, updatedAt: thread.updatedAt });
    }
    return interrupted;
  });
}

/**
 * Only a turn waiting on a person can never end by itself: a running turn
 * finishes without its client, but an approval or question nobody can see
 * waits forever.
 */
const WAITING_ON_PERSON = new Set(["waitingOnApproval", "waitingOnUserInput"]);

function waitingOnPerson(thread: CodexLoadedThread): boolean {
  return thread.status === "active" && thread.flags.some(flag => WAITING_ON_PERSON.has(flag));
}

function stale(thread: CodexLoadedThread, staleAfterMs: number, nowMs: number): boolean {
  return staleAfterMs <= 0 || (thread.updatedAt !== null && nowMs - thread.updatedAt * 1_000 >= staleAfterMs);
}

async function inProgressTurn(request: InventoryRequest, threadId: string): Promise<string | null> {
  const { thread } = threadTurns.parse(await request("thread/read", { threadId, includeTurns: true }));
  if (thread.id !== threadId) throw new Error("Codex loaded-thread inventory identity changed");
  return [...(thread.turns ?? [])].reverse().find(turn => turn.status === "inProgress")?.id ?? null;
}
