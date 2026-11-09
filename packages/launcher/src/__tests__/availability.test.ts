import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { NativeAvailability, localAvailability } from "../native/availability.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kr-availability-"));
  await mkdir(join(root, "supervisor"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function marker(name: string, value: unknown): Promise<void> {
  await writeFile(join(root, "supervisor", name), JSON.stringify(value));
}

const exit = (reason: string, occurredAt: string) => ({ schemaVersion: 1, reason, occurredAt });
const shutdown = (phase: string, state: string, observedAt: string) => ({ schemaVersion: 1, phase, state, observedAt });

describe("the reason this computer can prove while its control channel is missing", () => {
  it("reports liveness lost from last-exit.json when the service is not running", async () => {
    await marker("last-exit.json", exit("liveness_lost", "2026-11-09T11:36:06.000Z"));
    const answer = await localAvailability(root, false);
    expect(answer).toMatchObject({ available: false, phase: "liveness_lost", reason: { code: "liveness_lost" }, expectedReturn: { kind: "unknown" } });
    expect(answer.reason?.message).toContain("lost its heartbeat at 2026-11-09T11:36:06.000Z");
  });

  it("does not report a previous process's crash while this one is running", async () => {
    await marker("last-exit.json", exit("liveness_lost", "2026-11-09T11:36:06.000Z"));
    const answer = await localAvailability(root, true);
    expect(answer).toMatchObject({ phase: "starting", reason: { code: "control_socket_unavailable" } });
    expect(answer.reason?.message).not.toContain("lost its heartbeat");
  });

  it("reports a shutdown in progress when it is newer than the last exit", async () => {
    await marker("last-exit.json", exit("liveness_lost", "2026-11-09T11:36:06.000Z"));
    await marker("shutdown-progress.json", shutdown("control_close", "entered", "2026-11-09T12:00:00.000Z"));
    const answer = await localAvailability(root, false);
    expect(answer).toMatchObject({ phase: "draining", reason: { code: "shutdown_in_progress" }, expectedReturn: { kind: "unknown" } });
  });

  it("reports a cleanly stopped service once the shutdown receipt is written", async () => {
    await marker("last-exit.json", exit("liveness_lost", "2026-11-09T11:36:06.000Z"));
    await marker("shutdown-progress.json", shutdown("receipt", "completed", "2026-11-09T12:01:00.000Z"));
    await writeFile(join(root, "supervisor", "shutdown-complete"), "receipt");
    const answer = await localAvailability(root, false);
    expect(answer).toMatchObject({ phase: "liveness_lost", reason: { code: "service_stopped" } });
  });

  it("reports a failed start with when and why it failed", async () => {
    await marker("service-start-failure.json", { at: "2026-11-09T11:50:00.000Z", message: "the service manager did not start this connector" });
    const answer = await localAvailability(root, false);
    expect(answer).toMatchObject({ phase: "starting", reason: { code: "service_start_failed" } });
    expect(answer.reason?.message).toContain("2026-11-09T11:50:00.000Z");
  });

  it("says the control socket did not answer when no marker names a cause", async () => {
    const answer = await localAvailability(root, null);
    expect(answer).toMatchObject({ phase: "starting", reason: { code: "control_socket_unavailable" } });
  });

  it("keeps liveness, heartbeat and relay apart in local evidence rather than inventing any", async () => {
    const answer = await localAvailability(root, false);
    expect(answer.liveness.state).toBe("lost");
    expect(answer.heartbeat.state).toBe("unknown");
    expect(answer.relay.state).toBe("unknown");
  });
});

describe("asking a connector that may be older than this launcher", () => {
  it("falls back to this computer's own evidence when availability.status is refused", async () => {
    await marker("last-exit.json", exit("liveness_lost", "2026-11-09T11:36:06.000Z"));
    const asked: string[] = [];
    const probe = new NativeAvailability({
      control: {
        call: async (request: { op: string }) => {
          asked.push(request.op);
          throw new RemoteInstanceError("temporarily_unavailable", "control_request_invalid: request does not match the closed control protocol");
        },
      } as never,
      root,
      running: async () => false,
    });
    const answer = await probe.read();
    expect(asked).toEqual(["availability.status"]);
    expect(answer.reason).toMatchObject({ code: "liveness_lost" });
  });

  it("asks the connector and reports its own answer when it has one", async () => {
    const probe = new NativeAvailability({
      control: { call: async () => ({ available: true, phase: null, reason: null, expectedReturn: { kind: "unknown", why: "it can take work now" }, liveness: { state: "live", quietMs: 0 }, heartbeat: { state: "live", lastAttemptAt: null, lastSettledAt: null, budgetMs: 60_000 }, relay: { state: "connected", lastConnectedAt: null } }) } as never,
      root,
      running: async () => true,
    });
    expect(await probe.read()).toMatchObject({ available: true, phase: null });
  });
});
