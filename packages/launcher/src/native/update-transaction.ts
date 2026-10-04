import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DoctorReportSchema, RemoteInstanceError, SupervisorStatusSchema, type ControlRequest } from "@konteks/remote-common";
import { isHostAgentId, nativeConnectorFileNames, resolveNativeConnectorExecutable } from "@konteks/remote-release";
import { NATIVE_SHUTDOWN_RECEIPT_FILE, assertLegacyCodexOwnerIdle, ownedByAnotherConnector, recordNativeUpdateAttempt, type NativeRuntimeRecord, type NativeUpdateAttempt } from "@konteks/remote-supervisor";
import { SupervisorControl } from "../control.js";
import type { NativeCommandContext } from "./cli.js";
import { readNativeRecord, restoreNativeRecord } from "./install.js";
import { CONNECTOR_LOG_FILE, type NativeServiceCommand, type NativeServiceDefinition } from "./service.js";
import { commitNativeUpdate, stageNativeUpdate, type NativeUpdateDeps, type NativeUpdateStage } from "./update.js";

interface UpdateControlClient {
  call<T>(request: ControlRequest, schema: { parse(value: unknown): T }, options?: { timeoutMs?: number }): Promise<T>;
}

/** Every side effect of the transaction is injectable so the orchestration itself is testable. */
export interface NativeUpdateTransactionDeps {
  readRecord: (root: string) => Promise<NativeRuntimeRecord>;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
  start: (input: NativeCommandContext) => Promise<void>;
  control: (root: string, record: NativeRuntimeRecord) => UpdateControlClient;
  stage: (options: { root: string; output: NativeCommandContext["output"]; deps?: NativeUpdateDeps }) => Promise<NativeUpdateStage>;
  commit: (options: { root: string; releaseId: string; output: NativeCommandContext["output"] }) => Promise<NativeRuntimeRecord>;
  restore: (root: string, expectedReleaseId: string, previous: NativeRuntimeRecord) => Promise<void>;
  recordAttempt: (root: string, attempt: NativeUpdateAttempt) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** A fresh receipt is written only after this connector's shutdown steps succeed. */
  readStopReceipt?: (root: string) => Promise<string | null>;
  /** Verify a running older connector's private Codex owner when it lacks preflight control. */
  legacyCodexPreflight?: (root: string, previous: NativeRuntimeRecord) => Promise<void>;
  /** How often the OS has started the service and its last exit code; null where it cannot say. */
  serviceExits?: (definition: NativeServiceDefinition) => Promise<{ runs: number; lastExitCode: number | null } | null>;
  /** Ends the service's own process group when a rollback's graceful stop does not finish; absent where the OS stop already kills it. */
  forceStop?: (definition: NativeServiceDefinition) => Promise<void>;
  /** Replaces the person's `konteks-remote` with the kept release's executable, so their next command runs the code they updated to. */
  refreshLauncher?: (root: string, record: NativeRuntimeRecord) => Promise<unknown>;
  /**
   * The pid the service manager runs for the service, read before the stop so
   * its exit can be watched; null where it names none. launchd ends a
   * booted-out job 5 s after SIGTERM, before a busy connector writes its
   * shutdown receipt: its process being gone is then the proof.
   */
  servicePid?: (definition: NativeServiceDefinition) => Promise<number | null>;
  processAlive?: (pid: number) => boolean;
  /** Ends a process and its own process group, only while it is still this root's connector. */
  killProcessGroup?: (pid: number, root: string) => Promise<void>;
  /**
   * A mark that changes whenever the starting connector shows progress (its
   * log grows); null where it cannot say. The health deadline counts from the
   * last change, so a slow start on a busy computer is not rolled back.
   */
  startupProgress?: (root: string) => Promise<string | null>;
  drainDeadlineMs?: number;
  /** How long the successor may show no progress before it is rolled back. */
  healthDeadlineMs?: number;
  /** How long the old service may take to exit and release the runtime directory after its stop command returned. */
  stopDeadlineMs?: number;
  /** How long a stopped connector may take to exit before its processes are ended. */
  stopGraceMs?: number;
  pollMs?: number;
}

interface NativeUpdateInput extends NativeCommandContext {
  /** Launched by the supervisor rather than typed by an operator; recorded in the ledger. */
  unattended?: boolean;
  deps?: NativeUpdateDeps;
}

type NativeUpdateOutcome =
  | { state: "current"; bundleVersion: string }
  | { state: "updated"; from: string; to: string; releaseId: string; previousReleaseId: string; restarted: boolean };

const DrainStatusSchema = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
const AgentsSchema = z.object({ agents: z.array(z.object({ agentId: z.string(), readiness: z.string() }).passthrough()) }).passthrough();
const CodexMaintenanceSchema = z.object({ idle: z.literal(true) }).strict();

export function productionUpdateDeps(input: { serviceDefinition: NativeUpdateTransactionDeps["serviceDefinition"]; execute: NativeUpdateTransactionDeps["execute"]; start: NativeUpdateTransactionDeps["start"]; serviceExits: NonNullable<NativeUpdateTransactionDeps["serviceExits"]>; forceStop?: NativeUpdateTransactionDeps["forceStop"] | undefined; servicePid?: NativeUpdateTransactionDeps["servicePid"] | undefined }): NativeUpdateTransactionDeps {
  const { forceStop, servicePid, ...rest } = input;
  return {
    ...rest,
    ...(forceStop ? { forceStop } : {}),
    ...(servicePid ? { servicePid, processAlive, killProcessGroup: endProcessGroup } : {}),
    refreshLauncher: refreshInstalledLauncher,
    readRecord: readNativeRecord,
    control: (root, record) => new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort),
    stage: stageNativeUpdate,
    commit: commitNativeUpdate,
    restore: restoreNativeRecord,
    recordAttempt: recordNativeUpdateAttempt,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
    startupProgress: async root => {
      const log = await stat(join(root, "logs", CONNECTOR_LOG_FILE)).catch(() => null);
      return log ? `${log.size}:${log.mtimeMs}` : null;
    },
    readStopReceipt: async root => readFile(join(root, "supervisor", NATIVE_SHUTDOWN_RECEIPT_FILE), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }),
    legacyCodexPreflight: (root, previous) => assertLegacyCodexOwnerIdle({ root, releaseId: previous.releaseId,
      ...(previous.codexHome ? { codexHome: previous.codexHome } : {}),
      ...(previous.codexSocket ? { codexSocket: previous.codexSocket } : {}) }),
  };
}

/**
 * The native update transaction: stage by digest → drain → stop → commit the
 * record → start → health gate (new version answering, agents probed, no new
 * doctor failure) → done; any failure after the commit restores the previous
 * record and restarts it. The previous release directory is never removed
 * here, so rollback needs no network. Outcomes land in the durable ledger the
 * supervisor consults before launching another attempt.
 */
export async function runNativeUpdate(input: NativeUpdateInput, deps: NativeUpdateTransactionDeps): Promise<NativeUpdateOutcome> {
  const previous = await deps.readRecord(input.root);
  const staged = await stageOrRecordFailure(input, deps);
  if (staged.status === "current") {
    input.output.line(`Installed release ${staged.bundleVersion} is current; nothing was changed.`);
    const outcome: NativeUpdateOutcome = { state: "current", bundleVersion: staged.bundleVersion };
    input.output.result(outcome);
    return outcome;
  }
  const attempt: NativeUpdateAttempt = {
    id: `update-${randomUUID()}`, bundleVersion: staged.release.manifest.bundleVersion, manifestDigest: staged.release.manifest.digest, releaseId: staged.releaseId,
    reason: attemptReason(input), startedAt: new Date(deps.now()).toISOString(), finishedAt: null, outcome: "in_progress", detail: null,
  };
  await deps.recordAttempt(input.root, attempt);
  const definition = await deps.serviceDefinition(input.root);
  const wasRunning = await deps.execute(definition.status) === 0;
  return new UpdateTransaction(input, deps, { previous, staged, attempt, definition, wasRunning }).run();
}

function attemptReason(input: NativeUpdateInput): NativeUpdateAttempt["reason"] {
  return input.unattended ? "unattended" : "operator";
}

/**
 * Nothing is changed when staging fails, but the operator and the
 * supervisor's ledger view must still see that a launched transaction ended
 * there.
 */
async function stageOrRecordFailure(input: NativeUpdateInput, deps: NativeUpdateTransactionDeps): Promise<NativeUpdateStage> {
  try {
    return await deps.stage({ root: input.root, output: input.output, ...(input.deps ? { deps: input.deps } : {}) });
  } catch (error) {
    const startedAt = new Date(deps.now()).toISOString();
    await deps.recordAttempt(input.root, { id: `update-${randomUUID()}`, bundleVersion: "unknown", manifestDigest: "unknown", releaseId: null, reason: attemptReason(input), startedAt, finishedAt: startedAt, outcome: "failed", detail: errorText(error).slice(0, 1_024) }).catch(() => undefined);
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One staged update: drain → stop → commit → start → health gate, rolled back on any failure after the commit. */
class UpdateTransaction {
  private readonly control: UpdateControlClient;
  private stopped = false;
  private oldPid: number | null = null;
  private successor: NativeRuntimeRecord | undefined;

  constructor(
    private readonly input: NativeUpdateInput,
    private readonly deps: NativeUpdateTransactionDeps,
    private readonly update: {
      previous: NativeRuntimeRecord; staged: Extract<NativeUpdateStage, { status: "staged" }>; attempt: NativeUpdateAttempt;
      definition: NativeServiceDefinition; wasRunning: boolean;
    },
  ) {
    this.control = deps.control(input.root, update.previous);
  }

  async run(): Promise<NativeUpdateOutcome> {
    try {
      return await this.apply();
    } catch (error) {
      await this.recover(errorText(error));
      throw error;
    }
  }

  private async apply(): Promise<NativeUpdateOutcome> {
    const { input, deps, update } = this;
    // The previous release's own doctor result is the baseline; null when it
    // could not be read, and then only the successor's own agents can count.
    const baseline = update.wasRunning ? await doctorStatuses(this.control).catch(() => null) : null;
    if (update.wasRunning) await this.stopPrevious();
    const successor = await commitOnceReleased(input, update.staged.releaseId, deps);
    this.successor = successor;
    if (update.wasRunning) {
      input.output.line(`Starting ${successor.bundleVersion} and checking it is healthy before keeping it (rolled back if it makes no progress for ${spoken(deps.healthDeadlineMs ?? 180_000)})…`);
      await deps.start(input);
      await healthGate(input, deps.control(input.root, successor), { previous: update.previous, successor, baseline }, deps, update.definition);
    }
    await this.finish("applied", null);
    await this.refreshLauncher(successor);
    const outcome: NativeUpdateOutcome = { state: "updated", from: update.previous.bundleVersion, to: successor.bundleVersion, releaseId: successor.releaseId, previousReleaseId: update.previous.releaseId, restarted: update.wasRunning };
    input.output.line(`Native connector updated ${outcome.from} → ${outcome.to}; ${update.previous.releaseId} is kept for rollback.`);
    input.output.result(outcome);
    return outcome;
  }

  /**
   * Drain, check Codex's shared owner is idle, stop, and wait until the old
   * service is gone: launchd and Task Scheduler acknowledge a stop before the
   * process has finished its graceful shutdown, and the record may only move
   * once it has released the runtime directory.
   */
  private async stopPrevious(): Promise<void> {
    const { input, deps, update } = this;
    await drain(input, this.control, deps);
    if (update.previous.agents.includes("codex")) await this.codexPreflight();
    const previousReceipt = await deps.readStopReceipt?.(input.root) ?? null;
    this.oldPid = await deps.servicePid?.(update.definition).catch(() => null) ?? null;
    if (await deps.execute(update.definition.stop) !== 0) {
      await this.cancelDrain();
      throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; its installation was not changed.");
    }
    this.stopped = true;
    await waitForServiceExit(input, update.definition, deps, previousReceipt, this.oldPid);
  }

  /** The running connector's Codex owner must be idle; an older one without the control op is checked directly. */
  private async codexPreflight(): Promise<void> {
    try { await this.control.call({ op: "codex.maintenance.preflight" }, CodexMaintenanceSchema); }
    catch (error) {
      try {
        if (!closedProtocolRefusal(error) || !this.deps.legacyCodexPreflight) throw error;
        await this.deps.legacyCodexPreflight(this.input.root, this.update.previous);
      } catch (failure) {
        await this.cancelDrain();
        throw failure;
      }
    }
  }

  private cancelDrain(): Promise<unknown> {
    return this.control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
  }

  private async finish(outcome: NativeUpdateAttempt["outcome"], detail: string | null): Promise<void> {
    await this.deps.recordAttempt(this.input.root, { ...this.update.attempt, outcome, detail: detail?.slice(0, 1_024) ?? null, finishedAt: new Date(this.deps.now()).toISOString() }).catch(() => undefined);
  }

  /**
   * The installed `konteks-remote` is the executable the person first
   * installed and nothing replaced it, so an operator's next update would run
   * weeks-old transaction code.
   */
  private async refreshLauncher(successor: NativeRuntimeRecord): Promise<void> {
    if (!this.deps.refreshLauncher) return;
    await this.deps.refreshLauncher(this.input.root, successor).catch(error => {
      this.input.output.line(`konteks-remote itself could not be refreshed to ${successor.bundleVersion} (${errorText(error)}); the connector is updated.`);
    });
  }

  private async recover(detail: string): Promise<void> {
    if (this.successor) return this.rollBack(this.successor, detail);
    // Stopped but not swapped: the installation is unchanged, so the same
    // release comes back, confirmed or not (an unconfirmed stop left unloaded
    // would leave the computer offline).
    if (this.stopped && this.update.wasRunning) await restartUnchanged(this.input, this.update.definition, this.deps, this.update.previous, this.oldPid);
    await this.finish("failed", detail);
  }

  private async rollBack(successor: NativeRuntimeRecord, detail: string): Promise<void> {
    const { input, deps, update } = this;
    input.output.line(`Update to ${successor.bundleVersion} failed its health gate; rolling back to ${update.previous.releaseId}.`);
    let restored = false;
    try {
      await stopForRollback(input, update.definition, deps);
      await restoreOnceReleased(input, successor.releaseId, update.previous, deps);
      restored = true;
      if (update.wasRunning) await this.restartPrevious(successor);
      await this.finish("rolled_back", detail);
    } catch (rollbackError) {
      await this.finish("failed", `rollback failed after: ${detail}`);
      // Never leave this computer without its connector.
      if (update.wasRunning) await keepServiceRunning(input, update.definition, deps, restored ? update.previous : successor);
      throw new RemoteInstanceError("temporarily_unavailable", "The updated connector did not pass its health gate and automatic rollback failed; identity, credentials and workspaces remain preserved.", { cause: rollbackError });
    }
  }

  /** The person checks right after; say only once the old release answers again. */
  private async restartPrevious(successor: NativeRuntimeRecord): Promise<void> {
    const { input, deps, update } = this;
    await deps.start(input);
    const back = await answersAgain(input, deps.control(input.root, update.previous), update.previous, deps);
    input.output.line(back
      ? `Rolled back: ${update.previous.bundleVersion} is running and answering again. ${successor.bundleVersion} was not kept.`
      : `Rolled back to ${update.previous.bundleVersion} and started it; it has not answered yet. Run \`konteks-remote status\` in a minute.`);
  }
}

/** An older connector refuses an op its closed control protocol does not have. */
function closedProtocolRefusal(error: unknown): boolean {
  return error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" &&
    error.message === "control_request_invalid: request does not match the closed control protocol";
}

/**
 * The old connector is stopped once the OS no longer runs it and either it
 * wrote a fresh shutdown receipt or its process is gone. launchd SIGKILLs a
 * booted-out job 5 s after SIGTERM, so a
 * connector still closing its agents writes no receipt; a dead process holds
 * no lock, and the next start recovers what it journaled. One that outlives
 * the grace has its processes ended.
 */
function waitForServiceExit(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps, previousReceipt: string | null, pid: number | null): Promise<void> {
  return new ServiceExitWait(input, definition, deps, previousReceipt, pid).run();
}

class ServiceExitWait {
  private readonly started: number;
  private readonly stopMs: number;
  private readonly graceMs: number;
  private readonly watched: { pid: number; alive: (pid: number) => boolean } | null;
  private readonly progress: () => void;
  private gone = false;
  private forced = false;

  constructor(
    private readonly input: NativeUpdateInput,
    private readonly definition: NativeServiceDefinition,
    private readonly deps: NativeUpdateTransactionDeps,
    private readonly previousReceipt: string | null,
    pid: number | null,
  ) {
    this.stopMs = deps.stopDeadlineMs ?? 90_000;
    this.started = deps.now();
    this.graceMs = Math.min(deps.stopGraceMs ?? 30_000, this.stopMs);
    this.watched = pid !== null && deps.processAlive ? { pid, alive: deps.processAlive } : null;
    this.progress = progressLines(input, deps, "Stopping the connector: it closes its agent sessions and relay first, which usually takes under a minute…", "still stopping the connector");
  }

  async run(): Promise<void> {
    for (;;) {
      if (await this.exited()) return;
      if (this.deps.now() >= this.started + this.stopMs) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime did not finish stopping in time; its installation was not changed.");
      if (await this.forcedAfterGrace()) continue;
      this.progress();
      await this.deps.sleep(cappedPoll(this.deps, 1_000));
    }
  }

  private async exited(): Promise<boolean> {
    const running = await this.deps.execute(this.definition.status) === 0;
    this.gone = this.watched !== null && !this.watched.alive(this.watched.pid);
    return !running && await stopConfirmed(this.input, this.deps, this.gone, this.previousReceipt);
  }

  /** One that outlives the grace has its processes ended, once. */
  private async forcedAfterGrace(): Promise<boolean> {
    const { watched, deps } = this;
    if (!watched || this.gone || this.forced || !deps.killProcessGroup || deps.now() - this.started < this.graceMs) return false;
    this.input.output.line(`The connector did not stop within ${spoken(this.graceMs)}; ending its processes.`);
    await deps.killProcessGroup(watched.pid, this.input.root).catch(() => undefined);
    this.forced = true;
    return true;
  }
}

/** A stopped service is gone once its process is, or once it wrote a shutdown receipt newer than the one before the stop. */
async function stopConfirmed(input: NativeUpdateInput, deps: NativeUpdateTransactionDeps, gone: boolean, previousReceipt: string | null): Promise<boolean> {
  if (gone || !deps.readStopReceipt) return true;
  const receipt = await deps.readStopReceipt(input.root);
  return receipt !== null && receipt !== previousReceipt;
}

/** The configured poll interval, never longer than `cap`. */
function cappedPoll(deps: NativeUpdateTransactionDeps, cap: number): number {
  return Math.min(deps.pollMs ?? cap, cap);
}

/**
 * An update that stopped the connector but did not swap it: start the same
 * release and return only once it answers, or say plainly that it has not.
 * A process still running after the whole stop deadline is ended first, so
 * the start is not mistaken for "already running".
 */
async function restartUnchanged(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps, previous: NativeRuntimeRecord, pid: number | null): Promise<void> {
  await endLingeringService(input, definition, deps, pid);
  input.output.line("The update did not go ahead; starting this computer's connector again on the release it had.");
  try {
    await deps.start(input);
  } catch {
    input.output.line("The connector could not be started again; run `konteks-remote start`.");
    return;
  }
  const back = await answersAgain(input, deps.control(input.root, previous), previous, deps);
  input.output.line(back
    ? `${previous.bundleVersion} is running and answering again; nothing was changed.`
    : `${previous.bundleVersion} was started again but has not answered yet; run \`konteks-remote status\` in a minute.`);
}

async function endLingeringService(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps, pid: number | null): Promise<void> {
  const running = async () => await deps.execute(definition.status).catch(() => 0) === 0;
  if (!await running()) return;
  if (pid !== null && deps.killProcessGroup) await deps.killProcessGroup(pid, input.root).catch(() => undefined);
  else await deps.forceStop?.(definition).catch(() => undefined);
  for (let poll = 0; poll < 10 && await running(); poll += 1) await deps.sleep(cappedPoll(deps, 1_000));
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A pid the OS may since have given to another program is checked first: only this root's `serve` is ended. */
async function endProcessGroup(pid: number, root: string): Promise<void> {
  const command = await new Promise<string | null>(done => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => done(error ? null : stdout.trim()));
  });
  if (!command || !command.includes(" serve ") || !command.includes(resolve(root))) return;
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* not a group leader: the process alone */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/**
 * Stop a successor that failed its gate. Its shutdown receipt is not waited
 * for: once the OS no longer runs it, restoring the previous release is what
 * keeps this computer connected; a successor whose shutdown fails writes no
 * receipt. A stop that does not finish ends the service's process group.
 */
async function stopForRollback(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps): Promise<void> {
  await deps.execute(definition.stop).catch(() => null);
  const running = async () => await deps.execute(definition.status).catch(() => 0) === 0;
  const stopMs = deps.stopDeadlineMs ?? 90_000;
  const deadline = deps.now() + stopMs;
  const progress = progressLines(input, deps, "Stopping the updated connector before restoring the previous release…", "still stopping the updated connector");
  let forced = false;
  while (await running()) {
    if (deps.now() >= deadline) {
      if (forced || !deps.forceStop) throw new RemoteInstanceError("temporarily_unavailable", "The updated connector did not stop, so the previous release could not be restored.");
      input.output.line(`The updated connector did not stop within ${spoken(stopMs)}; ending its processes.`);
      await deps.forceStop(definition).catch(() => undefined);
      forced = true;
      continue;
    }
    progress();
    await deps.sleep(cappedPoll(deps, 1_000));
  }
}

/** Last resort after a failed rollback: whatever release the record names runs, rather than none. */
async function keepServiceRunning(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps, record: NativeRuntimeRecord): Promise<void> {
  if (await deps.execute(definition.status).catch(() => null) === 0) return;
  try {
    await deps.start(input);
    input.output.line(`Started ${record.bundleVersion} again so this computer stays connected; run \`konteks-remote status\` to check it.`);
  } catch {
    input.output.line("The connector could not be started again; run `konteks-remote start`.");
  }
}

/** Whether the restored release answers on its control socket within the stop deadline. */
async function answersAgain(input: NativeUpdateInput, control: UpdateControlClient, record: NativeRuntimeRecord, deps: NativeUpdateTransactionDeps): Promise<boolean> {
  const deadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  const progress = progressLines(input, deps, `Waiting for ${record.bundleVersion} to answer again…`, `still waiting for ${record.bundleVersion} to answer`);
  for (;;) {
    progress();
    const status = await control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 }).catch(() => null);
    if (status) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(cappedPoll(deps, 3_000));
  }
}

function spoken(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1_000)} s`;
}

/**
 * A wait the person watches: say once what is happening and roughly how long
 * it takes, then only every ten seconds how long it has been, so a normal wait
 * never reads as a loop.
 */
function progressLines(input: NativeUpdateInput, deps: NativeUpdateTransactionDeps, first: string, again: string): () => void {
  const started = deps.now();
  let said = -1;
  return () => {
    const tens = Math.floor((deps.now() - started) / 10_000);
    if (tens === said) return;
    input.output.line(said < 0 ? first : `${again} (${tens * 10} s so far)…`);
    said = tens;
  };
}

/** The previous process releases the runtime directory only at the very end of its shutdown. */
function commitOnceReleased(input: NativeUpdateInput, releaseId: string, deps: NativeUpdateTransactionDeps): Promise<NativeRuntimeRecord> {
  return onceReleased(input, deps, () => deps.commit({ root: input.root, releaseId, output: input.output }));
}
function restoreOnceReleased(input: NativeUpdateInput, expectedReleaseId: string, previous: NativeRuntimeRecord, deps: NativeUpdateTransactionDeps): Promise<void> {
  return onceReleased(input, deps, () => deps.restore(input.root, expectedReleaseId, previous));
}
async function onceReleased<T>(input: NativeUpdateInput, deps: NativeUpdateTransactionDeps, operation: () => Promise<T>): Promise<T> {
  const deadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  const progress = progressLines(input, deps, "Waiting for the stopped connector to let go of its files…", "still waiting for the stopped connector to let go of its files");
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!ownedByAnotherConnector(error) || deps.now() >= deadline) throw error;
      progress();
      await deps.sleep(cappedPoll(deps, 1_000));
    }
  }
}

async function drain(input: NativeUpdateInput, control: UpdateControlClient, deps: NativeUpdateTransactionDeps): Promise<void> {
  await control.call({ op: "drain", reason: "update" }, z.unknown());
  const deadline = deps.now() + (deps.drainDeadlineMs ?? 15 * 60_000);
  for (;;) {
    const state = await control.call({ op: "drain.status" }, DrainStatusSchema);
    // Idle ACP sessions are durable and resume after restart; only an
    // executing assignment must reach its terminal report first.
    if (state.activeAssignments === 0) return;
    if (deps.now() >= deadline) {
      await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
      throw new RemoteInstanceError("active_work", "The update waited for active work past its deadline; the running release resumed accepting work and was not changed.");
    }
    input.output.line(`waiting for ${state.activeAssignments} active assignment(s) before updating…`);
    await deps.sleep(deps.pollMs ?? 5_000);
  }
}

/** Every check's status, as the previous release reports it. */
async function doctorStatuses(control: UpdateControlClient): Promise<Map<string, string>> {
  const report = await control.call({ op: "doctor" }, DoctorReportSchema);
  return new Map(report.checks.map(check => [check.id, check.status]));
}

/** Each failing check's id and what it says, so a rollback can name why. */
async function failingDoctorDetails(control: UpdateControlClient): Promise<Map<string, string>> {
  const report = await control.call({ op: "doctor" }, DoctorReportSchema);
  return new Map(report.checks.filter(check => check.status === "fail").map(check => [check.id, check.detail]));
}

/**
 * Whether a check failing on the successor is the update's doing: the
 * previous release reported the same check and it did not fail there. A
 * check the previous release never reported is new in this release and only
 * informational (an agent check for an agent this computer never added),
 * except the check of an agent the successor itself must run.
 */
function introducedByUpdate(id: string, baseline: ReadonlyMap<string, string> | null, successor: NativeRuntimeRecord): boolean {
  const before = baseline?.get(id);
  if (before !== undefined) return before !== "fail";
  const agentId = id.startsWith("agent-") ? id.slice("agent-".length) : null;
  return agentId !== null && (successor.agents as readonly string[]).includes(agentId) && !isHostAgentId(agentId);
}

/**
 * Replace `<root>/bin/konteks-remote` with the kept release's executable when
 * it differs; true when it was replaced. A no-op where none was installed
 * there, and on Windows: the MSI's command under Program Files cannot be
 * replaced without elevation, and it runs the installed release's own
 * executable instead (`launcher-delegate.ts`).
 */
export async function refreshInstalledLauncher(root: string, record: NativeRuntimeRecord): Promise<boolean> {
  if (process.platform === "win32") return false;
  const target = join(root, "bin", "konteks-remote");
  if (!await stat(target).then(info => info.isFile(), () => false)) return false;
  const source = await resolveNativeConnectorExecutable(join(root, "releases", record.releaseId), process.platform === "darwin" ? "macos" : "debian");
  if (await sameContents(source, target)) return false;
  const staged = `${target}.update-${process.pid}`;
  try {
    await copyFile(source, staged);
    await chmod(staged, 0o755);
    // A rename replaces the file a running command was started from without touching that process.
    await rename(staged, target);
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
  return true;
}

async function sameContents(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([stat(a), stat(b)]);
  if (left.size !== right.size) return false;
  const digest = (path: string) => new Promise<string>((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", chunk => hash.update(chunk)).once("error", fail).once("end", () => done(hash.digest("hex")));
  });
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x === y;
}

interface KeepLauncherCurrentDeps {
  /** This process: a release's `konteks-connector` (or `connector`), or node in development. */
  execPath: string;
  readRecord: (root: string) => Promise<NativeRuntimeRecord>;
  readLedger: (root: string) => Promise<{ attempts: readonly NativeUpdateAttempt[] }>;
  refresh: (root: string, record: NativeRuntimeRecord) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs?: number;
  /** An `in_progress` attempt older than this is abandoned (as the supervisor's update coordinator treats it). */
  staleAttemptMs?: number;
}

/**
 * The running release keeps `<root>/bin/konteks-remote` on its own code. The
 * transaction refreshes it too, but only a launcher that has that code does,
 * so an older launcher would otherwise keep driving updates with its own old
 * transaction. Waits while an
 * update is still checking this release, and leaves it alone unless this
 * process is the release the record names.
 */
export async function keepLauncherCurrent(root: string, deps: KeepLauncherCurrentDeps): Promise<"refreshed" | "current" | "skipped"> {
  if (!(nativeConnectorFileNames(hostOs()) as string[]).includes(basename(deps.execPath))) return "skipped";
  for (;;) {
    const record = await deps.readRecord(root);
    if (resolve(dirname(deps.execPath)) !== resolve(root, "releases", record.releaseId)) return "skipped";
    const ledger = await deps.readLedger(root).catch(() => ({ attempts: [] }));
    if (!stillChecking(ledger.attempts, record, deps)) return await deps.refresh(root, record) ? "refreshed" : "current";
    await deps.sleep(deps.pollMs ?? 5_000);
  }
}

function hostOs(): "windows" | "macos" | "debian" {
  if (process.platform === "win32") return "windows";
  return process.platform === "darwin" ? "macos" : "debian";
}

/** Whether an update is still checking this release: an `in_progress` attempt for it that is not stale. */
function stillChecking(attempts: readonly NativeUpdateAttempt[], record: NativeRuntimeRecord, deps: KeepLauncherCurrentDeps): boolean {
  const staleMs = deps.staleAttemptMs ?? 45 * 60_000;
  return attempts.some(attempt => attempt.outcome === "in_progress" && attempt.releaseId === record.releaseId && deps.now() - Date.parse(attempt.startedAt) < staleMs);
}

interface GateVersions {
  previous: NativeRuntimeRecord;
  successor: NativeRuntimeRecord;
  /** The previous release's doctor statuses; null when they could not be read. */
  baseline: ReadonlyMap<string, string> | null;
}

/**
 * The successor must answer on the control socket with its own version, probe
 * every installed agent, and introduce no doctor failure that was not already
 * present; a pre-existing failure (an agent awaiting login) is not the update's.
 */
async function healthGate(input: NativeUpdateInput, control: UpdateControlClient, versions: GateVersions, deps: NativeUpdateTransactionDeps, definition: NativeServiceDefinition): Promise<void> {
  const quietMs = deps.healthDeadlineMs ?? 180_000;
  const clock: GateClock = { deps, definition, root: input.root, quietMs, deadline: deps.now() + quietMs, poll: deps.pollMs ?? 3_000 };
  await agentsSettled(input, control, versions.successor, clock);
  // Connectivity checks (relay, lease) settle seconds after start; they get a
  // full quiet window after the agents settled.
  clock.deadline = Math.max(clock.deadline, deps.now() + quietMs);
  await noIntroducedFailures(input, control, versions, clock);
  for (const agent of (await control.call({ op: "agents" }, AgentsSchema)).agents) {
    if (agent.readiness === "reconnect_required") input.output.line(`agent ${agent.agentId} needs a fresh login after this update: run \`konteks-remote auth login ${agent.agentId}\`.`);
  }
}

interface GateClock {
  deps: NativeUpdateTransactionDeps;
  definition: NativeServiceDefinition;
  root: string;
  /** How long the successor may show no progress. */
  quietMs: number;
  /** Moves forward whenever the successor shows progress while starting. */
  deadline: number;
  poll: number;
  /** The last startup progress mark seen; undefined before the first. */
  progressMark?: string;
}

interface ProbeState {
  answered: boolean;
  /** The agents the successor has not settled yet, named when the deadline passes. */
  unsettled: string[];
}

async function agentsSettled(input: NativeUpdateInput, control: UpdateControlClient, successor: NativeRuntimeRecord, clock: GateClock): Promise<void> {
  const state: ProbeState = { answered: false, unsettled: [] };
  const progress = progressLines(input, clock.deps, `Waiting for ${successor.bundleVersion} to answer…`, `still waiting for ${successor.bundleVersion} to answer`);
  for (;;) {
    progress();
    if (await probeSuccessor(control, successor, state)) return;
    await giveUpIfHopeless(state, clock);
    await clock.deps.sleep(clock.poll);
  }
}

/** One probe; true once every agent the successor must run has settled. */
async function probeSuccessor(control: UpdateControlClient, successor: NativeRuntimeRecord, state: ProbeState): Promise<boolean> {
  try {
    const status = await control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 });
    state.answered = true;
    // The old process has already exited before the commit, so a different
    // version answering here is the wrong executable, not a transition.
    if (status.version.bundle !== successor.bundleVersion) throw new RemoteInstanceError("update_required", `the service answering reports ${status.version.bundle}, not ${successor.bundleVersion}`);
    const probed = await control.call({ op: "agents" }, AgentsSchema, { timeoutMs: 5_000 });
    state.unsettled = unsettledAgents(successor, probed.agents);
    return state.unsettled.length === 0;
  } catch (error) {
    if (state.answered && error instanceof RemoteInstanceError && error.code === "update_required") throw error;
    return false;
  }
}

/**
 * A host-installed agent (the person's own DeepSeek Harness or OpenCode)
 * depends on their install, not on this release: it never holds an update
 * back. An agent that could not start is settled too: it is listed as
 * unavailable, and whether that is new is the doctor check's call.
 */
function unsettledAgents(successor: NativeRuntimeRecord, probed: readonly { agentId: string; readiness: string }[]): string[] {
  const settled = (agentId: string) => probed.some(agent => agent.agentId === agentId && agent.readiness !== "unknown" && agent.readiness !== "probing");
  return successor.agents.filter(agentId => !isHostAgentId(agentId) && !settled(agentId));
}

/**
 * A build that exits as it starts is restarted by the OS every few seconds
 * and will never answer: say so now rather than at the deadline.
 */
async function giveUpIfHopeless(state: ProbeState, clock: GateClock): Promise<void> {
  const exits = state.answered ? null : await clock.deps.serviceExits?.(clock.definition).catch(() => null);
  if (exits && exits.runs >= 3 && exits.lastExitCode) throw new RemoteInstanceError("temporarily_unavailable", `The updated connector stopped as soon as it started, ${exits.runs} times (exit code ${exits.lastExitCode}).`);
  await extendOnProgress(clock);
  if (clock.deps.now() >= clock.deadline) throw new RemoteInstanceError("temporarily_unavailable", probeTimeoutMessage(state));
}

/**
 * A connector still starting (QA browser, agent packages, model discovery)
 * keeps writing its log, and on a loaded computer that alone can take over
 * three minutes. Only a successor that stops making progress is rolled back.
 */
async function extendOnProgress(clock: GateClock): Promise<void> {
  const mark = await clock.deps.startupProgress?.(clock.root).catch(() => null) ?? null;
  if (mark === null) return;
  if (clock.progressMark !== undefined && mark !== clock.progressMark) clock.deadline = clock.deps.now() + clock.quietMs;
  clock.progressMark = mark;
}

function probeTimeoutMessage(state: ProbeState): string {
  if (!state.answered) return "The updated connector stopped making progress before it answered on its control socket.";
  return `The updated connector stopped making progress while probing its agents (${state.unsettled.join(", ") || "unknown"}).`;
}

/**
 * Connectivity checks (relay, lease) settle seconds after start; a failure
 * counts against the update only if it is still there when the deadline passes.
 */
async function noIntroducedFailures(input: NativeUpdateInput, control: UpdateControlClient, versions: GateVersions, clock: GateClock): Promise<void> {
  for (;;) {
    const failing = await failingDoctorDetails(control);
    const introduced = [...failing.keys()].filter(id => introducedByUpdate(id, versions.baseline, versions.successor));
    if (introduced.length === 0) return reportNewChecks(input, failing, versions);
    if (clock.deps.now() >= clock.deadline) throw new RemoteInstanceError("temporarily_unavailable", `The updated connector introduced doctor failure(s): ${describeChecks(introduced, failing)}.`);
    input.output.line(`waiting for the updated connector to clear doctor failure(s): ${introduced.join(", ")}…`);
    await clock.deps.sleep(clock.poll);
  }
}

/** A failing check the previous release never reported is named, but not held against the update. */
function reportNewChecks(input: NativeUpdateInput, failing: ReadonlyMap<string, string>, versions: GateVersions): void {
  const { baseline } = versions;
  const added = [...failing.keys()].filter(id => baseline !== null && !baseline.has(id));
  if (added.length > 0) input.output.line(`${versions.successor.bundleVersion} reports a check ${versions.previous.bundleVersion} did not have: ${describeChecks(added, failing)}. It is not held against the update.`);
}

function describeChecks(ids: readonly string[], failing: ReadonlyMap<string, string>): string {
  return ids.map(id => `${id} (${failing.get(id)})`).join(", ");
}

/**
 * The last attempt on this machine that could not keep this exact release, if
 * any. A release that already rolled back here is the same bytes next time,
 * so the person hears that before being offered it again.
 */
export function earlierFailure(attempts: readonly NativeUpdateAttempt[], manifestDigest: string): NativeUpdateAttempt | null {
  const last = [...attempts].reverse().find(attempt => attempt.manifestDigest === manifestDigest && attempt.outcome !== "in_progress");
  return last && (last.outcome === "rolled_back" || last.outcome === "failed") ? last : null;
}

/**
 * When the installed release is one the connector updated itself to, the
 * person hears that, instead of a bare "current" after being offered it.
 */
export function selfUpdateNote(attempts: readonly NativeUpdateAttempt[], bundleVersion: string): string | null {
  const last = [...attempts].reverse().find(attempt => attempt.bundleVersion === bundleVersion && attempt.outcome !== "in_progress");
  return last && last.outcome === "applied" && last.reason === "unattended" ? `Konteks updated itself to ${bundleVersion} at ${last.finishedAt ?? last.startedAt}.` : null;
}

export function earlierFailureNote(attempt: NativeUpdateAttempt): string {
  const when = attempt.finishedAt ?? attempt.startedAt;
  const how = attempt.outcome === "rolled_back" ? "failed its health check here and was rolled back" : "failed here";
  return `${attempt.bundleVersion} already ${how} (${when}${attempt.detail ? `: ${attempt.detail}` : ""}). Installing it again installs the same release; it is usually better to wait for a newer one.`;
}
