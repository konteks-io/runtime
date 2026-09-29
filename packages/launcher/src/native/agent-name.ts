/** An agent family as people name it. */
export function agentName(family: string): string {
  return ({ "claude-code": "Claude Code", codex: "Codex", dsh: "DeepSeek Harness", opencode: "OpenCode", antigravity: "Google Antigravity" } as Record<string, string>)[family] ?? family;
}
