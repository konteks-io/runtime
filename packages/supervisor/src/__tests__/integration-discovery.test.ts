import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { IntegrationInventoryEntrySchema } from "@konteks/backstage-plugin-common";
import { E2E_FIXTURE_SERVERS_VARIABLE, NativeIntegrationDiscovery, e2eFixtureServers, listFixtureTools, providerCategoryOf, readFixtureInventory, sanitizeClaudeMcpStatus, sanitizeCodexMcpStatus } from "../integration/discovery.js";

const CANARY = "ghp_canary_4d1c2b";

/** Everything a Codex status page may carry: URLs, headers, env, resources, schemas, server info. */
const codexRaw = [
  { name: "atlassian", authStatus: "oAuth", runtimeStatus: "connected", pluginId: null,
    serverInfo: { name: CANARY, version: "1", websiteUrl: `https://x/?t=${CANARY}`, description: CANARY },
    tools: { getJiraIssue: { name: "getJiraIssue", description: CANARY, inputSchema: { default: CANARY } }, addCommentToJiraIssue: { name: "addCommentToJiraIssue", inputSchema: {} } },
    resources: [{ name: "r", uri: `https://x/${CANARY}` }], resourceTemplates: [], url: `https://mcp.atlassian.com/?token=${CANARY}`,
    http_headers: { Authorization: `Bearer ${CANARY}` }, env: { API_KEY: CANARY }, command: "npx", args: [CANARY] },
  { name: "slack", authStatus: "notLoggedIn", runtimeStatus: null, pluginId: "slack@vendor", tools: {}, resources: [], resourceTemplates: [] },
  { name: "broken", authStatus: "unsupported", runtimeStatus: "failed", tools: {}, resources: [], resourceTemplates: [], error: `boom ${CANARY}` },
  { name: "off", authStatus: "unknown", runtimeStatus: "disabled", tools: {}, resources: [], resourceTemplates: [] },
  { name: "bad name; rm -rf", authStatus: "unknown", tools: {}, resources: [], resourceTemplates: [] },
  { name: "linear", authStatus: "oAuth", runtimeStatus: "authenticationRequired", tools: { "bad tool name!": {}, list_issues: {} }, resources: [], resourceTemplates: [] },
  { name: "listed", authStatus: "bearerToken", runtimeStatus: null, tools: { getIssue: {} }, resources: [], resourceTemplates: [] },
  { name: "silent", authStatus: "unsupported", tools: {}, resources: [], resourceTemplates: [] },
  "not an object",
];

describe("integration discovery allowlist (secret canaries)", () => {
  it("keeps only server name, source kind, status, provider category and tool names from Codex", () => {
    const inventory = sanitizeCodexMcpStatus(codexRaw);
    expect(JSON.stringify(inventory)).not.toContain(CANARY);
    expect(inventory).toEqual([
      { serverName: "atlassian", sourceKind: "agent_mcp", status: "connected", providerCategory: "jira", toolNames: ["addCommentToJiraIssue", "getJiraIssue"] },
      { serverName: "slack", sourceKind: "plugin_mcp", status: "needs_auth", providerCategory: "slack", toolNames: [] },
      { serverName: "broken", sourceKind: "agent_mcp", status: "failed", providerCategory: "unknown", toolNames: [] },
      { serverName: "off", sourceKind: "agent_mcp", status: "disabled", providerCategory: "unknown", toolNames: [] },
      { serverName: "linear", sourceKind: "agent_mcp", status: "needs_auth", providerCategory: "linear", toolNames: ["list_issues"] },
      // Outside a thread Codex has no runtime status: tools it listed mean it connected; none means unknown.
      { serverName: "listed", sourceKind: "agent_mcp", status: "connected", providerCategory: "unknown", toolNames: ["getIssue"] },
      { serverName: "silent", sourceKind: "agent_mcp", status: "unknown", providerCategory: "unknown", toolNames: [] },
    ]);
    for (const entry of inventory) IntegrationInventoryEntrySchema.parse(entry);
  });

  it("keeps only the Claude account connectors, named as Claude names their tools", () => {
    const inventory = sanitizeClaudeMcpStatus([
      { name: "claude.ai Atlassian", status: "connected", scope: "claudeai", tools: ["getJiraIssue", `x${CANARY}`.replace(/_/g, "-")] },
      { name: "claude.ai Microsoft 365", status: "needs-auth", scope: "claudeai", tools: [] },
      { name: "claude.ai Gmail", status: "pending", scope: "claudeai", tools: [] },
      { name: "personal", status: "connected", scope: "user", tools: ["anything"] },
      { name: "repo", status: "connected", scope: "project", tools: [] },
    ]);
    expect(inventory).toEqual([
      { serverName: "claude_ai_Atlassian", sourceKind: "account_connector", status: "connected", providerCategory: "jira", toolNames: ["getJiraIssue", "xghp-canary-4d1c2b"] },
      { serverName: "claude_ai_Microsoft_365", sourceKind: "account_connector", status: "needs_auth", providerCategory: "teams", toolNames: [] },
      { serverName: "claude_ai_Gmail", sourceKind: "account_connector", status: "unknown", providerCategory: "unknown", toolNames: [] },
    ]);
  });

  it("recognizes a provider only by its plain name", () => {
    expect(providerCategoryOf("Atlassian")).toBe("jira");
    expect(providerCategoryOf("asana-v2")).toBe("asana");
    expect(providerCategoryOf("github")).toBe("github");
    expect(providerCategoryOf("notion")).toBe("notion");
    expect(providerCategoryOf("figma-dev-mode")).toBe("figma");
    expect(providerCategoryOf("weather")).toBe("unknown");
  });

  it("discovers per agent, and an agent without a supported listing interface has none", async () => {
    const discovery = new NativeIntegrationDiscovery({
      codex: async () => codexRaw,
      claude: async () => [{ name: "claude.ai Slack", status: "connected", scope: "claudeai", tools: ["slack_read_thread"] }],
    });
    expect((await discovery.discover("codex")).map(entry => entry.serverName)).toContain("atlassian");
    expect(await discovery.discover("claude-code")).toEqual([{ serverName: "claude_ai_Slack", sourceKind: "account_connector", status: "connected", providerCategory: "slack", toolNames: ["slack_read_thread"] }]);
    await expect(discovery.discover("opencode")).rejects.toMatchObject({ code: "operation_unsupported" });
  });
});

describe("E2E fixture sources (KONTEKS_E2E_NATIVE_CONNECTOR=1 only)", () => {
  const servers = JSON.stringify({ atlassian: "http://127.0.0.1:7801/mcp", slack: "http://localhost:7802/mcp", remote: "https://example.com/mcp", "bad name": "http://127.0.0.1:1/mcp", creds: "http://u:p@127.0.0.1:2/mcp" });

  it("reads the controller's servers only in E2E mode and only as loopback HTTP", () => {
    expect(e2eFixtureServers({ [E2E_FIXTURE_SERVERS_VARIABLE]: servers })).toEqual([]);
    expect(e2eFixtureServers({ KONTEKS_E2E_NATIVE_CONNECTOR: "0", [E2E_FIXTURE_SERVERS_VARIABLE]: servers })).toEqual([]);
    expect(e2eFixtureServers({ KONTEKS_E2E_NATIVE_CONNECTOR: "1", [E2E_FIXTURE_SERVERS_VARIABLE]: servers })).toEqual([
      { serverName: "atlassian", url: "http://127.0.0.1:7801/mcp" },
      { serverName: "slack", url: "http://localhost:7802/mcp" },
    ]);
    for (const value of ["", "not json", "[1]", "null"]) {
      expect(e2eFixtureServers({ KONTEKS_E2E_NATIVE_CONNECTOR: "1", [E2E_FIXTURE_SERVERS_VARIABLE]: value })).toEqual([]);
    }
  });

  it("lists a fixture's tool names over MCP and marks an unreachable one failed", async () => {
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { id: number; method: string };
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "atlassian", version: "1" } }
        : { tools: [{ name: "getJiraIssue", description: "secret-canary" }, { name: "addOrEditJiraIssueComment" }, { name: "bad tool!" }] };
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      expect(await listFixtureTools({ serverName: "atlassian", url })).toEqual(["getJiraIssue", "addOrEditJiraIssueComment", "bad tool!"]);
      const inventory = await readFixtureInventory([{ serverName: "atlassian", url }, { serverName: "slack", url: "http://127.0.0.1:1/mcp" }]);
      expect(inventory).toEqual([
        { serverName: "atlassian", sourceKind: "fixture_mcp", status: "connected", providerCategory: "jira", toolNames: ["addOrEditJiraIssueComment", "getJiraIssue"] },
        { serverName: "slack", sourceKind: "fixture_mcp", status: "failed", providerCategory: "slack", toolNames: [] },
      ]);
      expect(JSON.stringify(inventory)).not.toContain("secret-canary");
      for (const entry of inventory) IntegrationInventoryEntrySchema.parse(entry);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("offers fixtures beside Claude's account connectors, never to Codex, and never shadowing a connector", async () => {
    const fixture = { serverName: "atlassian", sourceKind: "fixture_mcp" as const, status: "connected" as const, providerCategory: "jira" as const, toolNames: ["getJiraIssue"] };
    const discovery = new NativeIntegrationDiscovery({
      codex: async () => [],
      claude: async () => [{ name: "claude.ai Slack", status: "connected", scope: "claudeai", tools: ["slack_read_thread"] }],
      fixtures: async () => [fixture, { ...fixture, serverName: "claude_ai_Slack" }],
    });
    expect((await discovery.discover("claude-code")).map(entry => `${entry.sourceKind}:${entry.serverName}`)).toEqual(["account_connector:claude_ai_Slack", "fixture_mcp:atlassian"]);
    expect(await discovery.discover("codex")).toEqual([]);
  });
});
