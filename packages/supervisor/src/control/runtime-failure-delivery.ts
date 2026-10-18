import {
  RuntimeFailureObservationSchema,
  RuntimeFailureReceiptSchema,
  REMOTE_RUNTIME_FAILURE_MIN_CORE_CONTRACT_VERSION,
  coreContractAtLeast,
  createLogger,
  jcsDigest,
  listRuntimeFailureCaptures,
  readRuntimeFailureCapture,
  retireRuntimeFailureCapture,
  type Clock,
  type JsonValue,
  type Logger,
  type RuntimeFailureObservation,
} from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import { unrestrictedStateMutation, type StateMutation } from "../state/mutation-gate.js";
import type { OutboxItem } from "../state/outbox.js";
import { RuntimeFailureQueue } from "./runtime-failure-queue.js";

type FailureDeliveryOptions = {
  dataDir: string;
  core: Pick<CoreClient, "submitRuntimeFailure">;
  instanceId: () => string;
  clock: Clock;
  coreContractVersion: () => string | null | undefined;
  canSend: () => boolean;
  captureOwner?: { workspaceId: () => string; assertOwned: () => void };
  mutate?: StateMutation;
  logger?: Logger;
};
type CaptureOwner = { workspaceId: string; instanceId: string };

/** Technical history has its own capacity, journal and receipt; it grants no work authority. */
export class RuntimeFailureDelivery {
  private readonly queue: RuntimeFailureQueue;
  private readonly logger: Logger;
  private readonly mutate: StateMutation;
  private readonly warned = new Set<string>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private generation = 0;

  constructor(private readonly options: FailureDeliveryOptions) {
    this.logger = options.logger ?? createLogger({ name: "runtime-failures" });
    this.mutate = options.mutate ?? unrestrictedStateMutation;
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
    this.generation += 1;
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
    if (this.stopped) return Promise.resolve();
    this.flushing = this.flushInternal(this.generation).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private enabled(generation: number): boolean {
    try {
      return (
        !this.stopped &&
        generation === this.generation &&
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

  private async flushInternal(generation: number): Promise<void> {
    try {
      await this.importCaptures(generation);
      if (!this.enabled(generation)) return;
      for (const item of await this.queue.pending()) {
        if (!this.enabled(generation)) return;
        await this.deliver(item, generation);
      }
    } catch {
      this.warning("storage_unavailable", true);
    }
  }

  private async deliver(item: OutboxItem, generation: number): Promise<void> {
    const parsed = RuntimeFailureObservationSchema.safeParse(item.body);
    if (!parsed.success || parsed.data.instanceId !== this.options.instanceId()) return;
    const observation = parsed.data;
    try {
      await this.queue.markAttempt(item);
      if (!this.enabled(generation)) return;
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

  private captureAuthority(generation: number): CaptureOwner {
    const owner = this.options.captureOwner;
    if (!owner || this.stopped || generation !== this.generation) throw new Error("Capture owner is unavailable.");
    owner.assertOwned();
    const workspaceId = owner.workspaceId();
    const instanceId = this.options.instanceId();
    if (!workspaceId || !instanceId) throw new Error("Capture identity is unavailable.");
    return { workspaceId, instanceId };
  }

  private assertCaptureOwner(generation: number, expected: CaptureOwner): void {
    const current = this.captureAuthority(generation);
    if (current.instanceId !== expected.instanceId || current.workspaceId !== expected.workspaceId) throw new Error("Capture identity changed.");
  }

  private async importCaptures(generation: number): Promise<void> {
    if (!this.options.captureOwner) return;
    const owner = this.captureAuthority(generation);
    for (const path of await listRuntimeFailureCaptures(this.options.dataDir)) {
      try { await this.importCapture(path, generation, owner); }
      catch { this.warning("capture_unavailable"); }
    }
  }

  private async importCapture(path: string, generation: number, owner: CaptureOwner): Promise<void> {
    const assertCurrent = () => this.assertCaptureOwner(generation, owner);
    const source = await this.mutate(async () => {
      assertCurrent();
      return readRuntimeFailureCapture(path);
    });
    if (!source) return;
    const capture = source.capture;
    if (capture.workspaceId !== owner.workspaceId || capture.observation.instanceId !== owner.instanceId) return;
    assertCurrent();
    if (!(await this.queue.submit(capture.observation, { retained: true }))) return;
    await this.mutate(async () => {
      assertCurrent();
      await retireRuntimeFailureCapture(source, assertCurrent);
    });
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
