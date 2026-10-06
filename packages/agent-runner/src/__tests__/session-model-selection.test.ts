import { describe, expect, it, vi } from "vitest";
import { RequestError, type ClientSideConnection } from "@agentclientprotocol/sdk";
import type { BridgeProcess } from "../bridge/process.js";
import { RunnerEventBus } from "../events.js";
import { InMemorySessionRefStore, SessionManager } from "../sessions/manager.js";
import { CODEX_SESSION_GOVERNANCE } from "../runtime.js";

const policy = {
  kind: "same_agent_default_if_unoffered",
  configId: "model",
  requestedValue: "requested-model",
};
const context = { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "codex" };
const args = () =>
  ({
    context,
    cwd: "/work",
    mcpServers: [],
    sessionConfig: { model: policy.requestedValue },
    modelSelectionPolicy: policy,
  }) as never;
const option = (
  currentValue = "actual-default",
  values = ["actual-default", "another-offered"],
) => ({
  id: "model",
  category: "model",
  type: "select",
  name: "Model",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

function fixture(
  config: unknown = option(),
  refusal?: Error,
  modelAllowed?: (value: string) => boolean,
  requireRaw = false,
) {
  const mode = {
    id: "mode",
    type: "select",
    name: "Mode",
    currentValue: "read-only",
    options: [{ value: "read-only", name: "Ask" }],
  };
  const setSessionConfigOption = vi.fn(
    async ({ configId, value }: { configId: string; value: string }) => {
      if (refusal && configId === "model") throw refusal;
      if (
        configId === "model" &&
        !(config as ReturnType<typeof option>).options.some((entry) => entry.value === value)
      )
        throw RequestError.invalidParams(undefined, "unsupported model");
      return {
        configOptions: [
          { ...(config as object), ...(configId === "model" ? { currentValue: value } : {}) },
          mode,
        ],
      };
    },
  );
  const connection = {
    newSession: vi.fn(async () => ({
      sessionId: "provider-session",
      configOptions: [config, mode],
    })),
    setSessionConfigOption,
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
  } as unknown as ClientSideConnection;
  const bridge = {
    connection,
    initializeResult: { protocolVersion: 1 },
    exited: false,
    stop: vi.fn(async () => undefined),
    stderrTail: () => [],
  } as BridgeProcess;
  const events = new RunnerEventBus();
  const manager = new SessionManager({
    bridge: () => bridge,
    events,
    refStore: new InMemorySessionRefStore(),
    ...CODEX_SESSION_GOVERNANCE,
    ...(modelAllowed ? { modelAllowed } : {}),
    ...(requireRaw ? { requireRawModelOffer: true } : {}),
  });
  return { manager, connection, setSessionConfigOption, events, bridge };
}

const approvalMode = {
  id: "mode",
  type: "select",
  name: "Mode",
  currentValue: "read-only",
  options: [{ value: "read-only", name: "Ask" }],
};
function setterConfig(current: string, offered: string[]) {
  return [
    {
      ...option(
        current,
        [current, ...offered].filter((value, index, values) => values.indexOf(value) === index),
      ),
      _meta: {
        konteksModelOffer: {
          source: "codex-model-list.v1",
          offeredValues: offered,
          defaultValue: offered[0] ?? null,
        },
      },
    },
    approvalMode,
  ];
}

async function settleFirstTurn(test: ReturnType<typeof fixture>, acpSessionRef: string) {
  const completed = new Promise<void>((resolve) => {
    const unsubscribe = test.events.subscribe((event) => {
      if (event.kind !== "prompt_result") return;
      unsubscribe();
      resolve();
    });
  });
  test.manager.prompt(acpSessionRef, "first-prompt", { prompt: [] });
  await completed;
  await test.manager.sealCompletedTurn(acpSessionRef);
}

describe("admitted direct model selection before work", () => {
  const rawOption = (defaultValue: string | null = "actual-default") => ({
    ...option("gpt-6.1-sol", ["gpt-6.1-sol", "actual-default"]),
    _meta: {
      konteksModelOffer: {
        source: "codex-model-list.v1",
        offeredValues: ["actual-default"],
        defaultValue,
      },
    },
  });
  const defaultArgs = () =>
    ({
      context,
      cwd: "/work",
      mcpServers: [],
      agentTitled: true,
      modelSelectionPolicy: { kind: "same_agent_default", configId: "model" },
    }) as never;

  it.each(["model", "effort"])(
    "refuses an echoed effective model withdrawn from the raw offer during %s confirmation",
    async (withdrawnAt) => {
      const test = fixture(rawOption(), undefined, undefined, true);
      test.setSessionConfigOption.mockImplementation(async ({ configId, value }) => ({
        configOptions: [
          ...setterConfig(
            configId === "mode" ? "gpt-6.1-sol" : "actual-default",
            configId === withdrawnAt ? ["new-default"] : ["actual-default"],
          ),
          {
            id: "effort",
            type: "select",
            name: "Effort",
            currentValue: configId === "effort" ? value : "medium",
            options: [{ value: "high", name: "High" }],
          },
        ],
      }));
      await expect(
        test.manager.create({
          ...(args() as object),
          sessionConfig: { model: policy.requestedValue, effort: "high" },
        } as never),
      ).rejects.toThrow();
      expect(test.connection.prompt).not.toHaveBeenCalled();
      expect(
        test.setSessionConfigOption.mock.calls.filter(([request]) => request.configId === "model"),
      ).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "confirms only the retained agent-default pin on a live resume without config options (still offered: %s)",
    async (stillOffered) => {
      const test = fixture(rawOption(), undefined, undefined, true);
      test.bridge.initializeResult.agentCapabilities = { sessionCapabilities: { resume: {}, close: {} } };
      const resumeSession = vi.fn(async () => ({}));
      const closeSession = vi.fn(async () => ({}));
      Object.assign(test.connection, { resumeSession, closeSession });
      const first = await test.manager.create(defaultArgs());
      await settleFirstTurn(test, first.acpSessionRef);
      test.setSessionConfigOption.mockClear();
      test.setSessionConfigOption.mockImplementation(async () => ({
        configOptions: setterConfig(
          "actual-default",
          stillOffered ? ["new-default", "actual-default"] : ["new-default"],
        ),
      }));
      const continuation = test.manager.continueLive({
        context: { ...context, assignmentId: "next-asg" },
        cwd: "/work",
        mcpServers: [],
        acpSessionRef: first.acpSessionRef,
        sessionConfig: { model: "actual-default" },
        modelSelection: first.modelSelection,
      });
      if (stillOffered)
        expect(await continuation).toMatchObject({ modelSelection: first.modelSelection });
      else await expect(continuation).rejects.toThrow();
      expect(test.connection.prompt).toHaveBeenCalledTimes(1);
      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledWith({ sessionId: "provider-session" });
      expect(
        test.setSessionConfigOption.mock.calls.filter(([request]) => request.configId === "model"),
      ).toEqual([[{ sessionId: "provider-session", configId: "model", value: "actual-default" }]]);
    },
  );

  it("confirms the signed agent-default policy from the explicit raw default before work without inventing a requested model", async () => {
    const { manager, connection, setSessionConfigOption } = fixture(
      rawOption(),
      undefined,
      undefined,
      true,
    );
    expect(await manager.create(defaultArgs())).toMatchObject({
      modelSelection: {
        configId: "model",
        effectiveValue: "actual-default",
        resolution: "agent_default",
      },
    });
    expect(
      setSessionConfigOption.mock.calls.filter(([request]) => request.configId === "model"),
    ).toEqual([[{ sessionId: "provider-session", configId: "model", value: "actual-default" }]]);
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("excludes Codex's injected current option when resolving an admitted missing model", async () => {
    const { manager, connection } = fixture(rawOption(), undefined, undefined, true);
    expect(
      await manager.create({
        ...(args() as object),
        sessionConfig: { model: "gpt-6.1-sol" },
        modelSelectionPolicy: { ...policy, requestedValue: "gpt-6.1-sol" },
      } as never),
    ).toMatchObject({
      modelSelection: {
        requestedValue: "gpt-6.1-sol",
        effectiveValue: "actual-default",
        resolution: "default_if_unoffered",
      },
    });
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it.each([option(), rawOption(null)])(
    "refuses a signed Codex default without confirmed raw provenance (%j)",
    async (offered) => {
      const { manager, connection, setSessionConfigOption } = fixture(
        offered,
        undefined,
        undefined,
        true,
      );
      await expect(manager.create(defaultArgs())).rejects.toThrow();
      expect(setSessionConfigOption).not.toHaveBeenCalled();
      expect(connection.prompt).not.toHaveBeenCalled();
    },
  );

  it("can confirm a requested raw offer even when the agent did not identify a default", async () => {
    const { manager } = fixture(rawOption(null), undefined, undefined, true);
    expect(
      await manager.create({
        ...(args() as object),
        sessionConfig: { model: "actual-default" },
        modelSelectionPolicy: { ...policy, requestedValue: "actual-default" },
      } as never),
    ).toMatchObject({
      modelSelection: {
        requestedValue: "actual-default",
        effectiveValue: "actual-default",
        resolution: "requested",
      },
    });
  });

  it("uses the actual session default only when its exact offer excludes the request, retains governance and attests both values", async () => {
    const { manager, connection, setSessionConfigOption } = fixture();
    const created = await manager.create(args());
    expect(created).toMatchObject({
      modelSelection: {
        configId: "model",
        requestedValue: "requested-model",
        effectiveValue: "actual-default",
        resolution: "default_if_unoffered",
      },
    });
    expect(setSessionConfigOption.mock.calls.map(([request]) => request)).toEqual([
      { sessionId: "provider-session", configId: "mode", value: "read-only" },
      { sessionId: "provider-session", configId: "model", value: "actual-default" },
    ]);
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("confirms an offered request without substitution", async () => {
    const { manager } = fixture(option("actual-default", ["actual-default", "requested-model"]));
    expect(await manager.create(args())).toMatchObject({
      modelSelection: {
        configId: "model",
        requestedValue: "requested-model",
        effectiveValue: "requested-model",
        resolution: "requested",
      },
    });
  });

  it("never treats display-only direct naming as permission to change a model", async () => {
    const { manager, connection } = fixture();
    await expect(
      manager.create({
        context,
        cwd: "/work",
        mcpServers: [],
        sessionConfig: { model: "requested-model" },
        agentTitled: true,
      }),
    ).rejects.toThrow("did not confirm");
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("retains the existing unpinned OpenCode permitted-model choice without new direct model authority", async () => {
    const test = fixture(
      option("blocked-free", ["blocked-free", "actual-default"]),
      undefined,
      (value) => value !== "blocked-free",
    );
    const created = await test.manager.create({
      context: { ...context, agentId: "opencode" },
      cwd: "/work",
      mcpServers: [],
    });
    expect(created).not.toHaveProperty("modelSelection");
    expect(
      test.setSessionConfigOption.mock.calls.filter(([request]) => request.configId === "model"),
    ).toEqual([[{ sessionId: "provider-session", configId: "model", value: "actual-default" }]]);
    expect(test.connection.prompt).not.toHaveBeenCalled();
  });

  it.each([
    RequestError.invalidParams(undefined, "model supported before call but refused now"),
    new Error("authentication required"),
    new Error("quota exhausted"),
    new Error("network unavailable"),
  ])("does not mask a setter refusal or retry on another model (%s)", async (refusal) => {
    const { manager, connection, setSessionConfigOption } = fixture(
      option("actual-default", ["actual-default", "requested-model"]),
      refusal,
    );
    await expect(manager.create(args())).rejects.toThrow("did not confirm");
    expect(
      setSessionConfigOption.mock.calls.filter(([request]) => request.configId === "model"),
    ).toHaveLength(1);
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it.each([
    option("not-offered"),
    { ...option(), type: "input" },
    { ...option(), currentValue: "" },
    {
      ...option(),
      options: [
        { value: "actual-default", name: "one" },
        { value: "actual-default", name: "duplicate" },
      ],
    },
    { ...option(), category: "thought_level" },
  ])("refuses an unproven or malformed actual default (%j)", async (config) => {
    const { manager, connection, setSessionConfigOption } = fixture(config);
    await expect(manager.create(args())).rejects.toThrow();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("rejects a policy which does not match the immutable admitted pin", async () => {
    const { manager, connection } = fixture();
    await expect(
      manager.create({
        ...(args() as object),
        modelSelectionPolicy: { ...policy, requestedValue: "different" },
      } as never),
    ).rejects.toThrow();
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("does not widen the agent's governed model policy when its actual default is refused", async () => {
    const { manager, connection, setSessionConfigOption } = fixture(
      option(),
      undefined,
      (value) => value !== "actual-default",
    );
    await expect(manager.create(args())).rejects.toThrow();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("confirms a durable effective pin after restart without selecting a different current default", async () => {
    const { manager, connection, setSessionConfigOption } = fixture(
      option("new-default", ["new-default", "actual-default"]),
    );
    const modelSelection = {
      configId: "model",
      requestedValue: "requested-model",
      effectiveValue: "actual-default",
      resolution: "default_if_unoffered",
    };
    expect(await manager.create({ ...(args() as object), modelSelection } as never)).toMatchObject({
      modelSelection,
    });
    expect(
      setSessionConfigOption.mock.calls.filter(([request]) => request.configId === "model"),
    ).toEqual([[{ sessionId: "provider-session", configId: "model", value: "actual-default" }]]);
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("refuses a lost effective pin after restart instead of substituting a second default", async () => {
    const { manager, connection, setSessionConfigOption } = fixture(
      option("new-default", ["new-default"]),
    );
    const modelSelection = {
      configId: "model",
      requestedValue: "requested-model",
      effectiveValue: "actual-default",
      resolution: "default_if_unoffered",
    };
    await expect(
      manager.create({ ...(args() as object), modelSelection } as never),
    ).rejects.toThrow();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
  });
});
