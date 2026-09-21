import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeRemoteDeliveryOutputDigest, computeRemoteFileTreeDigest } from "@konteks/remote-common";
import { NativeOutputSessionHeadStore, NativeOutputStore } from "../native/output-store.js";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kr-output-store-")); await chmod(dir, 0o700); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture(invocationRef = "invocation", claimId = "claim") {
  const binding = { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" };
  const content = Buffer.from("generated\n");
  const entry = { path: "generated.txt", mode: 0o600 as const, sizeBytes: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") };
  const files = { format: "konteks-file-tree-v1" as const, entries: [entry], treeDigest: computeRemoteFileTreeDigest([entry]) };
  const body = { binding, claimId, invocationRef, resultId: `result-${invocationRef}`, inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: "revision", files, deletions: [] };
  const candidate = { ...body, resultDigest: computeRemoteDeliveryOutputDigest(body) };
  const receipt = { version: 1 as const, acceptanceId: `accepted-${invocationRef}`, invocationRef, binding, claimId, resultId: body.resultId, resultDigest: candidate.resultDigest,
    inputSelectionDigest: candidate.inputSelectionDigest, baseRevision: "revision", acceptedAt: "2026-09-11T01:00:00Z" };
  const completion = { kind: "acp_result" as const, id: "prompt", method: "session/prompt" as const, result: { stopReason: "end_turn" as const } };
  return { candidate, receipt, completion };
}

describe("durable native output state", () => {
  it("retains the exact candidate across restart and replaces pending with its matching acceptance", async () => {
    const { candidate, receipt, completion } = fixture();
    await new NativeOutputStore(dir).savePending(candidate, completion);
    expect(await new NativeOutputStore(dir).read()).toEqual({ version: 1, state: "pending", candidate, completion });
    await new NativeOutputStore(dir).saveAccepted(candidate, receipt);
    expect(await new NativeOutputStore(dir).read()).toEqual({ version: 1, state: "accepted", candidate, completion, receipt });
  });

  it("fails closed on a corrupt or overly permissive record", async () => {
    await writeFile(join(dir, "delivery-output.json"), "{}\n", { mode: 0o644 });
    await expect(new NativeOutputStore(dir).read()).rejects.toThrow();
  });

  it("rejects an accepted record whose receipt belongs to another frozen result", async () => {
    const { candidate, receipt, completion } = fixture();
    await writeFile(join(dir, "delivery-output.json"), JSON.stringify({
      version: 1,
      state: "accepted",
      candidate,
      completion,
      receipt: { ...receipt, resultId: "another-result" },
    }), { mode: 0o600 });

    await expect(new NativeOutputStore(dir).read()).rejects.toThrow();
  });

  it("never overwrites a frozen pending candidate with different bytes", async () => {
    const { candidate, completion } = fixture(); const store = new NativeOutputStore(dir);
    await store.savePending(candidate, completion);
    await expect(store.savePending({ ...candidate, resultId: "other" }, completion)).rejects.toThrow();
    expect((await store.read())?.candidate).toEqual(candidate);
  });

  it("retains only the accepted session head and current pending turn", async () => {
    const head = new NativeOutputSessionHeadStore(dir, "session");
    const first = fixture("first", "claim-first");
    await head.begin({ invocationId: "first", claimId: "claim-first" });
    await head.record({ invocationId: "first", claimId: "claim-first" }).savePending(first.candidate, first.completion);
    await head.record({ invocationId: "first", claimId: "claim-first" }).saveAccepted(first.candidate, first.receipt);
    await head.promote({ invocationId: "first", claimId: "claim-first" });

    const abandoned = fixture("abandoned", "claim-abandoned");
    await head.begin({ invocationId: "abandoned", claimId: "claim-abandoned" });
    await head.record({ invocationId: "abandoned", claimId: "claim-abandoned" }).savePending(abandoned.candidate, abandoned.completion);
    const next = fixture("next", "claim-next");
    await head.begin({ invocationId: "next", claimId: "claim-next" });
    expect(await head.record({ invocationId: "abandoned", claimId: "claim-abandoned" }).read()).toBeNull();
    await head.record({ invocationId: "next", claimId: "claim-next" }).savePending(next.candidate, next.completion);
    await head.record({ invocationId: "next", claimId: "claim-next" }).saveAccepted(next.candidate, next.receipt);
    await head.promote({ invocationId: "next", claimId: "claim-next" });
    expect(await head.record({ invocationId: "first", claimId: "claim-first" }).read()).toBeNull();
    expect((await head.record({ invocationId: "next", claimId: "claim-next" }).read())?.state).toBe("accepted");
  });

  it("repairs a crash after durable acceptance but before session-head promotion", async () => {
    const head = new NativeOutputSessionHeadStore(dir, "session");
    const first = fixture("first", "claim-first");
    await head.begin({ invocationId: "first", claimId: "claim-first" });
    const store = head.record({ invocationId: "first", claimId: "claim-first" });
    await store.savePending(first.candidate, first.completion);
    await store.saveAccepted(first.candidate, first.receipt);
    await expect(head.verifyExpected({ invocationId: "first", claimId: "claim-first",
      acceptanceId: first.receipt.acceptanceId, resultDigest: first.receipt.resultDigest },
    { invocationId: "next", claimId: "claim-next" })).resolves.toBeUndefined();
    await expect(head.begin({ invocationId: "next", claimId: "claim-next" })).resolves.toBeUndefined();
  });
});
