import { RemoteInstanceError, RuntimeCancellationDeliveryRequestSchema } from "@konteks/remote-common";
import type { CoreSignatureVerifier } from "./core-signature.js";
import type { CancellationInbox, CancellationInboxRecord } from "../state/cancellation-inbox.js";
import type { LocalExecutionJournal } from "../state/local-execution.js";
import type { CoreClient } from "../core/client.js";

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
      const now = this.deps.now();
      const leaseDeadline = Date.parse(scope.leaseExpiresAt);
      if (!Number.isFinite(now) || !Number.isFinite(leaseDeadline) ||
        request.intent.instanceId !== scope.instanceId || request.intent.tenantId !== scope.workspaceId ||
        request.connectionEpoch !== scope.connectionEpoch || Date.parse(request.issuedAt) > now + 300000 ||
        Date.parse(request.expiresAt) <= now || Date.parse(request.expiresAt) > leaseDeadline) throw unavailable();
      const { assignmentId, attempt } = request.intent.directive;
      const start = this.deps.claims.start(assignmentId, attempt);
      if (!start || start.admission.instanceId !== scope.instanceId || start.admission.workspaceId !== scope.workspaceId ||
        start.admission.runnerIncarnation !== scope.runnerIncarnation || start.admission.claimId !== request.intent.claimId ||
        start.assignment.kind !== "assistant_execution" || start.assignment.source.kind !== "conversation" ||
        start.assignment.source.sessionId !== request.intent.sessionId) throw unavailable();
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
