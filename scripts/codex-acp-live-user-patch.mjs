import { createHash } from "node:crypto";
import { konteksPrefixedName } from "./konteks-session-prefix.mjs";

// Build-time compatibility change only. Never mutate an installed signed artifact.
// Reuse upstream's history conversion; do not reconstruct or read local files.
// It admits an integration task's own server, switches every other configured
// MCP server off, and shows a direct session's own title behind the
// [konteks] prefix.
export const codexAcpLiveUserPatch = {
  id: "konteks-codex-acp-live-user-v11",
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

// A Konteks thread runs only the MCP servers Konteks gave it.
// codex-acp keeps the person's configured servers (user and trusted project
// layers) and adds the ACP ones; this turns each configured server off for
// the thread (`mcp_servers.<name>.enabled = false`, deep-merged per thread;
// measured against the pinned Codex 0.153.4: the server is never started).
// `admittedNames` are the servers an integration task's binding admits
// (`konteksAdmittedMcpServerNames`).
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

// The one personal server an integration task's
// binding admits, read ONLY from that task's own session/new
// (`_meta.konteksIntegration`, version 1, at most 8 bounded names). Any other
// shape admits nothing; resume, load and fork never carry an admission.
export function konteksAdmittedMcpServerNames(meta) {
  const integration = meta && typeof meta === "object" ? meta.konteksIntegration : undefined;
  if (!integration || typeof integration !== "object" || integration.version !== 1) return [];
  const names = integration.admittedMcpServerNames;
  if (!Array.isArray(names) || names.length > 8) return [];
  if (!names.every((name) => typeof name === "string" && name.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) return [];
  return [...names];
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
    "    currentValue: currentBaseModelId,\n    options\n  };\n}\nfunction createReasoningEffortConfigOption",
    `    currentValue: currentBaseModelId,
    options,
    _meta: { konteksModelOffer: {
      source: "codex-model-list.v1",
      offeredValues: availableModels.map(model => model.id),
      defaultValue: availableModels.filter(model => model.isDefault === true).length === 1 ?
        availableModels.find(model => model.isDefault === true).id : null
    } }
  };
}
function createReasoningEffortConfigOption`,
  );
  replaceOnce(
    '    codex = process.platform === "win32" ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv }) : spawn(codexPath, ["app-server"], { env: spawnEnv });',
    '    codex = process.platform === "win32" ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv, windowsHide: true }) : spawn(codexPath, ["app-server"], { env: spawnEnv });',
  );
  replaceOnce(
    "var CodexEventHandler = class _CodexEventHandler {",
    `${missingCodexToolTerminals.toString()}\n${reconcileCodexToolTerminals.toString()}\n${konteksCodexMcpServers.toString()}\n${konteksAdmittedMcpServerNames.toString()}\n${konteksPrefixedName.toString()}\nvar CodexEventHandler = class _CodexEventHandler {`,
  );
  replaceOnce(
    "      config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers),\n      modelProvider: this.getModelProvider(),",
    "      config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers, konteksAdmittedMcpServerNames(request._meta)),\n      modelProvider: this.getModelProvider(),",
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
    } else if (konteksSession?.version === 1 && konteksSession.prefix === "[konteks]") {
      // A direct session: Codex titles it itself; the name gets only the prefix.
      const titleGen = this.getSessionState(sessionId).titleGen;
      if (titleGen) titleGen.konteksPrefix = konteksSession.prefix;
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
  // Codex's own title for a direct session, behind "[konteks] ". The title
  // model's failure falls back to the first message, so the thread is still
  // recognisable; a name someone set meanwhile is never replaced.
  replaceOnce(
    "    this.generated = true;\n    this.generateAndPersist(userPromptText).catch(() => {\n    });",
    "    this.generated = true;\n    (this.konteksPrefix ? this.konteksNameThread(userPromptText) : this.generateAndPersist(userPromptText)).catch(() => {\n    });",
  );
  replaceOnce(
    "  async generateAndPersist(userPromptText) {\n",
    `  async konteksNameThread(userPromptText) {
    let title = null;
    try {
      title = await this.generateAndPersist(userPromptText);
    } catch {
    }
    const name = title ? konteksPrefixedName(this.konteksPrefix, title) : konteksPrefixedName(this.konteksPrefix, userPromptText, 80);
    if (!name || this.getSessionTitleSource() === "explicit") return;
    await this.client.threadSetName({
      threadId: this.mainThreadId,
      name
    });
  }
  async generateAndPersist(userPromptText) {
`,
  );
  replaceOnce(
    "    const title = extractTitle(turnResult.turn);\n    if (!title) return;",
    "    const title = extractTitle(turnResult.turn);\n    if (this.konteksPrefix) return title;\n    if (!title) return;",
  );
  return {
    source,
    provenance: {
      ...codexAcpLiveUserPatch,
      patchedSha256: createHash("sha256").update(source).digest("hex"),
    },
  };
}
