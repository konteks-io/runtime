import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DoctorReportSchema, RemoteInstanceError, SupervisorStatusSchema, type ControlRequest } from "@konteks/remote-common";
import { isHostAgentId, nativeConnectorFileNames, resolveNativeConnectorExecutable } from "@konteks/remote-release";
import { NATIVE_SHUTDOWN_RECEIPT_FILE, assertLegacyCodexOwnerIdle, recordNativeUpdateAttempt, type NativeRuntimeRecord, type NativeUpdateAttempt } from "@konteks/remote-supervisor";
import { installNativeManual } from "./guide.js";
import { SupervisorControl } from "../control.js";
import type { NativeCommandContext } from "./cli.js";
import { readNativeRecord, restoreNativeRecord } from "./install.js";
import type { NativeServiceCommand, NativeServiceDefinition } from "./service.js";
import { commitNativeUpdate, stageNativeUpdate, type NativeUpdateDeps, type NativeUpdateStage } from "./update.js";

export interface UpdateControlClient {
  call<T>(request: ControlRequest, schema: { parse(value: unknown): T }, options?: { timeoutMs?: number }): Promise<T>;
}

/** Every side effect of the transaction is injectable so the orchestration itself is testable. */
export interface NativeUpdateTransactionDeps {
  readRecord: (root: string) => Promise<NativeRuntimeRecord>;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
  /** OS-specific codes that prove the user service is inactive or absent. */
  serviceStoppedCodes?: readonly number[];
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
  /** Repair manuals missing from installations created before offline guides shipped. */
  refreshManual?: (root: string) => Promise<unknown>;
  /**
   * The pid the service manager runs for the service, read before the stop so
   * its exit can be watched; null where it names none. launchd ends a
   * booted-out job 5 s after SIGTERM, before a busy connector writes its
   * shutdown receipt (D113b): its process being gone is then the proof.
   */
  servicePid?: (definition: NativeServiceDefinition) => Promise<number | null>;
  processAlive?: (pid: number) => boolean;
  /** Ends a process and its own process group, only while it is still this root's connector. */
  killProcessGroup?: (pid: number, root: string) => Promise<void>;
  drainDeadlineMs?: number;
  healthDeadlineMs?: number;
  /** How long the old service may take to exit and release the runtime directory after its stop command returned. */
  stopDeadlineMs?: number;
  /** How long a stopped connector may take to exit before its processes are ended. */
  stopGraceMs?: number;
  pollMs?: number;
}

export interface NativeUpdateInput extends NativeCommandContext {
  /** Launched by the supervisor rather than typed by an operator; recorded in the ledger. */
  unattended?: boolean;
  deps?: NativeUpdateDeps;
}

export type NativeUpdateOutcome =
  | { state: "current"; bundleVersion: string }
  | { state: "updated"; from: string; to: string; releaseId: string; previousReleaseId: string; restarted: boolean };

const DrainStatusSchema = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
const AgentsSchema = z.object({ agents: z.array(z.object({ agentId: z.string(), readiness: z.string() }).passthrough()) }).passthrough();
const CodexMaintenanceSchema = z.object({ idle: z.literal(true) }).strict();

export function productionUpdateDeps(input: { serviceDefinition: NativeUpdateTransactionDeps["serviceDefinition"]; execute: NativeUpdateTransactionDeps["execute"]; start: NativeUpdateTransactionDeps["start"]; serviceExits: NonNullable<NativeUpdateTransactionDeps["serviceExits"]>; forceStop?: NativeUpdateTransactionDeps["forceStop"] | undefined; servicePid?: NativeUpdateTransactionDeps["servicePid"] | undefined }): NativeUpdateTransactionDeps {
  const { forceStop, servicePid, ...rest } = input;
  return {
    ...rest,
    serviceStoppedCodes: process.platform === "darwin" ? [113] : process.platform === "win32" ? [1] : [3, 4],
    ...(forceStop ? { forceStop } : {}),
    ...(servicePid ? { servicePid, processAlive, killProcessGroup: endProcessGroup } : {}),
    refreshLauncher: refreshInstalledLauncher,
    refreshManual: installNativeManual,
    readRecord: readNativeRecord,
    control: (root, record) => new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort),
    stage: stageNativeUpdate,
    commit: commitNativeUpdate,
    restore: restoreNativeRecord,
    recordAttempt: recordNativeUpdateAttempt,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
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
  const refreshManual = async (): Promise<void> => {
    if (deps.refreshManual) await deps.refreshManual(input.root).catch(() => {
      input.output.line("The installed manual could not be refreshed. Use konteks-remote guide for offline help.");
    });
  };
  let staged: NativeUpdateStage;
  try {
    staged = await deps.stage({ root: input.root, output: input.output, ...(input.deps ? { deps: input.deps } : {}) });
  } catch (error) {
    // Nothing was changed, but the operator and the supervisor's ledger view
    // must still see that a launched transaction ended here.
    const startedAt = new Date(deps.now()).toISOString();
    await deps.recordAttempt(input.root, { id: `update-${randomUUID()}`, bundleVersion: "unknown", manifestDigest: "unknown", releaseId: null, reason: input.unattended ? "unattended" : "operator", startedAt, finishedAt: startedAt, outcome: "failed", detail: (error instanceof Error ? error.message : String(error)).slice(0, 1_024) }).catch(() => undefined);
    throw error;
  }
  if (staged.status === "current") {
    await refreshManual();
    input.output.line(`Installed release ${staged.bundleVersion} is current.`);
    const outcome: NativeUpdateOutcome = { state: "current", bundleVersion: staged.bundleVersion };
    input.output.result(outcome);
    return outcome;
  }
  const attempt: NativeUpdateAttempt = {
    id: `update-${randomUUID()}`, bundleVersion: staged.release.manifest.bundleVersion, manifestDigest: staged.release.manifest.digest, releaseId: staged.releaseId,
    reason: input.unattended ? "unattended" : "operator", startedAt: new Date(deps.now()).toISOString(), finishedAt: null, outcome: "in_progress", detail: null,
  };
  await deps.recordAttempt(input.root, attempt);
  const finish = async (outcome: NativeUpdateAttempt["outcome"], detail: string | null) => {
    await deps.recordAttempt(input.root, { ...attempt, outcome, detail: detail?.slice(0, 1_024) ?? null, finishedAt: new Date(deps.now()).toISOString() }).catch(() => undefined);
  };
  const definition = await deps.serviceDefinition(input.root);
  const serviceStatus = await deps.execute(definition.status);
  const serviceWasRunning = serviceStatus === 0;
  const control = deps.control(input.root, previous);
  // The private authenticated control channel also finds a foreground serve.
  // A service-manager status alone cannot prove that this folder is unowned.
  const foreground = !serviceWasRunning
    && await control.call({ op: "drain.status" }, DrainStatusSchema, { timeoutMs: 2_000 }).then(() => true, () => false);
  const wasRunning = serviceWasRunning || foreground;
  let stopped = false;
  let foregroundStopped = false;
  let oldPid: number | null = null;
  let successor: NativeRuntimeRecord | undefined;
  let failureStage = "service_state";
  try {
    if (!serviceWasRunning && deps.serviceStoppedCodes && (serviceStatus === null || !deps.serviceStoppedCodes.includes(serviceStatus))) {
      throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation's state; its running connector and installation are unchanged.");
    }
    // The previous release's own doctor result is the baseline; null when it
    // could not be read, and then only the successor's own agents can count.
    const baseline = wasRunning ? await doctorStatuses(control).catch(() => null) : null;
    if (wasRunning) {
      failureStage = "drain";
      await drain(input, control, deps);
      if (previous.agents.includes("codex")) {
        failureStage = "codex_preflight";
        try { await control.call({ op: "codex.maintenance.preflight" }, CodexMaintenanceSchema); }
        catch (error) {
          const unsupported = error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" &&
            error.message === "control_request_invalid: request does not match the closed control protocol";
          try {
            if (!unsupported || !deps.legacyCodexPreflight) throw error;
            await deps.legacyCodexPreflight(input.root, previous);
          } catch (failure) {
            await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
            throw failure;
          }
        }
      }
      failureStage = "stop_preparation";
      const previousReceipt = await deps.readStopReceipt?.(input.root) ?? null;
      oldPid = await deps.servicePid?.(definition).catch(() => null) ?? null;
      if (foreground) {
        failureStage = "foreground_shutdown";
        try { await control.call({ op: "shutdown" }, z.unknown()); }
        catch (error) {
          await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
          throw error;
        }
        input.output.line("Stopping the connector running in a terminal; the updated connector will start as this user's background service.");
      } else {
        failureStage = "service_stop";
        if (await deps.execute(definition.stop) !== 0) {
          await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
          throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; its installation was not changed.");
        }
      }
      stopped = true;
      // launchd and Task Scheduler acknowledge a stop before the process has
      // finished its graceful shutdown; the record may only move once the old
      // service is gone and has released the runtime directory.
      if (foreground) {
        failureStage = "foreground_exit";
        await waitForForegroundExit(input, control, deps, previousReceipt);
        foregroundStopped = true;
      }
      else {
        failureStage = "service_exit";
        await waitForServiceExit(input, definition, deps, previousReceipt, oldPid);
      }
    }
    failureStage = "commit";
    successor = await commitOnceReleased(input, staged.releaseId, deps);
    if (wasRunning) {
      input.output.line(`Starting ${successor.bundleVersion} and checking it is healthy before keeping it (up to ${spoken(deps.healthDeadlineMs ?? 180_000)})…`);
      failureStage = "service_start";
      await deps.start(input);
      failureStage = "health_gate";
      await healthGate(input, deps.control(input.root, successor), previous, successor, baseline, deps, definition);
    }
    await finish("applied", null);
    // The installed `konteks-remote` is the executable the person first
    // installed and nothing replaced it, so an operator's next update ran
    // weeks-old transaction code (D113: the 09-28 launcher drove 0.10.8's).
    if (deps.refreshLauncher) await deps.refreshLauncher(input.root, successor).catch(error => {
      input.output.line(`konteks-remote itself could not be refreshed to ${successor!.bundleVersion} (${error instanceof Error ? error.message : String(error)}); the connector is updated.`);
    });
    await refreshManual();
    const outcome: NativeUpdateOutcome = { state: "updated", from: previous.bundleVersion, to: successor.bundleVersion, releaseId: successor.releaseId, previousReleaseId: previous.releaseId, restarted: wasRunning };
    input.output.line(`Native connector updated ${outcome.from} → ${outcome.to}; ${previous.releaseId} is kept for rollback.`);
    input.output.result(outcome);
    return outcome;
  } catch (error) {
    const detail = `[${failureStage}] ${error instanceof Error ? error.message : String(error)}`;
    if (successor) {
      input.output.line(`Update to ${successor.bundleVersion} failed its health gate; rolling back to ${previous.releaseId}.`);
      let restored = false;
      try {
        await stopForRollback(input, definition, deps);
        await restoreOnceReleased(input, successor.releaseId, previous, deps);
        restored = true;
        if (wasRunning) {
          await deps.start(input);
          // The person checks right after; say only once the old release answers again.
          const back = await answersAgain(input, deps.control(input.root, previous), previous, deps);
          input.output.line(back
            ? `Rolled back: ${previous.bundleVersion} is running and answering again. ${successor.bundleVersion} was not kept.`
            : `Rolled back to ${previous.bundleVersion} and started it; it has not answered yet. Run \`konteks-remote status\` in a minute.`);
        }
        await finish("rolled_back", detail);
      } catch (rollbackError) {
        await finish("failed", `rollback failed after: ${detail}`);
        // Never leave this computer without its connector (D113: the rollback
        // gave up while launchd had already unloaded the service).
        if (wasRunning) await keepServiceRunning(input, definition, deps, restored ? previous : successor);
        throw new RemoteInstanceError("temporarily_unavailable", "The updated connector did not pass its health gate and automatic rollback failed; identity, credentials and workspaces remain preserved.", { cause: rollbackError });
      }
    } else {
      // Stopped but not swapped: the installation is unchanged, so the same
      // release comes back, confirmed or not (RCA 2026-09-30, D113b: 0.8.0's
      // launcher left an unconfirmed stop unloaded and the computer offline).
      if (stopped && wasRunning && (!foreground || foregroundStopped)) await restartUnchanged(input, definition, deps, previous, oldPid);
      else if (foreground && stopped) await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
      await finish("failed", detail);
    }
    throw error;
  }
}

async function waitForForegroundExit(input: NativeUpdateInput, control: UpdateControlClient, deps: NativeUpdateTransactionDeps, previousReceipt: string | null): Promise<void> {
  const deadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  for (;;) {
    // A receipt follows complete daemon cleanup. commitOnceReleased then takes
    // the same kernel ownership lock before any installation record can move.
    if (deps.readStopReceipt) {
      const receipt = await deps.readStopReceipt(input.root);
      if (receipt !== null && receipt !== previousReceipt) return;
    } else {
      const answering = await control.call({ op: "drain.status" }, DrainStatusSchema, { timeoutMs: 2_000 }).then(() => true, () => false);
      if (!answering) return;
    }
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", "The foreground connector did not finish stopping; its installation was not changed.");
    await deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  }
}

/**
 * The old connector is stopped once the OS no longer runs it and either it
 * wrote a fresh shutdown receipt or its process is gone. launchd SIGKILLs a
 * booted-out job 5 s after SIGTERM (measured 2026-10-02, D113b), so a
 * connector still closing its agents writes no receipt; a dead process holds
 * no lock, and the next start recovers what it journaled. One that outlives
 * the grace has its processes ended.
 */
async function waitForServiceExit(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps, previousReceipt: string | null, pid: number | null): Promise<void> {
  const stopMs = deps.stopDeadlineMs ?? 90_000;
  const started = deps.now();
  const deadline = started + stopMs;
  const graceMs = Math.min(deps.stopGraceMs ?? 30_000, stopMs);
  const watched = pid !== null && deps.processAlive ? { pid, alive: deps.processAlive } : null;
  const progress = progressLines(input, deps, "Stopping the connector: it closes its agent sessions and relay first, which usually takes under a minute…", "still stopping the connector");
  let forced = false;
  for (;;) {
    const running = await deps.execute(definition.status) === 0;
    const gone = watched !== null && !watched.alive(watched.pid);
    if (!running && (gone || !deps.readStopReceipt || await deps.readStopReceipt(input.root).then(receipt => receipt !== null && receipt !== previousReceipt))) return;
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime did not finish stopping in time; its installation was not changed.");
    if (watched && !gone && !forced && deps.killProcessGroup && deps.now() - started >= graceMs) {
      input.output.line(`The connector did not stop within ${spoken(graceMs)}; ending its processes.`);
      await deps.killProcessGroup(watched.pid, input.root).catch(() => undefined);
      forced = true;
      continue;
    }
    progress();
    await deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  }
}

/**
 * An update that stopped the connector but did not swap it: start the same
 * release and return only once it answers, or say plainly that it has not.
 * A process still running after the whole stop deadline is ended first, so
 * the start is not mistaken for "already running".
 */
async function restartUnchanged(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps, previous: NativeRuntimeRecord, pid: number | null): Promise<void> {
  const running = async () => await deps.execute(definition.status).catch(() => 0) === 0;
  if (await running()) {
    if (pid !== null && deps.killProcessGroup) await deps.killProcessGroup(pid, input.root).catch(() => undefined);
    else await deps.forceStop?.(definition).catch(() => undefined);
    for (let poll = 0; poll < 10 && await running(); poll += 1) await deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  }
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
 * keeps this computer connected (D113: its shutdown failed, no receipt was
 * written and the rollback waited out the deadline, then gave up). A stop
 * that does not finish ends the service's process group.
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
    await deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
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
    await deps.sleep(Math.min(deps.pollMs ?? 3_000, 3_000));
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
      const owned = error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" && /owns this native data directory/.test(error.message);
      if (!owned || deps.now() >= deadline) throw error;
      progress();
      await deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
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
 * informational (D113: 0.10.8 listed Google Antigravity, which this computer
 * never added, and the gate rolled back for it), except the check of an
 * agent the successor itself must run.
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
 * replaced without elevation, and from 0.10.11 it runs the installed
 * release's own executable instead (`launcher-delegate.ts`, D131).
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

export interface KeepLauncherCurrentDeps {
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
 * transaction refreshes it too, but only a launcher that has that code does:
 * the owner's was 0.8.0's, so every update it drove (0.10.9, 0.10.10) ran
 * 0.8.0's transaction and nothing ever replaced it (D113b). Waits while an
 * update is still checking this release, and leaves it alone unless this
 * process is the release the record names.
 */
export async function keepLauncherCurrent(root: string, deps: KeepLauncherCurrentDeps): Promise<"refreshed" | "current" | "skipped"> {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "debian";
  if (!(nativeConnectorFileNames(os) as string[]).includes(basename(deps.execPath))) return "skipped";
  for (;;) {
    const record = await deps.readRecord(root);
    if (resolve(dirname(deps.execPath)) !== resolve(root, "releases", record.releaseId)) return "skipped";
    const ledger = await deps.readLedger(root).catch(() => ({ attempts: [] }));
    const checking = ledger.attempts.some(attempt => attempt.outcome === "in_progress" && attempt.releaseId === record.releaseId &&
      deps.now() - Date.parse(attempt.startedAt) < (deps.staleAttemptMs ?? 45 * 60_000));
    if (!checking) return await deps.refresh(root, record) ? "refreshed" : "current";
    await deps.sleep(deps.pollMs ?? 5_000);
  }
}

/**
 * The successor must answer on the control socket with its own version, probe
 * every installed agent, and introduce no doctor failure that was not already
 * present; a pre-existing failure (an agent awaiting login) is not the update's.
 */
async function healthGate(input: NativeUpdateInput, control: UpdateControlClient, previous: NativeRuntimeRecord, successor: NativeRuntimeRecord, baseline: ReadonlyMap<string, string> | null, deps: NativeUpdateTransactionDeps, definition: NativeServiceDefinition): Promise<void> {
  const deadline = deps.now() + (deps.healthDeadlineMs ?? 180_000);
  const poll = deps.pollMs ?? 3_000;
  let answered = false;
  /** The agents the successor has not settled yet, named when the deadline passes. */
  let unsettled: string[] = [];
  const progress = progressLines(input, deps, `Waiting for ${successor.bundleVersion} to answer…`, `still waiting for ${successor.bundleVersion} to answer`);
  for (;;) {
    progress();
    try {
      const status = await control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 });
      answered = true;
      // The old process has already exited before the commit, so a different
      // version answering here is the wrong executable, not a transition.
      if (status.version.bundle !== successor.bundleVersion) throw new RemoteInstanceError("update_required", `the service answering reports ${status.version.bundle}, not ${successor.bundleVersion}`);
      const probed = await control.call({ op: "agents" }, AgentsSchema, { timeoutMs: 5_000 });
      // A host-installed agent (the person's own DeepSeek Harness or OpenCode) depends on
      // their install, not on this release: it never holds an update back.
      // An agent that could not start is settled too: it is listed as
      // unavailable, and whether that is new is the doctor check's call below.
      unsettled = successor.agents.filter(agentId => !isHostAgentId(agentId)).filter(agentId => !probed.agents.some(agent => agent.agentId === agentId && agent.readiness !== "unknown" && agent.readiness !== "probing"));
      if (unsettled.length === 0) break;
    } catch (error) {
      if (answered && error instanceof RemoteInstanceError && error.code === "update_required") throw error;
    }
    // A build that exits as it starts is restarted by the OS every few
    // seconds and will never answer: say so now rather than at the deadline.
    const exits = answered ? null : await deps.serviceExits?.(definition).catch(() => null);
    if (exits && exits.runs >= 3 && exits.lastExitCode) throw new RemoteInstanceError("temporarily_unavailable", `The updated connector stopped as soon as it started, ${exits.runs} times (exit code ${exits.lastExitCode}).`);
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", answered ? `The updated connector did not finish probing its agents in time (${unsettled.join(", ") || "unknown"}).` : "The updated connector did not answer on its control socket in time.");
    await deps.sleep(poll);
  }
  // Connectivity checks (relay, lease) settle seconds after start; a failure
  // counts against the update only if it is still there when the deadline passes.
  for (;;) {
    const failing = await failingDoctorDetails(control);
    const introduced = [...failing.keys()].filter(id => introducedByUpdate(id, baseline, successor));
    if (introduced.length === 0) {
      const added = [...failing.keys()].filter(id => baseline !== null && !baseline.has(id));
      if (added.length > 0) input.output.line(`${successor.bundleVersion} reports a check ${previous.bundleVersion} did not have: ${added.map(id => `${id} (${failing.get(id)})`).join(", ")}. It is not held against the update.`);
      break;
    }
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", `The updated connector introduced doctor failure(s): ${introduced.map(id => `${id} (${failing.get(id)})`).join(", ")}.`);
    input.output.line(`waiting for the updated connector to clear doctor failure(s): ${introduced.join(", ")}…`);
    await deps.sleep(poll);
  }
  for (const agent of (await control.call({ op: "agents" }, AgentsSchema)).agents) {
    if (agent.readiness === "reconnect_required") input.output.line(`agent ${agent.agentId} needs a fresh login after this update: run \`konteks-remote auth login ${agent.agentId}\`.`);
  }
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
