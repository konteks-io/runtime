import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { dirname, isAbsolute, join } from "node:path";
import {
  RemoteInstanceError,
  isProcessGroupAlive,
  withoutUndefined,
  spawnPiped,
  stopProcessGroupLeaderFirst,
  type PipedChildProcess,
} from "@konteks/remote-common";
import {
  bridgeEnvironment,
  resolveBridgeFamily,
  resolveToolingCommand,
  verifyNativeRunnerPackage,
  assertCodexThreadsIdle,
  codexLoadedThreadStatuses,
  resolveCodexSocket,
  type RunnerConfig,
} from "@konteks/remote-agent-runner";
import { resolveNativeCodexSocket } from "./installation.js";
import { resolveNativeCodexHome } from "./codex-home.js";

const DEFAULT_RESTART_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const;

export interface NativeCodexAppServerOwnerOptions {
  config: RunnerConfig;
  spawn?: typeof spawnPiped;
  stop?: typeof stopProcessGroupLeaderFirst;
  /** Exact child group check after bounded stop; tests can model a surviving group. */
  groupAlive?: typeof isProcessGroupAlive;
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
  /** Fail closed unless every loaded thread in the shared owner is idle. */
  assertIdleThreads?: (socketPath: string) => Promise<void>;
  /** Stop a stale server's process group; tests replace the signals. */
  stopHolder?: (pid: number) => Promise<void>;
  onStaleReplaced?: (event: { pid: number; staleRelease: string; currentRelease: string }) => void;
  /** Every running process as `pid command`; tests replace the `ps` listing. */
  listProcesses?: () => Promise<Array<{ pid: number; command: string }>>;
  /** Whether a stray's socket still answers; tests replace the connect probe. */
  strayReachable?: (socketPath: string) => Promise<boolean>;
}

export interface CodexSocketHolder { pid: number; command: string }

/** rc.6 upgrade path: prove the still-running release owns the private socket before reading it. */
export async function assertLegacyCodexOwnerIdle(input: { root: string; releaseId: string; codexHome?: string; codexSocket?: string }): Promise<void> {
  const home = await resolveNativeCodexHome(input.codexHome === undefined ? process.env : { CODEX_HOME: input.codexHome });
  const socket = await resolveNativeCodexSocket(input.root, home, input.codexSocket);
  const holder = await findCodexSocketHolder(socket).catch(() => null);
  const release = holder && releaseOf(holder.command);
  if (!holder || !release || release.releasesDir !== `${join(input.root, "releases")}/` || release.release !== input.releaseId ||
      !holder.command.includes(`--listen unix://${socket}`)) {
    throw unavailable("The previous Codex service owner could not be verified for maintenance.");
  }
  await assertCodexThreadsIdle(socket);
}

/**
 * One supervisor-owned Codex app-server shared by every local ACP bridge.
 * Bridge/session restarts only replace clients; they never own this process.
 */
export class NativeCodexAppServerOwner {
  private child: PipedChildProcess | null = null;
  private adoptedHolder: CodexSocketHolder | null = null;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private adoptedTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private stopping = false;
  private generation = 0;
  private readonly ops: OwnerOperations;

  constructor(private readonly options: NativeCodexAppServerOwnerOptions) {
    if (!sharedCodexConfig(options.config)) {
      throw unavailable("Shared Codex ownership requires the signed native Codex profile and private Unix socket.");
    }
    this.ops = { ...DEFAULT_OPERATIONS, ...withoutUndefined({
      spawn: options.spawn, stop: options.stop, groupAlive: options.groupAlive, prepareSocket: options.prepareSocket,
      socketAvailable: options.socketAvailable, waitUntilReady: options.waitUntilReady, cleanupSocket: options.cleanupSocket,
      verifyPackage: options.verifyPackage, socketHolder: options.socketHolder, assertIdleThreads: options.assertIdleThreads,
      stopHolder: options.stopHolder, listProcesses: options.listProcesses, strayReachable: options.strayReachable,
    }) };
  }

  private exitReaper: (() => void) | null = null;

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(unavailable("The shared Codex owner is stopping."));
    // A failed start is not remembered: the supervisor tries a Codex that
    // could not start again later, and that try must spawn afresh.
    this.startPromise ??= this.spawnAndAwaitReady().catch(error => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  /**
   * A stop was asked for. The app-server runs in its own process
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

  /** Called while the launcher drain is still cancellable, before service stop. */
  async preflightMaintenance(): Promise<void> {
    await this.startPromise;
    if (this.stopping) throw unavailable("The shared Codex owner is stopping.");
    if (this.child || this.adoptedHolder) {
      await this.ops.assertIdleThreads(this.options.config.RUNNER_NATIVE_CODEX_SOCKET!);
    }
  }

  async inspectLegacyThread(reference: string): Promise<{ unloaded: boolean; ownerGeneration: string }> {
    await this.startPromise;
    if (this.stopping || (!this.child && !this.adoptedHolder)) throw unavailable("The shared Codex owner is unavailable.");
    const socket = this.options.config.RUNNER_NATIVE_CODEX_SOCKET!;
    // The bound socket itself, also when Codex 0.159+ reached it through a link.
    const before = await stat(socket);
    const pid = this.ownerPid();
    if (!before.isSocket() || !pid) throw unavailable("The shared Codex owner identity is unavailable.");
    const unloaded = !(await codexLoadedThreadStatuses(socket)).has(reference);
    const after = await stat(socket);
    if (!sameSocketEntry(before, after) || pid !== this.ownerPid()) throw unavailable("The shared Codex owner changed during legacy admission.");
    return { unloaded, ownerGeneration: `${pid}:${before.dev}:${before.ino}:${before.birthtimeMs}` };
  }

  private ownerPid(): number | undefined {
    return this.child?.pid ?? this.adoptedHolder?.pid;
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
    try { await this.stopOwnedProcess(); }
    catch (error) {
      // A maintenance refusal must not leave the exit reaper armed: the
      // connector may exit after reporting the failed stop to the launcher.
      if (this.exitReaper) process.removeListener("exit", this.exitReaper);
      this.exitReaper = null;
      throw error;
    }
    if (this.exitReaper) process.removeListener("exit", this.exitReaper);
    this.exitReaper = null;
  }

  /** Called only after the runner has fenced and stopped every Codex execution owner. */
  async refreshAfterLogin(): Promise<void> {
    if (this.stopping) throw unavailable("The shared Codex owner is stopping.");
    await this.startPromise;
    this.generation++;
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.adoptedTimer = this.stableTimer = this.restartTimer = null;
    await this.stopOwnedProcess();
    this.startPromise = null;
    await this.start();
  }

  private async stopOwnedProcess(): Promise<void> {
    const child = this.child;
    const adopted = this.adoptedHolder;
    const socketPath = this.options.config.RUNNER_NATIVE_CODEX_SOCKET!;
    if (adopted) await this.assertAdoptedUnchanged(socketPath, adopted);
    if (child || adopted) await this.ops.assertIdleThreads(socketPath);
    if (child) await this.stopChild(child);
    else if (adopted) await this.ops.stopHolder(adopted.pid);
    this.child = null;
    this.adoptedHolder = null;
    if (child || adopted) await this.ops.cleanupSocket(socketPath);
  }

  private async assertAdoptedUnchanged(socketPath: string, adopted: CodexSocketHolder): Promise<void> {
    const current = await this.ops.socketHolder(socketPath).catch(() => null);
    if (!sameHolder(current, adopted)) {
      throw unavailable("The adopted Codex owner changed; refusing to stop another process.");
    }
  }

  private async stopChild(child: PipedChildProcess): Promise<void> {
    await this.ops.stop({ child, timeoutMs: 5_000, killGraceMs: 2_000 });
    if (this.ops.groupAlive(child)) {
      throw unavailable("The signed Codex app-server process group did not finish stopping.");
    }
  }

  private async spawnAndAwaitReady(): Promise<void> {
    const generation = ++this.generation;
    const { config } = this.options;
    const socketPath = config.RUNNER_NATIVE_CODEX_SOCKET!;
    const codexHome = config.RUNNER_NATIVE_CODEX_HOME!;
    await this.ops.verifyPackage(config);
    const root = dirname(dirname(config.RUNNER_CREDENTIAL_DIR));
    const defaultSocket = await resolveNativeCodexSocket(root, codexHome);
    let socketMode = await this.ops.prepareSocket(socketPath, socketPath === defaultSocket);
    this.assertStarting(generation);
    const family = resolveBridgeFamily("codex");
    const command = resolveToolingCommand(config, family, ["codex", "app-server", "--listen", `unix://${socketPath}`]);
    if (socketMode === "adopt") socketMode = await this.classifyExistingHolder(socketPath, command.command);
    this.assertStarting(generation);
    if (socketMode === "adopt") {
      this.watchAdoptedSocket(socketPath, generation);
      void this.reapStrayServers(command.command, socketPath).catch(() => undefined);
      return;
    }
    await this.spawnServer({ command, codexHome, socketPath, generation, env: bridgeEnvironment(config, family) });
  }

  private assertStarting(generation: number): void {
    if (this.stopping || generation !== this.generation) throw unavailable("The shared Codex owner stopped during startup.");
  }

  /** Spawn the signed app-server in its own process group and wait for its socket; a failed start is stopped and cleaned up. */
  private async spawnServer(start: { command: ReturnType<typeof resolveToolingCommand>; codexHome: string; socketPath: string; generation: number; env: NodeJS.ProcessEnv }): Promise<void> {
    const { command, socketPath, generation } = start;
    const child = this.ops.spawn({ ...command, cwd: start.codexHome, env: start.env, detached: true });
    this.child = child;
    child.stdout.resume();
    child.stderr.resume();
    let rejectStartup!: (error: unknown) => void;
    const startupExit = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    const exitedDuringStartup = () => rejectStartup(unavailable("The signed Codex app-server exited during startup."));
    child.once("exit", exitedDuringStartup);
    child.once("error", exitedDuringStartup);
    try {
      await Promise.race([this.ops.waitUntilReady(socketPath, child), startupExit]);
      if (this.stopping || generation !== this.generation || this.child !== child) throw unavailable("The shared Codex owner exited during startup.");
      this.supervise(child, generation, exitedDuringStartup);
      void this.reapStrayServers(command.command, socketPath).catch(() => undefined);
    } catch (error) {
      if (this.child === child) this.child = null;
      child.removeListener("exit", exitedDuringStartup);
      child.removeListener("error", exitedDuringStartup);
      await this.ops.stop({ child, timeoutMs: 5_000, killGraceMs: 2_000 });
      await this.ops.cleanupSocket(socketPath);
      throw error;
    }
  }

  /** A started server is restarted when it exits; a minute of stable running resets the restart backoff. */
  private supervise(child: PipedChildProcess, generation: number, exitedDuringStartup: () => void): void {
    const exited = () => this.onExit(child, generation);
    child.once("exit", exited);
    child.once("error", exited);
    child.removeListener("exit", exitedDuringStartup);
    child.removeListener("error", exitedDuringStartup);
    this.stableTimer = setTimeout(() => { this.restartAttempt = 0; this.stableTimer = null; }, 60_000);
    this.stableTimer.unref();
  }

  /**
   * A live socket is adopted only from this connector's current release. A
   * server left running by an older release of the same connector keeps the
   * sign-in it read when it started: after the account signed in again it
   * can no longer refresh its token, and every Codex turn failed
   * "unauthorized" while the socket still looked healthy. Such a
   * server is stopped and a fresh one reads the current sign-in. A holder
   * that is not one of this connector's releases is never touched.
   */
  private async classifyExistingHolder(socketPath: string, currentCommand: string): Promise<"spawn" | "adopt"> {
    const current = releaseOf(currentCommand);
    if (!current) throw unavailable("The signed Codex owner could not prove its release.");
    const holder = await this.ops.socketHolder(socketPath).catch(() => null);
    const stale = holder ? releaseOf(holder.command) : null;
    if (!holder || !stale || !installationServer(holder, stale, current, socketPath)) {
      throw unavailable("The Codex socket is held by another or unverified process.");
    }
    if (stale.release === current.release) {
      this.adoptedHolder = holder;
      return "adopt";
    }
    await this.ops.assertIdleThreads(socketPath);
    await this.ops.stopHolder(holder.pid);
    await this.ops.cleanupSocket(socketPath);
    this.options.onStaleReplaced?.({ pid: holder.pid, staleRelease: stale.release, currentRelease: current.release });
    return "spawn";
  }

  /**
   * Codex app-servers an older release of THIS installation left behind on
   * another socket (a release folder deleted days earlier can still have its
   * server running, and an update's stop can leave the previous release's one
   * orphaned). Only processes whose executable is inside this
   * installation's releases folder, never the current release, never the
   * current socket (adoption and stale replacement own that one), and only
   * while their threads are idle when their socket still answers.
   */
  async reapStrayServers(currentCommand: string, currentSocket: string): Promise<number> {
    const current = executableRelease(currentCommand);
    if (!current) return 0;
    const processes = await this.ops.listProcesses().catch(() => []);
    let reaped = 0;
    for (const entry of processes) {
      const stray = this.strayServer(entry, current, currentSocket);
      if (stray && await this.reapStray(entry.pid, stray, current.release)) reaped += 1;
    }
    return reaped;
  }

  /** An older release's server on another socket; null for this process, the owned server, or anything else. */
  private strayServer(entry: { pid: number; command: string }, current: { releasesDir: string; release: string }, currentSocket: string): { release: string; socket: string } | null {
    if (this.ownProcess(entry.pid)) return null;
    const release = olderRelease(entry.command, current);
    if (!release) return null;
    const socket = /\bcodex\b.*\bapp-server\b.*--listen unix:\/\/(\S+)/.exec(entry.command)?.[1];
    if (!socket || socket === currentSocket) return null;
    return { release, socket };
  }

  private ownProcess(pid: number): boolean {
    return pid === process.pid || this.child?.pid === pid || this.adoptedHolder?.pid === pid;
  }

  /** Stop a stray while its threads are idle (when its socket still answers); false when it is busy or already gone. */
  private async reapStray(pid: number, stray: { release: string; socket: string }, currentRelease: string): Promise<boolean> {
    try {
      if (await this.ops.strayReachable(stray.socket)) await this.ops.assertIdleThreads(stray.socket);
      await this.ops.stopHolder(pid);
    } catch {
      return false; // busy or already gone: the next start looks again
    }
    try { this.options.onStaleReplaced?.({ pid, staleRelease: stray.release, currentRelease }); } catch { /* reported only */ }
    return true;
  }

  /** A healthy same-user socket is local-user authority and can survive a
   * connector restart. Polling retains supervision without spawning a racing
   * second server; loss atomically returns to the normal signed spawn path. */
  private watchAdoptedSocket(socketPath: string, generation: number): void {
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    this.adoptedTimer = setInterval(() => { void this.pollAdopted(socketPath, generation); }, this.options.adoptedPollMs ?? 2_000);
    this.adoptedTimer.unref();
  }

  private watching(generation: number): boolean {
    return !this.stopping && generation === this.generation;
  }

  /** Loss of the adopted socket returns to the normal signed spawn path. */
  private async pollAdopted(socketPath: string, generation: number): Promise<void> {
    if (!this.watching(generation) || !this.adoptedTimer) return;
    const available = await this.ops.socketAvailable(socketPath);
    if (available || !this.watching(generation)) return;
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    this.adoptedTimer = null;
    const adopted = this.adoptedHolder;
    this.adoptedHolder = null;
    await this.replaceLostAdopted(socketPath, generation, adopted).catch(error => {
      this.options.onRestartFailure?.(error);
      if (!this.stopping) this.onExitRetry();
    });
  }

  /** The adopted server, if it still holds the socket unanswered, is stopped; then a fresh one is spawned. */
  private async replaceLostAdopted(socketPath: string, generation: number, adopted: CodexSocketHolder | null): Promise<void> {
    if (adopted) {
      const current = await this.ops.socketHolder(socketPath).catch(() => null);
      if (!this.watching(generation)) return;
      if (sameHolder(current, adopted)) {
        await this.ops.stopHolder(adopted.pid);
        await this.ops.cleanupSocket(socketPath);
      }
    }
    if (this.watching(generation)) await this.spawnAndAwaitReady();
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

export async function prepareCodexSocket(socketPath: string, allowStaleCleanup = false): Promise<"spawn" | "adopt"> {
  validatePath(socketPath);
  await privateSocketDirectory(dirname(socketPath));
  const existing = await lstat(socketPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return "spawn";
  const socket = await resolveCodexSocket(socketPath, existing);
  if (notOurSocket(socket)) throw unavailable("The shared Codex socket path is not a private local-user socket.");
  if (socket.kind === "socket" && await canConnect(socketPath)) return "adopt";
  if (!allowStaleCleanup) throw unavailable("An explicit Codex socket is stale; refusing to remove an unproven holder's socket.");
  // A stale socket, or the link a stopped Codex left to its own: only the
  // entry at our path is removed, never what a link points to.
  await unlink(socketPath);
  return "spawn";
}

async function privateSocketDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const canonical = await realpath(directory);
  if (canonical !== directory || !info.isDirectory() || info.uid !== process.getuid?.()) throw unavailable("The shared Codex socket directory must be private and owned by the local user.");
  await chmod(directory, 0o700);
}

/** Another user's socket, or something that is not a socket at all. */
function notOurSocket(socket: Awaited<ReturnType<typeof resolveCodexSocket>>): boolean {
  return socket.kind === "foreign" || (socket.kind === "socket" && !privateOwner(socket.info));
}

/**
 * How long a starting Codex app-server may take to listen. A first start of a
 * newer Codex can migrate the state in its home before it binds, so this is
 * generous; a server that exits fails at once, and other agents start
 * meanwhile (start-native-agents), so the wait only costs Codex itself.
 */
const CODEX_SOCKET_READY_TIMEOUT_MS = 60_000;

export async function waitForCodexSocket(socketPath: string, child: PipedChildProcess, timeoutMs = CODEX_SOCKET_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw unavailable("The signed Codex app-server exited before its socket became ready.");
    if (await securedWhenListening(socketPath)) return;
    await pause(100);
  }
  throw unavailable("The signed Codex app-server did not become ready in time.");
}

/** Once this user's socket answers, make it private; false while it does not answer yet. */
async function securedWhenListening(socketPath: string): Promise<boolean> {
  const socket = await resolveCodexSocket(socketPath);
  if (!(socket.kind === "socket" && socket.info.uid === process.getuid?.() && await canConnect(socketPath))) return false;
  await chmod(socket.target, 0o600);
  const secured = await resolveCodexSocket(socketPath);
  if (secured.kind === "socket" && secured.target === socket.target && privateOwner(secured.info)) return true;
  throw unavailable("The shared Codex socket could not be secured.");
}

export async function cleanupCodexSocket(socketPath: string): Promise<void> {
  const socket = await resolveCodexSocket(socketPath);
  if (socket.kind === "none" || socket.kind === "foreign" || (socket.kind === "socket" && !privateOwner(socket.info))) return;
  // Never unlink a same-user server that won a race after our process stopped.
  if (socket.kind === "dangling" || !await canConnect(socketPath)) await unlink(socketPath).catch(() => undefined);
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
function releaseOf(command: string): { releasesDir: string; release: string } | null {
  const match = /^(.*\/releases\/)([^/]+)\//.exec(command);
  return match ? { releasesDir: match[1]!, release: match[2]! } : null;
}

const run = promisify(execFile);

/**
 * The release folder of a command's executable: the FIRST `…/releases/<release>/`
 * (a Node-wrapped server names its release twice, and install roots contain spaces).
 */
function executableRelease(command: string): { releasesDir: string; release: string } | null {
  const match = /^(.*?\/releases\/)([^/]+)\//.exec(command);
  return match ? { releasesDir: match[1]!, release: match[2]! } : null;
}

/** Every running process of this user with its full command line. */
async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]!.trim() }] : [];
  });
}

/** The Codex app-server process listening on the shared socket, if it can be told. */
async function findCodexSocketHolder(socketPath: string): Promise<CodexSocketHolder | null> {
  // lsof names a socket by where it was bound, not by a link to it (Codex 0.159+).
  const socket = await resolveCodexSocket(socketPath).catch(() => null);
  const { stdout } = await run("lsof", ["-t", socket?.kind === "socket" ? socket.target : socketPath], { timeout: 5_000 });
  for (const pid of stdout.split(/\s+/).map(Number).filter(value => Number.isSafeInteger(value) && value > 0)) {
    const { stdout: command } = await run("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 });
    if (/\bcodex\b.*\bapp-server\b/.test(command)) return { pid, command: command.trim() };
  }
  return null;
}

async function stopProcessGroup(pid: number): Promise<void> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The server runs in its own group (detached spawn); end the group, as a stop does.
  if (!signalGroup(pid, "SIGTERM")) return;
  await waitWhile(alive, 5_000);
  if (alive()) {
    signalGroup(pid, "SIGKILL");
    await waitWhile(alive, 2_000);
  }
  if (alive()) throw unavailable("The adopted Codex app-server did not finish stopping.");
}

/** Signal the process group, or the process alone when it leads none; false when neither could be signalled. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

async function waitWhile(condition: () => boolean, limitMs: number): Promise<void> {
  for (let waited = 0; waited < limitMs && condition(); waited += 100) await pause(100);
}

/** The collaborators the owner uses: the real ones, or a test's replacements. */
interface OwnerOperations {
  spawn: typeof spawnPiped;
  stop: typeof stopProcessGroupLeaderFirst;
  groupAlive: typeof isProcessGroupAlive;
  prepareSocket: typeof prepareCodexSocket;
  socketAvailable: (socketPath: string) => Promise<boolean>;
  waitUntilReady: typeof waitForCodexSocket;
  cleanupSocket: typeof cleanupCodexSocket;
  verifyPackage: typeof verifyNativeRunnerPackage;
  socketHolder: (socketPath: string) => Promise<CodexSocketHolder | null>;
  assertIdleThreads: (socketPath: string) => Promise<void>;
  stopHolder: (pid: number) => Promise<void>;
  listProcesses: () => Promise<Array<{ pid: number; command: string }>>;
  strayReachable: (socketPath: string) => Promise<boolean>;
}

const DEFAULT_OPERATIONS: OwnerOperations = {
  spawn: spawnPiped,
  stop: stopProcessGroupLeaderFirst,
  groupAlive: isProcessGroupAlive,
  prepareSocket: prepareCodexSocket,
  socketAvailable: canConnect,
  waitUntilReady: waitForCodexSocket,
  cleanupSocket: cleanupCodexSocket,
  verifyPackage: verifyNativeRunnerPackage,
  socketHolder: findCodexSocketHolder,
  assertIdleThreads: assertCodexThreadsIdle,
  stopHolder: stopProcessGroup,
  listProcesses,
  strayReachable: canConnect,
};

/** The signed native Codex profile with an absolute home and a private Unix socket, outside Windows. */
function sharedCodexConfig(config: RunnerConfig): boolean {
  if (process.platform === "win32" || config.RUNNER_AGENT_ID !== "codex" || config.RUNNER_AUTH_MODE !== "agent_local_subscription") return false;
  return Boolean(config.RUNNER_NATIVE_PACKAGE_PROFILE?.codexLocalProxy) &&
    absolutePath(config.RUNNER_NATIVE_CODEX_HOME) && absolutePath(config.RUNNER_NATIVE_CODEX_SOCKET);
}

function absolutePath(path: string | undefined): boolean {
  return path !== undefined && path !== "" && isAbsolute(path);
}

function sameHolder(current: CodexSocketHolder | null, adopted: CodexSocketHolder): boolean {
  return current?.pid === adopted.pid && current.command === adopted.command;
}

function sameSocketEntry(before: { dev: number; ino: number; birthtimeMs: number }, after: { dev: number; ino: number; birthtimeMs: number }): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.birthtimeMs === after.birthtimeMs;
}

/** A server from this connector's own releases folder, listening on exactly this socket. */
function installationServer(holder: CodexSocketHolder, stale: { releasesDir: string }, current: { releasesDir: string }, socketPath: string): boolean {
  return stale.releasesDir === current.releasesDir && holder.command.includes(`--listen unix://${socketPath}`);
}

/** The release of a command from another release of this installation; null for the current one or anything else. */
function olderRelease(command: string, current: { releasesDir: string; release: string }): string | null {
  const release = executableRelease(command);
  if (!release || release.releasesDir !== current.releasesDir || release.release === current.release) return null;
  return release.release;
}