import { expect, it, vi } from "vitest";

const settled = () => new Promise(resolve => setTimeout(resolve, 5));
import { REMOTE_INSTANCE_PROTOCOL_VERSION, RemoteInstanceError } from "@konteks/remote-common";
import { HttpsFallbackTransport } from "../transport/https-fallback.js";
import type { AssignmentSender } from "../work/assignment-sender.js";

/**
 * The protocol this build speaks decides the carrier. Core refuses the bare
 * routes under 2.0 and a 1.0 build has no retained stream to send from, so one
 * constant moves both halves and nothing inspects a reply to guess.
 */
const core = () => ({
  pull: vi.fn(async () => ({ assignments: [] })),
  claim: vi.fn(async () => ({ assignmentId: "a", attempt: 1, claimId: "c", outcome: "claimed" })),
  report: vi.fn(async () => ({ assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: "r", reportSequence: 1 }, durableWatermark: 1, outcome: "accepted" })),
});

function transport(sender?: Partial<AssignmentSender>) {
  const client = core();
  const delivered: unknown[] = [];
  const fallback = new HttpsFallbackTransport({
    core: client as never, instanceId: () => "instance", pollIntervalMs: 60_000,
    recoveryAuthority: () => "accepted-generation",
    ...(sender ? { sender: sender as AssignmentSender } : {}),
  });
  fallback.onInbound(message => { delivered.push(message.body); });
  return { client, delivered, fallback };
}

const pull = { channel: "assignment" as const, channelId: "assignment:instance", body: { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] } };
const report = { channel: "assignment" as const, channelId: "assignment:instance", body: { assignmentId: "a", attempt: 1, claimId: "c", reportId: "r", reportSequence: 1, payloadDigest: "d".repeat(43), terminal: false, reportedAt: "2026-09-06T00:00:00.000Z" } };
const claim = { channel: "assignment" as const, channelId: "assignment:instance", body: { assignmentId: "a", attempt: 1, claimId: "c", agentId: "codex" } };

it("keeps the 1.0 bare routes when no sender is composed", async () => {
  const f = transport();
  f.fallback.send(pull as never);
  f.fallback.send(report as never);
  await settled();
  expect(f.client.pull).toHaveBeenCalledOnce();
  expect(f.client.report).toHaveBeenCalledOnce();
  expect(f.delivered).toHaveLength(2);
});

it("carries pull and report over the retained stream once a sender is composed", async () => {
  const sender = {
    acknowledge: vi.fn(async () => undefined),
    deliverAllocated: vi.fn(async (reference: Parameters<AssignmentSender["deliverAllocated"]>[0], apply: Parameters<AssignmentSender["deliverAllocated"]>[1]) => apply(reference.requestKind === "pull" ? { assignments: [] } :
      { assignmentId: "a", attempt: 1, claimId: "c", acknowledged: { reportId: "r", reportSequence: 1 }, durableWatermark: 1, outcome: "accepted" })),
  };
  const f = transport(sender as never);
  const pullRef = { requestSequence: 1, requestDigest: "d".repeat(43), requestKind: "pull" };
  const reportRef = { requestSequence: 2, requestDigest: "e".repeat(43), requestKind: "report" };
  f.fallback.send({ ...pull, assignmentRequest: pullRef } as never);
  f.fallback.send({ ...report, assignmentRequest: reportRef } as never);
  await settled();
  expect(sender.deliverAllocated.mock.calls.map(call => call[0])).toEqual([pullRef, reportRef]);
  expect(sender.acknowledge).toHaveBeenCalledTimes(2);
  expect(f.client.pull).not.toHaveBeenCalled();
  expect(f.client.report).not.toHaveBeenCalled();
});

it("runs HTTPS cursor housekeeping when the retained sender starts with no queued request", async () => {
  const sender = { acknowledge: vi.fn(async () => undefined) };
  const f = transport(sender as never);
  f.fallback.start();
  try {
    await vi.waitFor(() => expect(sender.acknowledge).toHaveBeenCalledOnce());
  } finally {
    f.fallback.stop();
  }
});

it("refuses to allocate a 2.0 claim from the transport queue", async () => {
  const sender = { deliverAllocated: vi.fn() };
  const f = transport(sender as never);
  // A claim's frame belongs to the admission owner that chose it; queueing one
  // here would invent an identity the admission never authorized.
  f.fallback.send(claim as never);
  await settled();
  expect(f.client.claim).not.toHaveBeenCalled();
  expect(f.delivered).toHaveLength(0);
});

it("states the protocol this build speaks so both halves move together", () => {
  expect(["1.0", "2.0"]).toContain(String(REMOTE_INSTANCE_PROTOCOL_VERSION));
  expect(new RemoteInstanceError("assignment_sequence_gap", "x").code).toBe("assignment_sequence_gap");
});
