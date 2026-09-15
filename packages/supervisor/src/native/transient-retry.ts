import type { Logger } from "@konteks/remote-common";

/** One initial attempt followed by the required minimum of three retries. */
export const NATIVE_TRANSIENT_MAX_ATTEMPTS = 4;
export const NATIVE_TRANSIENT_BASE_DELAY_MS = 100;

export type NativeTransientClassification = "transport" | "timeout" | "rate_limited" | "upstream" | "response_body" | "credential_rotated";

export function transientHttpClassification(status: number): NativeTransientClassification | null {
  if (status === 408) return "timeout";
  if (status === 425) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return null;
}

export async function waitForNativeRetry(options: {
  logger: Logger;
  operation: string;
  attempt: number;
  classification: NativeTransientClassification;
  status?: number;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  baseDelayMs?: number | undefined;
  random?: () => number;
}): Promise<void> {
  const exponentialDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? NATIVE_TRANSIENT_BASE_DELAY_MS)) * 2 ** (options.attempt - 1);
  const jitterFactor = 0.75 + Math.min(1, Math.max(0, (options.random ?? Math.random)())) * 0.5;
  const delayMs = Math.max(1, Math.floor(exponentialDelayMs * jitterFactor));
  options.logger.warn({ operation: options.operation, attempt: options.attempt, retry: options.attempt,
    maxAttempts: NATIVE_TRANSIENT_MAX_ATTEMPTS, maxRetries: NATIVE_TRANSIENT_MAX_ATTEMPTS - 1,
    delayMs, classification: options.classification, ...(options.status === undefined ? {} : { status: options.status }) },
  "transient native transport request failed; retrying");
  await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delayMs);
}

export function logNativeRetryExhausted(options: {
  logger: Logger;
  operation: string;
  classification: NativeTransientClassification;
  status?: number;
}): void {
  options.logger.error({ operation: options.operation, attempt: NATIVE_TRANSIENT_MAX_ATTEMPTS,
    retries: NATIVE_TRANSIENT_MAX_ATTEMPTS - 1, maxAttempts: NATIVE_TRANSIENT_MAX_ATTEMPTS,
    maxRetries: NATIVE_TRANSIENT_MAX_ATTEMPTS - 1, classification: options.classification,
    ...(options.status === undefined ? {} : { status: options.status }) }, "transient native transport request retry exhausted");
}
