import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteInstanceError, computeRemoteDeliveryOutputDigest, computeRemoteFileTreeDigest } from "@konteks/remote-common";
import { createRetainedDeliveryOutputRecovery } from "../native/output-recovery.js";
import { NativeOutputStore } from "../native/output-store.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "kr-output-recovery-")); await chmod(root, 0o700); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture() {
  const binding = { workspaceId: "workspace", sessionId: "execution-session", assignmentId: "assignment", attempt: 1, instanceId: "instance" };
  const content = Buffer.from("generated\n");
  const entry = { path: "generated.txt", mode: 0o600 as const, sizeBytes: content.length,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") };
  const files = { format: "konteks-file-tree-v1" as const, entries: [entry], treeDigest: computeRemoteFileTreeDigest([entry]) };
  const body = { binding, claimId: "claim", invocationRef: "invocation", resultId: "result",
    inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: "revision", files, deletions: [] };
  const candidate = { ...body, resultDigest: computeRemoteDeliveryOutputDigest(body) };
  const completion = { kind: "acp_result" as const, id: "prompt", method: "session/prompt" as const, result: { stopReason: "end_turn" as const } };
  const receipt = { version: 1 as const, acceptanceId: "accepted", invocationRef: "invocation", binding, claimId: "claim", resultId: "result",
    resultDigest: candidate.resultDigest, inputSelectionDigest: candidate.inputSelectionDigest, baseRevision: "revision", acceptedAt: "2026-09-14T00:00:00Z" };
  return { candidate, completion, receipt };
}

describe("retained native output recovery", () => {
  it("retries and durably accepts the exact frozen candidate selected by admission and prompt authority", async () => {
    const container = join(root, `worktree-${"a".repeat(64)}`); await mkdir(container, { mode: 0o700 });
    const { candidate, completion, receipt } = fixture(); const store = new NativeOutputStore(container);
    await store.savePending(candidate, completion);
    const acceptRetained = vi.fn(async () => receipt);
    const pending = { acpSessionRef: "acp", id: "prompt", method: "session/prompt", direction: "received", closedAt: null,
      authorization: { state: "dispatch_started", claims: { acpSessionRef: "acp", instanceId: "instance", workspaceId: "workspace",
        assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", sessionId: "execution-session",
        deliveryIdentity: { invocationId: "invocation" } } } };
    const info = vi.fn();
    const recover = createRetainedDeliveryOutputRecovery({ roots: [root], journal: { pendingRequests: { get: vi.fn(() => pending) } } as never,
      client: () => ({ acceptRetained } as never), mutate: operation => operation(), logger: { info } as never });
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "old", assignmentId: "assignment", attempt: 1,
      claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: "2026-09-14T00:00:00Z" };

    await expect(recover(admission, { acpSessionRef: "acp" })).resolves.toEqual({ acpSessionRef: "acp", receipt });
    expect(acceptRetained).toHaveBeenCalledWith(admission, candidate);
    expect(await store.read()).toEqual({ version: 1, state: "accepted", candidate, completion, receipt });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "native.output.recovery_completed", correlationId: "invocation",
      stage: "recovery", outcome: "accepted", cacheOutcome: "pending_record", durationMs: expect.any(Number) }), expect.any(String));
    expect(JSON.stringify(info.mock.calls)).not.toContain("generated\\n");
    expect(JSON.stringify(info.mock.calls)).not.toContain(container);
  });
  it("leaves the frozen candidate unrecovered when Core no longer knows its assignment", async () => {
    const container = join(root, `worktree-${"b".repeat(64)}`); await mkdir(container, { mode: 0o700 });
    const { candidate, completion } = fixture(); const store = new NativeOutputStore(container);
    await store.savePending(candidate, completion);
    const acceptRetained = vi.fn(async () => { throw new RemoteInstanceError("capability_unavailable", "gone", { diagnostic: "assignment_not_found" }); });
    const pending = { acpSessionRef: "acp", id: "prompt", method: "session/prompt", direction: "received", closedAt: null,
      authorization: { state: "completed", claims: { acpSessionRef: "acp", instanceId: "instance", workspaceId: "workspace",
        assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "codex", sessionId: "execution-session",
        deliveryIdentity: { invocationId: "invocation" } } } };
    const warn = vi.fn();
    const recover = createRetainedDeliveryOutputRecovery({ roots: [root], journal: { pendingRequests: { get: vi.fn(() => pending) } } as never,
      client: () => ({ acceptRetained } as never), mutate: operation => operation(), logger: { warn } as never });
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "old", assignmentId: "assignment", attempt: 1,
      claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: "2026-09-14T00:00:00Z" };

    await expect(recover(admission, { acpSessionRef: "acp" })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "assignment", attempt: 1 }), expect.stringContaining("no longer knows"));
    expect(await store.read()).toEqual({ version: 1, state: "pending", candidate, completion });
    // any other refusal still surfaces, so a live assignment keeps retrying
    const other = createRetainedDeliveryOutputRecovery({ roots: [root], journal: { pendingRequests: { get: vi.fn(() => pending) } } as never,
      client: () => ({ acceptRetained: async () => { throw new RemoteInstanceError("capability_unavailable", "refused"); } } as never), mutate: operation => operation() });
    await expect(other(admission, { acpSessionRef: "acp" })).rejects.toThrow("refused");
  });
});
