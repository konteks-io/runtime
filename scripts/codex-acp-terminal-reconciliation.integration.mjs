#!/usr/bin/env node

// Offline execution of the exact build-time patched Codex ACP handler. Pass
// the pinned upstream 1.10.0 dist/index.js; no provider or connector starts.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { patchCodexAcpLiveUsers } from "./codex-acp-live-user-patch.mjs";

const upstreamPath = process.argv[2];
if (!upstreamPath) {
  throw new Error("Pass the pinned codex-acp 1.10.0 dist/index.js path");
}
const upstream = await readFile(upstreamPath, "utf8");
const { source } = patchCodexAcpLiveUsers(upstream, "1.10.0");
const startupStart = 'if (process.argv.includes("--version")) {';
const startupEnd = "function startAcpServer() {";
assert.equal(source.split(startupStart).length, 2);
assert.equal(source.split(startupEnd).length, 2);
const first = source.indexOf(startupStart);
const last = source.indexOf(startupEnd, first);
const testModule = source.slice(0, first) + "export { CodexEventHandler };\n" + source.slice(last);
const directory = await mkdtemp(join(tmpdir(), "konteks-codex-acp-terminal-"));
try {
  const file = join(directory, "bridge.mjs");
  await writeFile(file, testModule);
  const { CodexEventHandler } = await import(pathToFileURL(file).href);
  const updates = [];
  const handler = Object.create(CodexEventHandler.prototype);
  handler.nativeUserMessageUpdates = () => [];
  handler.konteksOpenToolIdsByTurn = new Map();
  handler.konteksTerminalToolIds = new Set();
  handler.sessionState = {
    sessionId: "root-thread",
    asyncTasks: { handleNotification: async () => {} },
  };
  handler.subagents = {
    closingChildSessions: () => [],
    handle: async () => false,
    takeBufferedNotifications: () => [],
    shouldIgnore: () => false,
    notificationSessionId: () => "root-thread",
  };
  handler.flushPendingErrors = async () => {};
  handler.completeRetryIncidentOnTurnProgress = () => {};
  handler.session = { update: async (update) => updates.push(update) };
  const item = (id, status, result = null) => ({
    id,
    type: "mcpToolCall",
    status,
    server: "__platform__",
    tool: "platform__project-management__breakdown_get",
    arguments: {},
    result,
    error: null,
  });
  const send = (method, turnId, toolItem, threadId = "root-thread") =>
    handler.handleNotification({ method, params: { threadId, turnId, item: toolItem } });

  await send("item/started", "turn-a", item("first", "inProgress"));
  await send("item/started", "turn-a", item("second", "inProgress"));
  await send("item/completed", "turn-a", item("second", "completed", { content: [] }));
  handler.konteksOpenToolIdsByTurn.set("previous-turn", new Set(["first"]));
  await handler.reconcileMissingToolTerminals({
    id: "turn-a",
    items: [
      item("first", "completed", { structuredContent: { plan: "read" } }),
      item("second", "completed"),
    ],
  });
  assert.deepEqual(
    updates.map((update) => [update.sessionUpdate, update.toolCallId, update.status]),
    [
      ["tool_call", "first", "in_progress"],
      ["tool_call", "second", "in_progress"],
      ["tool_call_update", "second", "completed"],
      ["tool_call_update", "first", "completed"],
    ],
  );
  assert.deepEqual(updates.at(-1).rawOutput.result.structuredContent, { plan: "read" });
  await send("item/completed", "turn-a", item("first", "completed"));
  assert.equal(updates.length, 4, "late normal completion must not duplicate reconciliation");
  assert.deepEqual([...handler.konteksOpenToolIdsByTurn.get("previous-turn")], ["first"]);

  await send("item/started", "child-turn", item("child", "inProgress"), "child-thread");
  assert.equal(handler.konteksOpenToolIdsByTurn.has("child-turn"), false);
  await send("item/started", "turn-b", item("failed", "inProgress"));
  await send("item/started", "turn-b", item("active", "inProgress"));
  await handler.reconcileMissingToolTerminals({
    id: "turn-b",
    items: [item("failed", "failed"), item("active", "inProgress")],
  });
  assert.equal(updates.at(-1).status, "failed");
  assert.deepEqual([...handler.konteksOpenToolIdsByTurn.get("turn-b")], ["active"]);
  process.stdout.write(
    "Patched Codex ACP handler reconciles a missing terminal once and preserves failures.\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
