import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../daemon.js";
import { EventLoopWatch, STALL_MS, TICK_MS } from "../event-loop-watch.js";
import { summariseRestarts } from "../state/restarts.js";
import { SupervisorStore } from "../state/store.js";
import { LIVENESS_CHECK_MS, LIVENESS_MIN_BUDGET_MS } from "../supervisor.js";
import { runDoctor } from "../support/doctor.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const doctorBase = (dir: string) => ({
  now: () => "2026-11-09T12:00:00.000Z",
  dataDir: dir,
  identity: { instanceId: "inst", administrativeStatus: "active" },
  lease: { mode: "active" as const, expiresAt: null },
  relay: { state: "offline", lastError: null, consecutiveFailures: 0 },
  transport: "relay" as const,
  reconciliationComplete: true,
  components: [],
  agents: [],
  configRevision: 1,
  diskFreeBytes: 1,
  minimumDiskBytes: 0,
  outboxDepth: 0,
  recoveryRequired: 0,
  coreSignatureConfigured: true,
});

describe("self-restarts", () => {
  it("pins the liveness and event-loop stall thresholds", () => {
    // AC4: the sensitivity and timing of both checks are untouched.
    expect(TICK_MS).toBe(1_000);
    expect(STALL_MS).toBe(2_000);
    expect(LIVENESS_CHECK_MS).toBe(30_000);
    expect(LIVENESS_MIN_BUDGET_MS).toBe(5 * 60_000);
  });

  it("names a liveness_lost restart after repeated stalls, where status and doctor said nothing before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kr-self-restarts-"));
    dirs.push(dir);

    // AC5: repeated native.event_loop.stalled warnings, then a liveness-lost exit.
    let now = 0;
    const warn = vi.fn();
    const watch = new EventLoopWatch({ warn } as never, { tickMs: TICK_MS, stallMs: STALL_MS, now: () => now });
    watch.start();
    for (let index = 0; index < 3; index += 1) {
      now += STALL_MS + TICK_MS;
      watch.tick(TICK_MS);
    }
    watch.stop();
    expect(warn).toHaveBeenCalledTimes(3);
    for (const call of warn.mock.calls) expect(call[0]).toMatchObject({ event: "native.event_loop.stalled", stalledMs: STALL_MS });

    const daemon = createDaemon({
      name: "self-restarts",
      onStart: async () => undefined,
      signalSource: new EventEmitter(),
      shutdownSteps: () => [],
      recordNonzeroExit: reason => new SupervisorStore(dir).recordLastExit(reason),
    });
    await daemon.start();
    await daemon.shutdown("liveness-lost", 1);

    // The service manager started a new process; it reads the same private folder.
    const restarted = new SupervisorStore(dir);
    expect(await restarted.lastExit()).toMatchObject({ reason: "liveness_lost" });
    const summary = summariseRestarts(await restarted.exitLedger(), Date.now());
    expect(summary).toMatchObject({ countLastHour: 1, latest: { reason: "liveness_lost" }, repeating: false });

    const report = await runDoctor({ ...doctorBase(dir), restarts: summary });
    const check = report.checks.find(entry => entry.id === "self-restarts");
    expect(check).toMatchObject({ status: "pass" });
    expect(check?.detail).toContain("1 self-restart in the last hour");
    expect(check?.detail).toContain("it lost its heartbeat");
  });
});
