import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import { runLogout, startLoginFlow } from "../auth/login-flow.js";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";

vi.mock("../auth/login-flow.js", () => ({ runLogout: vi.fn(async () => ({ code: 0 })), startLoginFlow: vi.fn() }));

const roots: string[] = [], runtimes: AgentRuntime[] = [];
it("does not change the normal local Codex login through connector auth actions", async () => {
  const spawn = vi.fn();
  const runtime = new AgentRuntime({ config: RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "codex", RUNNER_NATIVE_CODEX_HOME: "/operator/.codex",
    RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile,
  }), spawn });
  const logoutCalls = vi.mocked(runLogout).mock.calls.length;
  const loginCalls = vi.mocked(startLoginFlow).mock.calls.length;
  expect(() => runtime.startLogin({ organization: false })).toThrow(/normal local Codex/);
  await expect(runtime.logout()).rejects.toThrow(/normal local Codex/);
  expect(runLogout).toHaveBeenCalledTimes(logoutCalls);
  expect(startLoginFlow).toHaveBeenCalledTimes(loginCalls);
  expect(spawn).not.toHaveBeenCalled();
});
it("runs the device login the person asked for in their own Codex profile (WS1-115)", () => {
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "codex", RUNNER_NATIVE_CODEX_HOME: "/operator/.codex",
    RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile,
  });
  const runtime = new AgentRuntime({ config, spawn: vi.fn() });
  vi.mocked(startLoginFlow).mockReturnValueOnce({ loginId: "site-login", done: new Promise(() => undefined), input: vi.fn(), cancel: vi.fn(async () => undefined) });
  expect(runtime.startLogin({ organization: false, loginId: "site-login", personal: true }).loginId).toBe("site-login");
  expect(vi.mocked(startLoginFlow).mock.lastCall?.[0]).toMatchObject({ loginId: "site-login", env: expect.objectContaining({ CODEX_HOME: "/operator/.codex" }) });
});
it("runs the installed Claude Code's own login only when the person asked for it", () => {
  const runtime = new AgentRuntime({ config: RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "claude-code", RUNNER_NATIVE_CLAUDE_EXECUTABLE: "/operator/bin/claude",
    RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture("macos", "arm64", "claude-code").profile,
  }), spawn: vi.fn() });
  const loginCalls = vi.mocked(startLoginFlow).mock.calls.length;
  expect(() => runtime.startLogin({ organization: false })).toThrow(/installed Claude Code/);
  expect(startLoginFlow).toHaveBeenCalledTimes(loginCalls);
  vi.mocked(startLoginFlow).mockReturnValueOnce({ loginId: "site-login", done: new Promise(() => undefined), input: vi.fn(), cancel: vi.fn(async () => undefined) });
  expect(runtime.startLogin({ organization: false, loginId: "site-login", personal: true }).loginId).toBe("site-login");
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(limit = 2, executionSpawnProcess?: SpawnBridgeOptions["spawnProcess"], bootstrapTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "execution-owner-")); roots.push(root);
  const owners: Array<{ bridge: BridgeProcess; handlers: SpawnBridgeOptions["handlers"] }> = [];
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    const sessionId = `private-${owners.length}`;
    const bridge: BridgeProcess = { exited: false, initializeResult: { protocolVersion: 1 }, stderrTail: () => [],
      connection: { newSession: vi.fn(async () => ({ sessionId })), prompt: vi.fn(async () => ({ stopReason: "end_turn" })), cancel: vi.fn(async () => undefined) } as never,
      stop: vi.fn(async () => undefined) };
    owners.push({ bridge, handlers: input.handlers }); return bridge;
  });
  const runtime = new AgentRuntime({ config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: root, RUNNER_WORKSPACE_DIR: root,
    ...(bootstrapTimeoutMs === undefined ? {} : { RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS: bootstrapTimeoutMs }) }), spawn, executionBridgeLimit: () => limit,
    ...(executionSpawnProcess ? { executionSpawnProcess } : {}) });
  runtimes.push(runtime); await runtime.ensureBridge();
  return { root, runtime, owners, spawn, input: { context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "codex" }, cwd: root, mcpServers: [] } };
}

it("reserves before spawning execution and retains both concurrent reference writes", async () => {
  const f = await fixture();
  const beforeCreate = vi.fn(async () => { expect(f.spawn).toHaveBeenCalledTimes(1); });
  const [first, second] = await Promise.all([
    f.runtime.sessions.create({ ...f.input, lifecycle: { beforeCreate, assertCurrent: () => undefined } }),
    f.runtime.sessions.create({ ...f.input, lifecycle: { beforeCreate, assertCurrent: () => undefined } }),
  ]);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.owners[0]!.bridge.connection.newSession).not.toHaveBeenCalled();
  f.runtime.sessions.prompt(first.acpSessionRef, "a", { prompt: [] });
  f.runtime.sessions.prompt(second.acpSessionRef, "b", { prompt: [] });
  expect(f.owners[1]!.bridge.connection.prompt).toHaveBeenCalledOnce();
  expect(f.owners[2]!.bridge.connection.prompt).toHaveBeenCalledOnce();
  const stored = JSON.parse(await readFile(join(f.root, "session-refs.json"), "utf8"));
  expect(Object.keys(stored).sort()).toEqual([first.acpSessionRef, second.acpSessionRef].sort());
});

it("selects the execution process adapter without applying it to control or login", async () => {
  const processSpawner = vi.fn() as unknown as NonNullable<SpawnBridgeOptions["spawnProcess"]>;
  const f = await fixture(1, processSpawner);
  await f.runtime.sessions.create(f.input);
  expect(f.spawn.mock.calls[0]![0].spawnProcess).toBeUndefined();
  expect(f.spawn.mock.calls[1]![0].spawnProcess).toBe(processSpawner);
});

it("persists the exact process owner before ACP initialization can create a session", async () => {
  const f = await fixture(1);
  const durable = Promise.withResolvers<void>();
  const retainedProcessOwner = { version: 1 as const, platform: "darwin" as const, pid: 123, processGroupId: 123, startToken: "start", commandDigest: "A".repeat(43) };
  const candidate = { ...f.owners[0]!.bridge, retainedProcessOwner };
  f.spawn.mockImplementationOnce(async input => {
    await input.onProcessOwner?.(candidate);
    expect(candidate.connection.newSession).not.toHaveBeenCalled();
    return candidate;
  });
  const creating = f.runtime.sessions.create({ ...f.input, lifecycle: {
    beforeCreate: async () => undefined,
    recordProcessOwner: async owner => { expect(owner).toEqual(retainedProcessOwner); await durable.promise; },
    assertCurrent: () => undefined,
  } });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
  expect(candidate.connection.newSession).not.toHaveBeenCalled();
  durable.resolve();
  await creating;
  expect(candidate.connection.newSession).toHaveBeenCalledOnce();
});

it("replaces a timed-out pre-ready owner with a freshly initialized bridge in the same assignment", async () => {
  const f = await fixture(1, undefined, 2);
  const owner = (pid: number) => ({ version: 1 as const, platform: "darwin" as const, pid, processGroupId: pid,
    startToken: `start-${pid}`, commandDigest: "A".repeat(43) });
  const make = (pid: number, hangs: boolean) => {
    let exited = false;
    const bridge: BridgeProcess = {
      get exited() { return exited; }, retainedProcessOwner: owner(pid), initializeResult: { protocolVersion: 1 }, stderrTail: () => [],
      connection: { newSession: hangs ? vi.fn(() => new Promise<never>(() => undefined)) : vi.fn(async () => ({ sessionId: `private-${pid}` })) } as never,
      stop: vi.fn(async () => { exited = true; }),
    };
    return bridge;
  };
  const first = make(501, true), second = make(502, false);
  for (const bridge of [first, second]) {
    f.spawn.mockImplementationOnce(async input => {
      await input.onProcessOwner?.(bridge);
      f.owners.push({ bridge, handlers: input.handlers });
      return bridge;
    });
  }
  const replaceProcessOwner = vi.fn(async () => undefined);
  const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined,
    replaceProcessOwner, assertCurrent: () => undefined };

  await expect(f.runtime.sessions.create({ ...f.input, lifecycle })).resolves.toMatchObject({ resumed: false });
  expect(first.connection.newSession).toHaveBeenCalledOnce();
  expect(first.stop).toHaveBeenCalledOnce();
  expect(second.connection.newSession).toHaveBeenCalledOnce();
  expect(replaceProcessOwner).toHaveBeenCalledWith(owner(501), owner(502));
});

it("consumes a bootstrap attempt when fresh bridge initialization fails and never leaves its dead owner durable", async () => {
  const f = await fixture(1, undefined, 2);
  const retained = (pid: number) => ({ version: 1 as const, platform: "darwin" as const, pid, processGroupId: pid,
    startToken: `start-${pid}`, commandDigest: "A".repeat(43) });
  const failedStop = vi.fn(async () => undefined);
  const failedOwner = { exited: true, retainedProcessOwner: retained(601), stop: failedStop };
  f.spawn.mockImplementationOnce(async input => {
    await input.onProcessOwner?.(failedOwner);
    throw new RemoteInstanceError("agent_unavailable", "initialize failed");
  });
  let exited = false;
  const recovered: BridgeProcess = {
    get exited() { return exited; }, retainedProcessOwner: retained(602), initializeResult: { protocolVersion: 1 }, stderrTail: () => [],
    connection: { newSession: vi.fn(async () => ({ sessionId: "recovered" })) } as never,
    stop: vi.fn(async () => { exited = true; }),
  };
  f.spawn.mockImplementationOnce(async input => { await input.onProcessOwner?.(recovered); f.owners.push({ bridge: recovered, handlers: input.handlers }); return recovered; });
  const recordProcessOwner = vi.fn(async () => undefined);
  const replaceProcessOwner = vi.fn(async () => undefined);

  await expect(f.runtime.sessions.create({ ...f.input, lifecycle: { beforeCreate: async () => undefined,
    recordProcessOwner, replaceProcessOwner, assertCurrent: () => undefined } })).resolves.toMatchObject({ resumed: false });
  expect(failedStop).toHaveBeenCalledOnce();
  expect(recordProcessOwner).toHaveBeenCalledWith(retained(601));
  expect(replaceProcessOwner).toHaveBeenCalledWith(retained(601), retained(602));
  expect(recovered.connection.newSession).toHaveBeenCalledOnce();
});

it("bounds retained execution owners and never falls back to the control bridge", async () => {
  const f = await fixture(1);
  const first = await f.runtime.sessions.create(f.input);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  expect(f.spawn).toHaveBeenCalledTimes(2);
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  expect(f.spawn).toHaveBeenCalledTimes(2); // Exit is not qualified slot release.
});

it("returns the slot on qualified finalization while the retained reference stays owned", async () => {
  const f = await fixture(1);
  const first = await f.runtime.sessions.create(f.input);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  // A bare stop holds the slot; only an explicit qualified finalization — the
  // caller having proven the session is gone — returns the bounded allocation.
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  await f.runtime.stopExecutionBridge(first.acpSessionRef, { finalize: true });
  const second = await f.runtime.sessions.create(f.input);
  expect(second.acpSessionRef).not.toBe(first.acpSessionRef);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  // The key is never dropped, so the finalized reference still resolves to its
  // own retained owner rather than reading as an unknown one.
  await expect(f.runtime.stopExecutionBridge(first.acpSessionRef)).resolves.toBeUndefined();
  await expect(f.runtime.stopExecutionBridge("never-owned")).rejects.toThrow(/Unknown native execution bridge owner/);
});

it("fences all execution sessions before official logout and stops their exact owners", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input), second = await f.runtime.sessions.create(f.input);
  vi.mocked(runLogout).mockImplementationOnce(async () => {
    expect(f.runtime.readiness().connectionState).toBe("starting");
    expect(() => f.runtime.sessions.prompt(first.acpSessionRef, "late", { prompt: [] })).toThrow();
    expect(() => f.runtime.sessions.prompt(second.acpSessionRef, "late", { prompt: [] })).toThrow();
    return { code: 0 };
  });
  await f.runtime.logout();
  expect(f.owners[1]!.bridge.stop).toHaveBeenCalledOnce();
  expect(f.owners[2]!.bridge.stop).toHaveBeenCalledOnce();
  expect(f.owners[0]!.bridge.stop).toHaveBeenCalledOnce();
});

it("does not restore control readiness when logout execution cleanup is uncertain", async () => {
  const f = await fixture();
  await f.runtime.sessions.create(f.input);
  vi.mocked(f.owners[1]!.bridge.stop).mockRejectedValue(new Error("stop uncertain"));
  await expect(f.runtime.logout()).rejects.toThrow("Execution stop is uncertain");
  expect(f.runtime.readiness().connectionState).not.toBe("ready");
  // Failed owner stop is deliberately retained; avoid hiding that error in teardown.
  runtimes.splice(runtimes.indexOf(f.runtime), 1);
});

it("keeps login reserved until execution owners stop and control authentication refreshes", async () => {
  const f = await fixture();
  const session = await f.runtime.sessions.create(f.input);
  let finishLogin!: (value: { code: number }) => void, finishStop!: () => void;
  const done = new Promise<{ code: number }>(resolve => { finishLogin = resolve; });
  const stopped = new Promise<void>(resolve => { finishStop = resolve; });
  vi.mocked(startLoginFlow).mockReturnValueOnce({ loginId: "test-login", done, input: vi.fn(), cancel: vi.fn(async () => undefined) });
  vi.mocked(f.owners[1]!.bridge.stop).mockReturnValueOnce(stopped);
  f.runtime.startLogin({ organization: false });
  finishLogin({ code: 0 });
  await vi.waitFor(() => expect(f.owners[1]!.bridge.stop).toHaveBeenCalledOnce());
  expect(f.runtime.readiness().connectionState).toBe("starting");
  expect(() => f.runtime.sessions.prompt(session.acpSessionRef, "late", { prompt: [] })).toThrow();
  expect(() => f.runtime.startLogin({ organization: false })).toThrow("already in progress");
  expect(f.owners[0]!.bridge.stop).not.toHaveBeenCalled();
  finishStop();
  await vi.waitFor(() => expect(f.runtime.loginInput("test-login", "")).toBe(false));
  expect(f.owners[0]!.bridge.stop).toHaveBeenCalledOnce();
  expect(f.spawn).toHaveBeenCalledTimes(3);
});

it("stops the exact session bridge once without touching its sibling or control owner", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input), second = await f.runtime.sessions.create(f.input);
  await f.runtime.sessions.stopForRecovery(first.acpSessionRef);
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  expect(f.owners[1]!.bridge.stop).toHaveBeenCalledOnce();
  expect(f.owners[0]!.bridge.stop).not.toHaveBeenCalled();
  expect(f.owners[2]!.bridge.stop).not.toHaveBeenCalled();
  f.owners[1]!.handlers.onExit({ code: 0, signal: null });
  f.runtime.sessions.prompt(second.acpSessionRef, "b", { prompt: [] });
  expect(f.owners[2]!.bridge.connection.prompt).toHaveBeenCalledOnce();
  expect(f.runtime.readiness().connectionState).toBe("ready");
  await expect(f.runtime.stopExecutionBridge("foreign")).rejects.toThrow();
});

it("retries a failed retained process stop while coalescing concurrent attempts", async () => {
  const f = await fixture(2);
  const first = await f.runtime.sessions.create(f.input), second = await f.runtime.sessions.create(f.input);
  let rejectStop!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectStop = reject; });
  const stop = vi.mocked(f.owners[1]!.bridge.stop).mockReturnValueOnce(pending);
  const attempts = Promise.allSettled([
    f.runtime.stopExecutionBridge(first.acpSessionRef),
    f.runtime.stopExecutionBridge(first.acpSessionRef),
  ]);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  rejectStop(new Error("stop temporarily unavailable"));
  expect((await attempts).map(result => result.status)).toEqual(["rejected", "rejected"]);
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(f.owners[0]!.bridge.stop).not.toHaveBeenCalled();
  expect(f.owners[2]!.bridge.stop).not.toHaveBeenCalled();
  f.runtime.sessions.prompt(second.acpSessionRef, "sibling", { prompt: [] });
  expect(f.owners[2]!.bridge.connection.prompt).toHaveBeenCalledOnce();
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
});

it("recovers only after initialization cleanup retries and observes exact process exit", async () => {
  const f = await fixture(1);
  let exited = false;
  const candidate = { ...f.owners[0]!.bridge, get exited() { return exited; },
    stop: vi.fn().mockRejectedValueOnce(new Error("cleanup uncertain")).mockImplementation(async () => { exited = true; }) };
  f.spawn.mockImplementationOnce(async input => { input.handlers.onExit({ code: 1, signal: null }); return candidate; });
  let ref = "";
  await expect(f.runtime.sessions.create({ ...f.input, lifecycle: { beforeCreate: async value => { ref = value; }, assertCurrent: () => undefined } })).resolves.toMatchObject({ resumed: false });
  await f.runtime.stopExecutionBridge(ref);
  expect(candidate.stop).toHaveBeenCalledTimes(2);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  expect(f.runtime.readiness().connectionState).toBe("ready");
});

it("retains the process stop owner when spawn rejects before returning an initialized bridge", async () => {
  const f = await fixture(1);
  const provisional = { exited: false, stop: vi.fn(async () => undefined) };
  f.spawn.mockImplementationOnce(async input => {
    input.onProcessOwner?.(provisional);
    throw new Error("initialize cleanup uncertain");
  });
  let ref = "";
  await expect(f.runtime.sessions.create({ ...f.input, lifecycle: { beforeCreate: async value => { ref = value; }, assertCurrent: () => undefined } })).rejects.toThrow("process stop is unconfirmed");
  await f.runtime.stopExecutionBridge(ref);
  expect(provisional.stop).toHaveBeenCalledTimes(2);
  expect(f.owners[0]!.bridge.stop).not.toHaveBeenCalled();
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  expect(f.runtime.readiness().connectionState).toBe("ready");
});

it("stops the captured process before initialize settles and refuses its late success", async () => {
  const f = await fixture(1);
  const candidate = { ...f.owners[0]!.bridge, stop: vi.fn(async () => undefined) };
  let release!: (bridge: BridgeProcess) => void, ref = "";
  const pending = new Promise<BridgeProcess>(resolve => { release = resolve; });
  f.spawn.mockImplementationOnce(input => { input.onProcessOwner?.(candidate); return pending; });
  const creating = f.runtime.sessions.create({ ...f.input, lifecycle: { beforeCreate: async value => { ref = value; }, assertCurrent: () => undefined } });
  const outcome = creating.then(() => "created", () => "refused");
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
  const stopping = f.runtime.stopExecutionBridge(ref);
  try { await vi.waitFor(() => expect(candidate.stop).toHaveBeenCalled()); }
  finally { release(candidate); await stopping; }
  expect(await outcome).toBe("refused");
  expect(candidate.connection.newSession).not.toHaveBeenCalled();
  expect(f.owners[0]!.bridge.stop).not.toHaveBeenCalled();
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
});

it("fences session creation when authority is lost during execution bridge initialization", async () => {
  const f = await fixture(1);
  let release!: (value: BridgeProcess) => void, owned = true, ref = "";
  const candidate = { ...f.owners[0]!.bridge, stop: vi.fn(async () => undefined) };
  const pending = new Promise<BridgeProcess>(resolve => { release = resolve; });
  f.spawn.mockImplementationOnce(() => pending);
  const creating = f.runtime.sessions.create({ ...f.input, lifecycle: {
    beforeCreate: async value => { ref = value; },
    assertCurrent: () => { if (!owned) throw new Error("authority lost"); },
  } });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
  owned = false; release(candidate);
  await expect(creating).rejects.toThrow("authority lost");
  expect(candidate.connection.newSession).not.toHaveBeenCalled();
  await f.runtime.stopExecutionBridge(ref);
  expect(candidate.stop).toHaveBeenCalledOnce();
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
});
