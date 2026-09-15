import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RetainedProcessOwner } from "@konteks/remote-common";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";

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

async function fixture(options: { limit?: number; ttlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "execution-pool-")); roots.push(root);
  const owners: Owner[] = [];
  let sessions = 0;
  const spawn = vi.fn(async (input: SpawnBridgeOptions) => {
    const pid = 1000 + owners.length;
    const bridge: ExecutionBridge = {
      exited: false,
      initializeResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
      stderrTail: () => [],
      retainedProcessOwner: retainedOwner(pid),
      connection: {
        // A reused process hands out a fresh private id per `session/new`.
        newSession: vi.fn(async () => { sessions += 1; return { sessionId: `private-${pid}-${sessions}`, configOptions: modelOptions }; }),
        prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
        cancel: vi.fn(async () => undefined),
        closeSession: vi.fn(async () => ({})),
      } as never,
      stop: vi.fn(async () => undefined),
    };
    // The real spawn hands the exact stop handle over before ACP initialize.
    await input.onProcessOwner?.(bridge);
    owners.push({ bridge, handlers: input.handlers });
    return bridge;
  });
  const runtime = new AgentRuntime({
    config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: root, RUNNER_WORKSPACE_DIR: root }),
    spawn, executionBridgeLimit: () => options.limit ?? 1,
    probe: async () => ({ kind: "signal" as const, fingerprint: "opaque-identity-fingerprint" }),
    ...(options.ttlMs === undefined ? {} : { idleExecutionBridgeTtlMs: options.ttlMs }),
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
  f.runtime.sessions.releaseSealed(ref);
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
  await expect(f.runtime.sessions.create(failing)).rejects.toThrow("journal unavailable");
  expect(f.execution().bridge.stop).toHaveBeenCalledOnce();
  expect(f.execution().bridge.connection.newSession).toHaveBeenCalledTimes(1);
  // A rejected bootstrap retains its slot exactly as a rejected spawn does.
  await expect(f.runtime.sessions.create(f.input)).rejects.toThrow();
});

it("answers the model capability probe from the resident process and keeps it resident", async () => {
  const f = await fixture();
  await f.runtime.probe(false);
  expect(f.runtime.readiness().readiness).toBe("ready");
  const first = await f.runtime.sessions.create(f.input);
  await completeAndRelease(f, first.acpSessionRef);
  await expect(f.runtime.discoverModelCapability("model")).resolves.toEqual({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  const process = f.execution().bridge;
  expect(process.connection.newSession).toHaveBeenCalledTimes(2);
  expect(process.connection.closeSession).toHaveBeenCalledOnce();
  expect(process.stop).not.toHaveBeenCalled();
  await f.runtime.sessions.create(f.input);
  expect(f.spawn).toHaveBeenCalledTimes(2);
});

it("spawns a throwaway probe process only when nothing is resident", async () => {
  const f = await fixture();
  await f.runtime.probe(false);
  await expect(f.runtime.discoverModelCapability("model")).resolves.toEqual({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.owners[1]!.bridge.stop).toHaveBeenCalledOnce();
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
