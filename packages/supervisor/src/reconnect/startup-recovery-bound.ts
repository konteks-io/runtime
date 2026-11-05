import type { RecoveryStatusReport } from "@konteks/remote-common";

/**
 * Startup recovery is bounded so a connector whose Core cannot be reached can
 * still answer on this computer. Five minutes from the first failed
 * `establish()`, the supervisor leaves the "starting" phase for
 * "recovery_pending".
 *
 * The bound opens NO work gate: work pull, the transport (and so every
 * non-control channel), the ordinary heartbeat and recovery authority stay
 * closed, reconciliation keeps retrying, and only a completed recovery reports
 * "started".
 */
export const STARTUP_RECOVERY_BOUND_MS = 5 * 60_000;

/** The interval a pending startup recovery is retried at (`Supervisor.armRecoveryRetry`). */
export const STARTUP_RECOVERY_RETRY_MS = 15_000;

/** The supervisor's startup phase; only "started" admits work. */
export type StartupPhase = "starting" | "recovery_pending" | "started";

/**
 * Holds the one fact that bounds startup: when `establish()` first failed, and
 * the plain words for why recovery has not completed since. Nothing here opens
 * a gate; the supervisor reads it to leave "starting" and to report itself.
 */
export class StartupRecoveryBound {
  private firstFailureAt: number | null = null;
  private failureReason: string | null = null;
  private completed = false;

  /** Record a failed startup attempt; only the first one starts the bound. */
  recordFailure(reason: string, now: number): void {
    this.firstFailureAt ??= now;
    this.failureReason = reason;
  }

  /** The active loop started: recovery completed, so the bound no longer applies. */
  complete(): void {
    this.completed = true;
    this.firstFailureAt = null;
    this.failureReason = null;
  }

  /** Whether the bound measured from the first failed `establish()` has passed. */
  exceeded(now: number): boolean {
    return !this.completed && this.firstFailureAt !== null && now - this.firstFailureAt >= STARTUP_RECOVERY_BOUND_MS;
  }

  /** What `recovery.status` and `doctor` report about a startup recovery. */
  report(now: number): RecoveryStatusReport {
    return {
      completed: this.completed,
      boundExceeded: this.exceeded(now),
      reason: this.completed ? null : this.failureReason,
      retryIntervalMs: STARTUP_RECOVERY_RETRY_MS,
    };
  }
}
