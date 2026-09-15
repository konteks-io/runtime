import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FixedClock,
  logicalAssignmentResponseDigest,
  type AssignmentRequestReference,
  type LogicalAssignmentRequestFrame,
} from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { RecoveryAuthority } from "../transport/recovery-authority.js";
import type { OutboundMessage } from "../transport/transport.js";
import { AssignmentSender } from "../work/assignment-sender.js";
import { WorkOrchestrator } from "../work/orchestrator.js";

const at = "2026-09-06T00:00:00.000Z";
const scope = { instanceId: "instance", workspaceId: "workspace" };
const search = {
  id: "search-assignment",
  kind: "search_generation",
  placementId: "search-placement",
  ...scope,
  taskId: "manager-task",
  correlationId: "search-operation",
  attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z",
  requiredCapabilities: [],
  agentRoute: { requiredRole: "assistant", agentId: "codex" },
  source: {
    kind: "ai_manager_search",
    portability: "portable_before_claim",
    operationRef: "search-operation",
    inputRevision: 1,
    inputDigest: "a".repeat(43),
  },
  policy: {
    maxDurationSeconds: 60,
    maxArtifactBytes: 0,
    evidenceUpload: "structured_only",
    allowedArtifactKinds: [],
    recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-07T00:00:00Z",
    permissionResponderDeadlineSeconds: 60,
    humanDeferralAllowed: true,
  },
} as const;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "search-carrier-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture(options: { controller?: { acceptClaimed: ReturnType<typeof vi.fn> } } = {}) {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  const seed = {
    enrollmentId: "enrollment",
    activationId: "activation",
    keyDigest: "a".repeat(43),
    createdAt: at,
    assignmentStreamVersion: 1 as const,
  };
  await journal.execution.seedEnrollment(seed);
  await journal.execution.bindEnrollment({ ...seed, ...scope, exchangeNonce: "exchange" });
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  const sent: OutboundMessage[] = [];
  const clock = new FixedClock(Date.parse(at));
  const submit = vi.fn(async (_id: string, frame: LogicalAssignmentRequestFrame) => {
    const request = journal.assignmentStream.request(scope, frame.seq)!;
    const isPull = "maxItems" in frame.body;
    const claim = frame.body as { assignmentId?: string; attempt?: number; claimId?: string };
    const body = isPull
      ? { assignments: [search] }
      : {
          assignmentId: claim.assignmentId!, attempt: claim.attempt!, claimId: claim.claimId!,
          outcome: "claimed" as const,
        };
    const reply = {
      channel: "assignment" as const,
      channelId: frame.channelId,
      direction: "to_runtime" as const,
      seq: frame.seq,
      issuedAt: at,
      body: {
        requestSequence: frame.seq,
        requestDigest: request.digest,
        requestKind: isPull ? "pull" as const : "claim" as const,
        body,
      },
    };
    return {
      disposition: "accepted" as const,
      response: {
        deliveryId: `delivery-${frame.seq}`,
        sequence: frame.seq,
        digest: logicalAssignmentResponseDigest(reply),
      },
      frame: reply,
    };
  });
  const sender = new AssignmentSender({
    journal,
    clock,
    core: { submitAssignment: submit } as never,
    instanceId: () => scope.instanceId,
    workspaceId: () => scope.workspaceId,
    runnerIncarnation: () => "process",
    originManifestId: () => "manifest",
    assertOwned: () => undefined,
    captureRecoveryAuthority: () => new RecoveryAuthority(() => "accepted-generation").capture("assignment"),
    captureClaimAuthority: admission => work.capturePendingClaimAuthority(admission),
  });
  const work = new WorkOrchestrator({
    journal,
    outbox,
    assignmentSender: sender,
    clock,
    deploymentKind: "native_connector",
    transport: { send: (message: OutboundMessage) => sent.push(message) },
    instanceId: () => scope.instanceId,
    workspaceId: () => scope.workspaceId,
    runnerIncarnation: () => "process",
    assertOwned: () => undefined,
    recoveryAuthority: () => "accepted-generation",
    reportDeliveryAllowed: () => true,
    reconciliationComplete: () => true,
    lease: { canPullNewWork: () => true },
    draining: () => false,
    headroom: () => 1,
    maxPullItems: 1,
    acceptedKinds: () => ["search_generation"],
    advertisedRoles: () => ["assistant"],
    browserToolAvailable: () => false,
    agents: () => [{ agentId: "codex", readiness: "ready", connectionState: "ready" }],
    instanceEvidencePolicy: () => "structured_only",
    components: {},
    runners: new Map([["codex", { createSession: vi.fn() } as never]]),
    ...(options.controller ? { searchController: options.controller } : {}),
  } as never);
  const pull = await sender.preparePull({
    instanceId: scope.instanceId,
    maxItems: 1,
    acceptedKinds: ["search_generation"],
  });
  const deliver = (reference: AssignmentRequestReference) =>
    sender.deliverAllocated(reference, body => work.onAssignmentMessage(body, reference));
  return { journal, outbox, work, sender, submit, sent, pull, deliver };
}

it("durably claims Search, hands the exact claim to its hosted controller, then opens the local ACP session", async () => {
  const controller = { acceptClaimed: vi.fn(async () => undefined) };
  const f = await fixture({ controller });
  const startRelayedSession = vi.spyOn(f.work as never, "startRelayedSession" as never)
    .mockResolvedValue(undefined as never);
  await f.deliver(f.pull);
  const claim = f.journal.execution.start(search.id, search.attempt)!;
  expect(claim.assignment).toEqual(search);
  expect(claim.allocation).toMatchObject({ requestKind: "claim", requestSequence: 2 });

  await f.deliver(claim.allocation!);

  expect(controller.acceptClaimed).toHaveBeenCalledOnce();
  expect(controller.acceptClaimed).toHaveBeenCalledWith({
    assignment: search,
    admission: claim.admission,
  });
  expect(f.journal.execution.start(search.id, search.attempt)).toMatchObject({
    claimEffect: { state: "applied", response: { sequence: 2 } },
  });
  expect(startRelayedSession).toHaveBeenCalledOnce();
  expect(startRelayedSession).toHaveBeenCalledWith(search, expect.objectContaining({
    assignmentId: search.id,
    attempt: search.attempt,
    claimId: claim.admission.claimId,
  }), expect.any(Function));
});

it("replays the exact retained Search claim after a lost response without allocating or handing off a duplicate", async () => {
  const controller = { acceptClaimed: vi.fn(async () => undefined) };
  const f = await fixture({ controller });
  await f.deliver(f.pull);
  const reference = f.journal.execution.start(search.id, search.attempt)!.allocation!;
  f.submit.mockRejectedValueOnce(new Error("response lost"));
  await expect(f.deliver(reference)).rejects.toThrow("response lost");

  await f.deliver(reference);

  expect(f.submit.mock.calls[1]![1]).toEqual(f.submit.mock.calls[2]![1]);
  expect(f.journal.assignmentStream.snapshot(scope).allocatedThrough).toBe(2);
  expect(controller.acceptClaimed).toHaveBeenCalledOnce();
});

it("fails closed instead of silently dropping Search when its dedicated controller boundary is absent", async () => {
  const f = await fixture();
  await expect(f.deliver(f.pull)).rejects.toMatchObject({ code: "recovery_required" });
  expect(f.journal.execution.start(search.id, search.attempt)).toBeUndefined();
  expect(f.outbox.depth).toBe(0);
});
