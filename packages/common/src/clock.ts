/**
 * A clock the runtime can reason about. Core timestamps are authoritative;
 * the runtime keeps an estimate of its own skew from Core response times so
 * lease renewal and proof timestamps stay inside Core's acceptance window even
 * on a host with a drifting clock.
 */
export interface Clock {
  now(): number;
  nowIso(): string;
  /** Milliseconds this host is believed to be AHEAD of Core (negative = behind). */
  skewMs(): number;
  /** Fold in one observation of Core's clock (e.g. a `Date` response header). */
  observeCoreTime(coreNowMs: number, roundTripMs: number): void;
  coreNow(): number;
}

export class SystemClock implements Clock {
  private skewEstimateMs = 0;
  private samples = 0;

  now(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  skewMs(): number {
    return this.skewEstimateMs;
  }

  observeCoreTime(coreNowMs: number, roundTripMs: number): void {
    const localMid = this.now() - roundTripMs / 2;
    const sample = localMid - coreNowMs;
    this.samples = Math.min(this.samples + 1, 8);
    this.skewEstimateMs += (sample - this.skewEstimateMs) / this.samples;
  }

  coreNow(): number {
    return this.now() - this.skewEstimateMs;
  }
}

export class FixedClock implements Clock {
  private current: number;
  private skew = 0;

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  skewMs(): number {
    return this.skew;
  }

  observeCoreTime(coreNowMs: number, roundTripMs: number): void {
    this.skew = this.current - roundTripMs / 2 - coreNowMs;
  }

  coreNow(): number {
    return this.current - this.skew;
  }
}

export function parseRfc3339(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid RFC 3339 timestamp: ${value}`);
  }
  return ms;
}
