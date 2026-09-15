import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, type RemoteWorkAssignment } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { createNativeReadyRegistrar } from "../native/execution-ready.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-ready-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
const expiresAt = "2026-09-06T01:00:00Z";
const work: RemoteWorkAssignment = { id: "assignment", attempt: 1, workspaceId: "tenant", instanceId: "instance", placementId: "placement", kind: "assistant_execution", taskId: "task", correlationId: "correlation", expiresAt, requiredCapabilities: [], agentRoute: { agentId: "codex", requiredRole: "assistant" }, source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: "turn" }, policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: expiresAt, permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: false } };
const binding = { workspaceId: "tenant", instanceId: "instance", sessionId: "session", assignmentId: "assignment", attempt: 1 };
const ready = { ...binding, channelId: "session:session", claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "process", agentId: "codex", acpSessionRef: "acp", readyRevision: 1, registeredAt: clock.nowIso() };
async function fixture() {
  const journal = new SupervisorJournal(root); await journal.load();
  const entry = { assignmentId: work.id, attempt: 1, claimId: "claim", kind: work.kind, placementId: work.placementId, workspaceId: work.workspaceId, agentId: "codex", state: "claimed" as const, recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const, expiresAt, latestResumeAt: expiresAt, updatedAt: clock.nowIso() };
  await journal.assignments.put(entry);
  const registerExecutionReady = vi.fn(async () => ready);
  const assertActive = vi.fn();
  const register = createNativeReadyRegistrar({ clock, journal, client: { registerExecutionReady }, instanceId: "instance", workspaceId: "tenant", runnerIncarnation: "process", assertActive });
  return { journal, entry, register, registerExecutionReady, assertActive };
}
describe("native authoritative execution readiness", () => {
  it("uses only the local accepted claim and persists Core's exact receipt before returning", async () => {
    const f = await fixture();
    await expect(f.register(work, binding, "acp")).resolves.toEqual(ready);
    // The local deadline travels with the request so Core's retry budget is bounded by the caller.
    expect(f.registerExecutionReady).toHaveBeenCalledWith("instance", { assignmentId: "assignment", attempt: 1, claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "process", agentId: "codex", acpSessionRef: "acp" }, expect.any(Number));
    const reopened = new SupervisorJournal(root); await reopened.load();
    expect(reopened.assignments.get("assignment:1")?.executionReady).toEqual(ready);
  });
  it.each([{ workspaceId: "other" }, { agentId: "claude-code" }, { state: "completed" }, { expiresAt: "2026-09-05T00:00:00Z" }])("denies invalid local claim before Core IO: %j", async patch => {
    const f = await fixture(); await f.journal.assignments.put({ ...f.entry, ...patch } as typeof f.entry);
    await expect(f.register(work, binding, "acp")).rejects.toThrow();
    expect(f.registerExecutionReady).not.toHaveBeenCalled();
  });
  it.each([{ sessionId: "other", channelId: "session:other" }, { claimId: "other" }, { recoveryEpoch: 1 }, { runnerIncarnation: "other" }, { acpSessionRef: "other" }])("rejects mismatched Core receipt without persisting readiness: %j", async patch => {
    const f = await fixture(); f.registerExecutionReady.mockResolvedValue({ ...ready, ...patch });
    await expect(f.register(work, binding, "acp")).rejects.toThrow();
    expect(f.journal.assignments.get("assignment:1")?.executionReady).toBeUndefined();
  });
  it("rechecks cancellation and process ownership after Core IO", async () => {
    const f = await fixture();
    f.registerExecutionReady.mockImplementation(async () => { await f.journal.assignments.put({ ...f.entry, state: "cancelled" }); return ready; });
    await expect(f.register(work, binding, "acp")).rejects.toThrow();
    expect(f.journal.assignments.get("assignment:1")?.state).toBe("cancelled");
    expect(f.journal.assignments.get("assignment:1")?.executionReady).toBeUndefined();
    const other = await fixture(); other.assertActive.mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error("ownership lost"); });
    await expect(other.register(work, binding, "acp")).rejects.toThrow();
    expect(other.journal.assignments.get("assignment:1")?.executionReady).toBeUndefined();
  });
});
