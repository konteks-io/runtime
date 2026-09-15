/** Display provenance only, never an IAM claim or a model instruction. */
export function konteksSessionTitle(title: string): string {
  const normalized = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return (normalized.startsWith("[konteks]") ? normalized : `[konteks] ${normalized || "Coding session"}`).slice(0, 160);
}

/** Provider adapters must persist this title through their native naming API. */
export function konteksSessionMetadata(title: string, agentId?: string) {
  const nativeTitle = konteksSessionTitle(title);
  return {
    konteksSession: { version: 1, title: nativeTitle },
    // Pinned claude-agent-acp forwards these to the SDK's native new-session
    // title option. No permission, auth, model, or resume options are supplied.
    ...(agentId === "claude-code" ? { claudeCode: { options: { title: nativeTitle } } } : {}),
  };
}
