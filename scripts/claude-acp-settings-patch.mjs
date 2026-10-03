import { createHash } from "node:crypto";
import { konteksPrefixedName } from "./konteks-session-prefix.mjs";

// Build-time only: installed release bytes remain immutable and signed.
export const claudeAcpSettingsPatch = {
  id: "konteks-claude-project-settings-v3",
  version: "0.75.1",
  hashes: {
    "acp-agent.js": "c22424c297429378166524b59ee6bed239c999a420ad0dd06571b768efa7525b",
    "settings.js": "629348525ddd007ace9c06a16a19af6877af2a090b58255dd7f5974a6bdf2932",
    "session-titles.js": "a78f6ed7e85193fbb0ebc97b37c0adde70d1000eac94e70e310e75dd580e079a",
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

  } else if (file === "session-titles.js") {
    // A direct session (D130): Claude's own generated title, behind
    // "[konteks] ". Generated without persisting, prefixed, then written as
    // the session's title, which Claude Code's own session list shows.
    replace('import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";',
      `import { getSessionInfo, renameSession } from "@anthropic-ai/claude-agent-sdk";
${konteksPrefixedName.toString()}
function konteksSessionPrefix(session) {
    const meta = session?.creationParams?._meta?.konteksSession;
    return meta?.version === 1 && meta.prefix === "[konteks]" ? meta.prefix : null;
}`);
    replace('            await this.publish(info.customTitle, info.lastModified);',
      `            const konteksTitle = konteksPrefixedName(konteksSessionPrefix(session), info.customTitle);
            if (konteksTitle && konteksTitle !== info.customTitle && await this.konteksRename(session, konteksTitle)) {
                await this.publish(konteksTitle, Date.now());
                return;
            }
            await this.publish(info.customTitle, info.lastModified);`);
    replace(`                (await session.query.generateSessionTitle?.(description, {
                    persist: true,
                })) ?? null;`, `                (await session.query.generateSessionTitle?.(description, {
                    persist: !konteksSessionPrefix(session),
                })) ?? null;`);
    replace(`        if (this.agent.sessions[this.sessionId] !== session) {
            return;
        }`, `        if (this.agent.sessions[this.sessionId] !== session) {
            return;
        }
        const konteksPrefix = konteksSessionPrefix(session);
        if (konteksPrefix) {
            // Claude's wording when it has one, else the first message, so the
            // session is recognisable now rather than after a later retry.
            const named = title ? konteksPrefixedName(konteksPrefix, title) : fallback?.title ? konteksPrefixedName(konteksPrefix, fallback.title, 80) : null;
            if (!named || !(await this.konteksRename(session, named))) {
                this.settled = false;
                if (fallback) {
                    await this.publish(fallback.title, fallback.lastModified);
                }
                return;
            }
            this.context = undefined;
            await this.publish(named, Date.now());
            return;
        }`);
    replace('    async publish(rawTitle, lastModified) {', `    /** Persist a Konteks-prefixed title; a failure is logged, never thrown into the turn. */
    async konteksRename(session, title) {
        try {
            await renameSession(this.sessionId, title, { dir: session.cwd });
            return true;
        }
        catch (error) {
            this.agent.logger.error(\`Session \${this.sessionId}: [konteks] session title update failed: \${error}\`);
            return false;
        }
    }
    async publish(rawTitle, lastModified) {`);
  } else {
    replace('resolveSettings({ cwd: this.cwd })', 'resolveSettings({ cwd: this.cwd, settingSources: ["project"] })');
    replace('            path.join(CLAUDE_CONFIG_DIR, "settings.json"),\n', '');
    replace('            path.join(this.cwd, ".claude", "settings.local.json"),\n', '');
  }
  return { source, provenance: { id: claudeAcpSettingsPatch.id, version, file,
    upstreamSha256: claudeAcpSettingsPatch.hashes[file], patchedSha256: sha256(source) } };
}
