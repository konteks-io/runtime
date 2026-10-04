import type { HeartbeatLiveness } from "./heartbeat.js";

interface LivenessVerdict {
  state: "live" | "quiet" | "stuck";
  /** Milliseconds since the publisher last attempted or settled a heartbeat (or since watching began). */
  quietMs: number;
}

/**
 * Heartbeats are the one activity every mode keeps up: pending ones on each
 * recovery cycle, ordinary ones once active. A publisher that has not even
 * attempted one for longer than its budget is stuck, not quiet. "quiet" is the
 * warning tier at half the budget so the log names the stall before the exit.
 */
export function evaluateHeartbeatLiveness(input: { now: number; watchingSince: number; liveness: HeartbeatLiveness; budgetMs: number }): LivenessVerdict {
  const { liveness } = input;
  const last = Math.max(input.watchingSince, liveness.lastAttemptAt ?? 0, liveness.lastSettledAt ?? 0);
  const quietMs = Math.max(0, input.now - last);
  if (quietMs >= input.budgetMs) return { state: "stuck", quietMs };
  if (quietMs >= input.budgetMs / 2) return { state: "quiet", quietMs };
  return { state: "live", quietMs };
}

/** A 401/403 from Core: it answered and refused this runtime's credential. An unreachable Core is not a refusal. */
export function isCredentialRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * A running process whose lease lapsed never renews it: heartbeats and the
 * relay both need a live lease, and only the startup reconnect (proved with the
 * machine key) mints a new one. Restart into it once the lease is gone and Core,
 * reachable, has refused it for `thresholdMs`. Only after a successful start (a
 * refused startup reconnect never loops) and never for a runtime Core said is
 * revoked or suspended.
 */
export function leaseLapseNeedsRestart(input: {
  now: number;
  stopping: boolean;
  activeLoopStarted: boolean;
  refusedSince: number | null;
  leaseMode: "active" | "drain_only" | "none";
  administrativeStatus: string;
  thresholdMs: number;
}): boolean {
  if (input.stopping || !input.activeLoopStarted || input.refusedSince === null) return false;
  if (input.administrativeStatus === "revoked" || input.administrativeStatus === "suspended") return false;
  if (input.leaseMode !== "none") return false;
  return input.now - input.refusedSince >= input.thresholdMs;
}
