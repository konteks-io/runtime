import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DoctorReportSchema, RemoteInstanceError, SupervisorStatusSchema, type ControlRequest } from "@konteks/remote-common";
import { recordNativeUpdateAttempt, type NativeRuntimeRecord, type NativeUpdateAttempt } from "@konteks/remote-supervisor";
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
  start: (input: NativeCommandContext) => Promise<void>;
  control: (root: string, record: NativeRuntimeRecord) => UpdateControlClient;
  stage: (options: { root: string; output: NativeCommandContext["output"]; deps?: NativeUpdateDeps }) => Promise<NativeUpdateStage>;
  commit: (options: { root: string; releaseId: string; output: NativeCommandContext["output"] }) => Promise<NativeRuntimeRecord>;
  restore: (root: string, expectedReleaseId: string, previous: NativeRuntimeRecord) => Promise<void>;
  recordAttempt: (root: string, attempt: NativeUpdateAttempt) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  drainDeadlineMs?: number;
  healthDeadlineMs?: number;
  /** How long the old service may take to exit and release the runtime directory after its stop command returned. */
  stopDeadlineMs?: number;
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

export function productionUpdateDeps(input: { serviceDefinition: NativeUpdateTransactionDeps["serviceDefinition"]; execute: NativeUpdateTransactionDeps["execute"]; start: NativeUpdateTransactionDeps["start"] }): NativeUpdateTransactionDeps {
  return {
    ...input,
    readRecord: readNativeRecord,
    control: (root, record) => new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort),
    stage: stageNativeUpdate,
    commit: commitNativeUpdate,
    restore: restoreNativeRecord,
    recordAttempt: recordNativeUpdateAttempt,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
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
    input.output.line(`Installed release ${staged.bundleVersion} is current; nothing was changed.`);
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
  const wasRunning = await deps.execute(definition.status) === 0;
  const control = deps.control(input.root, previous);
  let stopped = false;
  let successor: NativeRuntimeRecord | undefined;
  try {
    const failingBefore = wasRunning ? await failingDoctorChecks(control).catch(() => new Set<string>()) : new Set<string>();
    if (wasRunning) {
      await drain(input, control, deps);
      if (await deps.execute(definition.stop) !== 0) {
        await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
        throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; its installation was not changed.");
      }
      stopped = true;
      // launchd and Task Scheduler acknowledge a stop before the process has
      // finished its graceful shutdown; the record may only move once the old
      // service is gone and has released the runtime directory.
      await waitForServiceExit(input, definition, deps);
    }
    successor = await commitOnceReleased(input, staged.releaseId, deps);
    if (wasRunning) {
      await deps.start(input);
      await healthGate(input, deps.control(input.root, successor), successor, failingBefore, deps);
    }
    await finish("applied", null);
    const outcome: NativeUpdateOutcome = { state: "updated", from: previous.bundleVersion, to: successor.bundleVersion, releaseId: successor.releaseId, previousReleaseId: previous.releaseId, restarted: wasRunning };
    input.output.line(`Native connector updated ${outcome.from} → ${outcome.to}; ${previous.releaseId} is kept for rollback.`);
    input.output.result(outcome);
    return outcome;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (successor) {
      input.output.line(`Update to ${successor.bundleVersion} failed its health gate; rolling back to ${previous.releaseId}.`);
      try {
        if (await deps.execute(definition.stop).catch(() => null) === 0) await waitForServiceExit(input, definition, deps);
        await restoreOnceReleased(input, successor.releaseId, previous, deps);
        if (wasRunning) await deps.start(input);
        await finish("rolled_back", detail);
      } catch (rollbackError) {
        await finish("failed", `rollback failed after: ${detail}`);
        throw new RemoteInstanceError("temporarily_unavailable", "The updated connector did not pass its health gate and automatic rollback failed; identity, credentials and workspaces remain preserved.", { cause: rollbackError });
      }
    } else {
      if (stopped && wasRunning) await deps.start(input).catch(() => undefined);
      await finish("failed", detail);
    }
    throw error;
  }
}

async function waitForServiceExit(input: NativeUpdateInput, definition: NativeServiceDefinition, deps: NativeUpdateTransactionDeps): Promise<void> {
  const deadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  while (await deps.execute(definition.status) === 0) {
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime did not finish stopping in time; its installation was not changed.");
    input.output.line("waiting for the running connector to exit…");
    await deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  }
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
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const owned = error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" && /owns this native data directory/.test(error.message);
      if (!owned || deps.now() >= deadline) throw error;
      input.output.line("waiting for the previous connector to release the runtime directory…");
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

async function failingDoctorChecks(control: UpdateControlClient): Promise<Set<string>> {
  const report = await control.call({ op: "doctor" }, DoctorReportSchema);
  return new Set(report.checks.filter(check => check.status === "fail").map(check => check.id));
}

/**
 * The successor must answer on the control socket with its own version, probe
 * every installed agent, and introduce no doctor failure that was not already
 * present; a pre-existing failure (an agent awaiting login) is not the update's.
 */
async function healthGate(input: NativeUpdateInput, control: UpdateControlClient, successor: NativeRuntimeRecord, failingBefore: Set<string>, deps: NativeUpdateTransactionDeps): Promise<void> {
  const deadline = deps.now() + (deps.healthDeadlineMs ?? 180_000);
  const poll = deps.pollMs ?? 3_000;
  let answered = false;
  for (;;) {
    try {
      const status = await control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 });
      answered = true;
      // The old process has already exited before the commit, so a different
      // version answering here is the wrong executable, not a transition.
      if (status.version.bundle !== successor.bundleVersion) throw new RemoteInstanceError("update_required", `the service answering reports ${status.version.bundle}, not ${successor.bundleVersion}`);
      const probed = await control.call({ op: "agents" }, AgentsSchema, { timeoutMs: 5_000 });
      const settled = successor.agents.every(agentId => probed.agents.some(agent => agent.agentId === agentId && agent.readiness !== "unknown" && agent.readiness !== "probing"));
      if (settled) break;
    } catch (error) {
      if (answered && error instanceof RemoteInstanceError && error.code === "update_required") throw error;
    }
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", answered ? "The updated connector did not finish probing its agents in time." : "The updated connector did not answer on its control socket in time.");
    await deps.sleep(poll);
  }
  // Connectivity checks (relay, lease) settle seconds after start; a failure
  // counts against the update only if it is still there when the deadline passes.
  for (;;) {
    const failingAfter = await failingDoctorChecks(control);
    const introduced = [...failingAfter].filter(id => !failingBefore.has(id));
    if (introduced.length === 0) break;
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", `The updated connector introduced doctor failure(s): ${introduced.join(", ")}.`);
    input.output.line(`waiting for the updated connector to clear doctor failure(s): ${introduced.join(", ")}…`);
    await deps.sleep(poll);
  }
  for (const agent of (await control.call({ op: "agents" }, AgentsSchema)).agents) {
    if (agent.readiness === "reconnect_required") input.output.line(`agent ${agent.agentId} needs a fresh login after this update: run \`konteks-remote auth login ${agent.agentId}\`.`);
  }
}
