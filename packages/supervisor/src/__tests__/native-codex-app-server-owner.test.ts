import { EventEmitter, once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipedChildProcess } from "@konteks/remote-common";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { NativeCodexAppServerOwner, cleanupCodexSocket, prepareCodexSocket, waitForCodexSocket } from "../native/codex-app-server-owner.js";

vi.mock("@konteks/remote-common", async importOriginal => ({
  ...await importOriginal<object>(), isProcessGroupAlive: vi.fn(() => false),
}));
const loadedStatuses = vi.hoisted(() => vi.fn(async (_socket: string) => new Map<string, string>()));
vi.mock("@konteks/remote-agent-runner", async importOriginal => {
  const actual = await importOriginal<object>();
  const runtime = await import("../../../agent-runner/src/runtime.js");
  return {
    ...actual, assertCodexThreadsIdle: vi.fn(async () => undefined),
    codexLoadedThreadStatuses: loadedStatuses,
    FileSessionRefStore: runtime.FileSessionRefStore,
  };
});

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
  async function legacyThreadFixture(sessionRefs: Record<string, unknown>, statuses: Map<string, string>) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "codex-legacy-thread-")));
    const credentialDir = join(root, "credentials");
    const socketPath = join(root, "app-server.sock");
    await mkdir(credentialDir, { mode: 0o700 });
    await writeFile(join(credentialDir, "session-refs.json"), JSON.stringify(sessionRefs), { mode: 0o600 });
    const localConfig = { ...config, RUNNER_CREDENTIAL_DIR: credentialDir, RUNNER_NATIVE_CODEX_SOCKET: socketPath } as RunnerConfig;
    const f = fixture();
    const server = createServer(socket => socket.end());
    server.listen(socketPath);
    await once(server, "listening");
    const owner = new NativeCodexAppServerOwner({
      config: localConfig, spawn: f.spawn, stop: f.stop,
      prepareSocket: vi.fn(async () => "spawn" as const), waitUntilReady: f.waitUntilReady,
      cleanupSocket: f.cleanupSocket, verifyPackage: f.verifyPackage,
    });
    await owner.start();
    loadedStatuses.mockReset();
    loadedStatuses.mockResolvedValue(statuses);
    const socketIdentity = await stat(socketPath);
    return {
      owner,
      ownerGeneration: `42:${socketIdentity.dev}:${socketIdentity.ino}:${socketIdentity.birthtimeMs}`,
      close: async () => {
        await owner.stop();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      },
    };
  }

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

  it.each(["idle", "active"])("recognizes a loaded provider thread for an ACP reference (%s)", async status => {
    const providerThreadId = "8eac57df-c963-4f26-b417-2edbeeeae7e1";
    const f = await legacyThreadFixture({ "acp-fixture": providerThreadId }, new Map([[providerThreadId, status]]));
    try {
      await expect(f.owner.inspectLegacyThread("acp-fixture")).resolves.toMatchObject({ unloaded: false });
    } finally {
      await f.close();
    }
  });

  it("reports unloaded when the mapped provider UUID is absent from the inventory", async () => {
    const providerThreadId = "8eac57df-c963-4f26-b417-2edbeeeae7e1";
    const f = await legacyThreadFixture({ "acp-fixture": providerThreadId }, new Map());
    try {
      await expect(f.owner.inspectLegacyThread("acp-fixture")).resolves.toMatchObject({
        unloaded: true, ownerGeneration: f.ownerGeneration,
      });
    } finally {
      await f.close();
    }
  });

  it.each([
    ["missing", {}],
    ["malformed string", { "acp-fixture": "not-a-provider-uuid" }],
    ["malformed null", { "acp-fixture": null }],
    ["malformed object", { "acp-fixture": { id: "8eac57df-c963-4f26-b417-2edbeeeae7e1" } }],
  ])(
    "refuses legacy inspection when the ACP mapping is %s",
    async (_label, sessionRefs) => {
      const f = await legacyThreadFixture(sessionRefs, new Map());
      try {
        await expect(f.owner.inspectLegacyThread("acp-fixture")).rejects.toMatchObject({ code: "agent_unavailable" });
        expect(loadedStatuses).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
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

/**
 * Codex 0.159+ binds its socket in a private directory of its own and leaves a
 * link at the `--listen unix://PATH` it was given (RCA 2026-10-01: 0.10.3's
 * Codex never counted as started, so its update rolled back every time).
 */
describe.skipIf(process.platform === "win32")("a Codex socket reached through a link", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
  async function linked() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cx-")));
    cleanup.push(() => rm(base, { recursive: true, force: true }));
    const daemon = join(base, "d"), owner = join(base, "o");
    await mkdir(daemon, { mode: 0o700 }); await mkdir(owner, { mode: 0o700 });
    return { base, daemon, path: join(owner, "s"), target: join(daemon, "t") };
  }
  async function listen(path: string): Promise<Server> {
    const server = createServer(socket => socket.end());
    server.listen(path); await once(server, "listening");
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    return server;
  }
  const running = { exitCode: null, signalCode: null } as PipedChildProcess;

  it("still takes a plain socket at the path, as Codex 0.153 binds it", async () => {
    const f = await linked();
    const ready = waitForCodexSocket(f.path, running, 5_000);
    const server = await listen(f.path); await chmod(f.path, 0o666);
    await expect(ready).resolves.toBeUndefined();
    expect((await lstat(f.path)).mode & 0o777).toBe(0o600);
    await expect(prepareCodexSocket(f.path, true)).resolves.toBe("adopt");
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanupCodexSocket(f.path);
    await expect(prepareCodexSocket(f.path, true)).resolves.toBe("spawn");
  });

  it("counts the linked socket as ready and makes the socket itself private", async () => {
    const f = await linked();
    const ready = waitForCodexSocket(f.path, running, 5_000);
    await listen(f.target); await chmod(f.target, 0o666);
    await symlink(f.target, f.path);
    await expect(ready).resolves.toBeUndefined();
    expect((await stat(f.target)).mode & 0o777).toBe(0o600);
  });

  it("adopts a live linked server, and removes only the link once that server is gone", async () => {
    const f = await linked();
    const server = await listen(f.target); await chmod(f.target, 0o600);
    await symlink(f.target, f.path);
    await expect(prepareCodexSocket(f.path, true)).resolves.toBe("adopt");
    await new Promise<void>(resolve => server.close(() => resolve()));
    await expect(prepareCodexSocket(f.path)).rejects.toThrow(/stale/);
    await expect(prepareCodexSocket(f.path, true)).resolves.toBe("spawn");
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up a link left dangling, and never one that leads where another user can reach", async () => {
    const f = await linked();
    await symlink(join(f.daemon, "gone"), f.path);
    await cleanupCodexSocket(f.path);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await listen(f.target); await chmod(f.target, 0o600);
    await symlink(f.target, f.path);
    await chmod(f.daemon, 0o755);
    await expect(prepareCodexSocket(f.path, true)).rejects.toThrow(/not a private local-user socket/);
    await cleanupCodexSocket(f.path);
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
    await expect(waitForCodexSocket(f.path, running, 300)).rejects.toThrow(/did not become ready in time/);
  });
});
