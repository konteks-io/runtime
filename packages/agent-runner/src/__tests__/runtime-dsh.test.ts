import { access, mkdtemp, rm } from "node:fs/promises";
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
      connection: { newSession: vi.fn(), prompt: vi.fn(), cancel: vi.fn(async () => undefined) } as never, stop: vi.fn(async () => undefined) };
    return bridge;
  });
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "workspace"),
    RUNNER_BRIDGE_PREFIX: "/opt/dsh", RUNNER_NATIVE_DSH_ROOT: "/opt/dsh", RUNNER_NATIVE_DSH_ENTRY: "/opt/dsh/lib/bin.js", RUNNER_NATIVE_DSH_NODE: "/opt/node/bin/node",
  });
  const runtime = new AgentRuntime({ config, spawn });
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
