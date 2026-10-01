import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexAcpLiveUserPatch,
  konteksTitlePrefixCheck,
  missingCodexToolTerminals,
  reconcileCodexToolTerminals,
  patchCodexAcpLiveUsers,
} from "./codex-acp-live-user-patch.mjs";

test("live-user compatibility change rejects an unreviewed upstream version", () => {
  assert.throws(() => patchCodexAcpLiveUsers("untrusted", "1.10.1"), /requires review/);
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

test("a Konteks thread turns the person's own configured MCP servers off and keeps its own (S0-2)", async () => {
  const { konteksCodexMcpServers } = await import("./codex-acp-live-user-patch.mjs");
  const existing = new Set(["atlassian", "personal_notes"]);
  assert.deepEqual(konteksCodexMcpServers(existing, ["konteks-1-a", "konteks-result"], []), {
    atlassian: { enabled: false },
    personal_notes: { enabled: false },
  });
  // The CP2 seam: a server an integration binding admitted stays on.
  assert.deepEqual(konteksCodexMcpServers(existing, ["konteks-result"], ["atlassian"]), {
    personal_notes: { enabled: false },
  });
  assert.deepEqual(konteksCodexMcpServers(new Set(), [], []), {});
  // A personal server under a name this session gives its own server would
  // run in its place and be judged as Konteks's: refused, never merged.
  assert.throws(() => konteksCodexMcpServers(new Set(["konteks-result"]), ["konteks-result"], []), /uses a name/);
});

// Build qualification supplies the pristine upstream dist directory.
test("the reviewed bridge disables configured MCP servers on every thread start, resume and fork", { skip: !process.env.CODEX_ACP_FIXTURE_DIR }, async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { source } = patchCodexAcpLiveUsers(readFileSync(join(process.env.CODEX_ACP_FIXTURE_DIR, "index.js"), "utf8"), codexAcpLiveUserPatch.version);
  assert.match(source, /async createSessionConfig\(projectPath, additionalDirectories, mcpServers, admittedMcpServerNames = \[\]\) \{/);
  assert.match(source, /const disabledMcpServers = konteksCodexMcpServers\(existingMcpServerNames, requestedServers\.map\(\(mcp\) => mcp\.name\), admittedMcpServerNames\.map\(sanitizeMcpServerName\)\);/);
  assert.doesNotMatch(source, /shouldDeduplicateMcpConflicts\(\)\) \{\n      const existingNames/);
  assert.equal(codexAcpLiveUserPatch.id, "konteks-codex-acp-live-user-v7");
});
