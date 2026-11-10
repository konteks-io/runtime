import type {
  ConnectorAvailability,
  ConnectorAvailabilityPhase,
  ConnectorExpectedReturn,
  ConnectorHeartbeatSignal,
  ConnectorLivenessSignal,
  ConnectorRelaySignal,
  ConnectorUnavailabilityReason,
  HeartbeatMessage,
} from "@konteks/remote-common";
import type { HeartbeatLiveness } from "../heartbeat/heartbeat.js";
import { STARTUP_RECOVERY_BOUND_MS, STARTUP_RECOVERY_RETRY_MS, type StartupPhase } from "./startup-recovery-bound.js";

/**
 * The five phases in which this connector takes no work, and the facts they
 * are derived from. Every field already exists on the supervisor: this module
 * is a derivation, not a second source of truth.
 */
export interface AvailabilityFacts {
  now: number;
  startup: {
    phase: StartupPhase;
    /** Five minutes from the first failed attempt; null before one fails. */
    boundEndsAt: number | null;
    boundExceeded: boolean;
    /** Why the last startup attempt failed, in plain words; null before one fails. */
    reason: string | null;
  };
  drain: { active: boolean; reason: string | null; deadline: string | null; activeAssignments: number };
  updateProbation: boolean;
  leaseMode: "active" | "drain_only" | "none";
  /** Component kinds that are not healthy, bounded by the inventory's own list. */
  unhealthyComponents: string[];
  acceptingWork: boolean;
  liveness: ConnectorLivenessSignal;
  heartbeat: ConnectorHeartbeatSignal;
  relay: ConnectorRelaySignal;
}

/** The connector's own answer to `availability.status`, from the facts it holds. */
export function connectorAvailability(facts: AvailabilityFacts): ConnectorAvailability {
  const phase = unavailablePhase(facts);
  if (phase === null) {
    return {
      available: true, phase: null, reason: null,
      // A connector that can take work still says what it knows about a return.
      expectedReturn: { kind: "unknown", why: "it can take work now" },
      liveness: facts.liveness, heartbeat: facts.heartbeat, relay: facts.relay,
    };
  }
  return {
    available: false, phase, reason: reasonFor(phase, facts), expectedReturn: expectedReturnFor(phase, facts),
    liveness: facts.liveness, heartbeat: facts.heartbeat, relay: facts.relay,
  };
}

/**
 * The local report as the shared heartbeat's optional `availability` block.
 *
 * The shared 7.31.0 wire enum has no relay code, so the local-only
 * `relay_disconnected` goes out as a degraded `component_unhealthy` that names
 * the relay; a dedicated wire code follows later through the contract gate.
 * An available connector sends no block at all: the shared block requires a
 * phase and a reason whenever it is present, and the heartbeat's own
 * `utilization.acceptingWork` already says it can take work.
 */
export function availabilityForHeartbeat(report: ConnectorAvailability): NonNullable<HeartbeatMessage["availability"]> | undefined {
  if (report.available || report.phase === null || report.reason === null) return undefined;
  if (report.reason.code === "relay_disconnected") {
    return {
      phase: "degraded",
      reason: { code: "component_unhealthy", message: report.reason.message },
      expectedReturn: report.expectedReturn,
    };
  }
  return {
    phase: report.phase,
    reason: { code: report.reason.code, message: report.reason.message },
    expectedReturn: report.expectedReturn,
  };
}

function unavailablePhase(facts: AvailabilityFacts): ConnectorAvailabilityPhase | null {
  if (facts.liveness.state === "lost") return "liveness_lost";
  if (facts.drain.active) return "draining";
  if (facts.startup.phase !== "started") return facts.startup.boundExceeded ? "recovering" : "starting";
  if (degradedReason(facts) !== null || !facts.acceptingWork) return "degraded";
  return null;
}

function reasonFor(phase: ConnectorAvailabilityPhase, facts: AvailabilityFacts): ConnectorUnavailabilityReason {
  switch (phase) {
    case "liveness_lost": return { code: "liveness_lost", message: "the process stopped answering its heartbeat watchdog and is being restarted" };
    case "draining": return drainReason(facts);
    case "recovering":
    case "starting": return startupReason(facts);
    case "degraded": return degradedReason(facts) ?? { code: "unknown", message: "it reports that it cannot take work, and gives no further reason" };
  }
}

function startupReason(facts: AvailabilityFacts): ConnectorUnavailabilityReason {
  if (facts.startup.boundExceeded) {
    return { code: "startup_recovery_bound_exceeded", message: facts.startup.reason ?? `startup recovery passed its ${STARTUP_RECOVERY_BOUND_MS / 60_000}-minute bound and is still retrying` };
  }
  return {
    code: facts.startup.reason === null ? "startup_in_progress" : "startup_recovery_pending",
    message: facts.startup.reason ?? "startup has not finished yet, and no attempt has failed",
  };
}

function drainReason(facts: AvailabilityFacts): ConnectorUnavailabilityReason {
  const why = facts.drain.reason === null ? "" : ` (${facts.drain.reason})`;
  const by = facts.drain.deadline === null ? "" : ` before ${facts.drain.deadline}`;
  return { code: "drain_in_progress", message: `it is draining${why}${by}, with ${facts.drain.activeAssignments} active assignment(s)` };
}

function degradedReason(facts: AvailabilityFacts): ConnectorUnavailabilityReason | null {
  // The relay comes first deliberately: without it no work can reach this
  // computer, so it is the answer a person needs even when an update
  // probation or a lease would otherwise also be true. A working HTTPS
  // fallback is `https_fallback`, not `disconnected`/`unknown`, so it stays
  // ready to take work.
  if (facts.relay.state === "disconnected" || facts.relay.state === "unknown") return relayReason(facts.relay);
  if (facts.updateProbation) return { code: "update_probation", message: "an update is still checking this release, so it takes no new work" };
  if (facts.unhealthyComponents.length > 0) {
    return { code: "component_unhealthy", message: `these parts are not healthy: ${facts.unhealthyComponents.join(", ")}` };
  }
  if (facts.leaseMode === "drain_only") return { code: "lease_unavailable", message: "its lease is drain only, so it takes no new work" };
  if (facts.leaseMode === "none") return { code: "lease_unavailable", message: "it has no lease, so it can take no work" };
  return null;
}

/** The local relay reason. `relay_disconnected` never goes on the wire. */
function relayReason(relay: ConnectorRelaySignal): ConnectorUnavailabilityReason {
  if (relay.state === "unknown") {
    return { code: "relay_disconnected", message: "no relay is configured, so no relay can deliver work to it" };
  }
  const since = relay.lastConnectedAt === null ? "" : ` since ${relay.lastConnectedAt}`;
  return { code: "relay_disconnected", message: `the relay is disconnected${since}, so it cannot take work` };
}

function expectedReturnFor(phase: ConnectorAvailabilityPhase, facts: AvailabilityFacts): ConnectorExpectedReturn {
  switch (phase) {
    case "starting": return startingReturn(facts.startup.boundEndsAt);
    case "recovering": return { kind: "at", at: new Date(facts.now + STARTUP_RECOVERY_RETRY_MS).toISOString(), basis: "startup_recovery_retry" };
    case "draining": return drainReturn(facts.drain.deadline);
    case "degraded": return { kind: "unknown", why: degradedUnknownWhy(facts) };
    case "liveness_lost": return { kind: "unknown", why: "the process is being restarted, so the next process reports its own return" };
  }
}

function startingReturn(boundEndsAt: number | null): ConnectorExpectedReturn {
  if (boundEndsAt === null) return { kind: "unknown", why: "no startup attempt has failed yet, so its five-minute bound has not started counting" };
  return { kind: "at", at: new Date(boundEndsAt).toISOString(), basis: "startup_recovery_bound" };
}

function drainReturn(deadline: string | null): ConnectorExpectedReturn {
  const at = deadline === null ? Number.NaN : Date.parse(deadline);
  if (Number.isNaN(at)) return { kind: "unknown", why: "this drain has no deadline" };
  return { kind: "at", at: new Date(at).toISOString(), basis: "drain_deadline" };
}

function degradedUnknownWhy(facts: AvailabilityFacts): string {
  if (facts.relay.state === "disconnected" || facts.relay.state === "unknown") {
    return "the relay retries with backoff and has no fixed return; it is ready once its socket and handshake are current";
  }
  if (facts.updateProbation) return "an update probation has no fixed end; it ends when the update check keeps or rolls back this release";
  if (facts.unhealthyComponents.length > 0) return "no return time is known for an unhealthy component";
  return "its lease promises no renewal time";
}

/** The watchdog's verdict, as the report's liveness signal. */
export function livenessSignal(verdict: "live" | "quiet" | "stuck" | "unknown", quietMs: number | null): ConnectorLivenessSignal {
  return { state: verdict === "stuck" ? "lost" : verdict, quietMs };
}

/** The heartbeat publisher's own last attempt, never the watchdog's verdict. */
export function heartbeatSignal(liveness: HeartbeatLiveness | null, budgetMs: number | null, now: number): ConnectorHeartbeatSignal {
  if (liveness === null || budgetMs === null) return { state: "unknown", lastAttemptAt: null, lastSettledAt: null, budgetMs };
  const last = liveness.lastAttemptAt ?? liveness.lastSettledAt;
  return {
    state: last === null || now - last >= budgetMs ? "stalled" : "live",
    lastAttemptAt: isoOrNull(liveness.lastAttemptAt), lastSettledAt: isoOrNull(liveness.lastSettledAt), budgetMs,
  };
}

/** The relay answer, kept apart from liveness and the heartbeat. */
export function relaySignal(relay: { connected: boolean; transport: "relay" | "https_fallback" | "offline"; configured: boolean; lastConnectedAt: string | null }): ConnectorRelaySignal {
  if (relay.connected) return { state: "connected", lastConnectedAt: relay.lastConnectedAt };
  if (relay.transport === "https_fallback") return { state: "https_fallback", lastConnectedAt: relay.lastConnectedAt };
  return { state: relay.configured ? "disconnected" : "unknown", lastConnectedAt: relay.lastConnectedAt };
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
