import { createHash } from "node:crypto";

// Build-time only: installed release bytes remain immutable and signed.
export const claudeAcpSettingsPatch = {
  id: "konteks-claude-project-settings-v2",
  version: "0.75.1",
  hashes: {
    "acp-agent.js": "c22424c297429378166524b59ee6bed239c999a420ad0dd06571b768efa7525b",
    "settings.js": "629348525ddd007ace9c06a16a19af6877af2a090b58255dd7f5974a6bdf2932",
  },
};

export function patchClaudeSettings(source, file, version) {
  const sha256 = value => createHash("sha256").update(value).digest("hex");
  if (version !== claudeAcpSettingsPatch.version || sha256(source) !== claudeAcpSettingsPatch.hashes[file]) {
    throw new Error("Claude ACP settings isolation requires review of this upstream artifact");
  }
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error("Claude ACP settings anchor is not unique");
    source = source.replace(before, after);
  };
  if (file === "acp-agent.js") {
    source = 'import { isolateClaudeInstructions } from "./konteks-instruction-scope.mjs";\n' + source;
    replace('        const env = {\n            ...process.env,', '        settings = await isolateClaudeInstructions(settings, params.cwd, CLAUDE_CONFIG_DIR);\n        this.logger.log(`[konteks] instruction_scope version=2 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=${settings.claudeMdExcludes.length}`);\n        const env = {\n            ...process.env,');
    replace('settingSources: ["user", "project", "local"],', 'settingSources: ["project"],');
    // Apply after the optional client options too, including session/load and
    // resume. SettingsManager and query must see the same effective scope.
    replace('            ...userProvidedOptions,\n', '            ...userProvidedOptions,\n            settingSources: ["project"],\n');

  } else {
    replace('resolveSettings({ cwd: this.cwd })', 'resolveSettings({ cwd: this.cwd, settingSources: ["project"] })');
    replace('            path.join(CLAUDE_CONFIG_DIR, "settings.json"),\n', '');
    replace('            path.join(this.cwd, ".claude", "settings.local.json"),\n', '');
  }
  return { source, provenance: { id: claudeAcpSettingsPatch.id, version, file,
    upstreamSha256: claudeAcpSettingsPatch.hashes[file], patchedSha256: sha256(source) } };
}
