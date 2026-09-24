import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError, type Logger } from "@konteks/remote-common";
import { RequestError, type ClientSideConnection, type InitializeResponse } from "@agentclientprotocol/sdk";
import type { BridgeProcess } from "../bridge/process.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import { InMemorySessionRefStore, SessionManager } from "../sessions/manager.js";

function fakeBridge(overrides: Partial<Record<keyof ClientSideConnection, unknown>> = {}, initialize: Partial<InitializeResponse> = {}): { bridge: BridgeProcess; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, result: unknown) =>
    vi.fn(async (params: unknown) => {
      (calls[name] ??= []).push(params);
      if (result instanceof Error) throw result;
      return result;
    });
  const connection = {
    newSession: record("newSession", { sessionId: "bridge-s1" }),
    loadSession: record("loadSession", {}),
    resumeSession: record("resumeSession", {}),
    prompt: record("prompt", { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: 5 } }),
    cancel: record("cancel", undefined),
    setSessionMode: record("setSessionMode", {}),
    setSessionConfigOption: vi.fn(async (params: { configId: string; value: string }) => {
      (calls.setSessionConfigOption ??= []).push(params);
      return { configOptions: [{ id: params.configId, type: "select", name: "Model", currentValue: params.value, options: [{ value: params.value, name: "Selected" }] }] };
    }),
    ...overrides,
  } as unknown as ClientSideConnection;
  const bridge: BridgeProcess = {
    connection,
    initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true }, ...initialize },
    exited: false,
    stderrTail: () => [],
    stop: vi.fn(async () => undefined),
  };
  return { bridge, calls };
}

const context = { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "codex" };

async function nextEvent(bus: RunnerEventBus, kind: RunnerEvent["kind"]): Promise<RunnerEvent> {
  return new Promise((resolve) => {
    const unsubscribe = bus.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe("session manager (D98 bootstrap)", () => {
  it("hands a settled live ACP session to the next turn with fresh MCP authority", async () => {
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const first = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const beforeCreate = vi.fn(async () => undefined);
    const nextContext = { ...context, assignmentId: "asg-2" };
    const currentMcp = [{ type: "http" as const, name: "platform", url: "http://localhost/mcp", headers: [{ name: "Authorization", value: "Bearer current-turn" }] }];
    const continued = await manager.continueLive({ context: nextContext, cwd: "/w", mcpServers: currentMcp, acpSessionRef: first.acpSessionRef, lifecycle: { beforeCreate, recordProcessOwner: async () => undefined, assertCurrent: () => undefined } });
    expect(continued).toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
    expect(beforeCreate).toHaveBeenCalledWith(first.acpSessionRef);
    expect(calls.resumeSession).toEqual([{ sessionId: "bridge-s1", cwd: "/w", mcpServers: currentMcp }]);
    expect(manager.activeSessions).toBe(1);
  });

  it("refuses and cancels work the agent starts on its own after a turn, so the next turn still continues (WS2-130)", async () => {
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const first = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    // A background timer from the last turn fires; Claude Code starts a turn
    // nobody asked for and wants a tool permission.
    await expect(manager.onRequestPermission({ sessionId: "bridge-s1", toolCall: { toolCallId: "t9", title: "discovery_run_inventory_list" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }))
      .resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(manager.onCreateElicitation({ sessionId: "bridge-s1", message: "?", requestedSchema: { type: "object" } } as never)).resolves.toEqual({ action: "cancel" });
    expect(calls.cancel).toEqual([{ sessionId: "bridge-s1" }, { sessionId: "bridge-s1" }]);
    const continued = await manager.continueLive({ context: { ...context, assignmentId: "asg-2" }, cwd: "/w", mcpServers: [], acpSessionRef: first.acpSessionRef,
      lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined } });
    expect(continued).toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
  });

  it("continues a sealed session whose closed predecessor owner now rejects its own fence", async () => {
    // The live shape: the first turn's RelayedSession installed a fence that
    // rejects once that turn has closed and settled. Continuation belongs to
    // the successor; the settled predecessor's fence must not veto it.
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    let predecessorClosed = false;
    const first = await manager.create({ context, cwd: "/w", mcpServers: [], lifecycle: {
      beforeCreate: async () => undefined, recordProcessOwner: async () => undefined,
      assertCurrent: () => { if (predecessorClosed) throw new RemoteInstanceError("recovery_required", "Session generation is fenced."); },
    } });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    predecessorClosed = true;
    const successorFence = vi.fn(() => undefined);
    const continued = await manager.continueLive({ context: { ...context, assignmentId: "asg-2" }, cwd: "/w", mcpServers: [], acpSessionRef: first.acpSessionRef,
      lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: successorFence } });
    expect(continued).toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
    expect(calls.resumeSession).toHaveLength(1);
    expect(successorFence).toHaveBeenCalled();
  });

  it("releases an idle sealed session without cancelling it, and refuses one that is not sealed", async () => {
    const { bridge, calls } = fakeBridge();
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const first = await manager.create({ context, cwd: "/w", mcpServers: [], lifecycle: {
      beforeCreate: async () => undefined, recordProcessOwner: async () => undefined,
      // A closed completed owner's fence rejects; release must not depend on it.
      assertCurrent: () => undefined,
    } });
    expect(() => manager.releaseSealed(first.acpSessionRef)).toThrow("idle sealed");
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const exited = nextEvent(events, "session_exited");
    manager.releaseSealed(first.acpSessionRef);
    await exited;
    expect(manager.activeSessions).toBe(0);
    expect(calls.cancel ?? []).toEqual([]);
    await expect(manager.continueLive({ context, cwd: "/w", mcpServers: [], acpSessionRef: first.acpSessionRef })).rejects.toThrow();
  });

  it("settles completed ACP operations before close without cancelling the local user's thread", async () => {
    let current = true;
    const closeSession = vi.fn(async () => ({}));
    const { bridge, calls } = fakeBridge({ closeSession }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [], lifecycle: {
      beforeCreate: async () => undefined,
      assertCurrent: () => { if (!current) throw new Error("stale execution owner"); },
    } });
    let closed: Promise<void> | undefined;
    events.subscribe(event => { if (event.kind === "prompt_result") closed = manager.closeCompleted(acpSessionRef); });
    const result = nextEvent(events, "prompt_result");
    manager.prompt(acpSessionRef, "p", { prompt: [] });
    await result;
    await closed;
    expect(manager.activeTurns).toBe(0);
    expect(manager.activeSessions).toBe(1); // Retained until qualified finalization.
    expect(closeSession).toHaveBeenCalledWith({ sessionId: "bridge-s1" });
    await manager.closeCompleted(acpSessionRef); // Retry a failed outer journal write.
    bridge.exited = true;
    manager.closeAll("agent_exited", bridge);
    await manager.stopForRecovery(acpSessionRef);
    expect(closeSession).toHaveBeenCalledTimes(1);
    manager.close(acpSessionRef);
    expect(manager.activeSessions).toBe(1);
    expect(() => manager.prompt(acpSessionRef, "late", { prompt: [] })).toThrow();
    expect(calls.cancel).toBeUndefined();
    current = false;
    await expect(manager.stopForRecovery(acpSessionRef)).rejects.toThrow("stale execution owner");
  });

  it.each(["no_turn", "cancelled", "close_failed"])("retains the owner when completed settlement is %s", async failure => {
    const closeSession = vi.fn(async () => { throw new Error("private close failure"); });
    const { bridge, calls } = fakeBridge({ prompt: vi.fn(async () => ({ stopReason: failure === "cancelled" ? "cancelled" : "end_turn" })), closeSession }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    if (failure !== "no_turn") {
      const result = nextEvent(events, "prompt_result");
      manager.prompt(acpSessionRef, "p", { prompt: [] });
      await result;
    }
    await expect(manager.closeCompleted(acpSessionRef)).rejects.toThrow();
    await expect(manager.stopForRecovery(acpSessionRef)).rejects.toThrow();
    manager.close(acpSessionRef);
    expect(manager.activeSessions).toBe(1);
    expect(() => manager.prompt(acpSessionRef, "late", { prompt: [] })).toThrow();
    expect(calls.cancel).toBeUndefined();
  });
  it.each([true, false])("passes current MCP bindings on resume (configured=%s) without creating another session", async configured => {
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    const mcpServers = configured ? [{ type: "http" as const, name: "platform", url: "http://localhost/mcp", headers: [{ name: "Authorization", value: "Bearer current-test-assignment" }] }] : [];
    await expect(manager.create({ context, cwd: "/w", mcpServers, acpSessionRef: "acp-prior", sessionConfig: { model: "approved" } })).resolves.toMatchObject({ acpSessionRef: "acp-prior", resumed: true });
    expect(calls.resumeSession).toEqual([{ sessionId: "bridge-old", cwd: "/w", mcpServers }]);
    expect(calls.loadSession).toBeUndefined();
    expect(calls.newSession).toBeUndefined();
    expect(calls.setSessionConfigOption?.[0]).toMatchObject({ sessionId: "bridge-old", configId: "model", value: "approved" });
    expect(await store.get("acp-prior")).toBe("bridge-old");
  });
  it.each(["codex", "claude-code", "opencode"])("marks new %s sessions without renaming resumed sessions", async agentId => {
    const { bridge, calls } = fakeBridge();
    const store = new InMemorySessionRefStore();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    await manager.create({ context: { ...context, agentId }, cwd: "/w", mcpServers: [] });
    expect(calls.newSession?.[0]).toMatchObject({ _meta: { konteksSession: { version: 1, title: expect.stringMatching(/^\[konteks\] Coding session /) } } });
    await store.put("acp-prior", "bridge-old");
    await manager.create({ context: { ...context, agentId }, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior" });
    expect(calls.loadSession?.[0]).not.toHaveProperty("_meta");
    expect(calls.newSession).toHaveLength(1);
  });
  it("refuses a later setting that resets an already confirmed model", async () => {
    const option = (id: string, currentValue: string) => ({ id, type: "select", name: id, currentValue, options: [{ value: currentValue, name: currentValue }] });
    const setSessionConfigOption = vi.fn(async ({ configId }: { configId: string }) => ({ configOptions:
      configId === "model" ? [option("model", "approved")] : [option("model", "default"), option("effort", "high")],
    }));
    const { bridge } = fakeBridge({ setSessionConfigOption });
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], sessionConfig: { model: "approved", effort: "high" } })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
  });
  it.each(["rejected", "missing", "mismatch", "duplicate"] as const)("refuses %s admitted configuration and fences the retained owner", async mode => {
    const selected = { id: "model", type: "select", name: "Model", currentValue: "approved", options: [{ value: "approved", name: "Approved" }] };
    const setSessionConfigOption = vi.fn(async () => {
      if (mode === "rejected") throw new Error("private bridge diagnostic");
      return { configOptions: mode === "missing" ? [] : mode === "duplicate" ? [selected, selected] : [{ ...selected, currentValue: "default" }] };
    });
    const { bridge, calls } = fakeBridge({ setSessionConfigOption });
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    let retainedRef = "";
    await expect(manager.create({ context, cwd: "/w", mcpServers: [],
      sessionConfig: { model: "approved" }, lifecycle: { beforeCreate: async ref => { retainedRef = ref; }, assertCurrent: () => undefined } })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(manager.activeSessions).toBe(1);
    expect(() => manager.prompt(retainedRef, "forbidden", { prompt: [] })).toThrow(/fenced/);
    manager.close(retainedRef);
    expect(manager.activeSessions).toBe(1);
    expect(calls.prompt).toBeUndefined();
  });

  it("reapplies and confirms admitted configuration after loading a prior session", async () => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const { bridge, calls } = fakeBridge();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior", sessionConfig: { model: "approved" } })).resolves.toMatchObject({ resumed: true });
    expect(calls.setSessionConfigOption).toEqual([{ sessionId: "bridge-old", configId: "model", value: "approved" }]);
  });
  it("closes only the owning session after its prompt settles when close is negotiated", async () => {
    let finishPrompt!: () => void;
    const order: string[] = [];
    const prompt = new Promise<{ stopReason: string }>(resolve => { finishPrompt = () => { order.push("prompt-settled"); resolve({ stopReason: "cancelled" }); }; });
    const closeSession = vi.fn(async (input: unknown) => { order.push("close"); expect(input).toEqual({ sessionId: "bridge-s1" }); return {}; });
    const first = fakeBridge({ prompt: vi.fn(() => prompt), closeSession }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const replacement = fakeBridge();
    let current = first.bridge;
    const manager = new SessionManager({ bridge: () => current, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    manager.prompt(acpSessionRef, "p", { prompt: [] });
    current = replacement.bridge;
    const stopped = manager.stopForRecovery(acpSessionRef);
    await Promise.resolve();
    expect(closeSession).not.toHaveBeenCalled();
    finishPrompt();
    await stopped;
    expect(order).toEqual(["prompt-settled", "close"]);
    expect(closeSession).toHaveBeenCalledOnce();
    await manager.stopForRecovery(acpSessionRef);
    expect(closeSession).toHaveBeenCalledOnce();
    expect(Object.keys(replacement.calls)).toEqual([]);
    expect(manager.activeSessions).toBe(1); // Not qualified finalization.
    expect(() => manager.prompt(acpSessionRef, "late", { prompt: [] })).toThrow();
  });

  it("retains a fenced owner after advertised session close fails", async () => {
    const closeSession = vi.fn(async () => { throw new Error("close outcome unknown"); });
    const { bridge } = fakeBridge({ closeSession }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    await expect(manager.stopForRecovery(acpSessionRef)).rejects.toThrow("close outcome unknown");
    manager.close(acpSessionRef);
    expect(manager.activeSessions).toBe(1);
    await expect(manager.stopForRecovery(acpSessionRef)).rejects.toThrow();
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it("keeps session commands and recovery cancellation on the creating bridge", async () => {
    const first = fakeBridge(), replacement = fakeBridge();
    let current = first.bridge;
    const manager = new SessionManager({ bridge: () => current, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    current = replacement.bridge;
    manager.prompt(acpSessionRef, "prompt", { prompt: [] });
    manager.setMode(acpSessionRef, "mode", { modeId: "default" });
    manager.setConfigOption(acpSessionRef, "config", { configId: "model", value: "test" });
    manager.cancel(acpSessionRef);
    await manager.stopForRecovery(acpSessionRef);
    expect(Object.keys(replacement.calls)).toEqual([]);
    expect(first.calls.prompt).toHaveLength(1);
    expect(first.calls.setSessionMode).toHaveLength(1);
    expect(first.calls.setSessionConfigOption).toHaveLength(1);
    expect(first.calls.cancel).toHaveLength(2);
  });

  it("refuses an exited creating bridge instead of using its live replacement", async () => {
    const first = fakeBridge(), replacement = fakeBridge();
    let current = first.bridge;
    const manager = new SessionManager({ bridge: () => current, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    Object.defineProperty(first.bridge, "exited", { value: true });
    current = replacement.bridge;
    expect(() => manager.prompt(acpSessionRef, "prompt", { prompt: [] })).toThrow();
    await expect(manager.stopForRecovery(acpSessionRef)).rejects.toThrow();
    expect(Object.keys(replacement.calls)).toEqual([]);
    expect(manager.activeSessions).toBe(1);
  });

  it("translates qualified native metadata and never accepts a provider transport-field override", async () => {
    const first = fakeBridge(), events = new RunnerEventBus(), seen: RunnerEvent[] = [];
    events.subscribe(event => seen.push(event));
    const manager = new SessionManager({ bridge: () => first.bridge, events, refStore: new InMemorySessionRefStore() });
    await manager.create({ context, cwd: "/w", mcpServers: [] });
    seen.length = 0;
    const native = { version: 1, origin: "unclassified", turnId: "t", itemId: "i" };
    manager.onSessionUpdate({ sessionId: "bridge-s1", update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text: "local" },
      _meta: { konteksNativeObservation: native }, nativeObservation: { ...native, origin: "connector" },
    } } as never);
    expect(seen[0]).toMatchObject({ params: { update: { nativeObservation: native } } });
    manager.onSessionUpdate({ sessionId: "bridge-s1", update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text: "local" },
      nativeObservation: { ...native, origin: "connector" },
    } } as never);
    expect((seen[1] as { params: { update: unknown } }).params.update).not.toHaveProperty("nativeObservation");
  });

  it("ignores foreign bridge callbacks and exit even when its private ID matches", async () => {
    const first = fakeBridge(), foreign = fakeBridge();
    const events = new RunnerEventBus(), seen: RunnerEvent[] = [];
    events.subscribe(event => seen.push(event));
    const manager = new SessionManager({ bridge: () => first.bridge, events, refStore: new InMemorySessionRefStore() });
    await manager.create({ context, cwd: "/w", mcpServers: [] });
    seen.length = 0;
    manager.onSessionUpdate({ sessionId: "bridge-s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } } }, foreign.bridge);
    await expect(manager.onRequestPermission({ sessionId: "bridge-s1", toolCall: { toolCallId: "t", title: "foreign" }, options: [] }, foreign.bridge)).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(manager.onCreateElicitation({ sessionId: "bridge-s1" } as never, foreign.bridge)).resolves.toEqual({ action: "cancel" });
    manager.closeAll("agent_exited", foreign.bridge);
    expect(seen).toEqual([]);
    expect(manager.activeSessions).toBe(1);
  });

  it("retains but refuses a session whose bridge exits during durable reference storage", async () => {
    const first = fakeBridge(), replacement = fakeBridge();
    let current = first.bridge;
    const manager = new SessionManager({ bridge: () => current, events: new RunnerEventBus(), refStore: {
      get: async () => null,
      put: async () => {
        Object.defineProperty(first.bridge, "exited", { value: true });
        current = replacement.bridge;
        manager.closeAll("agent_exited", first.bridge);
      },
    } });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], sessionConfig: { model: "test" } })).rejects.toThrow();
    expect(manager.activeSessions).toBe(1);
    expect(first.calls.setSessionConfigOption).toBeUndefined();
    expect(Object.keys(replacement.calls)).toEqual([]);
  });

  it("refuses load after the captured bridge exits during reference lookup", async () => {
    const first = fakeBridge(), replacement = fakeBridge();
    let current = first.bridge;
    const manager = new SessionManager({ bridge: () => current, events: new RunnerEventBus(), refStore: {
      get: async () => { Object.defineProperty(first.bridge, "exited", { value: true }); current = replacement.bridge; return "prior"; },
      put: async () => undefined,
    } });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "prior-ref" })).rejects.toThrow();
    expect(Object.keys(first.calls)).toEqual([]);
    expect(Object.keys(replacement.calls)).toEqual([]);
  });

  it("creates a session with mcpServers and config selections and returns an opaque ref", async () => {
    const { bridge, calls } = fakeBridge();
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const created = await manager.create({
      context,
      cwd: "/workspace/x",
      mcpServers: [{ type: "http", name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap" }] }],
      sessionConfig: { model: "fast" },
    });
    expect(created.acpSessionRef).toMatch(/^acp-/);
    expect(created.resumed).toBe(false);
    expect(created.capabilities).toEqual({ forkSession: false, sessionResume: true });
    expect(calls.newSession?.[0]).toMatchObject({ cwd: "/workspace/x", mcpServers: [{ name: "konteks" }] });
    expect(calls.setSessionConfigOption?.[0]).toMatchObject({ sessionId: "bridge-s1", configId: "model", value: "fast" });
  });

  it("bounds session/new, logs the assignment context, and recycles the exact bridge without replaying the mutation", async () => {
    const never = new Promise<never>(() => undefined);
    const { bridge } = fakeBridge({ newSession: vi.fn(() => never) });
    const stop = vi.spyOn(bridge, "stop");
    const warn = vi.fn();
    const manager = new SessionManager({
      bridge: () => bridge,
      events: new RunnerEventBus(),
      refStore: new InMemorySessionRefStore(),
      bootstrapTimeoutMs: 5,
      logger: { warn, error: vi.fn() } as unknown as Logger,
    });

    await expect(manager.create({ context, cwd: "/w", mcpServers: [] })).rejects.toMatchObject({
      code: "agent_unavailable",
      retryable: true,
      diagnostic: "acp_session_new_deadline",
    });
    expect(bridge.connection.newSession).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      stage: "session_new", assignmentId: "asg", attempt: 1, agentId: "codex",
      timeoutMs: 5, bridgeRecycled: true, retryable: true,
    }), expect.stringContaining("assignment retry"));
  });

  it.each([
    ["session_resume", { loadSession: true, sessionCapabilities: { resume: {} } }, "resumeSession"],
    ["session_load", { loadSession: true }, "loadSession"],
  ] as const)("bounds %s and recycles instead of retrying an ambiguous restore", async (stage, agentCapabilities, method) => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const never = new Promise<never>(() => undefined);
    const { bridge } = fakeBridge({ [method]: vi.fn(() => never) }, { agentCapabilities });
    const stop = vi.spyOn(bridge, "stop");
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store, bootstrapTimeoutMs: 5 });

    await expect(manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior" })).rejects.toMatchObject({
      code: "agent_unavailable",
      retryable: true,
      diagnostic: `acp_${stage}_deadline`,
    });
    expect(bridge.connection[method]).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("bounds required session configuration and recycles the bridge rather than publishing ready", async () => {
    const never = new Promise<never>(() => undefined);
    const { bridge } = fakeBridge({ setSessionConfigOption: vi.fn(() => never) });
    const stop = vi.spyOn(bridge, "stop");
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore(), bootstrapTimeoutMs: 5 });

    await expect(manager.create({ context, cwd: "/w", mcpServers: [], sessionConfig: { model: "required" } })).rejects.toMatchObject({
      code: "agent_unavailable",
      retryable: true,
      diagnostic: "acp_session_config_deadline",
    });
    expect(bridge.connection.setSessionConfigOption).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("self-heals one assignment with three fresh-bridge retries and exponential backoff", async () => {
    const never = new Promise<never>(() => undefined);
    const attempts = [
      fakeBridge({ newSession: vi.fn(() => never) }),
      fakeBridge({ newSession: vi.fn(() => never) }),
      fakeBridge({ newSession: vi.fn(() => never) }),
      fakeBridge(),
    ];
    const sleeps: number[] = [];
    const replaceBridge = vi.fn(async (_ref: string, previous: BridgeProcess, bootstrapAttempt: number) => {
      const index = attempts.findIndex(value => value.bridge === previous);
      return { bridge: attempts[index + 1]!.bridge, bootstrapAttempt };
    });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const manager = new SessionManager({
      bridge: () => attempts[0]!.bridge,
      replaceBridge,
      events: new RunnerEventBus(),
      refStore: new InMemorySessionRefStore(),
      bootstrapTimeoutMs: 2,
      bootstrapRetryRandom: () => 0.5,
      bootstrapRetrySleep: async delayMs => { sleeps.push(delayMs); },
      logger,
    });

    await expect(manager.create({ context, cwd: "/w", mcpServers: [] })).resolves.toMatchObject({ resumed: false });
    expect(sleeps).toEqual([500, 1_000, 2_000]);
    expect(replaceBridge).toHaveBeenCalledTimes(3);
    for (const attempt of attempts.slice(0, 3)) {
      expect(attempt.bridge.connection.newSession).toHaveBeenCalledOnce();
      expect(attempt.bridge.stop).toHaveBeenCalledOnce();
    }
    expect(attempts[3]!.bridge.connection.newSession).toHaveBeenCalledOnce();
    expect(attempts[3]!.bridge.stop).not.toHaveBeenCalled();
    expect((logger.info as unknown as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(expect.objectContaining({
      bootstrapAttempt: 4, recoveredFromAttempt: 3, recovery: "fresh_bridge",
    }), expect.stringContaining("fresh bridge"));
  });

  it("loads a prior session only when the ref is known and the bridge advertises resume", async () => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const { bridge, calls } = fakeBridge();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    const created = await manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior" });
    expect(created).toMatchObject({ acpSessionRef: "acp-prior", resumed: true });
    expect(calls.loadSession?.[0]).toMatchObject({ sessionId: "bridge-old" });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-unknown" })).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("restores durable provider history under a new local execution reference", async () => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const { bridge, calls } = fakeBridge();
    const beforeCreate = vi.fn(async () => undefined);
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    const restored = await manager.restore({ context, cwd: "/w", mcpServers: [], lifecycle: { beforeCreate, recordProcessOwner: async () => undefined, assertCurrent: () => undefined } }, "acp-prior");
    expect(restored).toMatchObject({ resumed: true });
    expect(restored.acpSessionRef).toMatch(/^acp-/);
    expect(restored.acpSessionRef).not.toBe("acp-prior");
    expect(beforeCreate).toHaveBeenCalledWith(restored.acpSessionRef);
    expect(calls.loadSession?.[0]).toMatchObject({ sessionId: "bridge-old" });
    expect(await store.get(restored.acpSessionRef)).toBe("bridge-old");
  });

  it("starts a fresh Claude provider query after restart so current MCP authority replaces the transcript's stale tool registry", async () => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const { bridge, calls } = fakeBridge();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    const mcpServers = [{ type: "http" as const, name: "konteks-platform", url: "http://localhost/mcp", headers: [{ name: "Authorization", value: "Bearer current-turn" }] }];

    const restored = await manager.restore({
      context: { ...context, agentId: "claude-code" },
      cwd: "/w",
      mcpServers,
      freshProviderSessionOnRestore: true,
      lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined },
    }, "acp-prior");

    expect(restored).toMatchObject({ resumed: false });
    expect(restored.acpSessionRef).toMatch(/^acp-/);
    expect(calls.loadSession).toBeUndefined();
    expect(calls.resumeSession).toBeUndefined();
    expect(calls.newSession).toEqual([expect.objectContaining({ cwd: "/w", mcpServers })]);
    expect(await store.get(restored.acpSessionRef)).toBe("bridge-s1");
  });

  it("reports agent_session_lost when the bridge refuses to load", async () => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const { bridge } = fakeBridge({ loadSession: vi.fn(async () => { throw new RequestError(-32602, "no such session"); }) });
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior" })).rejects.toThrow(/agent_session_lost/);
  });

  it("completes a prompt with its request id and emits AgentTurnUsageObservation with money unavailable", async () => {
    const { bridge } = fakeBridge();
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), now: () => new Date("2026-09-06T00:00:00Z") });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const result = nextEvent(events, "prompt_result");
    const usage = nextEvent(events, "usage_observation");
    manager.prompt(acpSessionRef, "req-1", { prompt: [{ type: "text", text: "hi" }] });
    expect(await result).toMatchObject({ kind: "prompt_result", requestId: "req-1", result: { stopReason: "end_turn" } });
    expect(await usage).toMatchObject({
      kind: "usage_observation",
      observation: { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "codex", totalTokens: 30, inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, moneyBasis: "unavailable_local_subscription" },
    });
    expect(JSON.stringify(await usage)).not.toMatch(/"model"|amount|currency/);
  });

  it("classifies bridge failures into the closed AcpJsonRpcError classes", async () => {
    const { bridge } = fakeBridge({ prompt: vi.fn(async () => { throw new RequestError(-32000, "authentication required"); }) });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const error = nextEvent(events, "request_error");
    manager.prompt(acpSessionRef, "req-2", { prompt: [] });
    expect(await error).toMatchObject({ kind: "request_error", requestId: "req-2", method: "session/prompt", class: "agent_auth_required", retryable: false });
  });

  it("forwards a permission request once and delivers exactly one answer", async () => {
    const { bridge } = fakeBridge();
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const forwarded = nextEvent(events, "permission_request");
    const pending = manager.onRequestPermission({ sessionId: "bridge-s1", toolCall: { toolCallId: "t1", title: "Run tests" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
    const request = (await forwarded) as Extract<RunnerEvent, { kind: "permission_request" }>;
    expect(request.acpSessionRef).toBe(acpSessionRef);
    expect(JSON.stringify(request.params)).not.toContain("bridge-s1");
    expect(manager.answer(acpSessionRef, request.requestId, { outcome: { outcome: "selected", optionId: "allow" } })).toBe(true);
    expect(manager.answer(acpSessionRef, request.requestId, { outcome: { outcome: "cancelled" } })).toBe(false);
    await expect(pending).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("closing all sessions on bridge exit rejects pending requests and emits session_exited", async () => {
    const { bridge } = fakeBridge();
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    await manager.create({ context, cwd: "/w", mcpServers: [] });
    const exited = nextEvent(events, "session_exited");
    const pending = manager.onRequestPermission({ sessionId: "bridge-s1", toolCall: { toolCallId: "2026-09-06T00:00:00Z", title: "x" }, options: [] });
    manager.closeAll("agent_exited");
    await expect(pending).rejects.toThrow("agent_exited");
    expect(await exited).toMatchObject({ kind: "session_exited", reason: "agent_exited" });
    expect(manager.activeSessions).toBe(0);
  });
});
