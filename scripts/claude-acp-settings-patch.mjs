import { createHash } from "node:crypto";

// Build-time only: installed release bytes remain immutable and signed.
// v3 (Stage 0, S0-1): a Konteks session also runs none of the repository's
// hooks and starts none of its `.mcp.json` servers. The bridge forces
// `strictMcpConfig` (only the servers in the ACP request load, which also
// leaves the account's claude.ai connectors out) and hardened flag settings
// (`disableAllHooks`; the SDK's callback hooks, the bridge's own, still run)
// on new, loaded and resumed sessions alike; and every permission request
// names its tool in `_meta.claudeCode.toolName` (S0-4). Measured against the operator's
// Claude CLI: external-integration-via-agent proof/cp2-runtime/stage-0.
export const claudeAcpSettingsPatch = {
  id: "konteks-claude-project-settings-v3",
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
    source = 'import { hardenClaudeSession, isolateClaudeInstructions } from "./konteks-instruction-scope.mjs";\n' + source;
    replace('        const env = {\n            ...process.env,', '        settings = hardenClaudeSession(await isolateClaudeInstructions(settings, params.cwd, CLAUDE_CONFIG_DIR));\n        this.logger.log(`[konteks] instruction_scope version=3 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=${settings.claudeMdExcludes.length} hooks=disabled repository_mcp=excluded account_connectors=excluded`);\n        const env = {\n            ...process.env,');
    replace('settingSources: ["user", "project", "local"],', 'settingSources: ["project"],');
    // Apply after the optional client options too, including session/load and
    // resume. SettingsManager and query must see the same effective scope.
    // S0-4: name the tool in a structured field on every permission request
    // (the request carried it only in its display title). The connector's
    // policy reads `_meta.claudeCode.toolName`, never the title.
    replace('    async requestPermissionFromClient(params, toolName, signal, parentToolUseId, ownerSessionId = params.sessionId) {\n', '    async requestPermissionFromClient(params, toolName, signal, parentToolUseId, ownerSessionId = params.sessionId) {\n        params = { ...params, toolCall: { ...params.toolCall, _meta: { ...params.toolCall._meta, claudeCode: { ...params.toolCall._meta?.claudeCode, toolName } } } };\n');
    replace('            ...userProvidedOptions,\n', '            ...userProvidedOptions,\n            settingSources: ["project"],\n            strictMcpConfig: true,\n');

  } else {
    replace('resolveSettings({ cwd: this.cwd })', 'resolveSettings({ cwd: this.cwd, settingSources: ["project"] })');
    replace('            path.join(CLAUDE_CONFIG_DIR, "settings.json"),\n', '');
    replace('            path.join(this.cwd, ".claude", "settings.local.json"),\n', '');
  }
  return { source, provenance: { id: claudeAcpSettingsPatch.id, version, file,
    upstreamSha256: claudeAcpSettingsPatch.hashes[file], patchedSha256: sha256(source) } };
}
