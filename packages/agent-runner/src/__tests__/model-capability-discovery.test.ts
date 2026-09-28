import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import { MAX_OFFERED_MODEL_VALUES, discoverBridgeModelCapability, exactSelect } from "../bridge/model-capability.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const spec = { family: { agentId: "codex" } } as never;
const exactModel = [{ id: "exact-model-id", name: "anything", category: "other", type: "select", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] }];

function fixture(options: unknown) {
  let handlers: SpawnBridgeOptions["handlers"] | undefined;
  const stop = vi.fn(async () => undefined), prompt = vi.fn(), closeSession = vi.fn(async () => ({}));
  const newSession = vi.fn(async (_request: { cwd: string; mcpServers: unknown[] }) => ({ sessionId: "discovery-private", configOptions: options }));
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    handlers = input.handlers;
    return { connection: { newSession, prompt } as never, initializeResult: { protocolVersion: 1, agentCapabilities: {} }, exited: false, stderrTail: () => [], stop } satisfies BridgeProcess;
  });
  return { spawn, stop, prompt, newSession, closeSession, handlers: () => handlers };
}

describe("supervisor-only ACP model capability discovery", () => {
  it("uses one dedicated bridge, an empty private cwd and no MCP, then removes all temporary state", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-discovery-test-")); roots.push(root);
    const f = fixture(exactModel);
    const result = await discoverBridgeModelCapability({ configId: "exact-model-id", workspaceRoot: root, spec, spawn: f.spawn, initializeTimeoutMs: 1_000, clientVersion: "1.0.0" });
    expect(result).toEqual({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"], offeredOptions: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] });
    expect(f.newSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: expect.stringContaining(".model-discovery-"), mcpServers: [] }));
    const cwd = f.newSession.mock.calls[0]![0].cwd;
    await expect(access(cwd)).rejects.toThrow();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
    await expect(f.handlers()!.onRequestPermission({} as never)).rejects.toThrow(/discovery/i);
    await expect(f.handlers()!.onCreateElicitation({} as never)).rejects.toThrow(/discovery/i);
  });

  it("runs on a lent resident bridge without spawning or stopping it and closes its discovery session", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-discovery-test-")); roots.push(root);
    const f = fixture(exactModel);
    const lent = { connection: { newSession: f.newSession, prompt: f.prompt, closeSession: f.closeSession } as never,
      initializeResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } }, exited: false, stderrTail: () => [], stop: f.stop } satisfies BridgeProcess;
    const result = await discoverBridgeModelCapability({ configId: "exact-model-id", workspaceRoot: root, spec, spawn: f.spawn, bridge: lent, initializeTimeoutMs: 1_000, clientVersion: "1.0.0" });
    expect(result).toEqual({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"], offeredOptions: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.closeSession).toHaveBeenCalledWith({ sessionId: "discovery-private" });
    await expect(access(f.newSession.mock.calls[0]![0].cwd)).rejects.toThrow();
  });

  it("leaves a lent bridge alone when the agent cannot close sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-discovery-test-")); roots.push(root);
    const f = fixture(exactModel);
    const lent = { connection: { newSession: f.newSession, prompt: f.prompt, closeSession: f.closeSession } as never,
      initializeResult: { protocolVersion: 1, agentCapabilities: {} }, exited: false, stderrTail: () => [], stop: f.stop } satisfies BridgeProcess;
    await discoverBridgeModelCapability({ configId: "exact-model-id", workspaceRoot: root, spec, bridge: lent, initializeTimeoutMs: 1_000, clientVersion: "1.0.0" });
    expect(f.closeSession).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("stops a timed-out lent bridge and retries discovery on a fresh process with exponential backoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-discovery-test-")); roots.push(root);
    let lentExited = false;
    const lentStop = vi.fn(async () => { lentExited = true; });
    const lent = { connection: { newSession: vi.fn(() => new Promise<never>(() => undefined)) } as never,
      initializeResult: { protocolVersion: 1, agentCapabilities: {} }, get exited() { return lentExited; }, stderrTail: () => [], stop: lentStop } satisfies BridgeProcess;
    const f = fixture(exactModel);
    const delays: number[] = [];

    await expect(discoverBridgeModelCapability({ configId: "exact-model-id", workspaceRoot: root, spec,
      spawn: f.spawn, bridge: lent, initializeTimeoutMs: 1_000, sessionTimeoutMs: 2,
      retryRandom: () => 0.5, retrySleep: async delayMs => { delays.push(delayMs); }, clientVersion: "1.0.0" }))
      .resolves.toEqual({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"], offeredOptions: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] });
    expect(lent.connection.newSession).toHaveBeenCalledOnce();
    expect(lentStop).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.newSession).toHaveBeenCalledOnce();
    expect(delays).toEqual([500]);
  });

  it("matches only the reviewed id and exact select shape, never labels or category", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-discovery-test-")); roots.push(root);
    for (const options of [
      [{ id: "other", name: "exact-model-id", category: "model", type: "select", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }] }],
      [{ id: "exact-model-id", name: "Model", category: "model", type: "boolean", currentValue: true }],
      [{ id: "exact-model-id", name: "Model", type: "select", currentValue: "missing", options: [{ value: "sonnet", name: "Sonnet" }] }],
    ]) {
      const f = fixture(options);
      await expect(discoverBridgeModelCapability({ configId: "exact-model-id", workspaceRoot: root, spec, spawn: f.spawn, initializeTimeoutMs: 1_000, clientVersion: "1.0.0" })).rejects.toThrow();
      expect(f.stop).toHaveBeenCalledOnce();
    }
  });

  it("reports each option's name and group, skipping malformed entries and repeats", () => {
    const result = exactSelect({ id: "model", name: "Model", type: "select", currentValue: '["deepseek-official","deepseek-flash"]', options: [
      { group: "deepseek-official", name: "DeepSeek", options: [
        { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek V4.1 Flash" },
        { value: '["deepseek-official","deepseek-flash"]', name: "repeat" },
        { value: "", name: "empty" },
      ] },
      { group: "openrouter", name: "Open\u0007Router", options: [{ value: '["openrouter","x-ai/grok-4.5"]', name: "Grok 4.5" }] },
    ] } as never, "dsh");
    expect(result).toEqual({
      currentValue: '["deepseek-official","deepseek-flash"]',
      offeredValues: ['["deepseek-official","deepseek-flash"]', '["openrouter","x-ai/grok-4.5"]'],
      offeredOptions: [
        { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek V4.1 Flash", group: "deepseek-official", groupName: "DeepSeek" },
        { value: '["openrouter","x-ai/grok-4.5"]', name: "Grok 4.5", group: "openrouter", groupName: "Open Router" },
      ],
    });
  });

  it("above the wire bound keeps known models first and the current value, instead of failing", () => {
    const unknown = Array.from({ length: 200 }, (_value, index) => ({ value: JSON.stringify(["acme", `house-${index}`]), name: `House ${index}` }));
    const known = [
      { value: '["deepseek-official","deepseek-flash"]', name: "Flash" },
      { value: '["openai","gpt-5.6-sol"]', name: "Sol" },
    ];
    const current = JSON.stringify(["acme", "house-199"]);
    const result = exactSelect({ id: "model", name: "Model", type: "select", currentValue: current,
      options: [{ group: "acme", name: "Acme", options: unknown }, { group: "known", name: "Known", options: known }] } as never, "dsh");
    expect(result.offeredValues).toHaveLength(MAX_OFFERED_MODEL_VALUES);
    expect(result.offeredValues).toContain(current);
    expect(result.offeredValues).toContain('["deepseek-official","deepseek-flash"]');
    expect(result.offeredValues).toContain('["openai","gpt-5.6-sol"]');
    expect(result.offeredOptions.map(option => option.value)).toEqual(result.offeredValues);
    // The agent's own order is kept among what is reported.
    expect(result.offeredValues.indexOf(current)).toBeLessThan(result.offeredValues.indexOf('["openai","gpt-5.6-sol"]'));
  });
});
