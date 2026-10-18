import { randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  isFsErrorWithCode,
  jcsDigest,
  RemoteInstanceError,
  RuntimeFailureObservationSchema,
  RUNTIME_FAILURE_OBSERVATION_MAX_BYTES,
  writeSecretFile,
  type Clock,
  type JsonValue,
  type RuntimeFailureObservation,
} from "@konteks/remote-common";
import { DurableOutbox, type OutboxItem } from "../state/outbox.js";
import { unrestrictedStateMutation, type StateMutation } from "../state/mutation-gate.js";

const CAPACITY = 256;
const SNAPSHOT_LIMIT = 8;
const SIDECAR_BYTES = 2 * RUNTIME_FAILURE_OBSERVATION_MAX_BYTES;
const SUMMARY_COUNT_LIMIT = 1_000_000;

const SuppressionSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: RuntimeFailureObservationSchema.shape.instanceId,
    suppressedCount: z.number().int().nonnegative().safe(),
    pendingBatch: RuntimeFailureObservationSchema.optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.pendingBatch && !suppressionBatch(state.pendingBatch, state.instanceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingBatch"],
        message: "Invalid retained suppression batch",
      });
    }
  });
type Suppression = z.infer<typeof SuppressionSchema>;
type Options = {
  dataDir: string;
  instanceId: () => string;
  clock: Clock;
  mutate?: StateMutation;
  degraded: (omittedCountUnknown?: boolean) => void;
};

/** A separate local journal; no queue operation performs network I/O. */
export class RuntimeFailureQueue {
  private readonly dir: string;
  private readonly outbox: DurableOutbox;
  private readonly mutate: StateMutation;
  private ready: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {
    this.dir = join(options.dataDir, "runtime-failures");
    this.mutate = options.mutate ?? unrestrictedStateMutation;
    this.outbox = new DurableOutbox(this.dir, this.mutate);
  }

  async submit(body: unknown, options: { retained?: boolean } = {}): Promise<boolean> {
    const parsed = RuntimeFailureObservationSchema.safeParse(body);
    if (!parsed.success || parsed.data.instanceId !== this.options.instanceId()) {
      this.degraded(true);
      return false;
    }
    return this.serialized(async () => {
      try {
        return await this.submitInternal(parsed.data, options.retained === true);
      } catch {
        this.degraded(true);
        return false;
      }
    });
  }

  pending(): Promise<OutboxItem[]> {
    return this.serialized(() =>
      this.guarded(async () => {
        await this.load();
        await this.reserveSuppression();
        return this.outbox
          .all("observation")
          .filter((item) => this.ownedBody(item) !== null)
          .sort(
            (a, b) =>
              (a.lastAttemptAt ?? "").localeCompare(b.lastAttemptAt ?? "") || a.order - b.order,
          )
          .slice(0, SNAPSHOT_LIMIT);
      }),
    );
  }

  markAttempt(item: OutboxItem): Promise<void> {
    return this.serialized(() =>
      this.guarded(async () => {
        await this.load();
        if (this.retainedItem(item))
          await this.outbox.markAttempt(item.id, this.options.clock.nowIso());
      }),
    );
  }

  ack(item: OutboxItem): Promise<void> {
    return this.serialized(() =>
      this.guarded(async () => {
        await this.load();
        if (this.retainedItem(item)) await this.outbox.ack(item.id);
        await this.reserveSuppression();
      }),
    );
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new RemoteInstanceError("local_io_failure", "Runtime failure queue is unavailable.");
    }
  }

  private load(): Promise<void> {
    this.ready ??= this.initialize().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async initialize(): Promise<void> {
    await this.mutate(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(this.dir, 0o700);
    });
    await this.outbox.load();
    if (this.outbox.depth > CAPACITY) this.degraded(true);
  }

  private async submitInternal(body: RuntimeFailureObservation, retained: boolean): Promise<boolean> {
    await this.load();
    if (body.instanceId !== this.options.instanceId()) {
      this.degraded(true);
      return false;
    }
    const existing = this.existing(body);
    if (existing) return sameBody(existing, body);
    await this.reserveSuppression();
    if (this.outbox.depth >= CAPACITY) {
      // An immutable source still owns this fact; capacity only defers its handoff.
      if (!retained) await this.suppress(body.instanceId);
      return false;
    }
    return this.enqueue(body);
  }

  private existing(body: RuntimeFailureObservation): OutboxItem | undefined {
    const key = identityKey(body);
    return this.outbox
      .all()
      .find((item) => item.key === key || sameIdentity(this.ownedBody(item), body));
  }

  private ownedBody(item: OutboxItem): RuntimeFailureObservation | null {
    const parsed = RuntimeFailureObservationSchema.safeParse(item.body);
    return parsed.success && parsed.data.instanceId === this.options.instanceId()
      ? parsed.data
      : null;
  }

  private retainedItem(snapshot: OutboxItem): OutboxItem | undefined {
    const current = this.outbox.all("observation").find((item) => item.id === snapshot.id);
    if (!current) return undefined;
    const body = this.ownedBody(snapshot);
    if (!body || snapshot.key !== current.key || !sameBody(current, body)) {
      throw new RemoteInstanceError(
        "registration_mismatch",
        "Runtime failure queue item does not match.",
      );
    }
    return current;
  }

  private async enqueue(body: RuntimeFailureObservation): Promise<boolean> {
    const existing = this.existing(body);
    if (existing) return sameBody(existing, body);
    if (this.outbox.depth >= CAPACITY) return false;
    const key = identityKey(body);
    await this.outbox.enqueue({
      id: key,
      key,
      channel: "observation",
      group: key,
      order: this.options.clock.now(),
      createdAt: this.options.clock.nowIso(),
      body,
    });
    return true;
  }

  private async suppress(instanceId: string): Promise<void> {
    const state = await this.readSuppression();
    if (!state) return;
    if (state.instanceId !== instanceId) {
      this.degraded(true);
      return;
    }
    if (state.suppressedCount === Number.MAX_SAFE_INTEGER) {
      this.degraded(true);
      return;
    }
    try {
      await this.writeSuppression({
        ...state,
        instanceId,
        suppressedCount: state.suppressedCount + 1,
      });
      this.degraded();
    } catch {
      this.degraded(true);
    }
  }

  private async reserveSuppression(): Promise<void> {
    const initial = await this.readSuppression();
    if (!initial) return;
    try {
      let state: Suppression | null = initial;
      while (state) state = await this.materializeBatch(state);
    } catch {
      this.degraded(true);
    }
  }

  private async materializeBatch(state: Suppression): Promise<Suppression | null> {
    const frozen = await this.freezeBatch(state);
    if (!frozen?.pendingBatch) return null;
    const existing = this.existing(frozen.pendingBatch);
    if (existing && !sameBody(existing, frozen.pendingBatch)) {
      this.degraded(true);
      return null;
    }
    if (!(await this.enqueue(frozen.pendingBatch))) return null;
    const cleared: Suppression = {
      schemaVersion: 1,
      instanceId: frozen.instanceId,
      suppressedCount: frozen.suppressedCount,
    };
    await this.writeSuppression(cleared);
    return cleared;
  }

  private async freezeBatch(state: Suppression): Promise<Suppression | null> {
    if (state.pendingBatch) return state;
    if (state.suppressedCount === 0 || this.outbox.depth >= CAPACITY) return null;
    const count = Math.min(state.suppressedCount, SUMMARY_COUNT_LIMIT);
    const pendingBatch = RuntimeFailureObservationSchema.parse({
      schemaVersion: 1,
      failureId: randomUUID(),
      instanceId: state.instanceId,
      observedAt: new Date(this.options.clock.coreNow()).toISOString(),
      scope: { kind: "runtime" },
      phase: "supervisor",
      stage: "diagnostic_queue",
      code: "runtime_failure_suppressed",
      evidence: { kind: "runtime_condition" },
      suppressedCount: count,
    });
    const frozen: Suppression = {
      ...state,
      suppressedCount: state.suppressedCount - count,
      pendingBatch,
    };
    await this.writeSuppression(frozen);
    return frozen;
  }

  private async readSuppression(): Promise<Suppression | null> {
    try {
      const raw = await boundedSidecar(join(this.dir, "suppression.json"));
      if (raw === null)
        return { schemaVersion: 1, instanceId: this.options.instanceId(), suppressedCount: 0 };
      const state = SuppressionSchema.parse(JSON.parse(raw));
      if (state.instanceId !== this.options.instanceId()) {
        this.degraded(true);
        return null;
      }
      return state;
    } catch {
      this.degraded(true);
      return null;
    }
  }

  private writeSuppression(state: Suppression): Promise<void> {
    if (state.instanceId !== this.options.instanceId())
      throw new RemoteInstanceError(
        "registration_mismatch",
        "Runtime failure counter belongs to another instance.",
      );
    const text = JSON.stringify(SuppressionSchema.parse(state));
    if (Buffer.byteLength(text) > SIDECAR_BYTES)
      throw new RemoteInstanceError("local_io_failure", "Runtime failure counter is unavailable.");
    return this.mutate(() => writeSecretFile(join(this.dir, "suppression.json"), text));
  }

  private degraded(unknown?: boolean): void {
    try {
      this.options.degraded(unknown);
    } catch {
      /* Diagnostic degradation cannot stop ordinary work. */
    }
  }
}

function identityKey(body: RuntimeFailureObservation): string {
  return `runtime-failure:${jcsDigest([body.instanceId, body.failureId])}`;
}

function sameIdentity(
  left: RuntimeFailureObservation | null,
  right: RuntimeFailureObservation,
): boolean {
  return (
    left !== null && left.instanceId === right.instanceId && left.failureId === right.failureId
  );
}

function sameBody(item: OutboxItem, body: RuntimeFailureObservation): boolean {
  return (
    item.channel === "observation" &&
    jcsDigest(item.body as JsonValue) === jcsDigest(body as unknown as JsonValue)
  );
}

function suppressionBatch(body: RuntimeFailureObservation, instanceId: string): boolean {
  return (
    body.instanceId === instanceId &&
    body.scope.kind === "runtime" &&
    body.phase === "supervisor" &&
    body.evidence.kind === "runtime_condition" &&
    body.suppressedCount !== undefined
  );
}

async function boundedSidecar(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > SIDECAR_BYTES)
      throw new Error("Invalid runtime failure counter");
    const buffer = Buffer.alloc(SIDECAR_BYTES);
    const { bytesRead } = await file.read(buffer, 0, SIDECAR_BYTES, 0);
    if (bytesRead !== info.size || (await file.stat()).size !== info.size)
      throw new Error("Unstable runtime failure counter");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
