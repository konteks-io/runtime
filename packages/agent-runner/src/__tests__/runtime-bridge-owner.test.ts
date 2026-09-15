import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { AgentRuntime } from "../runtime.js";
import { loadRunnerConfig } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const context = { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "codex" };
function bridge(): BridgeProcess {
  return { connection: { newSession: vi.fn(async () => ({ sessionId: "same-private-id" })) } as never,
    initializeResult: { protocolVersion: 1 }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) };
}
async function runtime(spawn: (input: SpawnBridgeOptions) => Promise<BridgeProcess>) {
  const root = await mkdtemp(join(tmpdir(), "bridge-owner-test-")); roots.push(root);
  return new AgentRuntime({ config: loadRunnerConfig({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: root, RUNNER_WORKSPACE_DIR: root }),
    spawn, retrySleep: async () => undefined, retryRandom: () => 0.5 });
}

describe("runtime exact bridge callbacks", () => {
  it("ignores the old bridge's callbacks and late exit after replacement", async () => {
    const first = bridge(), second = bridge();
    const handlers: SpawnBridgeOptions["handlers"][] = [];
    const agent = await runtime(async input => { handlers.push(input.handlers); return handlers.length === 1 ? first : second; });
    try {
      await agent.ensureBridge();
      const initial = await agent.sessions.create({ context, cwd: "/w", mcpServers: [] });
      agent.sessions.close(initial.acpSessionRef);
      Object.defineProperty(first, "exited", { value: true });
      await agent.ensureBridge();
      await agent.sessions.create({ context, cwd: "/w", mcpServers: [] });
      const seen: unknown[] = []; agent.events.subscribe(event => seen.push(event));
      handlers[0]!.onSessionUpdate({ sessionId: "same-private-id", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } });
      await expect(handlers[0]!.onRequestPermission({ sessionId: "same-private-id", toolCall: { toolCallId: "t", title: "old" }, options: [] })).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      handlers[0]!.onExit({ code: 0, signal: null });
      expect(seen).toEqual([]);
      expect(agent.utilization().activeSessions).toBe(1);
      expect(agent.readiness().connectionState).toBe("ready");
    } finally { await agent.stop(); }
  });

  it("coalesces concurrent starts so there is only one creating bridge", async () => {
    let release!: (value: BridgeProcess) => void;
    const pending = new Promise<BridgeProcess>(resolve => { release = resolve; });
    const spawn = vi.fn(() => pending), agent = await runtime(spawn);
    const first = agent.ensureBridge(), second = agent.ensureBridge();
    await Promise.resolve();
    release(bridge());
    await Promise.all([first, second]);
    try { expect(spawn).toHaveBeenCalledOnce(); } finally { await agent.stop(); }
  });

  it("does not publish ready if the bridge exits during initialization", async () => {
    const candidate = bridge();
    const agent = await runtime(async input => { input.handlers.onExit({ code: 1, signal: null }); return candidate; });
    try { await agent.ensureBridge(); expect(agent.readiness().connectionState).not.toBe("ready"); }
    finally { await agent.stop(); }
  });

  it("retries transient control bridge startup three times with fresh candidates before succeeding", async () => {
    const candidate = bridge();
    const spawn = vi.fn<(_: SpawnBridgeOptions) => Promise<BridgeProcess>>()
      .mockRejectedValueOnce(new Error("transient one"))
      .mockRejectedValueOnce(new Error("transient two"))
      .mockRejectedValueOnce(new Error("transient three"))
      .mockResolvedValueOnce(candidate);
    const agent = await runtime(spawn);
    try {
      await agent.ensureBridge();
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(agent.readiness().connectionState).toBe("ready");
    } finally { await agent.stop(); }
  });

  it("waits for and disposes a late initialized bridge after shutdown", async () => {
    let release!: (value: BridgeProcess) => void;
    const pending = new Promise<BridgeProcess>(resolve => { release = resolve; });
    const spawn = vi.fn(() => pending), candidate = bridge(), agent = await runtime(spawn);
    const starting = agent.ensureBridge();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const stopping = agent.stop();
    release(candidate);
    await Promise.all([starting, stopping]);
    expect(candidate.stop).toHaveBeenCalledOnce();
    expect(agent.readiness().connectionState).toBe("exited");
    await agent.ensureBridge();
    expect(spawn).toHaveBeenCalledOnce();
  });
});
