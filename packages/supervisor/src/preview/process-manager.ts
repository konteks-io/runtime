import { execFile, spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger, readDarwinProcessIdentity, stopProcessGroupLeaderFirst, supportsProcessGroups, type Logger } from "@konteks/remote-common";
import { blockedCommandPattern, DEFAULT_BASH_BLOCKLIST } from "../session/workspace-tool-policy.js";
import { resolvePreviewPlan, substitutePreviewVariables, type PreviewPlan, type PreviewPlanResult } from "./config.js";
import { resolvePreviewPath } from "./user-path.js";

/**
 * Supervised preview dev servers: at most one per session, run in that
 * session's working copy on a loopback port this manager picks, with an
 * allow-listed environment (never the connector's own secrets), health
 * probed, and killed as a whole process tree when it stops.
 *
 * Previews stop on idle (no viewer traffic and no agent activity for
 * `idleMs`, 30 minutes by default: a dev server is for looking at work in
 * progress, and restarting one costs a person a minute of compile), on
 * session close, claim loss, drain, revocation and connector stop. A restart
 * never adopts a preview: the registry file lets the next process kill any
 * dev server a crashed one left behind. A small global cap keeps an 8 GB
 * machine responsive.
 */
export type PreviewState = "not_started" | "starting" | "running" | "failed" | "stopped";
export type PreviewPhase = "install" | "prepare" | "serve";

export interface PreviewStatus {
  sessionId: string;
  state: PreviewState;
  phase: PreviewPhase | null;
  /** The loopback URL, for a browser on this computer (a QA agent's, for example). */
  url: string | null;
  port: number | null;
  command: string | null;
  install: string | null;
  prepare: string | null;
  source: PreviewPlan["source"] | null;
  /** Where the command came from, in one sentence (what was inferred, and why). */
  explanation: string | null;
  notes: string[];
  message: string;
  startedAt: string | null;
  readyAt: string | null;
  idleStopMinutes: number;
  logTail: string[];
}

export interface PreviewChild {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface PreviewProcessManagerOptions {
  /** Starts `command` through the platform shell. */
  spawn?: (request: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => PreviewChild;
  /** Stops the child and every process it started. */
  terminate?: (child: PreviewChild) => Promise<void>;
  resolvePlan?: (cwd: string) => Promise<PreviewPlanResult>;
  /** Any HTTP answer from host:port+path means the server is up. */
  probe?: (host: string, port: number, path: string) => Promise<boolean>;
  allocatePort?: (inUse: ReadonlySet<number>) => Promise<number>;
  resolvePath?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  registry?: PreviewProcessRegistry | null;
  onStopped?: (sessionId: string) => void;
  now?: () => number;
  idleMs?: number;
  maxRunning?: number;
  readinessTimeoutMs?: number;
  phaseTimeoutMs?: number;
  probeIntervalMs?: number;
  logger?: Logger;
}

export const PREVIEW_DEFAULT_IDLE_MS = 30 * 60_000;
export const PREVIEW_DEFAULT_MAX_RUNNING = 3;
export const PREVIEW_PORT_RANGE = { first: 43_100, last: 43_999 } as const;
const PREVIEW_HOST = "127.0.0.1";
const LOG_LINES = 200;
const LOG_TAIL = 40;
const LOG_LINE_CHARS = 400;
const RETAINED_ENDED = 32;

/**
 * The only variables a preview inherits from the connector's environment:
 * what a toolchain needs to find the person's home, temp folder, locale and
 * package-manager homes. Everything else (provider keys, activation
 * material, KONTEKS_*) is left out by construction, not by a denylist.
 */
export const PREVIEW_ENV_ALLOWLIST: readonly string[] = [
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP",
  "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL", "COREPACK_HOME", "npm_config_cache",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

export function buildPreviewEnv(base: NodeJS.ProcessEnv, path: string, port: number, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PREVIEW_ENV_ALLOWLIST) if (base[name] !== undefined) env[name] = base[name];
  for (const [name, value] of Object.entries(base)) if (value !== undefined && /^LC_[A-Z_]+$/.test(name)) env[name] = value;
  for (const [name, value] of Object.entries(extra)) {
    const upper = name.toUpperCase();
    if (upper === "PATH" || upper === "HOST" || upper === "PORT") continue;
    env[name] = value;
  }
  return {
    ...env,
    PATH: path,
    HOST: PREVIEW_HOST,
    PORT: String(port),
    // Dev servers must not open a browser window on the person's desktop.
    BROWSER: "none",
    FORCE_COLOR: "0",
    TERM: "dumb",
  };
}

interface Entry {
  sessionId: string;
  cwd: string;
  generation: number;
  state: PreviewState;
  phase: PreviewPhase | null;
  plan: PreviewPlan | null;
  port: number | null;
  host: string | null;
  child: PreviewChild | null;
  logs: string[];
  message: string;
  notes: string[];
  startedAt: number | null;
  readyAt: number | null;
  lastActivityAt: number;
  settled: Promise<void>;
  stopping: Promise<void> | null;
}

export class PreviewProcessManager {
  private readonly entries = new Map<string, Entry>();
  private readonly ended: Entry[] = [];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxRunning: number;
  private pathPromise: Promise<string> | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private generation = 0;
  private closed = false;
  private lastFailure: { at: number; message: string } | null = null;

  constructor(private readonly options: PreviewProcessManagerOptions = {}) {
    this.logger = options.logger ?? createLogger({ name: "preview" });
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? PREVIEW_DEFAULT_IDLE_MS;
    this.maxRunning = Math.max(1, options.maxRunning ?? PREVIEW_DEFAULT_MAX_RUNNING);
  }

  /** Begin the idle sweep; call once when the supervisor is serving. */
  startIdleSweep(intervalMs = 60_000): void {
    if (this.sweeper || this.closed) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), intervalMs);
    this.sweeper.unref();
  }

  /**
   * Start this session's preview in `cwd`, or return the one already running.
   * Resolves as soon as the attempt is under way; `waitForSettled` waits for
   * it to answer or fail.
   */
  async start(sessionId: string, cwd: string): Promise<PreviewStatus> {
    if (this.closed) return this.refusal(sessionId, "The connector is stopping; previews cannot start now.");
    const current = this.entries.get(sessionId);
    if (current && (current.state === "starting" || current.state === "running") && current.cwd === cwd && !current.stopping) {
      current.lastActivityAt = this.now();
      return this.view(current);
    }
    if (current) await this.stop(sessionId, "restart");
    const active = [...this.entries.values()].filter(entry => entry.state === "starting" || entry.state === "running");
    if (active.length >= this.maxRunning) {
      return this.refusal(sessionId, `${active.length} previews are already running on this computer (the limit is ${this.maxRunning}, to keep it responsive). Stop one with preview_stop, or wait until one stops after ${Math.round(this.idleMs / 60_000)} idle minutes.`);
    }
    const entry: Entry = {
      sessionId, cwd, generation: ++this.generation, state: "starting", phase: null, plan: null, port: null, host: null, child: null,
      logs: [], message: "Starting: reading how to serve this working copy.", notes: [], startedAt: this.now(), readyAt: null,
      lastActivityAt: this.now(), settled: Promise.resolve(), stopping: null,
    };
    this.entries.set(sessionId, entry);
    entry.settled = this.launch(entry).catch(error => {
      this.fail(entry, `The preview could not start: ${error instanceof Error ? error.message.slice(0, 300) : "unexpected error"}.`);
    });
    return this.view(entry);
  }

  /** Wait (bounded) until the preview answers, fails or stops. */
  async waitForSettled(sessionId: string, timeoutMs: number): Promise<PreviewStatus> {
    const entry = this.entries.get(sessionId);
    if (!entry) return this.status(sessionId);
    const deadline = Date.now() + timeoutMs;
    while (entry.state === "starting" && this.entries.get(sessionId) === entry && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.status(sessionId);
  }

  status(sessionId: string): PreviewStatus {
    const entry = this.entries.get(sessionId) ?? [...this.ended].reverse().find(candidate => candidate.sessionId === sessionId);
    if (!entry) {
      return { sessionId, state: "not_started", phase: null, url: null, port: null, command: null, install: null, prepare: null, source: null, explanation: null, notes: [],
        message: "No preview has been started for this session. Call preview_start.", startedAt: null, readyAt: null, idleStopMinutes: Math.round(this.idleMs / 60_000), logTail: [] };
    }
    return this.view(entry);
  }

  list(): PreviewStatus[] {
    return [...this.entries.values()].map(entry => this.view(entry));
  }

  /** The loopback origin the forwarder may dial for this session, only while it answers. */
  originFor(sessionId: string): string | null {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== "running" || entry.port === null || entry.host === null || entry.stopping) return null;
    return `http://${entry.host === "::1" ? "[::1]" : entry.host}:${entry.port}`;
  }

  /** Viewer traffic, an agent's preview call or a prompt on the session. */
  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.lastActivityAt = this.now();
  }

  async stop(sessionId: string, reason: string): Promise<PreviewStatus> {
    const entry = this.entries.get(sessionId);
    if (!entry) return this.status(sessionId);
    // Marked before any kill runs, so the child's exit reads as a stop, not a crash.
    if (!entry.stopping) entry.stopping = Promise.resolve().then(() => this.stopEntry(entry, reason));
    await entry.stopping;
    return this.status(sessionId);
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map(sessionId => this.stop(sessionId, reason)));
  }

  /** Stop everything and refuse new starts (connector stop). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await this.stopAll("connector_stopping");
  }

  /** For the doctor: counts and the last failure, never a path or a command. */
  health(): { running: number; starting: number; lastFailure: { at: string; message: string } | null } {
    let running = 0, starting = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "running") running += 1;
      else if (entry.state === "starting") starting += 1;
    }
    return { running, starting, lastFailure: this.lastFailure ? { at: new Date(this.lastFailure.at).toISOString(), message: this.lastFailure.message } : null };
  }

  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    for (const entry of [...this.entries.values()]) {
      if ((entry.state === "running" || entry.state === "starting") && entry.lastActivityAt < cutoff && !entry.stopping) {
        this.logger.info({ event: "preview.idle_stop", idleMs: this.now() - entry.lastActivityAt }, "stopping an idle preview");
        await this.stop(entry.sessionId, "idle");
      }
    }
  }

  private async launch(entry: Entry): Promise<void> {
    const current = () => this.entries.get(entry.sessionId) === entry && !entry.stopping && entry.state === "starting";
    const planned = await (this.options.resolvePlan ?? resolvePreviewPlan)(entry.cwd);
    if (!current()) return;
    if (!planned.ok) {
      entry.notes = planned.notes;
      return this.fail(entry, planned.message);
    }
    const plan = planned.plan;
    entry.plan = plan;
    entry.notes = plan.notes;
    for (const [phase, command] of [["install", plan.install], ["prepare", plan.prepare], ["serve", plan.command]] as const) {
      if (command === undefined) continue;
      const hit = blockedCommandPattern(command, DEFAULT_BASH_BLOCKLIST);
      if (hit) return this.fail(entry, `The ${phase} command is refused by this computer's command policy ("${hit.trim()}"). Change it in .konteks/preview.yaml.`);
    }
    const path = await this.userPath();
    if (!current()) return;
    const inUse = new Set([...this.entries.values()].map(candidate => candidate.port).filter((port): port is number => port !== null));
    const port = await (this.options.allocatePort ?? allocatePreviewPort)(inUse);
    if (!current()) return;
    entry.port = port;
    const env = buildPreviewEnv(this.options.env ?? process.env, path, port, plan.env);
    const values = { host: PREVIEW_HOST, port };
    for (const phase of ["install", "prepare"] as const) {
      const command = plan[phase];
      if (command === undefined) continue;
      entry.phase = phase;
      entry.message = phase === "install" ? "Installing dependencies before the dev server starts." : "Running the prepare step before the dev server starts.";
      const code = await this.runPhase(entry, substitutePreviewVariables(command, values), env);
      if (!current()) return;
      if (code !== 0) return this.fail(entry, `The ${phase} step (${command}) ${code === null ? "timed out" : `exited with code ${code}`}. See the log lines.`);
    }
    entry.phase = "serve";
    entry.message = `Starting the dev server on ${PREVIEW_HOST}:${port}.`;
    const child = this.spawnChild(entry, substitutePreviewVariables(plan.command, values), env);
    entry.child = child;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      void this.options.registry?.forget(child.pid);
      if (this.entries.get(entry.sessionId) !== entry || entry.stopping) return;
      if (entry.state === "running") this.fail(entry, `The dev server stopped unexpectedly (${describeExit(code, signal)}). Call preview_start to start it again.`);
    });
    child.once("error", error => {
      exited ??= { code: null, signal: null };
      this.appendLog(entry, `[connector] ${error.message}`);
    });
    if (child.pid !== undefined) void this.options.registry?.record(child.pid);
    const readiness = plan.readinessTimeoutMs ?? this.options.readinessTimeoutMs ?? 180_000;
    const deadline = this.now() + readiness;
    const probe = this.options.probe ?? probeHttp;
    const interval = this.options.probeIntervalMs ?? 500;
    while (current()) {
      if (exited) {
        const ended = exited as { code: number | null; signal: NodeJS.Signals | null };
        return this.fail(entry, `The dev server exited before it answered (${describeExit(ended.code, ended.signal)}). See the log lines.`);
      }
      for (const host of [PREVIEW_HOST, "::1"]) {
        if (await probe(host, port, plan.healthPath).catch(() => false)) {
          if (!current()) return;
          entry.host = host;
          entry.state = "running";
          entry.readyAt = this.now();
          entry.message = `Running. Open http://${PREVIEW_HOST}:${port}${plan.healthPath === "/" ? "" : plan.healthPath} on this computer, or open the preview from the session in Konteks.`;
          this.logger.info({ event: "preview.ready", source: plan.source, startupMs: entry.readyAt - (entry.startedAt ?? entry.readyAt) }, "preview answered its health probe");
          return;
        }
      }
      if (this.now() >= deadline) {
        await this.kill(entry);
        return this.fail(entry, `The dev server did not answer on ${PREVIEW_HOST}:${port} within ${Math.round(readiness / 1000)} s. If it listens on a fixed port or host, set serve.command in .konteks/preview.yaml to use $HOST and $PORT.`);
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  private runPhase(entry: Entry, command: string, env: NodeJS.ProcessEnv): Promise<number | null> {
    const child = this.spawnChild(entry, command, env);
    entry.child = child;
    if (child.pid !== undefined) void this.options.registry?.record(child.pid);
    return new Promise(resolve => {
      const timer = setTimeout(() => { void this.terminate(child).finally(() => resolve(null)); }, this.options.phaseTimeoutMs ?? 15 * 60_000);
      timer.unref?.();
      child.once("error", error => { this.appendLog(entry, `[connector] ${error.message}`); });
      child.once("exit", code => {
        clearTimeout(timer);
        void this.options.registry?.forget(child.pid);
        if (entry.child === child) entry.child = null;
        resolve(code ?? 1);
      });
    });
  }

  private spawnChild(entry: Entry, command: string, env: NodeJS.ProcessEnv): PreviewChild {
    this.appendLog(entry, `[connector] $ ${command}`);
    const child = (this.options.spawn ?? spawnShell)({ command, cwd: entry.cwd, env });
    let pending = "";
    const collect = (data: Buffer | string) => {
      pending += typeof data === "string" ? data : data.toString("utf8");
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.appendLog(entry, line);
      if (pending.length > LOG_LINE_CHARS * 4) { this.appendLog(entry, pending); pending = ""; }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    return child;
  }

  private appendLog(entry: Entry, line: string): void {
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
    if (clean.length === 0) return;
    entry.logs.push(clean.length > LOG_LINE_CHARS ? `${clean.slice(0, LOG_LINE_CHARS)}…` : clean);
    if (entry.logs.length > LOG_LINES) entry.logs.splice(0, entry.logs.length - LOG_LINES);
  }

  private async stopEntry(entry: Entry, reason: string): Promise<void> {
    const wasActive = entry.state === "starting" || entry.state === "running";
    await this.kill(entry);
    await entry.settled.catch(() => undefined);
    if (entry.state === "starting" || entry.state === "running") {
      entry.state = "stopped";
      entry.message = stopMessage(reason);
    }
    entry.phase = null;
    if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId);
    this.retain(entry);
    if (wasActive) this.logger.info({ event: "preview.stopped", reason }, "preview stopped");
    this.options.onStopped?.(entry.sessionId);
  }

  private async kill(entry: Entry): Promise<void> {
    const child = entry.child;
    entry.child = null;
    if (child) {
      await this.terminate(child).catch(error => this.logger.warn({ event: "preview.kill_failed", err: error }, "the preview process tree could not be confirmed stopped"));
      await this.options.registry?.forget(child.pid);
    }
  }

  private terminate(child: PreviewChild): Promise<void> {
    return (this.options.terminate ?? terminateTree)(child);
  }

  private fail(entry: Entry, message: string): void {
    if (this.entries.get(entry.sessionId) !== entry) return;
    entry.state = "failed";
    entry.phase = null;
    entry.message = message;
    this.lastFailure = { at: this.now(), message: message.slice(0, 200) };
    this.logger.warn({ event: "preview.failed", source: entry.plan?.source ?? null }, "preview did not start");
    // Whatever is left of the process tree goes with the failure.
    if (entry.child) void this.kill(entry);
    this.options.onStopped?.(entry.sessionId);
  }

  private refusal(sessionId: string, message: string): PreviewStatus {
    return { ...this.status(sessionId), state: this.entries.get(sessionId)?.state ?? "failed", message };
  }

  private retain(entry: Entry): void {
    this.ended.push(entry);
    if (this.ended.length > RETAINED_ENDED) this.ended.splice(0, this.ended.length - RETAINED_ENDED);
  }

  private userPath(): Promise<string> {
    this.pathPromise ??= (this.options.resolvePath ?? (() => resolvePreviewPath()))().catch(error => {
      this.pathPromise = null;
      throw error;
    });
    return this.pathPromise;
  }

  private view(entry: Entry): PreviewStatus {
    const plan = entry.plan;
    return {
      sessionId: entry.sessionId,
      state: entry.state,
      phase: entry.phase,
      url: entry.state === "running" && entry.port !== null ? `http://${PREVIEW_HOST}:${entry.port}` : null,
      port: entry.port,
      command: plan?.command ?? null,
      install: plan?.install ?? null,
      prepare: plan?.prepare ?? null,
      source: plan?.source ?? null,
      explanation: plan?.explanation ?? null,
      notes: [...entry.notes],
      message: entry.message,
      startedAt: entry.startedAt === null ? null : new Date(entry.startedAt).toISOString(),
      readyAt: entry.readyAt === null ? null : new Date(entry.readyAt).toISOString(),
      idleStopMinutes: Math.round(this.idleMs / 60_000),
      logTail: entry.logs.slice(-LOG_TAIL),
    };
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : "no exit code";
}

function stopMessage(reason: string): string {
  switch (reason) {
    case "idle": return "Stopped after it was idle (no viewer and no agent activity). Call preview_start to start it again.";
    case "agent": return "Stopped by the agent.";
    case "drain": case "lease_lost": return "Stopped because this computer stopped taking work.";
    case "restart": return "Restarted.";
    case "connector_stopping": return "Stopped because the connector is stopping.";
    default: return "Stopped because the session ended.";
  }
}

/** The platform shell runs the command; POSIX children lead their own process group. */
export function spawnShell(request: { command: string; cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  if (process.platform === "win32") {
    return spawn(request.env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", request.command], {
      cwd: request.cwd, env: request.env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, env: request.env, detached: supportsProcessGroups(), stdio: ["ignore", "pipe", "pipe"] });
}

/** Leader first, then the surviving group, SIGKILL after the grace; `taskkill /T` on Windows. */
export async function terminateTree(child: PreviewChild): Promise<void> {
  if (process.platform === "win32") {
    if (child.pid === undefined || child.exitCode !== null) return;
    await new Promise<void>(resolve => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, () => resolve()));
    return;
  }
  await stopProcessGroupLeaderFirst({ child: child as ChildProcess, timeoutMs: 5_000, killGraceMs: 2_000 });
}

export function probeHttp(host: string, port: number, path: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpRequest({ host, port, path, method: "GET", timeout: 2_000, headers: { accept: "text/html,*/*" } }, response => {
      response.resume();
      resolve(true);
    });
    req.once("timeout", () => { req.destroy(); resolve(false); });
    req.once("error", () => resolve(false));
    req.end();
  });
}

/** A free loopback port from the private preview range, never one another preview holds. */
export async function allocatePreviewPort(inUse: ReadonlySet<number>, range = PREVIEW_PORT_RANGE): Promise<number> {
  const size = range.last - range.first + 1;
  const offset = Math.floor(Math.random() * size);
  for (let attempt = 0; attempt < size; attempt += 1) {
    const port = range.first + ((offset + attempt) % size);
    if (inUse.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error("no free loopback port in the preview range");
}

function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: PREVIEW_HOST, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * The processes previews started, on disk, so a connector that crashed does
 * not leave dev servers running forever: the next start kills each recorded
 * process group whose leader is still exactly the recorded process (same pid
 * AND same start time; a reused pid is never signalled). Windows records
 * nothing: a preview there is stopped with its connector's job only.
 */
export class PreviewProcessRegistry {
  private readonly records = new Map<number, string>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly readIdentity: (pid: number) => string | null = readStartToken, private readonly logger: Logger = createLogger({ name: "preview" })) {}

  async record(pid: number): Promise<void> {
    const token = this.readIdentity(pid);
    if (token === null) return;
    this.records.set(pid, token);
    await this.persist();
  }

  async forget(pid: number | undefined): Promise<void> {
    if (pid !== undefined && this.records.delete(pid)) await this.persist();
    else await this.writing;
  }

  /** Kill what a previous connector process left behind; call before serving. */
  async sweep(signal: (pid: number) => void = pid => process.kill(-pid, "SIGKILL")): Promise<number> {
    let previous: Array<{ pid: number; token: string }> = [];
    try { previous = JSON.parse(await readFile(this.file, "utf8")) as Array<{ pid: number; token: string }>; } catch { previous = []; }
    let killed = 0;
    for (const record of Array.isArray(previous) ? previous : []) {
      if (!Number.isSafeInteger(record?.pid) || record.pid <= 1 || typeof record.token !== "string") continue;
      if (this.readIdentity(record.pid) !== record.token) continue;
      try { signal(record.pid); killed += 1; } catch { /* already gone */ }
    }
    if (killed > 0) this.logger.warn({ event: "preview.orphans_stopped", count: killed }, "stopped preview dev servers a previous connector process left running");
    this.records.clear();
    if (Array.isArray(previous) && previous.length > 0) await this.persist();
    return killed;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.records].map(([pid, token]) => ({ pid, token })));
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file, snapshot, { mode: 0o600 });
    }).catch(error => this.logger.warn({ event: "preview.registry_write_failed", err: error }, "preview process registry could not be written"));
    return this.writing;
  }
}

/** Process start identity: `ps lstart` on macOS, `/proc/<pid>/stat` start time on Linux. */
export function readStartToken(pid: number): string | null {
  if (process.platform === "darwin") {
    const identity = readDarwinProcessIdentity(pid);
    return identity && identity.processGroupId === pid ? identity.startToken : null;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[2] === String(pid) ? `linux:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  return null;
}
