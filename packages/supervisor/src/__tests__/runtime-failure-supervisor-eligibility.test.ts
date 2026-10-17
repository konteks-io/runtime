import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jcsDigest, RuntimeFailureObservationSchema, type JsonValue } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";
import { CoreClient } from "../core/client.js";
import type { ObservationDelivery } from "../control/observation-delivery.js";
import type { RuntimeFailureDelivery } from "../control/runtime-failure-delivery.js";
import { DurableOutbox } from "../state/outbox.js";
import type { StateMutationGate } from "../state/mutation-gate.js";
import type { LeaseRecord } from "../state/store.js";

interface DeliveryInternals {
  composeCoreDeliveries(): void;
  runtimeFailureDelivery: RuntimeFailureDelivery;
  observationDelivery: ObservationDelivery;
  stateMutations: StateMutationGate;
  instanceId: string;
  workspaceId: string;
  coreContractVersion: string;
  nativeOwnership: { assertOwned(): void };
}
type Eligibility = {
  mode: LeaseRecord["mode"];
  expired?: boolean;
  accepted?: boolean;
  deadlineElapsed?: boolean;
};

let dir: string;
const composed: DeliveryInternals[] = [];
const now = Date.parse("2026-10-17T20:00:00.000Z");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runtime-failure-eligibility-"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  for (const internal of composed.splice(0)) {
    internal.runtimeFailureDelivery.stop();
    await internal.runtimeFailureDelivery.flush();
    await internal.observationDelivery.stop();
    await internal.stateMutations.close();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function fixture(options: Eligibility) {
  const supervisor = new Supervisor(
    SupervisorConfigSchema.parse({
      SUPERVISOR_DATA_DIR: dir,
      SUPERVISOR_CORE_URL: "https://core.example",
    }),
  );
  const internal = supervisor as unknown as DeliveryInternals;
  Object.assign(internal, {
    instanceId: "instance",
    workspaceId: "tenant",
    coreContractVersion: "7.12",
    nativeOwnership: { assertOwned: vi.fn() },
  });
  vi.spyOn(supervisor.clock, "coreNow").mockReturnValue(now);
  supervisor.lease.set({
    lease: "fixture-lease",
    mode: options.mode,
    workspaceId: "tenant",
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + (options.expired ? -1 : 60_000)).toISOString(),
    drainDeadline: new Date(now + (options.deadlineElapsed ? -1 : 30_000)).toISOString(),
  });
  supervisor.reconciliation = { isComplete: true } as never;
  // Same retained-recovery seam as native-startup-order.test.ts. The actual
  // recoveryAuthority and LeaseState checks remain production code.
  const recovery = {
    state: "applied",
    manifest: { manifestId: "manifest", ownerRevision: 1 },
    receipt: { digest: "receipt-digest" },
    acceptedAt: new Date(now).toISOString(),
  };
  vi.spyOn(supervisor.journal.recovery, "current").mockReturnValue(
    options.accepted === false ? undefined : (recovery as never),
  );
  const send = vi
    .spyOn(CoreClient.prototype, "submitRuntimeFailure")
    .mockImplementation(async (instanceId, value) => {
      const body = RuntimeFailureObservationSchema.parse(value);
      return {
        schemaVersion: 1,
        instanceId,
        failureId: body.failureId,
        failureDigest: jcsDigest(body as unknown as JsonValue),
        status: "stored",
      };
    });
  internal.composeCoreDeliveries();
  composed.push(internal);
  await internal.runtimeFailureDelivery.flush();
  return { internal, send };
}

describe("Supervisor diagnostic history admission", () => {
  it.each([
    { label: "valid active lease", mode: "active" as const, delivered: true },
    { label: "valid drain-only lease", mode: "drain_only" as const, delivered: true },
    {
      label: "expired drain-only lease",
      mode: "drain_only" as const,
      expired: true,
      delivered: false,
    },
    {
      label: "elapsed drain deadline",
      mode: "drain_only" as const,
      deadlineElapsed: true,
      delivered: false,
    },
    {
      label: "missing accepted recovery receipt",
      mode: "drain_only" as const,
      accepted: false,
      delivered: false,
    },
  ])("uses production composition for $label", async (scenario) => {
    const { internal, send } = await fixture(scenario);
    const body = {
      schemaVersion: 1,
      instanceId: "instance",
      failureId: "retained-failure",
      observedAt: new Date(now).toISOString(),
      scope: { kind: "runtime" },
      phase: "supervisor",
      stage: "runtime_start",
      code: "temporarily_unavailable",
      evidence: { kind: "runtime_exception", errno: "EACCES" },
    };
    await expect(internal.runtimeFailureDelivery.submit(body)).resolves.toBe(true);
    await internal.runtimeFailureDelivery.flush();

    expect(send).toHaveBeenCalledTimes(scenario.delivered ? 1 : 0);
    const retained = new DurableOutbox(join(dir, "runtime-failures"));
    await retained.load();
    expect(retained.depth).toBe(scenario.delivered ? 0 : 1);
    if (scenario.delivered) expect(send).toHaveBeenCalledWith("instance", body);
  });
});
