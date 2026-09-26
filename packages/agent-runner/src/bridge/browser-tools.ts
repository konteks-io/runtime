/**
 * The browser tools' names and the ones Konteks never allows. Kept free of
 * imports: the launcher (browser-mcp.ts) runs from an agent package with only
 * Node, next to this file.
 */

/** The ACP MCP server name: Claude Code shows its tools as `mcp__konteks-browser__<tool>`. */
export const BROWSER_MCP_SERVER_NAME = "konteks-browser";

/**
 * Tools the launcher hides from the agent and refuses if called anyway:
 * `browser_run_code_unsafe` runs arbitrary JavaScript in the MCP server's own
 * Node process (outside the browser and its gateway), and the network tools
 * can rewrite what the page is served. Any other tool named `*_unsafe` too.
 */
export const BROWSER_DENIED_TOOLS: readonly string[] = Object.freeze([
  "browser_run_code_unsafe", "browser_route", "browser_unroute", "browser_route_list", "browser_network_state_set",
]);

export function isDeniedBrowserTool(name: string): boolean {
  return BROWSER_DENIED_TOOLS.includes(name) || /_unsafe$/.test(name);
}

/**
 * The browser tool an ACP permission title names, if any: Claude Code's
 * `mcp__konteks-browser__browser_click`, or `konteks-browser.browser_click`
 * / `konteks-browser__browser_click` / `konteks-browser/browser_click`.
 */
export function browserToolFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const match = /^(?:mcp__)?konteks-browser(?:__|\.|\/|:)([A-Za-z0-9_-]+)/.exec(title.trim());
  return match ? match[1]! : null;
}
