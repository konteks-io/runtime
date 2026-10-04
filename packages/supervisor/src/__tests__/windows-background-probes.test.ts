import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeExecutableIdentity } from "../native/claude-executable-identity.js";
import { spawnSetupCommand } from "../integration/setup.js";

const processes = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  ...processes,
}));

let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "konteks-background-probes-"));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Windows background probes", () => {
  it("reads the personal Claude version without opening a console", async () => {
    const executable = join(directory, "claude.exe");
    await writeFile(executable, "personal Claude executable");
    processes.execFile.mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      queueMicrotask(() => done(null, "2.1.259 (Claude Code)", ""));
      return new EventEmitter();
    });
    await expect(new ClaudeExecutableIdentity(executable).capability()).resolves.toMatch(/^claude-code-executable:2\.1\.259:sha256:/);
    expect(processes.execFile).toHaveBeenCalledWith(executable, ["--version"], expect.objectContaining({ windowsHide: true }), expect.any(Function));
  });

  it("runs an official integration setup quietly while preserving its exit code", async () => {
    processes.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    await expect(spawnSetupCommand("codex.exe", ["mcp", "get", "atlassian"], {}, 5_000)).resolves.toEqual({ exitCode: 0 });
    expect(processes.spawn).toHaveBeenCalledWith("codex.exe", ["mcp", "get", "atlassian"], expect.objectContaining({ windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore"] }));
  });
});
