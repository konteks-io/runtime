import { describe, expect, it, vi } from "vitest";

// Packages 7.1.0 brings OpenCode's recognition rule; until the runtime
// vendors it, stand in for it so the wiring (agent id, offered order) is proven.
vi.mock("@konteks/backstage-plugin-common/known-models", async importOriginal => {
  const actual = await importOriginal<typeof import("@konteks/backstage-plugin-common/known-models")>();
  return {
    ...actual,
    recogniseNativeModel: (agentId: string, value: string) => agentId === "opencode" && value.startsWith("anthropic/")
      ? { status: "known" } : actual.recogniseNativeModel(agentId, value),
  };
});

const { MAX_OFFERED_MODEL_VALUES, exactSelect } = await import("../bridge/model-capability.js");

describe("OpenCode's model select", () => {
  it("reports every model when the account offers fewer than the wire bound (77 through Zen alone)", () => {
    const options = Array.from({ length: 77 }, (_value, index) => ({ value: `opencode/model-${index}`, name: `Model ${index}` }));
    const result = exactSelect({ id: "model", name: "Model", type: "select", currentValue: "opencode/model-40", options } as never, "opencode");
    expect(result.offeredValues).toEqual(options.map(option => option.value));
    expect(result.currentValue).toBe("opencode/model-40");
  });

  it("above the wire bound keeps the known models first and the current one", () => {
    const zen = Array.from({ length: 150 }, (_value, index) => ({ value: `opencode/zen-${index}`, name: `Zen ${index}` }));
    const anthropic = [{ value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }, { value: "anthropic/claude-opus-4-1", name: "Claude Opus 4.1" }];
    const result = exactSelect({ id: "model", name: "Model", type: "select", currentValue: "opencode/zen-149", options: [...zen, ...anthropic] } as never, "opencode");
    expect(result.offeredValues).toHaveLength(MAX_OFFERED_MODEL_VALUES);
    expect(result.offeredValues).toEqual(expect.arrayContaining(["opencode/zen-149", "anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"]));
    expect(result.offeredValues.at(-1)).toBe("anthropic/claude-opus-4-1");
  });
});
