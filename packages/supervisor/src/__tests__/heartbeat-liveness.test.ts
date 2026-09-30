import { describe, expect, it } from "vitest";
import { CoreResponseError } from "@konteks/remote-common";
import { evaluateHeartbeatLiveness, isCredentialRefusal, leaseLapseNeedsRestart } from "../heartbeat/liveness.js";

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

describe("a lapsed lease Core keeps refusing (RCA 2026-09-30)", () => {
  const lapsed = { now: 200_000, stopping: false, activeLoopStarted: true, refusedSince: 50_000, leaseMode: "none" as const, administrativeStatus: "active", thresholdMs: 120_000 };

  it("restarts into the startup reconnect once Core has refused it for the threshold", () => {
    expect(leaseLapseNeedsRestart(lapsed)).toBe(true);
    expect(leaseLapseNeedsRestart({ ...lapsed, now: 169_999 })).toBe(false);
  });

  it("never restarts while the lease is still live, Core was not reached, or before a successful start", () => {
    expect(leaseLapseNeedsRestart({ ...lapsed, leaseMode: "active" })).toBe(false);
    expect(leaseLapseNeedsRestart({ ...lapsed, leaseMode: "drain_only" })).toBe(false);
    expect(leaseLapseNeedsRestart({ ...lapsed, refusedSince: null })).toBe(false);
    expect(leaseLapseNeedsRestart({ ...lapsed, activeLoopStarted: false })).toBe(false);
    expect(leaseLapseNeedsRestart({ ...lapsed, stopping: true })).toBe(false);
  });

  it("leaves a revoked or suspended runtime alone", () => {
    expect(leaseLapseNeedsRestart({ ...lapsed, administrativeStatus: "revoked" })).toBe(false);
    expect(leaseLapseNeedsRestart({ ...lapsed, administrativeStatus: "suspended" })).toBe(false);
  });

  it("counts only Core's own 401/403 as a refusal, never an unreachable Core", () => {
    expect(isCredentialRefusal(new CoreResponseError({ status: 403, code: "permission_denied", message: "HTTP 403" }))).toBe(true);
    expect(isCredentialRefusal(new CoreResponseError({ status: 401, code: "permission_denied", message: "HTTP 401" }))).toBe(true);
    expect(isCredentialRefusal(new CoreResponseError({ status: 503, code: "temporarily_unavailable", message: "HTTP 503" }))).toBe(false);
    expect(isCredentialRefusal(new TypeError("fetch failed"))).toBe(false);
    expect(isCredentialRefusal(null)).toBe(false);
  });
});
