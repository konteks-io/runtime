import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SupervisorJournal } from "../state/journal.js";
import { CancellationInbox, type CancellationInboxRecord } from "../state/cancellation-inbox.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cancellation-inbox-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const receivedAt = "2026-09-10T00:00:01.000Z";
const intent = { intentId: "intent", tenantId: "tenant", instanceId: "instance", sessionId: "session",
  claimId: "claim", delegationRef: "delegation", directive: { assignmentId: "assignment", attempt: 1,
    reason: "policy_denied", issuedAt: "2026-09-10T00:00:00.000Z", signature: "AA" } };

describe("native durable cancellation inbox (after receiver verification)", () => {
  it("retains exact verified intent and original receipt across restart without claiming stop", async () => {
    const journal = new SupervisorJournal(dir); await journal.load();
    const record = await journal.cancellations.receiveVerified(intent, receivedAt, () => {});
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.cancellations.pending()).toEqual([record]);
    expect(record).toMatchObject({ intent, receivedAt });
    expect(record).not.toHaveProperty("stoppedAt");
    expect(record).not.toHaveProperty("completed");
    expect(await restarted.cancellations.receiveVerified({ ...intent, directive: { ...intent.directive, signature: "BB" } },
      "2026-09-10T00:02:00.000Z", () => {})).toEqual(record);
  });
  it("serializes duplicate receipt and rejects conflicting identity without replacing evidence", async () => {
    const journal = new SupervisorJournal(dir); await journal.load();
    const [first, duplicate] = await Promise.all([journal.cancellations.receiveVerified(intent, receivedAt, () => {}),
      journal.cancellations.receiveVerified(intent, receivedAt, () => {})]);
    expect(duplicate).toEqual(first);
    await expect(journal.cancellations.receiveVerified({ ...intent, claimId: "foreign" }, receivedAt, () => {}))
      .rejects.toMatchObject({ code: "recovery_required" });
    expect(journal.cancellations.pending()).toEqual([first]);
  });
  it("withholds receipt on write failure and persists no fictitious admission", async () => {
    let fail = false;
    const journal = new SupervisorJournal(dir, async operation => { if (fail) throw new Error("disk unavailable"); return operation(); });
    await journal.load(); fail = true;
    await expect(journal.cancellations.receiveVerified(intent, receivedAt, () => {})).rejects.toThrow("disk unavailable");
    expect(journal.cancellations.pending()).toEqual([]);
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.cancellations.pending()).toEqual([]);
  });
  it("checks current ownership before persistence and again before returning a receipt", async () => {
    const journal = new SupervisorJournal(dir); await journal.load();
    const stale = () => { throw new Error("stale owner"); };
    await expect(journal.cancellations.receiveVerified(intent, receivedAt, stale)).rejects.toThrow("stale owner");
    expect(journal.cancellations.pending()).toEqual([]);
    const changesAfterWrite = vi.fn().mockImplementationOnce(() => {}).mockImplementation(stale);
    await expect(journal.cancellations.receiveVerified(intent, receivedAt, changesAfterWrite)).rejects.toThrow("stale owner");
    expect(journal.cancellations.pending()).toHaveLength(1);
  });
  it("returns detached records so consumers cannot mutate durable replay state", async () => {
    const journal = new SupervisorJournal(dir); await journal.load();
    const record = await journal.cancellations.receiveVerified(intent, receivedAt, () => {});
    record.intent.claimId = "changed";
    journal.cancellations.pending()[0]!.intent.claimId = "changed-again";
    expect(journal.cancellations.pending()[0]!.intent.claimId).toBe("claim");
  });
  it("fails closed at capacity without evicting receipts, while still allowing exact duplicates", async () => {
    const records = new Map<string, CancellationInboxRecord>();
    const log = { all: () => [...records.values()], update: async (key: string,
      derive: (value: CancellationInboxRecord | undefined) => CancellationInboxRecord) => { records.set(key, derive(records.get(key))); } };
    const inbox = new CancellationInbox(log, 1);
    const first = await inbox.receiveVerified(intent, receivedAt, () => {});
    await expect(inbox.receiveVerified({ ...intent, intentId: "second" }, receivedAt, () => {}))
      .rejects.toMatchObject({ code: "recovery_required" });
    expect(await inbox.receiveVerified(intent, receivedAt, () => {})).toEqual(first);
    expect(inbox.pending()).toEqual([first]);
    records.clear();
    await expect(new CancellationInbox(log, 1, 1).receiveVerified(intent, receivedAt, () => {}))
      .rejects.toMatchObject({ code: "recovery_required" });
    expect(records.size).toBe(0);
  });
  it("refuses corrupt complete records on restart rather than inventing receipt state", async () => {
    const journal = new SupervisorJournal(dir); await journal.load();
    const record = await journal.cancellations.receiveVerified(intent, receivedAt, () => {});
    await appendFile(join(dir, "cancellation-inbox.jsonl"), `${JSON.stringify({ ...record, intentDigest: "B".repeat(43) })}\n`);
    await expect(new SupervisorJournal(dir).load()).rejects.toThrow("Cancellation inbox identity mismatch");
  });
});
