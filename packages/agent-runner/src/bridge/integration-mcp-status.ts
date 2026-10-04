import { spawn as spawnChild } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { RunnerConfig } from "../config.js";
import { bridgeEnvironment, resolveBridgeFamily } from "./spec.js";
import { connectCodexLocalTransport } from "./codex-local-transport.js";

/**
 * Model-free MCP discovery for integrations (external-integration CP2,
 * capabilities-and-execution "Enrollment algorithm" step 1): the agents' own
 * reviewed listing interfaces, never a configuration file. Both readers hand
 * back RAW status objects in memory only; the supervisor's allowlist
 * (`integration/discovery.ts`) is the only thing that may look at them, and
 * nothing here logs them.
 */

const CODEX_DEADLINE_MS = 30_000;
const CODEX_MAX_PAGES = 32;
const CODEX_MAX_LINE = 8 * 1024 * 1024;

/**
 * Codex: `mcpServerStatus/list` with `detail: toolsAndAuthOnly` on the
 * connector's shared app-server (pinned 0.153.4 schema), every page.
 */
export async function readCodexMcpServerStatus(connect: () => Promise<Duplex>): Promise<unknown[]> {
  const stream = await connect();
  const lines = createInterface({ input: stream, terminal: false, crlfDelay: Infinity });
  let id = 0;
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  let failed = false;
  const fail = (reason = "Codex MCP status discovery unavailable") => {
    failed = true;
    pending?.reject(new Error(reason));
    pending = null;
  };
  lines.on("line", line => {
    if (line.length > CODEX_MAX_LINE) return fail();
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    try { message = JSON.parse(line); } catch { return fail(); }
    if (typeof message.method === "string" && message.id !== undefined) {
      // A discovery client answers nothing the server asks.
      stream.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported discovery request" } })}\n`);
      return;
    }
    if (!pending || message.id !== pending.id) return;
    const current = pending;
    pending = null;
    if (message.error !== undefined) current.reject(new Error("Codex MCP status request failed"));
    else current.resolve(message.result);
  });
  // Every stream error (destroying a duplex can emit more than one) fails closed.
  stream.on("error", () => fail());
  stream.once("close", () => fail());
  const timer = setTimeout(() => { fail(); stream.destroy(); }, CODEX_DEADLINE_MS);
  timer.unref();
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (failed || stream.destroyed) return reject(new Error("Codex MCP status discovery unavailable"));
    if (pending) return reject(new Error("Concurrent Codex discovery request"));
    pending = { id: ++id, resolve, reject };
    stream.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request("initialize", { clientInfo: { name: "konteks_integration_discovery", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    stream.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const servers: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= CODEX_MAX_PAGES) throw new Error("Codex MCP status exceeded its page bound");
      const result = await request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 64, ...(cursor ? { cursor } : {}) }) as { data?: unknown; nextCursor?: unknown } | null;
      if (!result || !Array.isArray(result.data)) throw new Error("Codex MCP status response was malformed");
      servers.push(...result.data);
      const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : null;
      if (next === null) return servers;
      if (seen.has(next)) throw new Error("Codex MCP status cursor repeated");
      seen.add(next);
      cursor = next;
    }
  } finally {
    clearTimeout(timer);
    lines.close();
    stream.destroy();
  }
}

/** The connector's shared Codex app-server socket as a discovery stream. */
export function codexDiscoveryConnection(socketPath: string): () => Promise<Duplex> {
  return () => connectCodexLocalTransport(socketPath);
}

/**
 * The child that asks the bundled Claude Agent SDK for its MCP status. It runs
 * in its own process (the SDK and the Claude CLI never load into the
 * connector), in an empty private folder (so no repository `.mcp.json`
 * exists), with project settings only (no personal settings, C2), hooks off
 * (S0-1), account connectors ON (that is what is being listed) and every tool
 * refused. It writes only name, status, scope and tool names: never config,
 * URLs, commands, env, headers, server info, descriptions or error text.
 * argv: sdkEntry, claudeExecutable, cwd, budgetMs.
 */
export const CLAUDE_MCP_STATUS_SCRIPT = `
import { pathToFileURL } from "node:url";
const [sdkEntry, executable, cwd, budget] = process.argv.slice(1);
const deadline = Date.now() + Math.max(1000, Number(budget) || 60000);
let release;
const never = (async function* () { await new Promise(resolve => { release = resolve; }); })();
let query;
try { ({ query } = await import(pathToFileURL(sdkEntry).href)); } catch { process.exit(2); }
const q = query({ prompt: never, options: { cwd, settingSources: ["project"], strictMcpConfig: false, settings: { disableAllHooks: true },
  pathToClaudeCodeExecutable: executable, permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "discovery runs no tools" }) } });
const ask = () => Promise.race([q.mcpServerStatus(), new Promise((_, reject) => setTimeout(() => reject(new Error("deadline")), Math.max(1, deadline - Date.now())))]);
const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
let out;
try {
  // Claude loads the account's connectors asynchronously: its first answer is
  // often an empty list. Keep asking while the list is still empty (within a
  // short settle window) or any server is still pending.
  const settleUntil = Date.now() + 15000;
  const unsettled = status => Array.isArray(status) &&
    ((status.length === 0 && Date.now() < settleUntil) || status.some(server => server && server.status === "pending"));
  let status = await ask();
  while (unsettled(status) && Date.now() + 1500 < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    status = await ask();
  }
  out = (Array.isArray(status) ? status : []).slice(0, 64).map(server => ({
    name: text(server && server.name, 256),
    status: text(server && server.status, 32),
    scope: text(server && (server.scope ?? (server.config && server.config.scope)), 32),
    tools: Array.isArray(server && server.tools) ? server.tools.slice(0, 256).map(tool => text(tool && tool.name, 128)).filter(Boolean) : [],
  }));
} catch {
  out = undefined;
} finally {
  release?.();
  try { q.close?.(); } catch {}
}
if (out === undefined) process.exit(3);
process.stdout.write(JSON.stringify(out), () => process.exit(0));
`;

export interface ClaudeMcpStatusLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ClaudeMcpStatusEntry {
  name: string;
  status: string;
  scope: string;
  tools: string[];
}

const CLAUDE_MAX_OUTPUT = 1024 * 1024;

/**
 * Run the Claude discovery child and read its reduced output. Its stderr is
 * never read; any failure is one fixed message, never the child's text.
 */
export async function readClaudeMcpStatus(launch: ClaudeMcpStatusLaunch, spawn: typeof spawnChild = spawnChild): Promise<ClaudeMcpStatusEntry[]> {
  const failed = () => new Error("Claude MCP status discovery failed");
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ["ignore", "pipe", "ignore"], detached: false, windowsHide: true });
  let output = "";
  let overflow = false;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (output.length + chunk.length > CLAUDE_MAX_OUTPUT) { overflow = true; child.kill("SIGKILL"); return; }
    output += chunk;
  });
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, launch.timeoutMs);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", exitCode => { clearTimeout(timer); resolve(exitCode); });
  });
  if (code !== 0 || overflow) throw failed();
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw failed(); }
  if (!Array.isArray(parsed)) throw failed();
  return parsed.map(entry => {
    const value = entry as Partial<ClaudeMcpStatusEntry> | null;
    return {
      name: typeof value?.name === "string" ? value.name : "",
      status: typeof value?.status === "string" ? value.status : "",
      scope: typeof value?.scope === "string" ? value.scope : "",
      tools: Array.isArray(value?.tools) ? value.tools.filter((tool): tool is string => typeof tool === "string") : [],
    };
  });
}

/**
 * The discovery child for a native personal Claude runner: the package's own
 * Node, the SDK bundled with the pinned claude-agent-acp, the operator's own
 * `claude` (its official sign-in), the bridge's environment.
 */
export function claudeMcpStatusLaunch(config: RunnerConfig, cwd: string, timeoutMs = 90_000): ClaudeMcpStatusLaunch {
  const profile = config.RUNNER_NATIVE_PACKAGE_PROFILE;
  const executable = config.RUNNER_NATIVE_CLAUDE_EXECUTABLE;
  if (config.RUNNER_AGENT_ID !== "claude-code" || !profile?.node || !executable) {
    throw new RemoteInstanceError("agent_unavailable", "Claude discovery needs the native personal Claude runner.");
  }
  const bridgeEntry = join(config.RUNNER_BRIDGE_PREFIX, ...profile.bridge.entrypoint.split("/"));
  const sdkEntry = createRequire(bridgeEntry).resolve("@anthropic-ai/claude-agent-sdk");
  return {
    command: join(config.RUNNER_BRIDGE_PREFIX, ...profile.node.entrypoint.split("/")),
    args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdkEntry, executable, cwd, String(Math.max(1_000, timeoutMs - 5_000))],
    env: bridgeEnvironment(config, resolveBridgeFamily("claude-code")),
    timeoutMs,
  };
}
