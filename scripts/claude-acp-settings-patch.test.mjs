import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchClaudeSettings, claudeAcpSettingsPatch } from "./claude-acp-settings-patch.mjs";

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
  assert.match(agent, /\.\.\.userProvidedOptions,\s+settingSources: \["project"\]/);
  assert.match(agent, /instruction_scope version=2/);
  assert.match(agent, /settings = await isolateClaudeInstructions\(settings, params.cwd, CLAUDE_CONFIG_DIR\)/);
});
