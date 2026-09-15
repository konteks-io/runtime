/**
 * Reconnect backoff (adapted from bb `packages/tunnel-client/reconnect.ts`).
 * Exponential with a cap; a connection that stayed up longer than
 * `stableConnectionMs` resets the attempt counter. Jitter is applied by the
 * caller so tests stay deterministic.
 */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_STABLE_CONNECTION_MS = 10_000;

export interface ReconnectBackoffOptions {
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

  reset(): void {
    this.attempt = 0;
  }

  nextDelayAfterClose(stableMs: number): number {
    this.attempt = stableMs > this.stableConnectionMs ? 0 : this.attempt + 1;
    return Math.min(this.baseDelayMs * 2 ** this.attempt, this.maxDelayMs);
  }
}

export function withJitter(delayMs: number, random: () => number = Math.random): number {
  return Math.round(delayMs * (0.5 + random() * 0.5));
}

export function humanizeTransportError(error: Error, host: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  let reason: string;
  if (code === "ECONNREFUSED") reason = "connection refused";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN") reason = "host not found";
  else if (code === "ETIMEDOUT" || /timed out|timeout|ETIMEDOUT/i.test(error.message))
    reason = "timed out";
  else if (code === "ECONNRESET") reason = "connection reset";
  else if (code === "CERT_HAS_EXPIRED" || /certificate/i.test(error.message))
    reason = "TLS certificate verification failed";
  else reason = error.message;
  return `can't reach ${host} — ${reason}`;
}
