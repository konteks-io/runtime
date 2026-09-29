import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { captureRetainedProcessOwner, readLinuxProcessIdentity, readWindowsProcessIdentity, stopRetainedProcessOwner, type ProcessIdentity } from "../retained-process-owner.js";

const identity: ProcessIdentity = { pid: 123, processGroupId: 123, startToken: "Thu Sep 11 10:00:00 2026", commandDigest: "A".repeat(43) };

describe("retained macOS process owner", () => {
  it("captures only a detached bridge whose exact identity is observable", () => {
    expect(captureRetainedProcessOwner(123, { platform: "darwin", readIdentity: () => identity })).toEqual({ version: 1, platform: "darwin", ...identity });
    expect(() => captureRetainedProcessOwner(123, { platform: "darwin", readIdentity: () => null })).toThrow("cannot be captured");
    expect(() => captureRetainedProcessOwner(123, { platform: "darwin", readIdentity: () => ({ ...identity, processGroupId: 9 }) })).toThrow("process-group leader");
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

describe("retained Windows process owner", () => {
  const record = { ProcessId: 123, ParentProcessId: 50, CreationDate: "20260929131122.123456+420",
    CommandLine: "node bridge.mjs --stdio", ExecutablePath: "C:\\Program Files\\nodejs\\node.exe" };
  const windowsIdentity = readWindowsProcessIdentity(123, () => record)!;

  it("captures a creation-bound command identity for the detached tree root", () => {
    expect(windowsIdentity).toMatchObject({ pid: 123, processGroupId: 123, startToken: record.CreationDate });
    expect(windowsIdentity.commandDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(captureRetainedProcessOwner(123, { platform: "win32", readIdentity: () => windowsIdentity }))
      .toEqual({ version: 1, platform: "win32", ...windowsIdentity });
  });

  it("refuses a PID that changes between the two identity observations", () => {
    const observations = [record, { ...record, CreationDate: "replacement" }];
    expect(readWindowsProcessIdentity(123, () => observations.shift() ?? null)).toBeNull();
  });

  it("uses kernel creation identity when Windows withholds the executable path", () => {
    const hidden = { ...record, ExecutablePath: "", CommandLine: "" };
    expect(readWindowsProcessIdentity(123, () => hidden)).toMatchObject({
      pid: 123, startToken: record.CreationDate, commandDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("terminates only the matched process tree and confirms it is gone", async () => {
    const observations: Array<ProcessIdentity | null> = [windowsIdentity, windowsIdentity, null];
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "win32", ...windowsIdentity }, {
      platform: "win32", readIdentity: () => observations.shift() ?? null, treeAlive: () => false,
      terminateTree, pause: async () => undefined, termTimeoutMs: 10,
    })).resolves.toBeUndefined();
    expect(terminateTree).toHaveBeenCalledWith(123, false);
  });

  it("refuses a reused PID or an ownerless surviving tree", async () => {
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "win32", ...windowsIdentity }, {
      platform: "win32", readIdentity: () => ({ ...windowsIdentity, startToken: "replacement" }),
      treeAlive: () => true, terminateTree,
    })).rejects.toThrow("identity changed");
    await expect(stopRetainedProcessOwner({ version: 1, platform: "win32", ...windowsIdentity }, {
      platform: "win32", readIdentity: () => null, treeAlive: () => true, terminateTree,
    })).rejects.toThrow("process tree survives");
    expect(terminateTree).not.toHaveBeenCalled();
  });
});

describe("retained Linux process owner", () => {
  const bootId = "f0d5ec7f-8b86-4fb1-98b9-3d8c26ed20a4";
  const linuxIdentity: ProcessIdentity = { ...identity, startToken: `${bootId}:987654` };

  it("captures only the exact process-group leader", () => {
    expect(captureRetainedProcessOwner(123, { platform: "linux", readIdentity: () => linuxIdentity }))
      .toEqual({ version: 1, platform: "linux", ...linuxIdentity });
    expect(() => captureRetainedProcessOwner(123, { platform: "linux", readIdentity: () => ({ ...linuxIdentity, processGroupId: 9 }) }))
      .toThrow("process-group leader");
  });

  it("reads boot-bound start time and command identity from procfs", () => {
    const rest = ["S", "1", "123", "123", ...Array(15).fill("0"), "987654"].join(" ");
    const files: Record<string, Buffer> = {
      "/proc/123/stat": Buffer.from(`123 (bwrap worker) ${rest}`),
      "/proc/123/cmdline": Buffer.from("/usr/bin/bwrap\0--new-session\0"),
      "/proc/sys/kernel/random/boot_id": Buffer.from(`${bootId}\n`),
    };
    const result = readLinuxProcessIdentity(123, path => files[path] ?? null);
    expect(result).toMatchObject({ pid: 123, processGroupId: 123, startToken: `${bootId}:987654` });
    expect(result?.commandDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readLinuxProcessIdentity(123, path => path === "/proc/123/stat" ? Buffer.from(`123 (gone) Z ${rest}`) : files[path] ?? null)).toBeNull();
  });

  it("refuses a reused PID before signaling", async () => {
    const signal = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "linux", ...linuxIdentity }, {
      platform: "linux", readIdentity: () => ({ ...linuxIdentity, startToken: "other-boot:987654" }), signal,
    })).rejects.toThrow("identity changed");
    expect(signal).not.toHaveBeenCalled();
  });

  it("stops only a matching Linux owner with group-exit evidence", async () => {
    const observations: Array<ProcessIdentity | null> = [linuxIdentity, linuxIdentity, null];
    const signal = vi.fn();
    await expect(stopRetainedProcessOwner({ version: 1, platform: "linux", ...linuxIdentity }, {
      platform: "linux", readIdentity: () => observations.shift() ?? null, groupAlive: () => false,
      signal, pause: async () => undefined, termTimeoutMs: 10,
    })).resolves.toBeUndefined();
    expect(signal).toHaveBeenCalledWith(123, "SIGTERM");
  });

  it.skipIf(process.platform !== "linux")("captures and stops a real detached Linux process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const owner = captureRetainedProcessOwner(child.pid!);
      expect(owner.platform).toBe("linux");
      expect(readLinuxProcessIdentity(child.pid!)).toMatchObject({ pid: owner.pid, processGroupId: owner.processGroupId,
        startToken: owner.startToken, commandDigest: owner.commandDigest });
      await stopRetainedProcessOwner(owner);
      expect(readLinuxProcessIdentity(child.pid!)).toBeNull();
    } finally {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
});
