import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeRemoteReconciliationReceiptSnapshotDigest } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { StateMutationGate } from "../state/mutation-gate.js";

const intent = { instanceId: "instance", runnerIncarnation: "process", reconnectIntentId: "intent", establishment: { expectedOwnerRevision: 0, expectedCurrentIncarnation: null }, lastHeartbeatSequence: 10, bundleVersion: "1.0.0", protocolVersion: "1.0", claims: [], pendingClaims: [] };
const manifest = { instanceId: "instance", runnerIncarnation: "process", reconnectIntentId: "intent", manifestId: "manifest", ownerRevision: 1, issuedAt: "2026-09-06T00:00:00Z", applyDeadlineAt: "2026-09-06T01:00:00Z", acceptedHeartbeatSequence: 7, heartbeatSequenceFloor: 10, lease: "secret-lease-canary", decisions: [], pendingClaimDecisions: [] };
const receipt = { instanceId: "instance", runnerIncarnation: "process", manifestId: "manifest", decisionResults: [], pendingClaimResults: [] };
const accepted = { ...receipt, receiptDigest: computeRemoteReconciliationReceiptSnapshotDigest(receipt), acceptedAt: "2026-09-06T00:01:00Z", outcome: "accepted" as const };
const { decisionResults: _results, pendingClaimResults: _pending, ...acceptance } = accepted;
let dir: string;
let journal: SupervisorJournal;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kr-recovery-journal-")); journal = new SupervisorJournal(dir); await journal.load(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function reload() { const next = new SupervisorJournal(dir); await next.load(); return next; }
async function prepared() { await journal.recovery.prepareIntent(intent); await journal.recovery.bindManifest(intent, manifest); await journal.recovery.prepareReceipt(intent, receipt); }

describe("durable runtime recovery generations", () => {
  it("keeps recovery pending when persisting Core acceptance fails", async () => {
    await prepared();
    const file = join(dir, "runtime-recovery.jsonl");
    await rename(file, `${file}.saved`); await mkdir(file);
    await expect(journal.recovery.acceptReceipt(intent, acceptance)).rejects.toThrow();
    expect(journal.recovery.current("instance", "process")?.state).toBe("pending");
    await rm(file, { recursive: true }); await rename(`${file}.saved`, file);
    expect((await reload()).recovery.current("instance", "process")?.state).toBe("pending");
    await journal.recovery.acceptReceipt(intent, acceptance);
    expect((await reload()).recovery.current("instance", "process")?.state).toBe("applied");
  });

  it("repairs torn recovery tails and rejects a complete tampered semantic record", async () => {
    await prepared();
    const file = join(dir, "runtime-recovery.jsonl");
    const complete = await readFile(file, "utf8");
    await writeFile(file, complete + '{"intent":');
    const next = await reload();
    await next.recovery.acceptReceipt(intent, acceptance);
    expect((await reload()).recovery.current("instance", "process")?.state).toBe("applied");
    const record = next.recovery.current("instance", "process")!;
    record.intent.lastHeartbeatSequence = 999;
    await writeFile(file, JSON.stringify(record) + "\n");
    await expect(reload()).rejects.toThrow();
  });

  it("preserves accepted history across supersession and cannot revive an old intent", async () => {
    await prepared(); await journal.recovery.acceptReceipt(intent, acceptance);
    await journal.recovery.terminate(intent, "superseded");
    expect((await reload()).recovery.current("instance", "process")?.acceptedAt).toBe(acceptance.acceptedAt);
    await journal.recovery.prepareIntent({ ...intent, reconnectIntentId: "next", establishment: null });
    await expect(journal.recovery.prepareIntent(intent)).rejects.toMatchObject({ code: "reconciliation_replay" });
  });

  it("restores the immutable pre-network intent and does not publish caller mutation", async () => {
    const input = structuredClone(intent);
    await journal.recovery.prepareIntent(input);
    input.lastHeartbeatSequence = 99;
    const next = await reload();
    expect(next.recovery.current("instance", "process")?.intent).toEqual(intent);
    const copy = next.recovery.current("instance", "process")!;
    copy.intent.lastHeartbeatSequence = 99;
    expect(next.recovery.current("instance", "process")?.intent).toEqual(intent);
    await next.recovery.prepareIntent(intent);
    await expect(next.recovery.prepareIntent({ ...intent, lastHeartbeatSequence: 11 })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("serializes competing intents and refuses a new unresolved generation", async () => {
    const results = await Promise.allSettled([journal.recovery.prepareIntent(intent), journal.recovery.prepareIntent({ ...intent, reconnectIntentId: "other" })]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await reload()).recovery.current("instance", "process")?.intent.reconnectIntentId).toBe("intent");
  });

  it("preserves manifest identity while allowing only lease/counter projections to change", async () => {
    await journal.recovery.prepareIntent(intent);
    await journal.recovery.bindManifest(intent, manifest);
    const first = journal.recovery.current("instance", "process");
    await journal.recovery.bindManifest(intent, { ...manifest, lease: "fresh-lease-canary", heartbeatSequenceFloor: 11, acceptedHeartbeatSequence: 11 });
    expect(journal.recovery.current("instance", "process")).toEqual(first);
    await expect(journal.recovery.bindManifest(intent, { ...manifest, applyDeadlineAt: "2026-09-06T02:00:00Z" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await readFile(join(dir, "runtime-recovery.jsonl"), "utf8")).not.toContain("lease-canary");
  });

  it.each(["instanceId", "runnerIncarnation", "reconnectIntentId"])("rejects a manifest for another %s", async key => {
    await journal.recovery.prepareIntent(intent);
    await expect(journal.recovery.bindManifest(intent, { ...manifest, [key]: "foreign" })).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(journal.recovery.current("instance", "process")?.manifest).toBeNull();
  });

  it("cannot prepare a receipt before its manifest or accept before its receipt", async () => {
    await journal.recovery.prepareIntent(intent);
    await expect(journal.recovery.prepareReceipt(intent, receipt)).rejects.toMatchObject({ code: "recovery_required" });
    await journal.recovery.bindManifest(intent, manifest);
    await expect(journal.recovery.acceptReceipt(intent, acceptance)).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("freezes queued evidence despite subsequent report acknowledgement", async () => {
    await journal.recovery.prepareIntent(intent); await journal.recovery.bindManifest(intent, manifest);
    const queued = { ...receipt, decisionResults: [{ assignmentId: "work", attempt: 1, disposition: "interrupted" as const, terminalReportId: "report", terminalEvidence: { kind: "queued" as const, reportSequence: 1, payloadDigest: "a".repeat(43), terminalResultHash: "b".repeat(43) } }] };
    await journal.recovery.prepareReceipt(intent, queued);
    await expect(journal.recovery.prepareReceipt(intent, { ...queued, decisionResults: [{ ...queued.decisionResults[0], disposition: "already_applied" }] })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await reload()).recovery.current("instance", "process")?.receipt?.snapshot).toEqual(queued);
  });

  it.each(["instanceId", "runnerIncarnation", "manifestId", "receiptDigest"])("rejects a mismatched acceptance %s without opening the gate", async key => {
    await prepared();
    await expect(journal.recovery.acceptReceipt(intent, { ...acceptance, [key]: key === "receiptDigest" ? "b".repeat(43) : "foreign" })).rejects.toMatchObject({ code: "registration_mismatch" });
    expect((await reload()).recovery.current("instance", "process")?.state).toBe("pending");
  });

  it("durably accepts exact receipt retries and preserves original accepted time", async () => {
    await prepared(); await journal.recovery.acceptReceipt(intent, acceptance);
    const next = await reload();
    await next.recovery.acceptReceipt(intent, { ...acceptance, outcome: "already_accepted" });
    expect(next.recovery.current("instance", "process")?.state).toBe("applied");
    await expect(next.recovery.acceptReceipt(intent, { ...acceptance, acceptedAt: "2026-09-06T00:02:00Z" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(next.recovery.current("instance", "process")?.acceptedAt).toBe(acceptance.acceptedAt);
  });

  it.each(["expired", "superseded", "establishment_conflict"] as const)("requires explicit %s disposition before replacing an unresolved intent", async state => {
    await journal.recovery.prepareIntent(intent);
    await journal.recovery.terminate(intent, state);
    const next = await reload();
    expect(next.recovery.current("instance", "process")?.state).toBe(state);
    await next.recovery.prepareIntent({ ...intent, reconnectIntentId: "next" });
    await expect(next.recovery.bindManifest(intent, manifest)).rejects.toMatchObject({ code: "reconciliation_replay" });
  });

  it("retains prior process facts but never projects them as a successor's acceptance", async () => {
    await prepared(); await journal.recovery.acceptReceipt(intent, acceptance);
    expect(journal.recovery.current("instance", "successor")).toBeUndefined();
    await journal.recovery.prepareIntent({ ...intent, runnerIncarnation: "successor", reconnectIntentId: "next", establishment: { expectedOwnerRevision: 1, expectedCurrentIncarnation: "process" } });
    expect((await reload()).recovery.current("instance", "successor")?.state).toBe("pending");
    expect(journal.recovery.current("instance", "process")?.acceptedAt).toBe(acceptance.acceptedAt);
  });

  it("does not rewrite accepted history as expiry or establishment failure", async () => {
    await prepared(); await journal.recovery.acceptReceipt(intent, acceptance);
    await expect(journal.recovery.terminate(intent, "expired")).rejects.toMatchObject({ code: "recovery_required" });
    await expect(journal.recovery.terminate(intent, "establishment_conflict")).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("rejects secret or extra snapshot fields rather than persisting them", async () => {
    await expect(journal.recovery.prepareIntent({ ...intent, proof: "secret-proof-canary" })).rejects.toThrow();
    await prepared();
    await expect(journal.recovery.prepareReceipt(intent, { ...receipt, lease: "secret-token-canary" })).rejects.toThrow();
    expect(await readFile(join(dir, "runtime-recovery.jsonl"), "utf8")).not.toContain("canary");
  });

  it("checks exclusive ownership before committing recovery facts", async () => {
    let owned = true;
    const gate = new StateMutationGate(() => { if (!owned) throw new Error("owner lost"); });
    const guarded = new SupervisorJournal(dir, gate.run); await guarded.load();
    owned = false;
    await expect(guarded.recovery.prepareIntent(intent)).rejects.toThrow("owner lost");
    expect((await reload()).recovery.current("instance", "process")).toBeUndefined();
    await gate.close();
  });
});
