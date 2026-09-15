import { describe, expect, it, vi } from "vitest";
import { captureRetainedProcessOwner, stopRetainedProcessOwner, type ProcessIdentity } from "../retained-process-owner.js";

const identity: ProcessIdentity = { pid: 123, processGroupId: 123, startToken: "Thu Sep 11 10:00:00 2026", commandDigest: "A".repeat(43) };

describe("retained macOS process owner", () => {
  it("captures only a detached bridge whose exact identity is observable", () => {
    expect(captureRetainedProcessOwner(123, { platform: "darwin", readIdentity: () => identity })).toEqual({ version: 1, platform: "darwin", ...identity });
    expect(() => captureRetainedProcessOwner(123, { platform: "darwin", readIdentity: () => null })).toThrow("cannot be captured");
    expect(() => captureRetainedProcessOwner(123, { platform: "darwin", readIdentity: () => ({ ...identity, processGroupId: 9 }) })).toThrow("process-group leader");
  });

  it.each(["linux", "win32"] as const)("leaves %s rehydration explicitly unsupported", platform => {
    expect(() => captureRetainedProcessOwner(123, { platform, readIdentity: () => identity })).toThrow("not available");
  });

  it("requires a positive exact identity match before signaling", async () => {
    const signal = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "darwin", ...identity }, {
      platform: "darwin", readIdentity: () => null, groupAlive: () => true, signal, pause: async () => undefined,
    })).rejects.toThrow("process group survives");
    expect(signal).not.toHaveBeenCalled();

    await expect(stopRetainedProcessOwner({ version: 1, platform: "darwin", ...identity }, {
      platform: "darwin", readIdentity: () => ({ ...identity, startToken: "reused" }), signal, pause: async () => undefined,
    })).rejects.toThrow("identity changed");
    expect(signal).not.toHaveBeenCalled();
  });

  it("accepts a leader and group that are both already gone, without signaling a stranger", async () => {
    // A connector restart kills its bridge group; refusing this evidence left
    // the runtime unable to finish startup recovery at all.
    const signal = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "darwin", ...identity }, {
      platform: "darwin", readIdentity: () => null, groupAlive: () => false, signal, pause: async () => undefined,
    })).resolves.toBeUndefined();
    expect(signal).not.toHaveBeenCalled();
  });

  it("signals the exact leader and group and requires observed exit", async () => {
    const observations: Array<ProcessIdentity | null> = [identity, identity, null];
    const signal = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "darwin", ...identity }, {
      platform: "darwin", readIdentity: () => observations.shift() ?? null, groupAlive: () => false,
      signal, pause: async () => undefined, termTimeoutMs: 10, killTimeoutMs: 10,
    })).resolves.toBeUndefined();
    expect(signal).toHaveBeenCalledWith(123, "SIGTERM");
  });
});
