import { describe, expect, it, vi } from "vitest";
import { RequestError, type ClientSideConnection } from "@agentclientprotocol/sdk";
import type { BridgeProcess } from "../bridge/process.js";
import { RunnerEventBus } from "../events.js";
import { InMemorySessionRefStore, SessionManager } from "../sessions/manager.js";
import { lowestEffortChange, routedModelChange } from "../sessions/utility-turn.js";

const effortFor: Record<string, string[]> = { opus: ["low", "medium", "high", "max"], haiku: [] };
/** Claude's ACP options: the model select, and an effort select only for a model that has effort levels. */
function claudeOptions(model: string, effort = "default") {
  const levels = effortFor[model] ?? [];
  return [
    { id: "model", category: "model", type: "select", currentValue: model,
      options: [{ value: "default", name: "Default" }, { value: "opus", name: "Opus" }, { value: "haiku", name: "Haiku" }] },
    ...(levels.length ? [{ id: "effort", category: "thought_level", type: "select", currentValue: effort,
      options: [{ value: "default", name: "Default" }, ...levels.map(value => ({ value, name: value }))] }] : []),
  ];
}

function fixture(refuse?: string) {
  let model = "opus";
  let effort = "default";
  const setSessionConfigOption = vi.fn(async ({ configId, value }: { configId: string; value: string }) => {
    if (configId === refuse) throw RequestError.invalidParams(undefined, "refused");
    if (configId === "model") model = value;
    if (configId === "effort") effort = value;
    return { configOptions: claudeOptions(model, effort) };
  });
  const connection = {
    newSession: vi.fn(async (_params: Record<string, unknown>) => ({ sessionId: "provider-session", configOptions: claudeOptions("opus") })),
    setSessionConfigOption,
  } as unknown as ClientSideConnection;
  const bridge = { connection, initializeResult: { protocolVersion: 1 }, exited: false, stop: vi.fn(async () => undefined), stderrTail: () => [] } as unknown as BridgeProcess;
  const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore() });
  return { manager, connection, setSessionConfigOption };
}

const args = (utility?: { model?: string }) => ({
  context: { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "claude-code" },
  cwd: "/work",
  mcpServers: [],
  integration: { admittedMcpServerNames: [], accountConnectors: true, ...(utility ? { utility } : {}) },
}) as never;

describe("a utility integration turn", () => {
  it("takes the routed model and its lowest effort, with extended thinking off", async () => {
    const test = fixture();
    effortFor.haiku = [];
    await test.manager.create(args({ model: "haiku" }));
    expect(test.setSessionConfigOption.mock.calls.map(([call]) => [call.configId, call.value])).toEqual([["model", "haiku"]]);
    const meta = (test.connection.newSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]._meta;
    expect(meta).toMatchObject({ konteksIntegration: { version: 1, accountConnectors: true }, claudeCode: { options: { thinking: { type: "disabled" } } } });
    // The session's own Claude options (its title) are kept.
    expect(meta.claudeCode.options.title).toMatch(/^\[konteks\] /);
  });

  it("lowers the effort of a routed model that has effort levels", async () => {
    const test = fixture();
    await test.manager.create(args({ model: "opus" }));
    expect(test.setSessionConfigOption.mock.calls.map(([call]) => [call.configId, call.value])).toEqual([["effort", "low"]]);
  });

  it("keeps the agent's own choice when it refuses one, and still opens the session", async () => {
    const test = fixture("model");
    const created = await test.manager.create(args({ model: "haiku" }));
    expect(created.acpSessionRef).toMatch(/^acp-/);
    // The refused model leaves Opus, whose lowest effort is still taken.
    expect(test.setSessionConfigOption.mock.calls.map(([call]) => [call.configId, call.value])).toEqual([["model", "haiku"], ["effort", "low"]]);
  });

  it("changes nothing for a read Core did not route", async () => {
    const test = fixture();
    await test.manager.create(args());
    expect(test.setSessionConfigOption).not.toHaveBeenCalled();
    const meta = (test.connection.newSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]._meta;
    expect(meta.claudeCode.options).not.toHaveProperty("thinking");
  });

  it("chooses only values the session offers", () => {
    expect(routedModelChange(claudeOptions("opus"), "sonnet")).toBeUndefined();
    expect(routedModelChange(claudeOptions("haiku"), "haiku")).toBeUndefined();
    expect(lowestEffortChange([{ id: "reasoning", category: "thought_level", type: "select", currentValue: "high",
      options: [{ group: "g", options: [{ value: "high" }, { value: "minimal" }, { value: "turbo" }] }] }])).toEqual({ configId: "reasoning", value: "minimal" });
    expect(lowestEffortChange(claudeOptions("opus", "low"))).toBeUndefined();
  });
});
