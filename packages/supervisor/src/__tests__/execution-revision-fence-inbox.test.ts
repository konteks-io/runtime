import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeExecutionRevisionControlIntentDigest,
  type RemoteExecutionRevisionControlIntent,
} from "@konteks/remote-common";
import {
  ExecutionRevisionFenceInbox,
  type ExecutionRevisionFenceInboxRecord,
} from "../state/execution-revision-fence-inbox.js";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "execution-revision-fence-inbox-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const issuedAt = "2026-09-21T00:00:00.000Z";
const deadlineAt = "2026-09-21T00:00:02.000Z";
const receivedAt = "2026-09-21T00:00:01.000Z";
const intent: RemoteExecutionRevisionControlIntent = {
  schemaVersion: "remote-execution-revision-control-v1" as const,
  negotiatedCapability: "execution-revision-control-v1" as const,
  intentId: "intent",
  tenantId: "tenant",
  instanceId: "instance",
  executionId: "execution",
  executionRevision: 7,
  checkId: "check",
  policyRevision: 4,
  connectionRef: "connection",
  connectionEpoch: 2,
  reason: "policy_revision_superseded" as const,
  issuedAt,
  deadlineAt,
};
const candidateFor = (nextIntent = intent) => ({
  intent: nextIntent,
  intentDigest: computeExecutionRevisionControlIntentDigest(nextIntent),
  runnerIncarnation: "runner",
  connectionRef: "connection",
  connectionEpoch: 2,
});
const candidate = candidateFor();

describe("native execution revision-fence inbox", () => {
  it("persists one exact pre-fence fact across restart without inventing a fence receipt", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const record = await journal.executionRevisionFences.receiveVerified(
      candidate,
      receivedAt,
      () => {},
    );

    const restarted = new SupervisorJournal(dir);
    await restarted.load();
    expect(restarted.executionRevisionFences.pending()).toEqual([record]);
    expect(record).toMatchObject({ intent, receivedAt });
    expect(record).not.toHaveProperty("fencedAt");
    expect(record).not.toHaveProperty("disposition");
  });

  it("deduplicates the same intent and rejects a different digest or revision tuple", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const first = await journal.executionRevisionFences.receiveVerified(
      candidate,
      receivedAt,
      () => {},
    );

    await expect(
      journal.executionRevisionFences.receiveVerified(candidate, receivedAt, () => {}),
    ).resolves.toEqual(first);
    await expect(
      journal.executionRevisionFences.receiveVerified(
        candidateFor({ ...intent, reason: "authority_revoked" }),
        receivedAt,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "recovery_required" });
    await expect(
      journal.executionRevisionFences.receiveVerified(
        {
          ...candidateFor({ ...intent, intentId: "other-intent", reason: "authority_revoked" }),
        },
        receivedAt,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "recovery_required" });
    expect(journal.executionRevisionFences.pending()).toEqual([first]);
  });

  it("refuses malformed or late facts at its own persistence boundary", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    await expect(
      journal.executionRevisionFences.receiveVerified(
        { ...candidate, intentDigest: "invalid" },
        receivedAt,
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      journal.executionRevisionFences.receiveVerified(
        candidate,
        "2026-09-21T00:00:02.001Z",
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      journal.executionRevisionFences.receiveVerified(
        { ...candidate, intent: { ...intent, deadlineAt: issuedAt } },
        receivedAt,
        () => {},
      ),
    ).rejects.toThrow();
    expect(journal.executionRevisionFences.pending()).toEqual([]);
  });

  it("keeps bounded durable state and allows an exact duplicate at capacity", async () => {
    const records = new Map<string, ExecutionRevisionFenceInboxRecord>();
    const log = {
      all: () => [...records.values()],
      update: async (
        key: string,
        derive: (
          value: ExecutionRevisionFenceInboxRecord | undefined,
        ) => ExecutionRevisionFenceInboxRecord,
      ) => {
        records.set(key, derive(records.get(key)));
      },
    };
    const inbox = new ExecutionRevisionFenceInbox(log, 1);
    const first = await inbox.receiveVerified(candidate, receivedAt, () => {});
    await expect(
      inbox.receiveVerified(
        {
          ...candidateFor({ ...intent, intentId: "other", executionId: "other-execution" }),
        },
        receivedAt,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "recovery_required" });
    await expect(inbox.receiveVerified(candidate, receivedAt, () => {})).resolves.toEqual(first);
  });
});
