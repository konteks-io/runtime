import { expect, it, vi } from "vitest";
import { Supervisor } from "../supervisor.js";
function fixture() {
  const client = { pendingRequest: vi.fn(async () => ({ requestId: "manual" })), receipt: vi.fn(async () => true) };
  let persisted: { requestId: string; state: "succeeded" | "failed" } | null = null;
  const supervisor = Object.assign(Object.create(Supervisor.prototype), {
    store: { pendingSkillReceipt: vi.fn(async () => persisted), savePendingSkillReceipt: vi.fn(async (_owner, result) => { persisted = result; }) },
    stopping: false, options: { native: {} }, nativeOwnership: {}, lease: { mode: () => "active" },
    reconciliation: { isComplete: true }, skillPollBusy: false, skillPollAbort: new AbortController(),
    machineSkillSyncClient: () => client, logger: { warn: vi.fn() },
    admitManualSkillSync: vi.fn(async (_request, sync) => { await sync(); return "executed"; }),
    syncOrganizationSkills: vi.fn(async () => ({})),
  });
  return { client, supervisor };
}
it("receipts success after refresh and retries a lost response without rerunning", async () => {
  const { client, supervisor } = fixture();
  client.receipt.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("offline"));
  await supervisor.pollSkillSyncRequest();
  expect(supervisor.pendingSkillReceipt).toEqual({ requestId: "manual", state: "succeeded" });
  supervisor.pendingSkillReceipt = undefined; // Simulate loss of process memory before the retry.
  await supervisor.pollSkillSyncRequest();
  expect(supervisor.pendingSkillReceipt).toBeUndefined();
  expect(supervisor.syncOrganizationSkills).toHaveBeenCalledTimes(1);
  expect(client.pendingRequest).toHaveBeenCalledTimes(1);
});
it("reports failed refresh and skips inactive or stopping runtimes", async () => {
  const { client, supervisor } = fixture();
  supervisor.syncOrganizationSkills.mockRejectedValueOnce(new Error("refresh"));
  await supervisor.pollSkillSyncRequest();
  expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "manual", state: "failed" }, supervisor.skillPollAbort.signal);
  supervisor.stopping = true; await supervisor.pollSkillSyncRequest();
  expect(client.pendingRequest).toHaveBeenCalledTimes(1);
});

it("records interruption before admission and does not refresh after a lost admission response", async () => {
  const { client, supervisor } = fixture();
  client.receipt.mockRejectedValueOnce(new Error("lost admission response"));
  await supervisor.pollSkillSyncRequest();
  expect(await supervisor.store.pendingSkillReceipt()).toEqual({ requestId: "manual", state: "failed" });
  expect(supervisor.syncOrganizationSkills).not.toHaveBeenCalled();
  supervisor.pendingSkillReceipt = undefined;
  await supervisor.pollSkillSyncRequest();
  expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "manual", state: "failed" }, supervisor.skillPollAbort.signal);
});
it("clears a definitively refused result so later requests are not blocked", async () => {
  const { client, supervisor } = fixture();
  await supervisor.store.savePendingSkillReceipt({}, { requestId: "expired", state: "failed" });
  client.receipt.mockResolvedValueOnce(false);
  await supervisor.pollSkillSyncRequest();
  expect(await supervisor.store.pendingSkillReceipt()).toBeNull();
  expect(supervisor.logger.warn).toHaveBeenCalledWith({ event: "skills.manual_sync_result_refused" }, expect.any(String));
  await supervisor.pollSkillSyncRequest();
  expect(client.pendingRequest).toHaveBeenCalledTimes(1);
});
