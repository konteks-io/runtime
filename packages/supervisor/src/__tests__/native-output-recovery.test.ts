import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRemoteDeliveryOutputDigest, computeRemoteFileTreeDigest } from "@konteks/remote-common";
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
    const recover = createRetainedDeliveryOutputRecovery({ roots: [root], journal: { pendingRequests: { get: vi.fn(() => pending) } } as never,
      client: () => ({ acceptRetained } as never), mutate: operation => operation() });
    const admission = { instanceId: "instance", workspaceId: "workspace", runnerIncarnation: "old", assignmentId: "assignment", attempt: 1,
      claimId: "claim", agentId: "codex", executionGeneration: "generation", openedAt: "2026-09-14T00:00:00Z" };

    await expect(recover(admission, { acpSessionRef: "acp" })).resolves.toEqual({ acpSessionRef: "acp", receipt });
    expect(acceptRetained).toHaveBeenCalledWith(admission, candidate);
    expect(await store.read()).toEqual({ version: 1, state: "accepted", candidate, completion, receipt });
  });
});
