import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RetainedProcessOwner } from "@konteks/remote-common";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { IdentityProbe } from "../auth/identity.js";
import { AgentScopeStore } from "../auth/scope-store.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import { RequestError } from "@agentclientprotocol/sdk";

vi.mock("../auth/login-flow.js", () => ({ runLogout: vi.fn(async () => ({ code: 0 })), startLoginFlow: vi.fn() }));

/**
 * The measured cost: every ACP session paid a bridge spawn plus `initialize`
 * (~47 s on the pinned Claude bridge) because qualified finalization killed
 * the process. An idle sealed release now keeps the healthy process resident
 * for the next reference; everything that is not that release still stops it.
 */
type ExecutionBridge = BridgeProcess & { retainedProcessOwner: RetainedProcessOwner };
interface Owner { bridge: ExecutionBridge; handlers: SpawnBridgeOptions["handlers"] }

const roots: string[] = [], runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const retainedOwner = (pid: number): RetainedProcessOwner =>
  ({ version: 1, platform: "darwin", pid, processGroupId: pid, startToken: `start-${pid}`, commandDigest: "A".repeat(43) });
const modelOptions = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] }];

async function fixture(options: { limit?: number; ttlMs?: number; now?: () => Date; modelCapabilityTtlMs?: number; probe?: () => Promise<IdentityProbe>;
  newSessionFails?: () => boolean | Error; closeSession?: () => Promise<object> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "execution-pool-")); roots.push(root);
  const owners: Owner[] = [];
  let sessions = 0;
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    const pid = 1000 + owners.length;
    const selectedConfig = new Map<string, string>();
    const bridge: ExecutionBridge = {
      exited: false,
      initializeResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
      stderrTail: () => [],
      retainedProcessOwner: retainedOwner(pid),
      connection: {
        // A reused process hands out a fresh private id per `session/new`.
        newSession: vi.fn(async () => {
          const failure = options.newSessionFails?.();
          if (failure instanceof Error) throw failure;
          if (failure) throw new Error("session/new refused");
          sessions += 1; return { sessionId: `private-${pid}-${sessions}`, configOptions: modelOptions }; }),
        prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
        cancel: vi.fn(async () => undefined),
        closeSession: vi.fn(options.closeSession ?? (async () => ({}))),
        setSessionConfigOption: vi.fn(async ({ configId, value }: { configId: string; value: string }) => {
          selectedConfig.set(configId, value);
          return { configOptions: [...selectedConfig].map(([id, currentValue]) => ({
            id, name: id, type: "select" as const, currentValue,
            options: [{ value: currentValue, name: currentValue }],
          })) };
        }),
      } as never,
      // A real stop handle resolves only once the process is observed exited.
      stop: vi.fn(async () => { Object.defineProperty(bridge, "exited", { value: true }); }),
    };
    // The real spawn hands the exact stop handle over before ACP initialize.
    await input.onProcessOwner?.(bridge);
    owners.push({ bridge, handlers: input.handlers });
    return bridge;
  });
  const runtime = new AgentRuntime({
    config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: root, RUNNER_WORKSPACE_DIR: root }),
    spawn, executionBridgeLimit: () => options.limit ?? 1,
    probe: options.probe ?? (async () => ({ kind: "signal" as const, fingerprint: "opaque-identity-fingerprint" })),
    ...(options.ttlMs === undefined ? {} : { idleExecutionBridgeTtlMs: options.ttlMs }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.modelCapabilityTtlMs === undefined ? {} : { modelCapabilityTtlMs: options.modelCapabilityTtlMs }),
  });
  runtimes.push(runtime);
  await runtime.ensureBridge();
  const recordProcessOwner = vi.fn(async (_owner: RetainedProcessOwner) => undefined);
  const lifecycle = { beforeCreate: async () => undefined, recordProcessOwner, assertCurrent: () => undefined };
  const input = { context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "codex" }, cwd: root, mcpServers: [], lifecycle };
  const execution = () => owners[1]!;
  return { root, runtime, owners, spawn, recordProcessOwner, input, execution };
}

/** Exactly the supervisor's idle-sealed release: a settled turn, sealed, released, finalized. */
async function completeAndRelease(f: Awaited<ReturnType<typeof fixture>>, ref: string) {
  f.runtime.sessions.prompt(ref, `turn-${ref}`, { prompt: [] });
  await f.runtime.sessions.sealCompletedTurn(ref);
  await f.runtime.sessions.releaseSealed(ref);
  return f.runtime.releaseExecutionBridge(ref);
}

it("serves the next reference from the resident process with no second spawn or initialize", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(2); // control + one execution process
  const process = f.execution().bridge;
  expect(f.recordProcessOwner).toHaveBeenCalledTimes(1);
  await expect(completeAndRelease(f, first.acpSessionRef)).resolves.toEqual({ retained: true });
  expect(process.stop).not.toHaveBeenCalled();

  const second = await f.runtime.sessions.create(f.input);
  expect(second.acpSessionRef).not.toBe(first.acpSessionRef);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(process.connection.newSession).toHaveBeenCalledTimes(2);
  // The durable owner record is per reference: the same identity, recorded again.
  expect(f.recordProcessOwner).toHaveBeenCalledTimes(2);
  expect(f.recordProcessOwner.mock.calls[1]![0]).toEqual(process.retainedProcessOwner);

  // The finalized predecessor still resolves to its own retained owner, and
  // stopping it must never reach the process the successor now owns.
  await expect(f.runtime.stopExecutionBridge(first.acpSessionRef)).resolves.toBeUndefined();
  expect(process.stop).not.toHaveBeenCalled();

  f.runtime.sessions.prompt(second.acpSessionRef, "second-turn", { prompt: [] });
  expect(process.connection.prompt).toHaveBeenCalledTimes(2);
  // Callback authority is the process object: its exit closes exactly the
  // sessions bound to it, which is now the successor.
  const seen: unknown[] = []; f.runtime.events.subscribe(event => seen.push(event));
  f.execution().handlers.onExit({ code: 0, signal: null });
  expect(seen).toContainEqual({ kind: "session_exited", acpSessionRef: second.acpSessionRef, reason: "agent_exited" });
  expect(f.runtime.utilization().activeSessions).toBe(0);
});

it("returns the capacity slot on the idle release exactly as a stop-proven finalization does", async () => {
  const f = await fixture({ limit: 1 });
  const first = await f.runtime.sessions.create(f.input);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  await completeAndRelease(f, first.acpSessionRef);
  await f.runtime.sessions.create(f.input);
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  await expect(f.runtime.stopExecutionBridge("never-owned")).rejects.toThrow(/Unknown native execution bridge owner/);
});

it("still stops the process on a recovery stop and keeps nothing resident", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  await f.runtime.sessions.stopForRecovery(first.acpSessionRef);
  await f.runtime.stopExecutionBridge(first.acpSessionRef);
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
  // The slot stays held; no resident process could serve a new reference.
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
  await f.runtime.stopExecutionBridge(first.acpSessionRef, { finalize: true });
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
});

it("still stops the process on a close finalization that carries no idleness proof", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  f.runtime.sessions.close(first.acpSessionRef);
  await f.runtime.stopExecutionBridge(first.acpSessionRef, { finalize: true });
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
});

it("stops the resident process on an authentication change instead of handing it to the next login", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  await f.runtime.logout();
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
  expect(f.owners[0]!.bridge.stop).toHaveBeenCalledOnce();
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(4); // control, execution, control again, execution again
});

it("stops the resident process when the runtime stops", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  await f.runtime.stop();
  runtimes.splice(runtimes.indexOf(f.runtime), 1);
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
});

it("drops the resident process when its exit is observed", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  Object.defineProperty(f.execution().bridge, "exited", { value: true });
  f.execution().handlers.onExit({ code: 1, signal: null });
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(f.execution().bridge.connection.newSession).toHaveBeenCalledTimes(1);
});

it("expires a resident process nobody reused within the idle lifetime", async () => {
  const f = await fixture({ ttlMs: 20 });
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  await vi.waitFor(() => expect(f.execution().bridge.stop).toHaveBeenCalledOnce());
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
});

it("keeps one resident process per runtime and stops a second release as before", async () => {
  const f = await fixture({ limit: 2 });
  const first = await f.runtime.sessions.create(f.input), second = await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  await expect(completeAndRelease(f, first.acpSessionRef)).resolves.toEqual({ retained: true });
  await expect(completeAndRelease(f, second.acpSessionRef)).resolves.toEqual({ retained: false });
  expect(f.owners[1]!.bridge.stop).not.toHaveBeenCalled();
  expect(f.owners[2]!.bridge.stop).toHaveBeenCalledOnce();
});

it("stops a resident process whose durable owner cannot be recorded for the new reference", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  const failing = { ...f.input, lifecycle: { ...f.input.lifecycle, recordProcessOwner: vi.fn(async () => { throw new Error("journal unavailable"); }) } };
  const spawnsBefore = f.spawn.mock.calls.length;
  await expect(f.runtime.sessions.create(failing)).rejects.toThrow("journal unavailable");
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
  expect(f.execution().bridge.connection.newSession).toHaveBeenCalledTimes(1);
  // The resident is stopped once; the remaining bootstrap attempts spawn
  // fresh processes, each stopped in turn, and every failed owner is finalized.
  expect(f.spawn.mock.calls.length).toBe(spawnsBefore + 3);
  for (const owner of f.owners.slice(spawnsBefore)) expect(owner.bridge.stop).toHaveBeenCalledOnce();
  // An exhausted bootstrap releases its slot rather than holding it forever.
  const recovered = await f.runtime.sessions.create(f.input);
  expect(recovered.acpSessionRef).toBeTruthy();
});

it("answers the model capability probe from the resident process and keeps it resident", async () => {
  const f = await fixture();
  await f.runtime.probe(false);
  expect(f.runtime.readiness().readiness).toBe("ready");
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  await expect(f.runtime.discoverModelCapability("model")).resolves.toMatchObject({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] });
  await expect(f.runtime.discoverModelCapability("model")).resolves.toMatchObject({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  const process = f.execution().bridge;
  expect(process.connection.newSession).toHaveBeenCalledTimes(2);
  // The released session, then the probe's own session: neither stays open on the resident process.
  expect(process.connection.closeSession).toHaveBeenCalledTimes(2);
  expect(process.connection.closeSession).toHaveBeenLastCalledWith({ sessionId: "private-1001-2" });
  expect(process.stop).not.toHaveBeenCalled();
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(2);
});

it("spawns a throwaway probe process only when nothing is resident", async () => {
  const f = await fixture();
  await f.runtime.probe(false);
  await expect(f.runtime.discoverModelCapability("model")).resolves.toMatchObject({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.owners[1]!.bridge.stop).toHaveBeenCalledOnce();
});

it("reads the identity again when a discovery fails for good, so readiness stops saying ready", async () => {
  let signedIn = true;
  let refuse = false;
  const f = await fixture({
    probe: async () => signedIn ? { kind: "signal", fingerprint: "opaque-identity-fingerprint" } : { kind: "logged_out" },
    newSessionFails: () => refuse,
  });
  await f.runtime.probe(false);
  expect(f.runtime.readiness().readiness).toBe("ready");
  const refresh = vi.spyOn(f.runtime, "probe");
  let releaseWrite!: () => void;
  const writable = new Promise<void>(resolve => { releaseWrite = resolve; });
  let writeFinished = false;
  const originalWrite = AgentScopeStore.prototype.write;
  const write = vi.spyOn(AgentScopeStore.prototype, "write").mockImplementation(async function (this: AgentScopeStore, state) {
    await writable;
    await originalWrite.call(this, state);
    writeFinished = true;
  });
  try {
    // Its sign-in went away outside Konteks (its home cleared): every session is refused.
    signedIn = false;
    refuse = true;
    await expect(f.runtime.discoverModelCapability("model")).rejects.toThrow();
    await vi.waitFor(() => expect(f.runtime.readiness()).toMatchObject({ readiness: "not_configured", recoveryAction: "login_locally" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(false, false, { fresh: true });
    // Readiness is visible before persistence settles; fixture teardown must join that exact probe.
    expect(writeFinished).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    releaseWrite();
    await refresh.mock.results[0]!.value;
    expect(writeFinished).toBe(true);
  } finally {
    releaseWrite();
    try { await refresh.mock.results[0]?.value; }
    finally {
      write.mockRestore();
      refresh.mockRestore();
    }
  }
});

it("re-reads the offered models once the discovery TTL has passed", async () => {
  let now = Date.parse("2026-09-27T00:00:00Z");
  const f = await fixture({ now: () => new Date(now), modelCapabilityTtlMs: 60_000 });
  await f.runtime.probe(false);
  await f.runtime.discoverModelCapability("model");
  await f.runtime.discoverModelCapability("model");
  expect(f.spawn).toHaveBeenCalledTimes(2);
  now += 60_000;
  // Past the TTL the last answer is served at once, with its true age, while it is read again.
  await expect(f.runtime.discoverModelCapability("model")).resolves.toMatchObject({ currentValue: "sonnet", observedAgoMs: 60_000 });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(3));
  await vi.waitFor(async () => expect((await f.runtime.discoverModelCapability("model")).observedAgoMs).toBeUndefined());
  expect(f.spawn).toHaveBeenCalledTimes(3);
});

it("closes each released session on the reused process, so it never accumulates agent sessions (2026-10-02 leak)", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  const process = f.execution().bridge;
  await expect(completeAndRelease(f, first.acpSessionRef)).resolves.toEqual({ retained: true });
  expect(process.connection.closeSession).toHaveBeenLastCalledWith({ sessionId: "private-1001-1" });
  const second = await f.runtime.sessions.create(f.input);
  await expect(completeAndRelease(f, second.acpSessionRef)).resolves.toEqual({ retained: true });
  expect(process.connection.closeSession).toHaveBeenLastCalledWith({ sessionId: "private-1001-2" });
  expect(process.connection.closeSession).toHaveBeenCalledTimes(2);
  expect(f.runtime.sessions.sessionsBoundTo(process)).toBe(0);
  expect(process.stop).not.toHaveBeenCalled();
});

it("stops and finalizes the process instead of keeping it when the agent does not confirm the close", async () => {
  const f = await fixture({ closeSession: async () => { throw new Error("close refused"); } });
  const first = await f.runtime.sessions.create(f.input);
  const process = f.execution().bridge;
  await expect(completeAndRelease(f, first.acpSessionRef)).resolves.toEqual({ retained: false });
  expect(process.stop).toHaveBeenCalledOnce();
  // Finalized: the slot is free and the next session starts a fresh process.
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(process.connection.newSession).toHaveBeenCalledOnce();
});

it("keeps serving the last offered models after a refresh fails for a transient reason", async () => {
  let now = Date.parse("2026-10-02T00:00:00Z");
  let fail: Error | false = false;
  const f = await fixture({ now: () => new Date(now), modelCapabilityTtlMs: 60_000, newSessionFails: () => fail });
  await f.runtime.probe(false);
  await f.runtime.discoverModelCapability("model");
  now += 90_000;
  fail = new Error("loaded computer");
  const kept = await f.runtime.discoverModelCapability("model");
  expect(kept).toMatchObject({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"], observedAgoMs: 90_000 });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(f.owners[2]!.bridge.stop).toHaveBeenCalled());
  // The failed refresh dropped nothing: the same answer, older, starting one new refresh at a time.
  now += 10_000;
  await expect(f.runtime.discoverModelCapability("model")).resolves.toMatchObject({ currentValue: "sonnet", observedAgoMs: 100_000 });
  await expect(f.runtime.discoverModelCapability("model")).resolves.toMatchObject({ currentValue: "sonnet" });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(4));
  expect(f.runtime.readiness().readiness).toBe("ready");
  fail = false;
  await vi.waitFor(async () => {
    await f.runtime.discoverModelCapability("model");
    expect((await f.runtime.discoverModelCapability("model")).observedAgoMs).toBeUndefined();
  });
});

it("drops the last offered models when a refresh is definitely refused", async () => {
  let now = Date.parse("2026-10-02T00:00:00Z");
  let fail: Error | false = false;
  const f = await fixture({ now: () => new Date(now), modelCapabilityTtlMs: 60_000, newSessionFails: () => fail });
  await f.runtime.probe(false);
  await f.runtime.discoverModelCapability("model");
  now += 90_000;
  fail = new RequestError(-32602, "Invalid params");
  await f.runtime.discoverModelCapability("model");
  await vi.waitFor(() => expect(f.owners[2]?.bridge.stop).toHaveBeenCalled());
  // Still signed in, but nothing is kept: the next read is a discovery of its own, and it fails.
  await vi.waitFor(async () => {
    const spawned = f.spawn.mock.calls.length;
    await expect(f.runtime.discoverModelCapability("model")).rejects.toThrow();
    expect(f.spawn.mock.calls.length).toBe(spawned + 1);
  });
  expect(f.runtime.readiness().readiness).toBe("ready");
});

it("drops the last offered models when a refresh says the agent needs signing in", async () => {
  let now = Date.parse("2026-10-02T00:00:00Z");
  let fail: Error | false = false;
  const f = await fixture({ now: () => new Date(now), modelCapabilityTtlMs: 60_000, newSessionFails: () => fail });
  await f.runtime.probe(false);
  await f.runtime.discoverModelCapability("model");
  now += 90_000;
  fail = new RequestError(-32000, "Authentication required");
  await f.runtime.discoverModelCapability("model");
  await vi.waitFor(() => expect(f.owners[2]?.bridge.stop).toHaveBeenCalled());
  // Nothing is kept now: the next read is a discovery of its own, and it fails.
  await vi.waitFor(async () => {
    const spawned = f.spawn.mock.calls.length;
    await expect(f.runtime.discoverModelCapability("model")).rejects.toThrow();
    expect(f.spawn.mock.calls.length).toBe(spawned + 1);
  });
});

it("refuses a restart-only retained stop for an identity live under a current owner and yields an idle one", async () => {
  const f = await fixture();
  const first = await f.runtime.sessions.create(f.input);
  const identity = f.execution().bridge.retainedProcessOwner;
  await expect(f.runtime.yieldRetainedProcess(identity)).rejects.toThrow(/live under a current local owner/);
  await completeAndRelease(f, first.acpSessionRef);
  const second = await f.runtime.sessions.create(f.input);
  // The predecessor's finalized record carries the same identity; the
  // successor's live ownership is what refuses the signal.
  await expect(f.runtime.yieldRetainedProcess(identity)).rejects.toThrow(/live under a current local owner/);
  await completeAndRelease(f, second.acpSessionRef);
  await f.runtime.yieldRetainedProcess(identity);
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
  await f.runtime.yieldRetainedProcess(retainedOwner(7));
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(3);
});

it("retries the unfinished stop of a fenced execution's process instead of refusing its retained stop for good", async () => {
  // The fenced owner keeps its capacity slot (no qualified finalization), so the live one needs a second.
  const f = await fixture({ limit: 2 });
  const first = await f.runtime.sessions.create(f.input);
  const process = f.execution().bridge;
  const stop = process.stop as ReturnType<typeof vi.fn>;
  const exit = stop.getMockImplementation()!;
  // A loaded computer: the recovery stop's process stop does not finish in time.
  stop.mockImplementationOnce(async () => { throw new Error("Bridge process exit remains unconfirmed."); });
  await f.runtime.sessions.stopForRecovery(first.acpSessionRef).catch(() => undefined);
  await expect(f.runtime.stopExecutionBridge(first.acpSessionRef)).rejects.toThrow("exit remains unconfirmed");
  stop.mockImplementation(exit);
  await expect(f.runtime.yieldRetainedProcess(process.retainedProcessOwner)).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(process.exited).toBe(true);
  // A live owner is still never signalled.
  const second = await f.runtime.sessions.create(f.input);
  expect(second.acpSessionRef).toBeTruthy();
  await expect(f.runtime.yieldRetainedProcess(f.owners.at(-1)!.bridge.retainedProcessOwner)).rejects.toThrow(/live under a current local owner/);
});
