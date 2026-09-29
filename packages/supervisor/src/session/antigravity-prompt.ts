import { STRUCTURED_RESULT_MCP_SERVER_NAME, STRUCTURED_RESULT_TOOL_NAME } from "@konteks/agent-core";

/**
 * How a Google Antigravity session is told to call Konteks tools. Antigravity
 * registers no tool per MCP server: the model reaches every one through its
 * single lazy `call_mcp_tool {ServerName, ToolName, Arguments}` (CP0 B10), so
 * a `mcp__<server>__<tool>` name never exists for it. The first prompt names
 * that form with the servers this session actually has, in the same words as
 * the Assistant's hint (`NATIVE_PLATFORM_MCP_SERVER_NAME` = `konteks-platform`,
 * the name `core/client.ts` gives the platform server).
 */

/** The turn result tool as an Antigravity session calls it. */
export const antigravityResultToolReference =
  `\`${STRUCTURED_RESULT_TOOL_NAME}\` through your \`call_mcp_tool\` tool (\`ServerName\` \`${STRUCTURED_RESULT_MCP_SERVER_NAME}\`, \`ToolName\` \`${STRUCTURED_RESULT_TOOL_NAME}\`, its arguments in \`Arguments\`)`;

/** The one line an Antigravity session's first prompt carries about Konteks tools. */
export function antigravityKonteksToolsLine(servers: Iterable<string>): string {
  const names = [...servers].filter(name => name.startsWith("konteks")).sort();
  const example = names.includes("konteks-platform") ? "konteks-platform" : names[0] ?? STRUCTURED_RESULT_MCP_SERVER_NAME;
  return [
    `Call Konteks tools through your \`call_mcp_tool\` tool: \`ServerName\` is the server (${names.map(name => `\`${name}\``).join(", ")}), `,
    `\`ToolName\` is the tool's name exactly as listed, and its parameters go in \`Arguments\` (for example \`ServerName\` \`${example}\`). `,
    "Konteks refuses every other MCP server, subagents and commands outside this working copy.",
  ].join("");
}
