import { freemem, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SignalSampler, UtilizationSignalsSchema, availableMemoryBytes, hostPressureRatio, parseDarwinAvailableBytes } from "../signals.js";

describe("sysmon signals", () => {
  it("samples bounded ratios and byte counts without any path or address", async () => {
    const sampler = new SignalSampler(tmpdir());
    const signals = await sampler.sample(() => new Date("2026-09-06T00:00:00Z"));
    expect(UtilizationSignalsSchema.safeParse(signals).success).toBe(true);
    expect(Object.keys(signals).sort()).toEqual([
      "cpuCount",
      "cpuRatio",
      "diskFreeBytes",
      "diskTotalBytes",
      "loadAverage1m",
      "memoryRatio",
      "observedAt",
    ]);
  });

  it("host pressure is the max of cpu, memory, and normalized load, clamped to 1", () => {
    expect(
      hostPressureRatio({
        cpuRatio: 0.2,
        memoryRatio: 0.9,
        diskFreeBytes: 1,
        diskTotalBytes: 1,
        loadAverage1m: 16,
        cpuCount: 4,
        observedAt: "t",
      }),
    ).toBe(1);
    expect(
      hostPressureRatio({
        cpuRatio: 0.2,
        memoryRatio: 0.3,
        diskFreeBytes: 1,
        diskTotalBytes: 1,
        loadAverage1m: 1,
        cpuCount: 4,
        observedAt: "t",
      }),
    ).toBe(0.3);
  });
});

describe("available memory on macOS", () => {
  const sample = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                     3537.",
    "Pages active:                                  71905.",
    "Pages inactive:                                65194.",
    "Pages speculative:                              5804.",
    "Pages wired down:                             152517.",
    "Pages purgeable:                                  10.",
  ].join("\n");

  it("counts reclaimable page classes, never active, wired or compressed pages", () => {
    // free + inactive + speculative + purgeable = 74545 pages of 16 KiB.
    expect(parseDarwinAvailableBytes(sample)).toBe(74545 * 16384);
    expect(availableMemoryBytes(() => sample)).toBe(74545 * 16384);
  });

  it("falls back to the wholly free figure rather than inventing headroom", () => {
    for (const broken of [null, "", "Pages free: not-a-number.", "(page size of 16384 bytes)\nPages active: 5."]) {
      expect(parseDarwinAvailableBytes(broken)).toBeNull();
    }
    expect(availableMemoryBytes(() => null)).toBe(freemem());
  });
});
