import type { HeartbeatLiveness } from "./heartbeat.js";

export interface LivenessVerdict {
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
