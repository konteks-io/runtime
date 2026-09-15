import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PipedChildProcess } from "@konteks/remote-common";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { NativeCodexAppServerOwner } from "../native/codex-app-server-owner.js";

function child(): PipedChildProcess {
  const process = new EventEmitter() as PipedChildProcess;
  Object.assign(process, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 42, exitCode: null, signalCode: null, kill: vi.fn(() => true),
  });
  return process;
}

const config = {
  RUNNER_AGENT_ID: "codex",
  RUNNER_AUTH_MODE: "agent_local_subscription",
  RUNNER_CREDENTIAL_DIR: "/private/runner",
  RUNNER_WORKSPACE_DIR: "/private/work",
  RUNNER_BRIDGE_PREFIX: "/signed/codex",
  RUNNER_NATIVE_CODEX_HOME: "/operator/.codex",
  RUNNER_NATIVE_CODEX_SOCKET: "/operator/.codex/app-server-control/app-server-control.sock",
  RUNNER_NATIVE_PACKAGE_PROFILE: {
    tooling: { entrypoint: "bin/codex", runtime: "native" },
    codexLocalProxy: { version: 1, entrypoint: "konteks/codex-local-proxy.js" },
  },
} as RunnerConfig;

function fixture() {
  const children: PipedChildProcess[] = [];
  const spawn = vi.fn(() => { const next = child(); children.push(next); return next; });
  const stop = vi.fn(async () => undefined);
  const prepareSocket = vi.fn(async (): Promise<"spawn" | "adopt"> => "spawn");
  const waitUntilReady = vi.fn(async () => undefined);
  const cleanupSocket = vi.fn(async () => undefined);
  const verifyPackage = vi.fn(async () => undefined);
  const owner = new NativeCodexAppServerOwner({
    config, spawn, stop, prepareSocket, waitUntilReady, cleanupSocket, verifyPackage,
    restartDelaysMs: [5, 10],
  });
  return { owner, children, spawn, stop, prepareSocket, waitUntilReady, cleanupSocket, verifyPackage };
}

describe("native shared Codex app-server owner", () => {
  it("starts the signed installed Codex server before clients and stops it as one shared owner", async () => {
    const f = fixture();
    await f.owner.start();
    expect(f.verifyPackage).toHaveBeenCalledWith(config);
    expect(f.prepareSocket).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET);
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({
      command: "/signed/codex/bin/codex",
      args: ["app-server", "--listen", `unix://${config.RUNNER_NATIVE_CODEX_SOCKET}`],
      detached: true,
      env: expect.objectContaining({ CODEX_HOME: config.RUNNER_NATIVE_CODEX_HOME }),
    }));
    expect(f.waitUntilReady).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET, f.children[0]);
    await f.owner.stop();
    expect(f.stop).toHaveBeenCalledWith({ child: f.children[0], timeoutMs: 5_000, killGraceMs: 2_000 });
    expect(f.cleanupSocket).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET);
  });

  it("restarts a crashed shared owner without coupling its lifecycle to runner bridges", async () => {
    const f = fixture();
    await f.owner.start();
    f.children[0]!.exitCode = 1;
    f.children[0]!.emit("exit", 1, null);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
    expect(f.prepareSocket).toHaveBeenCalledTimes(2);
    expect(f.waitUntilReady).toHaveBeenCalledTimes(2);
    await f.owner.stop();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it("adopts a healthy same-user server across connector restart without spawning a race", async () => {
    const f = fixture();
    f.prepareSocket.mockResolvedValueOnce("adopt");
    await f.owner.start();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.waitUntilReady).not.toHaveBeenCalled();
    await f.owner.stop();
  });

  it("fails startup cleanly when the socket never becomes ready", async () => {
    const f = fixture();
    f.waitUntilReady.mockRejectedValueOnce(new Error("not ready"));
    await expect(f.owner.start()).rejects.toThrow("not ready");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.cleanupSocket).toHaveBeenCalledOnce();
  });
});
