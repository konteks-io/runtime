import {
  DiagnosticCarrierCompanionDeliveryRequestSchema,
  RemoteInstanceError,
  type DiagnosticCarrierCompanionDeliveryRequest,
} from "@konteks/remote-common";
import type { CoreSignatureVerifier } from "./core-signature.js";
import {
  diagnosticCompanionDigest,
  type DiagnosticCompanionInbox,
  type DiagnosticCompanionInboxRecord,
} from "../state/diagnostic-companion-inbox.js";

export interface CapturedDiagnosticCompanionConnection {
  instanceId: string;
  workspaceId: string;
  runnerIncarnation: string;
  nodeId: string;
  connectionRef: string;
  connectionEpoch: number;
  assertCurrent(): void;
}

/**
 * Receives the C01 sidecar independently from assignment and control traffic.
 * Failure is deliberately diagnosable but cannot alter business delivery.
 */
export class DiagnosticCompanionReceiver {
  constructor(
    private readonly deps: {
      verifier: Pick<
        CoreSignatureVerifier,
        "verifyDiagnosticCarrierCompanionDelivery"
      >;
      inbox: Pick<DiagnosticCompanionInbox, "receiveVerified">;
      captureConnection: () => CapturedDiagnosticCompanionConnection | null;
      /** Best-effort observability after durable retention; never business control. */
      onAccepted?: (record: DiagnosticCompanionInboxRecord) => void | Promise<void>;
      now: () => number;
    },
  ) {}

  async receive(candidate: unknown): Promise<DiagnosticCompanionInboxRecord> {
    const parsed = DiagnosticCarrierCompanionDeliveryRequestSchema.safeParse(candidate);
    if (
      !parsed.success ||
      !this.deps.verifier.verifyDiagnosticCarrierCompanionDelivery(parsed.data)
    ) {
      throw new RemoteInstanceError(
        "permission_denied",
        "Core diagnostic companion signatures are required",
      );
    }
    const request = parsed.data;
    const scope = this.deps.captureConnection();
    if (!scope) throw this.unavailable();
    const assertCurrent = () => {
      scope.assertCurrent();
      this.assertExactCurrent(request, scope);
    };
    assertCurrent();
    const record = await this.deps.inbox.receiveVerified(
      {
        companion: request.companion,
        deliveryDigest: diagnosticCompanionDigest(request.companion),
        runnerIncarnation: scope.runnerIncarnation,
        nodeId: scope.nodeId,
        connectionRef: scope.connectionRef,
        connectionEpoch: scope.connectionEpoch,
      },
      new Date(this.deps.now()).toISOString(),
      assertCurrent,
    );
    assertCurrent();
    // Export or logging trouble must not make a signed diagnostic sidecar an
    // execution dependency. The retained record remains queryable either way.
    try {
      await this.deps.onAccepted?.(record);
    } catch {
      // C01 observation failure is explicitly non-fatal to work transport.
    }
    assertCurrent();
    return record;
  }

  private assertExactCurrent(
    request: DiagnosticCarrierCompanionDeliveryRequest,
    scope: CapturedDiagnosticCompanionConnection,
  ): void {
    const now = this.deps.now();
    const issuedAt = Date.parse(request.issuedAt);
    const expiresAt = Date.parse(request.expiresAt);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now + 300_000 ||
      expiresAt <= now ||
      request.path.instanceId !== scope.instanceId ||
      request.nodeId !== scope.nodeId ||
      request.connectionRef !== scope.connectionRef ||
      request.connectionEpoch !== scope.connectionEpoch ||
      request.companion.carrier.context.tenantId !== scope.workspaceId
    ) {
      throw this.unavailable();
    }
  }

  private unavailable(): RemoteInstanceError {
    return new RemoteInstanceError(
      "recovery_required",
      "Diagnostic companion delivery ownership is not current",
    );
  }
}
