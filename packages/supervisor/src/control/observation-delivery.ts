import { randomUUID } from "node:crypto";
import { createLogger, type Clock, type Logger } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { DurableOutbox } from "../state/outbox.js";

/**
 * Ordered, durable delivery for low-volume runtime observations.
 *
 * Relay frame acknowledgement only proves transport receipt; it cannot retire
 * the domain outbox. Core's HTTPS endpoint gives the correlated durable
 * stored/deduplicated result, so observations use that deliberately simple
 * lane and retain their exact body until it answers.
 */
export class ObservationDelivery {
  private flushing: Promise<void> | null = null;
  private readonly logger: Logger;

  constructor(private readonly options: {
    outbox: DurableOutbox;
    core: Pick<CoreClient, "observation">;
    instanceId: () => string;
    clock: Clock;
    canSend: () => boolean;
    logger?: Logger;
  }) { this.logger = options.logger ?? createLogger({ name: "observation-delivery" }); }

  async submit(key: string, body: unknown): Promise<void> {
    await this.options.outbox.enqueue({ id: randomUUID(), channel: "observation", key, group: "observation", order: this.options.clock.now(), body, createdAt: this.options.clock.nowIso() });
    void this.flush().catch(error => this.logger.warn({ err: error }, "observation retained for retry"));
  }

  flush(): Promise<void> {
    if (!this.options.canSend()) return Promise.resolve();
    this.flushing ??= this.flushInternal().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async settle(): Promise<void> { await this.flushing; }

  private async flushInternal(): Promise<void> {
    while (this.options.canSend()) {
      const item = this.options.outbox.heads("observation")[0];
      if (!item) return;
      await this.options.outbox.markAttempt(item.id, this.options.clock.nowIso());
      if (!this.options.canSend()) return;
      // `stored: false` is Core's durable duplicate receipt and is therefore
      // just as final for this immutable observation as a first insert.
      await this.options.core.observation(this.options.instanceId(), item.body);
      await this.options.outbox.ack(item.id);
    }
  }
}
