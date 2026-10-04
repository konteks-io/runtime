import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserLauncher } from "../bridge/browser-launcher.js";
import { readClaudeMcpStatus } from "../bridge/integration-mcp-status.js";

const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  ...processes,
}));

const streams: PassThrough[] = [];
function stream(): PassThrough { const value = new PassThrough(); streams.push(value); return value; }
function child() {
  return Object.assign(new EventEmitter(), { stdin: stream(), stdout: stream(), stderr: stream(), kill: vi.fn() });
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { for (const value of streams.splice(0)) value.destroy(); });

describe("Windows browser and integration helpers", () => {
  it("discovers Claude MCP status without opening a console", async () => {
    processes.spawn.mockImplementation(() => {
      const process = child();
      queueMicrotask(() => { process.stdout.end("[]"); process.emit("close", 0); });
      return process;
    });
    await expect(readClaudeMcpStatus({ command: "node.exe", args: ["status.mjs"], env: {}, timeoutMs: 5_000 })).resolves.toEqual([]);
    expect(processes.spawn).toHaveBeenCalledWith("node.exe", ["status.mjs"], expect.objectContaining({ windowsHide: true, detached: false, stdio: ["ignore", "pipe", "ignore"] }));
  });

  it("starts Playwright MCP and its one-time Chromium installer without console windows", async () => {
    processes.spawn.mockImplementation((_command: string, args: string[]) => {
      const process = child();
      if (args.includes("install-browser")) queueMicrotask(() => process.emit("exit", 0));
      return process;
    });
    const stdin = stream();
    startBrowserLauncher({ cli: "playwright.mjs", flags: ["--headless"], env: { KONTEKS_BROWSER_INSTALL: "chromium" }, stdin, stdout: stream(), stderr: stream(), execPath: "node.exe", onExit: vi.fn() });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_navigate" } })}\n`);
    await vi.waitFor(() => expect(processes.spawn).toHaveBeenCalledTimes(2));
    expect(processes.spawn).toHaveBeenNthCalledWith(1, "node.exe", ["playwright.mjs", "--headless"], expect.objectContaining({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
    expect(processes.spawn).toHaveBeenNthCalledWith(2, "node.exe", ["playwright.mjs", "install-browser", "chromium"], expect.objectContaining({ windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
  });
});
