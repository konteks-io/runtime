import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { RemoteInstanceError, stopRetainedProcessOwner } from "@konteks/remote-common";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import type { RunnerEvent } from "../events.js";
import { readDshApiKey } from "../auth/dsh-key.js";
import { dshRuntimePaths } from "../bridge/dsh-profile.js";

vi.mock("@konteks/remote-common", async importOriginal => ({
  ...await importOriginal<typeof import("@konteks/remote-common")>(),
  stopRetainedProcessOwner: vi.fn(async () => undefined),
}));

beforeEach(() => { vi.mocked(stopRetainedProcessOwner).mockReset().mockResolvedValue(undefined); });

const KEY = "sk-0123456789abcdef0123456789abcdef";
const roots: string[] = [], runtimes: AgentRuntime[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(options: { failFirstExecution?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-dsh-"))); roots.push(root);
  const spawned: SpawnBridgeOptions[] = [], bridges: BridgeProcess[] = [], stops: Array<BridgeProcess["stop"]> = [];
  const histories = new Map<string, string>(), operations: string[] = [];
  const policies: Array<{ path: string; contents: string | null }> = [], stoppedPolicies: Array<string | null> = [];
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    spawned.push(input);
    const path = join(dirname(input.spec.args.at(-1)!), "read-policy.json");
    policies.push({ path, contents: await readFile(path, "utf8").catch(() => null) });
    const index = spawned.length - 1;
    const pid = 50_000 + spawned.length;
    const active = new Set<string>();
    let exited = false, stopping: Promise<void> | null = null;
    const bridge: BridgeProcess = {
      get exited() { return exited; },
      retainedProcessOwner: { version: 1, platform: "darwin", pid, processGroupId: pid,
        startToken: `fixture-${pid}`, commandDigest: "A".repeat(43) },
      initializeResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } },
      stderrTail: () => [],
      connection: { newSession: vi.fn(async ({ cwd }: { cwd: string }) => {
        histories.set(`private-${pid}`, cwd);
        active.add(`private-${pid}`);
        return { sessionId: `private-${pid}` };
      }), resumeSession: vi.fn(async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        operations.push(`resume-${pid}`);
        if (active.has(sessionId)) throw RequestError.invalidParams(undefined, `session is already active: ${sessionId}`);
        if (histories.get(sessionId) !== cwd) throw RequestError.invalidParams(undefined, `session cwd does not match: ${cwd}`);
        active.add(sessionId);
        return {};
      }), closeSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        operations.push(`close-${pid}`);
        active.delete(sessionId);
        return {};
      }),
        prompt: vi.fn(async () => ({ stopReason: "end_turn" })), cancel: vi.fn(async () => undefined) } as never,
      stop: vi.fn(() => {
        stopping ??= (async () => {
          stoppedPolicies[index] = await readFile(path, "utf8").catch(() => null);
          operations.push(`stop-${pid}`);
          active.clear();
          exited = true;
          input.handlers.onExit({ code: 0, signal: null });
        })();
        return stopping;
      }),
    };
    bridges.push(bridge);
    stops.push(bridge.stop);
    await input.onProcessOwner?.(bridge);
    if (options.failFirstExecution && spawned.length === 2) throw new Error("fixture ACP initialization failed");
    return bridge;
  });
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "workspace"),
    RUNNER_BRIDGE_PREFIX: "/opt/dsh", RUNNER_NATIVE_DSH_ROOT: "/opt/dsh", RUNNER_NATIVE_DSH_ENTRY: "/opt/dsh/lib/bin.js", RUNNER_NATIVE_DSH_NODE: "/opt/node/bin/node",
  });
  const runtime = new AgentRuntime({ config, spawn, executionBridgeLimit: () => 2, retrySleep: async () => undefined });
  runtimes.push(runtime);
  const events: RunnerEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  const directory = async (name: string) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return path;
  };
  const session = (cwd: string, readOnlyRoots: readonly string[] = []) => runtime.sessions.create({
    context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "dsh" }, cwd, readOnlyRoots, mcpServers: [],
  });
  return { root, config, runtime, spawn, spawned, bridges, stops, policies, stoppedPolicies, operations, events, directory, session, paths: dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR) };
}

async function completeAndRelease(runtime: AgentRuntime, ref: string) {
  runtime.sessions.prompt(ref, `turn-${ref}`, { prompt: [] });
  await runtime.sessions.sealCompletedTurn(ref);
  await runtime.sessions.releaseSealed(ref);
  return runtime.releaseExecutionBridge(ref);
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
  const first = f.bridges[0]!;
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

it("binds the selected leaf roots and working copy before the execution child starts", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy");
  const selected = await f.directory("skills/selected-leaf");
  const peer = await f.directory("skills/peer-leaf");
  const readOnlyRoots = [selected];
  await f.session(cwd, readOnlyRoots);
  readOnlyRoots.push(peer);
  const controlPolicyDir = join(f.paths.dshHome, "profiles", "konteks-control-policy");
  expect(f.policies[0]!.path).toBe(join(controlPolicyDir, "read-policy.json"));
  expect(JSON.parse(f.policies[0]!.contents!)).toEqual({
    cwd: join(f.paths.dshHome, "konteks-control-workspace"), readOnlyRoots: [],
  });
  expect(f.spawned[0]!.spec.args.at(-1)).toBe(join(controlPolicyDir, "read-fence.patch.yml"));
  expect(f.spawned[0]!.spec.env.DSH_BUNDLED_SKILL_DIR).toBeUndefined();
  expect(f.spawned[1]!.spec.args).not.toContain(join(controlPolicyDir, "read-fence.patch.yml"));
  expect(JSON.parse(f.policies[1]!.contents!)).toEqual({ cwd, readOnlyRoots: [selected] });
  expect(f.spawned[1]!.spec.cwd).toBe(cwd);
  expect(f.spawned[1]!.spec.args).toContain("--from-default-profile");
  expect(f.spawned[1]!.spec.args.at(-1)).toBe(join(dirname(f.policies[1]!.path), "read-fence.patch.yml"));
  expect(f.spawned[1]!.spec.env.DSH_BUNDLED_SKILL_DIR).toBeUndefined();
  expect(f.bridges[0]!.connection.newSession).not.toHaveBeenCalled();
  expect(f.bridges[1]!.connection.newSession).toHaveBeenCalledOnce();
});

it("starts a direct DSH session in its own folder without selected skill roots", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("direct-session");
  await f.runtime.sessions.create({ context: { instanceId: "i", assignmentId: "direct", attempt: 1, agentId: "dsh" },
    cwd, readOnlyRoots: [], mcpServers: [], agentTitled: true,
  });
  expect(JSON.parse(f.policies[1]!.contents!)).toEqual({ cwd, readOnlyRoots: [] });
  expect(f.spawned[1]!.spec.cwd).toBe(cwd);
  expect(f.bridges[1]!.connection.newSession).toHaveBeenCalledWith(expect.objectContaining({
    cwd, mcpServers: [], _meta: { konteksSession: { version: 1, prefix: "[konteks]" } },
  }));
});

it("never reuses a released DSH child and removes only its owned profile after exit", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), selected = await f.directory("skills/selected-leaf");
  const first = await f.session(cwd, [selected]);
  await expect(completeAndRelease(f.runtime, first.acpSessionRef)).resolves.toEqual({ retained: false });
  expect(f.bridges[1]!.connection.closeSession).toHaveBeenCalledOnce();
  expect(f.stops[1]).toHaveBeenCalledOnce();
  expect(stopRetainedProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner);
  expect(f.bridges[1]!.exited).toBe(true);
  await vi.waitFor(async () => expect(await access(f.policies[1]!.path).then(() => true, () => false)).toBe(false));
  expect(f.stops[0]).not.toHaveBeenCalled();
  await access(join(f.paths.konteksDir, "konteks-dsh.patch.yml"));
  const second = await f.session(cwd, [selected]);
  expect(second.acpSessionRef).not.toBe(first.acpSessionRef);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.policies[2]!.path).not.toBe(f.policies[1]!.path);
  expect(JSON.parse(f.policies[2]!.contents!)).toEqual({ cwd, readOnlyRoots: [selected] });
});

it("restores saved provider history in a fresh child with the current selected roots", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), priorSkill = await f.directory("skills/prior-leaf"), currentSkill = await f.directory("skills/current-leaf");
  const prior = await f.session(cwd, [priorSkill]);
  await completeAndRelease(f.runtime, prior.acpSessionRef);
  const restored = await f.runtime.sessions.restore({
    context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" }, cwd, readOnlyRoots: [currentSkill], mcpServers: [],
  }, prior.acpSessionRef);
  expect(restored).toMatchObject({ resumed: true });
  expect(restored.acpSessionRef).not.toBe(prior.acpSessionRef);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.policies[2]!.path).not.toBe(f.policies[1]!.path);
  expect(JSON.parse(f.policies[2]!.contents!)).toEqual({ cwd, readOnlyRoots: [currentSkill] });
  expect(f.bridges[2]!.connection.resumeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "private-50002", cwd }));
  expect(f.bridges[2]!.connection.newSession).not.toHaveBeenCalled();
});

it("keeps trusted roots and durable ownership through failed-initialize child replacement", async () => {
  const f = await fixture({ failFirstExecution: true });
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), selected = await f.directory("skills/selected-leaf");
  const recordProcessOwner = vi.fn(async () => undefined), replaceProcessOwner = vi.fn(async () => undefined);
  await expect(f.runtime.sessions.create({
    context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "dsh" }, cwd, readOnlyRoots: [selected], mcpServers: [],
    lifecycle: { beforeCreate: async () => undefined, recordProcessOwner, replaceProcessOwner, assertCurrent: () => undefined },
  })).resolves.toMatchObject({ resumed: false });
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.stops[1]).toHaveBeenCalledOnce();
  expect(f.bridges[1]!.exited).toBe(true);
  expect(f.bridges[1]!.connection.newSession).not.toHaveBeenCalled();
  expect(JSON.parse(f.stoppedPolicies[1]!)).toEqual({ cwd, readOnlyRoots: [selected] });
  expect(f.bridges[2]!.connection.newSession).toHaveBeenCalledOnce();
  expect(recordProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner);
  expect(replaceProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner, f.bridges[2]!.retainedProcessOwner);
  expect(f.policies[2]!.path).not.toBe(f.policies[1]!.path);
  expect(f.policies.slice(1).map(policy => JSON.parse(policy.contents!))).toEqual([
    { cwd, readOnlyRoots: [selected] }, { cwd, readOnlyRoots: [selected] },
  ]);
  await vi.waitFor(async () => expect(await access(f.policies[1]!.path).then(() => true, () => false)).toBe(false));
});

it("continues an unchanged canonical root set on the same DSH child", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), a = await f.directory("skills/a"), b = await f.directory("skills/b");
  const first = await f.session(cwd, [a, b]);
  f.runtime.sessions.prompt(first.acpSessionRef, "p1", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  await expect(f.runtime.sessions.continueLive({
    context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" }, cwd, readOnlyRoots: [b, a, a],
    mcpServers: [], acpSessionRef: first.acpSessionRef,
    lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, assertCurrent: () => undefined },
  })).resolves.toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.stops[1]).not.toHaveBeenCalled();
  expect(f.bridges[1]!.connection.resumeSession).toHaveBeenCalledWith({ sessionId: "private-50002", cwd, mcpServers: [] });
  expect(f.bridges[1]!.connection.closeSession).toHaveBeenCalledOnce();
  expect(f.operations).toEqual(["resume-50002", "close-50002", "resume-50002"]);
  expect(JSON.parse(f.policies[1]!.contents!)).toEqual({ cwd, readOnlyRoots: [a, b] });
});

it.each([
  { name: "changed selected root", workingCopy: "working-copy", selected: ["current-leaf"] },
  { name: "removed selected roots", workingCopy: "working-copy", selected: [] },
])("replaces the DSH child and continues history with current authority: $name", async vector => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), priorSkill = await f.directory("skills/prior-leaf");
  const recordProcessOwner = vi.fn(async () => undefined), replaceProcessOwner = vi.fn(async () => undefined);
  const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner, replaceProcessOwner, assertCurrent: () => undefined };
  const first = await f.runtime.sessions.create({ context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "dsh" },
    cwd, readOnlyRoots: [priorSkill], mcpServers: [], lifecycle,
  });
  f.runtime.sessions.prompt(first.acpSessionRef, "p1", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  const nextCwd = await f.directory(vector.workingCopy);
  const readOnlyRoots = await Promise.all(vector.selected.map(name => f.directory(`skills/${name}`)));
  const expectedRoots = [...readOnlyRoots];
  const peer = await f.directory("skills/peer-leaf");
  let markReserved!: () => void, releaseGate!: () => void;
  const reserved = new Promise<void>(resolve => { markReserved = resolve; });
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const continuing = f.runtime.sessions.continueLive({ context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" },
    cwd: nextCwd, readOnlyRoots, mcpServers: [], acpSessionRef: first.acpSessionRef,
    lifecycle: { ...lifecycle, beforeCreate: async () => { markReserved(); await gate; } },
  });
  await reserved;
  readOnlyRoots.push(peer);
  releaseGate();
  await expect(continuing).resolves.toMatchObject({ acpSessionRef: first.acpSessionRef, resumed: true });
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.stops[1]).toHaveBeenCalledOnce();
  expect(f.bridges[1]!.exited).toBe(true);
  expect(JSON.parse(f.stoppedPolicies[1]!)).toEqual({ cwd, readOnlyRoots: [priorSkill] });
  expect(replaceProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner, f.bridges[2]!.retainedProcessOwner);
  expect(stopRetainedProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner);
  expect(JSON.parse(f.policies[2]!.contents!)).toEqual({ cwd: nextCwd, readOnlyRoots: expectedRoots });
  expect(f.spawned[2]!.spec.cwd).toBe(nextCwd);
  expect(f.bridges[2]!.connection.newSession).not.toHaveBeenCalled();
  expect(f.bridges[2]!.connection.resumeSession).toHaveBeenCalledWith({ sessionId: "private-50002", cwd: nextCwd, mcpServers: [] });
  expect(f.bridges[1]!.connection.resumeSession).not.toHaveBeenCalled();
  expect(f.operations).toEqual(["close-50002", "stop-50002", "resume-50003"]);
  expect(f.runtime.utilization().activeSessions).toBe(1);
  expect(f.events.filter(event => event.kind === "session_exited")).toEqual([]);
  await vi.waitFor(async () => expect(await access(f.policies[1]!.path).then(() => true, () => false)).toBe(false));
  f.runtime.sessions.prompt(first.acpSessionRef, "p2", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  expect(f.bridges[2]!.connection.prompt).toHaveBeenCalledOnce();
  expect(f.bridges[1]!.connection.prompt).toHaveBeenCalledOnce();
});

it("retains the old DSH profile and refuses continuation when its child stop is unconfirmed", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), prior = await f.directory("skills/prior-leaf"), next = await f.directory("skills/next-leaf");
  const first = await f.session(cwd, [prior]);
  f.runtime.sessions.prompt(first.acpSessionRef, "p1", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  const old = f.bridges[1]!, stop = old.stop;
  const replaceProcessOwner = vi.fn(async () => undefined);
  old.stop = vi.fn(async () => { throw new Error("fixture child stop is unconfirmed"); });
  try {
    await expect(f.runtime.sessions.continueLive({ context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" },
      cwd, readOnlyRoots: [next], mcpServers: [], acpSessionRef: first.acpSessionRef,
      lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, replaceProcessOwner, assertCurrent: () => undefined },
    })).rejects.toMatchObject({ code: "recovery_required", diagnostic: "file_authority_rebind_stop_unconfirmed" });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(old.exited).toBe(false);
    expect(JSON.parse(await readFile(f.policies[1]!.path, "utf8"))).toEqual({ cwd, readOnlyRoots: [prior] });
    expect(old.connection.resumeSession).not.toHaveBeenCalled();
    expect(replaceProcessOwner).not.toHaveBeenCalled();
    await expect(f.runtime.sessions.continueLive({ context: { instanceId: "i", assignmentId: "retry", attempt: 1, agentId: "dsh" },
      cwd, readOnlyRoots: [prior], mcpServers: [], acpSessionRef: first.acpSessionRef,
    })).rejects.toMatchObject({ code: "recovery_required" });
  } finally { old.stop = stop; }
});

it("retains the DSH binding when independent owned-group absence cannot be established", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), prior = await f.directory("skills/prior-leaf"), next = await f.directory("skills/next-leaf");
  const first = await f.session(cwd, [prior]);
  f.runtime.sessions.prompt(first.acpSessionRef, "p1", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  vi.mocked(stopRetainedProcessOwner).mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "fixture process observation is unavailable"));
  const replaceProcessOwner = vi.fn(async () => undefined);
  await expect(f.runtime.sessions.continueLive({ context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" },
    cwd, readOnlyRoots: [next], mcpServers: [], acpSessionRef: first.acpSessionRef,
    lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, replaceProcessOwner, assertCurrent: () => undefined },
  })).rejects.toMatchObject({ code: "recovery_required", diagnostic: "file_authority_rebind_stop_unconfirmed" });
  expect(stopRetainedProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.policies[1]!.path, "utf8"))).toEqual({ cwd, readOnlyRoots: [prior] });
  expect(f.bridges[1]!.connection.resumeSession).not.toHaveBeenCalled();
  expect(replaceProcessOwner).not.toHaveBeenCalled();
  expect(f.runtime.utilization().activeSessions).toBe(1);
});

it("stops the old DSH group but refuses a new child when history close fails", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), prior = await f.directory("skills/prior-leaf"), next = await f.directory("skills/next-leaf");
  const first = await f.session(cwd, [prior]);
  f.runtime.sessions.prompt(first.acpSessionRef, "p1", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  vi.mocked(f.bridges[1]!.connection.closeSession).mockRejectedValueOnce(new Error("fixture history flush failed"));
  const replaceProcessOwner = vi.fn(async () => undefined);
  await expect(f.runtime.sessions.continueLive({ context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" },
    cwd, readOnlyRoots: [next], mcpServers: [], acpSessionRef: first.acpSessionRef,
    lifecycle: { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined, replaceProcessOwner, assertCurrent: () => undefined },
  })).rejects.toMatchObject({ code: "recovery_required", diagnostic: "file_authority_rebind_stop_unconfirmed" });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.stops[1]).toHaveBeenCalledOnce();
  expect(f.bridges[1]!.exited).toBe(true);
  await expect(access(f.policies[1]!.path)).rejects.toThrow();
  expect(f.bridges[1]!.connection.resumeSession).not.toHaveBeenCalled();
  expect(replaceProcessOwner).not.toHaveBeenCalled();
});

it("reports lost provider history when a replacement tries to resume under a different real cwd", async () => {
  const f = await fixture();
  await f.runtime.start();
  const cwd = await f.directory("working-copy"), nextCwd = await f.directory("next-copy"), selected = await f.directory("skills/selected-leaf");
  const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner: async () => undefined,
    replaceProcessOwner: vi.fn(async () => undefined), assertCurrent: () => undefined };
  const first = await f.runtime.sessions.create({ context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "dsh" },
    cwd, readOnlyRoots: [selected], mcpServers: [], lifecycle,
  });
  f.runtime.sessions.prompt(first.acpSessionRef, "p1", { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(first.acpSessionRef);
  await expect(f.runtime.sessions.continueLive({ context: { instanceId: "i", assignmentId: "next", attempt: 1, agentId: "dsh" },
    cwd: nextCwd, readOnlyRoots: [selected], mcpServers: [], acpSessionRef: first.acpSessionRef, lifecycle,
  })).rejects.toMatchObject({ code: "recovery_required", diagnostic: "agent_session_lost" });
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.stops[1]).toHaveBeenCalledOnce();
  expect(f.bridges[1]!.exited).toBe(true);
  expect(JSON.parse(f.policies[2]!.contents!)).toEqual({ cwd: nextCwd, readOnlyRoots: [selected] });
  expect(f.bridges[2]!.connection.resumeSession).toHaveBeenCalledWith({ sessionId: "private-50002", cwd: nextCwd, mcpServers: [] });
  expect(f.bridges[2]!.connection.newSession).not.toHaveBeenCalled();
  expect(lifecycle.replaceProcessOwner).toHaveBeenCalledWith(f.bridges[1]!.retainedProcessOwner, f.bridges[2]!.retainedProcessOwner);
});
