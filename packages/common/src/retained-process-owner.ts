import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { RemoteInstanceError } from "./errors.js";

export interface ProcessIdentity {
  pid: number;
  processGroupId: number;
  startToken: string;
  commandDigest: string;
}

/** Durable handle for one process-group leader. It is stop evidence only and
 * never establishes tool/MCP quiescence or permits execution-slot release. */
export interface RetainedProcessOwner extends ProcessIdentity {
  version: 1;
  platform: "darwin";
}

interface CaptureOptions {
  platform?: NodeJS.Platform;
  readIdentity?: (pid: number) => ProcessIdentity | null;
}

interface StopOptions extends CaptureOptions {
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  groupAlive?: (processGroupId: number) => boolean;
  pause?: (ms: number) => Promise<void>;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}

export function captureRetainedProcessOwner(pid: number, options: CaptureOptions = {}): RetainedProcessOwner {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new RemoteInstanceError("recovery_required", `Durable execution-process rehydration is not available on ${platform}.`);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw invalidOwner("Bridge PID is invalid.");
  const identity = (options.readIdentity ?? readDarwinProcessIdentity)(pid);
  if (!identity) throw invalidOwner("Bridge process identity cannot be captured.");
  if (identity.pid !== pid || identity.processGroupId !== pid) throw invalidOwner("Bridge is not its exact process-group leader.");
  return { version: 1, platform: "darwin", ...identity };
}

export async function stopRetainedProcessOwner(owner: RetainedProcessOwner, options: StopOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || owner.platform !== "darwin") throw invalidOwner(`Durable execution-process rehydration is not available on ${platform}.`);
  const read = options.readIdentity ?? readDarwinProcessIdentity;
  const observed = read(owner.pid);
  const signal = options.signal ?? ((pid, value) => process.kill(pid, value));
  const groupAlive = options.groupAlive ?? ((pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } });
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!observed) {
    // The leader is gone. That alone is not stop proof — a descendant could
    // have survived it — so require the same evidence the stop wait accepts:
    // the whole process group is absent. A reused PID is refused below.
    if (groupAlive(owner.processGroupId)) throw invalidOwner("Retained bridge leader is absent while its process group survives; absence is not stop proof.");
    return;
  }
  if (!sameIdentity(owner, observed)) throw invalidOwner("Retained bridge identity changed; refusing to signal a reused process identity.");
  signal(owner.pid, "SIGTERM");
  if (await waitUntilStopped(owner, read, groupAlive, pause, options.termTimeoutMs ?? 5_000)) return;
  // The group signal is authorized only after the exact leader identity was
  // positively matched above. It does not rely on a PID file or root lock.
  try { signal(-owner.processGroupId, "SIGKILL"); } catch { /* verified below */ }
  if (await waitUntilStopped(owner, read, groupAlive, pause, options.killTimeoutMs ?? 2_000)) return;
  throw invalidOwner("Retained bridge process-group exit remains unconfirmed.");
}

export function readDarwinProcessIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "state=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]+)$/);
  if (!match) return null;
  const [, pidText, groupText, state, startToken, command] = match;
  if (state!.startsWith("Z")) return null;
  return { pid: Number(pidText), processGroupId: Number(groupText), startToken: startToken!, commandDigest: createHash("sha256").update(command!).digest("base64url") };
}

async function waitUntilStopped(owner: RetainedProcessOwner, read: (pid: number) => ProcessIdentity | null, groupAlive: (pgid: number) => boolean, pause: (ms: number) => Promise<void>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = read(owner.pid);
    if (current && !sameIdentity(owner, current)) throw invalidOwner("Retained bridge identity changed while stopping.");
    if (!current && !groupAlive(owner.processGroupId)) return true;
    await pause(Math.min(50, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.processGroupId === b.processGroupId && a.startToken === b.startToken && a.commandDigest === b.commandDigest;
}
function invalidOwner(message: string): RemoteInstanceError { return new RemoteInstanceError("recovery_required", message); }
