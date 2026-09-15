import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Subprocess-tree lifecycle (adapted from bb `packages/process-utils`). A
 * bridge or official login tool is spawned as a process-group leader so its
 * grandchildren die with it; termination is leader-first, then the surviving
 * group, then SIGKILL after the grace period.
 */
export interface SpawnRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: StdioOptions;
}

export interface PipedChildProcess extends ChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export function spawnPiped(request: SpawnRequest): PipedChildProcess {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    detached: request.detached ?? supportsProcessGroups(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("child process did not attach piped stdio");
  }
  return child as PipedChildProcess;
}

export function supportsProcessGroups(): boolean {
  return process.platform !== "win32";
}

export function killProcessGroup(child: { pid?: number | undefined; kill(signal: NodeJS.Signals): unknown }, signal: NodeJS.Signals): void {
  if (supportsProcessGroups() && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  child.kill(signal);
}

export function isProcessGroupAlive(child: { pid?: number | undefined }): boolean {
  if (!supportsProcessGroups() || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

const PROCESS_GROUP_EXIT_POLL_MS = 100;

export function stopProcessGroupLeaderFirst(args: {
  child: ChildProcess;
  timeoutMs: number;
  killGraceMs: number;
}): Promise<void> {
  const { child, timeoutMs, killGraceMs } = args;
  if (hasChildExited(child) && !isProcessGroupAlive(child)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveStop) => {
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (poll !== undefined) clearInterval(poll);
      resolveStop();
    };
    const groupGone = (): boolean => hasChildExited(child) && !isProcessGroupAlive(child);
    const softTimer = setTimeout(() => {
      if (groupGone()) {
        finish();
        return;
      }
      killProcessGroup(child, "SIGKILL");
      if (killGraceMs <= 0) {
        finish();
        return;
      }
      hardTimer = setTimeout(finish, killGraceMs);
    }, timeoutMs);

    const stopSurvivingMembers = (): void => {
      if (!isProcessGroupAlive(child)) {
        finish();
        return;
      }
      killProcessGroup(child, "SIGTERM");
      poll = setInterval(() => {
        if (!isProcessGroupAlive(child)) finish();
      }, PROCESS_GROUP_EXIT_POLL_MS);
    };

    if (hasChildExited(child)) {
      stopSurvivingMembers();
      return;
    }
    child.once("exit", stopSurvivingMembers);
    child.kill("SIGTERM");
  });
}

const INHERITED_ENV_DENYLIST = [
  /^KONTEKS_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^GOOGLE_/i,
  /^GEMINI_/i,
  /^DEEPSEEK_/i,
  /^AWS_/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_API_KEY$/i,
  /^NODE_OPTIONS$/,
];

/**
 * A child (bridge, login tool, Compose) receives only the environment it is
 * meant to see. Provider keys, activation material, and supervisor secrets are
 * removed by name; callers add exactly the variables a bridge documents.
 */
export function sanitizeInheritedChildProcessEnv(args: {
  env: NodeJS.ProcessEnv;
  allow?: readonly string[];
}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(args.env)) {
    if (value === undefined) continue;
    if (args.allow?.includes(name)) {
      out[name] = value;
      continue;
    }
    if (INHERITED_ENV_DENYLIST.some((pattern) => pattern.test(name))) continue;
    out[name] = value;
  }
  return out;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;

/** Run a command to completion with bounded, in-memory output capture. */
export function runCommand(
  request: SpawnRequest & { timeoutMs?: number; input?: string; outputCapBytes?: number },
): Promise<CommandResult> {
  const cap = request.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  return new Promise<CommandResult>((resolve, reject) => {
    let child: PipedChildProcess;
    try {
      child = spawnPiped(request);
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < cap) stdout.push(chunk.subarray(0, cap - stdoutBytes));
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < cap) stderr.push(chunk.subarray(0, cap - stderrBytes));
      stderrBytes += chunk.length;
    });
    const timer =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            void stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
          }, request.timeoutMs);
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (request.input !== undefined) child.stdin.write(request.input);
    child.stdin.end();
  });
}
