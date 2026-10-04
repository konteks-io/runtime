import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnEnrollmentStaging } from "../native/enrollment-staging.js";
import { ensureGraft, planGraft, prepareDeliveryGraft, writeGraftRecord } from "../native/graft.js";

const processes = vi.hoisted(() => {
  const capture = vi.fn();
  const execFile = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: capture });
  return { spawn: vi.fn(), execFile, capture };
});
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: processes.spawn,
  execFile: processes.execFile,
}));

let directory: string;
const streams: PassThrough[] = [];
function stream(): PassThrough { const value = new PassThrough(); streams.push(value); return value; }
beforeEach(async () => {
  vi.clearAllMocks();
  processes.capture.mockReset();
  directory = await mkdtemp(join(tmpdir(), "konteks-background-setup-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const value of streams.splice(0)) value.destroy();
  await rm(directory, { recursive: true, force: true });
});

describe("Windows background installation helpers", () => {
  it("unpacks enrollment packages without opening another console", async () => {
    processes.spawn.mockReturnValue({ pid: 312, unref: vi.fn() });
    await expect(spawnEnrollmentStaging(directory)).resolves.toBe(312);
    const [command, args, options] = processes.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(["--root", directory, "stage-enrollment"]));
    expect({ windowsHide: options.windowsHide, detached: options.detached }).toEqual({ windowsHide: true, detached: true });
  });

  it("wires the repository context graph without opening another console", async () => {
    const root = join(directory, "connector");
    const repo = join(directory, "delivery");
    const gitDir = join(repo, ".git");
    await mkdir(gitDir, { recursive: true });
    vi.stubEnv("HOME", join(directory, "home"));
    processes.capture.mockImplementation(async (_command, args: string[]) => ({
      stdout: args.includes("--absolute-git-dir") ? `${gitDir}\n` : "",
      stderr: "",
    }));
    processes.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.end("graph ready\n"); child.emit("close", 0); });
      return child;
    });
    await expect(prepareDeliveryGraft(root, repo, "codex", {
      available: async () => true,
      ensure: async () => ({ node: "node.exe", cli: "graft.mjs" }),
    })).resolves.toBe("wired");
    expect(processes.spawn.mock.calls.map(([command, args, options]) => ({
      command, args, windowsHide: options.windowsHide, cwd: options.cwd, stdio: options.stdio,
    }))).toEqual([
      { command: "node.exe", args: ["graft.mjs", "telemetry", "disable"], windowsHide: true, cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
      { command: "node.exe", args: ["graft.mjs", "init", repo, "--agents", "agents", "--no-global", "-y"], windowsHide: true, cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
    ]);
  });

  it("reads Git's repository inventory quietly while preparing Graft", async () => {
    processes.capture.mockResolvedValue({ stdout: "index.ts\n", stderr: "" });
    await expect(planGraft(directory, ["codex"])).resolves.toMatchObject({ agents: ["agents"], files: 1 });
    expect(processes.capture.mock.calls).toHaveLength(2);
    for (const [command, args, options] of processes.capture.mock.calls) {
      expect({ command, args: args.slice(0, 3), windowsHide: options?.windowsHide }).toEqual({ command: "git", args: ["-C", directory, "ls-files"], windowsHide: true });
    }
  });

  it("unpacks the verified Graft package without opening a tar console", async () => {
    const bytes = Buffer.from(`verified Graft archive for ${directory}`);
    await writeGraftRecord(directory, { name: "konteks-graft-windows-x64.tgz", digest: createHash("sha256").update(bytes).digest("hex"), base: "https://releases.example.test" });
    processes.capture.mockRejectedValue(new Error("characterized tar helper"));
    await expect(ensureGraft(directory, { node: async () => process.execPath, fetchFn: async () => new Response(bytes) })).rejects.toThrow("characterized tar helper");
    const [command, args, options] = processes.capture.mock.calls[0]!;
    expect({ command, firstArg: args[0], windowsHide: options?.windowsHide }).toEqual({ command: "tar", firstArg: "-xzf", windowsHide: true });
  });
});
