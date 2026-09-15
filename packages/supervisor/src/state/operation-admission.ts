import { RemoteExecutionAdmissionClaimsSchema, RemoteDeliveryAdmissionClaimsSchema, RemoteInstanceError, canonicalize,
  type Clock, type JsonValue, type RemoteExecutionAdmissionClaims, type RemoteDeliveryAdmissionClaims, type SessionToCoreMessage } from "@konteks/remote-common";
import type { SupervisorJournal, PendingRequest } from "./journal.js";

const conflict = () => new RemoteInstanceError("operation_conflict", "Operation conflicts with the durable request.");
type Admission = RemoteExecutionAdmissionClaims | RemoteDeliveryAdmissionClaims;
export function admittedOperationKey(claims: Admission): string {
  return `${claims.acpSessionRef}:${claims.kind === "acp" ? "received" : "issued"}:${claims.requestId ?? `operation:${claims.operationId}`}`;
}

/** Extends the existing pending-request journal. No second transport cursor or
 * operation log: every admission/disposition is fsynced with its request row. */
export class OperationAdmissionJournal {
  private readonly active = new Set<string>();
  private starts: Promise<unknown> = Promise.resolve();
  constructor(private readonly journal: SupervisorJournal, private readonly clock: Clock) {}

  /** Caller has independently verified signature, live Core consumption and the
   * exact local execution. The signer profile is parsed again before storage. */
  async admit(raw: Admission, receipt: string, assertCurrent: () => void): Promise<PendingRequest> {
    const claims = "workloadKind" in raw ? RemoteDeliveryAdmissionClaimsSchema.parse(raw) : RemoteExecutionAdmissionClaimsSchema.parse(raw);
    const key = admittedOperationKey(claims);
    await this.journal.pendingRequests.update(key, current => {
      assertCurrent();
      if (current?.authorization) {
        if (canonicalize(current.authorization.claims as unknown as JsonValue) !== canonicalize(claims as unknown as JsonValue) || current.authorization.receipt !== receipt) throw conflict();
        return current;
      }
      if (claims.kind === "acp") {
        // A legacy pending request cannot prove it has not already dispatched.
        if (current) throw new RemoteInstanceError("operation_interrupted", "Previous request has no durable admission evidence.");
      } else if (!current || current.closedAt !== null || current.method !== claims.method ||
        claims.sender.kind !== "core_permission_answer" || current.requestDigest !== claims.sender.requestDigest) throw conflict();
      return { ...(current ?? { acpSessionRef: claims.acpSessionRef, id: claims.requestId ?? `operation:${claims.operationId}`,
        method: claims.method, direction: "received" as const, openedAt: this.clock.nowIso(), closedAt: null,
        deadlineAt: null, requestDigest: claims.payloadDigest }), authorization: { claims, receipt, state: "admitted" } };
    });
    return this.journal.pendingRequests.get(key)!;
  }

  /** True exactly once per operation in this process. A recovered started row is
   * ambiguous, never an invitation to replay a possibly completed side effect. */
  begin(key: string, assertCurrent: () => void): Promise<boolean> {
    const result = this.starts.then(() => this.beginSerialized(key, assertCurrent));
    this.starts = result.then(() => undefined, () => undefined);
    return result;
  }

  private async beginSerialized(key: string, assertCurrent: () => void): Promise<boolean> {
    let begin = false;
    let interrupted = false;
    await this.journal.pendingRequests.update(key, current => {
      assertCurrent();
      if (!current?.authorization) throw conflict();
      const authorization = current.authorization;
      if (authorization.state === "completed" || authorization.state === "denied") return current;
      if (authorization.state === "dispatch_started" && this.active.has(key)) return current;
      if (authorization.state === "dispatch_started" || authorization.state === "interrupted") {
        interrupted = true;
        return { ...current, authorization: { ...authorization, state: "interrupted" } };
      }
      begin = true;
      return { ...current, authorization: { ...authorization, state: "dispatch_started" } };
    });
    if (interrupted) throw new RemoteInstanceError("operation_interrupted", "Prior dispatch outcome requires explicit recovery.");
    if (begin) this.active.add(key);
    return begin;
  }

  async complete(key: string, completion?: SessionToCoreMessage): Promise<void> {
    await this.journal.pendingRequests.update(key, current => {
      if (!current?.authorization) throw conflict();
      if (current.authorization.state === "completed") {
        if (completion && canonicalize(completion as unknown as JsonValue) !== canonicalize((current.authorization.completion ?? null) as JsonValue)) throw conflict();
        return current;
      }
      if (current.authorization.state !== "dispatch_started" || !this.active.has(key)) throw conflict();
      return { ...current, closedAt: this.clock.nowIso(), authorization: { ...current.authorization,
        state: "completed", ...(completion ? { completion } : {}) } };
    });
    this.active.delete(key);
  }

  async denyBeforeDispatch(key: string, completion?: SessionToCoreMessage): Promise<void> {
    await this.journal.pendingRequests.update(key, current => {
      if (!current?.authorization || !["admitted", "denied"].includes(current.authorization.state)) throw conflict();
      if (current.authorization.completion) {
        if (completion && canonicalize(completion as unknown as JsonValue) !== canonicalize(current.authorization.completion as unknown as JsonValue)) throw conflict();
        return current;
      }
      return { ...current, closedAt: current.closedAt ?? this.clock.nowIso(), authorization: { ...current.authorization,
        state: "denied", ...(completion ? { completion } : {}) } };
    });
  }
}
