/** The most records, and bytes, a durable control inbox retains. */
export const INBOX_MAX_ENTRIES = 2_000;
export const INBOX_MAX_BYTES = 8 * 1024 * 1024;

function within(value: number, ceiling: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= ceiling;
}

/** Throws `message` unless both limits are whole numbers from 1 up to the inbox ceilings. */
export function assertInboxCapacity(maxEntries: number, maxBytes: number, message: string): void {
  if (!within(maxEntries, INBOX_MAX_ENTRIES) || !within(maxBytes, INBOX_MAX_BYTES)) throw new Error(message);
}
