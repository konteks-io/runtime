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
  const staged = await deps.stage({ root: input.root, output: input.output, ...(input.deps ? { deps: input.deps } : {}) });
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
    }
    successor = await deps.commit({ root: input.root, releaseId: staged.releaseId, output: input.output });
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
        await deps.execute(definition.stop).catch(() => null);
        await deps.restore(input.root, successor.releaseId, previous);
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
      if (status.version.bundle !== successor.bundleVersion) throw new RemoteInstanceError("update_required", `the service answering reports ${status.version.bundle}, not ${successor.bundleVersion}`);
      answered = true;
      const probed = await control.call({ op: "agents" }, AgentsSchema, { timeoutMs: 5_000 });
      const settled = successor.agents.every(agentId => probed.agents.some(agent => agent.agentId === agentId && agent.readiness !== "unknown" && agent.readiness !== "probing"));
      if (settled) break;
    } catch (error) {
      if (answered && error instanceof RemoteInstanceError && error.code === "update_required") throw error;
    }
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", answered ? "The updated connector did not finish probing its agents in time." : "The updated connector did not answer on its control socket in time.");
    await deps.sleep(poll);
  }
  const failingAfter = await failingDoctorChecks(control);
  const introduced = [...failingAfter].filter(id => !failingBefore.has(id));
  if (introduced.length > 0) throw new RemoteInstanceError("temporarily_unavailable", `The updated connector introduced doctor failure(s): ${introduced.join(", ")}.`);
  for (const agent of (await control.call({ op: "agents" }, AgentsSchema)).agents) {
    if (agent.readiness === "reconnect_required") input.output.line(`agent ${agent.agentId} needs a fresh login after this update: run \`konteks-remote auth login ${agent.agentId}\`.`);
  }
}
