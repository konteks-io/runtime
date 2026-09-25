import { createHash } from "node:crypto";

// Build-time compatibility change only. Never mutate an installed signed artifact.
// Reuse upstream's history conversion; do not reconstruct or read local files.
export const codexAcpLiveUserPatch = {
  id: "konteks-codex-acp-live-user-v5",
  package: "@agentclientprotocol/codex-acp",
  version: "1.10.0",
  upstreamSha256: "4602784c5896fbf05a7d89b09655bacc768d0bf281e0d03a10333ff81da45268",
};

// Konteks titles start "[konteks]" (legacy) or "[konteks/<system>/<kind>]".
export const konteksTitlePrefixCheck = String.raw`/^\[konteks[\]\/]/`;

export function patchCodexAcpLiveUsers(source, version) {
  if (version !== codexAcpLiveUserPatch.version || createHash("sha256").update(source).digest("hex") !== codexAcpLiveUserPatch.upstreamSha256) {
    throw new Error("Codex ACP live-user compatibility change requires review of this upstream artifact");
  }
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2) throw new Error("Codex ACP compatibility anchor is not unique");
    source = source.replace(before, after);
  };
  replaceOnce(
    '    const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);\n    logger.log("New session created", {',
    `    const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);
    const konteksSession = params._meta?.konteksSession;
    if (konteksSession?.version === 1 && typeof konteksSession.title === "string" && ${konteksTitlePrefixCheck}.test(konteksSession.title) && konteksSession.title.length <= 160 && !/[\\p{Cc}\\p{Cf}]/u.test(konteksSession.title)) {
      await this.runWithProcessCheck(() => this.codexAcpClient.renameSession(sessionId, konteksSession.title));
      const state = this.getSessionState(sessionId);
      state.sessionTitle = konteksSession.title;
      state.sessionTitleSource = "explicit";
      state.titleGen?.markExistingTitle();
    }
    logger.log("New session created", {`,
  );
  replaceOnce(
    "  ), onAccountUpdated) {\n    this.onAccountUpdated = onAccountUpdated;",
    "  ), onAccountUpdated, nativeUserMessageUpdates) {\n    this.nativeUserMessageUpdates = nativeUserMessageUpdates;\n    this.onAccountUpdated = onAccountUpdated;",
  );
  replaceOnce(
    "        (accountUpdated) => this.handleAccountUpdated(accountUpdated)\n      );",
    "        (accountUpdated) => this.handleAccountUpdated(accountUpdated),\n        process.env.KONTEKS_NATIVE_CODEX_SOCKET ? (item) => this.createUserMessageUpdates(item) : undefined\n      );",
  );
  replaceOnce(
    "    if (updateEvent) {\n      await this.session.update(updateEvent, this.subagents.notificationSessionId(notification));",
    `    if (updateEvent) {
      if (this.nativeUserMessageUpdates && updateEvent.sessionUpdate === "agent_message_chunk" && typeof notification.params?.turnId === "string" && typeof notification.params?.itemId === "string") {
        updateEvent = { ...updateEvent, _meta: { ...updateEvent._meta, konteksNativeObservation: {
          version: 1, origin: "unclassified", turnId: notification.params.turnId, itemId: notification.params.itemId
        } } };
      }
      await this.session.update(updateEvent, this.subagents.notificationSessionId(notification));`,
  );
  replaceOnce(
    "      case \"item/completed\":\n        this.completeRetryIncidentOnTurnProgress();\n        return await this.completeItemEvent(notification.params);",
    `      case "item/completed":
        this.completeRetryIncidentOnTurnProgress();
        if (notification.params.item.type === "userMessage" && this.nativeUserMessageUpdates) {
          for (const update of this.nativeUserMessageUpdates(notification.params.item)) {
            await this.session.update({
              ...update,
              _meta: {
                ...update._meta,
                konteksNativeObservation: {
                  version: 1,
                  origin: notification.params.item.konteksInputSource === "connector" ? "connector" : "unclassified",
                  turnId: notification.params.turnId,
                  itemId: notification.params.item.id,
                  clientUserMessageId: notification.params.item.clientId ?? null
                }
              }
            }, this.subagents.notificationSessionId(notification));
          }
          return null;
        }
        return await this.completeItemEvent(notification.params);`,
  );
  return { source, provenance: { ...codexAcpLiveUserPatch, patchedSha256: createHash("sha256").update(source).digest("hex") } };
}
