import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:net";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { RunnerConfigSchema, type BridgeProcess, type SpawnBridgeOptions, type RunnerEvent } from "@konteks/remote-agent-runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeRunner } from "../native/runner.js";
import type { RunnerPort } from "../runner-port.js";

let root: string;
let runners: NativeRunner[];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-runner-")); runners = []; });
afterEach(async () => { await Promise.all(runners.map(runner => runner.stop())); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function fixture(options: { loggedOut?: boolean; startGate?: Promise<void> } = {}) {
  const events: RunnerEvent[] = [];
  let handlers!: SpawnBridgeOptions["handlers"];
  const connection = {
    newSession: vi.fn(async () => ({ sessionId: "bridge-private" })),
    loadSession: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => ({})),
    setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
  };
  const bridge: BridgeProcess = { connection: connection as unknown as ClientSideConnection, initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) };
  const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "work"), RUNNER_BRIDGE_PREFIX: join(root, "bridges") });
  const spawn = vi.fn(async (args: SpawnBridgeOptions) => { handlers = args.handlers; await options.startGate; return { ...bridge }; });
  const runner = new NativeRunner({ instanceId: "instance", config, onEvent: event => events.push(event), runtimeOptions: { spawn, probe: async () => options.loggedOut ? { kind: "logged_out" } : { kind: "signal", fingerprint: "opaque-identity-fingerprint" } } });
  const port: RunnerPort = runner;
  runners.push(runner);
  const input = { context: { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "codex" }, readinessDeadlineAt: "2099-01-01T00:00:00.000Z", cwd: join(root, "work"), mcpServers: [] };
  return { runner, port, input, config, connection, bridge, spawn, events, handlers: () => handlers };
}

describe("native in-process runner (A4)", () => {
  it("names the provider session from Core's display label", async () => {
    const f = fixture(); await f.runner.start();
    const { acpSessionRef } = await f.runner.createSession({ ...f.input, sessionLabel: { system: "Todo List", kind: "initiative", title: "[v3] Stand up the todo list API" } });
    expect(f.connection.newSession).toHaveBeenCalledWith(expect.objectContaining({ _meta: { konteksSession: { version: 1,
      title: `[konteks/Todo List/initiative] [v3] Stand up the todo list API ${acpSessionRef.slice(-8)}` } } }));
  });
  it("adds no browser for an agent package that carries none, and refuses a browser request that is not a loopback gateway", async () => {
    const f = fixture(); await f.runner.start();
    expect(f.runner.browserVersion()).toBeNull();
    const browser = { proxyUrl: "http://127.0.0.1:50123", outputDir: join(root, "out"), browsersPath: join(root, "browsers") };
    await f.runner.createSession({ ...f.input, browser });
    expect(f.connection.newSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
    await expect(f.runner.createSession({ ...f.input, browser: { ...browser, proxyUrl: "http://proxy.example:8080" } })).rejects.toThrow();
  });
  it("returns completed-turn settlement only after draining ACP and stopping its execution bridge", async () => {
    const f = fixture(); await f.runner.start(); f.runner.startEvents();
    const { acpSessionRef } = await f.runner.createSession(f.input);
    const [control, execution] = await Promise.all(f.spawn.mock.results.map(result => result.value));
    control!.stop = vi.fn(async () => undefined);
    execution!.stop = vi.fn(async () => undefined);
    await f.runner.prompt(acpSessionRef, "p", { sessionId: acpSessionRef, prompt: [{ type: "text", text: "Complete this turn." }] });
    await expect(f.runner.closeSession(acpSessionRef, { completed: true })).resolves.toEqual({ completion: "native_continuation_ready" });
    await expect(f.runner.closeSession(acpSessionRef, { completed: true })).resolves.toEqual({ completion: "native_continuation_ready" });
    expect((await f.runner.readiness()).utilization.activeSessions).toBe(1);
    expect(execution!.stop).not.toHaveBeenCalled();
    expect(control!.stop).not.toHaveBeenCalled();
    expect(f.connection.cancel).not.toHaveBeenCalled();
  });
  it("attempts exact execution stop after failed ACP cancellation without reporting settlement", async () => {
    const f = fixture(); await f.runner.start();
    const { acpSessionRef } = await f.runner.createSession(f.input);
    const [control, execution] = await Promise.all(f.spawn.mock.results.map(result => result.value));
    control!.stop = vi.fn(async () => undefined);
    execution!.stop = vi.fn(async () => undefined);
    f.connection.cancel.mockRejectedValueOnce(new Error("cancel transport failed"));
    await expect(f.runner.stopForRecovery(acpSessionRef)).rejects.toThrow("cancel transport failed");
    expect(execution!.stop).toHaveBeenCalledOnce();
    expect(control!.stop).not.toHaveBeenCalled();
    await expect(f.runner.prompt(acpSessionRef, "late", { sessionId: acpSessionRef, prompt: [] })).rejects.toThrow();
  });

  it("keeps the authentication bridge and a second execution alive when stopping the first", async () => {
    const f = fixture(); await f.runner.start();
    f.connection.newSession.mockResolvedValueOnce({ sessionId: "first-private" }).mockResolvedValueOnce({ sessionId: "second-private" });
    const first = await f.runner.createSession(f.input), second = await f.runner.createSession(f.input);
    expect(f.spawn).toHaveBeenCalledTimes(3);
    const [control, firstBridge, secondBridge] = await Promise.all(f.spawn.mock.results.map(result => result.value));
    control!.stop = vi.fn(async () => undefined);
    firstBridge!.stop = vi.fn(async () => undefined);
    secondBridge!.stop = vi.fn(async () => undefined);
    await f.runner.stopForRecovery(first.acpSessionRef);
    expect(firstBridge!.stop).toHaveBeenCalledOnce();
    expect(control!.stop).not.toHaveBeenCalled();
    expect(secondBridge!.stop).not.toHaveBeenCalled();
    await f.runner.prompt(second.acpSessionRef, "still-live", { sessionId: second.acpSessionRef, prompt: [{ type: "text", text: "continue" }] });
    expect(f.connection.prompt).toHaveBeenCalledWith({ sessionId: "second-private", prompt: [{ type: "text", text: "continue" }] });
    expect((await f.runner.readiness()).agent.readiness).toBe("ready");
  });

  it("keeps an idle released process resident, serves the next session from it and refuses a retained stop of it", async () => {
    const f = fixture(); await f.runner.start();
    const retainedProcessOwner = { version: 1 as const, platform: "darwin" as const, pid: 4242, processGroupId: 4242, startToken: "start", commandDigest: "A".repeat(43) };
    // Execution spawns hand the exact stop handle (with its durable identity) over before initialize, as the real spawn does.
    f.spawn.mockImplementation(async (args: SpawnBridgeOptions) => {
      const candidate = { ...f.bridge, retainedProcessOwner, stop: vi.fn(async () => undefined) };
      await args.onProcessOwner?.(candidate);
      return candidate;
    });
    f.connection.newSession.mockResolvedValueOnce({ sessionId: "first-private" }).mockResolvedValueOnce({ sessionId: "second-private" });
    const recordProcessOwner = vi.fn(async () => undefined);
    const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner, assertCurrent: () => undefined };
    const first = await f.runner.createSession(f.input, lifecycle);
    const execution = await f.spawn.mock.results[1]!.value;
    await f.runner.prompt(first.acpSessionRef, "p", { sessionId: first.acpSessionRef, prompt: [{ type: "text", text: "Complete this turn." }] });
    await f.runner.closeSession(first.acpSessionRef, { completed: true });
    await expect(f.runner.releaseSealedSession(first.acpSessionRef)).resolves.toEqual({ processRetained: true });
    expect(execution.stop).not.toHaveBeenCalled();
    const second = await f.runner.createSession(f.input, lifecycle);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.connection.newSession).toHaveBeenCalledTimes(2);
    expect(recordProcessOwner).toHaveBeenCalledTimes(2);
    expect(recordProcessOwner).toHaveBeenLastCalledWith(retainedProcessOwner);
    // The predecessor's journaled owner names the process the successor now runs on.
    await expect(f.runner.stopRetainedExecution(retainedProcessOwner)).rejects.toMatchObject({ code: "recovery_required" });
    expect(execution.stop).not.toHaveBeenCalled();
    await f.runner.prompt(second.acpSessionRef, "q", { sessionId: second.acpSessionRef, prompt: [{ type: "text", text: "continue" }] });
    expect(f.connection.prompt).toHaveBeenLastCalledWith({ sessionId: "second-private", prompt: [{ type: "text", text: "continue" }] });
  });

  it("refuses prior-reference adoption without qualified predecessor ownership", async () => {
    const f = fixture(); await f.runner.start(); const beforeCreate = vi.fn(async () => undefined);
    await expect(f.port.createSession({ ...f.input, acpSessionRef: "prior" }, { beforeCreate, assertCurrent: () => undefined })).rejects.toThrow("predecessor");
    expect(beforeCreate).not.toHaveBeenCalled(); expect(f.connection.newSession).not.toHaveBeenCalled();
  });

  it("loads a persisted provider session after restart under a new fenced local reference", async () => {
    const beforeRestart = fixture(); await beforeRestart.runner.start();
    const original = await beforeRestart.runner.createSession(beforeRestart.input);
    await beforeRestart.runner.stop();

    const afterRestart = fixture(); await afterRestart.runner.start();
    const beforeCreate = vi.fn(async () => undefined);
    const restored = await afterRestart.port.createSession({ ...afterRestart.input, restoreAcpSessionRef: original.acpSessionRef }, {
      beforeCreate, recordProcessOwner: async () => undefined, assertCurrent: () => undefined,
    });
    expect(restored).toMatchObject({ resumed: true });
    expect(restored.acpSessionRef).not.toBe(original.acpSessionRef);
    expect(beforeCreate).toHaveBeenCalledWith(restored.acpSessionRef);
    expect(afterRestart.connection.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "bridge-private" }));
    expect(afterRestart.connection.newSession).not.toHaveBeenCalled();
  });
  it("settles recovery and stops its dedicated execution bridge", async () => {
    const f = fixture(); await f.runner.start();
    const gate = Promise.withResolvers<{ stopReason: string }>();
    f.connection.prompt.mockImplementation(() => gate.promise);
    const { acpSessionRef } = await f.port.createSession(f.input);
    await f.port.prompt(acpSessionRef, "prompt", { sessionId: acpSessionRef, prompt: [{ type: "text", text: "work" }] });
    let stopped = false;
    const stopping = f.runner.stopForRecovery(acpSessionRef).then(() => { stopped = true; });
    await vi.waitFor(() => expect(f.connection.cancel).toHaveBeenCalledTimes(1));
    expect(stopped).toBe(false);
    gate.resolve({ stopReason: "cancelled" }); await stopping;
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.bridge.stop).toHaveBeenCalledOnce();
    expect((await f.port.readiness()).utilization).toEqual({ activeSessions: 1, activeTurns: 0 });
  });

  it("passes the native ownership reservation before ACP new and fences later input", async () => {
    const f = fixture(); await f.runner.start(); let owned = true;
    const beforeCreate = vi.fn(async (ref: string) => { expect(ref).toMatch(/^acp-/); expect(f.connection.newSession).not.toHaveBeenCalled(); });
    const { acpSessionRef } = await f.port.createSession(f.input, { beforeCreate, assertCurrent: () => { if (!owned) throw new Error("ownership lost"); } });
    expect(beforeCreate).toHaveBeenCalledWith(acpSessionRef);
    owned = false;
    await expect(f.port.prompt(acpSessionRef, "late", { sessionId: acpSessionRef, prompt: [{ type: "text", text: "work" }] })).rejects.toThrow("ownership lost");
    expect(f.connection.prompt).not.toHaveBeenCalled();
  });

  it("starts one runtime without a listening server and keeps a single event subscription", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const f = fixture();
    await Promise.all([f.runner.start(), f.runner.start()]);
    f.runner.startEvents();
    f.runner.startEvents();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
    expect(await f.port.readiness()).toMatchObject({ agent: { agentId: "codex", authMode: "agent_local_subscription", readiness: "ready" }, utilization: { activeSessions: 0, activeTurns: 0 } });
    const count = f.events.length;
    await f.port.probe();
    expect(f.events.length).toBe(count + 1);
    await Promise.all([f.runner.stop(), f.runner.stop()]);
    expect(f.bridge.stop).toHaveBeenCalledOnce();
    await expect(f.port.readiness()).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(f.port.createSession(f.input)).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(f.runner.start()).rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("waits for an in-flight start before stopping the bridge", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ startGate: gate });
    const starting = f.runner.start();
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    const stopping = f.runner.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(f.bridge.stop).toHaveBeenCalledOnce();
    await expect(f.port.createSession(f.input)).rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("rejects BYOK configuration before spawning anything", () => {
    const f = fixture();
    for (const config of [{ ...f.config, RUNNER_AUTH_MODE: "gateway_keyed" }]) {
      expect(() => new NativeRunner({ instanceId: "instance", config: config as typeof f.config, onEvent: () => undefined })).toThrow(/native|subscription/i);
    }
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("fails closed for an unready agent and rejects wrong placement identity", async () => {
    const unready = fixture({ loggedOut: true });
    await unready.runner.start();
    await expect(unready.port.createSession(unready.input)).rejects.toMatchObject({ code: "agent_auth_required" });
    expect(unready.connection.newSession).not.toHaveBeenCalled();
    await unready.runner.stop();
    const f = fixture();
    await f.runner.start();
    for (const context of [{ ...f.input.context, agentId: "claude-code" }, { ...f.input.context, instanceId: "other" }]) {
      await expect(f.port.createSession({ ...f.input, context })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    }
    expect(f.connection.newSession).not.toHaveBeenCalled();
  });

  it("validates requests and correlates real runtime messages, tools, permissions and completions", async () => {
    const f = fixture();
    await f.runner.start();
    const { acpSessionRef: ref } = await f.port.createSession(f.input);
    const prompt = { sessionId: ref, prompt: [{ type: "text", text: "Run tests" }] };
    await expect(f.port.prompt(ref, "bad", { ...prompt, sessionId: "other" })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    await expect(f.port.prompt(ref, "bad", { sessionId: ref, prompt: "invalid" })).rejects.toMatchObject({ code: "protocol_incompatible" });
    expect(f.connection.prompt).not.toHaveBeenCalled();
    await f.port.prompt(ref, "turn", prompt);
    expect(f.connection.prompt).toHaveBeenCalledWith({ sessionId: "bridge-private", prompt: prompt.prompt });
    f.handlers().onSessionUpdate({ sessionId: "bridge-private", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Testing" } } });
    f.handlers().onSessionUpdate({ sessionId: "bridge-private", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Test", status: "in_progress" } });
    expect(f.events.filter(event => event.kind === "session_update")).toEqual([
      { kind: "session_update", acpSessionRef: ref, params: { sessionId: ref, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Testing" } } } },
      { kind: "session_update", acpSessionRef: ref, params: { sessionId: ref, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Test", status: "in_progress" } } },
    ]);
    const pending = f.handlers().onRequestPermission({ sessionId: "bridge-private", toolCall: { toolCallId: "tool-1", title: "Test" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] });
    const request = f.events.find(event => event.kind === "permission_request")!;
    if (request.kind !== "permission_request") throw new Error("missing permission");
    const answer = { outcome: { outcome: "selected", optionId: "allow" } };
    expect(await f.port.answer(ref, request.requestId, answer)).toEqual({ delivered: true });
    expect(await f.port.answer(ref, request.requestId, answer)).toEqual({ delivered: false });
    await expect(pending).resolves.toEqual(answer);
    await vi.waitFor(() => expect(f.events).toContainEqual({ kind: "prompt_result", acpSessionRef: ref, requestId: "turn", result: { stopReason: "end_turn" } }));
    expect(JSON.stringify(f.events)).not.toContain("bridge-private");
  });
});

describe("native DeepSeek Harness runner", () => {
  const dshConfig = () => RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "work"), RUNNER_BRIDGE_PREFIX: "/opt/dsh",
    RUNNER_NATIVE_DSH_ROOT: "/opt/dsh", RUNNER_NATIVE_DSH_ENTRY: "/opt/dsh/lib/bin.js", RUNNER_NATIVE_DSH_NODE: "/opt/node/bin/node", RUNNER_BRIDGE_VERSION: "0.1.7-rc.2",
  });
  const bridge = (): BridgeProcess => ({ connection: {} as ClientSideConnection, initializeResult: { protocolVersion: 1 }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) });

  it("proves the Konteks overlay is in force in this exact installation before dsh ever starts", async () => {
    const order: string[] = [];
    const check = vi.fn(async (options: { node: string; installation: { root: string; entry: string; version: string }; dshHome: string; konteksDir: string }) => { order.push("check"); void options; });
    const spawn = vi.fn(async () => { order.push("spawn"); return bridge(); });
    const runner = new NativeRunner({ instanceId: "instance", config: dshConfig(), onEvent: () => undefined, dshProfileCheck: check,
      runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" }) } });
    runners.push(runner);
    await runner.start();
    expect(order).toEqual(["check", "spawn"]);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      node: "/opt/node/bin/node", installation: { root: "/opt/dsh", entry: "/opt/dsh/lib/bin.js", version: "0.1.7-rc.2" },
      dshHome: join(root, "credentials", ".dsh"), konteksDir: join(root, "credentials", "konteks-dsh"),
    }));
  });

  it("can be started again after a failed start, so a background retry really retries", async () => {
    const spawn = vi.fn(async () => bridge());
    let checks = 0;
    const runner = new NativeRunner({ instanceId: "instance", config: dshConfig(), onEvent: () => undefined,
      dshProfileCheck: async () => { checks += 1; if (checks === 1) throw new Error("dsh not supported yet"); },
      runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" }) } });
    runners.push(runner);
    await expect(runner.start()).rejects.toThrow("dsh not supported yet");
    expect(spawn).not.toHaveBeenCalled();
    await runner.start();
    expect(checks).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(runner.readiness()).resolves.toMatchObject({ agent: { agentId: "dsh" } });
  });

  it("never spawns a dsh whose composed profile drifted", async () => {
    const spawn = vi.fn(async () => bridge());
    const drift = Object.assign(new Error("DeepSeek Harness 0.1.7-rc.2 does not accept the Konteks settings"), { code: "prerequisite_missing", diagnostic: "dsh_profile_drift" });
    const runner = new NativeRunner({ instanceId: "instance", config: dshConfig(), onEvent: () => undefined, dshProfileCheck: async () => { throw drift; },
      runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" }) } });
    runners.push(runner);
    await expect(runner.start()).rejects.toMatchObject({ diagnostic: "dsh_profile_drift" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
