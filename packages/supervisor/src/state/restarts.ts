import type { RestartsStatusReport } from "@konteks/remote-common";
import type { ControlledExitEntry } from "./store.js";

/** The window a person is shown, and the count at which restarts are called repeating. */
export const RESTART_WINDOW_MS = 60 * 60_000;
export const RESTART_REPEAT_THRESHOLD = 2;

/**
 * The ledger's meaning, without I/O: how many exits happened in the last
 * hour, why the latest one did, and whether they are repeating. Never an
 * inferred cause or a raw log line.
 */
export function summariseRestarts(entries: readonly ControlledExitEntry[], now: number): RestartsStatusReport {
  const latest = entries.reduce<ControlledExitEntry | null>(
    (newest, entry) => (newest === null || Date.parse(entry.occurredAt) > Date.parse(newest.occurredAt) ? entry : newest),
    null,
  );
  const windowStart = now - RESTART_WINDOW_MS;
  const countLastHour = entries.filter(entry => Date.parse(entry.occurredAt) >= windowStart).length;
  return {
    countLastHour,
    windowMs: RESTART_WINDOW_MS,
    latest: latest === null ? null : { reason: latest.reason, occurredAt: latest.occurredAt },
    repeating: countLastHour >= RESTART_REPEAT_THRESHOLD,
  };
}
