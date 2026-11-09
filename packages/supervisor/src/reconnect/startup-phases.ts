import type { Logger } from "@konteks/remote-common";

/** Every startup phase the connector reports, in the order the ticket enumerates them. */
export const STARTUP_PHASES = [
  "process_start",
  "control_channel",
  "relay_connected",
  "recovery",
  "capability_discovery",
  "started",
] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];

/** A bounded timing summary: fixed phases, and at most this many named steps. */
export const STARTUP_STEP_LIMIT = 32;

/** The timing summary logged at "started" and carried into the recorded exit state. */
export interface StartupSummary {
  processStartedAt: string;
  phasesMs: Record<string, number>;
  stepsMs: Record<string, number>;
  totalMs: number;
}

/** How often an open phase names itself while it is still waiting (the RecheckProgress cadence). */
export const STARTUP_PHASE_WATCH_MS = 30_000;

interface OpenStep {
  phase: StartupPhase;
  step: string;
  since: number;
  phaseSince: number;
}

/**
 * Startup, phase by phase. Startup emits its own timings, so a slow start
 * explains itself from its own log alone (a startup waited 17 minutes with
 * nothing logged, 11-04). Shaped like the input recheck's `RecheckProgress`:
 * each phase and sub-step is timed, a 30 s ticker names whatever is still
 * open, and `started` prints the summary the exit ledger keeps.
 */
export class StartupPhases {
  private readonly startedAt = Date.now();
  private readonly processStartedAt = new Date(this.startedAt).toISOString();
  private readonly phasesMs: Record<string, number> = {};
  private readonly stepsMs: Record<string, number> = {};
  private readonly open: OpenStep[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private lastCheckpoint: number;
  private promoted = false;

  constructor(private readonly logger?: Logger, watchMs = STARTUP_PHASE_WATCH_MS) {
    this.lastCheckpoint = this.startedAt;
    this.timer = setInterval(() => this.reportWaiting(), watchMs);
    this.timer.unref?.();
  }

  /**
   * Record one phase being reached, once. `phaseMs` is the wait since the
   * previous checkpoint; `sinceStartMs` is measured from process start. A
   * later relay reconnect does not restate the relay phase.
   */
  complete(phase: StartupPhase): void {
    if (this.phasesMs[phase] !== undefined) return;
    const now = Date.now();
    this.phasesMs[phase] = Math.max(0, now - this.lastCheckpoint);
    this.lastCheckpoint = now;
    if (phase === "started") this.promoted = true;
    this.log({ event: "startup.phase", phase, phaseMs: this.phasesMs[phase]!, sinceStartMs: Math.max(0, now - this.startedAt) },
      "startup phase reached");
    this.stopWhenDone();
  }

  /**
   * Time one sub-step of a phase while it runs, so the 30 s ticker can name
   * the exact step a slow startup is sitting in. Nested steps keep the outer
   * step as the phase's own duration.
   */
  async step<T>(phase: StartupPhase, step: string, run: () => Promise<T>): Promise<T> {
    // Only startup recovery is timed; the same hook fires for late retirement.
    if (this.promoted && phase !== "capability_discovery") return run();
    const since = Date.now();
    const phaseSince = [...this.open].reverse().find(frame => frame.phase === phase)?.phaseSince ?? since;
    const frame: OpenStep = { phase, step, since, phaseSince };
    const nested = this.open.some(open => open.phase === phase);
    this.open.push(frame);
    try {
      return await run();
    } finally {
      const now = Date.now();
      this.remove(frame);
      const stepMs = Math.max(0, now - since);
      this.stepsMs[`${phase}:${step}`] = stepMs;
      if (!nested) this.phasesMs[phase] = (this.phasesMs[phase] ?? 0) + stepMs;
      this.lastCheckpoint = now;
      this.log({ event: "startup.phase", phase, step, phaseMs: stepMs, sinceStartMs: Math.max(0, now - this.startedAt) },
        "startup phase step completed");
      this.stopWhenDone();
    }
  }

  /** The bounded summary printed at `started` and written into `last-exit.json`. */
  summary(): StartupSummary {
    return {
      processStartedAt: this.processStartedAt,
      phasesMs: bounded(this.phasesMs, STARTUP_PHASES.length),
      stepsMs: bounded(this.stepsMs, STARTUP_STEP_LIMIT),
      totalMs: Math.max(0, Date.now() - this.startedAt),
    };
  }

  private reportWaiting(): void {
    const frame = this.open.at(-1);
    if (!frame) return;
    const now = Date.now();
    this.logger?.warn({ event: "startup.phase_running", phase: frame.phase, step: frame.step,
      phaseElapsedMs: Math.max(0, now - frame.phaseSince), stepElapsedMs: Math.max(0, now - frame.since) },
    "startup is still waiting in this phase");
  }

  private remove(frame: OpenStep): void {
    const index = this.open.indexOf(frame);
    if (index >= 0) this.open.splice(index, 1);
  }

  private log(fields: Record<string, unknown>, message: string): void {
    this.logger?.info(fields, message);
  }

  /** Nothing is open once `started` printed and discovery settled: stop the ticker. */
  private stopWhenDone(): void {
    if (this.promoted && this.open.length === 0) clearInterval(this.timer);
  }
}

/** Oldest keys stay; the summary never grows past `limit` entries. */
function bounded(record: Record<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(Object.entries(record).slice(-limit));
}
