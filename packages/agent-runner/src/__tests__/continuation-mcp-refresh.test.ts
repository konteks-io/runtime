import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError, type ClientSideConnection } from "@agentclientprotocol/sdk";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { BridgeProcess } from "../bridge/process.js";
import { CODEX_SESSION_GOVERNANCE } from "../runtime.js";
import { RunnerEventBus } from "../events.js";
import { InMemorySessionRefStore, SessionManager, type SessionManagerOptions } from "../sessions/manager.js";

const context = { instanceId: "fixture", assignmentId: "first", attempt: 1, agentId: "codex" };
const mcp = (name: string) => [{ type: "http" as const, name, url: `http://localhost/${name}`, headers: [] }];

function fixture(options: Partial<SessionManagerOptions> = {}, detach = true) {
  let nextId = 0;
  const subscribed = new Map<string, unknown>();
  const seen: unknown[] = [];
  const connection = {
    newSession: vi.fn(async (args: { mcpServers: unknown }) => {
      const sessionId = `thread-${++nextId}`;
      subscribed.set(sessionId, args.mcpServers);
      return { sessionId };
    }),
    closeSession: vi.fn(async (args: { sessionId: string }) => { subscribed.delete(args.sessionId); return {}; }),
    resumeSession: vi.fn(async (args: { sessionId: string; mcpServers: unknown }) => {
      // Codex acknowledges resume of a subscribed thread without replacing its transport.
      if (!subscribed.has(args.sessionId)) subscribed.set(args.sessionId, args.mcpServers);
      return {};
    }),
    prompt: vi.fn(async (args: { sessionId: string }) => {
      seen.push(subscribed.get(args.sessionId));
      return { stopReason: "end_turn" };
    }),
  };
  const bridge: BridgeProcess = { connection: connection as unknown as ClientSideConnection,
    initializeResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } },
    exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) };
  const events = new RunnerEventBus();
  const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(),
    ...(detach ? { detachMcpOnContinuation: CODEX_SESSION_GOVERNANCE.detachMcpOnContinuation } : {}), ...options });
  const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined };
  const args = { context, cwd: "/fixture", managedRepository: true as const, mcpServers: mcp("old"), lifecycle };
  async function prompt(ref: string) {
    const completed = new Promise<void>(resolve => {
      const off = events.subscribe(event => { if (event.kind === "prompt_result" && event.acpSessionRef === ref) { off(); resolve(); } });
    });
    manager.prompt(ref, "fixture-turn", { prompt: [] });
    await completed;
  }
  async function sealed() {
    const first = await manager.create(args);
    await prompt(first.acpSessionRef);
    await manager.sealCompletedTurn(first.acpSessionRef);
    return { ...args, context: { ...context, assignmentId: "next" }, mcpServers: mcp("new"), acpSessionRef: first.acpSessionRef };
  }
  return { manager, connection, bridge, seen, args, prompt, sealed };
}

afterEach(() => vi.useRealTimers());

describe("assignment-scoped continuation MCP refresh", () => {
  it("detaches the idle subscription before resume so the same thread actually uses successor tools", async () => {
    const f = fixture();
    const args = await f.sealed();
    const result = await f.manager.continueLive(args);
    await f.prompt(result.acpSessionRef);
    expect(result.acpSessionRef).toBe(args.acpSessionRef);
    expect(f.seen).toEqual([mcp("old"), mcp("new")]);
    expect(f.connection.closeSession).toHaveBeenCalledExactlyOnceWith({ sessionId: "thread-1" });
    expect(f.connection.newSession).toHaveBeenCalledTimes(1);
    expect(f.bridge.stop).not.toHaveBeenCalled();
  });

  it.each(["direct", "other-provider"])("keeps the existing %s continuation path", async mode => {
    const f = fixture({}, mode !== "other-provider");
    const args = await f.sealed();
    const { managedRepository: _managed, ...directArgs } = args;
    await f.manager.continueLive(mode === "direct" ? directArgs : args);
    expect(f.connection.closeSession).not.toHaveBeenCalled();
  });

  it("refuses unavailable close capability instead of reusing stale transport", async () => {
    const f = fixture(); const args = await f.sealed();
    f.bridge.initializeResult.agentCapabilities = { sessionCapabilities: { resume: {} } };
    await expect(f.manager.continueLive(args)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.connection.resumeSession).not.toHaveBeenCalled();
    expect(() => f.manager.prompt(args.acpSessionRef, "refused", { prompt: [] })).toThrow();
  });

  it("fences close failure and never resumes", async () => {
    const f = fixture(); const args = await f.sealed();
    f.connection.closeSession.mockRejectedValueOnce(new Error("fixture close refused"));
    await expect(f.manager.continueLive(args)).rejects.toThrow("fixture close refused");
    expect(f.connection.resumeSession).not.toHaveBeenCalled();
    expect(() => f.manager.prompt(args.acpSessionRef, "refused", { prompt: [] })).toThrow();
  });

  it("checks the successor fence again after close before resuming", async () => {
    const f = fixture(); const args = await f.sealed(); let current = true;
    f.connection.closeSession.mockImplementationOnce(async () => { current = false; return {}; });
    args.lifecycle.assertCurrent = () => { if (!current) throw new RemoteInstanceError("recovery_required", "fixture owner lost"); };
    await expect(f.manager.continueLive(args)).rejects.toThrow("fixture owner lost");
    expect(f.connection.resumeSession).not.toHaveBeenCalled();
  });

  it.each(["titled", "ownerless"])("does not detach a %s direct session even with repository metadata", async mode => {
    const f = fixture(); const args = await f.sealed();
    await f.manager.continueLive({ ...args, ...(mode === "titled" ? { agentTitled: true } : { lifecycle: { ...args.lifecycle, ownerless: true as const } }) });
    expect(f.connection.closeSession).not.toHaveBeenCalled();
  });

  it("keeps a timed-out close fenced even if its response arrives later", async () => {
    const f = fixture(); const args = await f.sealed();
    let release!: (value: object) => void;
    f.connection.closeSession.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    vi.useFakeTimers();
    const continuation = f.manager.continueLive({ ...args, readinessDeadlineAt: new Date(Date.now() + 50).toISOString() });
    const rejected = expect(continuation).rejects.toThrow("session-close deadline");
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    release({});
    await vi.advanceTimersByTimeAsync(1);
    expect(f.connection.resumeSession).not.toHaveBeenCalled();
    expect(() => f.manager.prompt(args.acpSessionRef, "late", { prompt: [] })).toThrow();
    await expect(f.manager.continueLive(args)).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("refuses an expired deadline before sending any close", async () => {
    const f = fixture(); const args = await f.sealed();
    await expect(f.manager.continueLive({ ...args, readinessDeadlineAt: new Date(0).toISOString() })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(f.connection.closeSession).not.toHaveBeenCalled();
    expect(f.connection.resumeSession).not.toHaveBeenCalled();
  });

  it("refuses a lost successor fence before sending close", async () => {
    const f = fixture(); const args = await f.sealed();
    args.lifecycle.assertCurrent = () => { throw new RemoteInstanceError("recovery_required", "fixture owner lost"); };
    await expect(f.manager.continueLive(args)).rejects.toThrow("fixture owner lost");
    expect(f.connection.closeSession).not.toHaveBeenCalled();
  });

  it("does not detach a subscription twice when authority rebind already closed it", async () => {
    const f = fixture({ rebindBridge: async (_ref, bridge, _lifecycle, _cwd, _roots, retire) => { await retire(); return bridge; } });
    const args = await f.sealed();
    await f.manager.continueLive(args);
    expect(f.connection.closeSession).toHaveBeenCalledTimes(1);
  });

  it("does not close again when resume rejects after a confirmed detach", async () => {
    const f = fixture(); const args = await f.sealed();
    f.connection.resumeSession.mockRejectedValueOnce(RequestError.invalidParams(undefined, "fixture refuses resume"));
    await expect(f.manager.continueLive(args)).rejects.toThrow("fixture refuses resume");
    expect(f.connection.closeSession).toHaveBeenCalledTimes(1);
    expect(f.connection.resumeSession).toHaveBeenCalledTimes(1);
  });

  it("keeps an independent peer subscription callable", async () => {
    const f = fixture(); const args = await f.sealed();
    const peer = await f.manager.create({ ...f.args, context: { ...context, assignmentId: "peer" }, mcpServers: mcp("peer") });
    await f.prompt(peer.acpSessionRef);
    await f.manager.continueLive(args);
    await f.prompt(peer.acpSessionRef);
    expect(f.seen).toEqual([mcp("old"), mcp("peer"), mcp("peer")]);
    expect(f.connection.closeSession).toHaveBeenCalledExactlyOnceWith({ sessionId: "thread-1" });
  });

  it("rejects a duplicate provider-thread identity before it can acquire another owner", async () => {
    const f = fixture(); await f.sealed();
    f.connection.newSession.mockResolvedValueOnce({ sessionId: "thread-1" });
    await expect(f.manager.create({ ...f.args, context: { ...context, assignmentId: "duplicate" } })).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.connection.closeSession).not.toHaveBeenCalled();
  });

  it("does not detach an unsealed active session", async () => {
    const f = fixture(); const first = await f.manager.create(f.args);
    await expect(f.manager.continueLive({ ...f.args, acpSessionRef: first.acpSessionRef })).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.connection.closeSession).not.toHaveBeenCalled();
  });

});
