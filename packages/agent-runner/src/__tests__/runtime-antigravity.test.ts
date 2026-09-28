import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { fetchedAgentPlatformPin } from "@konteks/remote-release";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import { ANTIGRAVITY_LICENCE_REASON } from "../bridge/process.js";
import { ANTIGRAVITY_SESSION_META, antigravityRuntimePaths } from "../host/antigravity.js";
import type { RunnerEvent } from "../events.js";

/**
 * Google Antigravity's runtime (CP2), against a scripted bridge: the tool
 * filter on every session, `default` mode only, the working copy's AGENTS.md
 * in the prompt, the process ceiling and its queue, the idle control
 * process, and failures the server only prints or writes as a reply.
 */
const pinned = fetchedAgentPlatformPin("antigravity") !== undefined;

const MODEL = { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash-high",
  options: [{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" }] };
const MODE = { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "default",
  options: [{ value: "default", name: "Default" }, { value: "auto_edit", name: "Auto Edit" }, { value: "yolo", name: "YOLO" }] };
const INITIALIZE = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { embeddedContext: true } },
  agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.2.1" } };

type Fake = {
  input: SpawnBridgeOptions;
  bridge: BridgeProcess;
  connection: Record<string, ReturnType<typeof vi.fn>>;
  /** Feed a stderr line through the adapter's reading, as spawnBridge would. */
  stderr(line: string): void;
};

const roots: string[] = [], runtimes: AgentRuntime[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(options: { newSession?: (fake: Fake) => Promise<unknown>; prompt?: (fake: Fake, params: { sessionId: string }) => Promise<unknown>; limit?: number; bootstrapMs?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-antigravity-"))); roots.push(root);
  const spawned: Fake[] = [];
  let sessions = 0;
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    let exited = false;
    let fail: ((error: unknown) => void) | null = null;
    const failure = input.stderrFailure ? new Promise<never>((_resolve, reject) => { fail = reject; }) : undefined;
    void failure?.catch(() => undefined);
    const fake = {} as Fake;
    const connection = {
      newSession: vi.fn(async () => options.newSession ? options.newSession(fake) : ({ sessionId: `agy-${++sessions}`, configOptions: [MODEL, MODE], modes: { currentModeId: "default" } })),
      loadSession: vi.fn(async () => ({ configOptions: [MODEL, MODE] })),
      resumeSession: vi.fn(async () => ({ configOptions: [MODEL, MODE], modes: { currentModeId: "default" } })),
      prompt: vi.fn(async (params: { sessionId: string }) => options.prompt ? options.prompt(fake, params) : ({ stopReason: "end_turn" })),
      cancel: vi.fn(async () => undefined),
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(async ({ configId, value }: { configId: string; value: string }) => ({ configOptions: [{ ...MODEL, ...(configId === "model" ? { currentValue: value } : {}) }, { ...MODE, ...(configId === "mode" ? { currentValue: value } : {}) }] })),
    };
    const bridge: BridgeProcess = {
      get exited() { return exited; },
      initializeResult: INITIALIZE as never, stderrTail: () => [],
      ...(failure ? { failure } : {}),
      connection: connection as never,
      stop: vi.fn(async () => { if (!exited) { exited = true; input.handlers.onExit({ code: 0, signal: null }); } }),
    };
    Object.assign(fake, { input, bridge, connection, stderr: (line: string) => { const refusal = input.stderrFailure?.(line); if (refusal && fail) fail(refusal); } });
    spawned.push(fake);
    return bridge;
  });
  const folder = "/rt/agents/antigravity/1.2.1-darwin-arm64";
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "workspace"),
    RUNNER_BRIDGE_PREFIX: folder, RUNNER_BRIDGE_VERSION: "1.2.1", RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder,
    ...(options.bootstrapMs === undefined ? {} : { RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS: options.bootstrapMs }),
  });
  const events: RunnerEvent[] = [];
  const runtime = new AgentRuntime({ config, spawn, probe: async () => ({ kind: "signal", fingerprint: "fp-antigravity-0123456789" }), executionBridgeLimit: () => options.limit ?? 4 });
  runtime.events.subscribe(event => events.push(event));
  runtimes.push(runtime);
  const workingCopy = async (name: string, agents?: string) => {
    const wc = join(root, name);
    await mkdir(wc, { recursive: true });
    if (agents !== undefined) await writeFile(join(wc, "AGENTS.md"), agents);
    return wc;
  };
  const args = (cwd: string, assignment = `a-${cwd}`) => ({ context: { instanceId: "i", assignmentId: assignment, attempt: 1, agentId: "antigravity" }, cwd, mcpServers: [] });
  return { root, config, runtime, spawn, spawned, events, workingCopy, args, paths: antigravityRuntimePaths(config.RUNNER_CREDENTIAL_DIR) };
}

describe.runIf(pinned)("Google Antigravity's runtime (CP2)", () => {
  it("sends the tool filter on session/new, load and resume, and on model discovery", async () => {
    const f = await fixture();
    await f.runtime.start();
    const wc = await f.workingCopy("repo");
    const first = await f.runtime.sessions.create(f.args(wc));
    const created = f.spawned[1]!.connection.newSession.mock.calls[0]![0] as { _meta: Record<string, unknown> };
    expect(created._meta).toMatchObject({ ...ANTIGRAVITY_SESSION_META, konteksSession: expect.objectContaining({ version: 1 }) });
    // A restart restores the session in a fresh process: resumed, with the filter again.
    f.runtime.sessions.close(first.acpSessionRef);
    await f.runtime.stopExecutionBridge(first.acpSessionRef, { finalize: true });
    await f.runtime.sessions.restore(f.args(wc, "a-2"), first.acpSessionRef);
    const resumed = f.spawned.at(-1)!.connection.resumeSession.mock.calls[0]![0] as { sessionId: string; _meta: unknown };
    expect(resumed).toMatchObject({ sessionId: "agy-1", _meta: ANTIGRAVITY_SESSION_META });
    await f.runtime.discoverModelCapability("model");
    const discovery = f.spawned.at(-1)!.connection.newSession.mock.calls.at(-1)![0] as { _meta: unknown };
    expect(discovery._meta).toMatchObject(ANTIGRAVITY_SESSION_META);
  });

  it("prepares the private home before every process: settings, no trust file", async () => {
    const f = await fixture();
    await mkdir(join(f.paths.geminiHome, "antigravity-acp"), { recursive: true });
    await writeFile(f.paths.trustFile, "{\"trusted\":[\"/\"]}");
    await f.runtime.start();
    expect(await readFile(f.paths.settingsFile, "utf8")).toBe("{}\n");
    await expect(readFile(f.paths.trustFile)).rejects.toThrow();
    await writeFile(f.paths.trustFile, "{}");
    await f.runtime.sessions.create(f.args(await f.workingCopy("repo")));
    await expect(readFile(f.paths.trustFile)).rejects.toThrow();
  });

  it("refuses auto_edit and yolo, and never reports them", async () => {
    const f = await fixture();
    await f.runtime.start();
    await expect(f.runtime.sessions.create({ ...f.args(await f.workingCopy("repo-y")), sessionConfig: { mode: "yolo" } })).rejects.toMatchObject({ code: "permission_denied" });
    const created = await f.runtime.sessions.create(f.args(await f.workingCopy("repo")));
    f.runtime.sessions.setMode(created.acpSessionRef, "m1", { modeId: "auto_edit" });
    f.runtime.sessions.setConfigOption(created.acpSessionRef, "m2", { configId: "mode", value: "yolo" } as never);
    f.runtime.sessions.setConfigOption(created.acpSessionRef, "m3", { configId: "model", value: "gemini-3.1-pro-low" } as never);
    await vi.waitFor(() => expect(f.events.filter(event => event.kind === "request_error" || event.kind === "set_config_option_result")).toHaveLength(3));
    for (const id of ["m1", "m2"]) expect(f.events.find(event => event.kind === "request_error" && event.requestId === id)).toMatchObject({ class: "invalid_params", message: expect.stringContaining("default mode") });
    expect(f.spawned.at(-1)!.connection.setSessionMode).not.toHaveBeenCalled();
    const result = f.events.find(event => event.kind === "set_config_option_result") as { result: { configOptions: Array<{ id: string; options: Array<{ value: string }> }> } };
    expect(result.result.configOptions.find(option => option.id === "mode")!.options.map(option => option.value)).toEqual(["default"]);
  });

  it("never reads a session ready outside the default mode or without a model choice", async () => {
    const yolo = await fixture({ newSession: async () => ({ sessionId: "agy-x", configOptions: [MODEL, { ...MODE, currentValue: "yolo" }] }) });
    await yolo.runtime.start();
    await expect(yolo.runtime.sessions.create(yolo.args(await yolo.workingCopy("repo")))).rejects.toMatchObject({ code: "agent_unavailable", diagnostic: "antigravity_session_mode" });
    const bare = await fixture({ newSession: async () => ({ sessionId: "agy-y", configOptions: [] }) });
    await bare.runtime.start();
    await expect(bare.runtime.sessions.create(bare.args(await bare.workingCopy("repo")))).rejects.toMatchObject({ diagnostic: "antigravity_unsupported_version" });
  });

  it("puts the working copy's AGENTS.md in front of the first prompt only, and again after a resume only when it changed", async () => {
    const f = await fixture();
    await f.runtime.start();
    const wc = await f.workingCopy("repo", "End every reply with PINEAPPLE.\n");
    const created = await f.runtime.sessions.create(f.args(wc));
    const prompt = f.spawned[1]!.connection.prompt;
    const send = async (id: string, calls: ReturnType<typeof vi.fn>, ref = created.acpSessionRef) => {
      f.runtime.sessions.prompt(ref, id, { prompt: [{ type: "text", text: "hi" }] });
      await vi.waitFor(() => expect(f.events.some(event => event.kind === "prompt_result" && event.requestId === id)).toBe(true));
      return (calls.mock.calls.at(-1)![0] as { prompt: Array<{ type: string }> }).prompt;
    };
    const first = await send("p1", prompt);
    expect(first.map(block => block.type)).toEqual(["text", "resource", "text"]);
    expect(first[1]).toMatchObject({ resource: { text: "End every reply with PINEAPPLE.\n", mimeType: "text/markdown" } });
    expect((await send("p2", prompt)).map(block => block.type)).toEqual(["text"]);
    // Restored in a new process: the server kept the history, so unchanged means not sent again.
    f.runtime.sessions.close(created.acpSessionRef);
    await f.runtime.stopExecutionBridge(created.acpSessionRef, { finalize: true });
    const restored = await f.runtime.sessions.restore(f.args(wc, "a-2"), created.acpSessionRef);
    const next = f.spawned.at(-1)!.connection.prompt;
    expect((await send("p3", next, restored.acpSessionRef)).map(block => block.type)).toEqual(["text"]);
    await writeFile(join(wc, "AGENTS.md"), "End every reply with MANGO.\n");
    expect((await send("p4", next, restored.acpSessionRef)).map(block => block.type)).toEqual(["text", "resource", "text"]);
  });

  it("a session/new that would need the person (no licence) fails at once with the Business AI Code API reason", async () => {
    const f = await fixture({ newSession: async fake => { fake.stderr("W0928 business_auth.py:462] Configured project=p location=global has no available license; falling through to the license picker (b/558693144)."); return new Promise(() => undefined); } });
    await f.runtime.start();
    const started = Date.now();
    await expect(f.runtime.sessions.create(f.args(await f.workingCopy("repo")))).rejects.toMatchObject({ code: "agent_auth_required", message: ANTIGRAVITY_LICENCE_REASON });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.spawned[1]!.bridge.stop).toHaveBeenCalled();
    // Only one process tried: a missing licence is not retried on fresh ones.
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it("a turn that would open a sign-in page ends as needing sign-in, and the turn is cancelled", async () => {
    const f = await fixture({ prompt: async fake => { fake.stderr("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?x"); return new Promise(() => undefined); } });
    await f.runtime.start();
    const created = await f.runtime.sessions.create(f.args(await f.workingCopy("repo")));
    f.runtime.sessions.prompt(created.acpSessionRef, "p1", { prompt: [{ type: "text", text: "hi" }] });
    await vi.waitFor(() => expect(f.events.find(event => event.kind === "request_error" && event.requestId === "p1")).toMatchObject({ class: "agent_auth_required", message: expect.stringContaining("auth login antigravity") }));
    expect(f.spawned[1]!.connection.cancel).toHaveBeenCalled();
    expect(f.runtime.readiness().readiness).toBe("not_configured");
  });

  it("a quota failure written as the reply is a failed turn in plain words, and Google's text never leaves the runner", async () => {
    const f = await fixture({ prompt: async (fake, params) => {
      fake.input.handlers.onSessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 days, 23 hours." } } } as SessionNotification);
      return { stopReason: "refusal" };
    } });
    await f.runtime.start();
    const created = await f.runtime.sessions.create(f.args(await f.workingCopy("repo")));
    f.runtime.sessions.prompt(created.acpSessionRef, "p1", { prompt: [{ type: "text", text: "hi" }] });
    await vi.waitFor(() => expect(f.events.find(event => event.kind === "request_error" && event.requestId === "p1"))
      .toMatchObject({ class: "provider_failure", retryable: true, message: "Your Gemini quota for this period is used up. The session is kept and can continue once it resets." }));
    expect(f.events.some(event => event.kind === "prompt_result")).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain("Usage Limit Reached");
  });

  it("runs at most two sessions at once; a third waits for one to finish", async () => {
    const f = await fixture({ limit: 4 });
    await f.runtime.start();
    const a = await f.runtime.sessions.create(f.args(await f.workingCopy("repo-a")));
    await f.runtime.sessions.create(f.args(await f.workingCopy("repo-b")));
    let third: unknown = null;
    const waiting = f.runtime.sessions.create(f.args(await f.workingCopy("repo-c"))).then(value => { third = value; });
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(third).toBeNull();
    expect(f.spawn).toHaveBeenCalledTimes(3); // control + two sessions
    f.runtime.sessions.close(a.acpSessionRef);
    await f.runtime.stopExecutionBridge(a.acpSessionRef, { finalize: true });
    await waiting;
    expect(third).toMatchObject({ acpSessionRef: expect.any(String) });
    expect(f.spawn).toHaveBeenCalledTimes(4);
  });

  it("refuses a waiting session plainly once the wait is over", async () => {
    const f = await fixture();
    await f.runtime.start();
    await f.runtime.sessions.create(f.args(await f.workingCopy("repo-a")));
    await f.runtime.sessions.create(f.args(await f.workingCopy("repo-b")));
    const real = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    const third = f.runtime.sessions.create(f.args(await f.workingCopy("repo-c")));
    await new Promise(resolve => setTimeout(resolve, 300));
    offset = 121_000;
    await expect(third).rejects.toMatchObject({ code: "temporarily_unavailable", message: "Google Antigravity is already running 2 sessions on this computer. Try again when one of them finishes." });
  });

  it("stops the control process after a minute idle and keeps reading ready; it comes back for sign-out", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.runtime.start();
    const control = f.spawned[0]!;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(control.bridge.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(control.bridge.stop).toHaveBeenCalledOnce();
    expect(f.runtime.readiness()).toMatchObject({ readiness: "ready", connectionState: "ready", acpCapabilities: { sessionResume: true } });
    // Nothing respawned it on exit; a later need starts it again without reading unavailable.
    expect(f.spawn).toHaveBeenCalledTimes(1);
    await f.runtime.ensureBridge();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.events.filter(event => event.kind === "readiness_changed" && event.agent.connectionState !== "ready").map(event => (event as { agent: { connectionState: string } }).agent.connectionState)).toEqual(["starting"]);
  });

  it("gives a session bootstrap at least 30 s", async () => {
    let resolveSlow: ((value: unknown) => void) | null = null;
    const f = await fixture({ bootstrapMs: 10_000, newSession: () => new Promise(resolve => { resolveSlow = resolve; }) });
    await f.runtime.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let failed: unknown = null;
    const pending = f.runtime.sessions.create(f.args(await f.workingCopy("repo"))).catch(error => { failed = error; });
    while (!resolveSlow) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(failed).toBeNull();
    resolveSlow!({ sessionId: "agy-slow", configOptions: [MODEL, MODE] });
    await pending;
    expect(failed).toBeNull();
  });

  it("sweeps processes left with its private home when it stops", async () => {
    const f = await fixture();
    const { antigravityRunnerAdapter } = await import("../host/antigravity.js");
    const sweep = vi.spyOn(antigravityRunnerAdapter, "sweepLeftovers").mockResolvedValue(undefined);
    await f.runtime.start();
    await f.runtime.stop();
    expect(sweep).toHaveBeenCalledWith(f.config);
  });
});
