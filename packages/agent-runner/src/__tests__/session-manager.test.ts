import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError, type Logger } from "@konteks/remote-common";
import { RequestError, type ClientSideConnection, type InitializeResponse } from "@agentclientprotocol/sdk";
import type { BridgeProcess } from "../bridge/process.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import { InMemorySessionRefStore, SessionManager } from "../sessions/manager.js";
import { CODEX_SESSION_GOVERNANCE } from "../runtime.js";

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

describe("session manager bootstrap", () => {
  it("binds native Skill admission to the current owner and invalidates it after settlement", async () => {
    const { bridge } = fakeBridge();
    const events = new RunnerEventBus();
    const admitSkillLoad = vi.fn(async () => {});
    const recordSkillLoad = vi.fn(async () => {});
    const load = { loadId: "load", readOnlyRoots: ["/verified/skill"], observedAt: "2026-10-10T00:00:00Z" };
    let turnRecorder: ((value: typeof load) => Promise<void>) | undefined;
    let turnAdmission: ((roots: readonly string[]) => Promise<void>) | undefined;
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(),
      beforePrompt: async (_bridge, turn) => {
        turnAdmission = turn.admitSkillLoad;
        await turnAdmission!(["/verified/skill"]);
        turnRecorder = turn.recordSkillLoad;
        await turnRecorder!(load);
      } });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [],
      lifecycle: { beforeCreate: async () => {}, recordProcessOwner: async () => {}, assertCurrent: () => {}, admitSkillLoad, recordSkillLoad } });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(acpSessionRef, "native-turn", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(acpSessionRef);
    expect(admitSkillLoad).toHaveBeenCalledExactlyOnceWith({ acpSessionRef, requestId: "native-turn", readOnlyRoots: ["/verified/skill"] });
    await expect(turnAdmission!(["/verified/skill"])).rejects.toThrow(/settled/);
    expect(admitSkillLoad).toHaveBeenCalledTimes(1);
    expect(recordSkillLoad).toHaveBeenCalledExactlyOnceWith({ ...load, acpSessionRef, requestId: "native-turn" });
    await expect(turnRecorder!(load)).rejects.toThrow(/settled/);
    expect(recordSkillLoad).toHaveBeenCalledTimes(1);
  });

  it("applies the governed session baseline to create and live continuation", async () => {
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(),
      defaultSessionConfig: { mode: "read-only" }, refusedModes: { modeIds: ["agent", "agent-full-access"], message: "governed mode required" } });
    const first = await manager.create({ context, cwd: "/w", mcpServers: [] });
    expect(calls.setSessionConfigOption).toContainEqual({ sessionId: "bridge-s1", configId: "mode", value: "read-only" });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    await manager.continueLive({ context: { ...context, assignmentId: "asg-2" }, cwd: "/w", mcpServers: [], acpSessionRef: first.acpSessionRef,
      lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined } });
    expect(calls.setSessionConfigOption).toEqual(expect.arrayContaining([
      { sessionId: "bridge-s1", configId: "mode", value: "read-only" },
      { sessionId: "bridge-s1", configId: "mode", value: "read-only" },
    ]));
    await expect(manager.restore({ context, cwd: "/w", mcpServers: [], sessionConfig: { mode: "agent" } }, "prior"))
      .rejects.toThrow("governed mode required");
  });

  it("pins Codex to Ask for approval: every other mode, named today or added later, is refused", async () => {
    // codex-acp 1.10.0 "read-only" = "Ask for approval": approvalPolicy
    // on-request, approvalsReviewer user, so Konteks's callback decides.
    expect(CODEX_SESSION_GOVERNANCE.defaultSessionConfig).toEqual({ mode: "read-only" });
    const { bridge, calls } = fakeBridge();
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), ...CODEX_SESSION_GOVERNANCE });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    expect(calls.setSessionConfigOption).toEqual([{ sessionId: "bridge-s1", configId: "mode", value: "read-only" }]);
    for (const modeId of ["agent", "agent-full-access", "auto-review-next"]) {
      const refused = nextEvent(events, "request_error");
      manager.setMode(acpSessionRef, `mode-${modeId}`, { modeId });
      expect(await refused).toMatchObject({ requestId: `mode-${modeId}`, class: "invalid_params", message: CODEX_SESSION_GOVERNANCE.refusedModes.message });
    }
    const refused = nextEvent(events, "request_error");
    manager.setConfigOption(acpSessionRef, "config-mode", { configId: "mode", value: "auto-review-next" });
    expect(await refused).toMatchObject({ requestId: "config-mode", class: "invalid_params" });
    expect(calls.setSessionMode).toBeUndefined();
    expect(calls.setSessionConfigOption).toHaveLength(1);
    await expect(manager.restore({ context, cwd: "/w", mcpServers: [], sessionConfig: { mode: "auto-review-next" } }, "prior")).rejects.toThrow(CODEX_SESSION_GOVERNANCE.refusedModes.message);
    // Selecting the pinned mode again is allowed.
    const same = nextEvent(events, "set_mode_result");
    manager.setMode(acpSessionRef, "mode-pinned", { modeId: "read-only" });
    await same;
  });

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

  it("closes and resumes a live session the agent will not resume while open, so the next prompt continues", async () => {
    let active = true;
    const resumeSession = vi.fn(async () => {
      if (active) throw RequestError.invalidParams(undefined, "session is already active: bridge-s1");
      active = true;
      return {};
    });
    const closeSession = vi.fn(async () => { active = false; return {}; });
    const { bridge } = fakeBridge({ resumeSession, closeSession }, { agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const first = await manager.create({ context: { ...context, agentId: "dsh" }, cwd: "/w", mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const continued = await manager.continueLive({ context: { ...context, agentId: "dsh", assignmentId: "asg-2" }, cwd: "/w", mcpServers: [], acpSessionRef: first.acpSessionRef,
      lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined } });
    expect(continued).toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
    expect(closeSession).toHaveBeenCalledWith({ sessionId: "bridge-s1" });
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  it("snapshots trusted read roots before awaiting the durable reservation", async () => {
    const { bridge } = fakeBridge();
    let markReserved!: () => void, releaseGate!: () => void;
    const reserved = new Promise<void>(resolve => { markReserved = resolve; });
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const createBridge = vi.fn(async (_ref: string, _lifecycle?: Parameters<SessionManager["create"]>[0]["lifecycle"], _cwd?: string, _roots?: readonly string[]) => ({ bridge, bootstrapAttempt: 1 }));
    const manager = new SessionManager({ bridge: () => bridge, createBridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    const readOnlyRoots = ["/selected-skill"];
    const lifecycle = { beforeCreate: async () => { markReserved(); await gate; },
      recordProcessOwner: async () => undefined, assertCurrent: () => undefined };
    const creating = manager.create({ context, cwd: "/w", readOnlyRoots, mcpServers: [], lifecycle });
    await reserved;
    readOnlyRoots.push("/peer-skill");
    releaseGate();
    await expect(creating).resolves.toMatchObject({ resumed: false });
    expect(createBridge).toHaveBeenCalledWith(expect.any(String), lifecycle, "/w", ["/selected-skill"]);
    const passedRoots = createBridge.mock.calls[0]![3];
    expect(passedRoots).not.toBe(readOnlyRoots);
    expect(Object.isFrozen(passedRoots)).toBe(true);
  });

  it("rebinds child file authority after reservation and before provider continuation", async () => {
    const order: string[] = [];
    const resumeSession = vi.fn(async () => { order.push("provider"); return {}; });
    const { bridge } = fakeBridge({ resumeSession }, { agentCapabilities: { sessionCapabilities: { resume: {} } } });
    const events = new RunnerEventBus();
    const rebindBridge = vi.fn(async () => { order.push("rebind"); return bridge; });
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), rebindBridge });
    const readOnlyRoots = Object.freeze(["/selected-skill"]);
    const first = await manager.create({ context: { ...context, agentId: "dsh" }, cwd: "/w", readOnlyRoots, mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const beforeCreate = vi.fn(async () => { order.push("durable"); });
    const lifecycle = { beforeCreate, recordProcessOwner: async () => undefined, assertCurrent: () => undefined };
    await expect(manager.continueLive({ context: { ...context, agentId: "dsh", assignmentId: "asg-2" }, cwd: "/w", readOnlyRoots,
      mcpServers: [], acpSessionRef: first.acpSessionRef, lifecycle,
    })).resolves.toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
    expect(rebindBridge).toHaveBeenCalledWith(first.acpSessionRef, bridge, lifecycle, "/w", readOnlyRoots, expect.any(Function));
    expect(order).toEqual(["durable", "rebind", "provider"]);
    expect(resumeSession).toHaveBeenCalledWith({ sessionId: "bridge-s1", cwd: "/w", mcpServers: [] });
  });

  it("keeps the sealed reference through expected old-child exit and resumes on its replacement", async () => {
    const closeSession = vi.fn(async () => ({}));
    const old = fakeBridge({ closeSession }, { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }), next = fakeBridge();
    const events = new RunnerEventBus(), seen: RunnerEvent[] = [];
    events.subscribe(event => seen.push(event));
    const rebindBridge = vi.fn(async (_ref: string, _previous: BridgeProcess, _lifecycle: Parameters<SessionManager["create"]>[0]["lifecycle"] | undefined,
      _cwd: string, _roots: readonly string[], retirePrevious: () => Promise<void>) => {
      await retirePrevious();
      manager.closeAll("agent_exited", old.bridge);
      return next.bridge;
    });
    const manager = new SessionManager({ bridge: () => old.bridge, events, refStore: new InMemorySessionRefStore(), rebindBridge });
    const first = await manager.create({ context: { ...context, agentId: "dsh" }, cwd: "/w", readOnlyRoots: ["/prior-skill"], mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined };
    await expect(manager.continueLive({ context: { ...context, agentId: "dsh", assignmentId: "asg-2" }, cwd: "/next", readOnlyRoots: ["/current-skill"],
      mcpServers: [], acpSessionRef: first.acpSessionRef, lifecycle,
    })).resolves.toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
    expect(rebindBridge).toHaveBeenCalledWith(first.acpSessionRef, old.bridge, lifecycle, "/next", ["/current-skill"], expect.any(Function));
    expect(closeSession).toHaveBeenCalledWith({ sessionId: "bridge-s1" });
    expect(next.calls.loadSession).toEqual([{ sessionId: "bridge-s1", cwd: "/next", mcpServers: [] }]);
    expect(next.calls.newSession).toBeUndefined();
    expect(old.calls.loadSession).toBeUndefined();
    expect(manager.activeSessions).toBe(1);
    expect(seen.filter(event => event.kind === "session_exited")).toEqual([]);
    const continued = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p2", { prompt: [] });
    await continued;
    expect(next.calls.prompt).toHaveLength(1);
    expect(old.calls.prompt).toHaveLength(1);
  });

  it("fences the reference when child rebinding is uncertain, without provider continuation", async () => {
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } });
    const events = new RunnerEventBus();
    const rebindBridge = vi.fn(async () => { throw new RemoteInstanceError("recovery_required", "fixture child stop is unconfirmed"); });
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), rebindBridge });
    const first = await manager.create({ context: { ...context, agentId: "dsh" }, cwd: "/w", readOnlyRoots: ["/selected-skill"], mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const beforeCreate = vi.fn(async () => undefined);
    const lifecycle = { beforeCreate, recordProcessOwner: async () => undefined, assertCurrent: () => undefined };
    const successor = { context: { ...context, agentId: "dsh", assignmentId: "asg-2" }, mcpServers: [], acpSessionRef: first.acpSessionRef, lifecycle };
    await expect(manager.continueLive({ ...successor, cwd: "/peer", readOnlyRoots: ["/peer-skill"] })).rejects.toMatchObject({ code: "recovery_required" });
    expect(beforeCreate).toHaveBeenCalledOnce();
    expect(rebindBridge).toHaveBeenCalledWith(first.acpSessionRef, bridge, lifecycle, "/peer", ["/peer-skill"], expect.any(Function));
    expect(calls.resumeSession).toBeUndefined();
    expect(calls.loadSession).toBeUndefined();
    expect(calls.closeSession).toBeUndefined();
    expect(manager.activeSessions).toBe(1);
    await expect(manager.continueLive({ ...successor, cwd: "/w", readOnlyRoots: ["/selected-skill"] })).rejects.toMatchObject({ code: "recovery_required" });
    expect(rebindBridge).toHaveBeenCalledOnce();
  });

  it("refuses and cancels work the agent starts on its own after a turn, so the next turn still continues", async () => {
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
    await manager.releaseSealed(first.acpSessionRef);
    await exited;
    expect(manager.activeSessions).toBe(0);
    expect(calls.cancel ?? []).toEqual([]);
    await expect(manager.continueLive({ context, cwd: "/w", mcpServers: [], acpSessionRef: first.acpSessionRef })).rejects.toThrow();
  });

  it("closes a released session on the agent and counts it on its process until the close is confirmed (2026-10-02 leak)", async () => {
    let confirm!: () => void;
    const closeSession = vi.fn(() => new Promise<object>(resolve => { confirm = () => resolve({}); }));
    const { bridge, calls } = fakeBridge({ closeSession }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const first = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const completed = nextEvent(events, "prompt_result");
    manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
    await completed;
    await manager.sealCompletedTurn(first.acpSessionRef);
    const released = manager.releaseSealed(first.acpSessionRef);
    // The record is gone at once, but the agent still holds the session.
    expect(manager.activeSessions).toBe(0);
    expect(manager.sessionsBoundTo(bridge)).toBe(1);
    expect(closeSession).toHaveBeenCalledWith({ sessionId: "bridge-s1" });
    confirm();
    await released;
    expect(manager.sessionsBoundTo(bridge)).toBe(0);
    expect(calls.cancel ?? []).toEqual([]);
  });

  it("keeps counting a released session the agent cannot close, refuses to close or never answers", async () => {
    const sealed = async (bridge: BridgeProcess) => {
      const events = new RunnerEventBus();
      const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
      const first = await manager.create({ context, cwd: "/w", mcpServers: [] });
      const completed = nextEvent(events, "prompt_result");
      manager.prompt(first.acpSessionRef, "p1", { prompt: [] });
      await completed;
      await manager.sealCompletedTurn(first.acpSessionRef);
      return { manager, ref: first.acpSessionRef };
    };
    const unsupported = fakeBridge({ closeSession: vi.fn(async () => ({})) });
    const a = await sealed(unsupported.bridge);
    await expect(a.manager.releaseSealed(a.ref)).resolves.toBeUndefined();
    expect(unsupported.bridge.connection.closeSession).not.toHaveBeenCalled();
    expect(a.manager.sessionsBoundTo(unsupported.bridge)).toBe(1);

    const refused = fakeBridge({ closeSession: vi.fn(async () => { throw new Error("close failed"); }) }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const b = await sealed(refused.bridge);
    await expect(b.manager.releaseSealed(b.ref)).resolves.toBeUndefined();
    expect(b.manager.sessionsBoundTo(refused.bridge)).toBe(1);

    const silent = fakeBridge({ closeSession: vi.fn(() => new Promise<never>(() => undefined)) }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const c = await sealed(silent.bridge);
    vi.useFakeTimers();
    try {
      let settled = false;
      void c.manager.releaseSealed(c.ref).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
    expect(c.manager.sessionsBoundTo(silent.bridge)).toBe(1);
  });

  it("settles completed ACP operations before close without cancelling the local user's thread", async () => {
    let current = true, exited = false;
    const closeSession = vi.fn(async () => ({}));
    const { bridge: initialBridge, calls } = fakeBridge({ closeSession }, { agentCapabilities: { sessionCapabilities: { close: {} } } });
    const bridge: BridgeProcess = { ...initialBridge, get exited() { return exited; } };
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [], lifecycle: {
      beforeCreate: async () => undefined,
      recordProcessOwner: vi.fn(async () => undefined),
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
    exited = true;
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
  it.each(["codex", "claude-code", "dsh"])("marks new %s sessions without renaming resumed sessions", async agentId => {
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
  it("names a new session from Core's display label", async () => {
    const { bridge, calls } = fakeBridge();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    const created = await manager.create({ context: { ...context, agentId: "claude-code" }, cwd: "/w", mcpServers: [],
      sessionLabel: { system: "Todo List", kind: "initiative", title: "[v3] Stand up the todo list API" } });
    const title = `[konteks/Todo List/initiative] [v3] Stand up the todo list API ${created.acpSessionRef.slice(-8)}`;
    expect(calls.newSession?.[0]).toMatchObject({ _meta: { konteksSession: { version: 1, title }, claudeCode: { options: { title } } } });
  });
  it.each(["codex", "claude-code"])("lets %s title a direct session itself, asking only for the [konteks] prefix, also when it is reopened", async agentId => {
    const { bridge, calls } = fakeBridge({}, { agentCapabilities: { loadSession: true } });
    const store = new InMemorySessionRefStore();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    await manager.create({ context: { ...context, agentId }, cwd: "/w", mcpServers: [], agentTitled: true });
    const meta = (calls.newSession?.[0] as { _meta: Record<string, { title?: unknown; options?: { title?: unknown } }> })._meta;
    expect(meta.konteksSession).toEqual({ version: 1, prefix: "[konteks]" });
    expect(meta.claudeCode?.options?.title).toBeUndefined();
    await store.put("acp-prior", "bridge-old");
    await manager.create({ context: { ...context, agentId }, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior", agentTitled: true });
    expect(calls.loadSession?.[0]).toMatchObject({ _meta: { konteksSession: { version: 1, prefix: "[konteks]" } } });
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
      sessionConfig: { model: "approved" }, lifecycle: { beforeCreate: async ref => { retainedRef = ref; }, recordProcessOwner: vi.fn(async () => undefined), assertCurrent: () => undefined } })).rejects.toMatchObject({ code: "agent_unavailable" });
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

  it("attributes a Codex reply to the turn the connector opened, and only that turn", async () => {
    const events = new RunnerEventBus(), seen: RunnerEvent[] = [];
    events.subscribe(event => seen.push(event));
    const { bridge } = fakeBridge();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    await manager.create({ context, cwd: "/w", mcpServers: [] });
    seen.length = 0;
    const observed = (origin: string, turnId: string) => ({ version: 1, origin, turnId, itemId: `${turnId}-item` });
    const send = (sessionUpdate: string, origin: string, turnId: string) => manager.onSessionUpdate({ sessionId: "bridge-s1", update: {
      sessionUpdate, content: { type: "text", text: "x" }, _meta: { konteksNativeObservation: observed(origin, turnId) },
    } } as never);
    send("user_message_chunk", "connector", "konteks-turn");
    send("agent_message_chunk", "unclassified", "konteks-turn");
    send("user_message_chunk", "unclassified", "local-turn");
    send("agent_message_chunk", "unclassified", "local-turn");
    const origins = seen.map(event => (event as { params: { update: { nativeObservation?: { origin: string } } } }).params.update.nativeObservation?.origin);
    expect(origins).toEqual(["connector", "connector", "unclassified", "unclassified"]);
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

  it("refuses a second prompt while one runs on the session, before it reaches the bridge", async () => {
    let finish!: (value: { stopReason: "end_turn" }) => void;
    const prompt = vi.fn(() => new Promise<{ stopReason: "end_turn" }>((resolve) => { finish = resolve; }));
    const { bridge } = fakeBridge({ prompt });
    const events = new RunnerEventBus();
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
    const published: RunnerEvent[] = [];
    events.subscribe((event) => void published.push(event));
    manager.prompt(acpSessionRef, "first", { prompt: [] });
    let refused: unknown;
    try { manager.prompt(acpSessionRef, "second", { prompt: [] }); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(RemoteInstanceError);
    expect(refused).toMatchObject({ code: "operation_conflict" });
    expect(prompt).toHaveBeenCalledOnce();
    const result = nextEvent(events, "prompt_result");
    finish({ stopReason: "end_turn" });
    expect(await result).toMatchObject({ requestId: "first" });
    expect(published.some((event) => event.kind === "request_error")).toBe(false);
    // The session takes its next turn once the first has ended.
    await new Promise((resolve) => setImmediate(resolve));
    manager.prompt(acpSessionRef, "third", { prompt: [] });
    expect(prompt).toHaveBeenCalledTimes(2);
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

describe("integration sessions", () => {
  it("tells the bridge which personal server or account connectors this one session admits", async () => {
    const { bridge, calls } = fakeBridge();
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
    await manager.create({ context, cwd: "/w", mcpServers: [], integration: { admittedMcpServerNames: ["atlassian"], accountConnectors: false } });
    expect(calls.newSession?.[0]).toMatchObject({ _meta: { konteksIntegration: { version: 1, admittedMcpServerNames: ["atlassian"], accountConnectors: false } } });
    const plain = fakeBridge();
    await new SessionManager({ bridge: () => plain.bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() }).create({ context, cwd: "/w", mcpServers: [] });
    expect(plain.calls.newSession?.[0]).not.toHaveProperty("_meta.konteksIntegration");
  });

  it("never carries an admission into a continued or restored session", async () => {
    const { bridge } = fakeBridge();
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    await expect(manager.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior", integration: { admittedMcpServerNames: [], accountConnectors: true } }))
      .rejects.toMatchObject({ code: "schema_invalid" });
  });
});

// 10-09: Core fenced a direct Claude Code turn; the connector stopped it for
// recovery and kept the fenced record, which still held the agent's own
// session id. Every later turn's restore was refused until a restart.
describe("restoring a conversation after its turn was stopped for recovery", () => {
  const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined };
  const successor = { ...context, assignmentId: "asg-2", agentId: "claude-code" };

  async function fencedSession(overrides: Partial<Record<keyof ClientSideConnection, unknown>> = {}) {
    const store = new InMemorySessionRefStore();
    const first = fakeBridge(overrides);
    let current = first.bridge;
    const manager = new SessionManager({ bridge: () => current, events: new RunnerEventBus(), refStore: store });
    const { acpSessionRef } = await manager.create({ context: { ...context, agentId: "claude-code" }, cwd: "/w", mcpServers: [] });
    const next = fakeBridge();
    return { store, manager, first, next, acpSessionRef, useNext: () => { current = next.bridge; } };
  }

  async function stoppedAndExited() {
    const f = await fencedSession();
    await f.manager.stopForRecovery(f.acpSessionRef);
    Object.assign(f.first.bridge, { exited: true });
    f.manager.closeAll("agent_exited", f.first.bridge);
    f.useNext();
    return f;
  }

  it("refuses the restore while the fenced owner still holds the agent's session, and says why", async () => {
    const f = await stoppedAndExited();
    await expect(f.manager.restore({ context: successor, cwd: "/w", mcpServers: [], lifecycle }, f.acpSessionRef))
      .rejects.toMatchObject({ code: "recovery_required", diagnostic: "bridge_session_owned" });
    expect(f.next.calls.loadSession).toBeUndefined();
    expect(f.manager.activeSessions).toBe(1);
  });

  it("resumes the same agent session under a new reference once the fenced owner is forgotten", async () => {
    const f = await stoppedAndExited();
    f.manager.forgetRecovered(f.acpSessionRef);
    expect(f.manager.activeSessions).toBe(0);
    const restored = await f.manager.restore({ context: successor, cwd: "/w", mcpServers: [], lifecycle }, f.acpSessionRef);
    expect(restored).toMatchObject({ resumed: true });
    expect(restored.acpSessionRef).not.toBe(f.acpSessionRef);
    expect(f.next.calls.loadSession?.[0]).toMatchObject({ sessionId: "bridge-s1" });
    expect(await f.store.get(restored.acpSessionRef)).toBe("bridge-s1");
    // An unknown reference has nothing left to forget.
    expect(() => f.manager.forgetRecovered(f.acpSessionRef)).not.toThrow();
  });

  it("refuses to forget a live session, or one whose process or recovery stop is still running", async () => {
    const live = await fencedSession();
    expect(() => live.manager.forgetRecovered(live.acpSessionRef)).toThrow(expect.objectContaining({ diagnostic: "forget_not_recovered" }));
    await live.manager.stopForRecovery(live.acpSessionRef);
    expect(() => live.manager.forgetRecovered(live.acpSessionRef)).toThrow(expect.objectContaining({ diagnostic: "forget_not_recovered" }));
    expect(live.manager.activeSessions).toBe(1);

    const stopping = await fencedSession({ cancel: vi.fn(() => new Promise(() => undefined)) });
    void stopping.manager.stopForRecovery(stopping.acpSessionRef).catch(() => undefined);
    Object.assign(stopping.first.bridge, { exited: true });
    expect(() => stopping.manager.forgetRecovered(stopping.acpSessionRef)).toThrow(expect.objectContaining({ diagnostic: "forget_not_recovered" }));
    expect(stopping.manager.activeSessions).toBe(1);
  });

  it("opens one new session for a person's turn when the agent cannot reopen its transcript", async () => {
    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "bridge-old");
    await store.put("acp-other", "bridge-other");
    let created = 0;
    const newSession = vi.fn(async () => ({ sessionId: `bridge-new-${++created}` }));
    const loadSession = vi.fn(async () => { throw new RequestError(-32602, "no such session"); });
    const { bridge } = fakeBridge({ loadSession, newSession });
    const beforeCreate = vi.fn(async () => undefined);
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: store });
    // Without the person's-turn flag a lost transcript still fails closed.
    await expect(manager.restore({ context: successor, cwd: "/w", mcpServers: [], lifecycle }, "acp-prior")).rejects.toMatchObject({ diagnostic: "agent_session_lost" });
    expect(newSession).not.toHaveBeenCalled();
    // No mapping at all: one new session under the reference already reserved.
    const unmapped = await manager.restore({ context: successor, cwd: "/w", mcpServers: [], freshSessionWhenRestoreLost: true,
      lifecycle: { ...lifecycle, beforeCreate } }, "acp-unknown");
    expect(unmapped).toMatchObject({ resumed: false });
    expect(beforeCreate).toHaveBeenCalledOnce();
    expect(beforeCreate).toHaveBeenCalledWith(unmapped.acpSessionRef);
    expect(await store.get(unmapped.acpSessionRef)).toBe("bridge-new-1");
    // The agent refuses the load: the same.
    const refused = await manager.restore({ context: successor, cwd: "/w", mcpServers: [], freshSessionWhenRestoreLost: true, lifecycle }, "acp-other");
    expect(refused).toMatchObject({ resumed: false });
    expect(loadSession).toHaveBeenCalledTimes(2);
    expect(await store.get(refused.acpSessionRef)).toBe("bridge-new-2");
  });
});


it("settles a synchronous pre-prompt refusal without sending or retaining an active turn", async () => {
  const { bridge, calls } = fakeBridge();
  const events = new RunnerEventBus();
  const beforePrompt = vi.fn(() => { throw new RemoteInstanceError("capability_unavailable", "Required Skill admission is unavailable."); });
  const afterPrompt = vi.fn((_bridge: unknown, _turn: unknown) => undefined);
  const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), beforePrompt, afterPrompt });
  const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
  const failed = nextEvent(events, "request_error");
  expect(() => manager.prompt(acpSessionRef, "blocked-turn", { prompt: [] })).not.toThrow();
  expect(await failed).toMatchObject({ requestId: "blocked-turn", method: "session/prompt" });
  await vi.waitFor(() => expect(manager.activeTurns).toBe(0));
  expect(calls.prompt).toBeUndefined();
  expect(beforePrompt).toHaveBeenCalledWith(bridge, { acpSessionRef, bridgeSessionId: "bridge-s1", requestId: "blocked-turn" });
  expect(afterPrompt).toHaveBeenCalledWith(bridge, { acpSessionRef, bridgeSessionId: "bridge-s1", requestId: "blocked-turn" });
});

it("invalidates the same immutable host turn after a successful prompt", async () => {
  const { bridge } = fakeBridge();
  const events = new RunnerEventBus();
  const beforePrompt = vi.fn(async () => undefined);
  const afterPrompt = vi.fn((_bridge: unknown, _turn: unknown) => undefined);
  const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), beforePrompt, afterPrompt });
  const { acpSessionRef } = await manager.create({ context, cwd: "/w", mcpServers: [] });
  const result = nextEvent(events, "prompt_result");
  manager.prompt(acpSessionRef, "completed-turn", { prompt: [] });
  await result;
  await vi.waitFor(() => expect(manager.activeTurns).toBe(0));
  const turn = afterPrompt.mock.calls[0][1];
  expect(beforePrompt).toHaveBeenCalledWith(bridge, turn);
  expect(Object.isFrozen(turn)).toBe(true);
});
