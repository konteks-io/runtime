import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { packageBrowser, type RunnerBrowser, type RunnerConfig } from "@konteks/remote-agent-runner";
import { locatePersonNode, personNodeCandidates } from "./dsh-installation.js";

/**
 * The QA browser as a connector capability.
 *
 * The browser (Playwright MCP, pinned by the release) is packaged inside the
 * Claude Code and Codex offline agent packages, with the connector's launcher.
 * It is offered to EVERY agent's sessions (Claude Code, Codex, DeepSeek
 * Harness, OpenCode) under the same per-session gateway, origin allow-list,
 * hidden unsafe tools and `environment_open` flow. Claude Code and Codex keep
 * running the copy in their own package; any other agent runs the copy of an
 * installed Claude Code (first) or Codex package, on:
 *
 *   1. the Node bundled with that package (then with the other package);
 *   2. else the person's own Node, found by the DeepSeek Harness Node locator
 *      (the Node dsh already runs on first, then PATH and the usual install
 *      locations), version-checked against Playwright's engines (Node 20+).
 *
 * Without the package there is nothing to run; without a usable Node there is
 * nothing to run it on. Either way the connector has no browser: doctor says
 * so plainly and the connector does not advertise `browser_tool`.
 */

/** The capability the agent runner component advertises while its agents get the QA browser (packages `KNOWN_REMOTE_CAPABILITIES`). */
export const BROWSER_TOOL_CAPABILITY = "browser_tool";

/** Playwright (the browser MCP server's engine) needs Node 20 or newer. */
const BROWSER_NODE_MINIMUM_MAJOR = 20;

export type ConnectorBrowserStatus =
  | { available: true; browser: RunnerBrowser }
  | { available: false; reason: "no_package" | "no_node"; message: string };

interface ConnectorBrowserDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** `node --version` of a candidate (the person's Node only). */
  version?: (node: string) => Promise<string | null>;
  /** Whether a package's bundled Node can run. */
  executable?: (path: string) => Promise<boolean>;
}

const PACKAGE_ORDER = ["claude-code", "codex"] as const;

export const BROWSER_NO_PACKAGE_MESSAGE = "No QA browser on this computer: it comes with the Claude Code or Codex package and neither is installed here, so QA and validator sessions check work without opening one. Add one with `konteks-remote agent add claude-code` (or `codex`).";
export const BROWSER_NO_NODE_MESSAGE = `No QA browser on this computer: it needs Node ${BROWSER_NODE_MINIMUM_MAJOR} or newer and none was found, so QA and validator sessions check work without opening one. Install Node from https://nodejs.org, then restart the connector.`;

export function browserNodeSupported(reported: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(reported.trim());
  return match !== null && Number(match[1]) >= BROWSER_NODE_MINIMUM_MAJOR;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(await realpath(path));
    if (!info.isFile()) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The connector's QA browser, resolved once when the supervisor starts. */
export async function resolveConnectorBrowser(runners: readonly RunnerConfig[], deps: ConnectorBrowserDeps = {}): Promise<ConnectorBrowserStatus> {
  const packaged = PACKAGE_ORDER.flatMap(agentId => {
    const runner = runners.find(candidate => candidate.RUNNER_AGENT_ID === agentId);
    const browser = runner ? packageBrowser(runner) : null;
    return browser ? [browser] : [];
  });
  const source = packaged[0];
  if (source === undefined) return { available: false, reason: "no_package", message: BROWSER_NO_PACKAGE_MESSAGE };
  const executable = deps.executable ?? isExecutableFile;
  for (const candidate of packaged) {
    if (await executable(candidate.node)) return { available: true, browser: { ...source, node: candidate.node, nodeSource: "agent_package" } };
  }
  const node = await personBrowserNode(runners, deps);
  if (node === null) return { available: false, reason: "no_node", message: BROWSER_NO_NODE_MESSAGE };
  return { available: true, browser: { ...source, node, nodeSource: "person" } };
}

/** The Node the person's DeepSeek Harness already runs on (Node 22.19+), then the usual places. */
async function personBrowserNode(runners: readonly RunnerConfig[], deps: ConnectorBrowserDeps): Promise<string | null> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const dshNode = runners.find(runner => runner.RUNNER_AGENT_ID === "dsh")?.RUNNER_NATIVE_DSH_NODE;
  const person = await locatePersonNode([...(dshNode ? [dshNode] : []), ...personNodeCandidates(env, platform)], browserNodeSupported, platform,
    deps.version ? { version: deps.version } : {});
  return person.node;
}

/**
 * Hand the connector's browser to every runner whose own package carries
 * none (DeepSeek Harness, OpenCode). Claude Code and Codex keep their own,
 * unchanged.
 */
export function withConnectorBrowser(runners: readonly RunnerConfig[], status: ConnectorBrowserStatus): RunnerConfig[] {
  return runners.map(runner => {
    const rest: RunnerConfig = { ...runner };
    delete rest.RUNNER_BROWSER;
    if (!status.available || packageBrowser(runner) !== null) return rest;
    return { ...rest, RUNNER_BROWSER: status.browser };
  });
}
