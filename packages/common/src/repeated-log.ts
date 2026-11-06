import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import pino from "pino";

const WINDOW_MS = 10_000;
const MAX_ENTRIES = 32;
const MAX_LINE_BYTES = 16 * 1024;
type Sink = Pick<ReturnType<typeof pino.destination>, "write" | "flush" | "flushSync">;
interface RepeatedEntry { line: string; firstAt: number; lastAt: number; openedAt: number; suppressed: number }
interface Candidate { key: string; line: string; time: number }

/** Only Pino's generated timestamp is removed; every serialized context field stays in the key. */
function candidate(line: string): Candidate | null {
  const prefix = /^(\{"level":(40|50)),"time":(\d+),/.exec(line);
  if (!prefix || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return null;
  const normalized = `${prefix[1]},${line.slice(prefix[0].length)}`;
  if (!ordinaryEvent(normalized, Number(prefix[2]))) return null;
  return { key: createHash("sha256").update(normalized).digest("hex"), line: normalized, time: Number(prefix[3]) };
}

function ordinaryEvent(line: string, level: number): boolean {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    // A caller's explicit time or repetition metadata is meaningful input.
    return event.level === level && !Object.hasOwn(event, "time") && !Object.hasOwn(event, "runtimeLogRepetition");
  } catch { return false; }
}

/** Input is already serialized and redacted by createLogger; raw provider data never enters this cache. */
export class RepeatedLogOutput {
  private readonly entries = new Map<string, RepeatedEntry>();
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly sink: Sink) {}

  write(line: string): void {
    const event = candidate(line);
    if (!event) { this.sink.write(line); return; }
    const previous = this.entries.get(event.key);
    if (previous && performance.now() - previous.openedAt < WINDOW_MS) {
      previous.suppressed++; previous.lastAt = event.time;
      this.schedule(); return;
    }
    if (previous) this.release(event.key, previous);
    this.makeRoom();
    this.entries.set(event.key, { line: event.line, firstAt: event.time, lastAt: event.time, openedAt: performance.now(), suppressed: 0 });
    this.sink.write(line);
  }

  flush(callback?: (error?: Error) => unknown): void {
    this.summarize(); this.sink.flush(callback);
  }

  flushSync(): void {
    this.summarize(); this.sink.flushSync();
  }

  private makeRoom(): void {
    if (this.entries.size < MAX_ENTRIES) return;
    const oldest = this.entries.entries().next().value;
    if (oldest) this.release(oldest[0], oldest[1]);
  }

  private release(key: string, entry: RepeatedEntry): void {
    this.entries.delete(key);
    if (entry.suppressed === 0) return;
    const original = entry.line.trimEnd();
    const repetition = { suppressed: entry.suppressed, firstAt: entry.firstAt, lastAt: entry.lastAt };
    this.sink.write(`${original.slice(0, -1)},"time":${Date.now()},"runtimeLogRepetition":${JSON.stringify(repetition)}}\n`);
  }

  private summarize(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const [key, entry] of this.entries) this.release(key, entry);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WINDOW_MS);
    this.timer.unref();
  }
}

let sharedOutput: RepeatedLogOutput | undefined;
/** One bounded cache and exit handler per process, shared by all named and child loggers. */
export function repeatedLogOutput(): RepeatedLogOutput {
  if (!sharedOutput) {
    const output = new RepeatedLogOutput(pino.destination(1));
    sharedOutput = output;
    const finish = () => { try { output.flushSync(); } catch { /* A closed diagnostic pipe must not prevent exit. */ } };
    process.prependListener("beforeExit", finish);
    process.prependListener("exit", finish);
  }
  return sharedOutput;
}
