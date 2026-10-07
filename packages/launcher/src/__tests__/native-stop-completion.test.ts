import { describe, expect, it, vi } from "vitest";
import { stopNativeConnector } from "../native/commands.js";
import { createOutput } from "../output.js";

describe("ordinary native stop completion", () => {
  it("disables crash restarts before gracefully stopping an owned Windows connector", async () => {
    const stop = { command: "stop", args: [] }, status = { command: "status", args: [] };
    let now = 0, alive = true;
    const terminate = vi.fn(async () => { alive = false; });
    const shutdown = vi.fn(async () => undefined);
    const execute = vi.fn(async (command: typeof stop) => command === stop ? 0 : 1);
    await stopNativeConnector({ root: "C:\\private\\remote", output: createOutput({ json: true }) }, {
      definition: async () => ({ stop, status, windowsBackground: true }) as never, execute, readReceipt: async () => "old-receipt",
      serviceOwner: async () => ({ pid: 42, alive: async () => alive, terminate }), shutdown,
      sleep: async () => { now += 100; }, now: () => now, platform: { os: "windows" },
      deadlineMs: 1_000, stopGraceMs: 200, pollMs: 100,
    } as never);
    expect(shutdown).toHaveBeenCalledWith("C:\\private\\remote");
    expect(terminate).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(stop);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(shutdown.mock.invocationCallOrder[0]!);
  });
  it("does not terminate Windows processes when the hidden background host cannot be stopped", async () => {
    const stop = { command: "stop", args: [] }, status = { command: "status", args: [] };
    let now = 0;
    const terminate = vi.fn();
    await expect(stopNativeConnector({ root: "C:\\private\\remote", output: createOutput({ json: true }) }, {
      definition: async () => ({ stop, status }) as never, execute: async () => 2, readReceipt: async () => "old-receipt",
      serviceOwner: async () => ({ pid: 42, alive: async () => true, terminate }), shutdown: async () => undefined,
      sleep: async () => { now += 100; }, now: () => now, platform: { os: "windows" },
      deadlineMs: 1_000, stopGraceMs: 200, pollMs: 100,
    } as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(terminate).not.toHaveBeenCalled();
  });
  it("waits for the hidden host to release its state after the connector exits", async () => {
    const stop = { command: "stop", args: [] }, status = { command: "status", args: [] };
    let now = 0;
    const terminate = vi.fn();
    await stopNativeConnector({ root: "C:\\private\\remote", output: createOutput({ json: true }) }, {
      definition: async () => ({ stop, status, windowsBackground: true }) as never,
      execute: async (command: typeof stop) => command === stop ? 0 : now >= 200 ? 1 : 0,
      readReceipt: async () => "old", shutdown: async () => undefined,
      serviceOwner: async () => ({ pid: 42, alive: async () => false, terminate }),
      sleep: async () => { now += 100; }, now: () => now, platform: { os: "windows" },
      deadlineMs: 1_000, stopGraceMs: 500, pollMs: 100,
    } as never);
    expect(now).toBe(200);
    expect(terminate).not.toHaveBeenCalled();
  });
  it("stops a Windows watchdog between connector runs without requiring a new daemon receipt", async () => {
    const stop = { command: "stop", args: [] }, status = { command: "status", args: [] };
    let stopped = false;
    const serviceOwner = vi.fn(async () => null);
    await stopNativeConnector({ root: "C:\\private\\remote", output: createOutput({ json: true }) }, {
      definition: async () => ({ stop, status, windowsBackground: true }) as never,
      execute: async (command: typeof stop) => { if (command === stop) { stopped = true; return 0; } return stopped ? 1 : 0; },
      readReceipt: async () => null, serviceOwner,
      sleep: async () => undefined, now: () => 0, platform: { os: "windows" },
    } as never);
    expect(stopped).toBe(true);
    expect(serviceOwner).toHaveBeenCalledTimes(2);
  });
  it("does not claim success until this installation reports completed cleanup and stopped service", async () => {
    const stop = { command: "stop", args: [] };
    const status = { command: "status", args: [] };
    let receipt = "previous-stop";
    let statusCode = 0;
    let now = 0;
    const output: string[] = [];
    const input = { root: "/private/test-native-root", output: createOutput({ json: false, stdout: { write: (line: string) => { output.push(line); return true; } } as never }) };
    const deps = {
      definition: async () => ({ stop, status }) as never,
      execute: vi.fn(async (command: typeof stop) => command === stop ? 0 : statusCode),
      readReceipt: async () => receipt,
      sleep: async () => { now += 100; if (now === 200) { receipt = "completed-current-stop"; statusCode = 113; } },
      now: () => now,
      platform: { os: "macos" },
      deadlineMs: 1_000,
      pollMs: 100,
    };

    await stopNativeConnector(input, deps as never);

    expect(now).toBe(200);
    expect(deps.execute).toHaveBeenCalledWith(stop);
    expect(deps.execute).toHaveBeenCalledWith(status);
    expect(output.join("")).toContain("stopped");
  });

  it("reports incomplete cleanup instead of a successful stop when no new receipt arrives", async () => {
    const stop = { command: "stop", args: [] };
    const status = { command: "status", args: [] };
    let now = 0;
    let stopped = false;
    const input = { root: "/private/test-native-root", output: createOutput({ json: false, stdout: { write: () => true } as never }) };
    await expect(stopNativeConnector(input, {
      definition: async () => ({ stop, status }) as never,
      execute: async command => { if (command === stop) { stopped = true; return 0; } return stopped ? 113 : 0; },
      readReceipt: async () => "previous-stop",
      sleep: async () => { now += 100; },
      now: () => now,
      platform: { os: "macos" },
      deadlineMs: 300,
      pollMs: 100,
    } as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});
