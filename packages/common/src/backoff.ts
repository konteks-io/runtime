/**
 * Reconnect backoff (adapted from bb `packages/tunnel-client/reconnect.ts`).
 * Exponential with a cap; a connection that stayed up longer than
 * `stableConnectionMs` resets the attempt counter. Jitter is applied by the
 * caller so tests stay deterministic.
 */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_STABLE_CONNECTION_MS = 10_000;

interface ReconnectBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  stableConnectionMs?: number;
}

export class ReconnectBackoff {
  private attempt = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly stableConnectionMs: number;

  constructor(options: ReconnectBackoffOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.stableConnectionMs = options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;
  }

  nextDelayAfterClose(stableMs: number): number {
    this.attempt = stableMs > this.stableConnectionMs ? 0 : this.attempt + 1;
    return Math.min(this.baseDelayMs * 2 ** this.attempt, this.maxDelayMs);
  }
}

export function withJitter(delayMs: number, random: () => number = Math.random): number {
  return Math.round(delayMs * (0.5 + random() * 0.5));
}

/** A transport failure's plain reason, by its errno code or, failing that, its message. */
const TRANSPORT_REASONS: ReadonlyArray<{ codes: readonly string[]; message?: RegExp; reason: string }> = [
  { codes: ["ECONNREFUSED"], reason: "connection refused" },
  { codes: ["ENOTFOUND", "EAI_AGAIN"], reason: "host not found" },
  { codes: ["ETIMEDOUT"], message: /timed out|timeout|ETIMEDOUT/i, reason: "timed out" },
  { codes: ["ECONNRESET"], reason: "connection reset" },
  { codes: ["CERT_HAS_EXPIRED"], message: /certificate/i, reason: "TLS certificate verification failed" },
];

export function humanizeTransportError(error: Error, host: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  const rule = TRANSPORT_REASONS.find(entry => (code !== undefined && entry.codes.includes(code)) || entry.message?.test(error.message));
  return `can't reach ${host} — ${rule?.reason ?? error.message}`;
}
