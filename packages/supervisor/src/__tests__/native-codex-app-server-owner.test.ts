import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PipedChildProcess } from "@konteks/remote-common";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { NativeCodexAppServerOwner, cleanupCodexSocket, prepareCodexSocket, waitForCodexSocket } from "../native/codex-app-server-owner.js";

vi.mock("@konteks/remote-common", async importOriginal => ({
  ...await importOriginal<object>(), isProcessGroupAlive: vi.fn(() => false),
}));
vi.mock("@konteks/remote-agent-runner", async importOriginal => ({
  ...await importOriginal<object>(), assertCodexThreadsIdle: vi.fn(async () => undefined),
}));

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

it.skipIf(process.platform === "win32")("keeps a live deterministic Codex alias and removes only its stale alias after stop", async () => {
  const root = await mkdtemp("/tmp/konteks-owner-alias-");
  const socket = join(root, "s");
  const directory = join(await realpath("/tmp"), `codex-daemon-${process.getuid?.()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const physical = join(directory, createHash("sha256").update(join(await realpath(root), "s")).digest("hex"));
  const server = createServer(connection => connection.destroy());
  try {
    server.listen(physical); await once(server, "listening"); await chmod(physical, 0o600);
    await symlink(physical, socket);
    await waitForCodexSocket(socket, child());
    expect(await prepareCodexSocket(socket)).toBe("adopt");
    await cleanupCodexSocket(socket);
    expect((await lstat(socket)).isSymbolicLink()).toBe(true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await prepareCodexSocket(socket, true)).toBe("spawn");
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

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
  it.each(["active", "unknown"])("keeps the exact owner alive when loaded-thread inventory is %s", async state => {
    const f = fixture();
    const assertIdleThreads = vi.fn(async (): Promise<void> => { throw new Error(`thread inventory ${state}`); });
    const owner = new NativeCodexAppServerOwner({
      config, spawn: f.spawn, stop: f.stop, prepareSocket: f.prepareSocket,
      waitUntilReady: f.waitUntilReady, cleanupSocket: f.cleanupSocket,
      verifyPackage: f.verifyPackage, assertIdleThreads,
    });
    await owner.start();
    await expect(owner.stop()).rejects.toThrow(`thread inventory ${state}`);
    expect(assertIdleThreads).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.cleanupSocket).not.toHaveBeenCalled();
    assertIdleThreads.mockImplementation(async () => undefined);
    await owner.stop();
  });

  it("stops an exact owner only after the loaded-thread idle inventory succeeds", async () => {
    const f = fixture();
    const assertIdleThreads = vi.fn(async () => undefined);
    const owner = new NativeCodexAppServerOwner({
      config, spawn: f.spawn, stop: f.stop, prepareSocket: f.prepareSocket,
      waitUntilReady: f.waitUntilReady, cleanupSocket: f.cleanupSocket,
      verifyPackage: f.verifyPackage, assertIdleThreads,
    });
    await owner.start();
    await owner.stop();
    expect(assertIdleThreads).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET);
    expect(assertIdleThreads.mock.invocationCallOrder[0]).toBeLessThan(f.stop.mock.invocationCallOrder[0]!);
  });

  it("refuses to attest shutdown while the exact owned process group remains alive", async () => {
    const f = fixture();
    let groupAlive = true;
    const owner = new NativeCodexAppServerOwner({
      config, spawn: f.spawn, stop: f.stop, prepareSocket: f.prepareSocket,
      waitUntilReady: f.waitUntilReady, cleanupSocket: f.cleanupSocket,
      verifyPackage: f.verifyPackage, groupAlive: () => groupAlive,
    });
    await owner.start();

    await expect(owner.stop()).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(f.cleanupSocket).not.toHaveBeenCalled();
    groupAlive = false;
    await owner.stop();
  });

  it("can be started again after a start that failed (WS1-018)", async () => {
    const f = fixture();
    f.waitUntilReady.mockRejectedValueOnce(new Error("socket never came up"));
    await expect(f.owner.start()).rejects.toThrow("socket never came up");
    await f.owner.start();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    await f.owner.stop();
  });

  it("ends its app-server group if the process exits after a stop was asked for, and only then (WS1-042)", async () => {
    const f = fixture();
    await f.owner.start();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    process.emit("exit", 0);
    expect(kill).not.toHaveBeenCalled(); // a crash leaves it for the next start to adopt
    f.owner.shutdownRequested();
    process.emit("exit", 0);
    expect(kill).toHaveBeenCalledWith(-42, "SIGKILL");
    kill.mockClear();
    await f.owner.stop();
    process.emit("exit", 0);
    expect(kill).not.toHaveBeenCalled(); // a finished stop removes the hook
    kill.mockRestore();
  });
  it("starts the signed installed Codex server before clients and stops it as one shared owner", async () => {
    const f = fixture();
    await f.owner.start();
    expect(f.verifyPackage).toHaveBeenCalledWith(config);
    expect(f.prepareSocket).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET, false);
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

  it("restarts the exact owned app-server after a successful login before reporting ready", async () => {
    const f = fixture();
    await f.owner.start();
    await f.owner.refreshAfterLogin();
    expect(f.stop).toHaveBeenCalledWith({ child: f.children[0], timeoutMs: 5_000, killGraceMs: 2_000 });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.waitUntilReady).toHaveBeenCalledTimes(2);
    await f.owner.stop();
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
    const releases = "/operator/connector/releases/";
    const socketHolder = vi.fn(async () => ({ pid: 4411, command: `${releases}release-new/agents/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}` }));
    const stopHolder = vi.fn(async () => undefined);
    const owner = new NativeCodexAppServerOwner({ config: { ...config, RUNNER_BRIDGE_PREFIX: `${releases}release-new/agents/codex` } as RunnerConfig,
      spawn: f.spawn, stop: f.stop, prepareSocket: vi.fn(async () => "adopt" as const), waitUntilReady: f.waitUntilReady,
      cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage, socketHolder, stopHolder });
    await owner.start();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.waitUntilReady).not.toHaveBeenCalled();
    await owner.stop();
    expect(stopHolder).toHaveBeenCalledWith(4411);
    expect(f.cleanupSocket).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET);
  });

  it("recycles a proven adopted owner after login and leaves an uncertain holder untouched", async () => {
    const releases = "/operator/connector/releases/";
    const f = fixture();
    const holder = { pid: 4411, command: `${releases}release-new/agents/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}` };
    const socketHolder = vi.fn(async () => holder);
    const stopHolder = vi.fn(async () => undefined);
    const prepareSocket = vi.fn().mockResolvedValueOnce("adopt").mockResolvedValue("spawn");
    const owner = new NativeCodexAppServerOwner({ config: { ...config, RUNNER_BRIDGE_PREFIX: `${releases}release-new/agents/codex` } as RunnerConfig,
      spawn: f.spawn, stop: f.stop, prepareSocket, waitUntilReady: f.waitUntilReady,
      cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage, socketHolder, stopHolder });
    await owner.start();
    socketHolder.mockResolvedValueOnce({ ...holder, pid: 9922 });
    await expect(owner.refreshAfterLogin()).rejects.toThrow();
    expect(stopHolder).not.toHaveBeenCalled();
    await owner.refreshAfterLogin();
    expect(stopHolder).toHaveBeenCalledWith(4411);
    expect(f.spawn).toHaveBeenCalledOnce();
    await owner.stop();
  });

  it("stops the replacement child after an adopted socket disappears", async () => {
    const releases = "/operator/connector/releases/";
    const f = fixture();
    const socketHolder = vi.fn(async () => ({ pid: 4411, command: `${releases}release-new/agents/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}` }));
    const stopHolder = vi.fn(async () => undefined);
    const prepareSocket = vi.fn().mockResolvedValueOnce("adopt").mockResolvedValue("spawn");
    const owner = new NativeCodexAppServerOwner({ config: { ...config, RUNNER_BRIDGE_PREFIX: `${releases}release-new/agents/codex` } as RunnerConfig,
      spawn: f.spawn, stop: f.stop, prepareSocket, socketAvailable: vi.fn(async () => false), adoptedPollMs: 5,
      waitUntilReady: f.waitUntilReady, cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage, socketHolder, stopHolder });
    await owner.start();
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    await owner.stop();
    expect(f.stop).toHaveBeenCalledWith({ child: f.children[0], timeoutMs: 5_000, killGraceMs: 2_000 });
    expect(stopHolder).toHaveBeenCalledWith(4411);
  });

  it("replaces a live server left by an older release of this connector instead of adopting it (WS2-141)", async () => {
    const releases = "/operator/connector/releases/";
    const f = fixture();
    const stopHolder = vi.fn(async () => undefined);
    const onStaleReplaced = vi.fn();
    const owner = new NativeCodexAppServerOwner({
      config: { ...config, RUNNER_BRIDGE_PREFIX: `${releases}release-new/agents/codex` } as RunnerConfig,
      spawn: f.spawn, stop: f.stop, prepareSocket: vi.fn(async () => "adopt" as const), waitUntilReady: f.waitUntilReady,
      cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage, restartDelaysMs: [5, 10],
      socketHolder: vi.fn(async () => ({ pid: 4411, command: `${releases}release-old/agents/codex/node_modules/@openai/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}` })),
      stopHolder, onStaleReplaced,
    });
    await owner.start();
    expect(stopHolder).toHaveBeenCalledWith(4411);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(onStaleReplaced).toHaveBeenCalledWith(expect.objectContaining({ staleRelease: "release-old", currentRelease: "release-new" }));
    await owner.stop();
  });

  it("does not replace a stale-release owner while its loaded threads are active or unverified", async () => {
    const releases = "/operator/connector/releases/";
    const f = fixture();
    const stopHolder = vi.fn(async () => undefined);
    const assertIdleThreads = vi.fn(async () => { throw new Error("loaded turn active"); });
    const owner = new NativeCodexAppServerOwner({
      config: { ...config, RUNNER_BRIDGE_PREFIX: `${releases}release-new/agents/codex` } as RunnerConfig,
      spawn: f.spawn, stop: f.stop, prepareSocket: vi.fn(async () => "adopt" as const), waitUntilReady: f.waitUntilReady,
      cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage,
      socketHolder: vi.fn(async () => ({ pid: 4411, command: `${releases}release-old/agents/codex/node_modules/@openai/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}` })),
      stopHolder, assertIdleThreads,
    });
    await expect(owner.start()).rejects.toThrow("loaded turn active");
    expect(assertIdleThreads).toHaveBeenCalledWith(config.RUNNER_NATIVE_CODEX_SOCKET);
    expect(stopHolder).not.toHaveBeenCalled();
    expect(f.cleanupSocket).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("adopts only its own release's server and refuses a foreign or unprovable holder without cleanup", async () => {
    const releases = "/operator/connector/releases/";
    for (const [command, own] of [[`${releases}release-new/agents/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}`, true], ["/Applications/Codex.app/Contents/Resources/codex app-server", false], [`/personal/releases/release-other/agents/codex/bin/codex app-server --listen unix://${config.RUNNER_NATIVE_CODEX_SOCKET}`, false]] as const) {
      const f = fixture();
      const stopHolder = vi.fn(async () => undefined);
      const owner = new NativeCodexAppServerOwner({
        config: { ...config, RUNNER_BRIDGE_PREFIX: `${releases}release-new/agents/codex` } as RunnerConfig,
        spawn: f.spawn, stop: f.stop, prepareSocket: vi.fn(async () => "adopt" as const), waitUntilReady: f.waitUntilReady,
        cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage, restartDelaysMs: [5, 10],
        socketHolder: vi.fn(async () => ({ pid: 4411, command })), stopHolder,
      });
      if (own) await owner.start();
      else await expect(owner.start()).rejects.toThrow();
      expect(stopHolder).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      await owner.stop();
      if (!own) expect(f.cleanupSocket).not.toHaveBeenCalled();
    }
  });

  it("fails startup cleanly when the socket never becomes ready", async () => {
    const f = fixture();
    f.waitUntilReady.mockRejectedValueOnce(new Error("not ready"));
    await expect(f.owner.start()).rejects.toThrow("not ready");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.cleanupSocket).toHaveBeenCalledOnce();
  });
});

describe("stray app-servers of this installation (RCA 2026-09-30)", () => {
  const current = "/root/releases/rel-new/agents/codex/bin/codex app-server --listen unix:///root/run/codex.sock";
  const strays = [
    { pid: 4630, command: "/root/releases/rel-deleted/agents/codex/bin/node /root/releases/rel-deleted/agents/codex/bin/codex app-server --listen unix:///home/.codex/app-server-control/app-server-control.sock" },
    { pid: 2619, command: "/root/releases/rel-old/agents/codex/bin/codex app-server --listen unix:///root/run/old.sock" },
  ];
  const others = [
    { pid: 900, command: "/root/releases/rel-new/agents/codex/bin/codex app-server --listen unix:///root/run/codex.sock" }, // the current release
    { pid: 901, command: "/root/releases/rel-old/agents/codex/bin/codex app-server --listen unix:///root/run/codex.sock" }, // the current socket: stale replacement owns it
    { pid: 902, command: "/Applications/Codex.app/Contents/Resources/codex app-server --listen unix:///home/.codex/app-server-control/app-server-control.sock" }, // the person's own Codex
    { pid: 903, command: "/other/releases/rel-old/agents/codex/bin/codex app-server --listen unix:///x.sock" }, // another installation
    { pid: 904, command: "/root/releases/rel-old/konteks-connector serve --root /root" }, // not an app-server
  ];

  function owner(input: { busy?: string[]; reachable?: boolean } = {}) {
    const stopHolder = vi.fn(async () => undefined);
    const replaced: number[] = [];
    const o = new NativeCodexAppServerOwner({
      config, listProcesses: async () => [...strays, ...others], stopHolder,
      strayReachable: async () => input.reachable ?? true,
      assertIdleThreads: async socket => { if (input.busy?.includes(socket)) throw new Error("thread active"); },
      onStaleReplaced: event => { replaced.push(event.pid); },
    });
    return { o, stopHolder, replaced };
  }

  it("ends servers older releases of this installation left on other sockets, and nothing else", async () => {
    const f = owner();
    expect(await f.o.reapStrayServers(current, "/root/run/codex.sock")).toBe(2);
    expect(f.stopHolder.mock.calls.map(([pid]) => pid).sort()).toEqual([2619, 4630]);
    expect(f.replaced.sort()).toEqual([2619, 4630]);
  });

  it("leaves a stray whose threads are still busy for the next start, and stops an unreachable one", async () => {
    const busy = owner({ busy: ["/root/run/old.sock"] });
    expect(await busy.o.reapStrayServers(current, "/root/run/codex.sock")).toBe(1);
    expect(busy.stopHolder).toHaveBeenCalledWith(4630);
    expect(busy.stopHolder).not.toHaveBeenCalledWith(2619);
    const deaf = owner({ reachable: false, busy: ["/root/run/old.sock"] });
    expect(await deaf.o.reapStrayServers(current, "/root/run/codex.sock")).toBe(2);
  });
});
