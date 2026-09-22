import {
  RemoteExecutionRevisionControlDeliveryRequestSchema,
  RemoteInstanceError,
  type RemoteExecutionRevisionControlDeliveryRequest,
} from "@konteks/remote-common";
import type { CoreSignatureVerifier } from "./core-signature.js";
import type {
  ExecutionRevisionFenceInbox,
  ExecutionRevisionFenceInboxRecord,
} from "../state/execution-revision-fence-inbox.js";

/** The current relay socket ownership captured at control delivery time. */
export interface CapturedExecutionRevisionControlConnection {
  instanceId: string;
  workspaceId: string;
  runnerIncarnation: string;
  nodeId: string;
  connectionRef: string;
  connectionEpoch: number;
  assertCurrent(): void;
}

/**
 * Authenticated C02 intake. It makes a durable pre-fence record only; the
 * exact execution gate and C03 terminal convergence remain separate owners.
 */
export class ExecutionRevisionControlReceiver {
  private readonly coreToMonotonicOffset: number;

  constructor(
    private readonly deps: {
      verifier: Pick<
        CoreSignatureVerifier,
        "verifyExecutionRevisionControlDelivery"
      >;
      inbox: Pick<ExecutionRevisionFenceInbox, "receiveVerified">;
      captureConnection: () => CapturedExecutionRevisionControlConnection | null;
      now: () => number;
      monotonicNow: () => number;
    },
  ) {
    // Capture the mapping once. Later wall-clock jumps may cause early refusal,
    // but they can never move an immutable Core deadline later.
    this.coreToMonotonicOffset =
      this.deps.monotonicNow() - this.deps.now();
  }

  async receive(candidate: unknown): Promise<ExecutionRevisionFenceInboxRecord> {
    const parsed =
      RemoteExecutionRevisionControlDeliveryRequestSchema.safeParse(candidate);
    if (
      !parsed.success ||
      !this.deps.verifier.verifyExecutionRevisionControlDelivery(parsed.data)
    ) {
      throw new RemoteInstanceError(
        "permission_denied",
        "Core execution revision-control signatures are required",
      );
    }
    const request = parsed.data;
    const scope = this.deps.captureConnection();
    if (!scope) throw this.unavailable();

    const deadline = this.monotonicDeadline(request);
    const assertCurrent = () => {
      scope.assertCurrent();
      this.assertExactCurrent(request, scope);
      if (this.deps.monotonicNow() >= deadline) throw this.unavailable();
    };

    assertCurrent();
    const record = await this.deps.inbox.receiveVerified(
      {
        intent: request.intent,
        intentDigest: request.intentDigest,
        runnerIncarnation: scope.runnerIncarnation,
        connectionRef: scope.connectionRef,
        connectionEpoch: scope.connectionEpoch,
      },
      new Date(this.deps.now()).toISOString(),
      assertCurrent,
    );
    assertCurrent();
    return record;
  }

  private monotonicDeadline(
    request: RemoteExecutionRevisionControlDeliveryRequest,
  ): number {
    const deadline =
      Date.parse(request.intent.deadlineAt) + this.coreToMonotonicOffset;
    if (!Number.isFinite(deadline) || this.deps.monotonicNow() >= deadline) {
      throw this.unavailable();
    }
    return deadline;
  }

  private assertExactCurrent(
    request: RemoteExecutionRevisionControlDeliveryRequest,
    scope: CapturedExecutionRevisionControlConnection,
  ): void {
    if (
      request.path.instanceId !== scope.instanceId ||
      request.intent.instanceId !== scope.instanceId ||
      request.intent.tenantId !== scope.workspaceId ||
      request.nodeId !== scope.nodeId ||
      request.connectionRef !== scope.connectionRef ||
      request.connectionEpoch !== scope.connectionEpoch ||
      request.intent.connectionRef !== scope.connectionRef ||
      request.intent.connectionEpoch !== scope.connectionEpoch
    ) {
      throw this.unavailable();
    }
  }

  private unavailable(): RemoteInstanceError {
    return new RemoteInstanceError(
      "recovery_required",
      "Execution revision-control delivery ownership is not current",
    );
  }
}
