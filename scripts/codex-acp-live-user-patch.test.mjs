import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  codexAcpLiveUserPatch,
  konteksTitlePrefixCheck,
  missingCodexToolTerminals,
  reconcileCodexToolTerminals,
  patchCodexAcpMcpServerResumeFilter,
  patchCodexAcpLiveUsers,
} from "./codex-acp-live-user-patch.mjs";

test("live-user compatibility change rejects an unreviewed upstream version", () => {
  assert.equal(codexAcpLiveUserPatch.id, "konteks-codex-acp-live-user-v7");
  assert.throws(() => patchCodexAcpLiveUsers("untrusted", "1.10.1"), /requires review/);
});

test("resume refreshes only existing generated Konteks MCP names and keeps unrelated names deduplicated", () => {
  const upstream = "let serversToConfigure = requestedServers;\nserversToConfigure = requestedServers.filter((mcp) => !existingNames.has(mcp.name));";
  const patched = patchCodexAcpMcpServerResumeFilter(upstream);
  const selected = runInNewContext(`${patched}\nserversToConfigure`, {
    requestedServers: [
      { name: "konteks-0123456789abcdef" },
      { name: "konteks-0123456789abcde" },
      { name: "konteks-0123456789abcdef0" },
      { name: "konteks-0123456789abcdeF" },
      { name: "other-0123456789abcdef" },
      { name: "user-server" },
      { name: "new-user-server" },
    ],
    existingNames: new Set([
      "konteks-0123456789abcdef",
      "konteks-0123456789abcde",
      "konteks-0123456789abcdef0",
      "konteks-0123456789abcdeF",
      "other-0123456789abcdef",
      "user-server",
    ]),
  });
  assert.deepEqual(selected.map(({ name }) => name), ["konteks-0123456789abcdef", "new-user-server"]);
});

test("MCP resume filter transformer fails closed when its anchor is absent or ambiguous", () => {
  const anchor = "serversToConfigure = requestedServers.filter((mcp) => !existingNames.has(mcp.name));";
  assert.throws(() => patchCodexAcpMcpServerResumeFilter("serversToConfigure = requestedServers;"), /anchor is not unique/);
  assert.throws(() => patchCodexAcpMcpServerResumeFilter(`${anchor}\n${anchor}`), /anchor is not unique/);
});

test("version equality does not allow modified or incomplete upstream bytes", () => {
  assert.throws(() => patchCodexAcpLiveUsers("", codexAcpLiveUserPatch.version), /requires review/);
  assert.throws(
    () => patchCodexAcpLiveUsers("// locally modified artifact", codexAcpLiveUserPatch.version),
    /requires review/,
  );
});

test("the injected title check accepts both Konteks title forms and nothing else", () => {
  const check = new Function(`return ${konteksTitlePrefixCheck}`)();
  assert.equal(check.test("[konteks] Coding session 3fa9c1d2"), true);
  assert.equal(
    check.test("[konteks/Todo List/initiative] [v3] Stand up the todo list API 3fa9c1d2"),
    true,
  );
  assert.equal(check.test("[konteksx] Other"), false);
  assert.equal(check.test("Fix filters"), false);
});

test("reconciles a completed first MCP read omitted from the notification stream", () => {
  const turn = {
    items: [
      { id: "read-first", type: "mcpToolCall", status: "completed" },
      { id: "read-second", type: "mcpToolCall", status: "completed" },
      { id: "reply", type: "mcpToolCall", status: "completed" },
    ],
  };
  assert.deepEqual(
    missingCodexToolTerminals(turn, new Set(["read-first"])).map((item) => item.id),
    ["read-first"],
  );
});

test("preserves a genuine failed MCP result and never resolves an in-progress call", () => {
  const turn = {
    items: [
      { id: "failed", type: "mcpToolCall", status: "failed" },
      { id: "active", type: "mcpToolCall", status: "inProgress" },
      { id: "message", type: "agentMessage", status: "completed" },
    ],
  };
  assert.deepEqual(
    missingCodexToolTerminals(turn, new Set(["failed", "active"])).map((item) => [
      item.id,
      item.status,
    ]),
    [["failed", "failed"]],
  );
});

test("reconciles only the current turn's missing terminal event once", async () => {
  const first = {
    id: "read-first",
    type: "mcpToolCall",
    status: "completed",
    result: { marker: "read-result" },
  };
  const reply = { id: "reply", type: "mcpToolCall", status: "completed" };
  const openByTurn = new Map([
    ["previous-turn", new Set(["read-first"])],
    ["current-turn", new Set(["read-first"])],
  ]);
  const emitted = [];
  const emit = async (item, turnId) => {
    emitted.push([turnId, item.id, item.status, item.result?.marker]);
    openByTurn.get(turnId).delete(item.id);
  };
  const turn = { id: "current-turn", items: [first, reply] };
  await reconcileCodexToolTerminals(turn, openByTurn, emit);
  await reconcileCodexToolTerminals(turn, openByTurn, emit);
  assert.deepEqual(emitted, [["current-turn", "read-first", "completed", "read-result"]]);
  assert.deepEqual([...openByTurn.get("previous-turn")], ["read-first"]);
});

test("does not turn a failed or unconfirmed tool into success", async () => {
  const openByTurn = new Map([["turn", new Set(["failed", "active"])]]);
  const emitted = [];
  await reconcileCodexToolTerminals(
    {
      id: "turn",
      items: [
        { id: "failed", type: "mcpToolCall", status: "failed" },
        { id: "active", type: "mcpToolCall", status: "inProgress" },
      ],
    },
    openByTurn,
    async (item, turnId) => {
      emitted.push([item.id, item.status]);
      openByTurn.get(turnId).delete(item.id);
    },
  );
  assert.deepEqual(emitted, [["failed", "failed"]]);
  assert.deepEqual([...openByTurn.get("turn")], ["active"]);
});

test("a failed reconciliation write remains an error with the tool still open", async () => {
  const openByTurn = new Map([["turn", new Set(["read"])]]);
  const failure = new Error("ACP update was not delivered");
  await assert.rejects(
    reconcileCodexToolTerminals(
      { id: "turn", items: [{ id: "read", type: "mcpToolCall", status: "completed" }] },
      openByTurn,
      async () => {
        throw failure;
      },
    ),
    failure,
  );
  assert.deepEqual([...openByTurn.get("turn")], ["read"]);
});
