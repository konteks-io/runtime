import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_UPDATE_TARGET_ENV } from "@konteks/remote-common";
import { launchNativeUpdater } from "../native/update-launch.js";

afterEach(() => vi.unstubAllEnvs());

function launchFixture() {
  const child = Object.assign(new EventEmitter(), { pid: 77, stderr: new PassThrough(), unref: vi.fn() });
  const spawnFn = vi.fn(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  const launch = () => launchNativeUpdater({ root: "/fixture", executable: "/fixture/bin/konteks-connector", os: "debian",
    target: { bundleVersion: "1.1.0", manifestDigest: "a".repeat(43) }, spawnFn: spawnFn as never });
  return { child, spawnFn, launch };
}

describe("systemd updater startup", () => {
  it("passes a complete public target assignment accepted by systemd249 without exposing proxy credentials", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://private-user:private-pass@proxy.invalid");
    const f = launchFixture();
    const launched = await f.launch();
    const target = launched.args.find(arg => arg.startsWith(`--setenv=${NATIVE_UPDATE_TARGET_ENV}`))!;
    expect(target.slice("--setenv=".length)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=.+$/);
    expect(JSON.parse(target.slice(target.indexOf("=", 9) + 1))).toEqual({ bundleVersion: "1.1.0", manifestDigest: "a".repeat(43) });
    expect(launched.args.join(" ")).not.toContain("private-pass");
    expect(launched.args).toContain("--setenv=HTTPS_PROXY");
  });

  it("waits for stderr close after a fast exit and retains only static diagnostic facts for late observers", async () => {
    const f = launchFixture();
    const launched = await f.launch();
    f.child.emit("exit", 1);
    const observer = vi.fn();
    launched.onExit(observer);
    expect(observer).not.toHaveBeenCalled();
    f.child.stderr.write("Failed to start transient service unit: Invalid environment block. /private/credential secret-value");
    f.child.emit("close", 1);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(1, expect.objectContaining({ reason: "systemd_environment_invalid", stderrTruncated: false }));
    expect(JSON.stringify(observer.mock.calls)).not.toMatch(/private\/credential|secret-value/);
    const late = vi.fn();
    launched.onExit(late);
    expect(late.mock.calls).toEqual(observer.mock.calls);
  });

  it("bounds unknown stderr and does not retain raw text", async () => {
    const f = launchFixture();
    const launched = await f.launch();
    f.child.stderr.write("private-body".repeat(10_000));
    f.child.emit("exit", 1);
    f.child.emit("close", 1);
    const observer = vi.fn();
    launched.onExit(observer);
    expect(observer).toHaveBeenCalledWith(1, { reason: "updater_start_failed", stderrBytes: 120_000, stderrTruncated: true });
    expect(JSON.stringify(observer.mock.calls)).not.toContain("private-body");
  });

  it.each([
    ["Failed to connect to bus: No medium found", "user_manager_unavailable"],
    ["No such file or directory", "updater_executable_missing"],
    ["Permission denied", "updater_permission_denied"],
    ["Unit already exists", "updater_unit_conflict"],
    ["unrecognized option --bad", "updater_option_unsupported"],
  ])("classifies bounded startup output: %s", async (message, reason) => {
    const f = launchFixture();
    const launched = await f.launch();
    f.child.stderr.write(message);
    f.child.emit("close", 1);
    const observer = vi.fn();
    launched.onExit(observer);
    expect(observer).toHaveBeenCalledWith(1, { reason, stderrBytes: Buffer.byteLength(message), stderrTruncated: false });
  });

  it("does not report a failure diagnostic for successful startup", async () => {
    const f = launchFixture();
    const launched = await f.launch();
    f.child.stderr.write("private warning");
    const observer = vi.fn();
    launched.onExit(observer);
    f.child.emit("close", 0);
    expect(observer).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.spawnFn.mock.calls[0]).toBeDefined();
  });

  it("captures a real process startup refusal without creating a unit or exposing its stderr", async () => {
    const spawnFn = ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath,
      ["-e", "process.stderr.write('Invalid environment block. secret-runtime-body'); process.exitCode = 1", "--", ...args], options)) as typeof spawn;
    const launched = await launchNativeUpdater({ root: "/fixture", executable: "/fixture/bin/konteks-connector", os: "debian", spawnFn });
    const observed = await new Promise<unknown[]>(resolve => launched.onExit((...result) => resolve(result)));
    expect(observed).toEqual([1, expect.objectContaining({ reason: "systemd_environment_invalid", stderrTruncated: false })]);
    expect(JSON.stringify(observed)).not.toContain("secret-runtime-body");
  });
});
