import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteExecutionAdmissionClaimsSchema, type SessionToCoreMessage } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { OperationAdmissionJournal, admittedOperationKey } from "../state/operation-admission.js";
import { terminalOperationDispositions } from '../state/operation-dispositions.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-operation-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const clock = new FixedClock(Date.parse("2026-09-10T00:00:00Z"));
const claims = RemoteExecutionAdmissionClaimsSchema.parse({
  executionId: "execution", delegationRef: "delegation", workspaceId: "tenant", sessionId: "session", turnRef: "turn",
  principal: "assistant", actorId: "user:default/owner", actorPrincipalId: "human", leaseSetId: "set", channelId: "session:session",
  assignmentId: "assignment", attempt: 1, claimId: "claim", recoveryEpoch: 0, readyRevision: 1, runnerIncarnation: "runner",
  instanceId: "instance", agentId: "codex", acpSessionRef: "acp", executionRevision: 1, state: "active", expiresAt: "2026-09-10T01:00:00Z",
  operationId: "operation", permitId: "permit", kind: "acp", method: "session/prompt", requestId: "request", payloadDigest: "a".repeat(43),
  sender: { kind: "holder", principal: "assistant" }, iss: "konteks:control-plane", aud: "konteks:remote-execution-admission",
  iat: clock.coreNow() / 1000, exp: clock.coreNow() / 1000 + 30, admissionId: "admission",
  admittedAt: clock.nowIso(), checkExpiresAt: "2026-09-10T00:00:30Z",
});
const completion: SessionToCoreMessage = { kind: "acp_result", id: "request", method: "session/prompt", result: { stopReason: "end_turn" } };
const current = () => undefined;
async function fixture() {
  const journal = new SupervisorJournal(root); await journal.load();
  return { journal, operations: new OperationAdmissionJournal(journal, clock), key: admittedOperationKey(claims) };
}

describe("native operations extend the durable pending-request journal", () => {
  it('projects real completion and retains ambiguous dispatch in the same journal before reporting', async () => {
    const f = await fixture(); await f.operations.admit(claims, 'a.b.c', current); await f.operations.begin(f.key, current);
    await f.operations.complete(f.key, completion);
    const other = { ...claims, operationId: 'second', requestId: 'second', permitId: 'second', admissionId: 'second' };
    await f.operations.admit(other, 'a.b.c', current); await f.operations.begin(admittedOperationKey(other), current);
    const dispositions = await terminalOperationDispositions(f.journal, 'assignment', 1, 'claim');
    expect(dispositions).toEqual([expect.objectContaining({ operationId: 'operation', state: 'completed', completionDigest: expect.any(String) }),
      expect.objectContaining({ operationId: 'second', state: 'interrupted' })]);
    expect(dispositions[1]).not.toHaveProperty('completionDigest');
    expect((await fixture()).journal.pendingRequests.get(admittedOperationKey(other))?.authorization?.state).toBe('interrupted');
    expect(await terminalOperationDispositions(f.journal, 'foreign', 1, 'claim')).toEqual([]);
  });
  it("durably replays one rejection without allowing a started operation to become denied", async () => {
    const f = await fixture(); await f.operations.admit(claims, "a.b.c", current);
    const rejection: SessionToCoreMessage = { kind: "acp_error", id: "request", method: "session/prompt",
      error: { code: -32603, class: "internal", message: "execution authority unavailable", retryable: false } };
    await f.operations.denyBeforeDispatch(f.key);
    await f.operations.denyBeforeDispatch(f.key, rejection);
    const reopened = await fixture();
    expect(reopened.journal.pendingRequests.get(f.key)?.authorization?.completion).toEqual(rejection);
    expect(await reopened.operations.begin(f.key, current)).toBe(false);
    await expect(reopened.operations.denyBeforeDispatch(f.key, completion)).rejects.toMatchObject({ code: "operation_conflict" });
    const second = { ...claims, operationId: "second", requestId: "second" };
    await f.operations.admit(second, "a.b.c", current);
    await f.operations.begin(admittedOperationKey(second), current);
    await expect(f.operations.denyBeforeDispatch(admittedOperationKey(second))).rejects.toMatchObject({ code: "operation_conflict" });
  });
  it("fsyncs admission and starts exactly once under concurrent duplicates", async () => {
    const f = await fixture(); await f.operations.admit(claims, "a.b.c", current);
    const reopened = await fixture();
    expect(reopened.journal.pendingRequests.get(f.key)?.authorization?.state).toBe("admitted");
    expect(await Promise.all([f.operations.begin(f.key, current), f.operations.begin(f.key, current)])).toEqual([true, false]);
    expect((await fixture()).journal.pendingRequests.get(f.key)?.authorization?.state).toBe("dispatch_started");
  });

  it("never repeats an ambiguous dispatch after process restart", async () => {
    const f = await fixture(); await f.operations.admit(claims, "a.b.c", current); await f.operations.begin(f.key, current);
    const reopened = await fixture();
    await expect(reopened.operations.begin(f.key, current)).rejects.toMatchObject({ code: "operation_interrupted" });
    expect((await fixture()).journal.pendingRequests.get(f.key)?.authorization?.state).toBe("interrupted");
  });

  it("retains exact completion for duplicate replay without redispatch", async () => {
    const f = await fixture(); await f.operations.admit(claims, "a.b.c", current); await f.operations.begin(f.key, current);
    await f.operations.complete(f.key, completion);
    const reopened = await fixture();
    expect(await reopened.operations.begin(f.key, current)).toBe(false);
    expect(reopened.journal.pendingRequests.get(f.key)?.authorization?.completion).toEqual(completion);
    await expect(reopened.operations.complete(f.key, { ...completion, result: { stopReason: "cancelled" } })).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("fences changed facts, prior legacy requests and revoked-before-dispatch work", async () => {
    const f = await fixture(); await f.operations.admit(claims, "a.b.c", current);
    await expect(f.operations.admit({ ...claims, operationId: "other" }, "a.b.c", current)).rejects.toMatchObject({ code: "operation_conflict" });
    await f.operations.denyBeforeDispatch(f.key);
    expect(await f.operations.begin(f.key, current)).toBe(false);
    await f.journal.pendingRequests.put({ acpSessionRef: "acp", id: "legacy", method: "session/prompt", direction: "received", openedAt: clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
    await expect(f.operations.admit({ ...claims, requestId: "legacy" }, "a.b.c", current)).rejects.toMatchObject({ code: "operation_interrupted" });
  });

  it("requires a matching pending permission digest before an authorized answer", async () => {
    const f = await fixture();
    const answer = RemoteExecutionAdmissionClaimsSchema.parse({ ...claims, kind: "acp_result", method: "session/request_permission",
      sender: { kind: "core_permission_answer", principal: "core", pendingRef: "pending", requestDigest: "b".repeat(43), responderActorId: "user:default/owner", decisionId: "decision" } });
    await expect(f.operations.admit(answer, "a.b.c", current)).rejects.toMatchObject({ code: "operation_conflict" });
    await f.journal.pendingRequests.put({ acpSessionRef: "acp", id: "request", method: "session/request_permission", direction: "issued", openedAt: clock.nowIso(), closedAt: null, deadlineAt: "2026-09-10T00:00:30Z", requestDigest: "b".repeat(43) });
    await f.operations.admit(answer, "a.b.c", current);
    const key = admittedOperationKey(answer); expect(await f.operations.begin(key, current)).toBe(true);
    await f.operations.complete(key);
    expect(f.journal.pendingRequests.get(key)?.closedAt).toBe(clock.nowIso());
  });

  it("cannot report started when journal persistence fails", async () => {
    const f = await fixture(); await f.operations.admit(claims, "a.b.c", current);
    vi.spyOn(f.journal.pendingRequests, "update").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.operations.begin(f.key, current)).rejects.toThrow("disk unavailable");
    expect(f.journal.pendingRequests.get(f.key)?.authorization?.state).toBe("admitted");
    await expect(f.operations.begin(f.key, () => { throw new Error("claim retired"); })).rejects.toThrow("claim retired");
    expect(f.journal.pendingRequests.get(f.key)?.authorization?.state).toBe("admitted");
  });
});
