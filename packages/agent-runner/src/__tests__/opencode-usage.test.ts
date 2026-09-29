import { describe, expect, it, vi } from "vitest";
import { AgentTurnUsageObservationSchema, type ConnectedAgentCredential } from "@konteks/remote-common";
import type { ClientSideConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import type { BridgeProcess } from "../bridge/process.js";
import { offerableModelCapability } from "../bridge/model-capability.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import { InMemorySessionRefStore, SessionManager, type SessionManagerOptions } from "../sessions/manager.js";
import { turnUsageLabel } from "../sessions/usage-label.js";
import { isRetiredAgentId, isNativeAgentRuntimeId } from "@konteks/backstage-plugin-common";
import { classifyAgentBilling, recogniseNativeModel } from "@konteks/backstage-plugin-common/known-models";

const credential = (providerId: string, kind: "sign_in" | "api_key"): ConnectedAgentCredential => ({ providerId, label: `${providerId} ${kind}`, kind, state: "ready" });

describe("a turn's money basis follows how its provider bills (O7)", () => {
  const accepts = { coreAcceptsRouteBilling: true };
  it("keeps Claude Code and Codex on the subscription basis", () => {
    for (const agentId of ["claude-code", "codex"]) expect(turnUsageLabel({ agentId, modelValue: "sonnet", credentials: undefined, ...accepts })).toEqual({ moneyBasis: "unavailable_local_subscription" });
  });
  it("labels an OpenCode turn by its model's provider and the credential that serves it", () => {
    const signedIn = [credential("openai", "sign_in"), credential("opencode", "sign_in"), credential("deepseek", "api_key")];
    // ChatGPT sign-in: the person's plan.
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "openai/gpt-5.5", credentials: signedIn, ...accepts })).toEqual({ moneyBasis: "unavailable_local_subscription" });
    // The Console sign-in draws Zen credit; free models are Zen too.
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "opencode/claude-sonnet-5", credentials: signedIn, ...accepts })).toEqual({ moneyBasis: "pay_per_use", provider: "opencode", model: "claude-sonnet-5" });
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "opencode/muse-spark-1.3-contributor-free", credentials: [], ...accepts })).toEqual({ moneyBasis: "pay_per_use", provider: "opencode", model: "muse-spark-1.3-contributor-free" });
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "deepseek/deepseek-v4-pro", credentials: signedIn, ...accepts })).toEqual({ moneyBasis: "pay_per_use", provider: "deepseek", model: "deepseek-v4-pro" });
    // An OpenAI key: pay-per-use. Held both ways: nothing is claimed, so pay-per-use.
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "openai/gpt-5.5", credentials: [credential("openai", "api_key")], ...accepts })).toMatchObject({ moneyBasis: "pay_per_use", provider: "openai" });
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "openai/gpt-5.5", credentials: [credential("openai", "api_key"), credential("openai", "sign_in")], ...accepts })).toMatchObject({ moneyBasis: "pay_per_use" });
    // OpenCode Go and Copilot are plans however signed in.
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "opencode-go/glm-5.1", credentials: [credential("opencode-go", "api_key")], ...accepts })).toEqual({ moneyBasis: "unavailable_local_subscription" });
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "github-copilot/claude-sonnet-4.5", credentials: [], ...accepts })).toEqual({ moneyBasis: "unavailable_local_subscription" });
  });
  it("moves DeepSeek Harness's key turns to pay-per-use (closes dsh D5)", () => {
    expect(turnUsageLabel({ agentId: "dsh", modelValue: "[\"deepseek-official\",\"deepseek-flash\"]", credentials: undefined, ...accepts })).toEqual({ moneyBasis: "pay_per_use", provider: "deepseek" });
  });
  it("never reports a pay-per-use turn to an older Core, nor a turn whose provider is unknown, and never as a subscription", () => {
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "deepseek/deepseek-v4-pro", credentials: [], coreAcceptsRouteBilling: false })).toBeNull();
    expect(turnUsageLabel({ agentId: "dsh", modelValue: undefined, credentials: undefined, coreAcceptsRouteBilling: false })).toBeNull();
    expect(turnUsageLabel({ agentId: "opencode", modelValue: undefined, credentials: [], ...accepts })).toBeNull();
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "no-provider", credentials: [], ...accepts })).toBeNull();
    // A subscription turn is still reported to an older Core.
    expect(turnUsageLabel({ agentId: "opencode", modelValue: "openai/gpt-5.5", credentials: [credential("openai", "sign_in")], coreAcceptsRouteBilling: false })).toEqual({ moneyBasis: "unavailable_local_subscription" });
  });
});

const MODELS = (current: string) => [{ id: "model", type: "select", name: "Model", currentValue: current, options: [
  { value: "opencode/space-bunny-free", name: "Space Bunny (free)" }, { value: "opencode/claude-sonnet-5", name: "Claude Sonnet 5" }, { value: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
] }];

function openCodeBridge(options: { current?: string; usage?: Array<{ cost: number }> } = {}) {
  const calls: Record<string, unknown[]> = {};
  let onUpdate: ((cost: number) => void) | undefined;
  let costs = [...(options.usage ?? [])];
  const connection = {
    newSession: vi.fn(async (params: unknown) => { (calls.newSession ??= []).push(params); return { sessionId: "oc-1", configOptions: MODELS(options.current ?? "opencode/claude-sonnet-5") }; }),
    loadSession: vi.fn(async () => ({ configOptions: MODELS(options.current ?? "opencode/claude-sonnet-5") })),
    prompt: vi.fn(async () => {
      const next = costs.shift();
      if (next) onUpdate?.(next.cost);
      return { stopReason: "end_turn", usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 } };
    }),
    setSessionConfigOption: vi.fn(async (params: { configId: string; value: string }) => { (calls.setSessionConfigOption ??= []).push(params); return { configOptions: MODELS(params.value) }; }),
    cancel: vi.fn(async () => undefined),
  } as unknown as ClientSideConnection;
  const bridge: BridgeProcess = { connection, initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } } as InitializeResponse, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) };
  return { bridge, calls, attach: (fn: (cost: number) => void) => { onUpdate = fn; }, setCosts: (value: Array<{ cost: number }>) => { costs = value; } };
}

const context = { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "opencode" };

function manager(bridge: BridgeProcess, extra: Partial<SessionManagerOptions> = {}) {
  const events = new RunnerEventBus();
  const observations: Array<Extract<RunnerEvent, { kind: "usage_observation" }>["observation"]> = [];
  const errors: RunnerEvent[] = [];
  events.subscribe(event => {
    if (event.kind === "usage_observation") observations.push(event.observation);
    if (event.kind === "request_error") errors.push(event);
  });
  const sessions = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), now: () => new Date("2026-09-28T12:00:00Z"), ...extra });
  return { sessions, events, observations, errors };
}

async function turn(sessions: SessionManager, events: RunnerEventBus, ref: string, id: string) {
  const done = new Promise<void>(resolve => { const off = events.subscribe(event => { if (event.kind === "prompt_result" && event.requestId === id) { off(); resolve(); } }); });
  sessions.prompt(ref, id, { prompt: [{ type: "text", text: "hi" }] });
  await done;
  // The turn is counted finished once its completion settled.
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("OpenCode turns carry the provider's reported cost (O7)", () => {
  const label = (credentials: ConnectedAgentCredential[]) => (modelValue: string | undefined) => turnUsageLabel({ agentId: "opencode", modelValue, credentials, coreAcceptsRouteBilling: true });

  it("reports each turn's `usage_update.cost` delta in USD micros, with the provider and model the session runs", async () => {
    const fake = openCodeBridge({ usage: [{ cost: 0.0125 }, { cost: 0.0305 }] });
    const { sessions, events, observations } = manager(fake.bridge, { usageLabel: label([credential("opencode", "sign_in")]) });
    const { acpSessionRef } = await sessions.create({ context, cwd: "/w", mcpServers: [] });
    fake.attach(cost => sessions.onSessionUpdate({ sessionId: "oc-1", update: { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: cost, currency: "USD" } } } as never, fake.bridge));
    await turn(sessions, events, acpSessionRef, "t1");
    await turn(sessions, events, acpSessionRef, "t2");
    expect(observations).toEqual([
      expect.objectContaining({ moneyBasis: "pay_per_use", provider: "opencode", model: "claude-sonnet-5", reportedCost: { currency: "USD", amountMicros: 12_500 }, totalTokens: 100 }),
      expect.objectContaining({ moneyBasis: "pay_per_use", provider: "opencode", model: "claude-sonnet-5", reportedCost: { currency: "USD", amountMicros: 18_000 } }),
    ]);
    for (const observation of observations) expect(AgentTurnUsageObservationSchema.safeParse(observation).success).toBe(true);
    // The session moves to another model: the next turn names it.
    sessions.setConfigOption(acpSessionRef, "c1", { configId: "model", value: "deepseek/deepseek-v4-pro" } as never);
    await vi.waitFor(() => expect(fake.calls.setSessionConfigOption).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    await turn(sessions, events, acpSessionRef, "t3");
    expect(observations[2]).toMatchObject({ moneyBasis: "pay_per_use", provider: "deepseek", model: "deepseek-v4-pro" });
    // No cost reported for that turn: unknown, never zero.
    expect(observations[2]).not.toHaveProperty("reportedCost");
  });

  it("keeps a subscription turn without money, and a resumed session's first turn without a cost it cannot know", async () => {
    const fake = openCodeBridge({ current: "openai/gpt-5.5" });
    const { sessions, events, observations } = manager(fake.bridge, { usageLabel: label([credential("openai", "sign_in")]) });
    const { acpSessionRef } = await sessions.create({ context, cwd: "/w", mcpServers: [] });
    await turn(sessions, events, acpSessionRef, "t1");
    expect(observations[0]).toEqual(expect.objectContaining({ moneyBasis: "unavailable_local_subscription" }));
    expect(JSON.stringify(observations[0])).not.toMatch(/provider|reportedCost|model/);

    const store = new InMemorySessionRefStore();
    await store.put("acp-prior", "oc-old");
    const resumed = openCodeBridge({ usage: [{ cost: 4.2 }] });
    const second = manager(resumed.bridge, { usageLabel: label([credential("opencode", "sign_in")]), refStore: store });
    const restored = await second.sessions.create({ context, cwd: "/w", mcpServers: [], acpSessionRef: "acp-prior" });
    resumed.attach(cost => second.sessions.onSessionUpdate({ sessionId: "oc-old", update: { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: cost, currency: "USD" } } } as never, resumed.bridge));
    await turn(second.sessions, second.events, restored.acpSessionRef, "t1");
    // $4.20 is the whole session's history: not this turn's cost.
    expect(second.observations[0]).toMatchObject({ moneyBasis: "pay_per_use", provider: "opencode" });
    expect(second.observations[0]).not.toHaveProperty("reportedCost");
    resumed.setCosts([{ cost: 4.25 }]);
    await turn(second.sessions, second.events, restored.acpSessionRef, "t2");
    expect(second.observations[1]).toMatchObject({ reportedCost: { currency: "USD", amountMicros: 50_000 } });
  });

  it("reports nothing it cannot label: a pay-per-use turn to an older Core", async () => {
    const fake = openCodeBridge();
    const { sessions, events, observations } = manager(fake.bridge, { usageLabel: modelValue => turnUsageLabel({ agentId: "opencode", modelValue, credentials: [], coreAcceptsRouteBilling: false }) });
    const { acpSessionRef } = await sessions.create({ context, cwd: "/w", mcpServers: [] });
    await turn(sessions, events, acpSessionRef, "t1");
    expect(observations).toEqual([]);
  });
});

describe("Zen's free models only with the person's say-so (O6)", () => {
  const offOnly = (value: string) => !/^opencode\/[^/]+-free$/.test(value);

  it("moves a session that would start on a free model to the first model it may use, and refuses switching to one", async () => {
    const fake = openCodeBridge({ current: "opencode/space-bunny-free" });
    const { sessions, events, errors } = manager(fake.bridge, { modelAllowed: offOnly });
    const { acpSessionRef } = await sessions.create({ context, cwd: "/w", mcpServers: [] });
    expect(fake.calls.setSessionConfigOption).toEqual([{ sessionId: "oc-1", configId: "model", value: "opencode/claude-sonnet-5" }]);
    sessions.setConfigOption(acpSessionRef, "c1", { configId: "model", value: "opencode/space-bunny-free" } as never);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ kind: "request_error", class: "invalid_params", message: expect.stringContaining("free models are switched off") });
    expect(fake.calls.setSessionConfigOption).toHaveLength(1);
    await expect(sessions.create({ context, cwd: "/w", mcpServers: [], sessionConfig: { model: "opencode/space-bunny-free" } })).rejects.toMatchObject({ code: "permission_denied" });
    void events;
  });

  it("leaves a session on a model it may use alone, and lets a free model run once switched on", async () => {
    const fake = openCodeBridge({ current: "opencode/claude-sonnet-5" });
    await manager(fake.bridge, { modelAllowed: offOnly }).sessions.create({ context, cwd: "/w", mcpServers: [] });
    expect(fake.calls.setSessionConfigOption).toBeUndefined();
    const on = openCodeBridge({ current: "opencode/space-bunny-free" });
    await manager(on.bridge, { modelAllowed: () => true }).sessions.create({ context, cwd: "/w", mcpServers: [] });
    expect(on.calls.setSessionConfigOption).toBeUndefined();
  });

  it("filters what is offered and never reports a hidden model as current", () => {
    const capability = { currentValue: "opencode/space-bunny-free", offeredValues: ["opencode/space-bunny-free", "opencode/claude-sonnet-5"], offeredOptions: [{ value: "opencode/space-bunny-free" }, { value: "opencode/claude-sonnet-5" }] };
    const family = { agentId: "opencode", displayName: "OpenCode" };
    expect(offerableModelCapability(capability, offOnly, family)).toEqual({ currentValue: "opencode/claude-sonnet-5", offeredValues: ["opencode/claude-sonnet-5"], offeredOptions: [{ value: "opencode/claude-sonnet-5" }] });
    expect(offerableModelCapability(capability, () => true, family)).toEqual(capability);
    expect(() => offerableModelCapability({ ...capability, offeredValues: ["opencode/space-bunny-free"], offeredOptions: [{ value: "opencode/space-bunny-free" }] }, offOnly, family))
      .toThrow(expect.objectContaining({ code: "agent_auth_required" }) as Error);
  });
});

describe("the vendored packages 7.1.0", () => {
  it("un-retires OpenCode and brings its recognition, billing and money basis", () => {
    expect(isRetiredAgentId("opencode")).toBe(false);
    expect(isNativeAgentRuntimeId("opencode")).toBe(true);
    expect(recogniseNativeModel("opencode", "anthropic/claude-sonnet-4-5").status).not.toBe("unrecognised");
    expect(recogniseNativeModel("opencode", "opencode/claude-sonnet-5").status).not.toBe("unrecognised");
    expect(classifyAgentBilling({ agentId: "opencode", providerId: "openai", credential: "sign_in" })).toBe("subscription");
    expect(AgentTurnUsageObservationSchema.safeParse({ instanceId: "i", assignmentId: "a", attempt: 1, agentId: "opencode", totalTokens: 1, inputTokens: 1, outputTokens: 0,
      observedAt: "2026-09-28T00:00:00Z", moneyBasis: "pay_per_use", provider: "opencode", reportedCost: { currency: "USD", amountMicros: 1 } }).success).toBe(true);
  });
});
