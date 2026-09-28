import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { RemoteInstanceError } from "@konteks/remote-common";
import { RunnerConfigSchema, type BridgeProcess } from "@konteks/remote-agent-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeRunner } from "../native/runner.js";
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
    const codex = runner("codex"), claude = runner("claude-code", true), dsh = runner("dsh", true);
    const onUnavailable = vi.fn();
    const result = await startNativeAgents({ codexOwner, runners: [codex, claude, dsh], onUnavailable });
    expect(result.started).toEqual([codex]);
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

/** The person's own OpenCode (opencode-runtime-support CP6): parked like any agent, the others run. */
describe("an OpenCode that cannot start", () => {
  afterEach(() => vi.useRealTimers());

  it("is left out when its settings check fails, the rest start, and a background retry brings it back", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "native-start-opencode-"));
    try {
      const config = RunnerConfigSchema.parse({
        RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "work"),
        RUNNER_BRIDGE_PREFIX: "/opt/opencode/bin", RUNNER_NATIVE_OPENCODE_BINARY: "/opt/opencode/bin/opencode", RUNNER_BRIDGE_VERSION: "2.0.18",
      });
      const drift = new RemoteInstanceError("prerequisite_missing", "Unsupported OpenCode installation", { diagnostic: "opencode_unsupported_installation" });
      let checks = 0;
      const spawn = vi.fn(async (): Promise<BridgeProcess> => ({ connection: {} as ClientSideConnection, initializeResult: { protocolVersion: 1 }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) }));
      const opencode = new NativeRunner({ instanceId: "instance", config, onEvent: () => undefined,
        openCodeSelfCheck: async () => { checks += 1; if (checks === 1) throw drift; },
        runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" }) } });
      const claude = { agentId: "claude-code", start: vi.fn(async () => undefined) };
      const result = await startNativeAgents({ codexOwner: null, runners: [claude, opencode] });
      expect(result.started).toEqual([claude]);
      expect(result.failed).toEqual([opencode]);
      expect(result.unavailable).toEqual([{ agentId: "opencode", reason: "Unsupported OpenCode installation" }]);
      expect(spawn).not.toHaveBeenCalled();
      expect(opencode.hostInstallation()).toEqual({ version: "2.0.18", executable: "/opt/opencode/bin/opencode", selfCheck: "failed" });
      const onStarted = vi.fn();
      const retry = new NativeAgentRetry({ onStarted, onGaveUp: vi.fn(), log: () => undefined });
      retry.park("opencode", () => opencode.start());
      await vi.advanceTimersByTimeAsync(60_000);
      // The retry fired; its start does real file work (the private home).
      vi.useRealTimers();
      await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith("opencode"));
      expect(checks).toBe(2);
      expect(opencode.hostInstallation()?.selfCheck).toBe("passed");
      await expect(opencode.readiness()).resolves.toMatchObject({ agent: { agentId: "opencode" } });
      retry.stop();
      await opencode.stop();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

/** Google Antigravity (antigravity CP6): a copy that fails its start check is parked like any agent, the others run. */
describe("a Google Antigravity that cannot start", () => {
  afterEach(() => vi.useRealTimers());

  it("is left out when its start check fails, the rest start, and a background retry brings it back", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "native-start-antigravity-"));
    try {
      const folder = join(root, "agents", "antigravity", "1.2.1-darwin-arm64");
      const config = RunnerConfigSchema.parse({
        RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "work"),
        RUNNER_BRIDGE_PREFIX: folder, RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder, RUNNER_BRIDGE_VERSION: "1.2.1",
      });
      const drift = new RemoteInstanceError("prerequisite_missing", "Google Antigravity on this computer does not match Google's release.", { diagnostic: "antigravity_unsafe_install" });
      let checks = 0;
      const spawn = vi.fn(async (): Promise<BridgeProcess> => ({ connection: {} as ClientSideConnection, initializeResult: { protocolVersion: 1 }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) }));
      const antigravity = new NativeRunner({ instanceId: "instance", config, onEvent: () => undefined,
        antigravitySelfCheck: async () => { checks += 1; if (checks === 1) throw drift; },
        runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" }) } });
      // The folder check before the start check: stand in for a verified copy.
      const { antigravityInstallAdapter } = await import("../native/host-agents.js");
      const selfCheck = vi.spyOn(antigravityInstallAdapter, "selfCheck").mockImplementation(async (_config, deps) => { await deps!.antigravitySelfCheck!({ config }); });
      const claude = { agentId: "claude-code", start: vi.fn(async () => undefined) };
      const result = await startNativeAgents({ codexOwner: null, runners: [claude, antigravity] });
      expect(result.started).toEqual([claude]);
      expect(result.failed).toEqual([antigravity]);
      expect(result.unavailable).toEqual([{ agentId: "antigravity", reason: "Google Antigravity on this computer does not match Google's release." }]);
      expect(spawn).not.toHaveBeenCalled();
      expect(antigravity.hostInstallation()).toEqual({ version: "1.2.1", executable: null, fetchedRoot: folder, selfCheck: "failed" });
      const onStarted = vi.fn();
      const retry = new NativeAgentRetry({ onStarted, onGaveUp: vi.fn(), log: () => undefined });
      retry.park("antigravity", () => antigravity.start());
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith("antigravity"));
      expect(checks).toBe(2);
      expect(antigravity.hostInstallation()?.selfCheck).toBe("passed");
      expect(antigravity.quarantineReason()).toBeNull();
      retry.stop();
      await antigravity.stop();
      selfCheck.mockRestore();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("starts an update's retry at once, not after a minute (A17)", async () => {
    vi.useFakeTimers();
    const started = vi.fn(async () => undefined);
    const retry = new NativeAgentRetry({ onStarted: vi.fn(), onGaveUp: vi.fn(), log: () => undefined });
    retry.park("antigravity", started, { firstDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledTimes(1);
    const later = vi.fn(async () => undefined);
    retry.park("opencode", later);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(later).not.toHaveBeenCalled();
    retry.stop();
  });
});
