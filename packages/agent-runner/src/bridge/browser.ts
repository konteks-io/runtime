import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { BROWSER_MCP_PACKAGE } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { BROWSER_MCP_SERVER_NAME } from "./browser-tools.js";

export { BROWSER_MCP_SERVER_NAME, BROWSER_DENIED_TOOLS, browserToolFromTitle, isDeniedBrowserTool } from "./browser-tools.js";

/**
 * What the supervisor asks for when a session gets a browser: the session's
 * browser gateway (an HTTP proxy on loopback that admits only that session's
 * running preview), a folder for screenshots and the like, and where
 * Playwright's own Chromium lives when there is no Chrome.
 */
export interface BrowserSessionRequest {
  proxyUrl: string;
  outputDir: string;
  browsersPath: string;
}

/** Origins the MCP server lets the page request: loopback only (the gateway narrows it to the preview's port). */
export const BROWSER_ALLOWED_ORIGINS = "http://127.0.0.1:*;http://localhost:*";

/** Where Playwright's `chrome` channel looks for Google Chrome, per platform. */
export function chromeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  switch (platform) {
    case "darwin": return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ...(env.HOME ? [join(env.HOME, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")] : [])];
    case "win32": return [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter((root): root is string => !!root).map(root => join(root, "Google", "Chrome", "Application", "chrome.exe"));
    default: return ["/opt/google/chrome/chrome"];
  }
}

export function chromeInstalled(exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return chromeCandidates(platform, env).some(path => exists(path));
}

/** The browser version this runner's agent package carries, or null when it carries none (DeepSeek Harness, older packages). */
export function bundledBrowserVersion(config: RunnerConfig): string | null {
  const browser = config.RUNNER_NATIVE_PACKAGE_PROFILE?.browser;
  return browser && browser.version === BROWSER_MCP_PACKAGE.version ? browser.version : null;
}

/**
 * The ACP stdio MCP server entry for the session's browser, or null when this
 * agent's package has none. Headless, an in-memory profile, every request
 * through the session's gateway (Chromium sends loopback through a proxy too,
 * so the gateway sees all of it), loopback origins only, no service workers,
 * no page-registered tools. Installed Chrome when present, else Playwright's
 * Chromium (installed by the launcher on first use).
 */
export function browserMcpServer(config: RunnerConfig, request: BrowserSessionRequest, deps: { chrome?: () => boolean } = {}): McpServerStdio | null {
  const profile = config.RUNNER_NATIVE_PACKAGE_PROFILE;
  const browser = profile?.browser;
  if (!profile?.node || !browser || bundledBrowserVersion(config) === null) return null;
  const path = (entry: string) => join(config.RUNNER_BRIDGE_PREFIX, ...entry.split("/"));
  const chrome = (deps.chrome ?? chromeInstalled)();
  return {
    name: BROWSER_MCP_SERVER_NAME,
    command: path(profile.node.entrypoint),
    args: [
      path(browser.launcher), path(browser.entrypoint),
      "--headless", "--isolated",
      "--browser", chrome ? "chrome" : "chromium",
      "--proxy-server", request.proxyUrl,
      "--allowed-origins", BROWSER_ALLOWED_ORIGINS,
      "--block-service-workers", "--no-webmcp",
      "--caps", "testing",
      "--output-dir", request.outputDir,
    ],
    env: [
      { name: "PLAYWRIGHT_BROWSERS_PATH", value: request.browsersPath },
      ...(chrome ? [] : [{ name: "KONTEKS_BROWSER_INSTALL", value: "chromium" }]),
    ],
  };
}
