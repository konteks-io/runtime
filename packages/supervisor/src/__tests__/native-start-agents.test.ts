import { describe, expect, it, vi } from "vitest";
import { startNativeAgents } from "../native/start-native-agents.js";

/** One agent that cannot start must not take the runtime down (WS1-018). */
describe("startNativeAgents", () => {
  const runner = (agentId: string, fail = false) => ({ agentId, start: vi.fn(async () => { if (fail) throw new Error(`${agentId} failed`); }) });

  it("starts every other agent when Codex's shared app-server cannot start", async () => {
    const codexOwner = { start: vi.fn(async () => { throw new Error("The signed Codex app-server exited during startup."); }), stop: vi.fn(async () => {}) };
    const claude = runner("claude-code");
    const codex = runner("codex");
    const onUnavailable = vi.fn();
    const result = await startNativeAgents({ codexOwner, runners: [claude, codex], onUnavailable });
    expect(result.started).toEqual([claude]);
    expect(codex.start).not.toHaveBeenCalled();
    expect(result.unavailable).toEqual([{ agentId: "codex", reason: "The signed Codex app-server exited during startup." }]);
    expect(onUnavailable).toHaveBeenCalledWith("codex", expect.any(Error));
    expect(result.codexOwnerStarted).toBe(false);
  });

  it("still fails startup, and stops Codex, when another agent's runner fails", async () => {
    const codexOwner = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    await expect(startNativeAgents({ codexOwner, runners: [runner("codex"), runner("claude-code", true)] })).rejects.toThrow("claude-code failed");
    expect(codexOwner.stop).toHaveBeenCalledTimes(1);
  });
});
