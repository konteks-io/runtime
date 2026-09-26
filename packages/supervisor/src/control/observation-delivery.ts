import { randomUUID } from "node:crypto";
import { AgentTurnUsageObservationSchema, createLogger, jcsDigest,
  RemoteInstanceError, type Clock, type Logger, type JsonValue } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { DurableOutbox } from "../state/outbox.js";

/** Durable source bodies survive both relay ACK loss and process restart.
 * HTTPS returns a content-bound receipt after Core commits; socket ACKs never
 * retire this journal. Old usage keys are reconciled by the same path. */
export class ObservationDelivery {
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: Logger;
  constructor(private readonly options: { outbox: DurableOutbox; core: Pick<CoreClient, "submitObservation">;
    instanceId: () => string; clock: Clock; canSend: () => boolean; logger?: Logger }) {
    this.logger = options.logger ?? createLogger({ name: "observations" });
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, 5_000);
    this.timer.unref();
    void this.flush();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushing;
  }
  async submit(body: unknown): Promise<void> {
    const observation = AgentTurnUsageObservationSchema.parse(body);
    if (observation.instanceId !== this.options.instanceId()) throw new Error("Observation instance mismatch");
    await this.options.outbox.enqueue({ id: randomUUID(), channel: "observation",
      key: `observation:${jcsDigest(observation as unknown as JsonValue)}`, group: "observation", order: this.options.clock.now(),
      body: observation, createdAt: this.options.clock.nowIso() });
    // Reporting usage must not hold the agent's terminal path behind network I/O.
    void this.flush();
  }
  flush(): Promise<void> {
    if (!this.options.canSend()) return Promise.resolve();
    this.flushing ??= this.flushInternal().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async flushInternal(): Promise<void> {
    const pending = this.options.outbox.all("observation").sort((a,b) =>
      (a.lastAttemptAt ?? "").localeCompare(b.lastAttemptAt ?? "") || a.order - b.order).slice(0, 8);
    for (const item of pending) {
      if (!this.options.canSend()) return;
      const body = item.body as { instanceId?: string; assignmentId?: string; attempt?: number };
      if (body.instanceId !== this.options.instanceId()) continue;
      const started = this.options.clock.now();
      try {
        await this.options.outbox.markAttempt(item.id, this.options.clock.nowIso());
        await this.options.core.submitObservation(body.instanceId, item.body);
        await this.options.outbox.ack(item.id);
        this.logger.info({ event: "observation.receipt_accepted", assignmentId: body.assignmentId, attempt: body.attempt,
          outboxId: item.id, ageMs: Math.max(0, started - Date.parse(item.createdAt)),
          elapsedMs: this.options.clock.now() - started, pending: this.options.outbox.all("observation").length }, "Usage receipt accepted");
      } catch (error) {
        this.logger.warn({ event: "observation.receipt_pending", assignmentId: body.assignmentId, attempt: body.attempt,
          outboxId: item.id, deliveryAttempt: item.attempts + 1,
          code: error instanceof RemoteInstanceError ? error.code : "local_or_transport_failure",
          elapsedMs: this.options.clock.now() - started }, "Usage retained for receipt reconciliation");
      }
    }
  }
}
