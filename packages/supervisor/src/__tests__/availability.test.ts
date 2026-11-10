import { describe, expect, it } from "vitest";
import { ConnectorAvailabilitySchema } from "@konteks/remote-common";
import { connectorAvailability, availabilityForHeartbeat, heartbeatSignal, livenessSignal, relaySignal, type AvailabilityFacts } from "../reconnect/availability.js";
import { STARTUP_RECOVERY_BOUND_MS, STARTUP_RECOVERY_RETRY_MS, StartupRecoveryBound } from "../reconnect/startup-recovery-bound.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

/** Every field already exists on the supervisor; a test names only what it changes. */
function facts(overrides: Partial<AvailabilityFacts> = {}): AvailabilityFacts {
  return {
    now: NOW,
    startup: { phase: "started", boundEndsAt: null, boundExceeded: false, reason: null },
    drain: { active: false, reason: null, deadline: null, activeAssignments: 0 },
    updateProbation: false,
    leaseMode: "active",
    unhealthyComponents: [],
    acceptingWork: true,
    liveness: { state: "live", quietMs: 0 },
    heartbeat: { state: "live", lastAttemptAt: null, lastSettledAt: null, budgetMs: 120_000 },
    relay: { state: "connected", lastConnectedAt: null },
    ...overrides,
  };
}

describe("the connector's availability report", () => {
  it("says an available connector can take work, with no phase or reason", () => {
    const report = connectorAvailability(facts());
    expect(report).toMatchObject({ available: true, phase: null, reason: null });
    expect(ConnectorAvailabilitySchema.safeParse(report).success).toBe(true);
  });

  it("reports starting, and an explicit unknown when no failure has started the bound", () => {
    const report = connectorAvailability(facts({ startup: { phase: "starting", boundEndsAt: null, boundExceeded: false, reason: null }, acceptingWork: false }));
    expect(report.phase).toBe("starting");
    expect(report.reason).toMatchObject({ code: "startup_in_progress" });
    expect(report.expectedReturn.kind).toBe("unknown");
    expect(ConnectorAvailabilitySchema.safeParse(report).success).toBe(true);
  });

  it("reports starting with the five-minute bound as the expected return once an attempt failed", () => {
    const boundEndsAt = NOW + STARTUP_RECOVERY_BOUND_MS;
    const report = connectorAvailability(facts({
      startup: { phase: "starting", boundEndsAt, boundExceeded: false, reason: "Core has not accepted this computer yet" },
      acceptingWork: false,
    }));
    expect(report.reason).toEqual({ code: "startup_recovery_pending", message: "Core has not accepted this computer yet" });
    expect(report.expectedReturn).toEqual({ kind: "at", at: new Date(boundEndsAt).toISOString(), basis: "startup_recovery_bound" });
    expect(ConnectorAvailabilitySchema.safeParse(report).success).toBe(true);
  });

  it("reports recovering past the bound, with the next recovery attempt as the expected return", () => {
    const report = connectorAvailability(facts({
      startup: { phase: "recovery_pending", boundEndsAt: NOW - 1, boundExceeded: true, reason: "startup recovery has not completed" },
      acceptingWork: false,
    }));
    expect(report.phase).toBe("recovering");
    expect(report.reason).toEqual({ code: "startup_recovery_bound_exceeded", message: "startup recovery has not completed" });
    expect(report.expectedReturn).toEqual({ kind: "at", at: new Date(NOW + STARTUP_RECOVERY_RETRY_MS).toISOString(), basis: "startup_recovery_retry" });
    expect(ConnectorAvailabilitySchema.safeParse(report).success).toBe(true);
  });

  it("reports draining with its deadline, and an explicit unknown when it has none", () => {
    const deadline = new Date(NOW + 60_000).toISOString();
    const draining = facts({ drain: { active: true, reason: "update", deadline, activeAssignments: 2 }, acceptingWork: false });
    expect(connectorAvailability(draining)).toMatchObject({
      phase: "draining",
      reason: { code: "drain_in_progress" },
      expectedReturn: { kind: "at", at: deadline, basis: "drain_deadline" },
    });
    const noDeadline = connectorAvailability({ ...draining, drain: { ...draining.drain, deadline: null } });
    expect(noDeadline.expectedReturn.kind).toBe("unknown");
    expect(ConnectorAvailabilitySchema.safeParse(noDeadline).success).toBe(true);
  });

  it("reports degraded for update probation, an unhealthy component or a lease it cannot pull with, and never invents a return", () => {
    const probation = connectorAvailability(facts({ updateProbation: true, acceptingWork: false }));
    expect(probation).toMatchObject({ phase: "degraded", reason: { code: "update_probation" }, expectedReturn: { kind: "unknown" } });
    expect(connectorAvailability(facts({ unhealthyComponents: ["agent_runner"], acceptingWork: false })).reason).toMatchObject({ code: "component_unhealthy" });
    expect(connectorAvailability(facts({ leaseMode: "none", acceptingWork: false })).reason).toMatchObject({ code: "lease_unavailable" });
    expect(ConnectorAvailabilitySchema.safeParse(probation).success).toBe(true);
  });

  it("reports liveness lost, with the reason the heartbeat stalled and an explicit unknown return", () => {
    const report = connectorAvailability(facts({ liveness: { state: "lost", quietMs: 400_000 }, heartbeat: { state: "stalled", lastAttemptAt: null, lastSettledAt: null, budgetMs: 120_000 }, acceptingWork: false }));
    expect(report).toMatchObject({ phase: "liveness_lost", reason: { code: "liveness_lost" }, expectedReturn: { kind: "unknown" } });
    expect(ConnectorAvailabilitySchema.safeParse(report).success).toBe(true);
  });

  it("keeps liveness, heartbeat and relay as three separate answers", () => {
    const report = connectorAvailability(facts({
      liveness: { state: "live", quietMs: 0 },
      heartbeat: { state: "stalled", lastAttemptAt: null, lastSettledAt: null, budgetMs: 120_000 },
      relay: { state: "disconnected", lastConnectedAt: "2026-11-09T11:00:00.000Z" },
    }));
    expect(report.liveness).toEqual({ state: "live", quietMs: 0 });
    expect(report.heartbeat.state).toBe("stalled");
    expect(report.relay).toEqual({ state: "disconnected", lastConnectedAt: "2026-11-09T11:00:00.000Z" });
  });

  it("reports the relay as the degraded reason while it is disconnected, and stays available on the working fallback", () => {
    const disconnected = connectorAvailability(facts({ acceptingWork: false, relay: { state: "disconnected", lastConnectedAt: "2026-11-04T13:36:06.000Z" } }));
    expect(disconnected).toMatchObject({ available: false, phase: "degraded", reason: { code: "relay_disconnected" }, expectedReturn: { kind: "unknown" } });
    expect(disconnected.reason?.message).toContain("since 2026-11-04T13:36:06.000Z");
    expect(ConnectorAvailabilitySchema.safeParse(disconnected).success).toBe(true);

    const noRelay = connectorAvailability(facts({ acceptingWork: false, relay: { state: "unknown", lastConnectedAt: null } }));
    expect(noRelay).toMatchObject({ available: false, phase: "degraded", reason: { code: "relay_disconnected" } });

    // The HTTPS fallback is a working transport, so it does not degrade the connector.
    const fallback = connectorAvailability(facts({ relay: { state: "https_fallback", lastConnectedAt: null } }));
    expect(fallback).toMatchObject({ available: true, phase: null, reason: null });
  });
});

describe("the availability block on the heartbeat wire", () => {
  it("sends no block for an available connector, and maps the local relay code to a degraded component", () => {
    expect(availabilityForHeartbeat(connectorAvailability(facts()))).toBeUndefined();
    const relay = connectorAvailability(facts({ acceptingWork: false, relay: { state: "disconnected", lastConnectedAt: "2026-11-04T13:36:06.000Z" } }));
    expect(availabilityForHeartbeat(relay)).toMatchObject({
      phase: "degraded",
      reason: { code: "component_unhealthy" },
      expectedReturn: { kind: "unknown" },
    });
    expect(availabilityForHeartbeat(relay)?.reason.message).toContain("the relay is disconnected since");
  });

  it("passes every other local code and the expected return through unchanged", () => {
    const report = connectorAvailability(facts({ leaseMode: "none", acceptingWork: false }));
    expect(availabilityForHeartbeat(report)).toEqual({
      phase: "degraded",
      reason: { code: "lease_unavailable", message: expect.any(String) },
      expectedReturn: report.expectedReturn,
    });
  });
});

describe("the signals the report is built from", () => {
  it("maps the watchdog's verdict and never folds a missing one into live", () => {
    expect(livenessSignal("stuck", 400_000)).toEqual({ state: "lost", quietMs: 400_000 });
    expect(livenessSignal("quiet", 120_000)).toEqual({ state: "quiet", quietMs: 120_000 });
    expect(livenessSignal("live", 0)).toEqual({ state: "live", quietMs: 0 });
    expect(livenessSignal("unknown", null)).toEqual({ state: "unknown", quietMs: null });
  });

  it("says stalled when the publisher has no attempt inside its budget, and unknown without a publisher", () => {
    const publisher = { running: true, pendingFlight: false, stage: null, inFlightSince: null, lastAttemptAt: NOW - 10_000, lastSettledAt: NOW - 10_000 };
    expect(heartbeatSignal(publisher, 120_000, NOW)).toMatchObject({ state: "live", budgetMs: 120_000 });
    expect(heartbeatSignal({ ...publisher, lastAttemptAt: NOW - 300_000, lastSettledAt: NOW - 300_000 }, 120_000, NOW)).toMatchObject({ state: "stalled" });
    expect(heartbeatSignal(null, null, NOW)).toEqual({ state: "unknown", lastAttemptAt: null, lastSettledAt: null, budgetMs: null });
  });

  it("tells a relay socket apart from the HTTPS fallback and from no relay at all", () => {
    expect(relaySignal({ connected: true, transport: "relay", configured: true, lastConnectedAt: null })).toEqual({ state: "connected", lastConnectedAt: null });
    expect(relaySignal({ connected: false, transport: "https_fallback", configured: true, lastConnectedAt: null }).state).toBe("https_fallback");
    expect(relaySignal({ connected: false, transport: "offline", configured: true, lastConnectedAt: null }).state).toBe("disconnected");
    expect(relaySignal({ connected: false, transport: "offline", configured: false, lastConnectedAt: null }).state).toBe("unknown");
  });
});

describe("the startup bound's own return time", () => {
  it("is unknown until a failed attempt starts it, then five minutes from that attempt", () => {
    const bound = new StartupRecoveryBound();
    expect(bound.boundEndsAt()).toBeNull();
    bound.recordFailure("Core is unreachable", NOW);
    expect(bound.boundEndsAt()).toBe(NOW + STARTUP_RECOVERY_BOUND_MS);
    bound.complete();
    expect(bound.boundEndsAt()).toBeNull();
  });
});
