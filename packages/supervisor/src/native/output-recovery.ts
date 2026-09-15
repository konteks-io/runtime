import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RemoteInstanceError, type Logger } from "@konteks/remote-common";
import type { LocalAdmission } from "../state/local-admission.js";
import type { SupervisorJournal } from "../state/journal.js";
import type { StateMutation } from "../state/mutation-gate.js";
import { isAssignmentGone, type NativeOutputClient } from "./output-client.js";
import { NativeOutputStore, type NativeOutputRecord } from "./output-store.js";

const WORKSPACE = /^(?:assignment|worktree)-[a-f0-9]{64}$/;
const TURN_RECORD = /^\.delivery-output-[a-f0-9]{64}\.json$/;
const MAX_WORKSPACES_PER_ROOT = 4096;
const unavailable = () => new RemoteInstanceError("capability_unavailable", "Frozen native delivery output could not be recovered.");

export interface RetainedDeliveryOutputRecoveryOptions {
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
    if (!execution.acpSessionRef) return null;
    let found: { store: NativeOutputStore; record: NativeOutputRecord } | null = null;
    for (const root of options.roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => { throw unavailable(); });
      if (entries.length > MAX_WORKSPACES_PER_ROOT) throw unavailable();
      for (const entry of entries) {
        if (entry.isFile() && TURN_RECORD.test(entry.name)) {
          const store = NativeOutputStore.retained(join(root, entry.name));
          const record = await store.read();
          if (!record || !matches(record, admission, execution.acpSessionRef, options.journal)) continue;
          if (found) throw unavailable();
          found = { store, record };
          continue;
        }
        if (!entry.isDirectory() || !WORKSPACE.test(entry.name)) continue;
        const container = join(root, entry.name);
        const stat = await lstat(container).catch(() => { throw unavailable(); });
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700)) throw unavailable();
        const store = new NativeOutputStore(container);
        const record = await store.read();
        if (!record || !matches(record, admission, execution.acpSessionRef, options.journal)) continue;
        if (found) throw unavailable();
        found = { store, record };
      }
    }
    if (!found) return null;
    let receipt;
    if (found.record.state === "accepted") receipt = found.record.receipt;
    else {
      try { receipt = await options.client().acceptRetained(admission, found.record.candidate); }
      catch (error) {
        if (!isAssignmentGone(error)) throw error;
        // The assignment no longer exists on Core (its plan failed or was
        // superseded while this runtime was down), so nothing can ever accept
        // the frozen output. Retrying it on every startup kept the whole
        // runtime in startup recovery: no relay handshake, no new work. The
        // record stays on disk for forensics; recovery reports nothing found
        // and restart recovery classifies the attempt as interrupted.
        options.logger?.warn({ assignmentId: admission.assignmentId, attempt: admission.attempt, claimId: admission.claimId },
          "retained delivery output belongs to an assignment Core no longer knows; leaving it unrecovered");
        return null;
      }
    }
    await options.mutate(() => found!.store.saveAccepted(found!.record.candidate, receipt));
    return { acpSessionRef: execution.acpSessionRef, receipt };
  };
}

function matches(record: NativeOutputRecord, admission: LocalAdmission, acpSessionRef: string, journal: SupervisorJournal): boolean {
  const candidate = record.candidate;
  const completion = record.completion;
  const binding = candidate.binding;
  if (binding.instanceId !== admission.instanceId || binding.workspaceId !== admission.workspaceId ||
    binding.assignmentId !== admission.assignmentId || binding.attempt !== admission.attempt || candidate.claimId !== admission.claimId ||
    completion.kind !== "acp_result" || completion.method !== "session/prompt" ||
    (completion.result as { stopReason?: string }).stopReason !== "end_turn") return false;
  const pending = journal.pendingRequests.get(`${acpSessionRef}:received:${completion.id}`);
  const claims = pending?.authorization?.claims;
  if (!pending || pending.method !== "session/prompt" || pending.direction !== "received" || !claims || !("deliveryIdentity" in claims)) return false;
  return claims.acpSessionRef === acpSessionRef && claims.instanceId === admission.instanceId && claims.workspaceId === admission.workspaceId &&
    claims.assignmentId === admission.assignmentId && claims.attempt === admission.attempt && claims.claimId === admission.claimId &&
    claims.agentId === admission.agentId && claims.sessionId === binding.sessionId && claims.deliveryIdentity.invocationId === candidate.invocationRef &&
    ["dispatch_started", "completed"].includes(pending.authorization!.state);
}
