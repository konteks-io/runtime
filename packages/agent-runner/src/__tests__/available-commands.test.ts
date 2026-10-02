import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvailableCommandListSchema, ConnectedAgentViewSchema } from "@konteks/remote-common";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { BridgeProcess } from "../bridge/process.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import { InMemorySessionRefStore, SessionManager } from "../sessions/manager.js";
import { AVAILABLE_COMMANDS_FILE, AvailableCommandsStore } from "../sessions/available-commands.js";
import { projectReadiness } from "../readiness.js";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import { DEFAULT_HOST_AGENT_SETTINGS } from "../host/host-agent.js";
import { SUPPORTED_AGENT_BRIDGES } from "@konteks/remote-release";
import { INITIAL_SCOPE_STATE } from "../auth/scope-store.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "available-commands-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const update = (availableCommands: unknown) => ({ sessionUpdate: "available_commands_update", availableCommands });

describe("learnt slash commands (runtime-view R19)", () => {
  it("keeps the latest update without refused commands, one line each, and always a list the heartbeat takes", async () => {
    const store = new AvailableCommandsStore(join(await tempDir(), AVAILABLE_COMMANDS_FILE), ["plan", "logout"]);
    store.learn(update([
      { name: "/review", description: "Review the\nchanges", input: { hint: "what to review" } },
      { name: "plan", description: "Plan mode" },
      { name: "LOGOUT", description: "Sign out" },
      { name: "bad name", description: "dropped" },
      { name: "review", description: "duplicate" },
      { name: "compact", description: null },
    ]), new Date("2026-09-29T10:00:00.000Z"));
    const learnt = store.current();
    expect(learnt).toEqual({
      commands: [{ name: "review", description: "Review the changes", hint: "what to review" }, { name: "compact", description: "" }],
      learntAt: "2026-09-29T10:00:00.000Z",
    });
    expect(AvailableCommandListSchema.safeParse(learnt!.commands).success).toBe(true);
    // A later update replaces it, an empty one too (the agent has none now).
    store.learn(update([]), new Date("2026-09-29T10:05:00.000Z"));
    expect(store.current()).toEqual({ commands: [], learntAt: "2026-09-29T10:05:00.000Z" });
    // Something that is not a command list changes nothing.
    store.learn({ sessionUpdate: "available_commands_update" }, new Date("2026-09-29T10:06:00.000Z"));
    expect(store.current()?.learntAt).toBe("2026-09-29T10:05:00.000Z");
    await store.settled();
  });

  it("survives a connector restart in the agent's own folder (0600), and a refused command never comes back from disk", async () => {
    const path = join(await tempDir(), AVAILABLE_COMMANDS_FILE);
    const first = new AvailableCommandsStore(path, []);
    first.learn(update([{ name: "plan", description: "Plan" }, { name: "compact", description: "Compact", input: { hint: "focus" } }]), new Date("2026-09-29T10:00:00.000Z"));
    await first.settled();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restarted = new AvailableCommandsStore(path, ["plan"]);
    expect(restarted.current()).toBeNull();
    await restarted.load();
    expect(restarted.current()).toEqual({ commands: [{ name: "compact", description: "Compact", hint: "focus" }], learntAt: "2026-09-29T10:00:00.000Z" });
  });

  it("re-dates an unchanged list at most hourly, and reads a damaged file as nothing learnt", async () => {
    const path = join(await tempDir(), AVAILABLE_COMMANDS_FILE);
    const store = new AvailableCommandsStore(path, []);
    const list = update([{ name: "compact", description: "Compact" }]);
    store.learn(list, new Date("2026-09-29T10:00:00.000Z"));
    store.learn(list, new Date("2026-09-29T10:30:00.000Z"));
    await store.settled();
    expect(JSON.parse(await readFile(path, "utf8")).learntAt).toBe("2026-09-29T10:00:00.000Z");
    store.learn(list, new Date("2026-09-29T11:01:00.000Z"));
    await store.settled();
    expect(JSON.parse(await readFile(path, "utf8")).learntAt).toBe("2026-09-29T11:01:00.000Z");
    await writeFile(path, "{not json");
    const damaged = new AvailableCommandsStore(path, []);
    await damaged.load();
    expect(damaged.current()).toBeNull();
  });

  it("the session manager hands every update to the runtime and still forwards it on the session stream", async () => {
    const connection = { newSession: vi.fn(async () => ({ sessionId: "bridge-s1" })) } as unknown as ClientSideConnection;
    const bridge = { connection, initializeResult: { protocolVersion: 1, agentCapabilities: {} }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) } as unknown as BridgeProcess;
    const events = new RunnerEventBus();
    const seen: unknown[] = [];
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore(), onAvailableCommands: value => { seen.push(value); } });
    await manager.create({ context: { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "claude-code" }, cwd: "/w", mcpServers: [] });
    const published: RunnerEvent[] = [];
    events.subscribe(event => { published.push(event); });
    const commands = update([{ name: "review", description: "Review" }]);
    manager.onSessionUpdate({ sessionId: "bridge-s1", update: commands } as never);
    expect(seen).toEqual([commands]);
    expect(published).toEqual([expect.objectContaining({ kind: "session_update", params: expect.objectContaining({ update: commands }) })]);
  });

  it("learns commands an agent announces while it is still creating the session (WS1-176)", async () => {
    const seen: unknown[] = [];
    const managerRef: { current?: SessionManager } = {};
    const commands = update([{ name: "init", description: "Create AGENTS.md" }]);
    // OpenCode sends its commands before its session/new reply arrives.
    const connection = { newSession: vi.fn(async () => { managerRef.current!.onSessionUpdate({ sessionId: "bridge-s1", update: commands } as never); return { sessionId: "bridge-s1" }; }) } as unknown as ClientSideConnection;
    const bridge = { connection, initializeResult: { protocolVersion: 1, agentCapabilities: {} }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) } as unknown as BridgeProcess;
    const manager = new SessionManager({ bridge: () => bridge, events: new RunnerEventBus(), refStore: new InMemorySessionRefStore(), onAvailableCommands: value => { seen.push(value); } });
    managerRef.current = manager;
    await manager.create({ context: { instanceId: "inst", assignmentId: "asg", attempt: 1, agentId: "opencode" }, cwd: "/w", mcpServers: [] });
    expect(seen).toEqual([commands]);
  });

  it("rides on the connected agent with when it was learnt", () => {
    const family = SUPPORTED_AGENT_BRIDGES.find(entry => entry.agentId === "claude-code")!;
    const view = projectReadiness({
      family, authMode: "agent_local_subscription", connectionState: "ready", initializeResult: { protocolVersion: 1, agentCapabilities: {} },
      scope: INITIAL_SCOPE_STATE, identity: "signal",
      bridgeVersionCompatible: true, lastProbeAt: null,
      availableCommands: { commands: [{ name: "review", description: "Review" }], learntAt: "2026-09-29T10:00:00.000Z" },
    });
    expect(view.availableCommands).toEqual([{ name: "review", description: "Review" }]);
    expect(view.availableCommandsLearntAt).toBe("2026-09-29T10:00:00.000Z");
    expect(ConnectedAgentViewSchema.safeParse(view).success).toBe(true);
  });

  it("the runtime reports what its sessions announced, only to a Core that takes 7.1 fields, and remembers it across a restart", async () => {
    const root = await tempDir();
    const handlers: Array<Parameters<NonNullable<ConstructorParameters<typeof AgentRuntime>[0]["spawn"]>>[0]["handlers"]> = [];
    const spawn = async (input: { handlers: (typeof handlers)[number] }) => {
      handlers.push(input.handlers);
      return { connection: { newSession: vi.fn(async () => ({ sessionId: "private-1" })),
        setSessionConfigOption: vi.fn(async ({ configId, value }: { configId: string; value: string }) => ({ configOptions: [
          { id: configId, name: configId, type: "select" as const, currentValue: value, options: [{ value, name: value }] },
        ] })) } as never,
        initializeResult: { protocolVersion: 1 }, exited: false, stderrTail: () => [], stop: vi.fn(async () => undefined) } as BridgeProcess;
    };
    const make = () => new AgentRuntime({ config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: root, RUNNER_WORKSPACE_DIR: root }),
      spawn: spawn as never, now: () => new Date("2026-09-29T10:00:00.000Z"), retrySleep: async () => undefined, retryRandom: () => 0.5 });
    const agent = make();
    try {
      await agent.ensureBridge();
      await agent.sessions.create({ context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "codex" }, cwd: "/w", mcpServers: [] });
      handlers[0]!.onSessionUpdate({ sessionId: "private-1", update: update([{ name: "review", description: "Review" }]) } as never);
      expect(agent.readiness().availableCommands).toBeUndefined();
      await agent.applyHostSettings({ ...DEFAULT_HOST_AGENT_SETTINGS, coreAcceptsRouteBilling: true });
      expect(agent.readiness()).toMatchObject({ availableCommands: [{ name: "review", description: "Review" }], availableCommandsLearntAt: "2026-09-29T10:00:00.000Z" });
    } finally { await agent.stop(); }
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, AVAILABLE_COMMANDS_FILE), "utf8")).commands).toHaveLength(1));
    const restarted = make();
    try {
      await restarted.start().catch(() => undefined);
      await restarted.applyHostSettings({ ...DEFAULT_HOST_AGENT_SETTINGS, coreAcceptsRouteBilling: true });
      expect(restarted.readiness().availableCommands).toEqual([{ name: "review", description: "Review" }]);
    } finally { await restarted.stop(); }
  });
});
