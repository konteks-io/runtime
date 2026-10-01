import { describe, expect, it } from "vitest";
import { IntegrationInventoryEntrySchema } from "@konteks/backstage-plugin-common";
import { NativeIntegrationDiscovery, providerCategoryOf, sanitizeClaudeMcpStatus, sanitizeCodexMcpStatus } from "../integration/discovery.js";

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

describe("integration discovery allowlist (D26, secret canaries)", () => {
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
