import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * Processes a host agent left behind, found by the private home in their own
 * environment: a process counts only when its command names one of the
 * agent's programs AND its `HOME` is exactly the connector's private home, so
 * the person's own copies of the same program are never touched. Linux reads
 * `/proc/<pid>/environ`, macOS `ps eww` (the environment follows the
 * command); Windows has no reliable reading and is skipped.
 */
export interface PrivateHomeProcesses {
  list(home: string, programs: readonly string[]): Promise<number[]>;
  /** SIGTERM, then SIGKILL; resolves once every one is gone. */
  stop(pids: number[]): Promise<void>;
}

export function privateHomeProcesses(platform: NodeJS.Platform = process.platform): PrivateHomeProcesses {
  return {
    async list(home, programs) {
      if (platform === "win32") return [];
      const listing = await capture("ps", platform === "linux" ? ["-e", "-ww", "-o", "pid=,args="] : ["-axww", "-o", "pid=,command="]).catch(() => "");
      const pids: number[] = [];
      for (const line of listing.split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match || !programs.some(program => match[2]!.includes(program))) continue;
        const pid = Number(match[1]);
        if (pid === process.pid) continue;
        const env = await processEnvironment(pid, platform);
        if (env !== null && hasHome(env, home)) pids.push(pid);
      }
      return pids;
    },
    async stop(pids) {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } }
        for (let wait = 0; wait < 50 && pids.some(alive); wait += 1) await new Promise(resolve => setTimeout(resolve, 100));
        if (!pids.some(alive)) return;
      }
      throw new RemoteInstanceError("agent_unavailable", "A process this connector started did not stop.", { diagnostic: "host_agent_leftover_stop_failed", retryable: true });
    },
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function processEnvironment(pid: number, platform: NodeJS.Platform): Promise<string[] | string | null> {
  if (platform === "linux") {
    try { return (await readFile(`/proc/${pid}/environ`, "utf8")).split("\u0000"); } catch { return null; }
  }
  const text = await capture("ps", ["eww", "-o", "command=", "-p", String(pid)]).catch(() => "");
  return text.trim() === "" ? null : text.trim();
}

/** `HOME=<home>` exactly: in `ps eww` text an assignment is followed by a space or the end (paths may hold spaces). */
function hasHome(env: string[] | string, home: string): boolean {
  const assignment = `HOME=${home}`;
  if (Array.isArray(env)) return env.includes(assignment);
  return env.includes(` ${assignment} `) || env.endsWith(` ${assignment}`);
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error && !stdout ? reject(error) : resolve(String(stdout))));
  });
}
