import { performance } from "node:perf_hooks";

/**
 * Diagnostic only (D175): whole-log journal work long enough to hold the
 * connector's event loop. A 10-15 freeze sat in `structuredClone` for minutes
 * with no log naming the table; this names it, and the event-loop watch quotes
 * the last one when the loop stalls.
 */
export const SLOW_JOURNAL_WORK_MS = 250;

export interface SlowJournalWork {
  table: string;
  operation: "all" | "rewrite" | "compact";
  rows: number;
  ms: number;
  at: string;
}

let observer: ((work: SlowJournalWork) => void) | undefined;
let last: SlowJournalWork | undefined;

export function observeSlowJournalWork(next: ((work: SlowJournalWork) => void) | undefined): void {
  observer = next;
}

/** The most recent slow whole-log operation, if any. */
export function lastSlowJournalWork(): SlowJournalWork | undefined {
  return last;
}

function report(table: string, operation: SlowJournalWork["operation"], rows: number, started: number): void {
  const ms = Math.round(performance.now() - started);
  if (ms < SLOW_JOURNAL_WORK_MS) return;
  last = { table, operation, rows, ms, at: new Date().toISOString() };
  try { observer?.(last); } catch { /* diagnostics never fail the write */ }
}

export function timedJournalWork<R>(table: string, operation: SlowJournalWork["operation"], rows: number, work: () => R): R {
  const started = performance.now();
  try { return work(); } finally { report(table, operation, rows, started); }
}

export async function timedJournalWorkAsync<R>(table: string, operation: SlowJournalWork["operation"], rows: number, work: () => Promise<R>): Promise<R> {
  const started = performance.now();
  try { return await work(); } finally { report(table, operation, rows, started); }
}
