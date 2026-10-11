import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Logger } from "@konteks/remote-common";
import { AgentRuntime } from "../runtime.js";
import { RunnerConfigSchema } from "../config.js";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";

/**
 * D64: a busy connector refused a new session's bridge at once, 35 ms into
 * attempt 1 of 4, as `recovery_required` with no diagnostic, and the turn
 * ended interrupted/not_resumable. A full execution ceiling is transient:
 * a claimed session waits for a free slot with backoff instead.
 */
const roots: string[] = [], runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function recordingLogger(): { logger: Logger; lines: Array<{ fields: Record<string, unknown>; msg: string }> } {
  const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  const write = (fields: Record<string, unknown>, msg: string) => { lines.push({ fields, msg }); };
  const logger = { warn: write, info: write, error: write, debug: write, trace: write, fatal: write } as Record<string, unknown>;
  logger.child = () => logger;
  return { logger: logger as unknown as Logger, lines };
}

async function fixture(retrySleep: (delayMs: number) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "slot-wait-")); roots.push(root);
  const spawn = vi.fn(async (_input: SpawnBridgeOptions) => {
    const bridge: BridgeProcess = { exited: false, initializeResult: { protocolVersion: 1 }, stderrTail: () => [],
      connection: { newSession: vi.fn(async () => ({ sessionId: `private-${spawn.mock.calls.length}` })), prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
        cancel: vi.fn(async () => undefined), setSessionConfigOption: vi.fn(async ({ configId, value }: { configId: string; value: string }) => ({
          configOptions: [{ id: configId, name: configId, type: "select" as const, currentValue: value, options: [{ value, name: value }] }] })) } as never,
      stop: vi.fn(async () => undefined) };
    return bridge;
  });
  const { logger, lines } = recordingLogger();
  const runtime = new AgentRuntime({ config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: root, RUNNER_WORKSPACE_DIR: root }),
    spawn, logger, executionBridgeLimit: () => 1, retrySleep, retryRandom: () => 0.5 });
  runtimes.push(runtime); await runtime.ensureBridge();
  const input = { context: { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "codex" }, cwd: root, mcpServers: [] };
  return { runtime, spawn, lines, input };
}

const claimed = (assertCurrent: () => void = () => undefined) => ({ beforeCreate: async () => undefined, assertCurrent });

it("waits for a free execution process with exponential backoff and no attempt cap while the claim is current", async () => {
  const delays: number[] = [];
  const slot: { free?: () => Promise<void> } = {};
  const f = await fixture(async delayMs => { delays.push(delayMs); if (delays.length === 6) await slot.free!(); });
  const first = await f.runtime.sessions.create({ ...f.input, lifecycle: claimed() });
  slot.free = () => f.runtime.stopExecutionBridge(first.acpSessionRef, { finalize: true });

  const second = await f.runtime.sessions.create({ ...f.input, lifecycle: claimed() });

  expect(second.acpSessionRef).not.toBe(first.acpSessionRef);
  expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000]);
  expect(f.spawn).toHaveBeenCalledTimes(3); // Control, first, and the second once a slot was free.
  const waits = f.lines.filter(line => line.fields.recovery === "free_slot");
  expect(waits).toHaveLength(6);
  expect(waits[0]!.fields).toMatchObject({ bootstrapAttempt: 1, slotWait: 1, limit: 1, held: 1, delayMs: 500,
    errorCode: "recovery_required", diagnostic: "execution_capacity_full" });
  expect(f.lines.some(line => line.msg === "bootstrap bridge initialization failed")).toBe(false);
  expect(f.lines.find(line => line.msg === "bootstrap bridge initialized" && line.fields.acpSessionRef === second.acpSessionRef)?.fields)
    .toMatchObject({ bootstrapAttempt: 1 });
});

it("stops waiting when the claim is no longer current", async () => {
  let current = true;
  const f = await fixture(async () => { current = false; });
  await f.runtime.sessions.create({ ...f.input, lifecycle: claimed() });
  const lost = new Error("claim moved");

  await expect(f.runtime.sessions.create({ ...f.input, lifecycle: claimed(() => { if (!current) throw lost; }) })).rejects.toBe(lost);
  expect(f.spawn).toHaveBeenCalledTimes(2);
});

it("refuses a full ceiling at once, naming it, when no claim can end a wait", async () => {
  const retrySleep = vi.fn(async () => undefined);
  const f = await fixture(retrySleep);
  await f.runtime.sessions.create(f.input);

  await expect(f.runtime.sessions.create(f.input)).rejects.toMatchObject({ code: "recovery_required", diagnostic: "execution_capacity_full" });
  expect(retrySleep).not.toHaveBeenCalled();
  expect(f.lines.find(line => line.msg === "bootstrap bridge initialization failed")?.fields)
    .toMatchObject({ retryable: false, exhausted: true, diagnostic: "execution_capacity_full" });
});
