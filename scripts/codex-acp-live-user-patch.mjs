import { createHash } from "node:crypto";

// Build-time compatibility change only. Never mutate an installed signed artifact.
// Reuse upstream's history conversion; do not reconstruct or read local files.
export const codexAcpLiveUserPatch = {
  id: "konteks-codex-acp-live-user-v7",
  package: "@agentclientprotocol/codex-acp",
  version: "1.10.0",
  upstreamSha256: "4602784c5896fbf05a7d89b09655bacc768d0bf281e0d03a10333ff81da45268",
};

// Konteks titles start "[konteks]" (legacy) or "[konteks/<system>/<kind>]".
export const konteksTitlePrefixCheck = String.raw`/^\[konteks[\]\/]/`;

// A terminal app-server turn is the authority for tool item outcomes. One live
// turn reached Assistant without a completion for a provider-completed tool;
// the loss stage is not yet proven. Reconcile only items whose start reached
// ACP but whose terminal update did not, preserving genuine failed statuses.
export function missingCodexToolTerminals(turn, openToolIds) {
  if (!turn || !Array.isArray(turn.items) || !(openToolIds instanceof Set)) return [];
  return turn.items.filter(
    (item) =>
      item &&
      typeof item.id === "string" &&
      openToolIds.has(item.id) &&
      (item.type === "mcpToolCall" || item.type === "dynamicToolCall") &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "declined" ||
        item.status === "interrupted"),
  );
}

export async function reconcileCodexToolTerminals(turn, openByTurn, emit) {
  if (!turn || typeof turn.id !== "string" || !(openByTurn instanceof Map)) return;
  const open = openByTurn.get(turn.id);
  if (!(open instanceof Set)) return;
  for (const item of missingCodexToolTerminals(turn, open)) {
    await emit(item, turn.id);
  }
}

// Stage 0 (S0-2): a Konteks thread runs only the MCP servers Konteks gave it.
// codex-acp keeps the person's configured servers (user and trusted project
// layers) and adds the ACP ones; this turns each configured server off for
// the thread (`mcp_servers.<name>.enabled = false`, deep-merged per thread;
// measured against the pinned Codex 0.153.4: the server is never started).
// `admittedNames` is the integration seam (CP2); nothing admits one yet.
export function konteksCodexMcpServers(existingNames, requestedNames, admittedNames) {
  const conflict = requestedNames.find((name) => existingNames.has(name));
  if (conflict !== undefined) {
    throw new Error("A personal Codex MCP server uses a name this Konteks session needs for its own; rename it in your Codex config.");
  }
  const keep = new Set([...requestedNames, ...admittedNames]);
  return Object.fromEntries(
    [...existingNames].filter((name) => !keep.has(name)).sort().map((name) => [name, { enabled: false }]),
  );
}

export function patchCodexAcpLiveUsers(source, version) {
  if (
    version !== codexAcpLiveUserPatch.version ||
    createHash("sha256").update(source).digest("hex") !== codexAcpLiveUserPatch.upstreamSha256
  ) {
    throw new Error(
      "Codex ACP live-user compatibility change requires review of this upstream artifact",
    );
  }
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error("Codex ACP compatibility anchor is not unique");
    source = source.replace(before, after);
  };
  replaceOnce(
    "var CodexEventHandler = class _CodexEventHandler {",
    `${missingCodexToolTerminals.toString()}\n${reconcileCodexToolTerminals.toString()}\n${konteksCodexMcpServers.toString()}\nvar CodexEventHandler = class _CodexEventHandler {`,
  );
  replaceOnce(
    `  async createSessionConfig(projectPath, additionalDirectories, mcpServers) {`,
    `  async createSessionConfig(projectPath, additionalDirectories, mcpServers, admittedMcpServerNames = []) {`,
  );
  replaceOnce(
    `    if (mcpServers.length === 0) {
      return configWithWorkspaceRoots;
    }
    const requestedServers = mcpServers.map((mcp) => ({
      name: sanitizeMcpServerName(mcp.name),
      server: mcp
    }));
    let serversToConfigure = requestedServers;
    if (shouldDeduplicateMcpConflicts()) {
      const existingNames = await this.getConfigMcpServerNames(projectPath);
      serversToConfigure = requestedServers.filter((mcp) => !existingNames.has(mcp.name));
    }
    if (serversToConfigure.length === 0) {
      return configWithWorkspaceRoots;
    }
    return {
      ...configWithWorkspaceRoots,
      "mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))
    };`,
    `    const requestedServers = mcpServers.map((mcp) => ({
      name: sanitizeMcpServerName(mcp.name),
      server: mcp
    }));
    const existingMcpServerNames = await this.getConfigMcpServerNames(projectPath);
    const disabledMcpServers = konteksCodexMcpServers(existingMcpServerNames, requestedServers.map((mcp) => mcp.name), admittedMcpServerNames.map(sanitizeMcpServerName));
    if (requestedServers.length === 0 && Object.keys(disabledMcpServers).length === 0) {
      return configWithWorkspaceRoots;
    }
    return {
      ...configWithWorkspaceRoots,
      "mcp_servers": {
        ...disabledMcpServers,
        ...Object.fromEntries(requestedServers.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))
      }
    };`,
  );
  replaceOnce(
    "  terminalCommandOutputIds = /* @__PURE__ */ new Set();\n  agentMessagePhases = /* @__PURE__ */ new Map();",
    "  terminalCommandOutputIds = /* @__PURE__ */ new Set();\n  konteksOpenToolIdsByTurn = /* @__PURE__ */ new Map();\n  konteksTerminalToolIds = /* @__PURE__ */ new Set();\n  agentMessagePhases = /* @__PURE__ */ new Map();",
  );
  replaceOnce(
    "  async handleNotification(notification) {\n    await this.flushPendingErrors();",
    `  async handleNotification(notification) {
    if (this.nativeUserMessageUpdates && notification.method === "item/completed" &&
        notification.params?.threadId === this.sessionState.sessionId &&
        typeof notification.params?.turnId === "string" &&
        typeof notification.params?.item?.id === "string" &&
        this.konteksTerminalToolIds.has(notification.params.turnId + ":" + notification.params.item.id)) return;
    await this.flushPendingErrors();`,
  );
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
      await this.session.update(updateEvent, this.subagents.notificationSessionId(notification));
      if (this.nativeUserMessageUpdates &&
          notification.params?.threadId === this.sessionState.sessionId &&
          typeof notification.params?.turnId === "string" &&
          (notification.params?.item?.type === "mcpToolCall" || notification.params?.item?.type === "dynamicToolCall") &&
          typeof notification.params.item.id === "string") {
        const turnId = notification.params.turnId;
        const itemId = notification.params.item.id;
        if (notification.method === "item/started" && updateEvent.status === "in_progress") {
          const open = this.konteksOpenToolIdsByTurn.get(turnId) ?? new Set();
          open.add(itemId);
          this.konteksOpenToolIdsByTurn.set(turnId, open);
        }
        if (notification.method === "item/completed" &&
            (updateEvent.status === "completed" || updateEvent.status === "failed")) {
          this.konteksOpenToolIdsByTurn.get(turnId)?.delete(itemId);
          this.konteksTerminalToolIds.add(turnId + ":" + itemId);
        }
      }`,
  );
  replaceOnce(
    "  async waitForNativeSubagentSession(childThreadId) {",
    `  async reconcileMissingToolTerminals(turn) {
    if (!this.nativeUserMessageUpdates) return;
    await reconcileCodexToolTerminals(turn, this.konteksOpenToolIdsByTurn, async (item, turnId) => {
      await this.handleNotification({ method: "item/completed", params: {
        threadId: this.sessionState.sessionId, turnId, item
      } });
      logger.log("Konteks Codex tool terminal reconciled", {
        threadId: this.sessionState.sessionId, turnId, itemId: item.id, status: item.status
      });
    });
  }
  async waitForNativeSubagentSession(childThreadId) {`,
  );
  replaceOnce(
    '      await this.codexAcpClient.waitForSessionNotifications(params.sessionId);\n      if (turnCompleted.turn.status === "completed") {',
    `      await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
      if (process.env.KONTEKS_NATIVE_CODEX_SOCKET &&
          eventHandler.konteksOpenToolIdsByTurn.get(turnCompleted.turn.id)?.size > 0) {
        await eventHandler.reconcileMissingToolTerminals(turnCompleted.turn);
        if (eventHandler.konteksOpenToolIdsByTurn.get(turnCompleted.turn.id)?.size > 0) {
          const history = await this.codexAcpClient.readSessionThread(params.sessionId);
          const authoritativeTurn = history?.turns?.find(turn => turn.id === turnCompleted.turn.id);
          if (authoritativeTurn) await eventHandler.reconcileMissingToolTerminals(authoritativeTurn);
          if (eventHandler.konteksOpenToolIdsByTurn.get(turnCompleted.turn.id)?.size > 0) {
            logger.log("Konteks Codex tool terminal unconfirmed", {
              threadId: params.sessionId, turnId: turnCompleted.turn.id,
              itemIds: [...eventHandler.konteksOpenToolIdsByTurn.get(turnCompleted.turn.id)].slice(0, 16)
            });
          }
        }
      }
      if (turnCompleted.turn.status === "completed") {`,
  );
  replaceOnce(
    '      case "item/completed":\n        this.completeRetryIncidentOnTurnProgress();\n        return await this.completeItemEvent(notification.params);',
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
  return {
    source,
    provenance: {
      ...codexAcpLiveUserPatch,
      patchedSha256: createHash("sha256").update(source).digest("hex"),
    },
  };
}
