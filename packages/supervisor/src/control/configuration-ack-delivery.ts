import { randomUUID } from "node:crypto";
import { DesiredConfigurationAckSchema, createLogger, jcsDigest, type Clock, type DesiredConfigurationAck, type Logger } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { DurableOutbox } from "../state/outbox.js";

/** HTTPS gives a correlated durable receipt, unlike a relay frame-level ack. */
export class ConfigurationAckDelivery {
  private flushing: Promise<void> | null = null;
  private readonly logger: Logger;

  constructor(private readonly options: {
    outbox: DurableOutbox;
    core: Pick<CoreClient, "controlAck">;
    instanceId: () => string;
    clock: Clock;
    canSend: () => boolean;
    logger?: Logger;
  }) { this.logger = options.logger ?? createLogger({ name: "configuration-ack" }); }

  async submit(value: DesiredConfigurationAck): Promise<void> {
    const ack = DesiredConfigurationAckSchema.parse(value);
    if (ack.instanceId !== this.options.instanceId()) throw new Error("Configuration acknowledgement instance mismatch");
    const identity = { instanceId: ack.instanceId, revision: ack.revision, digest: ack.digest, status: ack.status, ...(ack.reason === undefined ? {} : { reason: ack.reason }) };
    // Retries may have a fresh signed timestamp; the durable first body wins.
    const key = `configuration-ack:${jcsDigest(identity)}`;
    await this.options.outbox.enqueue({ id: randomUUID(), channel: "control", key, group: `configuration:${ack.instanceId}`, order: ack.revision, body: ack, createdAt: this.options.clock.nowIso() });
    await this.flush();
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
      // Include historical group="control" entries, without misrouting other
      // control variants. Each record is attempted once per bounded pass.
      const pending = this.options.outbox.all("control").filter(item => !attempted.has(item.id)).sort((a, b) => a.order - b.order);
      if (pending.length === 0) return;
      for (const item of pending) {
        if (!this.options.canSend()) return;
        attempted.add(item.id);
        const parsed = DesiredConfigurationAckSchema.safeParse(item.body);
        if (!parsed.success || parsed.data.instanceId !== this.options.instanceId()) continue;
        try {
          await this.options.outbox.markAttempt(item.id, this.options.clock.nowIso());
          if (!this.options.canSend()) return;
          const accepted = await this.options.core.controlAck(parsed.data.instanceId, parsed.data);
          if (accepted === true) await this.options.outbox.ack(item.id);
          else if (accepted !== false) await this.options.outbox.supersedeConfigurationAck(item.id, accepted);
        } catch {
          // Core may have committed before a response was lost. Keep the exact
          // signed record, including after a local acknowledgement-write failure.
          this.logger.warn({ revision: parsed.data.revision }, "configuration acknowledgement retained for retry");
        }
      }
    }
  }
}
