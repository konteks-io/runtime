import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeFailureCapture, jcsDigest, RemoteWorkAssignmentSchema, RemoteWorkspaceBeginRequestSchema, RemoteWorkspaceSealRequestSchema, RuntimeFailureObservationSchema, writeRuntimeFailureCapture, type JsonValue } from "@konteks/remote-common";
import { RunnerConfigSchema } from "@konteks/remote-agent-runner";
import { Supervisor, type SupervisorOptions } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";
import { CoreClient } from "../core/client.js";
import type { ObservationDelivery } from "../control/observation-delivery.js";
import type { RuntimeFailureDelivery } from "../control/runtime-failure-delivery.js";
import { DurableOutbox } from "../state/outbox.js";
import type { StateMutationGate } from "../state/mutation-gate.js";
import type { LeaseRecord } from "../state/store.js";
import { JournalEntrySchema } from "../state/journal.js";
import { LocalAdmissionSchema, type LocalAdmission } from "../state/local-admission.js";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { NativeInputClient } from "../native/input-client.js";
import { NativeWorkspaceCheckpointStore } from "../native/workspace-preservation.js";
import { testGitCommand, testGitTool } from "./native-git-fixture.js";

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
interface WorkCompositionInternals {
  composeWork(native: NonNullable<SupervisorOptions["native"]>, verifier: CoreSignatureVerifier): void;
  work: {
    deps: {
      preserveStoppedWorkspace(admission: LocalAdmission, assertCurrent: () => void): Promise<void>;
    };
  };
  previews: { stop(sessionId: string, reason: string): Promise<void> };
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

async function fixture(options: Eligibility, waitForFlush = true) {
  const supervisor = new Supervisor(
    SupervisorConfigSchema.parse({
      SUPERVISOR_DATA_DIR: dir,
      SUPERVISOR_CORE_URL: "https://core.example",
      SUPERVISOR_ONBOARD_SCRATCH_ROOT: join(dir, "onboard"),
      SUPERVISOR_ONBOARD_GIT_KEY_DIR: join(dir, "git-keys"),
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
  if (waitForFlush) await internal.runtimeFailureDelivery.flush();
  return { supervisor, internal, send };
}

async function retainedLifecycle(failureId = "update-import", workspaceId = "tenant") {
  const body = RuntimeFailureObservationSchema.parse({
    schemaVersion: 1, failureId, observedAt: new Date(now).toISOString(),
    instanceId: "instance", scope: { kind: "runtime" }, phase: "preparation",
    stage: "native_update_stage", code: "native_update_stage_failed", evidence: { kind: "runtime_exception" },
  });
  const capture = createRuntimeFailureCapture(workspaceId, body);
  const path = await writeRuntimeFailureCapture(dir, capture);
  return { path, capture, body, bytes: await readFile(path, "utf8") };
}

async function failureOutbox() {
  const outbox = new DurableOutbox(join(dir, "runtime-failures"));
  await outbox.load();
  return outbox;
}

async function fullFailureOutbox(): Promise<void> {
  await mkdir(join(dir, "runtime-failures"), { recursive: true, mode: 0o700 });
  const outbox = await failureOutbox();
  for (let n = 0; n < 256; n += 1) {
    const failureId = `occupied-${n}`;
    const key = `runtime-failure:${jcsDigest(["instance", failureId])}`;
    const body = RuntimeFailureObservationSchema.parse({
      schemaVersion: 1, failureId, observedAt: new Date(now).toISOString(), instanceId: "instance",
      scope: { kind: "runtime" }, phase: "supervisor", stage: "runtime_start", code: "runtime_failed", evidence: { kind: "runtime_exception" },
    });
    await outbox.enqueue({ id: key, key, channel: "observation", group: key, order: n, createdAt: new Date(now).toISOString(), body });
  }
}

async function suppressedCount(): Promise<number> {
  const bytes = await readFile(join(dir, "runtime-failures", "suppression.json"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return bytes === null ? 0 : JSON.parse(bytes).suppressedCount;
}

function holdNextEnqueue() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = DurableOutbox.prototype.enqueue;
  const enqueue = vi.spyOn(DurableOutbox.prototype, "enqueue").mockImplementationOnce(async function (this: DurableOutbox, item) {
    entered.resolve();
    await release.promise;
    return original.call(this, item);
  });
  return { entered, release, enqueue };
}

async function checkpointComposition(replaceClaim: boolean) {
  const { supervisor, internal } = await fixture({ mode: "active" });
  await mkdir(join(dir, "journal"), { recursive: true, mode: 0o700 });
  await supervisor.journal.load();
  const work = supervisor as unknown as WorkCompositionInternals;
  const root = join(dir, "workspace"); const cwd = join(root, "source");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const tool = await testGitTool();
  await testGitCommand(tool, cwd, ["init", "-q"]);
  await writeFile(join(cwd, "file.txt"), "base");
  await testGitCommand(tool, cwd, ["add", "."]);
  await testGitCommand(tool, cwd, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base"]);
  const baselineCommit = (await testGitCommand(tool, cwd, ["rev-parse", "HEAD"])).trim();
  const assignment = RemoteWorkAssignmentSchema.parse({
    id: "retained-assignment", instanceId: "instance", workspaceId: "tenant", attempt: 1,
    kind: "assistant_execution", placementId: "placement", taskId: "task", correlationId: "correlation",
    expiresAt: new Date(now + 60_000).toISOString(), requiredCapabilities: [],
    agentRoute: { agentId: "codex", requiredRole: "assistant" },
    source: { kind: "conversation", portability: "portable_before_claim", sessionId: "retained-session", turnRef: "turn" },
    policy: { maxDurationSeconds: 600, maxArtifactBytes: 1024, evidenceUpload: "structured_only", allowedArtifactKinds: [],
      recoveryMode: "report_interrupted", latestResumeAt: new Date(now + 60_000).toISOString(), permissionResponderDeadlineSeconds: 30, humanDeferralAllowed: false },
  });
  const entry = JournalEntrySchema.parse({
    assignmentId: assignment.id, attempt: assignment.attempt, claimId: "original-claim", kind: assignment.kind,
    placementId: assignment.placementId, workspaceId: assignment.workspaceId, agentId: "codex", state: "completed",
    recoveryEpoch: 0, reports: { nextSequence: 2, durableWatermark: 1, terminalSequence: 1 }, terminalResultHash: "terminal-result",
    evidenceUpload: "structured_only", expiresAt: assignment.expiresAt, latestResumeAt: assignment.expiresAt,
    updatedAt: new Date(now).toISOString(),
  });
  await supervisor.journal.assignments.put(entry);
  const admission = LocalAdmissionSchema.parse({
    instanceId: assignment.instanceId, workspaceId: assignment.workspaceId, assignmentId: assignment.id, attempt: assignment.attempt,
    claimId: entry.claimId, agentId: entry.agentId, runnerIncarnation: "runner", executionGeneration: "generation", openedAt: new Date(now).toISOString(),
  });
  // The production composition only reads the retained assignment from this lookup.
  vi.spyOn(supervisor.journal.execution, "start").mockReturnValue({ assignment } as ReturnType<typeof supervisor.journal.execution.start>);
  vi.spyOn(work.previews, "stop").mockResolvedValue(undefined);
  const submit = vi.spyOn(internal.runtimeFailureDelivery, "submit").mockResolvedValue(true);
  const failure = new Error("private-checkpoint-seal-response");
  const workspace = vi.spyOn(NativeInputClient.prototype, "workspace").mockImplementation(async (_assignment, operation, raw) => {
    if (operation === "begin") return { checkpointId: RemoteWorkspaceBeginRequestSchema.parse(raw).checkpointId, state: "writing" };
    expect(operation).toBe("seal");
    RemoteWorkspaceSealRequestSchema.parse(raw);
    if (replaceClaim) await supervisor.journal.assignments.put(JournalEntrySchema.parse({ ...entry, claimId: "replacement-claim" }));
    throw failure;
  });
  const api = new NativeInputClient({ baseUrl: "https://core.example", roots: [], clock: supervisor.clock, credential: () => null });
  await new NativeWorkspaceCheckpointStore({ root, client: () => api }).begin({
    assignment, claimId: entry.claimId, selectionDigest: `sha256:${"a".repeat(64)}`, cwd, baselineCommit, tool,
  });
  await writeFile(join(cwd, "file.txt"), "retained unfinished work");
  work.composeWork({ trustedRoots: [], runners: [RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_WORKSPACE_DIR: root })], git: tool }, new CoreSignatureVerifier([]));
  return { work, supervisor, assignment, admission, entry, cwd, submit, failure, workspace };
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

  it.each([false, true])("binds checkpoint diagnostics to the exact retained admission (claim replaced: %s)", async replaceClaim => {
    const f = await checkpointComposition(replaceClaim);
    const current = vi.fn();
    await expect(f.work.work.deps.preserveStoppedWorkspace(f.admission, current)).rejects.toBe(f.failure);
    expect(current).toHaveBeenCalled();
    expect(f.workspace.mock.calls.map(call => call[1])).toEqual(["begin", "seal"]);
    expect(await readFile(join(f.cwd, "file.txt"), "utf8")).toBe("retained unfinished work");
    expect(f.supervisor.journal.assignments.get(`${f.assignment.id}:${f.assignment.attempt}`)).toMatchObject({
      state: "completed", claimId: replaceClaim ? "replacement-claim" : f.entry.claimId,
    });
    expect(f.submit).toHaveBeenCalledTimes(replaceClaim ? 0 : 1);
    if (!replaceClaim) {
      const fact = RuntimeFailureObservationSchema.parse(f.submit.mock.calls[0]![0]);
      expect(fact).toMatchObject({
        instanceId: f.assignment.instanceId,
        scope: { kind: "assignment", assignmentId: f.assignment.id, attempt: f.assignment.attempt, claimId: f.admission.claimId },
        phase: "checkpoint", stage: "workspace_seal", code: "checkpoint_seal_failed", evidence: { kind: "runtime_exception" },
      });
      expect(JSON.stringify(fact)).not.toMatch(/private-checkpoint|"message"|"stack"/);
    }
  });
});

describe("Supervisor lifecycle capture intake", () => {
  it("hands off a private pre-publication capture on restart without a producer retry", async () => {
    const source = await retainedLifecycle("update-before-publication");
    const pending = `${source.path}.pending`;
    await rename(source.path, pending);
    expect((await lstat(pending)).nlink).toBe(1);
    const held = holdNextEnqueue();
    const { internal, send } = await fixture({ mode: "active" }, false);
    const flushing = internal.runtimeFailureDelivery.flush();
    try {
      const phase = await Promise.race([held.entered.promise.then(() => "commit-held"), flushing.then(() => "flight-ended")]);
      expect(phase).toBe("commit-held");
      expect(await readFile(pending, "utf8")).toBe(source.bytes);
      expect((await failureOutbox()).depth).toBe(0);
      expect(send).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      await flushing;
    }
    expect(held.enqueue).toHaveBeenCalledOnce();
    expect(send.mock.calls).toEqual([["instance", source.body]]);
    await expect(lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hands a real producer capture to the owned queue while network authority is unavailable", async () => {
    const source = await retainedLifecycle();
    const { send } = await fixture({ mode: "drain_only", expired: true });
    expect((await failureOutbox()).all().map(item => item.body)).toEqual([source.body]);
    await expect(lstat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(send).not.toHaveBeenCalled();
  });

  it("coalesces intake and keeps its immutable source until the real durable queue commit finishes", async () => {
    const source = await retainedLifecycle();
    const held = holdNextEnqueue();
    const { internal, send } = await fixture({ mode: "active" }, false);
    const flushing = internal.runtimeFailureDelivery.flush();
    expect(internal.runtimeFailureDelivery.flush()).toBe(flushing);
    try {
      const phase = await Promise.race([held.entered.promise.then(() => "commit-held"), flushing.then(() => "flight-ended")]);
      expect(phase).toBe("commit-held");
      expect(await readFile(source.path, "utf8")).toBe(source.bytes);
      expect(send).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      await flushing;
    }
    expect(held.enqueue).toHaveBeenCalledOnce();
    expect(send.mock.calls).toEqual([["instance", source.body]]);
    await expect(lstat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a real source after failed durable admission and retries that same fact", async () => {
    const source = await retainedLifecycle();
    const enqueue = vi.spyOn(DurableOutbox.prototype, "enqueue").mockRejectedValueOnce(new Error("private queue write failed"));
    const { internal, send } = await fixture({ mode: "active" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(await readFile(source.path, "utf8")).toBe(source.bytes);
    expect(send).not.toHaveBeenCalled();
    await internal.runtimeFailureDelivery.flush();
    expect(send.mock.calls).toEqual([["instance", source.body]]);
    await expect(lstat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defers a retained source at full capacity without counting every retry as a lost fact", async () => {
    const source = await retainedLifecycle();
    await fullFailureOutbox();
    const { supervisor, internal, send } = await fixture({ mode: "drain_only", expired: true });
    await internal.runtimeFailureDelivery.flush();
    await internal.runtimeFailureDelivery.flush();
    expect(await readFile(source.path, "utf8")).toBe(source.bytes);
    expect((await failureOutbox()).depth).toBe(256);
    expect(await suppressedCount()).toBe(0);
    supervisor.lease.set({
      lease: "fixture-lease", mode: "active", workspaceId: "tenant",
      issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), drainDeadline: new Date(now + 30_000).toISOString(),
    });
    await internal.runtimeFailureDelivery.flush();
    await internal.runtimeFailureDelivery.flush();
    const custody = [...(await failureOutbox()).all().map(item => item.body), ...send.mock.calls.map(([, body]) => body)];
    expect(custody).toContainEqual(source.body);
    await expect(lstat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await suppressedCount()).toBe(0);
  });

  it("does not retire a replacement file after admission of an earlier immutable source", async () => {
    const source = await retainedLifecycle();
    const held = holdNextEnqueue();
    const { internal, send } = await fixture({ mode: "active" }, false);
    const flushing = internal.runtimeFailureDelivery.flush();
    const changed = createRuntimeFailureCapture("tenant", { ...source.body, code: "different_failure" });
    const replacement = JSON.stringify(changed);
    try {
      const phase = await Promise.race([held.entered.promise.then(() => "commit-held"), flushing.then(() => "flight-ended")]);
      expect(phase).toBe("commit-held");
      await rename(source.path, `${source.path}.kept`);
      await writeFile(source.path, replacement, { mode: 0o600 });
    } finally {
      held.release.resolve();
      await flushing;
    }
    expect(send.mock.calls).toEqual([["instance", source.body]]);
    expect(await readFile(source.path, "utf8")).toBe(replacement);
    expect(await readFile(`${source.path}.kept`, "utf8")).toBe(source.bytes);
  });

  it("leaves the source intact when stop and owner loss interrupt an uncommitted intake", async () => {
    const source = await retainedLifecycle();
    const held = holdNextEnqueue();
    const { internal, send } = await fixture({ mode: "active" }, false);
    const flushing = internal.runtimeFailureDelivery.flush();
    try {
      const phase = await Promise.race([held.entered.promise.then(() => "commit-held"), flushing.then(() => "flight-ended")]);
      expect(phase).toBe("commit-held");
      expect(internal.runtimeFailureDelivery.stop()).toBeUndefined();
      vi.spyOn(internal.nativeOwnership, "assertOwned").mockImplementation(() => { throw new Error("owner lost"); });
    } finally {
      held.release.resolve();
      await flushing;
    }
    internal.runtimeFailureDelivery.start();
    await internal.runtimeFailureDelivery.flush();
    expect(send).not.toHaveBeenCalled();
    expect(await readFile(source.path, "utf8")).toBe(source.bytes);
    expect((await failureOutbox()).depth).toBe(0);
  });

  it("imports the current tenant's fact without retagging a foreign tenant's capture", async () => {
    const owned = await retainedLifecycle("update-owned");
    const foreign = await retainedLifecycle("update-foreign", "other-tenant");
    const { send } = await fixture({ mode: "active" });
    expect(send.mock.calls).toEqual([["instance", owned.body]]);
    expect(await readFile(foreign.path, "utf8")).toBe(foreign.bytes);
    await expect(lstat(owned.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects capture links and nonprivate files while importing a valid owned source", async () => {
    const owned = await retainedLifecycle("update-owned");
    const insecure = await retainedLifecycle("update-nonprivate");
    await chmod(insecure.path, 0o644);
    const linked = join(dirname(owned.path), `${"A".repeat(43)}.json`);
    await symlink(owned.path, linked);
    const { send } = await fixture({ mode: "active" });
    expect(send.mock.calls).toEqual([["instance", owned.body]]);
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readFile(insecure.path, "utf8")).toBe(insecure.bytes);
  });
});
