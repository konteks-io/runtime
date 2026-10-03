import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_MCP_STATUS_SCRIPT, readClaudeMcpStatus, readCodexMcpServerStatus } from "../bridge/integration-mcp-status.js";

const CANARY = "sk-canary-7f3a9c";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kr-mcp-status-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A fake app-server on one duplex: answers initialize and pages of mcpServerStatus/list. */
function fakeCodex(pages: unknown[]): { client: Duplex; seen: Array<{ method: string; params: unknown }> } {
  const seen: Array<{ method: string; params: unknown }> = [];
  let buffered = "";
  const client: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) {
        const message = JSON.parse(line) as { id?: number | string; method?: string; params: unknown };
        if (message.method === undefined) continue; // the client's answer to the server's own request
        seen.push({ method: message.method, params: message.params });
        if (message.id === undefined) continue;
        if (message.method === "initialize") {
          // The server may ask the client things; a discovery client refuses them.
          client.push(`${JSON.stringify({ id: "srv-1", method: "item/tool/requestUserInput", params: {} })}\n`);
          client.push(`${JSON.stringify({ id: message.id, result: { userAgent: "codex" } })}\n`);
          continue;
        }
        const cursor = (message.params as { cursor?: string }).cursor;
        const index = cursor === undefined ? 0 : Number(cursor);
        client.push(`${JSON.stringify({ id: message.id, result: { data: pages[index], nextCursor: index + 1 < pages.length ? String(index + 1) : null } })}\n`);
      }
      done();
    },
  });
  return { client, seen };
}

describe("Codex MCP status discovery (model-free, app-server mcpServerStatus/list)", () => {
  it("reads every page with tools and auth only, and refuses the server's own requests", async () => {
    const page1 = [{ name: "atlassian", authStatus: "oAuth", runtimeStatus: "connected", tools: { getJiraIssue: { name: "getJiraIssue", inputSchema: {} } }, resources: [], resourceTemplates: [] }];
    const page2 = [{ name: "slack", authStatus: "notLoggedIn", tools: {}, resources: [], resourceTemplates: [] }];
    const { client, seen } = fakeCodex([page1, page2]);
    const servers = await readCodexMcpServerStatus(async () => client);
    expect(servers).toEqual([...page1, ...page2]);
    expect(seen.map(entry => entry.method)).toEqual(["initialize", "initialized", "mcpServerStatus/list", "mcpServerStatus/list"]);
    expect(seen[2]!.params).toMatchObject({ detail: "toolsAndAuthOnly" });
  });

  it("stops at its page bound", async () => {
    const pages = Array.from({ length: 40 }, (_, index) => [{ name: `s${index}`, authStatus: "unknown", tools: {}, resources: [], resourceTemplates: [] }]);
    await expect(readCodexMcpServerStatus(async () => fakeCodex(pages).client)).rejects.toThrow(/bound/);
  });
});

describe("Claude MCP status discovery (model-free, Agent SDK mcpServerStatus in a child)", () => {
  it("passes only names, status, scope and tool names out of the child process", async () => {
    // A fake SDK whose status carries everything a real one may: URLs, headers, commands, env, error text.
    const sdk = join(dir, "sdk.mjs");
    await writeFile(sdk, `
      export function query({ options }) {
        globalThis.__options = options;
        return {
          async mcpServerStatus() {
            return [
              { name: "claude.ai Atlassian", status: "connected", scope: "claudeai",
                config: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/?token=${CANARY}", id: "${CANARY}" },
                serverInfo: { name: "${CANARY}", version: "1" },
                tools: [{ name: "getJiraIssue", description: "${CANARY}", annotations: { readOnly: true } }] },
              { name: "local", status: "failed", error: "spawn failed: ${CANARY}",
                config: { type: "stdio", command: "npx", args: ["--token", "${CANARY}"], env: { API_KEY: "${CANARY}" } } },
              { name: "opts", status: "connected", scope: JSON.stringify(globalThis.__options).length > 0 ? "project" : "x", tools: [] },
            ];
          },
          close() {},
        };
      }`);
    const servers = await readClaudeMcpStatus({ command: process.execPath, args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdk, "/bin/false", dir, "5000"], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
    expect(JSON.stringify(servers)).not.toContain(CANARY);
    expect(servers).toEqual([
      { name: "claude.ai Atlassian", status: "connected", scope: "claudeai", tools: ["getJiraIssue"] },
      { name: "local", status: "failed", scope: "", tools: [] },
      { name: "opts", status: "connected", scope: "project", tools: [] },
    ]);
  });

  it("keeps asking while Claude's first answers are still empty, then reports the account connectors", async () => {
    // Claude loads claude.ai connectors asynchronously: the first status is an empty list.
    const sdk = join(dir, "sdk.mjs");
    await writeFile(sdk, `
      let calls = 0;
      export function query() {
        return {
          async mcpServerStatus() {
            calls += 1;
            if (calls < 3) return [];
            return [{ name: "claude.ai Atlassian", status: "connected", scope: "claudeai", tools: [{ name: "getJiraIssue" }] }];
          },
          close() {},
        };
      }`);
    const servers = await readClaudeMcpStatus({ command: process.execPath, args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdk, "/bin/false", dir, "8000"], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 12_000 });
    expect(servers).toEqual([{ name: "claude.ai Atlassian", status: "connected", scope: "claudeai", tools: ["getJiraIssue"] }]);
  });

  it("reports an empty list once the settle window or the budget runs out", async () => {
    const sdk = join(dir, "sdk.mjs");
    await writeFile(sdk, `export function query() { return { async mcpServerStatus() { return []; }, close() {} }; }`);
    const started = Date.now();
    await expect(readClaudeMcpStatus({ command: process.execPath, args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdk, "/bin/false", dir, "4000"], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 })).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(9_000);
  });

  it("asks for account connectors with no hooks and no tool use, in the given empty folder", async () => {
    const sdk = join(dir, "sdk.mjs");
    await writeFile(sdk, `
      export function query({ options }) {
        return { async mcpServerStatus() { return [{ name: JSON.stringify({ settingSources: options.settingSources, strict: options.strictMcpConfig, settings: options.settings, cwd: options.cwd, exe: options.pathToClaudeCodeExecutable, tool: typeof options.canUseTool }), status: "connected", tools: [] }]; }, close() {} };
      }`);
    const [server] = await readClaudeMcpStatus({ command: process.execPath, args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdk, "/opt/claude", dir, "5000"], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
    expect(JSON.parse(server!.name)).toEqual({ settingSources: ["project"], strict: false, settings: { disableAllHooks: true }, cwd: dir, exe: "/opt/claude", tool: "function" });
  });

  it("fails closed, without output, when the child fails or overruns", async () => {
    const sdk = join(dir, "sdk.mjs");
    await writeFile(sdk, `export function query() { return { async mcpServerStatus() { throw new Error("${CANARY}"); }, close() {} }; }`);
    await expect(readClaudeMcpStatus({ command: process.execPath, args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdk, "/bin/false", dir, "5000"], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 }))
      .rejects.toThrow(/^Claude MCP status discovery failed$/);
    await writeFile(sdk, `export function query() { return { mcpServerStatus: () => new Promise(() => {}), close() {} }; }`);
    await expect(readClaudeMcpStatus({ command: process.execPath, args: ["--input-type=module", "-e", CLAUDE_MCP_STATUS_SCRIPT, sdk, "/bin/false", dir, "60000"], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 1_500 }))
      .rejects.toThrow(/^Claude MCP status discovery failed$/);
  });
});
