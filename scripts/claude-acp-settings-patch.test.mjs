import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchClaudeSettings, claudeAcpSettingsPatch } from "./claude-acp-settings-patch.mjs";

test("the reviewed change is identified as the session-hardening revision", () => {
  assert.equal(claudeAcpSettingsPatch.id, "konteks-claude-project-settings-v5");
});

test("settings isolation rejects unreviewed versions and modified artifacts", () => {
  for (const file of Object.keys(claudeAcpSettingsPatch.hashes)) {
    assert.throws(() => patchClaudeSettings("unreviewed", file, "0.75.1"), /requires review/);
    assert.throws(() => patchClaudeSettings("unreviewed", file, "0.75.2"), /requires review/);
  }
});

// Build qualification supplies the pristine installed/upstream dist directory.
test("reviewed bridge uses project settings in both SDK resolution and query", { skip: !process.env.CLAUDE_ACP_FIXTURE_DIR }, () => {
  const load = file => patchClaudeSettings(readFileSync(join(process.env.CLAUDE_ACP_FIXTURE_DIR, file), "utf8"), file, "0.75.1").source;
  const settings = load("settings.js");
  assert.match(settings, /resolveSettings\(\{ cwd: this.cwd, settingSources: \["project"\] \}\)/);
  assert.doesNotMatch(settings, /path.join\(CLAUDE_CONFIG_DIR, "settings.json"\)/);
  const agent = load("acp-agent.js");
  // CP2: an integration session (and only one, `_meta.konteksIntegration`)
  // loads the account connectors, with no setting sources at all so no
  // repository .mcp.json server starts; every other session is as Stage 0.
  assert.match(agent, /\.\.\.userProvidedOptions,\s+settingSources: konteksAccountConnectors\(params\._meta\) \? \[\] : \["project"\],\s+strictMcpConfig: !konteksAccountConnectors\(params\._meta\),/);
  // S0-1: only the MCP servers Konteks hands the session (the ACP request)
  // load; the repository's .mcp.json is ignored. Flag settings switch the
  // repository's hooks off on new, loaded and resumed sessions alike.
  assert.match(agent, /settings = hardenClaudeSession\(await isolateClaudeInstructions\(settings, params.cwd, CLAUDE_CONFIG_DIR\), konteksAccountConnectors\(params\._meta\)\)/);
  assert.match(agent, /^import \{ hardenClaudeSession, isolateClaudeInstructions, konteksAccountConnectors \} from "\.\/konteks-instruction-scope\.mjs";/);
  // S0-4: every permission request names its tool in a structured field the
  // connector reads (never the display title), set where the bridge asks.
  assert.match(agent, /async requestPermissionFromClient\(params, toolName, signal, parentToolUseId, ownerSessionId = params.sessionId\) \{\n        params = \{ \.\.\.params, toolCall: \{ \.\.\.params\.toolCall, _meta: \{ \.\.\.params\.toolCall\._meta, claudeCode: \{ \.\.\.params\.toolCall\._meta\?\.claudeCode, toolName \} \} \} \};/);
  assert.match(agent, /\[konteks\] instruction_scope version=4 settings=\$\{konteksAccountConnectors\(params\._meta\) \? "none" : "project"\} .* hooks=disabled repository_mcp=excluded account_connectors=\$\{konteksAccountConnectors\(params\._meta\) \? "integration" : "excluded"\}/);
});

const fixture = process.env.CLAUDE_ACP_FIXTURE_DIR;
/** The patched session-titles module, its SDK replaced by a recorder. */
async function sessionTitles(sdk) {
  const source = patchClaudeSettings(readFileSync(join(fixture, "session-titles.js"), "utf8"), "session-titles.js", "0.75.1").source;
  assert.match(source, /import \{ getSessionInfo, renameSession \} from "@anthropic-ai\/claude-agent-sdk";/);
  globalThis.__konteksSdk = sdk;
  const stubbed = source.replace('import { getSessionInfo, renameSession } from "@anthropic-ai/claude-agent-sdk";',
    "const { getSessionInfo, renameSession } = globalThis.__konteksSdk;");
  return import(`data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}#${Math.random()}`);
}
function claudeSession(prefix, generated) {
  const asked = [];
  const session = { cwd: "/w", queryClosed: false, cancelled: false,
    creationParams: { _meta: prefix ? { konteksSession: { version: 1, prefix } } : {} },
    query: { generateSessionTitle: async (description, options) => { asked.push(options); return generated; } } };
  const published = [];
  const agent = { sessions: {}, logger: { error: () => undefined }, client: { sessionUpdate: async update => { published.push(update.update.title); } } };
  return { session, agent, asked, published };
}

test("Claude's own title for a direct session is generated, prefixed once and written as the session title", { skip: !fixture }, async () => {
  const renamed = [];
  const { SessionTitles } = await sessionTitles({ getSessionInfo: async () => ({ summary: "fix the login loop", lastModified: 1 }), renameSession: async (...args) => { renamed.push(args); } });
  const f = claudeSession("[konteks]", "Fix login redirect loop");
  const titles = new SessionTitles(f.agent, "s-1");
  f.agent.sessions["s-1"] = { ...f.session, titles };
  titles.onPrompt([{ type: "text", text: "the login page keeps redirecting to itself" }]);
  await titles.onTurnEnd(f.agent.sessions["s-1"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.asked, [{ persist: false }]);
  assert.deepEqual(renamed, [["s-1", "[konteks] Fix login redirect loop", { dir: "/w" }]]);
  assert.deepEqual(f.published, ["[konteks] Fix login redirect loop"]);
});

test("a direct session whose title Claude could not generate is named from its first message", { skip: !fixture }, async () => {
  const renamed = [];
  const { SessionTitles } = await sessionTitles({ getSessionInfo: async () => ({ summary: "the login page keeps redirecting to itself", lastModified: 1 }), renameSession: async (...args) => { renamed.push(args); } });
  const f = claudeSession("[konteks]", null);
  const titles = new SessionTitles(f.agent, "s-2");
  f.agent.sessions["s-2"] = { ...f.session, titles };
  titles.onPrompt([{ type: "text", text: "the login page keeps redirecting to itself" }]);
  await titles.onTurnEnd(f.agent.sessions["s-2"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(renamed, [["s-2", "[konteks] the login page keeps redirecting to itself", { dir: "/w" }]]);
});

test("a stored title without the prefix gains it; an engineering session's title is left alone", { skip: !fixture }, async () => {
  const renamed = [];
  let customTitle = "Fix login redirect loop";
  const { SessionTitles } = await sessionTitles({ getSessionInfo: async () => ({ customTitle, lastModified: 1 }), renameSession: async (...args) => { renamed.push(args); } });
  const direct = claudeSession("[konteks]", "unused");
  const titles = new SessionTitles(direct.agent, "s-3");
  await titles.onTurnEnd({ ...direct.session, titles });
  assert.deepEqual(renamed, [["s-3", "[konteks] Fix login redirect loop", { dir: "/w" }]]);
  customTitle = "[konteks/Todo List/initiative] Stand up the API 3fa9c1d2";
  const engineering = claudeSession(null, "unused");
  await new SessionTitles(engineering.agent, "s-4").onTurnEnd(engineering.session);
  assert.equal(renamed.length, 1);
  assert.deepEqual(engineering.published, [customTitle]);
  assert.deepEqual(engineering.asked, []);
});
