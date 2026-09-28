import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireNativeRootLock } from "@konteks/remote-supervisor";
import { runNativeAgentAdd } from "../native/commands.js";
import { createOutput } from "../output.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-add-lifecycle-")); roots.push(root);
  const supervisor = join(root, "supervisor");
  const owner = acquireNativeRootLock(supervisor);
  const status = { command: "status", args: [] }, stop = { command: "stop", args: [] };
  let stopped = false, now = 0;
  const calls: string[] = [];
  const record = { instanceId: "instance", releaseId: "release-one", controlPort: 41800, agents: ["codex"] } as never;
  const successor = { ...record, agents: ["codex", "dsh"] } as never;
  const add = vi.fn(async () => {
    calls.push("add");
    const lock = acquireNativeRootLock(supervisor);
    lock.release();
    return successor;
  });
  const start = vi.fn(async () => { calls.push("start"); });
  const restore = vi.fn(async () => { calls.push("restore"); });
  const deps = {
    readRecord: async () => record,
    serviceDefinition: async () => ({ status, stop }) as never,
    execute: async (command: { command: string }) => {
      calls.push(command.command);
      if (command === stop) { stopped = true; return 0; }
      return stopped ? 113 : 0;
    },
    control: () => ({ call: async (request: { op: string }) => {
      calls.push(request.op);
      return request.op === "drain.status" ? { draining: true, reason: "update", activeAssignments: 0, openSessions: 0 } : {};
    } }),
    add, restore, start,
    sleep: async () => { now += 1_000; calls.push("wait"); },
    now: () => now,
    platform: { os: "macos", architecture: "arm64", containerBackend: "none", deploymentKind: "native_connector" },
    stopDeadlineMs: 3_000,
    pollMs: 1_000,
  };
  return { root, owner, calls, deps, add, start, restore };
}

describe("native agent-add ownership lifecycle", () => {
  it("waits for the stopped supervisor to release ownership before adding dsh and restarting", async () => {
    const f = await fixture();
    const sleep = f.deps.sleep;
    f.deps.sleep = async () => { await sleep(); f.owner.release(); };
    await runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never);
    expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf("stop"));
    expect(f.calls).toEqual(expect.arrayContaining(["drain.status", "stop", "add", "wait", "start"]));
    expect(f.calls.lastIndexOf("add")).toBeLessThan(f.calls.indexOf("start"));
    expect(f.restore).not.toHaveBeenCalled();
  });

  it("leaves the service stopped and the original record intact if ownership never releases", async () => {
    const f = await fixture();
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/owns this native data directory/) });
      expect(f.add).toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.restore).not.toHaveBeenCalled();
    } finally { f.owner.release(); }
  });

  it("waits for the OS service to finish stopping before trying the installer lock", async () => {
    const f = await fixture();
    const execute = f.deps.execute, sleep = f.deps.sleep;
    let stoppingChecks = 0, waits = 0;
    f.deps.execute = async command => {
      if (command.command === "status" && f.calls.includes("stop") && stoppingChecks++ < 2) {
        f.calls.push("status-still-running");
        return 0;
      }
      return execute(command);
    };
    f.deps.sleep = async () => { await sleep(); if (++waits === 2) f.owner.release(); };
    await runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never);
    expect(waits).toBe(2);
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.calls.indexOf("add")).toBeGreaterThan(f.calls.lastIndexOf("status-still-running"));
    expect(f.start).toHaveBeenCalledOnce();
  });

  it("fails closed if the service manager cannot confirm the stopped state", async () => {
    const f = await fixture();
    const execute = f.deps.execute;
    f.deps.execute = async command => command.command === "status" && f.calls.includes("stop") ? 7 : execute(command);
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/cannot confirm.*stopped/) });
      expect(f.add).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    } finally { f.owner.release(); }
  });

  it("refuses an unknown initial service state before draining or changing agents", async () => {
    const f = await fixture();
    f.deps.execute = async () => 7;
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/cannot confirm.*service state/) });
      expect(f.add).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.calls).not.toContain("drain");
    } finally { f.owner.release(); }
  });

  it("restores the previous record before restarting it if the successor start fails", async () => {
    const f = await fixture();
    f.owner.release();
    f.start.mockRejectedValueOnce(new Error("new service failed to start"));
    await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
      .rejects.toThrow("new service failed to start");
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.calls.indexOf("restore")).toBeLessThan(f.calls.lastIndexOf("start"));
  });
});
