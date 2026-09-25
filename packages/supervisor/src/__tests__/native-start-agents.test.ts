import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAgentRetry, startNativeAgents } from "../native/start-native-agents.js";

/** One agent that cannot start must not take the runtime down (WS1-018, dsh-runtime-support CP5). */
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
    expect(result.failed).toEqual([]);
    expect(onUnavailable).toHaveBeenCalledWith("codex", expect.any(Error));
    expect(result.codexOwnerStarted).toBe(false);
  });

  it("leaves out any agent whose runner cannot start and starts the rest, keeping Codex's server up", async () => {
    const codexOwner = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const codex = runner("codex"), claude = runner("claude-code", true), dsh = runner("dsh", true), opencode = runner("opencode");
    const onUnavailable = vi.fn();
    const result = await startNativeAgents({ codexOwner, runners: [codex, claude, dsh, opencode], onUnavailable });
    expect(result.started).toEqual([codex, opencode]);
    expect(result.failed).toEqual([claude, dsh]);
    expect(result.unavailable).toEqual([{ agentId: "claude-code", reason: "claude-code failed" }, { agentId: "dsh", reason: "dsh failed" }]);
    expect(onUnavailable).toHaveBeenCalledWith("dsh", expect.any(Error));
    expect(codexOwner.stop).not.toHaveBeenCalled();
    expect(result.codexOwnerStarted).toBe(true);
  });
});

describe("NativeAgentRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("tries a left-out agent again after a minute, doubling up to fifteen, at most ten times", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    let succeedOn = 3;
    const onStarted = vi.fn();
    const retry = new NativeAgentRetry({ onStarted, onGaveUp: vi.fn(), log: () => undefined });
    retry.park("dsh", async () => { attempts.push(Date.now()); if (attempts.length < succeedOn) throw new Error("not yet"); });
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(attempts.map(at => at - start)).toEqual([60_000, 180_000, 420_000]);
    expect(onStarted).toHaveBeenCalledWith("dsh");
    expect(retry.parked()).toEqual([]);
    succeedOn = Infinity;
  });

  it("gives up after ten tries, and cancels everything when the runtime stops", async () => {
    vi.useFakeTimers();
    const onGaveUp = vi.fn();
    const retry = new NativeAgentRetry({ onStarted: vi.fn(), onGaveUp, log: () => undefined });
    const failing = vi.fn(async () => { throw new Error("still unsupported"); });
    retry.park("dsh", failing);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(failing).toHaveBeenCalledTimes(10);
    expect(onGaveUp).toHaveBeenCalledWith("dsh", expect.any(Error));
    const later = vi.fn(async () => undefined);
    retry.park("claude-code", later);
    expect(retry.parked()).toEqual(["claude-code"]);
    retry.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(later).not.toHaveBeenCalled();
    expect(retry.parked()).toEqual([]);
  });
});
