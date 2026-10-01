import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchClaudeSettings, claudeAcpSettingsPatch } from "./claude-acp-settings-patch.mjs";

test("the reviewed change is identified as the session-hardening revision", () => {
  assert.equal(claudeAcpSettingsPatch.id, "konteks-claude-project-settings-v4");
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
