/**
 * The browser a QA or validator agent drives (native-only plan step 6): Microsoft's
 * Playwright MCP server, bundled into the Claude Code and Codex offline agent
 * packages at the version pinned here and in `release/native-agent-builds.json`
 * (`browser`). It runs on the package's own Node; it is never fetched from a
 * registry at runtime. The browser itself is not bundled: the installed Google
 * Chrome is used when present, else Playwright's Chromium is installed on
 * first use.
 */
export const BROWSER_MCP_PACKAGE = Object.freeze({
  package: "@playwright/mcp",
  version: "0.0.82",
  bin: "playwright-mcp",
  /** The agents whose offline package carries it (DeepSeek Harness has no package to carry it). */
  agents: Object.freeze(["claude-code", "codex"] as const),
});

/** Where the connector's launcher for it sits inside an agent package. */
export const BROWSER_MCP_LAUNCHER_PATH = "konteks/browser-mcp.js";
