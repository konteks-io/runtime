import { spawnSync } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { z } from "zod";

/**
 * Read-only host utilization signals. Sysmon never writes anything and never
 * reports a path, hostname, address, or process list — only ratios and byte
 * counts the supervisor folds into `RuntimeUtilization` for D74 ranking.
 */
export const UtilizationSignalsSchema = z
  .object({
    cpuRatio: z.number().min(0).max(1),
    memoryRatio: z.number().min(0).max(1),
    diskFreeBytes: z.number().int().nonnegative(),
    diskTotalBytes: z.number().int().nonnegative(),
    loadAverage1m: z.number().nonnegative(),
    cpuCount: z.number().int().positive(),
    observedAt: z.string(),
  })
  .strict();
export type UtilizationSignals = z.infer<typeof UtilizationSignalsSchema>;

interface CpuSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

export class SignalSampler {
  private previous: CpuSnapshot = cpuSnapshot();
  private lastCpuRatio = 0;

  constructor(private readonly dataRoot: string) {}

  async sample(now: () => Date = () => new Date()): Promise<UtilizationSignals> {
    const current = cpuSnapshot();
    const totalDelta = current.total - this.previous.total;
    const idleDelta = current.idle - this.previous.idle;
    if (totalDelta > 0) {
      this.lastCpuRatio = clamp(1 - idleDelta / totalDelta);
    }
    this.previous = current;
    const total = totalmem();
    const memoryRatio = clamp(1 - availableMemoryBytes() / Math.max(total, 1));
    let diskFreeBytes = 0;
    let diskTotalBytes = 0;
    try {
      const stats = await statfs(this.dataRoot);
      diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
      diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
    } catch {
      // Disk figures stay 0 and the supervisor's doctor flags the root as unreadable.
    }
    return UtilizationSignalsSchema.parse({
      cpuRatio: this.lastCpuRatio,
      memoryRatio,
      diskFreeBytes: Math.floor(diskFreeBytes),
      diskTotalBytes: Math.floor(diskTotalBytes),
      loadAverage1m: loadavg()[0] ?? 0,
      cpuCount: Math.max(cpus().length, 1),
      observedAt: now().toISOString(),
    });
  }
}

/**
 * Memory a new bridge could actually use. `os.freemem()` counts only wholly
 * free pages, so a healthy Mac reports a few tens of megabytes and every
 * sample looks saturated; reclaimable page classes are available memory.
 */
export function availableMemoryBytes(readVmStat: () => string | null = darwinVmStat): number {
  if (process.platform === "darwin") {
    const parsed = parseDarwinAvailableBytes(readVmStat());
    if (parsed !== null) return parsed;
  }
  return freemem();
}

/** Reclaimable classes only: never `active`, `wired down`, or compressed pages. */
export function parseDarwinAvailableBytes(output: string | null): number | null {
  if (!output) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  let pages = 0;
  let matched = false;
  for (const name of ["free", "inactive", "speculative", "purgeable"]) {
    const value = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m").exec(output)?.[1];
    if (value === undefined) continue;
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return null;
    pages += count;
    matched = true;
  }
  if (!matched) return null;
  const bytes = pages * pageSize;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function darwinVmStat(): string | null {
  const result = spawnSync("/usr/bin/vm_stat", [], { encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024 });
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Folds host pressure into a single 0..1 headroom input. Active-session load is
 * added by the supervisor from runner state; sysmon only knows the host.
 */
export function hostPressureRatio(signals: UtilizationSignals): number {
  const loadRatio = clamp(signals.loadAverage1m / signals.cpuCount);
  return clamp(Math.max(signals.cpuRatio, signals.memoryRatio, loadRatio));
}
