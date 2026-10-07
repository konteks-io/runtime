import { describe, expect, it, vi } from "vitest";
import { stopNativeConnector } from "../native/commands.js";
import { createOutput } from "../output.js";
import { nativePlatform, nativeServiceDefinition, type NativeServiceCommand } from "../native/service.js";

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
  it("does not terminate Windows processes when unknown task state cannot be ended", async () => {
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
  it("does not shut down or terminate an owned connector when the background host stop is refused", async () => {
    const root = "C:\\private\\remote";
    const definition = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Test User", root,
      executable: `${root}\\releases\\fixture\\konteks-connector.exe`, userId: "S-1-5-21-1-2-3-1001" });
    const alive = vi.fn(async () => true), terminate = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined), sleep = vi.fn(async () => undefined);
    const execute = vi.fn(async (command: NativeServiceCommand) => command === definition.stop ? 2 : 0);
    expect(definition.windowsBackground).toBe(true);
    await expect(stopNativeConnector({ root, output: createOutput({ json: true }) }, {
      definition: async () => definition, execute, readReceipt: async () => "old-receipt",
      serviceOwner: async () => ({ pid: 42, alive, terminate }), shutdown, sleep, now: () => 0,
      platform: nativePlatform("win32", "x64"), deadlineMs: 1_000, stopGraceMs: 200, pollMs: 100,
    })).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(definition.stop);
    expect(shutdown).not.toHaveBeenCalled();
    expect(alive).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
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
      execute: async (command: NativeServiceCommand) => { if (command === stop) { stopped = true; return 0; } return stopped ? 113 : 0; },
      readReceipt: async () => "previous-stop",
      sleep: async () => { now += 100; },
      now: () => now,
      platform: { os: "macos" },
      deadlineMs: 300,
      pollMs: 100,
    } as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});
