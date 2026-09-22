import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticCarrierCompanion } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diagnostic-companion-inbox-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const companion: DiagnosticCarrierCompanion = {
  schemaVersion: "diagnostic-carrier-companion-v1" as const,
  deliveryId: "delivery",
  match: { assignmentId: "assignment", attempt: 1, executionSessionId: "session", invocationId: "invocation", dispatchGeneration: 2 },
  capabilityOffer: { schemaVersion: "diagnostic-carrier-capability-offer-v1" as const, capabilities: ["diagnostic-carrier-v1"] },
  carrier: {
    schemaVersion: "diagnostic-carrier-v1" as const,
    context: {
      schemaVersion: "observability-context-v1" as const,
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      tenantId: "tenant",
      assignmentId: "assignment",
      attempt: 1,
      invocationId: "invocation",
    },
    build: { service: "core", component: "admission", sourceRevision: "a".repeat(40) },
    protocol: { remoteInstanceProtocolVersion: "2.0" },
  },
};

const candidate = {
  companion,
  deliveryDigest: "placeholder",
  runnerIncarnation: "runner",
  nodeId: "node",
  connectionRef: "connection",
  connectionEpoch: 2,
};

const receivedAt = "2026-09-21T00:00:01.000Z";

describe("native diagnostic companion inbox", () => {
  it("persists one exact diagnostic-only join fact across restart", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const input = { ...candidate, deliveryDigest: (await import("../state/diagnostic-companion-inbox.js")).diagnosticCompanionDigest(companion) };
    const record = await journal.diagnosticCompanions.receiveVerified(input, receivedAt, () => {});

    const restarted = new SupervisorJournal(dir);
    await restarted.load();
    expect(restarted.diagnosticCompanions.all()).toEqual([record]);
    expect(record).toMatchObject({ companion, receivedAt });
    expect(record).not.toHaveProperty("assignment");
    expect(record).not.toHaveProperty("receipt");
  });

  it("deduplicates one delivery and rejects a reused identifier with changed evidence", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const { diagnosticCompanionDigest } = await import("../state/diagnostic-companion-inbox.js");
    const input = { ...candidate, deliveryDigest: diagnosticCompanionDigest(companion) };
    const first = await journal.diagnosticCompanions.receiveVerified(input, receivedAt, () => {});
    await expect(journal.diagnosticCompanions.receiveVerified(input, receivedAt, () => {})).resolves.toEqual(first);
    const changed = { ...companion, carrier: { ...companion.carrier, build: { ...companion.carrier.build, component: "changed" } } };
    await expect(journal.diagnosticCompanions.receiveVerified({
      ...input,
      companion: changed,
      deliveryDigest: diagnosticCompanionDigest(changed),
    }, receivedAt, () => {})).rejects.toMatchObject({ code: "recovery_required" });
  });
});
