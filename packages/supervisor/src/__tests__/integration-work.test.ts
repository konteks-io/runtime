import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteWorkAssignmentSchema, type RemoteWorkAssignment } from "@konteks/remote-common";
import { REMOTE_INTEGRATION_TASK_CAPABILITY } from "@konteks/backstage-plugin-common";
import { SupervisorJournal } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { LeaseState } from "../lease/lease.js";
import { WorkOrchestrator } from "../work/orchestrator.js";
import { acceptedWorkKinds } from "../work/accepted-kinds.js";
import { isIntegrationWorkAssignment } from "../integration/carrier.js";
import type { TransportManager } from "../transport/relay-transport.js";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kr-integration-work-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const clock = new FixedClock(Date.parse("2026-10-01T00:00:00Z"));
const integration = RemoteWorkAssignmentSchema.parse({
  id: "asg-int", kind: "integration", placementId: "pl", instanceId: "inst-1", workspaceId: "ws-1", taskId: "xi-task-1", correlationId: "c", attempt: 1,
  expiresAt: "2026-10-01T01:00:00Z", requiredCapabilities: [REMOTE_INTEGRATION_TASK_CAPABILITY],
  agentRoute: { requiredRole: "assistant", agentId: "codex" },
  source: { kind: "integration_task", portability: "instance_bound", ownerInstanceId: "inst-1", taskId: "xi-task-1", specDigest: "a".repeat(64) },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
    latestResumeAt: "2026-10-01T02:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: false },
}) as RemoteWorkAssignment;
const readyAgent = { agentId: "codex", displayName: "Codex", connectionState: "ready" as const, authMode: "agent_local_subscription" as const, accountScope: "personal" as const, readiness: "ready" as const, tokenUsageObservable: true, acpCapabilities: { sessionResume: true, forkSession: false, structuredOutputShim: true, toolControl: "approve" as const } };

async function orchestrator(overrides: Partial<ConstructorParameters<typeof WorkOrchestrator>[0]> = {}) {
  const journal = new SupervisorJournal(dir);
  await journal.load();
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  const lease = new LeaseState(clock);
  lease.set({ lease: "l", mode: "active", expiresAt: "2026-10-02T00:00:00Z", drainDeadline: null, issuedAt: "2026-10-01T00:00:00Z", workspaceId: "ws-1" });
  const transport = { send: () => undefined, openChannel: () => undefined, closeChannel: () => undefined, kind: "relay", available: true } as unknown as TransportManager;
  const work = new WorkOrchestrator({
    clock, journal, outbox, transport, lease,
    instanceId: () => "inst-1", runnerIncarnation: () => "process", assertOwned: () => undefined, workspaceId: () => "ws-1",
    agents: () => [readyAgent], roleBindings: () => [{ role: "assistant", agentPreference: ["codex"] }], advertisedRoles: () => ["assistant"],
    acceptedKinds: () => acceptedWorkKinds("7.3"), instanceEvidencePolicy: () => "structured_only", draining: () => false,
    reconciliationComplete: () => true, recoveryAuthority: () => "accepted", reportDeliveryAllowed: () => true, headroom: () => 2, maxPullItems: 4,
    runners: new Map(), sessionDeps: () => { throw new Error("an integration task never opens a relayed session"); }, onUsage: async () => undefined,
    ...overrides,
  });
  return { work, journal };
}

describe("integration work kind", () => {
  it("is asked for only from a Core that signs contract 7.3 or later", () => {
    expect(acceptedWorkKinds(undefined)).not.toContain("integration");
    expect(acceptedWorkKinds(undefined)).not.toContain("direct");
    expect(acceptedWorkKinds("7.1")).toContain("direct");
    expect(acceptedWorkKinds("7.2")).not.toContain("integration");
    expect(acceptedWorkKinds("7.3")).toEqual(expect.arrayContaining(["direct", "integration", "delivery", "onboarding"]));
    expect(acceptedWorkKinds("8.0")).toContain("integration");
  });

  it("is recognized by its kind and its integration_task source", () => {
    expect(isIntegrationWorkAssignment(integration)).toBe(true);
    expect(isIntegrationWorkAssignment({ ...integration, kind: "assistant_execution" } as RemoteWorkAssignment)).toBe(false);
  });

  it("is refused by a runtime without the integration carrier, and by an older Core's kinds", async () => {
    expect((await orchestrator()).work.validate(integration)).toBe("unknown_kind");
    const carrier = { execute: vi.fn(), onRunnerEvent: vi.fn() };
    expect((await orchestrator({ integrationCarrier: carrier, acceptedKinds: () => acceptedWorkKinds("7.2") })).work.validate(integration)).toBe("unknown_kind");
    expect((await orchestrator({ integrationCarrier: carrier })).work.validate(integration)).toBeNull();
  });

  it("runs on the carrier, reports its structured result as the terminal report and opens no relayed session", async () => {
    const structuredOutput = { schemaVersion: 1, taskId: "xi-task-1", phase: "read", toolCalls: [], observations: [] };
    const carrier = { execute: vi.fn(async () => ({ structuredOutput })), onRunnerEvent: vi.fn(async () => undefined) };
    const { work, journal } = await orchestrator({ integrationCarrier: carrier });
    const entry = { assignmentId: integration.id, attempt: 1, claimId: "claim-1", kind: "integration" as const, placementId: "pl", workspaceId: "ws-1", agentId: "codex",
      state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const,
      expiresAt: integration.expiresAt, latestResumeAt: integration.policy.latestResumeAt, updatedAt: clock.nowIso() };
    await journal.assignments.put(entry);
    const submit = vi.spyOn(work.reports, "submit").mockResolvedValue(undefined as never);
    await (work as unknown as { dispatchImpl(a: RemoteWorkAssignment, e: typeof entry, f: () => void): Promise<void> }).dispatchImpl(integration, entry, () => undefined);
    expect(carrier.execute).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "asg-int", claimId: "claim-1",
      draft: { terminal: true, result: expect.objectContaining({ class: "succeeded", structuredOutput }) } }));
    expect(journal.assignments.get("asg-int:1")?.state).toBe("running");
  });

  it("hands a claimed read off the claim lane, so one slow read never holds the next claim", async () => {
    let finish!: () => void;
    const carrier = {
      execute: vi.fn(() => new Promise<{ structuredOutput: unknown }>(resolve => { finish = () => resolve({ structuredOutput: { schemaVersion: 1 } }); })),
      onRunnerEvent: vi.fn(async () => undefined),
    };
    const { work, journal } = await orchestrator({ integrationCarrier: carrier });
    const entry = { assignmentId: integration.id, attempt: 1, claimId: "claim-1", kind: "integration" as const, placementId: "pl", workspaceId: "ws-1", agentId: "codex",
      state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const,
      expiresAt: integration.expiresAt, latestResumeAt: integration.policy.latestResumeAt, updatedAt: clock.nowIso() };
    await journal.assignments.put(entry);
    const submit = vi.spyOn(work.reports, "submit").mockResolvedValue(undefined as never);
    const internals = work as unknown as {
      dispatchClaimed(claimed: { key: string; assignment: RemoteWorkAssignment; entry: typeof entry; assertAuthority: () => void }): Promise<void>;
      dispatching: Map<string, Promise<void>>;
    };
    await internals.dispatchClaimed({ key: "asg-int:1", assignment: integration, entry, assertAuthority: () => undefined });
    // The claim handler returned while the read still runs, and the read stays owned.
    await vi.waitFor(() => expect(carrier.execute).toHaveBeenCalledOnce());
    expect(submit).not.toHaveBeenCalled();
    expect(internals.dispatching.has("asg-int:1")).toBe(true);
    finish();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(internals.dispatching.has("asg-int:1")).toBe(false));
  });

  it("passes runner events to the carrier so its own ACP session hears them", async () => {
    const carrier = { execute: vi.fn(), onRunnerEvent: vi.fn(async () => undefined) };
    const { work } = await orchestrator({ integrationCarrier: carrier });
    const event = { kind: "session_update" as const, acpSessionRef: "ref-1", params: {} };
    await work.onRunnerEvent(event);
    expect(carrier.onRunnerEvent).toHaveBeenCalledWith(event);
  });
});

describe("integration-task-v1 advertisement", () => {
  it("is advertised when a Claude Code or Codex runner can hold a binding, and not for host agents alone", async () => {
    const { integrationTaskCapabilities } = await import("../integration/carrier.js");
    expect(integrationTaskCapabilities(["codex"])).toEqual([REMOTE_INTEGRATION_TASK_CAPABILITY]);
    expect(integrationTaskCapabilities(["claude-code", "dsh"])).toEqual([REMOTE_INTEGRATION_TASK_CAPABILITY]);
    expect(integrationTaskCapabilities(["dsh", "opencode", "antigravity"])).toEqual([]);
    expect(integrationTaskCapabilities([])).toEqual([]);
  });
});
