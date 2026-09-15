import { describe, expect, it } from "vitest";
import { evaluateHeartbeatLiveness } from "../heartbeat/liveness.js";

const idle = { running: true, pendingFlight: false, stage: null, inFlightSince: null, lastAttemptAt: null, lastSettledAt: null };

describe("heartbeat liveness verdict", () => {
  it("counts from when watching began until the first attempt exists", () => {
    expect(evaluateHeartbeatLiveness({ now: 10_000, watchingSince: 0, liveness: idle, budgetMs: 100_000 })).toEqual({ state: "live", quietMs: 10_000 });
    expect(evaluateHeartbeatLiveness({ now: 60_000, watchingSince: 0, liveness: idle, budgetMs: 100_000 })).toEqual({ state: "quiet", quietMs: 60_000 });
    expect(evaluateHeartbeatLiveness({ now: 100_000, watchingSince: 0, liveness: idle, budgetMs: 100_000 })).toEqual({ state: "stuck", quietMs: 100_000 });
  });

  it("treats the latest attempt or settlement as the last sign of life", () => {
    const liveness = { ...idle, lastAttemptAt: 400_000, lastSettledAt: 350_000, inFlightSince: 400_000, stage: "request" as const };
    expect(evaluateHeartbeatLiveness({ now: 420_000, watchingSince: 0, liveness, budgetMs: 100_000 }).state).toBe("live");
    expect(evaluateHeartbeatLiveness({ now: 501_000, watchingSince: 0, liveness, budgetMs: 100_000 }).state).toBe("stuck");
  });
});
