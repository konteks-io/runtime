import { randomUUID } from "node:crypto";
import {
  NativeExecutionRevisionFenceReceiptRequestSchema,
  NativeExecutionRevisionFenceReceiptSchema,
  createLogger,
  type Clock,
  type Logger,
  type NativeExecutionRevisionFenceReceipt,
} from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { DurableOutbox } from "../state/outbox.js";

/**
 * Retains exact proof-bearing C02 receipt bytes before delivery. This is only
 * proof of a local authority fence; it never reports provider stop, quiescence,
 * or a terminal controller state.
 */
export class ExecutionRevisionFenceReceiptDelivery {
  private flushing: Promise<void> | null = null;
  private readonly logger: Logger;

  constructor(private readonly options: {
    outbox: DurableOutbox;
    core: Pick<CoreClient, "createExecutionRevisionFenceReceiptRequest" | "submitExecutionRevisionFenceReceipt">;
    clock: Clock;
    canSend: () => boolean;
    logger?: Logger;
  }) {
    this.logger = options.logger ?? createLogger({ name: "execution-revision-fence-receipt" });
  }

  async submit(receipt: NativeExecutionRevisionFenceReceipt): Promise<void> {
    const parsed = NativeExecutionRevisionFenceReceiptSchema.parse(receipt);
    const key = `execution-revision-fence-receipt:${parsed.intentDigest}:${parsed.runnerIncarnation}:${parsed.connectionRef}:${parsed.connectionEpoch}`;
    if (!this.options.outbox.has(key)) {
      const request = this.options.core.createExecutionRevisionFenceReceiptRequest(parsed);
      await this.options.outbox.enqueue({
        id: randomUUID(), channel: "control", key,
        group: `execution-revision-fence-receipt:${parsed.intent.instanceId}:${parsed.intent.executionId}`,
        order: parsed.intent.executionRevision,
        body: request,
        createdAt: this.options.clock.nowIso(),
      });
    }
    void this.flush();
  }

  flush(): Promise<void> {
    if (!this.options.canSend()) return Promise.resolve();
    this.flushing ??= this.flushInternal().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async settle(): Promise<void> { await this.flushing; }

  private async flushInternal(): Promise<void> {
    const attempted = new Set<string>();
    while (this.options.canSend()) {
      const pending = this.options.outbox.all("control")
        .filter(item => !attempted.has(item.id))
        .map(item => ({ item, request: NativeExecutionRevisionFenceReceiptRequestSchema.safeParse(item.body) }))
        .filter((candidate): candidate is { item: ReturnType<DurableOutbox["all"]>[number]; request: { success: true; data: ReturnType<typeof NativeExecutionRevisionFenceReceiptRequestSchema.parse> } } => candidate.request.success);
      if (pending.length === 0) return;
      for (const { item, request } of pending) {
        if (!this.options.canSend()) return;
        attempted.add(item.id);
        try {
          await this.options.outbox.markAttempt(item.id, this.options.clock.nowIso());
          if (!this.options.canSend()) return;
          await this.options.core.submitExecutionRevisionFenceReceipt(request.data);
          await this.options.outbox.ack(item.id);
        } catch {
          this.logger.warn({ intentId: request.data.intent.intentId, intentDigest: request.data.intentDigest }, "execution revision fence receipt retained for retry");
        }
      }
    }
  }
}
