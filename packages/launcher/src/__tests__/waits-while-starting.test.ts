import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError, type ConnectorAvailability } from "@konteks/remote-common";
import { NativeAvailability, type AvailabilityProbe } from "../native/availability.js";
import { waitWhileStarting } from "../native/commands.js";

const unavailable = () => new RemoteInstanceError("control_socket_unavailable", "cannot reach the supervisor control socket");
const olderConnector = () => new RemoteInstanceError("temporarily_unavailable", "control_request_invalid: request does not match the closed control protocol");

/** A connector's own answer; a test names only what it changes. */
function answer(overrides: Partial<ConnectorAvailability> = {}): ConnectorAvailability {
  return {
    available: false,
    phase: "starting",
    reason: { code: "startup_in_progress", message: "startup has not finished yet, and no attempt has failed" },
    expectedReturn: { kind: "unknown", why: "no startup attempt has failed yet, so its five-minute bound has not started counting" },
    liveness: { state: "unknown", quietMs: null },
    heartbeat: { state: "unknown", lastAttemptAt: null, lastSettledAt: null, budgetMs: null },
    relay: { state: "unknown", lastConnectedAt: null },
    ...overrides,
  };
}

const runningProbe = (answers: ConnectorAvailability[], running = true): AvailabilityProbe => {
  let index = 0;
  return {
    read: async () => answers[Math.min(index++, answers.length - 1)]!,
    running: async () => running,
  };
};

const output = () => {
  const lines: string[] = [];
  return { lines, value: { line: (text: string) => lines.push(text), setupLocale: "en" as const } };
};

const noSleep = async (): Promise<void> => undefined;

describe("a command run while the connector cannot take work", () => {
  it("drives one computer through starting, recovering, draining and liveness lost, reporting each reason", async () => {
    const at = "2026-11-09T12:05:00.000Z";
    const states = [
      answer({ phase: "starting", reason: { code: "startup_recovery_pending", message: "startup recovery has not completed" }, expectedReturn: { kind: "at", at, basis: "startup_recovery_bound" } }),
      answer({ phase: "recovering", reason: { code: "startup_recovery_bound_exceeded", message: "startup recovery passed its five-minute bound" } }),
      answer({ phase: "draining", reason: { code: "drain_in_progress", message: "it is draining (update), with 1 active assignment(s)" }, expectedReturn: { kind: "unknown", why: "this drain has no deadline" } }),
      answer({ phase: "liveness_lost", reason: { code: "liveness_lost", message: "the process stopped answering its heartbeat watchdog and is being restarted" } }),
      answer({ available: true, phase: null, reason: null }),
    ];
    let index = 0;
    let now = 0;
    const out = output();
    const probe: AvailabilityProbe = { read: async () => states[Math.min(index++, states.length - 1)]!, running: async () => true };
    const deps = { sleep: async ms => { now += ms; }, now: () => now };
    // The first call waits through starting and recovering, and stops at draining.
    expect((await waitWhileStarting({ availability: probe, output: out.value }, deps)).phase).toBe("draining");
    expect((await waitWhileStarting({ availability: probe, output: out.value }, deps)).phase).toBe("liveness_lost");
    expect((await waitWhileStarting({ availability: probe, output: out.value }, deps)).available).toBe(true);
    expect(out.lines.map(line => line.match(/\(([^)]+)\)/)?.[1])).toEqual(["starting", "recovering", "draining", "liveness lost"]);
    expect(out.lines[0]).toContain("startup recovery has not completed");
    expect(out.lines[0]).toContain(`by ${at}`);
    expect(out.lines[1]).toContain("startup recovery passed its five-minute bound");
    expect(out.lines[1]).toContain("not known");
    expect(out.lines[2]).toContain("it is draining (update)");
    expect(out.lines[3]).toContain("stopped answering its heartbeat watchdog");
  });

  it("waits through starting and reports the reason and the expected return once", async () => {
    const at = "2026-11-09T12:05:00.000Z";
    const starting = answer({ expectedReturn: { kind: "at", at, basis: "startup_recovery_bound" } });
    const ordered = [starting, starting, answer({ available: true, phase: null, reason: null })];
    let index = 0;
    let now = 0;
    const out = output();
    const read = vi.fn(async () => ordered[Math.min(index++, ordered.length - 1)]!);
    const result = await waitWhileStarting({ availability: { read, running: async () => true }, output: out.value },
      { sleep: async ms => { now += ms; }, now: () => now });
    expect(result.available).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(out.lines).toEqual([`Konteks cannot take work on this computer yet (starting): ${starting.reason!.message}. It should be able to take work by ${at}.`]);
  });

  it("reports recovering with an explicit unknown return rather than a generic starting message", async () => {
    const recovering = answer({
      phase: "recovering",
      reason: { code: "startup_recovery_bound_exceeded", message: "startup recovery passed its five-minute bound and is still retrying" },
      expectedReturn: { kind: "unknown", why: "this drain has no deadline" },
    });
    const out = output();
    let now = 0;
    await waitWhileStarting({ availability: runningProbe([recovering]), output: out.value },
      { sleep: async ms => { now += ms; }, now: () => now, waitMs: 6_000 });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("(recovering)");
    expect(out.lines[0]).toContain("startup recovery passed its five-minute bound");
    expect(out.lines[0]).toContain("When it can take work is not known");
    expect(out.lines[0]).not.toContain("still starting");
  });

  it("reports draining with its deadline and does not wait for the drain to end", async () => {
    const draining = answer({
      phase: "draining",
      reason: { code: "drain_in_progress", message: "it is draining (update) before 2026-11-09T12:01:00.000Z, with 2 active assignment(s)" },
      expectedReturn: { kind: "at", at: "2026-11-09T12:01:00.000Z", basis: "drain_deadline" },
    });
    const sleep = vi.fn(noSleep);
    const out = output();
    const result = await waitWhileStarting({ availability: runningProbe([draining]), output: out.value }, { sleep, now: () => 0 });
    expect(result.phase).toBe("draining");
    expect(sleep).not.toHaveBeenCalled();
    expect(out.lines[0]).toContain("(draining)");
    expect(out.lines[0]).toContain("before 2026-11-09T12:01:00.000Z");
  });

  it("reports liveness lost from this computer's own files when the control channel cannot be reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "kr-waits-"));
    try {
      await mkdir(join(root, "supervisor"), { recursive: true });
      await writeFile(join(root, "supervisor", "last-exit.json"), JSON.stringify({ schemaVersion: 1, reason: "liveness_lost", occurredAt: "2026-11-09T11:36:06.000Z" }));
      const out = output();
      const availability = new NativeAvailability({ control: { call: async () => { throw unavailable(); } } as never, root, running: async () => false });
      const result = await waitWhileStarting({ availability, output: out.value }, { sleep: noSleep, now: () => 0 });
      expect(result.phase).toBe("liveness_lost");
      expect(result.reason).toMatchObject({ code: "liveness_lost" });
      expect(out.lines[0]).toContain("(liveness lost)");
      expect(out.lines[0]).toContain("lost its heartbeat at 2026-11-09T11:36:06.000Z");
      expect(out.lines[0]).toContain("When it can take work is not known");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reports a structured reason when an older connector refuses availability.status", async () => {
    const root = await mkdtemp(join(tmpdir(), "kr-waits-"));
    try {
      await mkdir(join(root, "supervisor"), { recursive: true });
      await writeFile(join(root, "supervisor", "service-start-failure.json"), JSON.stringify({ at: "2026-11-09T11:50:00.000Z", message: "the service manager did not start this connector" }));
      const asked: string[] = [];
      const availability = new NativeAvailability({
        control: { call: async (request: { op: string }) => { asked.push(request.op); throw olderConnector(); } } as never,
        root,
        running: async () => false,
      });
      const out = output();
      const result = await waitWhileStarting({ availability, output: out.value }, { sleep: noSleep, now: () => 0 });
      expect(asked).toContain("availability.status");
      expect(result.phase).toBe("degraded");
      expect(result.reason).toMatchObject({ code: "service_start_failed" });
      expect(out.lines[0]).toContain("(degraded)");
      expect(out.lines[0]).toContain("its service could not start");
      expect(out.lines[0]).toContain("When it can take work is not known");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a read-only command answer once the connector says why, without waiting for recovery", async () => {
    const starting = answer({
      phase: "starting",
      reason: { code: "startup_recovery_pending", message: "startup recovery has not completed" },
      expectedReturn: { kind: "at", at: "2026-11-09T12:05:00.000Z", basis: "startup_recovery_bound" },
    });
    const sleep = vi.fn(noSleep);
    const out = output();
    const result = await waitWhileStarting({ availability: runningProbe([starting]), output: out.value }, { sleep, now: () => 0, waitForWork: false });
    expect(result.phase).toBe("starting");
    expect(sleep).not.toHaveBeenCalled();
    expect(out.lines[0]).toContain("startup recovery has not completed");
  });

  it("keeps a read-only command waiting while the control channel itself is missing", async () => {
    const missing = answer({ reason: { code: "control_socket_unavailable", message: "its control socket on this computer did not answer" } });
    let now = 0;
    const out = output();
    await waitWhileStarting({ availability: runningProbe([missing]), output: out.value },
      { sleep: async ms => { now += ms; }, now: () => now, waitMs: 6_000, waitForWork: false });
    expect(now).toBe(6_000);
    expect(out.lines[0]).toContain("control socket on this computer did not answer");
  });

  it("does not wait for a stopped connector, nor past its limit", async () => {
    const stopped = answer({ phase: "liveness_lost", reason: { code: "service_stopped", message: "its service is not running on this computer" } });
    const sleep = vi.fn(noSleep);
    const out = output();
    await waitWhileStarting({ availability: runningProbe([stopped]), output: out.value }, { sleep, now: () => 0 });
    expect(sleep).not.toHaveBeenCalled();
    expect(out.lines).toHaveLength(1);

    let now = 0;
    const starting = answer();
    const probe = runningProbe([starting]);
    await waitWhileStarting({ availability: probe, output: output().value },
      { sleep: async ms => { now += ms; }, now: () => now, waitMs: 6_000 });
    expect(now).toBe(6_000);
  });

  it("says nothing when the connector can take work", async () => {
    const out = output();
    const result = await waitWhileStarting({ availability: runningProbe([answer({ available: true, phase: null, reason: null })]), output: out.value }, { sleep: noSleep, now: () => 0 });
    expect(result.available).toBe(true);
    expect(out.lines).toEqual([]);
  });
});
