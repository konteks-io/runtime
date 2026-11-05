import { afterEach, expect, it, vi } from "vitest";
import { RepeatedLogOutput } from "../repeated-log.js";

const outputs: RepeatedLogOutput[] = [];
afterEach(() => { for (const output of outputs.splice(0)) output.flushSync(); vi.useRealTimers(); });
function fixture() {
  const lines: string[] = [];
  const output = new RepeatedLogOutput({ write: line => { lines.push(line); return true; }, flush: callback => { callback?.(); }, flushSync: () => undefined });
  outputs.push(output);
  const entries = () => lines.map(line => JSON.parse(line) as { code?: number; runtimeLogRepetition?: { suppressed: number; firstAt: number; lastAt: number } });
  return { output, lines, entries };
}
const line = (code: number, time = Date.now()) => JSON.stringify({ level: 50, time, name: "fixture", code, msg: "refused" }) + "\n";

it("bounds retained patterns by summarizing evictions without losing their counts", () => {
  const f = fixture();
  for (let code = 0; code < 40; code++) { f.output.write(line(code)); f.output.write(line(code)); }
  expect(f.entries().filter(entry => entry.runtimeLogRepetition)).toHaveLength(8);
  f.output.flushSync();
  const summaries = f.entries().filter(entry => entry.runtimeLogRepetition);
  expect(summaries).toHaveLength(40);
  expect(summaries.reduce((count, entry) => count + entry.runtimeLogRepetition!.suppressed, 0)).toBe(40);
  expect(new Set(summaries.map(entry => entry.code)).size).toBe(40);
});

it("summarizes a live burst after ten seconds and releases its timer", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.output.write(line(1, 1)); f.output.write(line(1, 2)); f.output.write(line(1, 3));
  expect(f.lines).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(10_000);
  expect(f.entries()[1]).toMatchObject({ runtimeLogRepetition: { suppressed: 2, firstAt: 1, lastAt: 3 } });
  expect(vi.getTimerCount()).toBe(0);
  f.output.write(line(1, 4)); expect(f.lines).toHaveLength(3);
});

it("does not retain oversized or unstructured output", () => {
  const f = fixture();
  const large = JSON.stringify({ level: 50, time: 1, msg: "x".repeat(20 * 1024) }) + "\n";
  for (const value of [large, large, "native diagnostic\n", "native diagnostic\n"]) f.output.write(value);
  f.output.flushSync();
  expect(f.lines).toEqual([large, large, "native diagnostic\n", "native diagnostic\n"]);
});
