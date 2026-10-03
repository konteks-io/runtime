import { allEqual, RemoteInstanceError, RuntimeCancellationDeliveryRequestSchema } from "@konteks/remote-common";
import { deliveryNotCurrent } from "./delivery-scope.js";
import type { CoreSignatureVerifier } from "./core-signature.js";
import type { CancellationInbox, CancellationInboxRecord } from "../state/cancellation-inbox.js";
import type { LocalExecutionJournal } from "../state/local-execution.js";
import type { CoreClient } from "../core/client.js";

type StartedAssignment = NonNullable<ReturnType<LocalExecutionJournal["start"]>>["assignment"];

/** The work a Core cancellation may name: an Assistant conversation turn, a
 * person's direct session prompt, or a native delivery turn of a
 * repository-role Session whose cleanup Core owns. The session must be the
 * assignment's own. */
export function cancellationNamesAssignment(assignment: StartedAssignment, sessionId: string): boolean {
  const source = assignment.source;
  if (source.kind === "harness_delivery") return source.executionSessionId === sessionId;
  if (assignment.kind === "direct" && source.kind === "direct_session") return source.sessionId === sessionId;
  return assignment.kind === "assistant_execution" && source.kind === "conversation" && source.sessionId === sessionId;
}

/**
 * A turn that stops through the ordinary signed cancel (its session closes and
 * reports a cancelled terminal, which is Core's stop proof): a
 * delivery turn and a direct session's turn. A direct turn that was
 * only stopped for recovery never reported, and Core's cancel left it
 * unsettled here, so every later prompt in that session was refused as
 * waiting on its predecessor.
 */
export function isDeliveryCancellation(assignment: StartedAssignment): boolean {
  return assignment.source.kind === "harness_delivery" || assignment.source.kind === "direct_session";
}

/** Whether the started assignment is the one the cancellation names, claimed by this connection's runner. */
function claimedOnConnection(
  start: NonNullable<ReturnType<LocalExecutionJournal["start"]>>,
  intent: { claimId: string; sessionId: string },
  scope: CapturedCancellationConnection,
): boolean {
  return allEqual([
    [start.admission.instanceId, scope.instanceId],
    [start.admission.workspaceId, scope.workspaceId],
    [start.admission.runnerIncarnation, scope.runnerIncarnation],
    [start.admission.claimId, intent.claimId],
  ]) && cancellationNamesAssignment(start.assignment, intent.sessionId);
}

export interface CapturedCancellationConnection {
  instanceId: string;
  workspaceId: string;
  runnerIncarnation: string;
  /** Core allocates the epoch for this instance; never use a local attempt counter. */
  connectionEpoch: number;
  leaseExpiresAt: string;
  /** Revalidates exclusive root, same live socket generation and lease identity. */
  assertCurrent(): void;
}

/** Authenticated admission and optional native HTTPS receipt submission. The
 * caller supplies the live connection's captured owner guard. Neither local
 * persistence nor the receipt is an ACP call or proof of quiescence.
 */
export class CancellationReceiver {
  constructor(private readonly deps: {
    verifier: Pick<CoreSignatureVerifier, "verifyCancellationDelivery">;
    inbox: Pick<CancellationInbox, "receiveVerified">;
    claims: Pick<LocalExecutionJournal, "start">;
    captureConnection: () => CapturedCancellationConnection | null;
    now: () => number;
    core?: Pick<CoreClient, "acknowledgeCancellation">;
    onPersisted?: (record: CancellationInboxRecord) => void;
  }) {}

  async receive(candidate: unknown): Promise<CancellationInboxRecord> {
    const parsed = RuntimeCancellationDeliveryRequestSchema.safeParse(candidate);
    if (!parsed.success || !this.deps.verifier.verifyCancellationDelivery(parsed.data)) {
      throw new RemoteInstanceError("permission_denied", "Core cancellation delivery signatures are required");
    }
    const request = parsed.data;
    const scope = this.deps.captureConnection();
    const unavailable = () => new RemoteInstanceError("recovery_required", "Cancellation delivery ownership is not current");
    if (!scope) throw unavailable();
    const assertCurrent = () => {
      scope.assertCurrent();
      if (deliveryNotCurrent(request, scope, this.deps.now(), 300_000)) throw unavailable();
      const { assignmentId, attempt } = request.intent.directive;
      const start = this.deps.claims.start(assignmentId, attempt);
      if (!start || !claimedOnConnection(start, request.intent, scope)) throw unavailable();
    };
    // The inbox repeats this guard under its write lane and after fsync. The
    // exact parsed intent cannot be changed by caller mutation during awaits.
    assertCurrent();
    const record = await this.deps.inbox.receiveVerified(request.intent, new Date(this.deps.now()).toISOString(), assertCurrent);
    assertCurrent();
    this.deps.onPersisted?.(record);
    assertCurrent();
    if (this.deps.core) {
      await this.deps.core.acknowledgeCancellation({ kind: "durable_received",
        tenantId: record.intent.tenantId, instanceId: scope.instanceId,
        runnerIncarnation: scope.runnerIncarnation, connectionEpoch: scope.connectionEpoch,
        intentId: record.intent.intentId, intentDigest: record.intentDigest, receivedAt: record.receivedAt,
      });
      // A response cannot transfer this attempt's ownership to a replacement.
      // The record remains in the inbox even when receipt delivery fails.
      assertCurrent();
    }
    return record;
  }
}
