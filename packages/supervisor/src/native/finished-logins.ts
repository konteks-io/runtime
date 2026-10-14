import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeAgentLoginReportSchema, isFsErrorWithCode, writeSecretFile, type Logger } from "@konteks/remote-common";
import type { StateMutation } from "../state/mutation-gate.js";

export type FinishedLoginReport = ReturnType<typeof RuntimeAgentLoginReportSchema.parse>;

interface FinishedLogin {
  /** Epoch milliseconds the sign-in ended here. */
  finishedAt: number;
  report: FinishedLoginReport;
}

/** How many ended sign-ins are remembered, and for how long. */
export const FINISHED_LOGIN_LIMIT = 200;
export const FINISHED_LOGIN_WINDOW_MS = 24 * 60 * 60_000;

const FILE_NAME = "finished-logins.json";

/**
 * Sign-ins that ended on this computer, with the report that ended them: the
 * last 200 within a day. Core re-sends a person's sign-in until its report
 * arrives, so a late copy of one that already ended answers with that same
 * report instead of starting it again. Kept on disk, because adding an agent
 * on the computer restarts this connector.
 */
export class FinishedLogins {
  private entries: FinishedLogin[] | null = null;
  /** One read of the file, shared by every caller that arrives before it ends. */
  private loading: Promise<FinishedLogin[]> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: { dataDir: string; now: () => number; logger: Logger; mutate: StateMutation }) {}

  /** The terminal report of a sign-in that ended here, once every earlier record is in. */
  async get(loginId: string): Promise<FinishedLoginReport | undefined> {
    await this.writes;
    return this.current(await this.load()).find(entry => entry.report.loginId === loginId)?.report;
  }

  /** Remembers a report that ends a sign-in (succeeded or failed); any other report is ignored. */
  record(report: FinishedLoginReport): void {
    if (report.state !== "succeeded" && report.state !== "failed") return;
    const finishedAt = this.options.now();
    this.writes = this.writes
      .then(async () => {
        const kept = (await this.load()).filter(entry => entry.report.loginId !== report.loginId);
        this.entries = this.current([...kept, { finishedAt, report }]);
        const text = `${JSON.stringify({ logins: this.entries })}\n`;
        await this.options.mutate(() => writeSecretFile(this.path(), text));
      })
      .catch(error => this.options.logger.warn({ err: error, loginId: report.loginId }, "ended sign-in not kept across a restart"));
  }

  private async load(): Promise<FinishedLogin[]> {
    if (this.entries) return this.entries;
    this.loading ??= this.read().then(entries => { this.entries ??= this.current(entries); return this.entries; });
    return this.loading;
  }

  /** Every well-formed record on disk; a missing or damaged file is an empty list. */
  private async read(): Promise<FinishedLogin[]> {
    try {
      const logins = (JSON.parse(await readFile(this.path(), "utf8")) as { logins?: unknown }).logins;
      return Array.isArray(logins) ? logins.flatMap(wellFormed) : [];
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) this.options.logger.warn({ err: error }, "ended sign-ins could not be read; starting without them");
      return [];
    }
  }

  /** Within the window, newest last, at most the limit. */
  private current(entries: FinishedLogin[]): FinishedLogin[] {
    const since = this.options.now() - FINISHED_LOGIN_WINDOW_MS;
    return entries.filter(entry => entry.finishedAt > since).slice(-FINISHED_LOGIN_LIMIT);
  }

  private path(): string {
    return join(this.options.dataDir, FILE_NAME);
  }
}

function wellFormed(value: unknown): FinishedLogin[] {
  const { finishedAt, report } = (typeof value === "object" && value !== null ? value : {}) as { finishedAt?: unknown; report?: unknown };
  const parsed = RuntimeAgentLoginReportSchema.safeParse(report);
  return typeof finishedAt === "number" && parsed.success ? [{ finishedAt, report: parsed.data }] : [];
}
