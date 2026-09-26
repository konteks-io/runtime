/**
 * The launcher's logic (browser-mcp.ts runs it): starts Playwright MCP with
 * exactly the flags the connector composed and an environment without
 * Playwright overrides, hides the tools Konteks never allows, and installs
 * Playwright's Chromium on the first tool call when asked to (no Chrome on
 * this computer). Node built-ins only: it runs from an agent package.
 *
 * MCP stdio messages are newline-delimited JSON-RPC; anything else passes
 * through untouched.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isDeniedBrowserTool } from "./browser-tools.js";

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: unknown }; result?: { tools?: Array<{ name?: unknown }> } };

export interface BrowserLauncherOptions {
  cli: string;
  flags: string[];
  env: NodeJS.ProcessEnv;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  execPath?: string;
  onExit: (code: number) => void;
}

/** The environment Playwright MCP gets: no PLAYWRIGHT_MCP_* config, no loopback proxy bypass, no install switch. */
export function launcherEnvironment(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; installChromium: boolean } {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PLAYWRIGHT_MCP_") || key === "PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK" || key === "KONTEKS_BROWSER_INSTALL") continue;
    out[key] = value;
  }
  return { env: out, installChromium: env.KONTEKS_BROWSER_INSTALL === "chromium" };
}

export function startBrowserLauncher(options: BrowserLauncherOptions): void {
  const execPath = options.execPath ?? process.execPath;
  const { env, installChromium } = launcherEnvironment(options.env);
  const child = spawn(execPath, [options.cli, ...options.flags], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.pipe(options.stderr, { end: false });
  child.on("exit", (code, signal) => options.onExit(code ?? (signal ? 1 : 0)));
  child.on("error", error => {
    options.stderr.write(`konteks browser: Playwright MCP could not start: ${error.message}\n`);
    options.onExit(1);
  });

  const toolListIds = new Set<string | number>();
  let installed: Promise<string | null> | null = installChromium ? null : Promise.resolve(null);
  let queue: Promise<void> = Promise.resolve();
  const reply = (message: unknown) => void options.stdout.write(`${JSON.stringify(message)}\n`);
  const toChild = (line: string) => void child.stdin.write(`${line}\n`);

  // Installs once; resolves to an error message, or null when it is ready.
  const ensureChromium = (): Promise<string | null> => {
    installed ??= new Promise(resolve => {
      options.stderr.write("konteks browser: installing Playwright's Chromium (no Google Chrome on this computer); this happens once.\n");
      const run = spawn(execPath, [options.cli, "install-browser", "chromium"], { stdio: ["ignore", "ignore", "pipe"], env });
      run.stderr.pipe(options.stderr, { end: false });
      run.on("error", error => resolve(error.message));
      run.on("exit", code => resolve(code === 0 ? null : `the install exited with code ${code}`));
    });
    return installed;
  };

  const fromAgent = async (line: string): Promise<void> => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return toChild(line); }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return toChild(line);
    if (message.method === "tools/list" && message.id !== undefined && message.id !== null) toolListIds.add(message.id);
    if (message.method === "tools/call" && message.id !== undefined) {
      const name = typeof message.params?.name === "string" ? message.params.name : "";
      if (isDeniedBrowserTool(name)) {
        return reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name} is not available in Konteks: this browser only opens, reads and operates this session's preview.` }], isError: true } });
      }
      const failure = await ensureChromium();
      if (failure !== null) {
        installed = null; // tried again on the next call
        return reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `The browser could not be installed on this computer (${failure}). Install Google Chrome, or try again.` }], isError: true } });
      }
    }
    toChild(line);
  };

  const fromServer = (line: string): void => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return void options.stdout.write(`${line}\n`); }
    if (message && typeof message === "object" && message.id !== undefined && message.id !== null && toolListIds.has(message.id)) {
      toolListIds.delete(message.id);
      if (Array.isArray(message.result?.tools)) {
        message.result.tools = message.result.tools.filter(tool => !(typeof tool.name === "string" && isDeniedBrowserTool(tool.name)));
        return reply(message);
      }
    }
    options.stdout.write(`${line}\n`);
  };

  // In order: a call waiting on the one-time install holds the messages after it.
  createInterface({ input: options.stdin }).on("line", line => { queue = queue.then(() => fromAgent(line)); });
  options.stdin.on("end", () => { void queue.then(() => child.stdin.end()); });
  createInterface({ input: child.stdout }).on("line", fromServer);
}
