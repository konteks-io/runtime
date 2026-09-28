import { lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import { openCodeRuntimePaths, openCodeWorkingCopyConfig } from "../host/opencode.js";

const roots: string[] = [], runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const MODELS = { id: "model", name: "Model", type: "select", currentValue: "opencode/muse-spark-1.3-contributor-free",
  options: [{ value: "opencode/muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 (free)" }, { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }] };

async function fixture(options: { limit?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-opencode-"))); roots.push(root);
  const spawned: Array<{ env: NodeJS.ProcessEnv; linked: string | null; bridge: BridgeProcess }> = [];
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    const configHome = input.spec.env.XDG_CONFIG_HOME!;
    const linked = await readlink(join(configHome, "opencode", "AGENTS.md")).catch(() => null);
    let exited = false;
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    const bridge: BridgeProcess = {
      get exited() { return exited; },
      initializeResult: { protocolVersion: 1, agentCapabilities: {} }, stderrTail: () => [],
      connection: { newSession: vi.fn(async () => ({ sessionId: `oc-${spawned.length}`, configOptions: [MODELS] })), prompt, cancel: vi.fn(async () => undefined) } as never,
      stop: vi.fn(async () => { if (!exited) { exited = true; input.handlers.onExit({ code: 0, signal: null }); } }),
    };
    spawned.push({ env: input.spec.env, linked, bridge });
    return bridge;
  });
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "workspace"),
    RUNNER_BRIDGE_PREFIX: "/opt/opencode/bin", RUNNER_BRIDGE_VERSION: "2.0.18", RUNNER_NATIVE_OPENCODE_BINARY: "/opt/opencode/bin/opencode",
  });
  const runtime = new AgentRuntime({ config, spawn, probe: async () => ({ kind: "signal", fingerprint: "fp-opencode-0123456789" }),
    ...(options.limit === false ? {} : { executionBridgeLimit: () => 4 }) });
  runtimes.push(runtime);
  const workingCopy = async (name: string, agents?: string) => {
    const wc = join(root, name);
    await mkdir(wc, { recursive: true });
    if (agents !== undefined) await writeFile(join(wc, "AGENTS.md"), agents);
    return wc;
  };
  const session = (cwd: string) => runtime.sessions.create({ context: { instanceId: "i", assignmentId: `a-${cwd}`, attempt: 1, agentId: "opencode" }, cwd, mcpServers: [] });
  return { root, config, runtime, spawn, spawned, workingCopy, session, paths: openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR) };
}

it("runs the control process without a working copy and each session in its own working copy's process", async () => {
  const f = await fixture();
  await f.runtime.start();
  expect(f.spawned[0]!.env.XDG_CONFIG_HOME).toBe(f.paths.controlConfig);
  expect(f.spawned[0]!.linked).toBeNull();

  const a = await f.workingCopy("repo-a", "Reply in French.");
  const b = await f.workingCopy("repo-b");
  await f.session(a);
  await f.session(b);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  // The link existed before the process started, and only for the copy that has an AGENTS.md.
  expect(f.spawned[1]!.env.XDG_CONFIG_HOME).toBe(openCodeWorkingCopyConfig(f.config.RUNNER_CREDENTIAL_DIR, a));
  expect(f.spawned[1]!.linked).toBe(join(a, "AGENTS.md"));
  expect(f.spawned[2]!.env.XDG_CONFIG_HOME).toBe(openCodeWorkingCopyConfig(f.config.RUNNER_CREDENTIAL_DIR, b));
  expect(f.spawned[2]!.linked).toBeNull();
  for (const { env } of f.spawned) expect(env).toMatchObject({ HOME: f.paths.home, XDG_DATA_HOME: f.paths.data, OPENCODE_CONFIG_PROJECT_DISABLE: "1" });
});

it("never parks a working copy's process for another session, and removes its folder with the process", async () => {
  const f = await fixture();
  await f.runtime.start();
  const a = await f.workingCopy("repo-a", "rules");
  const created = await f.session(a);
  const folder = openCodeWorkingCopyConfig(f.config.RUNNER_CREDENTIAL_DIR, a);
  await expect(f.runtime.releaseExecutionBridge(created.acpSessionRef)).resolves.toEqual({ retained: false });
  expect(f.spawned[1]!.bridge.stop).toHaveBeenCalled();
  await vi.waitFor(async () => expect(await lstat(folder).then(() => true, () => false)).toBe(false));
  // The next session on the same working copy gets a fresh process and a fresh link.
  await f.session(a);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.spawned[2]!.linked).toBe(join(a, "AGENTS.md"));
});

it("re-checks the working copy's instructions before each prompt", async () => {
  const f = await fixture();
  await f.runtime.start();
  const a = await f.workingCopy("repo-a", "rules");
  const created = await f.session(a);
  const link = join(openCodeWorkingCopyConfig(f.config.RUNNER_CREDENTIAL_DIR, a), "opencode", "AGENTS.md");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  await rm(join(a, "AGENTS.md"));
  f.runtime.sessions.prompt(created.acpSessionRef, "p1", { prompt: [{ type: "text", text: "hi" }] });
  const prompt = (f.spawned[1]!.bridge.connection as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt;
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  await expect(lstat(link)).rejects.toThrow();
});

it("discovers models on a control process, never a working copy's", async () => {
  const f = await fixture();
  await f.runtime.start();
  const result = await f.runtime.discoverModelCapability("model");
  expect(result.currentValue).toBe("opencode/muse-spark-1.3-contributor-free");
  expect(result.offeredValues).toEqual(["opencode/muse-spark-1.3-contributor-free", "anthropic/claude-sonnet-4-5"]);
  expect(f.spawned.at(-1)!.env.XDG_CONFIG_HOME).toBe(f.paths.controlConfig);
});

it("refuses to run OpenCode sessions on the control process", async () => {
  await expect(fixture({ limit: false })).rejects.toThrow(/its own working copy/);
});
