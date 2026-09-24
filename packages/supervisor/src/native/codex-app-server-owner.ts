import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { dirname, isAbsolute } from "node:path";
import {
  RemoteInstanceError,
  spawnPiped,
  stopProcessGroupLeaderFirst,
  type PipedChildProcess,
} from "@konteks/remote-common";
import {
  bridgeEnvironment,
  resolveBridgeFamily,
  resolveToolingCommand,
  verifyNativeRunnerPackage,
  type RunnerConfig,
} from "@konteks/remote-agent-runner";

const DEFAULT_RESTART_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const;

export interface NativeCodexAppServerOwnerOptions {
  config: RunnerConfig;
  spawn?: typeof spawnPiped;
  stop?: typeof stopProcessGroupLeaderFirst;
  prepareSocket?: typeof prepareCodexSocket;
  socketAvailable?: (socketPath: string) => Promise<boolean>;
  adoptedPollMs?: number;
  waitUntilReady?: typeof waitForCodexSocket;
  cleanupSocket?: typeof cleanupCodexSocket;
  verifyPackage?: typeof verifyNativeRunnerPackage;
  restartDelaysMs?: readonly number[];
  onRestartFailure?: (error: unknown) => void;
  /** Who holds the shared socket; tests replace the lsof/ps lookup. */
  socketHolder?: (socketPath: string) => Promise<CodexSocketHolder | null>;
  /** Stop a stale server's process group; tests replace the signals. */
  stopHolder?: (pid: number) => Promise<void>;
  onStaleReplaced?: (event: { pid: number; staleRelease: string; currentRelease: string }) => void;
}

export interface CodexSocketHolder { pid: number; command: string }

/**
 * One supervisor-owned Codex app-server shared by every local ACP bridge.
 * Bridge/session restarts only replace clients; they never own this process.
 */
export class NativeCodexAppServerOwner {
  private child: PipedChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private adoptedTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private stopping = false;
  private generation = 0;

  constructor(private readonly options: NativeCodexAppServerOwnerOptions) {
    const { config } = options;
    if (process.platform === "win32" || config.RUNNER_AGENT_ID !== "codex" || config.RUNNER_AUTH_MODE !== "agent_local_subscription" ||
        !config.RUNNER_NATIVE_PACKAGE_PROFILE?.codexLocalProxy || !config.RUNNER_NATIVE_CODEX_HOME || !config.RUNNER_NATIVE_CODEX_SOCKET ||
        !isAbsolute(config.RUNNER_NATIVE_CODEX_HOME) || !isAbsolute(config.RUNNER_NATIVE_CODEX_SOCKET)) {
      throw unavailable("Shared Codex ownership requires the signed native Codex profile and private Unix socket.");
    }
  }

  private exitReaper: (() => void) | null = null;

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(unavailable("The shared Codex owner is stopping."));
    // A failed start is not remembered: the supervisor tries a Codex that
    // could not start again later (WS1-018), and that try must spawn afresh.
    this.startPromise ??= this.spawnAndAwaitReady().catch(error => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  /**
   * A stop was asked for (WS1-042). The app-server runs in its own process
   * group and listens on a socket, so it deliberately outlives a connector
   * crash for the next start to adopt; but once the connector is being
   * stopped, a shutdown that ends the process before reaching `stop()` — the
   * daemon's exit watchdog — must not leave it running with nobody to own it.
   */
  shutdownRequested(): void {
    if (this.exitReaper) return;
    this.exitReaper = () => {
      const pid = this.child?.pid;
      if (!pid) return;
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    };
    process.once("exit", this.exitReaper);
  }

  async stop(): Promise<void> {
    this.shutdownRequested();
    this.stopping = true;
    this.generation++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    this.restartTimer = null;
    this.stableTimer = null;
    this.adoptedTimer = null;
    await this.startPromise?.catch(() => undefined);
    const child = this.child;
    this.child = null;
    if (child) await (this.options.stop ?? stopProcessGroupLeaderFirst)({ child, timeoutMs: 5_000, killGraceMs: 2_000 });
    await (this.options.cleanupSocket ?? cleanupCodexSocket)(this.options.config.RUNNER_NATIVE_CODEX_SOCKET!);
    if (this.exitReaper) process.removeListener("exit", this.exitReaper);
    this.exitReaper = null;
  }

  private async spawnAndAwaitReady(): Promise<void> {
    const generation = ++this.generation;
    const { config } = this.options;
    const socketPath = config.RUNNER_NATIVE_CODEX_SOCKET!;
    const codexHome = config.RUNNER_NATIVE_CODEX_HOME!;
    await (this.options.verifyPackage ?? verifyNativeRunnerPackage)(config);
    let socketMode = await (this.options.prepareSocket ?? prepareCodexSocket)(socketPath);
    if (this.stopping || generation !== this.generation) throw unavailable("The shared Codex owner stopped during startup.");
    const family = resolveBridgeFamily("codex");
    const command = resolveToolingCommand(config, family, ["codex", "app-server", "--listen", `unix://${socketPath}`]);
    if (socketMode === "adopt" && await this.replaceStaleRelease(socketPath, command.command)) socketMode = "spawn";
    if (this.stopping || generation !== this.generation) throw unavailable("The shared Codex owner stopped during startup.");
    if (socketMode === "adopt") {
      this.watchAdoptedSocket(socketPath, generation);
      return;
    }

    const child = (this.options.spawn ?? spawnPiped)({
      ...command,
      cwd: codexHome,
      env: bridgeEnvironment(config, family),
      detached: true,
    });
    this.child = child;
    child.stdout.resume();
    child.stderr.resume();
    let rejectStartup!: (error: unknown) => void;
    const startupExit = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    const exitedDuringStartup = () => rejectStartup(unavailable("The signed Codex app-server exited during startup."));
    child.once("exit", exitedDuringStartup);
    child.once("error", exitedDuringStartup);
    try {
      await Promise.race([(this.options.waitUntilReady ?? waitForCodexSocket)(socketPath, child), startupExit]);
      if (this.stopping || generation !== this.generation || this.child !== child) throw unavailable("The shared Codex owner exited during startup.");
      const exited = () => this.onExit(child, generation);
      child.once("exit", exited);
      child.once("error", exited);
      child.removeListener("exit", exitedDuringStartup);
      child.removeListener("error", exitedDuringStartup);
      this.stableTimer = setTimeout(() => { this.restartAttempt = 0; this.stableTimer = null; }, 60_000);
      this.stableTimer.unref();
    } catch (error) {
      if (this.child === child) this.child = null;
      child.removeListener("exit", exitedDuringStartup);
      child.removeListener("error", exitedDuringStartup);
      await (this.options.stop ?? stopProcessGroupLeaderFirst)({ child, timeoutMs: 5_000, killGraceMs: 2_000 });
      await (this.options.cleanupSocket ?? cleanupCodexSocket)(socketPath);
      throw error;
    }
  }

  /**
   * A live socket is adopted only from this connector's current release. A
   * server left running by an older release of the same connector keeps the
   * sign-in it read when it started: after the account signed in again it
   * can no longer refresh its token, and every Codex turn failed
   * "unauthorized" while the socket still looked healthy (WS2-141). Such a
   * server is stopped and a fresh one reads the current sign-in. A holder
   * that is not one of this connector's releases is never touched.
   */
  private async replaceStaleRelease(socketPath: string, currentCommand: string): Promise<boolean> {
    const current = releaseOf(currentCommand);
    if (!current) return false;
    const holder = await (this.options.socketHolder ?? findCodexSocketHolder)(socketPath).catch(() => null);
    const stale = holder ? releaseOf(holder.command) : null;
    if (!holder || !stale || stale.releasesDir !== current.releasesDir || stale.release === current.release) return false;
    await (this.options.stopHolder ?? stopProcessGroup)(holder.pid);
    await (this.options.cleanupSocket ?? cleanupCodexSocket)(socketPath);
    this.options.onStaleReplaced?.({ pid: holder.pid, staleRelease: stale.release, currentRelease: current.release });
    return true;
  }

  /** A healthy same-user socket is local-user authority and can survive a
   * connector restart. Polling retains supervision without spawning a racing
   * second server; loss atomically returns to the normal signed spawn path. */
  private watchAdoptedSocket(socketPath: string, generation: number): void {
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    this.adoptedTimer = setInterval(() => {
      if (this.stopping || generation !== this.generation || !this.adoptedTimer) return;
      void (this.options.socketAvailable ?? canConnect)(socketPath).then(available => {
        if (available || this.stopping || generation !== this.generation) return;
        if (this.adoptedTimer) clearInterval(this.adoptedTimer);
        this.adoptedTimer = null;
        this.spawnAndAwaitReady().catch(error => {
          this.options.onRestartFailure?.(error);
          if (!this.stopping) this.onExitRetry();
        });
      });
    }, this.options.adoptedPollMs ?? 2_000);
    this.adoptedTimer.unref();
  }

  private onExit(child: PipedChildProcess, generation: number): void {
    if (this.child !== child || generation !== this.generation) return;
    this.child = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (this.stopping) return;
    const delays = this.options.restartDelaysMs?.length ? this.options.restartDelaysMs : DEFAULT_RESTART_DELAYS_MS;
    const delay = delays[Math.min(this.restartAttempt++, delays.length - 1)]!;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnAndAwaitReady().catch(error => {
        this.options.onRestartFailure?.(error);
        if (!this.stopping) this.onExitRetry();
      });
    }, delay);
    this.restartTimer.unref();
  }

  private onExitRetry(): void {
    if (this.stopping) return;
    const delays = this.options.restartDelaysMs?.length ? this.options.restartDelaysMs : DEFAULT_RESTART_DELAYS_MS;
    const delay = delays[Math.min(this.restartAttempt++, delays.length - 1)]!;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnAndAwaitReady().catch(error => { this.options.onRestartFailure?.(error); this.onExitRetry(); });
    }, delay);
    this.restartTimer.unref();
  }
}

export async function prepareCodexSocket(socketPath: string): Promise<"spawn" | "adopt"> {
  validatePath(socketPath);
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const canonical = await realpath(directory);
  if (canonical !== directory || !info.isDirectory() || info.uid !== process.getuid?.()) throw unavailable("The shared Codex socket directory must be private and owned by the local user.");
  await chmod(directory, 0o700);
  const existing = await lstat(socketPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return "spawn";
  if (!existing.isSocket() || !privateOwner(existing)) throw unavailable("The shared Codex socket path is not a private local-user socket.");
  if (await canConnect(socketPath)) return "adopt";
  await unlink(socketPath);
  return "spawn";
}

export async function waitForCodexSocket(socketPath: string, child: PipedChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw unavailable("The signed Codex app-server exited before its socket became ready.");
    const info = await lstat(socketPath).catch(() => null);
    if (info?.isSocket() && info.uid === process.getuid?.() && await canConnect(socketPath)) {
      await chmod(socketPath, 0o600);
      const secured = await lstat(socketPath);
      if (secured.isSocket() && privateOwner(secured)) return;
      throw unavailable("The shared Codex socket could not be secured.");
    }
    await pause(100);
  }
  throw unavailable("The signed Codex app-server did not become ready in time.");
}

export async function cleanupCodexSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch(() => null);
  if (!info?.isSocket() || !privateOwner(info)) return;
  // Never unlink a same-user server that won a race after our process stopped.
  if (!await canConnect(socketPath)) await unlink(socketPath).catch(() => undefined);
}

function validatePath(path: string): void {
  if (process.platform === "win32" || !isAbsolute(path) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) throw unavailable("The shared Codex socket path is invalid.");
}

function privateOwner(info: { mode: number; uid: number }): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

function canConnect(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const done = (connected: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(connected); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function pause(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function unavailable(message: string): RemoteInstanceError { return new RemoteInstanceError("agent_unavailable", message); }

/** `…/releases/<release>/…` → the releases folder and the release name. */
export function releaseOf(command: string): { releasesDir: string; release: string } | null {
  const match = /^(.*\/releases\/)([^/]+)\//.exec(command);
  return match ? { releasesDir: match[1]!, release: match[2]! } : null;
}

const run = promisify(execFile);

/** The Codex app-server process listening on the shared socket, if it can be told. */
export async function findCodexSocketHolder(socketPath: string): Promise<CodexSocketHolder | null> {
  const { stdout } = await run("lsof", ["-t", socketPath], { timeout: 5_000 });
  for (const pid of stdout.split(/\s+/).map(Number).filter(value => Number.isSafeInteger(value) && value > 0)) {
    const { stdout: command } = await run("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 });
    if (/\bcodex\b.*\bapp-server\b/.test(command)) return { pid, command: command.trim() };
  }
  return null;
}

async function stopProcessGroup(pid: number): Promise<void> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The server runs in its own group (detached spawn); end the group, as a stop does.
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { return; } }
  for (let waited = 0; waited < 5_000 && alive(); waited += 100) await pause(100);
  if (alive()) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}
