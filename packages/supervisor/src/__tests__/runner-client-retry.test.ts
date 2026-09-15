import { describe, expect, it, vi } from "vitest";
import { nullLogger } from "@konteks/remote-common";
import { RunnerClient } from "../runner-client.js";

describe("ambiguous ACP mutation transport policy", () => {
  it.each([
    ["close", (client: RunnerClient) => client.closeSession("session")],
    ["set_mode", (client: RunnerClient) => client.setMode("session", "request", { sessionId: "session", modeId: "plan" })],
    ["set_config_option", (client: RunnerClient) => client.setConfigOption("session", "request", { sessionId: "session", configId: "model", value: "model" })],
    ["answer", (client: RunnerClient) => client.answer("session", "request", { outcome: "cancelled" })],
  ] as const)("does not replay %s after an ambiguous transport failure", async (_name, invoke) => {
    const fetchFn = vi.fn(async () => { throw new Error("connection reset after write"); });
    const client = new RunnerClient({ agentId: "codex", baseUrl: "http://runner.local", fetchFn: fetchFn as typeof fetch,
      onEvent: () => undefined, retrySleep: async () => undefined, logger: nullLogger });
    await expect(invoke(client)).rejects.toMatchObject({ code: "agent_unavailable", retryable: true });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
