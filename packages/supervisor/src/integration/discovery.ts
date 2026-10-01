import {
  INTEGRATION_TASK_LIMITS,
  IntegrationFixtureServerSchema,
  IntegrationInventoryEntrySchema,
  type IntegrationInventoryEntry,
  type IntegrationProvider,
} from "@konteks/backstage-plugin-common";
import type { ClaudeMcpStatusEntry } from "@konteks/remote-agent-runner";
import { claudeMcpServerSegment } from "../session/permission-tool-identity.js";
import { integrationFixturesEnabled } from "./carrier.js";
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

/** The variable the E2E controller sets on its connector process: `{serverName: loopback url}`. */
export const E2E_FIXTURE_SERVERS_VARIABLE = "KONTEKS_E2E_FIXTURE_MCP_SERVERS";

export interface E2EFixtureServer {
  serverName: string;
  url: string;
}

/**
 * E2E only (`KONTEKS_E2E_NATIVE_CONNECTOR=1`): the synthetic provider servers
 * the controller runs. Claude has no personal MCP source a fixture could live
 * in (its source is the account's connectors), so its discovery offers these
 * as `fixture_mcp` sources; Core serves the URL back on the task spec. Outside
 * E2E mode, or for anything that is not a bounded name and a loopback HTTP
 * URL, nothing is offered.
 */
export function e2eFixtureServers(env: NodeJS.ProcessEnv = process.env): E2EFixtureServer[] {
  if (!integrationFixturesEnabled(env)) return [];
  const raw = env[E2E_FIXTURE_SERVERS_VARIABLE];
  if (raw === undefined || raw.length === 0 || raw.length > 16 * 1024) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter((item): item is [string, string] => typeof item[1] === "string" && item[0].length <= 128 && SERVER_TOKEN.test(item[0]))
    .filter(([, url]) => IntegrationFixtureServerSchema.safeParse({ type: "http", url }).success)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, INTEGRATION_TASK_LIMITS.maxInventoryServers)
    .map(([serverName, url]) => ({ serverName, url }));
}

/**
 * Model-free listing of one fixture server: MCP `initialize` then
 * `tools/list` over loopback streamable HTTP. Only tool names come back.
 */
export async function listFixtureTools(server: E2EFixtureServer, fetchImpl: typeof fetch = fetch, timeoutMs = 3_000): Promise<unknown[]> {
  const post = async (body: unknown, session?: string) => {
    const response = await fetchImpl(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error(`fixture answered ${response.status}`);
    return { session: response.headers.get("mcp-session-id") ?? undefined, body: await response.json() as { result?: { tools?: Array<{ name?: unknown }> } } };
  };
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "konteks-integration-discovery", version: "1" } } });
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.session);
  return (listed.body.result?.tools ?? []).map(tool => tool.name);
}

/** The `fixture_mcp` inventory entries for the E2E fixture servers; an unreachable one is `failed`. */
export async function readFixtureInventory(servers: readonly E2EFixtureServer[], list: (server: E2EFixtureServer) => Promise<unknown[]> = listFixtureTools): Promise<IntegrationInventoryEntry[]> {
  const entries = await Promise.all(servers.map(async server => {
    let tools: unknown[] = [];
    let status: IntegrationInventoryEntry["status"] = "connected";
    try {
      tools = await list(server);
    } catch {
      status = "failed";
    }
    return entry({ serverName: server.serverName, sourceKind: "fixture_mcp", status, providerCategory: providerCategoryOf(server.serverName), toolNames: toolNames(tools) });
  }));
  return bounded(entries);
}

export interface IntegrationDiscovery {
  discover(agentId: string): Promise<IntegrationInventoryEntry[]>;
}

/** Per-agent model-free readers (agent-runner `integration-mcp-status.ts`), composed by the supervisor. */
export interface NativeIntegrationDiscoveryReaders {
  claude?: () => Promise<ClaudeMcpStatusEntry[]>;
  codex?: () => Promise<unknown[]>;
  /** E2E only: the `fixture_mcp` sources offered beside Claude's account connectors. */
  fixtures?: () => Promise<IntegrationInventoryEntry[]>;
}

export class NativeIntegrationDiscovery implements IntegrationDiscovery {
  constructor(private readonly readers: NativeIntegrationDiscoveryReaders) {}

  async discover(agentId: string): Promise<IntegrationInventoryEntry[]> {
    if (agentId === "claude-code" && this.readers.claude) {
      const connectors = sanitizeClaudeMcpStatus(await this.readers.claude());
      const fixtures = this.readers.fixtures ? await this.readers.fixtures() : [];
      const names = new Set(connectors.map(item => item.serverName));
      return bounded([...connectors, ...fixtures.filter(item => !names.has(item.serverName))]);
    }
    if (agentId === "codex" && this.readers.codex) return sanitizeCodexMcpStatus(await this.readers.codex());
    throw new IntegrationTaskError("operation_unsupported");
  }
}
