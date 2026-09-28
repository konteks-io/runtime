import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import type { RunnerEvent } from "../events.js";
import { readDshApiKey } from "../auth/dsh-key.js";
import { dshRuntimePaths } from "../bridge/dsh-profile.js";

const KEY = "sk-0123456789abcdef0123456789abcdef";
const roots: string[] = [], runtimes: AgentRuntime[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-dsh-")); roots.push(root);
  const spawned: SpawnBridgeOptions[] = [];
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    spawned.push(input);
    const bridge: BridgeProcess = { exited: false, initializeResult: { protocolVersion: 1 }, stderrTail: () => [],
      connection: { newSession: vi.fn(async () => ({ sessionId: `private-${spawned.length}` })), prompt: vi.fn(), cancel: vi.fn(async () => undefined) } as never, stop: vi.fn(async () => undefined) };
    return bridge;
  });
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "workspace"),
    RUNNER_BRIDGE_PREFIX: "/opt/dsh", RUNNER_NATIVE_DSH_ROOT: "/opt/dsh", RUNNER_NATIVE_DSH_ENTRY: "/opt/dsh/lib/bin.js", RUNNER_NATIVE_DSH_NODE: "/opt/node/bin/node",
  });
  const runtime = new AgentRuntime({ config, spawn, executionBridgeLimit: () => 2 });
  runtimes.push(runtime);
  const events: RunnerEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  return { root, config, runtime, spawn, spawned, events, paths: dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR) };
}

it("writes the Konteks overlay before dsh first starts, and is signed out until a key is stored", async () => {
  const f = await fixture();
  await f.runtime.start();
  for (const name of ["konteks-dsh.patch.yml", "konteks-dsh-ask.patch.yml", "konteks-hooks.json"]) await access(join(f.paths.konteksDir, name));
  expect(f.spawned[0]!.spec.command).toBe("/opt/node/bin/node");
  expect(f.spawned[0]!.spec.args).toContain(join(f.paths.konteksDir, "konteks-dsh-ask.patch.yml"));
  expect(f.runtime.readiness().readiness).not.toBe("ready");
});

it("signs in with a DeepSeek key checked against DeepSeek, then restarts dsh to use it; sign-out removes it", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  await f.runtime.start();
  const flow = f.runtime.startLogin({ organization: false, personal: true });
  expect(f.events.some(event => event.kind === "login_event" && event.event.type === "prompt" && event.event.secret)).toBe(true);
  expect(f.runtime.loginInput(flow.loginId, KEY)).toBe(true);
  await expect(flow.done).resolves.toEqual({ code: 0 });
  await vi.waitFor(() => expect(f.events.some(event => event.kind === "login_event" && event.event.type === "completed")).toBe(true));
  expect(await readDshApiKey(f.paths.credentialsFile)).toBe(KEY);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.events)).not.toContain(KEY);
  const signedIn = f.runtime.readiness();
  expect(signedIn.authIdentityFingerprint).toBeDefined();

  await f.runtime.logout();
  expect(await readDshApiKey(f.paths.credentialsFile)).toBeNull();
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.runtime.readiness().authIdentityFingerprint).toBeUndefined();
});

it("takes dsh out of service after a governance bypass: bridges stop, readiness drops, nothing new starts", async () => {
  const f = await fixture();
  await f.runtime.start();
  const first = await f.spawn.mock.results[0]!.value as BridgeProcess;
  await f.runtime.quarantine("DeepSeek Harness ran a tool without asking Konteks first.");
  expect(first.stop).toHaveBeenCalled();
  expect(f.runtime.readiness().readiness).toBe("unavailable");
  expect(f.events.some(event => event.kind === "readiness_changed" && event.agent.connectionState === "failed")).toBe(true);
  await expect(f.runtime.ensureBridge()).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/without asking/) });
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it("rewrites the Konteks overlay before every dsh process it spawns, so a changed copy heals", async () => {
  const f = await fixture();
  await f.runtime.start();
  const hooks = join(f.paths.konteksDir, "konteks-hooks.json");
  const good = await readFile(hooks, "utf8");
  await writeFile(hooks, "{ this is not json");
  await f.runtime.sessions.create({ context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "dsh" }, cwd: join(f.root, "workspace"), mcpServers: [] });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(await readFile(hooks, "utf8")).toBe(good);
});
