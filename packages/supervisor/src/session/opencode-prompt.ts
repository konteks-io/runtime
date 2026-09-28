import { STRUCTURED_RESULT_MCP_SERVER_NAME, STRUCTURED_RESULT_TOOL_NAME } from "@konteks/agent-core";

/**
 * How an OpenCode 2 session is told to call Konteks tools. OpenCode reaches
 * MCP tools only through Code Mode (`execute`), and Konteks runs a block only
 * in one form (opencode-code-mode.ts). A refusal travels to OpenCode as a
 * bare "rejected" (ACP carries no reason with it), so the form is given up
 * front, in the first prompt, with the servers this session actually has.
 */

/** The turn result tool as an OpenCode session calls it. */
export const openCodeResultToolReference = `await tools["${STRUCTURED_RESULT_MCP_SERVER_NAME}"].${STRUCTURED_RESULT_TOOL_NAME}({ ... })`;

/** The one line an OpenCode session's first prompt carries about Konteks tools. */
export function openCodeKonteksToolsLine(servers: Iterable<string>): string {
  const names = [...servers].filter(name => name.startsWith("konteks")).sort();
  const example = names.includes("konteks-platform") ? "konteks-platform" : names[0] ?? STRUCTURED_RESULT_MCP_SERVER_NAME;
  return [
    `Call Konteks tools (${names.map(name => `\`${name}\``).join(", ")}) from your \`execute\` tool, only in this form: `,
    `\`const result = await tools["${example}"].<tool>({ ...literal arguments... });\`, one call per statement, `,
    "then `return result;`. Konteks refuses any other code: no other tools, loops, variables in arguments or built names.",
  ].join("");
}
