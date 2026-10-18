import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FixedClock,
  createLogger,
  jcsDigest,
  writeSecretFile,
  type JsonValue,
} from "@konteks/remote-common";
import { DurableOutbox } from "../state/outbox.js";
import { ObservationDelivery } from "../control/observation-delivery.js";
import { RuntimeFailureDelivery } from "../control/runtime-failure-delivery.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runtime-failure-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const observedAt = "2026-10-17T18:00:00Z";
const failure = (failureId = "failure-one") => ({
  schemaVersion: 1,
  failureId,
  observedAt,
  instanceId: "instance",
  scope: { kind: "assignment", assignmentId: "assignment", attempt: 1, claimId: "claim" },
  phase: "tool",
  stage: "tool_terminal",
  code: "tool_failed",
  evidence: { kind: "tool_status", status: "failed" },
  toolCallId: failureId,
});

function receipt(value: unknown, status: "stored" | "duplicate" | "expired" = "stored") {
  const body = value as { instanceId: string; failureId: string };
  return {
    schemaVersion: 1 as const,
    instanceId: body.instanceId,
    failureId: body.failureId,
    failureDigest: jcsDigest(value as JsonValue),
    status,
  };
}

type Sender = (instanceId: string, body: unknown) => Promise<ReturnType<typeof receipt>>;
function fixture(send: Sender = async (_id, body) => receipt(body)) {
  const submitRuntimeFailure = vi.fn(send);
  let enabled = true;
  let availabilityFailed = false;
  let version: string | null = "7.12";
  const logger = createLogger({ name: "runtime-failure-test" });
  const logs: unknown[][] = [];
  for (const level of ["warn", "error", "info", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
  const delivery = new RuntimeFailureDelivery({
    dataDir: dir,
    core: { submitRuntimeFailure },
    instanceId: () => "instance",
    clock: new FixedClock(Date.parse(observedAt)),
    coreContractVersion: () => version,
    canSend: () => {
      if (availabilityFailed) throw new Error("private ownership failure");
      return enabled;
    },
    logger,
  });
  return {
    delivery,
    submitRuntimeFailure,
    logs,
    logger,
    disable: () => {
      enabled = false;
    },
    failAvailability: () => {
      availabilityFailed = true;
    },
    version: (value: string | null) => {
      version = value;
    },
  };
}

async function pending() {
  const outbox = new DurableOutbox(join(dir, "runtime-failures"));
  await outbox.load();
  return outbox;
}

async function fill(f: ReturnType<typeof fixture>, prefix = "full") {
  const count = (await pending()).depth;
  for (let n = count; n < 256; n += 1) {
    await expect(f.delivery.submit(failure(`${prefix}-${n}`))).resolves.toBe(true);
  }
}

function summaries(outbox: DurableOutbox) {
  return outbox
    .all()
    .filter(
      (item) =>
        typeof item.body === "object" && item.body !== null && "suppressedCount" in item.body,
    )
    .map((item) => item.body as { failureId: string; suppressedCount: number });
}

// A counter and one frozen batch share one atomic replacement, bound to their instance.
const suppressionPath = () => join(dir, "runtime-failures", "suppression.json");
async function seedSuppression(suppressedCount: number, pendingBatch?: unknown) {
  await writeSecretFile(
    suppressionPath(),
    JSON.stringify({
      schemaVersion: 1,
      instanceId: "instance",
      suppressedCount,
      ...(pendingBatch === undefined ? {} : { pendingBatch }),
    }),
  );
}

describe("Runtime failure delivery", () => {
  it("commits a separate immutable record and does not await network delivery", async () => {
    const f = fixture();
    const value = failure();
    await expect(f.delivery.submit(value)).resolves.toBe(true);
    value.code = "changed_after_enqueue";
    const stored = (await pending()).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toEqual(failure());
    expect(Buffer.byteLength(JSON.stringify(stored[0]!.body))).toBeLessThanOrEqual(4096);
    expect(stored[0]!.channel).toBe("observation");
    expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
    const ordinary = new DurableOutbox(dir);
    await ordinary.load();
    expect(ordinary.depth).toBe(0);
  });

  it("replays the same body after lost response and restart", async () => {
    const first = fixture(async () => {
      throw new Error("response lost");
    });
    await first.delivery.submit(failure());
    await first.delivery.flush();
    expect((await pending()).depth).toBe(1);
    const restarted = fixture();
    await restarted.delivery.flush();
    expect(restarted.submitRuntimeFailure.mock.calls[0]).toEqual(
      first.submitRuntimeFailure.mock.calls[0],
    );
    expect((await pending()).depth).toBe(0);
  });

  it("converges an exact duplicate but does not accept changed bytes under one failure identity", async () => {
    const f = fixture();
    await expect(f.delivery.submit(failure())).resolves.toBe(true);
    await expect(f.delivery.submit(failure())).resolves.toBe(true);
    await expect(f.delivery.submit({ ...failure(), code: "different_failure" })).resolves.toBe(
      false,
    );
    const stored = (await pending()).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toEqual(failure());
  });

  it("retains the exact record when local receipt acknowledgment cannot persist", async () => {
    const f = fixture();
    await f.delivery.submit(failure());
    vi.spyOn(DurableOutbox.prototype, "ack").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.delivery.flush()).resolves.toBeUndefined();
    expect((await pending()).depth).toBe(1);
    const restarted = fixture();
    await restarted.delivery.flush();
    expect(restarted.submitRuntimeFailure.mock.calls[0]).toEqual(
      f.submitRuntimeFailure.mock.calls[0],
    );
    expect((await pending()).depth).toBe(0);
  });

  it.each(["stored", "duplicate", "expired"] as const)(
    "retires only the bound %s receipt",
    async (status) => {
      const f = fixture(async (_id, value) => receipt(value, status));
      await f.delivery.submit(failure());
      await f.delivery.flush();
      expect((await pending()).depth).toBe(0);
    },
  );

  it.each([
    { instanceId: "foreign" },
    { failureId: "different" },
    { failureDigest: "B".repeat(43) },
    { schemaVersion: 2 },
    { status: "accepted" },
    { unexpected: true },
  ])("retains a record after an unbound or malformed response %#", async (patch) => {
    const f = fixture(async (_id, value) => ({ ...receipt(value), ...patch }) as never);
    await f.delivery.submit(failure());
    await expect(f.delivery.flush()).resolves.toBeUndefined();
    expect((await pending()).all()[0]!.body).toEqual(failure());
  });

  it.each([null, "7.11"])(
    "queues without uploading before signed Core 7.12 support (%s)",
    async (version) => {
      const f = fixture();
      f.version(version);
      await f.delivery.submit(failure());
      await f.delivery.flush();
      expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
      expect((await pending()).depth).toBe(1);
      f.version("7.12");
      await f.delivery.flush();
      expect(f.submitRuntimeFailure).toHaveBeenCalledOnce();
    },
  );

  it("retains local evidence while authentication or recovery is unavailable", async () => {
    const f = fixture();
    f.disable();
    await f.delivery.submit(failure());
    await f.delivery.flush();
    expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
    expect((await pending()).depth).toBe(1);
  });

  it("contains a failed availability check even when its diagnostic logger throws", async () => {
    const f = fixture();
    f.failAvailability();
    vi.mocked(f.logger.warn).mockImplementation(() => {
      throw new Error("private logger failure");
    });
    await expect(f.delivery.flush()).resolves.toBeUndefined();
    expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
  });

  it("never uploads another instance's persisted history", async () => {
    await mkdir(join(dir, "runtime-failures"), { recursive: true });
    const outbox = await pending();
    await outbox.enqueue({
      id: "foreign",
      key: "foreign",
      channel: "observation",
      group: "foreign",
      order: 0,
      body: { ...failure(), instanceId: "foreign" },
      createdAt: observedAt,
    });
    const f = fixture();
    await f.delivery.flush();
    expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
    expect((await pending()).depth).toBe(1);
  });

  it("shares one bounded eight-record flush flight", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    const f = fixture(async (_id, value) => {
      if (sent++ === 0) await blocked;
      return receipt(value);
    });
    for (let n = 0; n < 20; n += 1) await f.delivery.submit(failure(`bounded-${n}`));
    const first = f.delivery.flush();
    const second = f.delivery.flush();
    await vi.waitFor(() => expect(f.submitRuntimeFailure).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(f.submitRuntimeFailure).toHaveBeenCalledTimes(8);
    expect((await pending()).depth).toBe(12);
  });

  it("does not consume normal usage capacity or hold its delivery behind a diagnostic request", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (_id, value) => {
      await blocked;
      return receipt(value);
    });
    await f.delivery.submit(failure());
    const flushing = f.delivery.flush();
    await vi.waitFor(() => expect(f.submitRuntimeFailure).toHaveBeenCalledOnce());
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    const submitObservation = vi.fn(async () => undefined);
    const usage = new ObservationDelivery({
      outbox,
      core: { submitObservation },
      instanceId: () => "instance",
      clock: new FixedClock(Date.parse(observedAt)),
      canSend: () => true,
    });
    await usage.submit({
      instanceId: "instance",
      assignmentId: "assignment",
      agentId: "codex",
      attempt: 1,
      moneyBasis: "unavailable_local_subscription",
      observedAt,
      outputTokens: 3,
    });
    await usage.flush();
    expect(submitObservation).toHaveBeenCalledOnce();
    expect(outbox.depth).toBe(0);
    release();
    await flushing;
  });

  it("contains diagnostic storage and sender faults without recursive diagnostic submission", async () => {
    const f = fixture(async () => {
      throw new Error("private provider detail");
    });
    vi.spyOn(DurableOutbox.prototype, "enqueue").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    await expect(f.delivery.submit(failure("not-persisted"))).resolves.toBe(false);
    await expect(f.delivery.submit(failure())).resolves.toBe(true);
    const submit = vi.spyOn(f.delivery, "submit");
    await expect(f.delivery.flush()).resolves.toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
    expect(inspect(f.logs)).not.toContain("private provider detail");
    expect((await pending()).depth).toBe(1);
  });

  it.each([{ message: "private provider detail" }, { code: "x".repeat(4097) }])(
    "never persists invalid or overlarge raw evidence %#",
    async (patch) => {
      const f = fixture();
      await expect(f.delivery.submit({ ...failure(), ...patch })).resolves.toBe(false);
      expect((await pending()).depth).toBe(0);
      expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
    },
  );

  it("caps pending records at 256 and retains exact suppression batches across restart", async () => {
    const first = fixture();
    await fill(first);
    await expect(first.delivery.submit(failure("overflow-one"))).resolves.toBe(false);
    await expect(first.delivery.submit(failure("overflow-two"))).resolves.toBe(false);
    expect((await pending()).depth).toBe(256);
    const restarted = fixture();
    await restarted.delivery.flush();
    await restarted.delivery.flush();
    let outbox = await pending();
    expect(outbox.depth).toBeLessThanOrEqual(256);
    const firstBatch = summaries(outbox);
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]!.suppressedCount).toBe(2);
    expect(outbox.all().map((item) => item.body)).toContainEqual(
      expect.objectContaining({
        schemaVersion: 1,
        scope: { kind: "runtime" },
        phase: "supervisor",
        evidence: { kind: "runtime_condition" },
        suppressedCount: 2,
      }),
    );
    const restored = fixture();
    await fill(restored, "next-full");
    await expect(restored.delivery.submit(failure("later-overflow"))).resolves.toBe(false);
    const next = fixture();
    await next.delivery.flush();
    await next.delivery.flush();
    outbox = await pending();
    expect(
      summaries(outbox)
        .map((value) => value.suppressedCount)
        .sort(),
    ).toEqual([1, 2]);
    expect(summaries(outbox).find((value) => value.suppressedCount === 2)).toEqual(firstBatch[0]);
    expect(outbox.depth).toBeLessThanOrEqual(256);
  });

  it("splits an exact durable large counter into bounded frozen batches without saturation", async () => {
    await seedSuppression(1_000_002);
    const f = fixture();
    for (let pass = 0; pass < 4; pass += 1) await f.delivery.flush();
    const sent = f.submitRuntimeFailure.mock.calls.map(
      ([, body]) => body as { suppressedCount: number },
    );
    expect(sent.map((body) => body.suppressedCount)).toEqual([1_000_000, 2]);
    expect(JSON.parse(await readFile(suppressionPath(), "utf8"))).toEqual({
      schemaVersion: 1,
      instanceId: "instance",
      suppressedCount: 0,
    });
    expect((await pending()).depth).toBe(0);
    const restarted = fixture();
    await restarted.delivery.flush();
    expect(restarted.submitRuntimeFailure).not.toHaveBeenCalled();
  });

  it("recovers enqueue-before-batch-clear without recounting the already frozen omissions", async () => {
    await seedSuppression(2);
    const first = fixture(async () => {
      throw new Error("response lost");
    });
    await first.delivery.flush();
    const frozen = summaries(await pending());
    expect(frozen).toHaveLength(1);
    // Reconstruct the atomic sidecar just before its post-enqueue clear. The
    // real durable outbox already contains that same batch's canonical body.
    await seedSuppression(1, frozen[0]);
    const restarted = fixture();
    for (let pass = 0; pass < 4; pass += 1) await restarted.delivery.flush();
    const sent = restarted.submitRuntimeFailure.mock.calls.map(
      ([, body]) => body as { failureId: string; suppressedCount: number },
    );
    expect(sent.filter((body) => body.failureId === frozen[0]!.failureId)).toEqual([frozen[0]]);
    expect(sent.map((body) => body.suppressedCount).sort()).toEqual([1, 2]);
    expect((await pending()).depth).toBe(0);
    expect(JSON.parse(await readFile(suppressionPath(), "utf8"))).toEqual({
      schemaVersion: 1,
      instanceId: "instance",
      suppressedCount: 0,
    });
  });

  it("reports an unknown omitted count when atomic suppression persistence fails", async () => {
    const f = fixture();
    await fill(f);
    await expect(f.delivery.submit(failure("known-capacity-omission"))).resolves.toBe(false);
    await rm(suppressionPath(), { force: true });
    await mkdir(suppressionPath());
    const before = f.logs.length;
    await expect(f.delivery.submit(failure("unrecorded-overflow"))).resolves.toBe(false);
    const degradation = f.logs.slice(before).flat();
    expect(degradation).toContainEqual(expect.objectContaining({ omittedCount: "unknown" }));
    expect(f.submitRuntimeFailure).not.toHaveBeenCalled();
    expect((await pending()).depth).toBe(256);
    await rm(suppressionPath(), { recursive: true });
    await seedSuppression(0);
    const restarted = fixture();
    await restarted.delivery.flush();
    expect(summaries(await pending())).toHaveLength(0);
  });
});
