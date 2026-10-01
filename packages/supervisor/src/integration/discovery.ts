import {
  INTEGRATION_TASK_LIMITS,
  IntegrationInventoryEntrySchema,
  type IntegrationInventoryEntry,
  type IntegrationProvider,
} from "@konteks/backstage-plugin-common";
import type { ClaudeMcpStatusEntry } from "@konteks/remote-agent-runner";
import { claudeMcpServerSegment } from "../session/permission-tool-identity.js";
import { IntegrationTaskError } from "./errors.js";

/**
 * The discovery allowlist (D26; capabilities-and-execution "Enrollment
 * algorithm" step 1). An agent's listing output may carry URLs with tokens,
 * headers, commands, environment values, server descriptions and error text;
 * none of it may leave this function. What comes out is exactly the
 * `IntegrationInventoryEntry` fields: server name, source kind, status,
 * provider category and tool names, each a bounded token.
 */

const SERVER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOOL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Provider by the server's plain name. A recognized name is a category, never an enabled operation. */
const PROVIDER_NAMES: ReadonlyArray<[RegExp, IntegrationProvider]> = [
  [/atlassian|jira/i, "jira"],
  [/slack/i, "slack"],
  [/teams|microsoft|m365/i, "teams"],
  [/asana/i, "asana"],
  [/github/i, "github"],
  [/linear/i, "linear"],
  [/notion/i, "notion"],
  [/figma/i, "figma"],
];

export function providerCategoryOf(name: string): IntegrationProvider | "unknown" {
  return PROVIDER_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? "unknown";
}

function toolNames(names: readonly unknown[]): string[] {
  return [...new Set(names.filter((name): name is string => typeof name === "string" && name.length <= 128 && TOOL_TOKEN.test(name)))]
    .sort()
    .slice(0, INTEGRATION_TASK_LIMITS.maxToolNamesPerServer);
}

/** Build one entry through the shared schema; anything that does not fit is dropped, never repaired. */
function entry(value: IntegrationInventoryEntry): IntegrationInventoryEntry | null {
  const parsed = IntegrationInventoryEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function bounded(entries: Array<IntegrationInventoryEntry | null>): IntegrationInventoryEntry[] {
  return entries.filter((value): value is IntegrationInventoryEntry => value !== null).slice(0, INTEGRATION_TASK_LIMITS.maxInventoryServers);
}

const CODEX_RUNTIME_STATUS: Readonly<Record<string, IntegrationInventoryEntry["status"]>> = {
  connected: "connected",
  authenticationRequired: "needs_auth",
  failed: "failed",
  cancelled: "failed",
  disabled: "disabled",
  notStarted: "unknown",
  starting: "unknown",
};

/** Codex `mcpServerStatus/list` data (pinned 0.153.4 schema): name, authStatus, runtimeStatus, pluginId, tools keys. */
export function sanitizeCodexMcpStatus(raw: readonly unknown[]): IntegrationInventoryEntry[] {
  return bounded(raw.map(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const server = item as { name?: unknown; authStatus?: unknown; runtimeStatus?: unknown; pluginId?: unknown; tools?: unknown };
    if (typeof server.name !== "string" || server.name.length > 128 || !SERVER_TOKEN.test(server.name)) return null;
    const runtime = typeof server.runtimeStatus === "string" ? CODEX_RUNTIME_STATUS[server.runtimeStatus] : undefined;
    const tools = server.tools !== null && typeof server.tools === "object" && !Array.isArray(server.tools) ? Object.keys(server.tools) : [];
    // Outside a thread Codex reports no runtime status; a server whose tools
    // it just listed did connect for that listing (measured, pinned 0.153.4).
    const listed = runtime === undefined && server.runtimeStatus == null && tools.length > 0 ? "connected" : undefined;
    const status = server.authStatus === "notLoggedIn" && runtime !== "disabled" ? "needs_auth" : runtime ?? listed ?? "unknown";
    return entry({
      serverName: server.name,
      sourceKind: typeof server.pluginId === "string" && server.pluginId.length > 0 ? "plugin_mcp" : "agent_mcp",
      status,
      providerCategory: providerCategoryOf(server.name),
      toolNames: toolNames(tools),
    });
  }));
}

const CLAUDE_STATUS: Readonly<Record<string, IntegrationInventoryEntry["status"]>> = {
  connected: "connected",
  "needs-auth": "needs_auth",
  failed: "failed",
  disabled: "disabled",
  pending: "unknown",
};

/**
 * Claude Agent SDK `mcpServerStatus()`, already reduced by the discovery child.
 * Only account connectors (scope `claudeai`) are a Claude source (preflight
 * C2/C3): personal CLI servers are not loaded and repository servers are not
 * offered. The server is named as Claude names it in tool calls
 * (`claude.ai Atlassian` -> `claude_ai_Atlassian`), which is what the gate sees.
 */
export function sanitizeClaudeMcpStatus(raw: readonly ClaudeMcpStatusEntry[]): IntegrationInventoryEntry[] {
  return bounded(raw.map(server => {
    if (server.scope !== "claudeai") return null;
    const serverName = claudeMcpServerSegment(server.name);
    if (serverName.length === 0 || serverName.length > 128 || !SERVER_TOKEN.test(serverName)) return null;
    return entry({
      serverName,
      sourceKind: "account_connector",
      status: CLAUDE_STATUS[server.status] ?? "unknown",
      providerCategory: providerCategoryOf(server.name),
      toolNames: toolNames(server.tools),
    });
  }));
}

export interface IntegrationDiscovery {
  discover(agentId: string): Promise<IntegrationInventoryEntry[]>;
}

/** Per-agent model-free readers (agent-runner `integration-mcp-status.ts`), composed by the supervisor. */
export interface NativeIntegrationDiscoveryReaders {
  claude?: () => Promise<ClaudeMcpStatusEntry[]>;
  codex?: () => Promise<unknown[]>;
}

export class NativeIntegrationDiscovery implements IntegrationDiscovery {
  constructor(private readonly readers: NativeIntegrationDiscoveryReaders) {}

  async discover(agentId: string): Promise<IntegrationInventoryEntry[]> {
    if (agentId === "claude-code" && this.readers.claude) return sanitizeClaudeMcpStatus(await this.readers.claude());
    if (agentId === "codex" && this.readers.codex) return sanitizeCodexMcpStatus(await this.readers.codex());
    throw new IntegrationTaskError("operation_unsupported");
  }
}
