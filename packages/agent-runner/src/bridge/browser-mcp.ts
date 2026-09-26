#!/usr/bin/env node
/**
 * The connector's launcher for the QA browser's MCP server (Playwright MCP),
 * run by the agent (Claude Code or Codex) over stdio from the agent package's
 * own Node: `node konteks/browser-mcp.js <playwright-mcp cli.js> <flags...>`.
 * See browser-launcher.ts.
 */
import { startBrowserLauncher } from "./browser-launcher.js";

const [cli, ...flags] = process.argv.slice(2);
if (!cli) {
  process.stderr.write("konteks browser: no Playwright MCP entry point was given.\n");
  process.exit(2);
}
startBrowserLauncher({
  cli, flags, env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  // Let pending output drain; closing stdin ends the event loop.
  onExit: code => { process.exitCode = code; process.stdin.destroy(); },
});
