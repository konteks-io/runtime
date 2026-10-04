import { RemoteExecutionAdmissionClaimsSchema, RemoteDeliveryAdmissionClaimsSchema, RemoteInstanceError, canonicalize,
  type Clock, type JsonValue, type RemoteExecutionAdmissionClaims, type RemoteDeliveryAdmissionClaims, type SessionToCoreMessage } from "@konteks/remote-common";
import type { SupervisorJournal, PendingRequest } from "./journal.js";

const conflict = () => new RemoteInstanceError("operation_conflict", "Operation conflicts with the durable request.");
type Admission = RemoteExecutionAdmissionClaims | RemoteDeliveryAdmissionClaims;
export function admittedOperationKey(claims: Admission): string {
  return `${claims.acpSessionRef}:${claims.kind === "acp" ? "received" : "issued"}:${claims.requestId ?? `operation:${claims.operationId}`}`;
}

type Authorization = NonNullable<PendingRequest["authorization"]>;

function canonical(value: unknown): string {
  return canonicalize(value as JsonValue);
}

function assertSameAdmission(authorization: Authorization, claims: Admission, receipt: string): void {
  if (canonical(authorization.claims) !== canonical(claims) || authorization.receipt !== receipt) throw conflict();
}

/** A repeated completion must be the one already stored. */
function assertSameCompletion(stored: unknown, completion: SessionToCoreMessage | undefined): void {
  if (completion && canonical(completion) !== canonical(stored)) throw conflict();
}

/** A delivery's answer to a permission request this journal holds open, as Core signed it. */
function answersOpenRequest(current: PendingRequest | undefined, claims: Admission): boolean {
  return current !== undefined && current.closedAt === null && current.method === claims.method &&
    claims.sender.kind === "core_permission_answer" && current.requestDigest === claims.sender.requestDigest;
}

function assertAdmissible(current: PendingRequest | undefined, claims: Admission): void {
  if (claims.kind === "acp") {
    // A legacy pending request cannot prove it has not already dispatched.
    if (current) throw new RemoteInstanceError("operation_interrupted", "Previous request has no durable admission evidence.");
    return;
  }
  if (!answersOpenRequest(current, claims)) throw conflict();
}

function receivedRequest(claims: Admission, openedAt: string): PendingRequest {
  return { acpSessionRef: claims.acpSessionRef, id: claims.requestId ?? `operation:${claims.operationId}`,
    method: claims.method, direction: "received" as const, openedAt, closedAt: null,
    deadlineAt: null, requestDigest: claims.payloadDigest };
}

/** What a begin does to an admitted operation in its current state. */
type BeginStep = "keep" | "interrupt" | "begin";

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
        assertSameAdmission(current.authorization, claims, receipt);
        return current;
      }
      assertAdmissible(current, claims);
      return { ...(current ?? receivedRequest(claims, this.clock.nowIso())), authorization: { claims, receipt, state: "admitted" } };
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
      const step = this.beginStep(key, current.authorization.state);
      if (step === "keep") return current;
      if (step === "interrupt") {
        interrupted = true;
        return { ...current, authorization: { ...current.authorization, state: "interrupted" } };
      }
      begin = true;
      return { ...current, authorization: { ...current.authorization, state: "dispatch_started" } };
    });
    if (interrupted) throw new RemoteInstanceError("operation_interrupted", "Prior dispatch outcome requires explicit recovery.");
    if (begin) this.active.add(key);
    return begin;
  }

  /** A started dispatch this process began is settled once; a recovered one stays ambiguous. */
  private beginStep(key: string, state: Authorization["state"]): BeginStep {
    if (state === "completed" || state === "denied") return "keep";
    if (state === "dispatch_started" && this.active.has(key)) return "keep";
    if (state === "dispatch_started" || state === "interrupted") return "interrupt";
    return "begin";
  }

  private assertDispatching(key: string, authorization: Authorization): void {
    if (authorization.state !== "dispatch_started" || !this.active.has(key)) throw conflict();
  }

  async complete(key: string, completion?: SessionToCoreMessage): Promise<void> {
    await this.journal.pendingRequests.update(key, current => {
      if (!current?.authorization) throw conflict();
      if (current.authorization.state === "completed") {
        assertSameCompletion(current.authorization.completion ?? null, completion);
        return current;
      }
      this.assertDispatching(key, current.authorization);
      return { ...current, closedAt: this.clock.nowIso(), authorization: { ...current.authorization,
        state: "completed", ...(completion ? { completion } : {}) } };
    });
    this.active.delete(key);
  }

  /** Whether this process began the operation and has not settled it yet. */
  isDispatching(key: string): boolean {
    return this.active.has(key);
  }

  /**
   * The runner proved it refused the request before it reached the agent (for
   * example, another prompt already runs on the session). The operation began
   * in this process, so its refusal is a known non-dispatch, not an ambiguity.
   */
  async refuseAtDispatch(key: string, completion: SessionToCoreMessage): Promise<void> {
    await this.journal.pendingRequests.update(key, current => {
      if (!current?.authorization) throw conflict();
      if (current.authorization.state === "denied") return current;
      this.assertDispatching(key, current.authorization);
      return { ...current, closedAt: current.closedAt ?? this.clock.nowIso(), authorization: { ...current.authorization,
        state: "denied", completion } };
    });
    this.active.delete(key);
  }

  async denyBeforeDispatch(key: string, completion?: SessionToCoreMessage): Promise<void> {
    await this.journal.pendingRequests.update(key, current => {
      if (!current?.authorization || !["admitted", "denied"].includes(current.authorization.state)) throw conflict();
      if (current.authorization.completion) {
        assertSameCompletion(current.authorization.completion, completion);
        return current;
      }
      return { ...current, closedAt: current.closedAt ?? this.clock.nowIso(), authorization: { ...current.authorization,
        state: "denied", ...(completion ? { completion } : {}) } };
    });
  }
}
