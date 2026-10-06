import { RemoteInstanceError, RuntimePermissionAnswerDeliveryRequestSchema, runtimePermissionAnswerMatches,
  verifyRemoteExecutionOperationSignature, type RemoteAuthorizedOperation, type RemoteExecutionOperationPermitClaims,
  type RuntimePermissionAnswerDeliveryRequest } from "@konteks/remote-common";
import { deliveryNotCurrent } from "./delivery-scope.js";
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
    const denied = () => new RemoteInstanceError("permission_denied", "Current Core permission answer authority is required");
    if (!parsed.success || !this.deps.coreProducer || !this.deps.verifier.verifyPermissionAnswerDelivery(parsed.data)) throw denied();
    const request = parsed.data, scope = this.deps.captureConnection();
    if (!scope) throw denied();
    const assertConnection = () => {
      scope.assertCurrent();
      const now = this.deps.now();
      // Core clock estimation may contain fractional milliseconds; time bounds still use the full estimate.
      if (!Number.isSafeInteger(Math.floor(now)) || deliveryNotCurrent(request, scope, now, 0)) throw denied();
    };
    assertConnection();
    const keys = await this.deps.core.executionSigningKeys();
    assertConnection();
    const claims = this.verifiedClaims(request, keys, scope, denied);
    const assertCurrent = () => { assertConnection(); if (claims.exp * 1000 <= this.deps.now()) throw denied(); };
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
