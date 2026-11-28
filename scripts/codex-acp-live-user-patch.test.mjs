import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { konteksPrefixedName } from "./konteks-session-prefix.mjs";
import {
  codexAcpLiveUserPatch,
  konteksCodexInstructionScope,
  konteksCodexMcpServers,
  konteksRepositoryConfig,
  konteksTitlePrefixCheck,
  konteksWorkingCopyInstructions,
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

test("a Konteks thread turns the person's own configured MCP servers off and keeps its own", async () => {
  const { konteksCodexMcpServers } = await import("./codex-acp-live-user-patch.mjs");
  const existing = new Set(["atlassian", "personal_notes"]);
  assert.deepEqual(konteksCodexMcpServers(existing, ["konteks-1-a", "konteks-result"], []), {
    atlassian: { enabled: false },
    personal_notes: { enabled: false },
  });
  // A server an integration binding admitted stays on.
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
  assert.equal(codexAcpLiveUserPatch.id, "konteks-codex-acp-live-user-v13");
  // Every start, resume and load return carries the working-copy-only scope.
  assert.equal(source.match(/\.\.\.konteksCodexInstructionScope\(projectPath\)/g)?.length, 2);
  assert.match(source, /project_doc_max_bytes: 0/);
  assert.match(source, /features: \{ memories: false \}/);
},
);

test("an integration session admits only the bound personal server, read from its own session/new", async () => {
  const { konteksAdmittedMcpServerNames } = await import("./codex-acp-live-user-patch.mjs");
  assert.deepEqual(konteksAdmittedMcpServerNames({ konteksIntegration: { version: 1, admittedMcpServerNames: ["atlassian"], accountConnectors: false } }), ["atlassian"]);
  // Nothing else admits anything: no meta, another version, a bad name, too many.
  assert.deepEqual(konteksAdmittedMcpServerNames(undefined), []);
  assert.deepEqual(konteksAdmittedMcpServerNames({ konteksIntegration: { version: 2, admittedMcpServerNames: ["atlassian"] } }), []);
  assert.deepEqual(konteksAdmittedMcpServerNames({ konteksIntegration: { version: 1, admittedMcpServerNames: ["ok", "bad name"] } }), []);
  assert.deepEqual(konteksAdmittedMcpServerNames({ konteksIntegration: { version: 1, admittedMcpServerNames: Array.from({ length: 9 }, (_, i) => `s${i}`) } }), []);
  assert.deepEqual(konteksAdmittedMcpServerNames({ konteksIntegration: { version: 1, admittedMcpServerNames: "atlassian" } }), []);
});

test("the reviewed bridge passes the admission on thread start only, never on resume, load or fork", { skip: !process.env.CODEX_ACP_FIXTURE_DIR }, async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { source } = patchCodexAcpLiveUsers(readFileSync(join(process.env.CODEX_ACP_FIXTURE_DIR, "index.js"), "utf8"), codexAcpLiveUserPatch.version);
  assert.match(source, /config: konteksRepositoryConfig\(await this\.createSessionConfig\(request\.cwd, additionalDirectories, request\.mcpServers, konteksAdmittedMcpServerNames\(request\._meta\)\), request\._meta\),/);
  assert.equal(source.split("konteksAdmittedMcpServerNames(request._meta)").length, 2);
  assert.match(source, /function konteksAdmittedMcpServerNames\(meta\)/);
});

test("a direct session keeps the agent's own title behind one [konteks] prefix", () => {
  assert.equal(konteksPrefixedName("[konteks]", "Fix login redirect loop"), "[konteks] Fix login redirect loop");
  assert.equal(konteksPrefixedName("[konteks]", "[konteks] Fix login"), "[konteks] Fix login");
  const labelled = "[konteks/Todo List/initiative] Stand up the API 3fa9c1d2";
  assert.equal(konteksPrefixedName("[konteks]", labelled), labelled);
  assert.equal(konteksPrefixedName("[konteks]", " Fix\n\tlogin\u202e "), "[konteks] Fix login");
  assert.equal(konteksPrefixedName("[konteks]", ""), "[konteks]");
  assert.equal(konteksPrefixedName("[konteks]", null), "[konteks]");
  assert.equal(konteksPrefixedName("[other]", "Fix login"), null);
  assert.equal(konteksPrefixedName(undefined, "Fix login"), null);
  const cut = konteksPrefixedName("[konteks]", "word ".repeat(40), 80);
  assert.ok(cut.length <= 80);
  assert.match(cut, /^\[konteks\] (word )+word…$/);
});

// Build qualification supplies the pristine upstream dist directory.
const fixture = process.env.CODEX_ACP_FIXTURE_DIR;
function codexModelOption() {
  const original = readFileSync(join(fixture, "index.js"), "utf8");
  const patched = patchCodexAcpLiveUsers(original, codexAcpLiveUserPatch.version).source;
  const start = patched.indexOf(
    "function createModelConfigOption(availableModels, currentBaseModelId) {",
  );
  const end = patched.indexOf("\nfunction createReasoningEffortConfigOption(", start);
  assert.ok(start >= 0 && end > start, "the reviewed Codex model option section moved");
  return new Function(
    "MODEL_CONFIG_ID",
    `${patched.slice(start, end)}\nreturn createModelConfigOption;`,
  )("model");
}

test(
  "Codex model provenance excludes the injected unsupported current value and identifies only its explicit default",
  { skip: !fixture },
  () => {
    const create = codexModelOption();
    const option = create(
      [{ id: "supported-default", displayName: "Supported", isDefault: true }],
      "gpt-6.1-sol",
    );
    // Upstream personal configuration semantics remain unchanged.
    assert.equal(option.currentValue, "gpt-6.1-sol");
    assert.deepEqual(
      option.options.map((entry) => entry.value),
      ["gpt-6.1-sol", "supported-default"],
    );
    assert.deepEqual(option._meta?.konteksModelOffer, {
      source: "codex-model-list.v1",
      offeredValues: ["supported-default"],
      defaultValue: "supported-default",
    });
  },
);

test(
  "Codex model provenance retains exact ACP values and never guesses an ambiguous or absent default",
  { skip: !fixture },
  () => {
    const create = codexModelOption();
    const models = [
      { id: "supported/variant", displayName: "Variant", isDefault: true },
      { id: "other", isDefault: true },
    ];
    const option = create(models, "supported/variant");
    assert.deepEqual(option._meta?.konteksModelOffer, {
      source: "codex-model-list.v1",
      offeredValues: ["supported/variant", "other"],
      defaultValue: null,
    });
    assert.equal(
      create([{ id: "listed", isDefault: false }], "listed")._meta?.konteksModelOffer.defaultValue,
      null,
    );
    assert.equal(create([], "unlisted")._meta?.konteksModelOffer.defaultValue, null);
  },
);

function backgroundCodexSpawner(platform) {
  const original = readFileSync(join(fixture, "index.js"), "utf8");
  const patched = patchCodexAcpLiveUsers(original, codexAcpLiveUserPatch.version).source;
  const start = patched.indexOf("function startCodexConnection(codexPath, env) {");
  const end = patched.indexOf("\nfunction attachLogs(proc)", start);
  assert.ok(start >= 0 && end > start, "the background Codex connection section moved");
  const connection = { listen() {}, dispose() {} };
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { stdout: {}, stdin: {}, on() {} };
  };
  // Substitute import.meta only to evaluate this reviewed function with inert boundaries.
  const source = patched.slice(start, end)
    .replace("createRequire(import.meta.url)", "createRequire('file:///fixture.js')");
  const startConnection = new Function(
    "process",
    "spawn",
    "attachLogs",
    "createJSONRPCReader",
    "createJSONRPCWriter",
    "rpc",
    "createRequire",
    `${source}\nreturn startCodexConnection;`,
  )(
    { platform, execPath: "fixture-node", env: {} },
    spawn,
    () => {},
    () => ({}),
    () => ({}),
    { createMessageConnection: () => connection },
    () => ({ resolve: () => "fixture-bundled-codex" }),
  );
  return { startConnection, calls, patched };
}

test(
  "a Windows background Codex app-server hides its console while sign-in stays interactive",
  { skip: !fixture },
  () => {
    const { startConnection, calls, patched } = backgroundCodexSpawner("win32");
    const env = { CODEX_HOME: "fixture-personal-home" };
    startConnection("C:\\signed package\\codex.exe", env);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '"C:\\signed package\\codex.exe" app-server');
    assert.deepEqual(calls[0][1], { shell: true, env, windowsHide: true });
    const cli = patched.slice(
      patched.indexOf("function spawnCodexCli("),
      patched.indexOf("// src/index.ts"),
    );
    assert.ok(cli.includes('stdio: "inherit"'));
    assert.doesNotMatch(cli, /windowsHide/);
  },
);

test(
  "the background connection preserves Unix app-server arguments and environment",
  { skip: !fixture },
  () => {
    const { startConnection, calls } = backgroundCodexSpawner("linux");
    const env = { CODEX_HOME: "fixture-personal-home" };
    startConnection("/signed package/codex", env);
    assert.deepEqual(calls, [["/signed package/codex", ["app-server"], { env }]]);
  },
);

function titleGenerator() {
  const patched = patchCodexAcpLiveUsers(readFileSync(join(fixture, "index.js"), "utf8"), codexAcpLiveUserPatch.version).source;
  const start = patched.indexOf("// src/TitleGenerator.ts");
  const end = patched.indexOf("\n// src/CodexAcpServer.ts\nimport { once }");
  assert.ok(start > 0 && end > start, "the TitleGenerator section moved");
  return { patched, TitleGenerator: new Function(`${konteksPrefixedName.toString()}\n${patched.slice(start, end)}\nreturn TitleGenerator;`)() };
}
function codexClient(answer) {
  const named = [];
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  return { named, done, client: {
    threadStart: async () => ({ thread: { id: "ephemeral" } }),
    runTurn: async () => answer(),
    threadSetName: async params => { named.push(params); settle(); },
  } };
}
const titled = title => ({ turn: { items: [{ type: "agentMessage", text: JSON.stringify({ title }) }] } });

test("Codex's own title for a direct session gains the prefix once; the name is never Konteks-built", { skip: !fixture }, async () => {
  const { TitleGenerator, patched } = titleGenerator();
  assert.match(patched, /titleGen\.konteksPrefix = konteksSession\.prefix/);
  const direct = codexClient(() => titled("Fix login redirect loop"));
  const generator = new TitleGenerator(direct.client, "thread-1", "/w", () => "unset");
  generator.konteksPrefix = "[konteks]";
  generator.onTurnCompleted("the login page keeps redirecting to itself after sign-in");
  await direct.done;
  assert.deepEqual(direct.named, [{ threadId: "thread-1", name: "[konteks] Fix login redirect loop" }]);
  generator.onTurnCompleted("a second turn never renames");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(direct.named.length, 1);
});

test("a failed title model still names a direct thread, from the first message", { skip: !fixture }, async () => {
  const { TitleGenerator } = titleGenerator();
  const failing = codexClient(() => { throw new Error("title model unavailable"); });
  const generator = new TitleGenerator(failing.client, "thread-2", "/w", () => "unset");
  generator.konteksPrefix = "[konteks]";
  generator.onTurnCompleted("Please add a dark mode toggle to the settings page of the dashboard app we built last week");
  await failing.done;
  assert.equal(failing.named[0].threadId, "thread-2");
  assert.match(failing.named[0].name, /^\[konteks\] Please add a dark mode toggle .*…$/);
  assert.ok(failing.named[0].name.length <= 80);
});

test("an engineering or unprefixed thread keeps upstream naming, and a name set meanwhile is kept", { skip: !fixture }, async () => {
  const { TitleGenerator } = titleGenerator();
  const upstream = codexClient(() => titled("Fix login redirect loop"));
  new TitleGenerator(upstream.client, "thread-3", "/w", () => "unset").onTurnCompleted("the login page loops");
  await upstream.done;
  assert.deepEqual(upstream.named, [{ threadId: "thread-3", name: "Fix login redirect loop" }]);
  let source = "unset";
  const renamed = codexClient(() => { source = "explicit"; return titled("Something else"); });
  const generator = new TitleGenerator(renamed.client, "thread-4", "/w", () => source);
  generator.konteksPrefix = "[konteks]";
  generator.onTurnCompleted("the person renames it while the title is generated");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(renamed.named, []);
});


test("repository lifecycle policy is per thread and leaves direct configuration unchanged", () => {
  const base = { "sandbox_mode": "workspace-write", "mcp_servers": { owned: { enabled: true } } };
  const policy = { konteksRepository: { version: 1, managed: true } };
  assert.deepEqual(konteksRepositoryConfig(base, policy), {
    ...base, "shell_environment_policy.set.HUSKY": "0",
  });
  assert.equal(konteksRepositoryConfig(base, undefined), base);
  assert.equal(konteksRepositoryConfig(base, { konteksRepository: { version: 2, managed: true } }), base);
  assert.equal(konteksRepositoryConfig(base, { konteksRepository: { version: 1, managed: false } }), base);
  assert.equal(Object.hasOwn(base, "shell_environment_policy.set.HUSKY"), false);
});

test("the instruction scope turns off Codex docs and memories and carries only the working copy's AGENTS.md", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-instruction-scope-"));
  try {
    const wc = join(root, "work");
    mkdirSync(wc, { recursive: true });
    writeFileSync(join(wc, "AGENTS.md"), "Run the project's tests.\n");
    const scope = konteksCodexInstructionScope(wc);
    assert.equal(scope.project_doc_max_bytes, 0);
    assert.deepEqual(scope.features, { memories: false });
    assert.equal(scope.developer_instructions, "Run the project's tests.\n");
    // Without a working-copy AGENTS.md there are no instructions at all; the
    // scope never names a path outside the working copy.
    assert.deepEqual(konteksCodexInstructionScope(join(root, "empty")), {
      project_doc_max_bytes: 0,
      features: { memories: false },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pinned Codex source carries the memories feature behind its features config", () => {
  // scripts/fixtures/cpal-0.18.2-availability/Cargo.lock is exact public source
  // from Codex commit 687a119. It grounds the feature name and that Codex's
  // config crate deserializes the feature table through codex-features.
  const lock = readFileSync(new URL("./fixtures/cpal-0.18.2-availability/Cargo.lock", import.meta.url), "utf8");
  for (const crate of ["codex-features", "codex-memories-read", "codex-memories-write", "codex-memories-extension"]) {
    assert.match(lock, new RegExp(`name = "${crate}"`), crate);
  }
  const start = lock.indexOf('name = "codex-config"');
  const end = lock.indexOf("[[package]]", start);
  assert.ok(start >= 0 && end > start, "codex-config moved in the pinned Codex source");
  assert.match(lock.slice(start, end), /"codex-features"/);
});

// Build qualification supplies the pristine upstream dist directory.
function methodSection(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `the reviewed Codex section moved: ${signature}`);
  const next = /\n {2}(?:async\s+)?[A-Za-z_$][\w$]*\s*[=(]/.exec(source.slice(start + 1));
  return source.slice(start, next === null ? undefined : start + 1 + next.index).trim();
}

function sessionConfigFor(source) {
  return new Function(
    "konteksCodexMcpServers", "konteksCodexInstructionScope", "konteksWorkingCopyInstructions", "sanitizeMcpServerName",
    `return { ${methodSection(source, "  async createSessionConfig(projectPath, additionalDirectories, mcpServers, admittedMcpServerNames = []) {")} };`,
  )(konteksCodexMcpServers, konteksCodexInstructionScope, konteksWorkingCopyInstructions, name => name);
}

test("the patched bridge sends working-copy-only instruction scope to every thread config", { skip: !fixture }, async () => {
  const original = readFileSync(join(fixture, "index.js"), "utf8");
  const patched = patchCodexAcpLiveUsers(original, codexAcpLiveUserPatch.version).source;
  const root = mkdtempSync(join(tmpdir(), "codex-thread-config-"));
  try {
    const wc = join(root, "work");
    const sharedHome = join(root, "operator", ".codex");
    mkdirSync(wc, { recursive: true });
    mkdirSync(sharedHome, { recursive: true });
    writeFileSync(join(wc, "AGENTS.md"), "# working copy rules\n");
    writeFileSync(join(sharedHome, "AGENTS.md"), "# operator private rules\n");
    writeFileSync(join(sharedHome, "AGENTS.override.md"), "# operator private override\n");
    const handler = { getConfigMcpServerNames: async () => new Set(), createMcpSeverConfig: () => ({}) };
    const create = sessionConfigFor(patched).createSessionConfig;
    const config = await create.call(handler, wc, [], [], []);
    assert.equal(config.project_doc_max_bytes, 0);
    assert.deepEqual(config.features, { memories: false });
    assert.equal(config.developer_instructions, "# working copy rules\n");
    // The same thread config with the shared profile present, and with the
    // environment naming it, still carries no CODEX_HOME instruction bytes.
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHome;
    try {
      const same = await create.call(handler, wc, [], [], []);
      assert.deepEqual(same, config);
      assert.doesNotMatch(JSON.stringify(same), /operator private|sharedHome/);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
    // The unpatched upstream method returns none of these keys for the same
    // working copy: the config the app-server receives is the patch's change.
    const plain = await new Function(
      "sanitizeMcpServerName",
      `return { ${methodSection(original, "  async createSessionConfig(projectPath, additionalDirectories, mcpServers) {")} };`,
    )(name => name).createSessionConfig.call(handler, wc, [], []);
    for (const key of ["project_doc_max_bytes", "features", "developer_instructions"]) {
      assert.equal(Object.hasOwn(plain, key), false, key);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a working copy's instructions never come through a link out, a folder or a book", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-working-copy-instructions-"));
  try {
    const wc = join(root, "work");
    mkdirSync(wc, { recursive: true });
    assert.equal(konteksWorkingCopyInstructions(undefined), "");
    assert.equal(konteksWorkingCopyInstructions(""), "");
    // No file: no instructions, and no private discovery outside the copy.
    assert.equal(konteksWorkingCopyInstructions(wc), "");
    writeFileSync(join(root, "private.md"), "Personal rules.\n");
    symlinkSync(join(root, "private.md"), join(wc, "AGENTS.md"));
    assert.equal(konteksWorkingCopyInstructions(wc), "");
    rmSync(join(wc, "AGENTS.md"));
    mkdirSync(join(wc, "AGENTS.md"));
    assert.equal(konteksWorkingCopyInstructions(wc), "");
    rmSync(join(wc, "AGENTS.md"), { recursive: true, force: true });
    writeFileSync(join(wc, "AGENTS.md"), "x".repeat(32_769));
    assert.equal(konteksWorkingCopyInstructions(wc), "");
    // A link that stays inside the working copy is the working copy's own.
    rmSync(join(wc, "AGENTS.md"));
    writeFileSync(join(wc, "RULES.md"), "# rules\n");
    symlinkSync(join(wc, "RULES.md"), join(wc, "AGENTS.md"));
    assert.equal(konteksWorkingCopyInstructions(wc), "# rules\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("managed repository policy reaches start, resume and load on the pinned bridge", { skip: !process.env.CODEX_ACP_FIXTURE_DIR }, async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { source } = patchCodexAcpLiveUsers(readFileSync(join(process.env.CODEX_ACP_FIXTURE_DIR, "index.js"), "utf8"), codexAcpLiveUserPatch.version);
  for (const method of ["newSession", "resumeSession", "loadSession"]) {
    const start = source.indexOf(`async ${method}(request`);
    assert.notEqual(start, -1, method);
    const next = source.indexOf("\n  async ", start + 1);
    const body = source.slice(start, next === -1 ? undefined : next);
    assert.match(body, /config: konteksRepositoryConfig\(await this\.createSessionConfig\([^\n]+request\._meta\),/);
  }
  assert.equal(source.match(/config: konteksRepositoryConfig\(/g)?.length, 3);
});
