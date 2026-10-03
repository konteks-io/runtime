import { describe, expect, it } from "vitest";
import { IntegrationTaskSpecSchema } from "@konteks/backstage-plugin-common";
import { buildIntegrationPrompt } from "../integration/prompt.js";

describe("buildIntegrationPrompt", () => {
  it("names each admitted tool and the fixed arguments a read must carry", () => {
    const spec = IntegrationTaskSpecSchema.parse({
      schemaVersion: 1, taskId: "xi-1", agentId: "claude-code", phase: "verify",
      binding: { bindingId: "b1", revision: 1, source: { kind: "account_connector", serverName: "claude_ai_Atlassian" } },
      admittedTools: [
        { server: "claude_ai_Atlassian", tool: "executeRead", mode: "read", requiredArgs: { name: "listJiraIssueComments" } },
        { server: "claude_ai_Atlassian", tool: "getJiraIssue", mode: "read" },
      ],
      instructions: "Read back comment 10000 on SCRUM-1.", resultSchema: { type: "object" },
      limits: { maxToolCalls: 4, maxBytes: 65536, deadlineMs: 60000 },
    });
    const prompt = buildIntegrationPrompt(spec, "schema");
    expect(prompt).toContain('- executeRead (read), always with these arguments set exactly: {"name":"listJiraIssueComments"}');
    expect(prompt).toContain("- getJiraIssue (read)\n");
  });
});
