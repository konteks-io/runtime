import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, computeRemoteReconciliationReceiptSnapshotDigest, type AssignmentReport } from "@konteks/remote-common";
import { Reconciliation } from "../reconnect/reconciliation.js";
import { SupervisorJournal, type JournalEntry } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { ReportSender } from "../work/report-sender.js";
import type { CoreClient } from "../core/client.js";
import type { TransportManager } from "../transport/relay-transport.js";
import type { OutboundMessage } from "../transport/transport.js";

let testDir = "";
beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kr-recon-"));
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const entry = (overrides: Partial<JournalEntry>): JournalEntry => ({
  assignmentId: "a",
  attempt: 1,
  claimId: "c",
  kind: "delivery",
  placementId: "p",
  workspaceId: "w",
  agentId: "codex",
  state: "running",
  recoveryEpoch: 1,
  reports: { nextSequence: 1, durableWatermark: 0 },
  evidenceUpload: "structured_only",
  expiresAt: "2026-09-07T00:00:00Z",
  latestResumeAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
  ...overrides,
});

type Intent = { instanceId: string; runnerIncarnation: string; reconnectIntentId: string; lastHeartbeatSequence: number };

let harnessCount = 0;
async function harness(entries: JournalEntry[]) {
  // Each harness owns its journal: two in one test must not share decisions.
  const dir = await mkdtemp(join(testDir, `h${(harnessCount += 1)}-`));
  const journal = new SupervisorJournal(dir);
  await journal.load();
  for (const item of entries) await journal.assignments.put(item);
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const sent: OutboundMessage[] = [];
  const transport = { send: (message: OutboundMessage) => void sent.push(message), openChannel: () => undefined, closeChannel: () => undefined } as unknown as TransportManager;
  const reports = new ReportSender({ journal, outbox, transport, clock, canSend: () => true, instanceId: () => "inst-1", onConflict: async () => undefined, onTerminalDurable: async () => undefined });
  // Resolves when the exact local work can no longer execute; a test may hold it.
  const local = { stop: async (): Promise<void> => undefined };
  const leases: string[] = [];
  const core = {
    resolveRuntimeOwner: async () => ({ instanceId: "inst", ownerRevision: 0, currentIncarnation: null, acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 0 }),
    applyReconciliation: vi.fn(async (receipt: Record<string, unknown>) => {
      const { connection: _connection, proof: _proof, ...snapshot } = receipt;
      return {
        instanceId: snapshot.instanceId, runnerIncarnation: snapshot.runnerIncarnation, manifestId: snapshot.manifestId,
        receiptDigest: computeRemoteReconciliationReceiptSnapshotDigest(snapshot),
        acceptedAt: "2026-09-06T00:00:10Z", outcome: "accepted" as const,
      };
    }),
    reconnect: vi.fn(async (request: Intent) => ({ lease: "lease-2", leaseExpiresAt: "2026-09-06T01:00:00Z", manifest: manifest(request, { manifestId: "m1", lease: "lease-2" }) })),
  } as unknown as CoreClient;
  const reconciliation = new Reconciliation({ clock, journal, core, instanceId: () => "inst", runnerIncarnation: () => "process", assertOwned: () => undefined, reserveHeartbeatFloor: async () => undefined, stopLocalWork: () => local.stop(), bundleVersion: "1.0.0", protocolVersion: "1.0", lastHeartbeatSequence: async () => 5, reports, onLease: async (lease) => void leases.push(lease) });
  /** A complete manifest for the generation `run()` would sign. */
  function manifest(intent: Intent, patch: Record<string, unknown>) {
    return {
      instanceId: intent.instanceId, runnerIncarnation: intent.runnerIncarnation, reconnectIntentId: intent.reconnectIntentId,
      ownerRevision: 1, lease: "l", issuedAt: "2026-09-06T00:00:00Z", applyDeadlineAt: "2026-09-06T01:00:00Z",
      acceptedHeartbeatSequence: intent.lastHeartbeatSequence, heartbeatSequenceFloor: intent.lastHeartbeatSequence,
      decisions: [], pendingClaimDecisions: [], ...patch,
    };
  }
  /**
   * A manifest reaches the decision engine only through the bound recovery
   * generation Core issued it for; each distinct manifest supersedes the last.
   */
  async function bound(patch: Record<string, unknown>) {
    const previous = journal.recovery.current("inst", "process");
    if (previous && (previous.state === "pending" || previous.state === "applied")) {
      if (previous.manifest?.manifestId === patch.manifestId) return manifest(previous.intent, patch);
      await journal.recovery.terminate(previous.intent, "superseded");
    }
    const intent: Intent = {
      instanceId: "inst", runnerIncarnation: "process", reconnectIntentId: `intent-${String(patch.manifestId)}`,
      establishment: { expectedOwnerRevision: 0, expectedCurrentIncarnation: null }, lastHeartbeatSequence: 5,
      bundleVersion: "1.0.0", protocolVersion: "1.0", claims: [], pendingClaims: [],
    };
    await journal.recovery.prepareIntent(intent);
    const built = manifest(intent, patch);
    await journal.recovery.bindManifest(intent, built);
    return built;
  }
  /** A generation this process never bound; identity alone must refuse it. */
  const unbound = (instanceId: string, patch: Record<string, unknown>) =>
    manifest({ instanceId, runnerIncarnation: "process", reconnectIntentId: "unbound", lastHeartbeatSequence: 5 }, patch);
  return { reconciliation, journal, sent, leases, core, local, dir, reports, outbox, manifest, bound, unbound };
}

const terminalReports = (sent: OutboundMessage[]) => sent.map((message) => message.body as AssignmentReport).filter((body) => "reportId" in body && body.terminal);

describe("reconnect and reconciliation", () => {
  it("builds a signed-snapshot request from journal facts only (no checkpoint content)", async () => {
    const { reconciliation } = await harness([entry({ state: "checkpointed", checkpoint: { ref: "ckpt", hash: "h".repeat(43), createdAt: "2026-09-06T00:00:00Z" }, acpSessionRef: "acp" })]);
    const request = await reconciliation.buildRequest();
    expect(request).toMatchObject({ instanceId: "inst", lastHeartbeatSequence: 5, claims: [{ assignmentId: "a", attempt: 1, claimId: "c", state: "checkpointed", recoveryEpoch: 1, acpSessionRef: "acp", checkpoint: { ref: "ckpt", hash: "h".repeat(43) } }] });
    expect(JSON.stringify(request)).not.toMatch(/content|path/);
  });

  it("gates on completion: not complete until the manifest is applied, then stores the renewed lease", async () => {
    const { reconciliation, leases } = await harness([]);
    expect(reconciliation.isComplete).toBe(false);
    await reconciliation.run();
    expect(reconciliation.isComplete).toBe(true);
    expect(leases).toEqual(["lease-2"]);
  });

  it("never resumes from a checkpoint: a native connector reports the attempt interrupted and journals the decision", async () => {
    const { reconciliation, journal, sent, bound } = await harness([entry({ state: "checkpointed", checkpoint: { ref: "ckpt", hash: "h".repeat(43), createdAt: "2026-09-06T00:00:00Z" } })]);
    const outcomes = await reconciliation.apply((await bound({ manifestId: "m", decisions: [{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "auth", latestResumeAt: "2026-09-07T00:00:00Z" }] })));
    expect(outcomes.get("a:1")).toBe("interrupted");
    expect(journal.decisions.get("m:a:1")?.executedAt).not.toBeNull();
    expect(terminalReports(sent)[0]?.result).toMatchObject({ class: "interrupted", reason: "agent_session_lost" });
  });

  it("rejects a stale recovery epoch, a wrong attempt, an unknown assignment, and a foreign instance", async () => {
    const { reconciliation, sent, bound, unbound } = await harness([entry({ state: "checkpointed", checkpoint: { ref: "ckpt", hash: "h".repeat(43), createdAt: "2026-09-06T00:00:00Z" }, recoveryEpoch: 3 })]);
    const stale = await reconciliation.apply((await bound({ manifestId: "m", decisions: [{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 3, authorization: "x", latestResumeAt: "2026-09-07T00:00:00Z" }] })));
    expect(stale.get("a:1")).toBe("rejected_stale_epoch");
    expect(reconciliation.isComplete).toBe(false);
    const wrongAttempt = await reconciliation.apply((await bound({ manifestId: "m2", decisions: [{ action: "replay_terminal", assignmentId: "a", attempt: 2, recoveryEpoch: 4, authorization: "x" }] })));
    expect(wrongAttempt.get("a:2")).toBe("rejected_unknown_assignment");
    expect(reconciliation.isComplete).toBe(false);
    // A foreign instance never reaches the decision engine: the manifest is not
    // this process's bound recovery generation.
    await expect(reconciliation.apply(unbound("other", { manifestId: "m3", decisions: [{ action: "cancel", assignmentId: "a", attempt: 1, reason: "revoked" }] })))
      .rejects.toMatchObject({ code: "registration_mismatch" });
    expect(terminalReports(sent)).toHaveLength(0);
  });

  it("invalid and foreign empty manifests close a previously completed local gate", async () => {
    const { reconciliation, unbound } = await harness([]);
    await reconciliation.run();
    expect(reconciliation.isComplete).toBe(true);
    await expect(reconciliation.apply(unbound("foreign", { manifestId: "foreign", decisions: [] }))).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(reconciliation.isComplete).toBe(false);
    await reconciliation.run();
    await expect(reconciliation.apply({ invalid: true })).rejects.toThrow();
    expect(reconciliation.isComplete).toBe(false);
  });

  it("run does not overwrite rejected decisions with completion", async () => {
    const { reconciliation, core, manifest } = await harness([]);
    vi.mocked(core.reconnect).mockImplementation(async request => ({ lease: "lease-2", leaseExpiresAt: "2026-09-06T01:00:00Z", manifest: manifest(request as never, { manifestId: "m", lease: "lease-2", decisions: [{ action: "replay_terminal", assignmentId: "unknown", attempt: 1, recoveryEpoch: 2, authorization: "x" }] }) as never }));
    await expect(reconciliation.run()).rejects.toMatchObject({ code: "recovery_required" });
    expect(reconciliation.isComplete).toBe(false);
  });

  it("a repeated executed decision is a duplicate only for the identical durable decision", async () => {
    const { reconciliation, sent, bound } = await harness([entry({})]);
    const decision = { action: "cancel", assignmentId: "a", attempt: 1, reason: "revoked" };
    const applied = (await bound({ manifestId: "m", decisions: [decision] }));
    expect((await reconciliation.apply(applied)).get("a:1")).toBe("executed");
    expect((await reconciliation.apply(applied)).get("a:1")).toBe("duplicate");
    expect(reconciliation.isComplete).toBe(true);
    // Changed content under the same manifest ID is no longer the generation
    // this process bound; it is refused before any local effect.
    await expect(reconciliation.apply({ ...applied, decisions: [{ ...decision, reason: "policy_denied" }] })).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(reconciliation.isComplete).toBe(false);
    expect(terminalReports(sent)).toHaveLength(1);
  });

  it("an older in-flight apply cannot reopen the gate after a newer rejection", async () => {
    const f = await harness([entry({})]);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.local.stop = async () => { entered(); await waiting; };
    const pending = f.reconciliation.apply((await f.bound({ manifestId: "m", decisions: [{ action: "cancel", assignmentId: "a", attempt: 1, reason: "revoked" }] })));
    const settled = pending.then(() => undefined, () => undefined);
    await started;
    await expect(f.reconciliation.apply(f.unbound("foreign", { manifestId: "other", decisions: [] }))).rejects.toMatchObject({ code: "registration_mismatch" });
    release();
    await settled;
    expect(f.reconciliation.isComplete).toBe(false);
  });

  it("duplicate decision identities fail before any local action", async () => {
    const f = await harness([entry({})]);
    const decision = { action: "cancel", assignmentId: "a", attempt: 1, reason: "revoked" };
    // Repeated ordinary identities are rejected by the shared manifest schema,
    // so the pair can never be bound or applied.
    await expect(f.bound({ manifestId: "m", decisions: [decision, decision] })).rejects.toThrow();
    await expect(f.reconciliation.apply(f.unbound("inst", { manifestId: "m", decisions: [decision, decision] }))).rejects.toThrow();
    expect(f.reconciliation.isComplete).toBe(false);
    expect(f.sent).toHaveLength(0);
    expect(f.journal.decisions.all()).toHaveLength(0);
  });

  it("old journal records without a decision digest are not proof of exact replay", async () => {
    const f = await harness([entry({})]);
    await f.journal.decisions.put({ manifestId: "m", assignmentId: "a", attempt: 1, action: "cancel", recoveryEpoch: 1, journaledAt: "2026-09-06T00:00:00Z", executedAt: "2026-09-06T00:00:01Z" });
    await expect(f.reconciliation.apply((await f.bound({ manifestId: "m", decisions: [] })))).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.reconciliation.isComplete).toBe(false);
    expect(f.sent).toHaveLength(0);
  });

  it("an identical decision from an older recovery epoch cannot reopen completion", async () => {
    const f = await harness([entry({})]);
    const manifest = (await f.bound({ manifestId: "m", decisions: [{ action: "replay_terminal", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "x" }] }));
    await f.reconciliation.apply(manifest);
    await f.journal.assignments.put({ ...f.journal.assignments.get("a:1")!, recoveryEpoch: 3 });
    expect((await f.reconciliation.apply(manifest)).get("a:1")).toBe("rejected_stale_epoch");
    expect(f.reconciliation.isComplete).toBe(false);
  });

  it("a durable manifest digest refuses an omitted rejected decision after reload", async () => {
    const f = await harness([]);
    const manifest = (await f.bound({ manifestId: "m", decisions: [{ action: "cancel", assignmentId: "unknown", attempt: 1, reason: "revoked" }] }));
    await f.reconciliation.apply(manifest);
    const restored = new SupervisorJournal(f.dir);
    await restored.load();
    // Use the reloaded table to prove the guard is not a process-local cache.
    Object.assign(f.journal, { manifests: restored.manifests });
    await expect(f.reconciliation.apply({ ...manifest, lease: "renewed-lease", decisions: [] })).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.reconciliation.isComplete).toBe(false);
  });

  it("manifest history preserves first-seen order across compaction and restart", async () => {
    const f = await harness([]);
    const older = (await f.bound({ manifestId: "older", decisions: [] }));
    await f.reconciliation.apply(older);
    const newer = (await f.bound({ manifestId: "newer", decisions: [] }));
    await f.reconciliation.apply(newer);
    await f.journal.manifests.compact();
    const restored = new SupervisorJournal(f.dir);
    await restored.load();
    Object.assign(f.journal, { manifests: restored.manifests });
    // Replay cannot make a superseded generation current again.
    await expect(f.reconciliation.apply(older)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.reconciliation.isComplete).toBe(false);
    await f.reconciliation.apply({ ...newer, lease: "renewed" });
    expect(f.reconciliation.isComplete).toBe(true);
  });

  it("a refused resume is a locally applied interruption only after its report is durable", async () => {
    const f = await harness([entry({})]);
    const outcomes = await f.reconciliation.apply((await f.bound({ manifestId: "m", decisions: [{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "x", latestResumeAt: "2026-09-07T00:00:00Z" }] })));
    expect(outcomes.get("a:1")).toBe("interrupted");
    expect(f.reconciliation.isComplete).toBe(true);
    const restored = new DurableOutbox(f.dir);
    await restored.load();
    expect(restored.heads("assignment")).toHaveLength(1);
    expect(restored.heads("assignment")[0]?.body).toMatchObject({ terminal: true, result: { class: "interrupted", reason: "checkpoint_invalid" } });
  });

  it.each(["cancel", "report_interrupted", "replay_terminal"])("a terminal pointer without durable report evidence cannot complete %s", async action => {
    const f = await harness([entry({ state: "terminal_pending_report", reports: { nextSequence: 2, durableWatermark: 0, terminalSequence: 1 } })]);
    const decision = { action, assignmentId: "a", attempt: 1, ...(action === "replay_terminal" ? { recoveryEpoch: 2, authorization: "x" } : { reason: action === "cancel" ? "revoked" : "agent_session_lost" }) };
    const manifest = (await f.bound({ manifestId: "m", decisions: [decision] }));
    expect((await f.reconciliation.apply(manifest)).get("a:1")).toBe("rejected_report_missing");
    expect(f.reconciliation.isComplete).toBe(false);
    expect(f.journal.decisions.get("m:a:1")?.executedAt ?? null).toBeNull();
    expect((await f.reconciliation.apply(manifest)).get("a:1")).toBe("rejected_report_missing");
    expect(f.reconciliation.isComplete).toBe(false);
  });

  it("a frozen receipt keeps its accepted disposition when the outbox is cleared afterwards", async () => {
    const f = await harness([entry({})]);
    const manifest = (await f.bound({ manifestId: "m", decisions: [{ action: "cancel", assignmentId: "a", attempt: 1, reason: "revoked" }] }));
    await f.reconciliation.apply(manifest);
    const frozen = f.journal.recovery.current("inst", "process")?.receipt;
    expect(frozen?.snapshot.decisionResults).toHaveLength(1);
    await f.outbox.clear();
    // The receipt is the durable evidence: re-deriving it from a cleared outbox
    // would rewrite bytes Core has already been asked to accept.
    expect((await f.reconciliation.apply(manifest)).get("a:1")).toBe("duplicate");
    expect(f.journal.recovery.current("inst", "process")?.receipt?.digest).toBe(frozen?.digest);
  });

  it("a resume without a proven checkpoint or past its deadline becomes an interrupted terminal report, never execution", async () => {
    const invalid = await harness([entry({})]);
    await invalid.reconciliation.apply((await invalid.bound({ manifestId: "m", decisions: [{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "x", latestResumeAt: "2026-09-07T00:00:00Z" }] })));
    expect(terminalReports(invalid.sent)[0]?.result).toMatchObject({ class: "interrupted", reason: "checkpoint_invalid" });
    const expired = await harness([entry({ state: "checkpointed", checkpoint: { ref: "ckpt", hash: "h".repeat(43), createdAt: "2026-09-06T00:00:00Z" } })]);
    await expired.reconciliation.apply((await expired.bound({ manifestId: "m", decisions: [{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "x", latestResumeAt: "2026-09-05T00:00:00Z" }] })));
    expect(terminalReports(expired.sent)[0]?.result).toMatchObject({ class: "interrupted", reason: "deadline_expired" });
  });

  it("an ACP session without a proven checkpoint is agent_session_lost", async () => {
    const { reconciliation, sent, bound } = await harness([entry({ kind: "assistant_execution", acpSessionRef: "acp" })]);
    await reconciliation.apply((await bound({ manifestId: "m", decisions: [{ action: "resume_from_checkpoint", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "x", latestResumeAt: "2026-09-07T00:00:00Z" }] })));
    expect(terminalReports(sent)[0]?.result).toMatchObject({ class: "interrupted", reason: "agent_session_lost" });
  });

  it("cancel decisions produce a cancelled terminal report and duplicates converge", async () => {
    const { reconciliation, sent, bound } = await harness([entry({})]);
    const manifest = (await bound({ manifestId: "m", decisions: [{ action: "cancel", assignmentId: "a", attempt: 1, reason: "revoked" }] }));
    expect((await reconciliation.apply(manifest)).get("a:1")).toBe("executed");
    expect((await reconciliation.apply(manifest)).get("a:1")).toBe("duplicate");
    expect(terminalReports(sent)).toHaveLength(1);
    expect(terminalReports(sent)[0]?.result).toMatchObject({ class: "cancelled", reason: "revoked" });
  });

  it("replay_terminal resends the outbox without rerunning execution", async () => {
    const { reconciliation, local, reports, bound } = await harness([entry({})]);
    await reports.submit({ assignmentId: "a", attempt: 1, claimId: "c", draft: { terminal: true, result: { class: "interrupted", reason: "agent_session_lost", terminalResultHash: "h".repeat(43) } } });
    const stop = vi.spyOn(local, "stop");
    expect((await reconciliation.apply((await bound({ manifestId: "m", decisions: [{ action: "replay_terminal", assignmentId: "a", attempt: 1, recoveryEpoch: 2, authorization: "x" }] })))).get("a:1")).toBe("executed");
    expect(stop).not.toHaveBeenCalled();
  });
});
