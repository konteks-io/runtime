import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_MCP_PACKAGE, NativeAgentPackageProfileSchema } from "@konteks/remote-release";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { RunnerConfigSchema } from "../config.js";
import { BROWSER_ALLOWED_ORIGINS, BROWSER_MCP_SERVER_NAME, browserMcpServer, browserToolFromTitle, bundledBrowserVersion, chromeCandidates, isDeniedBrowserTool } from "../bridge/browser.js";
import { launcherEnvironment, startBrowserLauncher } from "../bridge/browser-launcher.js";

const digest = `sha256:${"a".repeat(64)}`;
function withBrowser(agentId: "claude-code" | "codex" = "codex") {
  const profile = offlineFixture("macos", "arm64", agentId).profile;
  const files = [...profile.files,
    { path: "konteks/browser-mcp.js", digest, sizeBytes: 1, executable: false },
    { path: "node_modules/@playwright/mcp/cli.js", digest, sizeBytes: 1, executable: false },
  ].sort((a, b) => a.path < b.path ? -1 : 1);
  return NativeAgentPackageProfileSchema.parse({ ...profile, files,
    browser: { package: BROWSER_MCP_PACKAGE.package, version: BROWSER_MCP_PACKAGE.version, entrypoint: "node_modules/@playwright/mcp/cli.js", launcher: "konteks/browser-mcp.js", runtime: "node" } });
}
const request = { proxyUrl: "http://127.0.0.1:50123", outputDir: "/tmp/konteks-browser-x", browsersPath: "/state/browsers" };

describe("the QA browser MCP server", () => {
  it("is part of a Claude Code or Codex package profile only at the pinned version, with its launcher inventoried", () => {
    expect(withBrowser("claude-code").browser?.version).toBe("0.0.82");
    const profile = withBrowser();
    expect(() => NativeAgentPackageProfileSchema.parse({ ...profile, browser: { ...profile.browser, version: "0.0.1" } })).toThrow(/browser MCP server/);
    expect(() => NativeAgentPackageProfileSchema.parse({ ...profile, browser: { ...profile.browser, launcher: "konteks/other.js" } })).toThrow(/browser MCP server/);
  });

  it("is composed as a stdio server run by the package's Node through the connector's launcher, confined to the gateway", () => {
    const config = { ...RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_BRIDGE_PREFIX: "/pkg" }), RUNNER_NATIVE_PACKAGE_PROFILE: withBrowser() };
    expect(bundledBrowserVersion(config)).toBe("0.0.82");
    const chrome = browserMcpServer(config, request, { chrome: () => true })!;
    expect(chrome).toMatchObject({ name: BROWSER_MCP_SERVER_NAME, command: "/pkg/bin/node" });
    expect(chrome.args.slice(0, 2)).toEqual(["/pkg/konteks/browser-mcp.js", "/pkg/node_modules/@playwright/mcp/cli.js"]);
    const flag = (name: string) => chrome.args[chrome.args.indexOf(name) + 1];
    expect(chrome.args).toEqual(expect.arrayContaining(["--headless", "--isolated", "--block-service-workers", "--no-webmcp"]));
    expect(flag("--proxy-server")).toBe(request.proxyUrl);
    expect(flag("--allowed-origins")).toBe(BROWSER_ALLOWED_ORIGINS);
    expect(flag("--browser")).toBe("chrome");
    expect(flag("--output-dir")).toBe(request.outputDir);
    expect(chrome.env).toEqual([{ name: "PLAYWRIGHT_BROWSERS_PATH", value: "/state/browsers" }]);
    // No Chrome: Playwright's Chromium, which the launcher installs on first use.
    const chromium = browserMcpServer(config, request, { chrome: () => false })!;
    expect(chromium.args[chromium.args.indexOf("--browser") + 1]).toBe("chromium");
    expect(chromium.env).toContainEqual({ name: "KONTEKS_BROWSER_INSTALL", value: "chromium" });
  });

  it("is absent for an agent whose package carries none (DeepSeek Harness, older packages)", () => {
    const dsh = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "dsh" });
    expect(bundledBrowserVersion(dsh)).toBeNull();
    expect(browserMcpServer(dsh, request)).toBeNull();
    const older = { ...RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex" }), RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile };
    expect(browserMcpServer(older as never, request)).toBeNull();
  });

  it("names its tools in permission titles and refuses the unsafe ones", () => {
    expect(browserToolFromTitle("mcp__konteks-browser__browser_click")).toBe("browser_click");
    expect(browserToolFromTitle("konteks-browser.browser_snapshot")).toBe("browser_snapshot");
    expect(browserToolFromTitle("mcp__konteks-preview__preview_start")).toBeNull();
    expect(browserToolFromTitle("mcp__konteks-browser-tool__navigate")).toBeNull();
    expect(isDeniedBrowserTool("browser_run_code_unsafe")).toBe(true);
    expect(isDeniedBrowserTool("browser_route")).toBe(true);
    expect(isDeniedBrowserTool("browser_navigate")).toBe(false);
    expect(chromeCandidates("darwin", {})[0]).toContain("Google Chrome.app");
  });
});

describe("the browser launcher", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "browser-launcher-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** A stand-in for Playwright MCP: lists three tools, echoes calls, and records an install. */
  async function fakeCli(installExit = 0): Promise<string> {
    const cli = join(dir, "cli.cjs");
    await writeFile(cli, `
const fs = require("node:fs"); const path = require("node:path");
if (process.argv[2] === "install-browser") { fs.writeFileSync(path.join(${JSON.stringify(dir)}, "installed"), process.argv[3]); process.exit(${installExit}); }
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "browser_navigate" }, { name: "browser_run_code_unsafe" }, { name: "browser_route" }] } }) + "\\n");
  if (m.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: m.params.name + " flags=" + process.argv.slice(2).join(" ") + " installed=" + fs.existsSync(path.join(${JSON.stringify(dir)}, "installed")) + " env=" + Object.keys(process.env).filter(k => k.startsWith("PLAYWRIGHT_")).sort().join(",") }] } }) + "\\n");
});`);
    return cli;
  }

  function launch(cli: string, env: NodeJS.ProcessEnv) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const answers = new Map<number, (message: { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }) => void>();
    createInterface({ input: stdout }).on("line", line => { const message = JSON.parse(line); answers.get(message.id)?.(message); });
    let exited: (code: number) => void = () => undefined;
    const exit = new Promise<number>(resolve => { exited = resolve; });
    startBrowserLauncher({ cli, flags: ["--headless", "--proxy-server", "http://127.0.0.1:1"], env, stdin, stdout, stderr, onExit: code => exited(code) });
    let id = 0;
    const rpc = (method: string, params: unknown) => new Promise<{ result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }>(resolve => {
      const current = ++id;
      answers.set(current, resolve);
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    });
    return { rpc, close: () => { stdin.end(); return exit; } };
  }

  it("hides and refuses the unsafe tools and passes only the composed flags and a clean environment", async () => {
    const launcher = launch(await fakeCli(), { PATH: process.env.PATH, PLAYWRIGHT_BROWSERS_PATH: "/b", PLAYWRIGHT_MCP_CONFIG: "/evil.json", PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1" });
    expect((await launcher.rpc("tools/list", {})).result.tools!.map(tool => tool.name)).toEqual(["browser_navigate"]);
    const refused = await launcher.rpc("tools/call", { name: "browser_run_code_unsafe", arguments: { code: "x" } });
    expect(refused.result).toMatchObject({ isError: true });
    expect(refused.result.content![0]!.text).toContain("not available in Konteks");
    const called = (await launcher.rpc("tools/call", { name: "browser_navigate", arguments: {} })).result.content![0]!.text;
    expect(called).toBe("browser_navigate flags=--headless --proxy-server http://127.0.0.1:1 installed=false env=PLAYWRIGHT_BROWSERS_PATH");
    expect(await launcher.close()).toBe(0);
  });

  it("installs Playwright's Chromium once, on the first tool call, when there is no Chrome", async () => {
    const launcher = launch(await fakeCli(), { PATH: process.env.PATH, KONTEKS_BROWSER_INSTALL: "chromium" });
    await launcher.rpc("tools/list", {});
    expect(existsSync(join(dir, "installed"))).toBe(false);
    expect((await launcher.rpc("tools/call", { name: "browser_navigate", arguments: {} })).result.content![0]!.text).toContain("installed=true");
    await launcher.close();
  });

  it("answers a failed install plainly instead of forwarding the call", async () => {
    const launcher = launch(await fakeCli(3), { PATH: process.env.PATH, KONTEKS_BROWSER_INSTALL: "chromium" });
    const failed = await launcher.rpc("tools/call", { name: "browser_navigate", arguments: {} });
    expect(failed.result).toMatchObject({ isError: true });
    expect(failed.result.content![0]!.text).toContain("could not be installed");
    await launcher.close();
  });

  it("keeps Playwright overrides out of the environment", () => {
    expect(launcherEnvironment({ A: "1", PLAYWRIGHT_MCP_ALLOWED_ORIGINS: "*", KONTEKS_BROWSER_INSTALL: "chromium" })).toEqual({ env: { A: "1" }, installChromium: true });
  });
});
