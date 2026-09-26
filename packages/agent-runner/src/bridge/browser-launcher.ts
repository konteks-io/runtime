/**
 * The launcher's logic (browser-mcp.ts runs it): starts Playwright MCP with
 * exactly the flags the connector composed and an environment without
 * Playwright overrides, hides the tools Konteks never allows, and installs
 * Playwright's Chromium on the first tool call when asked to (no Chrome on
 * this computer). Node built-ins only: it runs from an agent package.
 *
 * It also keeps Playwright's own `--allowed-origins` (a second layer behind
 * the session's browser gateway, which is the boundary) in step with the
 * origins Core opened for the session (`environment_open`: a signed-in cloud
 * preview or a registered application). Before each tool call it asks the
 * gateway for them (`KONTEKS_BROWSER_ORIGINS_URL`); when they changed and no
 * call is in flight it restarts Playwright MCP with loopback plus exactly
 * those origins, replaying the agent's own `initialize`. Playwright reads the
 * flag once per browser context, so a restart is the only way to change it;
 * it happens right before the call that opens the new origin, so what that
 * call signs in to survives. If the gateway cannot be asked, the flag stays
 * as it was, which is narrower, never wider.
 *
 * MCP stdio messages are newline-delimited JSON-RPC; anything else passes
 * through untouched.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { get as httpGet } from "node:http";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BROWSER_ORIGINS_ENV, isDeniedBrowserTool } from "./browser-tools.js";

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
  /** Test seam: the origins Core opened for this session, or null when they cannot be read. */
  fetchOrigins?: () => Promise<string[] | null>;
}

const ALLOWED_ORIGINS_FLAG = "--allowed-origins";
const RESTART_HANDSHAKE_MS = 20_000;
const DRAIN_WAIT_MS = 15_000;

/** The environment Playwright MCP gets: no PLAYWRIGHT_MCP_* config, no loopback proxy bypass, no install switch, no origins URL. */
export function launcherEnvironment(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; installChromium: boolean; originsUrl: string | null } {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PLAYWRIGHT_MCP_") || key === "PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK" || key === "KONTEKS_BROWSER_INSTALL" || key === BROWSER_ORIGINS_ENV) continue;
    out[key] = value;
  }
  const originsUrl = env[BROWSER_ORIGINS_ENV];
  return { env: out, installChromium: env.KONTEKS_BROWSER_INSTALL === "chromium", originsUrl: originsUrl && /^http:\/\/127\.0\.0\.1:\d+\//.test(originsUrl) ? originsUrl : null };
}

/** Only well-formed http(s) origins, sorted, so the same set is the same flag. */
export function sanitizeOrigins(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { origins?: unknown }).origins)) return null;
  const out = new Set<string>();
  for (const entry of (value as { origins: unknown[] }).origins) {
    if (typeof entry !== "string") continue;
    try {
      const url = new URL(entry);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === entry) out.add(entry);
    } catch { /* not an origin */ }
  }
  return [...out].sort();
}

/** The gateway's list, asked over loopback; null when it does not answer in time. */
export function fetchGatewayOrigins(url: string, timeoutMs = 2_000): Promise<string[] | null> {
  return new Promise(resolve => {
    const request = httpGet(url, { timeout: timeoutMs }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { if (body.length < 65_536) body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return resolve(null);
        try { resolve(sanitizeOrigins(JSON.parse(body))); } catch { resolve(null); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

/** The flags with `--allowed-origins` set to `value`. */
export function withAllowedOrigins(flags: string[], value: string): string[] {
  const out = [...flags];
  const index = out.indexOf(ALLOWED_ORIGINS_FLAG);
  if (index >= 0 && index + 1 < out.length) out[index + 1] = value;
  else out.push(ALLOWED_ORIGINS_FLAG, value);
  return out;
}

export function startBrowserLauncher(options: BrowserLauncherOptions): void {
  const execPath = options.execPath ?? process.execPath;
  const { env, installChromium, originsUrl } = launcherEnvironment(options.env);
  const fetchOrigins = options.fetchOrigins ?? (originsUrl ? () => fetchGatewayOrigins(originsUrl) : null);
  const flagIndex = options.flags.indexOf(ALLOWED_ORIGINS_FLAG);
  const baseAllowed = flagIndex >= 0 ? options.flags[flagIndex + 1] ?? "" : "";

  const toolListIds = new Set<string | number>();
  /** Requests the agent sent the current child that it has not answered yet. */
  const pending = new Set<string | number>();
  let drained: (() => void) | null = null;
  let installed: Promise<string | null> | null = installChromium ? null : Promise.resolve(null);
  let queue: Promise<void> = Promise.resolve();
  let initializeLine: string | null = null;
  let currentAllowed = baseAllowed;
  let generation = 0;
  let restarts = 0;
  let handshake: { id: string; resolve: () => void } | null = null;
  let child: ChildProcessWithoutNullStreams;

  const reply = (message: unknown) => void options.stdout.write(`${JSON.stringify(message)}\n`);
  const toChild = (line: string) => void child.stdin.write(`${line}\n`);

  const fromServer = (line: string): void => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return void options.stdout.write(`${line}\n`); }
    if (message && typeof message === "object" && message.id !== undefined && message.id !== null) {
      if (handshake && message.id === handshake.id) {
        handshake.resolve();
        return;
      }
      // A response (not a server-to-client request) settles an agent call.
      if (message.method === undefined && pending.delete(message.id) && pending.size === 0) drained?.();
      if (toolListIds.has(message.id)) {
        toolListIds.delete(message.id);
        if (Array.isArray(message.result?.tools)) {
          message.result.tools = message.result.tools.filter(tool => !(typeof tool.name === "string" && isDeniedBrowserTool(tool.name)));
          return reply(message);
        }
      }
    }
    options.stdout.write(`${line}\n`);
  };

  const spawnChild = (allowed: string): ChildProcessWithoutNullStreams => {
    const mine = ++generation;
    const flags = allowed === baseAllowed ? options.flags : withAllowedOrigins(options.flags, allowed);
    const spawned = spawn(execPath, [options.cli, ...flags], { stdio: ["pipe", "pipe", "pipe"], env });
    spawned.stderr.pipe(options.stderr, { end: false });
    // Only the current child ends the launcher; one replaced by a restart does not.
    spawned.on("exit", (code, signal) => { if (mine === generation) options.onExit(code ?? (signal ? 1 : 0)); });
    spawned.on("error", error => {
      if (mine !== generation) return;
      options.stderr.write(`konteks browser: Playwright MCP could not start: ${error.message}\n`);
      options.onExit(1);
    });
    createInterface({ input: spawned.stdout }).on("line", line => { if (mine === generation) fromServer(line); });
    return spawned;
  };
  child = spawnChild(baseAllowed);

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

  const waitForDrain = (): Promise<boolean> => {
    if (pending.size === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => { drained = null; resolve(false); }, DRAIN_WAIT_MS);
      drained = () => { clearTimeout(timer); drained = null; resolve(true); };
    });
  };

  /** Keep Playwright's allowed origins equal to loopback plus what Core opened for this session. */
  const syncAllowedOrigins = async (): Promise<void> => {
    if (!fetchOrigins || initializeLine === null) return;
    const granted = await fetchOrigins();
    if (granted === null) return;
    const desired = [baseAllowed, ...granted].filter(Boolean).join(";");
    if (desired === currentAllowed) return;
    if (!(await waitForDrain())) return;
    const previous = child;
    child = spawnChild(desired);
    previous.kill();
    const id = `konteks-browser-restart-${++restarts}`;
    const init = JSON.parse(initializeLine) as Record<string, unknown>;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, RESTART_HANDSHAKE_MS);
      handshake = { id, resolve: () => { clearTimeout(timer); resolve(); } };
      toChild(JSON.stringify({ ...init, id }));
    });
    handshake = null;
    toChild(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    currentAllowed = desired;
    options.stderr.write(`konteks browser: this session's browser may now also open ${granted.length > 0 ? granted.join(", ") : "nothing beyond its live preview"}.\n`);
  };

  const fromAgent = async (line: string): Promise<void> => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return toChild(line); }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return toChild(line);
    if (message.method === "initialize" && initializeLine === null) initializeLine = line;
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
      await syncAllowedOrigins();
    }
    if (message.method !== undefined && message.id !== undefined && message.id !== null) pending.add(message.id);
    toChild(line);
  };

  // In order: a call waiting on the one-time install (or a restart) holds the messages after it.
  createInterface({ input: options.stdin }).on("line", line => { queue = queue.then(() => fromAgent(line)); });
  options.stdin.on("end", () => { void queue.then(() => child.stdin.end()); });
}
