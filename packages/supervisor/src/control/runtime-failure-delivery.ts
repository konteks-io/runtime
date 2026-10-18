import {
  RuntimeFailureObservationSchema,
  RuntimeFailureReceiptSchema,
  REMOTE_RUNTIME_FAILURE_MIN_CORE_CONTRACT_VERSION,
  coreContractAtLeast,
  createLogger,
  jcsDigest,
  type Clock,
  type JsonValue,
  type Logger,
  type RuntimeFailureObservation,
} from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { StateMutation } from "../state/mutation-gate.js";
import type { OutboxItem } from "../state/outbox.js";
import { RuntimeFailureQueue } from "./runtime-failure-queue.js";

type FailureDeliveryOptions = {
  dataDir: string;
  core: Pick<CoreClient, "submitRuntimeFailure">;
  instanceId: () => string;
  clock: Clock;
  coreContractVersion: () => string | null | undefined;
  canSend: () => boolean;
  mutate?: StateMutation;
  logger?: Logger;
};

/** Technical history has its own capacity, journal and receipt; it grants no work authority. */
export class RuntimeFailureDelivery {
  private readonly queue: RuntimeFailureQueue;
  private readonly logger: Logger;
  private readonly warned = new Set<string>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly options: FailureDeliveryOptions) {
    this.logger = options.logger ?? createLogger({ name: "runtime-failures" });
    this.queue = new RuntimeFailureQueue({
      ...options,
      degraded: (unknownCount) =>
        this.warning(unknownCount ? "storage_unavailable" : "queue_at_capacity", unknownCount),
    });
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.flush();
    }, 5_000);
    this.timer.unref();
    void this.flush();
  }

  /** A diagnostic HTTP request never becomes a condition for stopping a work session. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async submit(body: unknown): Promise<boolean> {
    try {
      const parsed = RuntimeFailureObservationSchema.safeParse(body);
      if (!parsed.success || parsed.data.instanceId !== this.options.instanceId()) {
        this.warning("invalid_observation");
        return false;
      }
      return await this.queue.submit(parsed.data);
    } catch {
      this.warning("storage_unavailable", true);
      return false;
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.enabled()) return Promise.resolve();
    this.flushing = this.flushInternal().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private enabled(): boolean {
    try {
      return (
        !this.stopped &&
        this.options.canSend() &&
        coreContractAtLeast(
          this.options.coreContractVersion() ?? undefined,
          REMOTE_RUNTIME_FAILURE_MIN_CORE_CONTRACT_VERSION,
        )
      );
    } catch {
      this.warning("availability_unavailable");
      return false;
    }
  }

  private async flushInternal(): Promise<void> {
    try {
      for (const item of await this.queue.pending()) {
        if (!this.enabled()) return;
        await this.deliver(item);
      }
    } catch {
      this.warning("storage_unavailable", true);
    }
  }

  private async deliver(item: OutboxItem): Promise<void> {
    const parsed = RuntimeFailureObservationSchema.safeParse(item.body);
    if (!parsed.success || parsed.data.instanceId !== this.options.instanceId()) return;
    const observation = parsed.data;
    try {
      await this.queue.markAttempt(item);
      if (!this.enabled()) return;
      const receipt = await this.options.core.submitRuntimeFailure(
        observation.instanceId,
        observation,
      );
      if (!boundReceipt(receipt, observation)) {
        this.warning("receipt_mismatch");
        return;
      }
      await this.queue.ack(item);
      this.warned.delete("delivery_pending");
    } catch {
      this.warning("delivery_pending");
    }
  }

  private warning(code: string, unknownCount = false): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    try {
      this.logger.warn(
        { event: `runtime_failure.${code}`, ...(unknownCount ? { omittedCount: "unknown" } : {}) },
        "Runtime diagnostic delivery is degraded; no work outcome was changed.",
      );
    } catch {
      /* Diagnostics cannot recursively fail through their own logger. */
    }
  }
}

function boundReceipt(value: unknown, observation: RuntimeFailureObservation): boolean {
  const parsed = RuntimeFailureReceiptSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.instanceId === observation.instanceId &&
    parsed.data.failureId === observation.failureId &&
    parsed.data.failureDigest === jcsDigest(observation as unknown as JsonValue)
  );
}
