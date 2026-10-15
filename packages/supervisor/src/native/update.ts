import { RemoteInstanceError, type Logger, type NativeUpdateApply, type NativeUpdateStatus } from "@konteks/remote-common";
import { verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { compareSemver } from "../control/handlers.js";
import { isDeferredUpdateAttempt, type NativeUpdateLedger } from "./update-ledger.js";

export type NativeUpdateTarget = { bundleVersion: string; manifestDigest: string };
type AvailableRelease = NativeUpdateTarget;

export type NativeUpdateReason = "periodic" | "core_minimum" | "operator";

export interface NativeUpdateCoordinatorOptions {
  currentBundleVersion: string;
  /** Embedded in the verified executable; a manifest that fails them is not an update. */
  trustedRoots: readonly EmbeddedReleaseRoot[];
  fetchManifest: () => Promise<unknown>;
  /** Starts the launcher transaction out of process; it drains, stops and restarts this service itself. */
  launch: (target: NativeUpdateTarget & { reason: NativeUpdateReason; assertCurrent?: () => void }) => Promise<{ pid: number | null; onExit?: (listener: (code: number | null) => void) => void }>;
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
  /**
   * The release Core accepts: installing any other one is refused
   * by Core and costs minutes offline and a rollback. Undefined when Core
   * could not be asked; null when this Core does not say.
   */
  acceptedRelease?: () => Promise<{ bundleVersion: string; manifestDigest?: string } | null>;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_STALE_ATTEMPT_MS = 45 * 60_000;
/**
 * A release waiting only for Core to accept it (or for Core to answer) is
 * checked again this soon, doubling up to the cap, instead of at the next
 * 6-hour tick: Core moves its accepted release minutes to hours after the
 * channel publishes one. A channel read that failed and a transaction that
 * exited without replacing this service are transient too, and retry the same
 * way (10-13: a failed 0.14.1 update and a timed-out re-check each left the
 * owner's connector on 0.13.3 until the next 6-hour tick).
 */
const ACCEPTANCE_RECHECK_FIRST_MS = 15 * 60_000;
const ACCEPTANCE_RECHECK_MAX_MS = 60 * 60_000;

/** Why the update is checked again soon, for the scheduled re-check. */
interface AwaitingAcceptance {
  reason: "accepted_mismatch" | "core_unanswered" | "check_failed" | "update_failed";
  accepted: string | null;
  available: string | null;
}

const RECHECK_MESSAGES: Record<AwaitingAcceptance["reason"], string> = {
  accepted_mismatch: "the newest release waits for Konteks to accept it; checking again soon",
  core_unanswered: "the newest release waits for Konteks to answer; checking again soon",
  check_failed: "the release channel could not be read; checking again soon",
  update_failed: "the update did not replace this service; trying again soon",
};

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
  /**
   * Core refused this bundle as below its minimum (a `version_policy` or a
   * refused reconnect). Such a runtime has no lease, so Core cannot be asked
   * which release it accepts; a strictly newer signed release is then the way
   * back in, so a runtime below a raised minimum still updates.
   */
  private refusedAsTooOld: { minimumSupportedBundle: string | null } | null = null;
  /** The last channel read's failure only (never a launch failure), for `doctor`. */
  private channelError: string | null = null;
  private inFlight: NonNullable<NativeUpdateStatus["inFlight"]> | null = null;
  private lastAttempt: NativeUpdateStatus["lastAttempt"] = null;
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  /** Re-checks scheduled since the release last stopped waiting for Core. */
  private recheckStreak = 0;
  private lastUnlaunchedReason: string | null = null;
  /** Set by the current check when the newest release waits only for Core's acceptance. */
  private awaitingAcceptance: AwaitingAcceptance | null = null;
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
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.initialTimer = null;
    this.timer = null;
    this.recheckTimer = null;
  }

  /** Core's `version_policy` says this bundle is below the minimum: act now rather than at the next tick. */
  onUpdateRequired(policy: { minimumSupportedBundle: string | null; targetBundle?: string }): void {
    this.options.logger.warn({ minimumSupportedBundle: policy.minimumSupportedBundle, targetBundle: policy.targetBundle ?? null }, "update_required: Konteks refuses this release; requesting an update");
    this.refusedAsTooOld = { minimumSupportedBundle: policy.minimumSupportedBundle };
    void this.apply("core_minimum").catch(() => undefined);
  }

  /** Fetch + verify the channel manifest and remember what is newer than this build. */
  async check(): Promise<NativeUpdateStatus> {
    try {
      const release = verifyNativeRelease(await this.options.fetchManifest(), this.options.trustedRoots, this.now());
      const newer = compareSemver(release.manifest.bundleVersion, this.options.currentBundleVersion) > 0;
      this.available = newer ? { bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest } : null;
      this.lastError = null;
      this.channelError = null;
    } catch (error) {
      this.available = null;
      this.lastError = error instanceof Error ? error.message.slice(0, 1_024) : "manifest check failed";
      this.channelError = this.lastError;
      this.options.logger.warn({ err: error }, "native update check failed");
    }
    this.lastCheckedAt = new Date(this.now()).toISOString();
    await this.refreshLedgerView();
    return this.status();
  }

  /**
   * Without Core's accepted release, only a runtime Core refused as too old
   * updates unattended, and only to a strictly newer signed release (verified
   * by `check`) at or above the minimum Core named, when it named one.
   */
  private mayUpdateWithoutAcceptedRelease(reason: NativeUpdateReason, bundleVersion: string): boolean {
    if (reason !== "core_minimum" || !this.refusedAsTooOld) return false;
    const minimum = this.refusedAsTooOld.minimumSupportedBundle;
    return minimum === null || compareSemver(bundleVersion, minimum) >= 0;
  }

  /** The release channel's last read, for `doctor`: when, and why it failed (null when it was read). */
  channel(): { lastCheckedAt: string | null; error: string | null; available: string | null } {
    return { lastCheckedAt: this.lastCheckedAt, error: this.channelError, available: this.available?.bundleVersion ?? null };
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
  apply(reason: NativeUpdateReason, target?: NativeUpdateTarget, assertCurrent?: () => void): Promise<NativeUpdateApply> {
    if (target && this.applying) return Promise.resolve(this.refuse("busy"));
    this.applying ??= this.applyImpl(reason, target, assertCurrent).then(result => this.noteUnlaunched(result, target)).finally(() => {
      this.applying = null;
      this.scheduleAcceptanceRecheck();
    });
    return this.applying;
  }

  /**
   * While the newest signed release waits only for Core, check again soon
   * (15 min, doubling to 1 h) until it launches or stops waiting; the
   * 6-hour tick carries on unchanged.
   */
  private scheduleAcceptanceRecheck(): void {
    const awaiting = this.awaitingAcceptance;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    if (!awaiting || this.stopped) {
      this.recheckStreak = 0;
      return;
    }
    const delayMs = Math.min(ACCEPTANCE_RECHECK_FIRST_MS * 2 ** this.recheckStreak, ACCEPTANCE_RECHECK_MAX_MS);
    this.recheckStreak += 1;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.apply("periodic").catch(() => undefined);
    }, delayMs);
    this.recheckTimer.unref();
    this.options.logger.info({ event: "native.update.recheck_scheduled", ...awaiting, current: this.options.currentBundleVersion, delayMs },
      RECHECK_MESSAGES[awaiting.reason]);
  }

  /**
   * A check of its own accord that launches nothing says why, once per
   * reason, so a wait (backoff, Core's accepted release) is never silent.
   */
  private noteUnlaunched(result: NativeUpdateApply, target: NativeUpdateTarget | undefined): NativeUpdateApply {
    if (result.started) this.lastUnlaunchedReason = null;
    else if (!target && result.reason !== this.lastUnlaunchedReason) {
      this.lastUnlaunchedReason = result.reason;
      this.options.logger.info({ event: "native.update.not_launched", reason: result.reason, current: this.options.currentBundleVersion }, "the update check launched nothing");
    }
    return result;
  }

  private refuse(reason: string): NativeUpdateApply {
    return { started: false, reason, pid: null, status: this.status() };
  }

  private async applyImpl(reason: NativeUpdateReason, target?: NativeUpdateTarget, assertCurrent?: () => void): Promise<NativeUpdateApply> {
    this.awaitingAcceptance = null;
    if (this.stopped) return this.refuse(target ? "busy" : "supervisor is stopping");
    await this.check();
    const available = this.available;
    if (!available) return this.refuse(this.unavailableReason(target));
    if (target && !sameUpdateTarget(target, available)) return this.refuse("stale_target");
    const refusal = await this.launchRefusal(reason, available, target !== undefined);
    if (refusal) return this.refuse(refusal);
    assertCurrent?.();
    return this.launch(reason, available, assertCurrent);
  }

  /** Also marks an unattended check whose channel read failed for an early re-check. */
  private unavailableReason(target: NativeUpdateTarget | undefined): string {
    if (target) return this.channelError ? "unavailable" : "stale_target";
    if (this.channelError) this.awaitingAcceptance = { reason: "check_failed", accepted: null, available: null };
    return this.lastError ? `check failed: ${this.lastError}` : "no newer signed release";
  }

  /** Why the available release is not launched now: one already in flight, a veto, the ledger, backoff, or Core's accepted release. */
  private async launchRefusal(reason: NativeUpdateReason, available: AvailableRelease, frozen = false): Promise<string | null> {
    const live = this.liveLaunchRefusal(frozen);
    if (live) return live;
    const ledger = await this.options.readLedger().catch((error: unknown) => { this.options.logger.warn({ err: error }, "native update ledger unreadable; refusing to launch"); return null; });
    if (!ledger) return updateRefusal(frozen, "unavailable", "update ledger unreadable");
    const backoff = this.backoffReason(ledger, available.manifestDigest);
    if (backoff) return updateRefusal(frozen, "busy", backoff);
    const accepted = await this.acceptedReleaseRefusal(reason, available, frozen);
    return accepted ?? this.liveLaunchRefusal(frozen);
  }

  private liveLaunchRefusal(frozen: boolean): string | null {
    if (this.stopped) return updateRefusal(frozen, "busy", "supervisor is stopping");
    if (this.inFlight) return updateRefusal(frozen, "busy", `update to ${this.inFlight.bundleVersion} already launched`);
    const veto = this.options.canApply();
    return veto.ok ? null : updateRefusal(frozen, "busy", veto.reason);
  }

  private async acceptedReleaseRefusal(reason: NativeUpdateReason, available: AvailableRelease, frozen: boolean): Promise<string | null> {
    if (!this.options.acceptedRelease) return updateRefusal(frozen, "unavailable", null);
    const accepted = await this.options.acceptedRelease().catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "could not ask Konteks which release it accepts");
      return undefined;
    });
    if (frozen) return frozenAcceptedReleaseRefusal(accepted, available);
    if (accepted === undefined) return this.unansweredAcceptedRelease(reason, available);
    if (accepted === null) return "this Konteks does not say which release it accepts; update by hand with `konteks-remote update`";
    if (accepted.bundleVersion === available.bundleVersion) return null;
    this.awaitingAcceptance = { reason: "accepted_mismatch", accepted: accepted.bundleVersion, available: available.bundleVersion };
    return `Konteks accepts ${accepted.bundleVersion}, not ${available.bundleVersion} yet; staying on this one until it does`;
  }

  /** Konteks could not be asked: stay, unless it refuses this release as too old. */
  private unansweredAcceptedRelease(reason: NativeUpdateReason, available: AvailableRelease): string | null {
    if (!this.mayUpdateWithoutAcceptedRelease(reason, available.bundleVersion)) {
      this.awaitingAcceptance = { reason: "core_unanswered", accepted: null, available: available.bundleVersion };
      return "Konteks could not be asked which release it accepts; staying on this one";
    }
    this.options.logger.warn({ bundleVersion: available.bundleVersion, minimumSupportedBundle: this.refusedAsTooOld?.minimumSupportedBundle ?? null }, "Konteks refuses this release and cannot be asked which one it accepts; installing the newer signed release");
    return null;
  }

  private async launch(reason: NativeUpdateReason, available: AvailableRelease, assertCurrent?: () => void): Promise<NativeUpdateApply> {
    try {
      const assertLaunchCurrent = assertCurrent ? () => {
        assertCurrent();
        if (this.liveLaunchRefusal(true)) throw new RemoteInstanceError("temporarily_unavailable", "The native update owner withdrew launch permission.");
      } : undefined;
      const launched = await this.options.launch({ ...available, reason, ...(assertLaunchCurrent ? { assertCurrent: assertLaunchCurrent } : {}) });
      const inFlight = { startedAt: new Date(this.now()).toISOString(), bundleVersion: available.bundleVersion, manifestDigest: available.manifestDigest, reason, pid: launched.pid };
      this.inFlight = inFlight;
      // A transaction that exits while this service is still running did not
      // replace it: clear the in-flight view so the next tick can try again.
      launched.onExit?.(code => {
        if (this.inFlight !== inFlight) return;
        this.inFlight = null;
        if (code !== 0) this.lastError = `update transaction exited with code ${code ?? "null"} before replacing this service`;
        this.options.logger.warn({ code, bundleVersion: available.bundleVersion }, "native update transaction exited without replacing the service");
        if (code !== 0 && !this.applying) {
          this.awaitingAcceptance = { reason: "update_failed", accepted: null, available: available.bundleVersion };
          this.scheduleAcceptanceRecheck();
        }
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
    const recentFailures = ledger.attempts.filter(attempt => attempt.manifestDigest === manifestDigest && attempt.outcome !== "applied" && attempt.outcome !== "in_progress" && !isDeferredUpdateAttempt(attempt) && now - Date.parse(attempt.startedAt) < window);
    const max = this.options.maxAttemptsPerRelease ?? DEFAULT_MAX_ATTEMPTS;
    if (recentFailures.length >= max) return `release ${manifestDigest} was ${recentFailures[recentFailures.length - 1]!.outcome} ${recentFailures.length} time(s) within the retry window; waiting for a newer release or operator action`;
    return null;
  }

  private async refreshLedgerView(): Promise<void> {
    const ledger = await this.options.readLedger().catch(() => null);
    const last = ledger?.attempts[ledger.attempts.length - 1];
    this.lastAttempt = last ? { bundleVersion: last.bundleVersion, manifestDigest: last.manifestDigest, outcome: last.outcome, startedAt: last.startedAt, finishedAt: last.finishedAt, detail: last.detail } : null;
    if (this.inFlightSettled(last)) this.inFlight = null;
  }

  /**
   * A launched transaction that reached a terminal ledger outcome without
   * replacing this process (refused, failed before stop), or one gone stale,
   * is no longer in flight.
   */
  private inFlightSettled(last: NativeUpdateLedger["attempts"][number] | undefined): boolean {
    const inFlight = this.inFlight;
    if (!inFlight) return false;
    if (last && last.manifestDigest === inFlight.manifestDigest && last.outcome !== "in_progress" && Date.parse(last.startedAt) >= Date.parse(inFlight.startedAt) - 60_000) return true;
    return this.now() - Date.parse(inFlight.startedAt) > (this.options.staleAttemptMs ?? DEFAULT_STALE_ATTEMPT_MS);
  }
}

function sameUpdateTarget(a: { bundleVersion: string; manifestDigest?: string }, b: NativeUpdateTarget): boolean {
  return a.bundleVersion === b.bundleVersion && a.manifestDigest === b.manifestDigest;
}

function updateRefusal(frozen: boolean, bounded: string, legacy: string | null): string | null {
  return frozen ? bounded : legacy;
}

function frozenAcceptedReleaseRefusal(accepted: { bundleVersion: string; manifestDigest?: string } | null | undefined, available: NativeUpdateTarget): string | null {
  if (!accepted) return "unavailable";
  return sameUpdateTarget(accepted, available) ? null : "stale_target";
}
