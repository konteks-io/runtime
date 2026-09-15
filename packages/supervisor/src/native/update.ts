import { RemoteInstanceError, type Logger, type NativeUpdateApply, type NativeUpdateStatus } from "@konteks/remote-common";
import { verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { compareSemver } from "../control/handlers.js";
import type { NativeUpdateLedger } from "./update-ledger.js";

export type NativeUpdateReason = "periodic" | "core_minimum" | "operator";

export interface NativeUpdateCoordinatorOptions {
  currentBundleVersion: string;
  /** Embedded in the verified executable; a manifest that fails them is not an update. */
  trustedRoots: readonly EmbeddedReleaseRoot[];
  fetchManifest: () => Promise<unknown>;
  /** Starts the launcher transaction out of process; it drains, stops and restarts this service itself. */
  launch: (target: { bundleVersion: string; manifestDigest: string; reason: NativeUpdateReason }) => Promise<{ pid: number | null; onExit?: (listener: (code: number | null) => void) => void }>;
  readLedger: () => Promise<NativeUpdateLedger>;
  /** Live veto from the owner: stopping, or a drain the update must not preempt. */
  canApply: () => { ok: true } | { ok: false; reason: string };
  logger: Logger;
  now?: () => number;
  checkIntervalMs?: number;
  initialDelayMs?: number;
  /** Terminal non-applied attempts on one manifest inside the window before it is left alone. */
  maxAttemptsPerRelease?: number;
  attemptWindowMs?: number;
  /** An `in_progress` attempt older than this is treated as abandoned. */
  staleAttemptMs?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_STALE_ATTEMPT_MS = 45 * 60_000;

/**
 * Decides when the running connector asks for its own replacement. The
 * supervisor never swaps files itself: the launcher transaction owns staging,
 * drain, service swap, health gate and rollback, and records its outcome in a
 * durable ledger that this coordinator consults before launching again.
 */
export class NativeUpdateCoordinator {
  private available: { bundleVersion: string; manifestDigest: string } | null = null;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private inFlight: NonNullable<NativeUpdateStatus["inFlight"]> | null = null;
  private lastAttempt: NativeUpdateStatus["lastAttempt"] = null;
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private applying: Promise<NativeUpdateApply> | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: NativeUpdateCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => void this.apply("periodic").catch(() => undefined);
    this.initialTimer = setTimeout(tick, this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    this.initialTimer.unref();
    this.timer = setInterval(tick, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /** Core's `version_policy` says this bundle is below the minimum: act now rather than at the next tick. */
  onUpdateRequired(policy: { minimumSupportedBundle: string; targetBundle?: string }): void {
    this.options.logger.warn({ minimumSupportedBundle: policy.minimumSupportedBundle, targetBundle: policy.targetBundle ?? null }, "update_required: bundle below Core's minimum; requesting update");
    void this.apply("core_minimum").catch(() => undefined);
  }

  /** Fetch + verify the channel manifest and remember what is newer than this build. */
  async check(): Promise<NativeUpdateStatus> {
    try {
      const release = verifyNativeRelease(await this.options.fetchManifest(), this.options.trustedRoots, this.now());
      const newer = compareSemver(release.manifest.bundleVersion, this.options.currentBundleVersion) > 0;
      this.available = newer ? { bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest } : null;
      this.lastError = null;
    } catch (error) {
      this.available = null;
      this.lastError = error instanceof Error ? error.message.slice(0, 1_024) : "manifest check failed";
      this.options.logger.warn({ err: error }, "native update check failed");
    }
    this.lastCheckedAt = new Date(this.now()).toISOString();
    await this.refreshLedgerView();
    return this.status();
  }

  status(): NativeUpdateStatus {
    return {
      current: { bundleVersion: this.options.currentBundleVersion },
      available: this.available,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      inFlight: this.inFlight,
      lastAttempt: this.lastAttempt,
    };
  }

  /** Check, then launch at most one transaction; refusals are reported, never thrown, so callers see why. */
  apply(reason: NativeUpdateReason): Promise<NativeUpdateApply> {
    this.applying ??= this.applyImpl(reason).finally(() => { this.applying = null; });
    return this.applying;
  }

  private async applyImpl(reason: NativeUpdateReason): Promise<NativeUpdateApply> {
    const refuse = (why: string): NativeUpdateApply => ({ started: false, reason: why, pid: null, status: this.status() });
    if (this.stopped) return refuse("supervisor is stopping");
    await this.check();
    const available = this.available;
    if (!available) return refuse(this.lastError ? `check failed: ${this.lastError}` : "no newer signed release");
    if (this.inFlight) return refuse(`update to ${this.inFlight.bundleVersion} already launched`);
    const veto = this.options.canApply();
    if (!veto.ok) return refuse(veto.reason);
    const ledger = await this.options.readLedger().catch((error: unknown) => { this.options.logger.warn({ err: error }, "native update ledger unreadable; refusing to launch"); return null; });
    if (!ledger) return refuse("update ledger unreadable");
    const backoff = this.backoffReason(ledger, available.manifestDigest);
    if (backoff) return refuse(backoff);
    try {
      const launched = await this.options.launch({ ...available, reason });
      const inFlight = { startedAt: new Date(this.now()).toISOString(), bundleVersion: available.bundleVersion, manifestDigest: available.manifestDigest, reason, pid: launched.pid };
      this.inFlight = inFlight;
      // A transaction that exits while this service is still running did not
      // replace it: clear the in-flight view so the next tick can try again.
      launched.onExit?.(code => {
        if (this.inFlight !== inFlight) return;
        this.inFlight = null;
        if (code !== 0) this.lastError = `update transaction exited with code ${code ?? "null"} before replacing this service`;
        this.options.logger.warn({ code, bundleVersion: available.bundleVersion }, "native update transaction exited without replacing the service");
      });
      this.options.logger.info({ bundleVersion: available.bundleVersion, reason, pid: launched.pid }, "native update transaction launched");
      return { started: true, reason: null, pid: launched.pid, status: this.status() };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 1_024) : "update launch failed";
      this.options.logger.error({ err: error }, "native update transaction could not be launched");
      throw new RemoteInstanceError("temporarily_unavailable", "The native update could not be launched; the running release is unchanged.", { cause: error });
    }
  }

  private backoffReason(ledger: NativeUpdateLedger, manifestDigest: string): string | null {
    const now = this.now();
    const window = this.options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
    const stale = this.options.staleAttemptMs ?? DEFAULT_STALE_ATTEMPT_MS;
    const live = ledger.attempts.find(attempt => attempt.outcome === "in_progress" && now - Date.parse(attempt.startedAt) < stale);
    if (live) return `an update transaction started at ${live.startedAt} is still in progress`;
    const recentFailures = ledger.attempts.filter(attempt => attempt.manifestDigest === manifestDigest && attempt.outcome !== "applied" && attempt.outcome !== "in_progress" && now - Date.parse(attempt.startedAt) < window);
    const max = this.options.maxAttemptsPerRelease ?? DEFAULT_MAX_ATTEMPTS;
    if (recentFailures.length >= max) return `release ${manifestDigest} was ${recentFailures[recentFailures.length - 1]!.outcome} ${recentFailures.length} time(s) within the retry window; waiting for a newer release or operator action`;
    return null;
  }

  private async refreshLedgerView(): Promise<void> {
    const ledger = await this.options.readLedger().catch(() => null);
    const last = ledger?.attempts[ledger.attempts.length - 1];
    this.lastAttempt = last ? { bundleVersion: last.bundleVersion, manifestDigest: last.manifestDigest, outcome: last.outcome, startedAt: last.startedAt, finishedAt: last.finishedAt, detail: last.detail } : null;
    // A launched transaction that reached a terminal ledger outcome without
    // replacing this process (refused, failed before stop) is no longer in flight.
    if (this.inFlight && last && last.manifestDigest === this.inFlight.manifestDigest && last.outcome !== "in_progress" && Date.parse(last.startedAt) >= Date.parse(this.inFlight.startedAt) - 60_000) this.inFlight = null;
    else if (this.inFlight && this.now() - Date.parse(this.inFlight.startedAt) > (this.options.staleAttemptMs ?? DEFAULT_STALE_ATTEMPT_MS)) this.inFlight = null;
  }
}
