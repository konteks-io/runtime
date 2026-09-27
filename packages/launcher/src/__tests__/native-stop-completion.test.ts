import { describe, expect, it, vi } from "vitest";
import { stopNativeConnector } from "../native/commands.js";
import { createOutput } from "../output.js";

describe("ordinary native stop completion", () => {
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
