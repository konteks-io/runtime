import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { allEqual, RemoteInstanceError, type Logger } from "@konteks/remote-common";
import type { LocalAdmission } from "../state/local-admission.js";
import type { SupervisorJournal } from "../state/journal.js";
import type { StateMutation } from "../state/mutation-gate.js";
import { isAssignmentGone, type NativeOutputClient } from "./output-client.js";
import { NativeOutputStore, type NativeOutputRecord } from "./output-store.js";

const WORKSPACE = /^(?:assignment|worktree)-[a-f0-9]{64}$/;
const TURN_RECORD = /^\.delivery-output-[a-f0-9]{64}\.json$/;
const MAX_WORKSPACES_PER_ROOT = 4096;
const unavailable = () => new RemoteInstanceError("capability_unavailable", "Frozen native delivery output could not be recovered.");

interface RetainedDeliveryOutputRecoveryOptions {
  roots: readonly string[];
  journal: SupervisorJournal;
  client: () => NativeOutputClient;
  mutate: StateMutation;
  logger?: Logger;
}

/** Locates only connector-owned assignment/worktree containers and retries the
 * exact candidate frozen before the crash. The durable admission and prompt
 * authorization must independently name every candidate identity. */
export function createRetainedDeliveryOutputRecovery(options: RetainedDeliveryOutputRecoveryOptions) {
  return async (admission: LocalAdmission, execution: { acpSessionRef: string | null }) => {
    const startedAt = Date.now();
    if (!execution.acpSessionRef) return null;
    const found = await findRetainedOutput(options, admission, execution.acpSessionRef);
    if (!found) return null;
    const cacheOutcome = found.record.state === "accepted" ? "accepted_record" : "pending_record";
    const receipt = await acceptedReceipt(options, admission, found.record);
    if (receipt === null) return null;
    await options.mutate(() => found.store.saveAccepted(found.record.candidate, receipt));
    options.logger?.info({ event: "native.output.recovery_completed", correlationId: found.record.candidate.invocationRef, stage: "recovery",
      outcome: "accepted", cacheOutcome, resultDigest: found.record.candidate.resultDigest, durationMs: Date.now() - startedAt },
    "retained native delivery output recovery completed");
    return { acpSessionRef: execution.acpSessionRef, receipt };
  };
}

type Retained = { store: NativeOutputStore; record: NativeOutputRecord };

/** The one retained output the admission names; two would be ambiguous and refuse. */
async function findRetainedOutput(options: RetainedDeliveryOutputRecoveryOptions, admission: LocalAdmission, acpSessionRef: string): Promise<Retained | null> {
  let found: Retained | null = null;
  for (const root of options.roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => { throw unavailable(); });
    if (entries.length > MAX_WORKSPACES_PER_ROOT) throw unavailable();
    for (const entry of entries) {
      const store = await outputStoreFor(root, entry);
      const record = store ? await matchingRecord(store, admission, acpSessionRef, options.journal) : null;
      if (!store || !record) continue;
      if (found) throw unavailable();
      found = { store, record };
    }
  }
  return found;
}

/** A turn's own record file, or a private assignment/worktree container; null for anything else. */
async function outputStoreFor(root: string, entry: Dirent): Promise<NativeOutputStore | null> {
  if (entry.isFile() && TURN_RECORD.test(entry.name)) return NativeOutputStore.retained(join(root, entry.name));
  if (!entry.isDirectory() || !WORKSPACE.test(entry.name)) return null;
  const container = join(root, entry.name);
  const stat = await lstat(container).catch(() => { throw unavailable(); });
  if (!privateContainer(stat)) throw unavailable();
  return new NativeOutputStore(container);
}

function privateContainer(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === "win32" || (stat.mode & 0o7777) === 0o700);
}

async function matchingRecord(store: NativeOutputStore, admission: LocalAdmission, acpSessionRef: string, journal: SupervisorJournal): Promise<NativeOutputRecord | null> {
  const record = await store.read();
  return record && matches(record, admission, acpSessionRef, journal) ? record : null;
}

/**
 * The record's receipt, or Core's for a pending one. The assignment may no
 * longer exist on Core (its plan failed or was superseded while this runtime
 * was down), so nothing can ever accept the frozen output; retrying it on
 * every startup would keep the whole runtime in startup recovery. The record
 * stays on disk for forensics; recovery reports nothing found and restart
 * recovery classifies the attempt as interrupted.
 */
async function acceptedReceipt(options: RetainedDeliveryOutputRecoveryOptions, admission: LocalAdmission, record: NativeOutputRecord) {
  if (record.state === "accepted") return record.receipt;
  try {
    return await options.client().acceptRetained(admission, record.candidate);
  } catch (error) {
    if (!isAssignmentGone(error)) throw error;
    options.logger?.warn({ assignmentId: admission.assignmentId, attempt: admission.attempt, claimId: admission.claimId },
      "retained delivery output belongs to an assignment Core no longer knows; leaving it unrecovered");
    return null;
  }
}

function matches(record: NativeOutputRecord, admission: LocalAdmission, acpSessionRef: string, journal: SupervisorJournal): boolean {
  const { candidate, completion } = record;
  if (!candidateMatches(candidate, admission) || !endedPrompt(completion)) return false;
  const pending = journal.pendingRequests.get(`${acpSessionRef}:received:${completion.id}`);
  const claims = deliveryClaims(pending);
  return claims !== null && allEqual([
    [claims.acpSessionRef, acpSessionRef],
    [claims.instanceId, admission.instanceId],
    [claims.workspaceId, admission.workspaceId],
    [claims.assignmentId, admission.assignmentId],
    [claims.attempt, admission.attempt],
    [claims.claimId, admission.claimId],
    [claims.agentId, admission.agentId],
    [claims.sessionId, candidate.binding.sessionId],
    [claims.deliveryIdentity.invocationId, candidate.invocationRef],
  ]) && ["dispatch_started", "completed"].includes(pending!.authorization!.state);
}

function candidateMatches(candidate: NativeOutputRecord["candidate"], admission: LocalAdmission): boolean {
  const binding = candidate.binding;
  return allEqual([
    [binding.instanceId, admission.instanceId],
    [binding.workspaceId, admission.workspaceId],
    [binding.assignmentId, admission.assignmentId],
    [binding.attempt, admission.attempt],
    [candidate.claimId, admission.claimId],
  ]);
}

/** A received `session/prompt` that ended its turn. */
function endedPrompt(completion: NativeOutputRecord["completion"]): completion is Extract<NativeOutputRecord["completion"], { kind: "acp_result" }> {
  return completion.kind === "acp_result" && completion.method === "session/prompt" &&
    (completion.result as { stopReason?: string }).stopReason === "end_turn";
}

type PendingRequest = ReturnType<SupervisorJournal["pendingRequests"]["get"]>;

function receivedPrompt(pending: PendingRequest): boolean {
  return pending !== undefined && pending.method === "session/prompt" && pending.direction === "received";
}

/** The delivery claims the received prompt was authorized under; null when it carries none. */
function deliveryClaims(pending: PendingRequest) {
  const claims = pending?.authorization?.claims;
  if (!receivedPrompt(pending) || !claims || !("deliveryIdentity" in claims)) return null;
  return claims;
}
