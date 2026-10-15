import { RemoteInstanceError, RuntimePermissionAnswerDeliveryRequestSchema, runtimePermissionAnswerMatches,
  verifyRemoteExecutionOperationSignature, type RemoteAuthorizedOperation, type RemoteExecutionOperationPermitClaims,
  type RuntimePermissionAnswerDeliveryRequest } from "@konteks/remote-common";
import { CORE_DELIVERY_CLOCK_SKEW_MS, deliveryStaleReason } from "./delivery-scope.js";
import type { CoreSignatureVerifier } from "./core-signature.js";
import type { CapturedCancellationConnection } from "./cancellation-receiver.js";
import type { CoreClient } from "../core/client.js";

/** Verifies the envelope independently of Relay. The accepting session owner
 * must run the supplied guard around its asynchronous admission and before ACP.
 * Durable deduplication/disposition belongs to its existing execution gate. */
export class PermissionAnswerReceiver {
  constructor(private readonly deps: {
    verifier: Pick<CoreSignatureVerifier, "verifyPermissionAnswerDelivery">;
    core: Pick<CoreClient, "executionSigningKeys">;
    coreProducer: string;
    captureConnection: () => CapturedCancellationConnection | null;
    now: () => number;
    deliver: (operation: RemoteAuthorizedOperation, claims: RemoteExecutionOperationPermitClaims, assertCurrent: () => void) => Promise<void>;
  }) {}

  async receive(raw: unknown): Promise<void> {
    const parsed = RuntimePermissionAnswerDeliveryRequestSchema.safeParse(raw);
    // Which check refused is said, so a refusal can be told apart from the log alone (10-15).
    const denied = (reason: string) => new RemoteInstanceError("permission_denied", `Current Core permission answer authority is required (${reason})`);
    if (!parsed.success) throw denied("request");
    if (!this.deps.coreProducer) throw denied("producer");
    if (!this.deps.verifier.verifyPermissionAnswerDelivery(parsed.data)) throw denied("signature");
    const request = parsed.data, scope = this.deps.captureConnection();
    if (!scope) throw denied("connection");
    const assertConnection = () => {
      scope.assertCurrent();
      const now = this.deps.now();
      // Core's clock as this computer estimates it carries a fractional skew; any finite reading is a time (10-15: an
      // integer-only check refused every answer as "connection_window").
      const stale = deliveryStaleReason(request, scope, now, CORE_DELIVERY_CLOCK_SKEW_MS);
      if (stale) throw denied(`connection_window: ${stale}`);
    };
    assertConnection();
    const keys = await this.deps.core.executionSigningKeys();
    assertConnection();
    const claims = this.verifiedClaims(request, keys, scope, () => denied("permit"));
    const assertCurrent = () => { assertConnection(); if (claims.exp * 1000 <= this.deps.now()) throw denied("permit_expired"); };
    assertCurrent();
    await this.deps.deliver(request.intent.operation, claims, assertCurrent);
    assertCurrent();
  }

  /** The operation permit's claims, when they authorize exactly this answer on this connection's runner. */
  private verifiedClaims(
    request: RuntimePermissionAnswerDeliveryRequest,
    keys: Awaited<ReturnType<CoreClient["executionSigningKeys"]>>,
    scope: CapturedCancellationConnection,
    denied: () => RemoteInstanceError,
  ): RemoteExecutionOperationPermitClaims {
    try {
      const claims = verifyRemoteExecutionOperationSignature({ operation: request.intent.operation, trustedKeys: keys, nowSeconds: Math.floor(this.deps.now() / 1000) });
      if (!runtimePermissionAnswerMatches(claims, request.intent, this.deps.coreProducer) ||
        claims.runnerIncarnation !== scope.runnerIncarnation || Date.parse(request.expiresAt) > claims.exp * 1000) throw denied();
      return claims;
    } catch { throw denied(); }
  }
}
