import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FixedClock,
  RemoteInstanceError,
  RuntimeFailureObservationSchema,
  jcsDigest,
  type JsonValue,
  type RemoteWorkAssignment,
  type RuntimeFailureObservation,
} from "@konteks/remote-common";
import { RuntimeFailureDelivery } from "../control/runtime-failure-delivery.js";
import { SupervisorConfigSchema } from "../config.js";
import { LeaseState } from "../lease/lease.js";
import { createNativeReadyRegistrar } from "../native/execution-ready.js";
import type { RunnerPort } from "../runner-port.js";
import type { RuntimeFailureContext, RuntimeFailureFact } from "../runtime-failure-types.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { PermissionBroker } from "../session/permissions.js";
import { RelayedSession, type RelayedSessionDeps } from "../session/relayed-session.js";
import { DurableOutbox } from "../state/outbox.js";
import { Supervisor } from "../supervisor.js";
import type { OutboundMessage } from "../transport/transport.js";
import type { TransportManager } from "../transport/relay-transport.js";
import { WorkOrchestrator } from "../work/orchestrator.js";

interface FailureOwner {
  instanceId: string;
  workspaceId: string;
  nativeOwnership: { assertOwned(): void } | null;
  runtimeFailureDelivery: RuntimeFailureDelivery;
  recordRuntimeFailure(assignment: RemoteWorkAssignment, fact: RuntimeFailureFact, context: RuntimeFailureContext): Promise<void>;
}

const now = Date.parse("2026-10-19T07:00:00Z");
const privateDetail = "private-d20c-bootstrap https://provider.invalid/private /Users/private/work";
const assignment: RemoteWorkAssignment = {
  id: "asg", kind: "assistant_execution", placementId: "placement", instanceId: "instance", workspaceId: "workspace",
  taskId: "2026-10-19T07:00:00Z", correlationId: "correlation", attempt: 1, expiresAt: "2026-10-20T07:00:00Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "assistant", agentId: "codex", mcpCapabilityTokenRef: "capability-reference" },
  source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: "turn" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [],
    recoveryMode: "report_interrupted", latestResumeAt: "2026-10-20T07:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
};

let dir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "runtime-d20c-bootstrap-")); });
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function retainedFailures(): Promise<RuntimeFailureObservation[]> {
  const outbox = new DurableOutbox(join(dir, "runtime-failures"));
  await outbox.load();
  return outbox.all().map(item => RuntimeFailureObservationSchema.parse(item.body));
}

async function fixture(seedClaim = true) {
  const clock = new FixedClock(now);
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({
    SUPERVISOR_DATA_DIR: dir, SUPERVISOR_CORE_URL: "https://core.example",
    SUPERVISOR_ONBOARD_SCRATCH_ROOT: join(dir, "onboard"), SUPERVISOR_ONBOARD_GIT_KEY_DIR: join(dir, "git-keys"),
  }));
  const owner = supervisor as unknown as FailureOwner;
  Object.assign(owner, { instanceId: assignment.instanceId, workspaceId: assignment.workspaceId, nativeOwnership: { assertOwned: vi.fn() } });
  vi.spyOn(supervisor.clock, "coreNow").mockReturnValue(now);
  await mkdir(join(dir, "journal"), { recursive: true, mode: 0o700 });
  await supervisor.journal.load();
  if (seedClaim) await supervisor.journal.assignments.put({
    assignmentId: assignment.id, attempt: 1, claimId: "claim-one", placementId: assignment.placementId,
    workspaceId: assignment.workspaceId, agentId: "codex", kind: assignment.kind, state: "claimed", recoveryEpoch: 0,
    reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only",
    expiresAt: assignment.expiresAt, latestResumeAt: assignment.policy.latestResumeAt, updatedAt: clock.nowIso(),
  });
  const delivery = new RuntimeFailureDelivery({
    dataDir: dir, core: { submitRuntimeFailure: vi.fn(async () => { throw new Error("offline"); }) },
    instanceId: () => assignment.instanceId, clock, coreContractVersion: () => "7.12", canSend: () => false,
  });
  owner.runtimeFailureDelivery = delivery;
  cleanups.push(async () => { delivery.stop(); await delivery.flush(); });
  const captures: Promise<void>[] = [];
  const reporter = vi.fn((fact: RuntimeFailureFact, context: RuntimeFailureContext) => {
    const capture = owner.recordRuntimeFailure(assignment, fact, context);
    captures.push(capture);
    return capture;
  });
  const sent: OutboundMessage[] = [];
  const transport = { send: (message: OutboundMessage) => void sent.push(message), openChannel: vi.fn(), closeChannel: vi.fn(),
    kind: "relay", available: true } as unknown as TransportManager;
  const runner = {
    createSession: vi.fn(async () => ({ acpSessionRef: "acp", resumed: false, capabilities: { forkSession: false, sessionResume: true } })),
    cancel: vi.fn(async () => undefined), closeSession: vi.fn(async () => undefined), prompt: vi.fn(async () => undefined),
  } as unknown as RunnerPort;
  const ready = vi.fn<RelayedSessionDeps["registerReady"]>(async (target, binding, acpSessionRef) => ({
    workspaceId: target.workspaceId, instanceId: target.instanceId, sessionId: binding.sessionId, channelId: `session:${binding.sessionId}`,
    assignmentId: target.id, attempt: target.attempt, claimId: "claim-one", recoveryEpoch: 0, runnerIncarnation: "runner",
    agentId: target.agentRoute.agentId, acpSessionRef, readyRevision: 1, registeredAt: clock.nowIso(),
  }));
  const deps: Omit<RelayedSessionDeps, "onUsage" | "onClosed"> = {
    clock, journal: supervisor.journal, transport, runner,
    policy: new EvaluatorPolicyResponder(null, () => true),
    broker: new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined }),
    instanceId: assignment.instanceId, workspaceRoot: dir,
    redeemCapabilityToken: async () => ({ mcpServer: { name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }, expiresAt: assignment.expiresAt }),
    prepareInputs: async target => ({ binding: { workspaceId: target.workspaceId, sessionId: "session", assignmentId: target.id,
      instanceId: target.instanceId, attempt: target.attempt }, cwd: dir, skillInstructions: "", beforePrompt: async () => undefined }),
    registerReady: ready, onRuntimeFailure: reporter,
  };
  const onUsage = vi.fn(async () => undefined);
  function session(overrides: Partial<RelayedSessionDeps> = {}) {
    const created = new RelayedSession(assignment, { ...deps, onUsage, onClosed: async () => undefined, ...overrides });
    cleanups.push(() => created.disposeFailedBootstrap());
    return created;
  }
  return { clock, supervisor, owner, reporter, captures, sent, transport, runner, ready, deps, onUsage, session };
}

function assertSafeFact(failure: RuntimeFailureObservation, stage: string, code: string) {
  expect(failure).toMatchObject({ schemaVersion: 1, instanceId: assignment.instanceId,
    scope: { kind: "assignment", assignmentId: assignment.id, attempt: 1, claimId: "claim-one" },
    phase: "launch", stage, code, evidence: { kind: "runtime_exception" } });
  expect(JSON.stringify(failure)).not.toMatch(/private-d20c|provider\.invalid|Users|"message"|"stack"|"cause"|"errorName"|"rpcCode"/);
}

describe("D20c claim-bound bootstrap failure history", () => {
  it.each(["acp_session_bootstrap", "readiness"] as const)("retains one safe %s failure without replacing its original error", async stage => {
    const f = await fixture();
    const original = new RemoteInstanceError("agent_unavailable", privateDetail, { retryable: true });
    if (stage === "acp_session_bootstrap") vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    else f.ready.mockRejectedValueOnce(original);
    const session = f.session();
    const cleanup = vi.spyOn(session as unknown as { closeMcpFacade(): Promise<void> }, "closeMcpFacade");
    await expect(session.bootstrap()).rejects.toBe(original);
    await Promise.all(f.captures);
    const failures = await retainedFailures();
    expect(failures).toHaveLength(1);
    assertSafeFact(failures[0], stage, "agent_unavailable");
    expect(failures[0].retryable).toBe(true);
    expect(f.reporter).toHaveBeenCalledOnce();
    expect(f.reporter.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]);
    expect(f.onUsage).not.toHaveBeenCalled();
    expect(f.sent.filter(message => "reportId" in (message.body as object))).toEqual([]);
  });

  it.each(["acp_session_bootstrap", "readiness"] as const)(
    "retains a static refusal within its original %s stage",
    async (stage) => {
      const f = await fixture();
      const original = new RemoteInstanceError("recovery_required", privateDetail, {
        diagnostic: "local_execution_unprovable",
      });
      if (stage === "acp_session_bootstrap")
        vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
      else f.ready.mockRejectedValueOnce(original);
      await expect(f.session().bootstrap()).rejects.toBe(original);
      await Promise.all(f.captures);
      const failures = await retainedFailures();
      expect(failures).toHaveLength(1);
      assertSafeFact(failures[0], `${stage}_local_execution_unprovable`, "recovery_required");
      expect(failures[0].retryable).toBe(false);
      expect(f.reporter).toHaveBeenCalledOnce();
      expect(f.onUsage).not.toHaveBeenCalled();
    },
  );

  it("retains the actual legacy Codex refusal beneath the fallback bootstrap parent", async () => {
    const f = await fixture();
    const inspect = vi.fn(async () => false);
    const session = f.session({
      continueReference: "legacy-reference",
      assertLegacyCodexThreadUnloaded: inspect,
    });
    await expect(session.bootstrap()).rejects.toMatchObject({
      code: "recovery_required",
      diagnostic: "legacy_mcp_thread_loaded_or_unverified",
    });
    await Promise.all(f.captures);
    const failures = await retainedFailures();
    expect(failures).toHaveLength(1);
    assertSafeFact(
      failures[0],
      "session_bootstrap_legacy_mcp_thread_loaded_or_unverified",
      "recovery_required",
    );
    expect(inspect).toHaveBeenCalledExactlyOnceWith("legacy-reference");
    expect(f.runner.createSession).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.reporter).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "an identifier-shaped private value", diagnostic: "private_token_canary" },
    { label: "private exception detail", diagnostic: privateDetail },
    { label: "an oversized identifier", diagnostic: "x".repeat(128) },
  ])("keeps $label out of durable history", async ({ diagnostic }) => {
    const f = await fixture();
    const original = new RemoteInstanceError("recovery_required", privateDetail, { diagnostic });
    vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    await expect(f.session().bootstrap()).rejects.toBe(original);
    await Promise.all(f.captures);
    const failures = await retainedFailures();
    expect(failures).toHaveLength(1);
    assertSafeFact(failures[0], "acp_session_bootstrap", "recovery_required");
    expect(failures[0].evidence).toEqual({ kind: "runtime_exception" });
    expect(JSON.stringify(failures)).not.toContain(diagnostic);
  });

  it("does not trust an arbitrary error carrying a known diagnostic spelling", async () => {
    const f = await fixture();
    const original = Object.assign(new Error(privateDetail), {
      diagnostic: "local_execution_unprovable",
    });
    vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    await expect(f.session().bootstrap()).rejects.toBe(original);
    await Promise.all(f.captures);
    const failures = await retainedFailures();
    expect(failures).toHaveLength(1);
    assertSafeFact(failures[0], "acp_session_bootstrap", "session_bootstrap_failed");
    expect(JSON.stringify(failures)).not.toContain("local_execution_unprovable");
  });

  it("does not infer a provider code or copy fields from an arbitrary thrown error", async () => {
    const f = await fixture();
    const original = Object.assign(new Error(privateDetail), { name: "private-d20c-name", code: -32603, cause: { args: privateDetail } });
    vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    await expect(f.session().bootstrap()).rejects.toBe(original);
    await Promise.all(f.captures);
    const failures = await retainedFailures();
    expect(failures).toHaveLength(1);
    assertSafeFact(failures[0], "acp_session_bootstrap", "session_bootstrap_failed");
    expect(failures[0].evidence).toEqual({ kind: "runtime_exception" });
  });

  it.each(["throws", "rejects", "never_settles"] as const)("keeps bootstrap and cleanup independent when its reporter %s", async mode => {
    const f = await fixture();
    const original = new Error(privateDetail);
    vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    const reporter = vi.fn(() => {
      if (mode === "throws") throw new Error(privateDetail);
      if (mode === "rejects") return Promise.reject(new Error(privateDetail));
      return new Promise<void>(() => undefined);
    });
    const session = f.session({ onRuntimeFailure: reporter });
    await expect(session.bootstrap()).rejects.toBe(original);
    await expect(session.disposeFailedBootstrap()).resolves.toBeUndefined();
    expect(reporter).toHaveBeenCalledOnce();
    expect(f.onUsage).not.toHaveBeenCalled();
  });

  it("does not retain transient preparation failures after the same bootstrap succeeds", async () => {
    const f = await fixture();
    const prepareInputs = vi.fn(f.deps.prepareInputs).mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", privateDetail,
      { retryable: true, diagnostic: "response_transient_503" }));
    const session = f.session({ prepareInputs, inputDeferralRandom: () => 0.5 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const booting = session.bootstrap();
    void booting.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
    } finally { vi.useRealTimers(); }
    await expect(booting).resolves.toMatchObject({ acpSessionRef: "acp" });
    await Promise.all(f.captures);
    expect(prepareInputs).toHaveBeenCalledTimes(2);
    expect(f.reporter).not.toHaveBeenCalled();
    expect(await retainedFailures()).toEqual([]);
  });

  it("does not attribute a later readiness refusal to an already recovered input failure", async () => {
    const f = await fixture();
    const prepareInputs = vi.fn(f.deps.prepareInputs).mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", privateDetail,
      { retryable: true, diagnostic: "response_transient_503" }));
    const normalReady = f.ready.getMockImplementation()!;
    f.ready.mockImplementationOnce(async (...args) => ({ ...await normalReady(...args), assignmentId: "another-assignment" }));
    const session = f.session({ prepareInputs, inputDeferralRandom: () => 0.5 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const booting = session.bootstrap();
    void booting.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
    } finally { vi.useRealTimers(); }
    await expect(booting).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    await Promise.all(f.captures);
    const failures = await retainedFailures();
    expect(failures).toHaveLength(1);
    assertSafeFact(failures[0], "session_bootstrap", "workspace_binding_invalid");
    expect(f.reporter).toHaveBeenCalledOnce();
    expect(prepareInputs).toHaveBeenCalledTimes(2);
  });

  it("does not turn a missing retained runtime owner into a diagnostic authority", async () => {
    const f = await fixture();
    f.owner.nativeOwnership = null;
    const original = new Error(privateDetail);
    vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    await expect(f.session().bootstrap()).rejects.toBe(original);
    await Promise.all(f.captures);
    expect(await retainedFailures()).toEqual([]);
  });

  it("replays the same durable refusal substage after an offline send without creating another observation", async () => {
    const f = await fixture();
    const original = new RemoteInstanceError("recovery_required", privateDetail, {
      diagnostic: "local_execution_unprovable",
    });
    vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
    await expect(f.session().bootstrap()).rejects.toBe(original);
    await Promise.all(f.captures);
    const captured = await retainedFailures();
    expect(captured).toHaveLength(1);
    assertSafeFact(
      captured[0],
      "acp_session_bootstrap_local_execution_unprovable",
      "recovery_required",
    );
    const sent: RuntimeFailureObservation[] = [];
    const send = vi.fn(async (_instanceId: string, body: unknown) => {
      const observation = RuntimeFailureObservationSchema.parse(body);
      sent.push(observation);
      if (sent.length === 1) throw new Error(privateDetail);
      return {
        schemaVersion: 1 as const,
        instanceId: observation.instanceId,
        failureId: observation.failureId,
        failureDigest: jcsDigest(observation as unknown as JsonValue),
        status: "duplicate" as const,
      };
    });
    const makeDelivery = () =>
      new RuntimeFailureDelivery({
        dataDir: dir,
        core: { submitRuntimeFailure: send },
        instanceId: () => assignment.instanceId,
        clock: f.clock,
        coreContractVersion: () => "7.12",
        canSend: () => true,
      });
    const first = makeDelivery();
    await first.flush();
    first.stop();
    expect(await retainedFailures()).toEqual(captured);
    f.clock.advance(60_000);
    const restarted = makeDelivery();
    await restarted.flush();
    restarted.stop();
    expect(sent).toEqual([captured[0], captured[0]]);
    expect(await retainedFailures()).toEqual([]);
    expect(f.reporter).toHaveBeenCalledOnce();
  });

  it.each([
    { diagnostic: undefined, reason: "not_resumable", stage: "acp_session_bootstrap" },
    {
      diagnostic: "local_execution_unprovable",
      reason: "not_resumable",
      stage: "acp_session_bootstrap_local_execution_unprovable",
    },
    {
      diagnostic: "agent_session_lost",
      reason: "agent_session_lost",
      stage: "acp_session_bootstrap_agent_session_lost",
    },
  ] as const)(
    "keeps the ordinary $reason result for $diagnostic while retaining exactly one bootstrap fact",
    async ({ diagnostic, reason, stage }) => {
      const f = await fixture(false);
      const original = new RemoteInstanceError(
        "recovery_required",
        privateDetail,
        diagnostic === undefined ? {} : { diagnostic },
      );
      vi.mocked(f.runner.createSession).mockRejectedValueOnce(original);
      const lease = new LeaseState(f.clock);
      lease.set({
        lease: "fixture-lease",
        mode: "active",
        workspaceId: assignment.workspaceId,
        issuedAt: f.clock.nowIso(),
        expiresAt: assignment.expiresAt,
        drainDeadline: null,
      });
      const outbox = new DurableOutbox(dir);
      await outbox.load();
      const work = new WorkOrchestrator({
        clock: f.clock,
        journal: f.supervisor.journal,
        outbox,
        transport: f.transport,
        lease,
        instanceId: () => assignment.instanceId,
        runnerIncarnation: () => "runner",
        assertOwned: () => undefined,
        workspaceId: () => assignment.workspaceId,
        agents: () => [
          {
            agentId: "codex",
            displayName: "Codex",
            connectionState: "ready",
            authMode: "agent_local_subscription",
            accountScope: "personal",
            readiness: "ready",
            tokenUsageObservable: true,
            acpCapabilities: {
              sessionResume: true,
              forkSession: false,
              structuredOutputShim: true,
              toolControl: "approve",
            },
          },
        ],
        roleBindings: () => [{ role: "assistant", agentPreference: ["codex"] }],
        advertisedRoles: () => ["assistant"],
        acceptedKinds: () => ["assistant_execution"],
        instanceEvidencePolicy: () => "structured_only",
        draining: () => false,
        reconciliationComplete: () => true,
        recoveryAuthority: () => "accepted-recovery",
        reportDeliveryAllowed: () => true,
        headroom: () => 2,
        maxPullItems: 1,
        runners: new Map([["codex", f.runner]]),
        onUsage: f.onUsage,
        sessionDeps: (target, runner) => ({
          ...f.deps,
          runner,
          registerReady: createNativeReadyRegistrar({
            clock: f.clock,
            journal: f.supervisor.journal,
            instanceId: target.instanceId,
            workspaceId: target.workspaceId,
            runnerIncarnation: "runner",
            assertActive: () => undefined,
            client: {
              registerExecutionReady: async (_instanceId, request) => ({
                ...request,
                workspaceId: target.workspaceId,
                instanceId: target.instanceId,
                sessionId: "session",
                channelId: "session:session",
                readyRevision: 1,
                registeredAt: f.clock.nowIso(),
              }),
            },
          }),
        }),
      });
      cleanups.push(() => work.drainSessions("drain"));
      await work.onAssignmentMessage({ assignments: [assignment] });
      const claim = f.supervisor.journal.assignments.get("asg:1")!;
      expect(claim).toMatchObject({ assignmentId: "asg", state: "claimed" });
      await work.onAssignmentMessage({
        assignmentId: "asg",
        attempt: 1,
        claimId: claim.claimId,
        outcome: "claimed",
      });
      const state = work as unknown as { bootstrapping: Map<string, Promise<void>> };
      await vi.waitFor(() => expect(state.bootstrapping.has("asg:1")).toBe(false));
      await Promise.all(f.captures);
      const reports = f.sent
        .map((message) => message.body)
        .filter((body) => "reportId" in (body as object));
      expect(reports).toEqual([
        expect.objectContaining({
          assignmentId: "asg",
          claimId: claim.claimId,
          result: expect.objectContaining({ class: "interrupted", reason }),
        }),
      ]);
      const failures = await retainedFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0].scope).toEqual({
        kind: "assignment",
        assignmentId: "asg",
        attempt: 1,
        claimId: claim.claimId,
      });
      expect(failures[0]).toMatchObject({ stage, code: "recovery_required" });
      expect(f.reporter).toHaveBeenCalledOnce();
      expect(f.onUsage).not.toHaveBeenCalled();
      expect(JSON.stringify(reports)).not.toContain("private-d20c");
    },
  );
});
