import { existsSync } from "node:fs";
import type { Logger } from "@konteks/remote-common";
import { pendingViewerRetry, type PreviewFailure, type PreviewStarter, type PreviewStatus } from "./process-manager.js";

/** The person's reasons a viewer's start is declined; Konteks shows them after "Preview could not start: ". */
export const NOT_TAKING_WORK_REASON = "This computer is not taking new work right now. Try again in a moment.";
export const NO_WORKTREE_REASON = "This session's changes are not on this computer, so there is nothing to preview.";
export const WORKTREE_GONE_REASON = "This session's changes were removed from this computer, so there is nothing to preview.";
const REFUSED_REASON = "This computer could not start the preview. Try again in a moment.";

interface ViewerStartDeps {
  previews: {
    start(sessionId: string, cwd: string, startedBy: PreviewStarter, managedRepository?: true): Promise<PreviewStatus>;
    status(sessionId: string): PreviewStatus;
    lastFailureFor(sessionId: string): PreviewFailure | null;
  };
  /** The session's kept worktree, whatever happened to the session since (D96). */
  permits: { get(sessionId: string): string | undefined; managedRepository?(sessionId: string): true | undefined };
  /** False while this computer is stopping, draining or without an active lease. */
  takingWork(): boolean;
  /** How long a failed viewer start waits before a viewer may start it again. */
  retryMs: number;
  exists?: (path: string) => boolean;
  now?: () => number;
  logger: Logger;
}

type Declined = "not_taking_work" | "no_worktree" | "worktree_missing" | "retry_pending" | "refused";

/**
 * A viewer opened a session's preview and nothing runs: start it in the
 * session's kept worktree (same process manager, inference and caps as
 * preview_start). True while one is starting. Every other outcome is a
 * `{ reason }` the viewer is shown, and a log line that says why: a page
 * that reads "Nothing to preview yet … refreshes by itself" for something
 * that will never appear by itself is the failure this replaces (D96).
 */
export class PreviewViewerStarts {
  /** When a viewer last started each session's preview (to pace retries after a failure). */
  readonly #lastStart = new Map<string, number>();

  constructor(private readonly deps: ViewerStartDeps) {}

  async start(sessionId: string): Promise<true | { reason: string }> {
    if (this.deps.previews.status(sessionId).state === "starting") return true;
    const cwd = this.permittedWorktree(sessionId);
    if (typeof cwd !== "string") return cwd;
    const now = this.deps.now?.() ?? Date.now();
    const pending = pendingViewerRetry(this.#lastStart.get(sessionId), this.deps.previews.lastFailureFor(sessionId), now, this.deps.retryMs);
    if (pending !== null) return this.decline(sessionId, "retry_pending", pending);
    this.#lastStart.set(sessionId, now);
    const started = await this.deps.previews.start(sessionId, cwd, "viewer", this.deps.permits.managedRepository?.(sessionId));
    return this.startResult(sessionId, started);
  }

  private permittedWorktree(sessionId: string): string | { reason: string } {
    if (!this.deps.takingWork()) return this.decline(sessionId, "not_taking_work", NOT_TAKING_WORK_REASON);
    const cwd = this.deps.permits.get(sessionId);
    if (cwd === undefined) return this.decline(sessionId, "no_worktree", NO_WORKTREE_REASON);
    if (!(this.deps.exists ?? existsSync)(cwd)) return this.decline(sessionId, "worktree_missing", WORKTREE_GONE_REASON);
    return cwd;
  }

  private startResult(sessionId: string, started: PreviewStatus): true | { reason: string } {
    if (started.state !== "starting" && started.state !== "running") {
      const reason = started.reason ?? this.deps.previews.lastFailureFor(sessionId)?.reason ?? REFUSED_REASON;
      return this.decline(sessionId, "refused", reason, started.state);
    }
    this.deps.logger.info({ event: "preview.viewer_started", sessionId }, "a viewer started this session's preview");
    return true;
  }

  /** The session was released: its next viewer start is not paced by an older one. */
  forget(sessionId: string): void {
    this.#lastStart.delete(sessionId);
  }

  private decline(sessionId: string, cause: Declined, reason: string, state?: PreviewStatus["state"]): { reason: string } {
    this.deps.logger.info({ event: "preview.viewer_start_declined", sessionId, cause, ...(state ? { state } : {}), reason },
      "a viewer's preview could not start");
    return { reason };
  }
}
