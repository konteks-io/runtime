import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { BROWSER_MCP_PACKAGE } from "@konteks/remote-release";
import type { RunnerBrowser, RunnerConfig } from "../config.js";
import { BROWSER_MCP_SERVER_NAME, BROWSER_ORIGINS_ENV, BROWSER_ORIGINS_PATH } from "./browser-tools.js";

export { BROWSER_MCP_SERVER_NAME, BROWSER_ORIGINS_PATH, browserToolFromTitle, isDeniedBrowserTool } from "./browser-tools.js";

/**
 * What the supervisor asks for when a session gets a browser: the session's
 * browser gateway (an HTTP proxy on loopback that admits only that session's
 * running preview), a folder for screenshots and the like, and where
 * Playwright's own Chromium lives when there is no Chrome.
 */
interface BrowserSessionRequest {
  proxyUrl: string;
  outputDir: string;
  browsersPath: string;
}

/**
 * Origins the MCP server lets the page request at start: loopback only (the
 * gateway narrows it to the preview's port). The launcher adds the origins
 * Core opens for the session later (see browser-launcher.ts).
 */
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

/**
 * The browser this runner's own agent package carries (Claude Code, Codex),
 * run on that package's own Node; null for a package without one (an older
 * package) or an agent with no package (DeepSeek Harness, OpenCode).
 */
export function packageBrowser(config: RunnerConfig): RunnerBrowser | null {
  const profile = config.RUNNER_NATIVE_PACKAGE_PROFILE;
  const browser = profile?.browser;
  if (!profile?.node || !browser || browser.version !== BROWSER_MCP_PACKAGE.version) return null;
  const path = (entry: string) => join(config.RUNNER_BRIDGE_PREFIX, ...entry.split("/"));
  return { version: browser.version, packageAgent: profile.agentId, nodeSource: "agent_package",
    node: path(profile.node.entrypoint), launcher: path(browser.launcher), entrypoint: path(browser.entrypoint) };
}

/**
 * The QA browser a session of this runner gets (a connector capability,
 * not an agent package feature). Claude Code and Codex keep the one in their
 * own package; any other agent gets the one the supervisor resolved for the
 * connector (`RUNNER_BROWSER`); null when the connector has none.
 */
export function runnerBrowser(config: RunnerConfig): RunnerBrowser | null {
  const own = packageBrowser(config);
  if (own) return own;
  const shared = config.RUNNER_BROWSER;
  return shared && shared.version === BROWSER_MCP_PACKAGE.version ? shared : null;
}

/** The browser (Playwright MCP) version this runner's sessions get, or null when the connector has none. */
export function runnerBrowserVersion(config: RunnerConfig): string | null {
  return runnerBrowser(config)?.version ?? null;
}

/**
 * The ACP stdio MCP server entry for the session's browser, or null when the
 * connector has none. The agent launches it: the resolved Node runs the
 * connector's launcher, which runs Playwright MCP. Headless, an in-memory
 * profile, every request through the session's gateway (Chromium sends
 * loopback through a proxy too, so the gateway sees all of it), loopback
 * origins only, no service workers, no page-registered tools. Installed
 * Chrome when present, else Playwright's Chromium (installed by the launcher
 * on first use).
 */
export function browserMcpServer(config: RunnerConfig, request: BrowserSessionRequest, deps: { chrome?: () => boolean } = {}): McpServerStdio | null {
  const browser = runnerBrowser(config);
  if (browser === null) return null;
  const chrome = (deps.chrome ?? chromeInstalled)();
  return {
    name: BROWSER_MCP_SERVER_NAME,
    command: browser.node,
    args: [
      browser.launcher, browser.entrypoint,
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
      { name: BROWSER_ORIGINS_ENV, value: `${request.proxyUrl}${BROWSER_ORIGINS_PATH}` },
      ...(chrome ? [] : [{ name: "KONTEKS_BROWSER_INSTALL", value: "chromium" }]),
    ],
  };
}
