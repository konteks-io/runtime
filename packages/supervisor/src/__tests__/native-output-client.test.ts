import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, computeRemoteDeliveryOutputDigest, computeRemoteFileTreeDigest, type RemoteWorkAssignment } from "@konteks/remote-common";
import { NativeOutputClient, isAssignmentGone } from "../native/output-client.js";

const assignment: RemoteWorkAssignment = {
  id: "assignment", instanceId: "instance", workspaceId: "tenant", attempt: 1, kind: "delivery", placementId: "placement", taskId: "task", correlationId: "invocation",
  expiresAt: "2026-09-11T02:00:00Z", requiredCapabilities: [], agentRoute: { agentId: "codex", requiredRole: "generator" },
  source: { kind: "harness_delivery", portability: "instance_bound", ownerInstanceId: "instance", executionSessionId: "session",
    repositoryId: "https://git.example.com/acme/store", modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
    turn: { invocationId: "invocation", dispatchGeneration: 0 } },
  policy: { maxDurationSeconds: 600, maxArtifactBytes: 1024, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-11T02:00:00Z", permissionResponderDeadlineSeconds: 30, humanDeferralAllowed: false },
};
const binding = { workspaceId: "tenant", sessionId: "session", assignmentId: "assignment", attempt: 1, instanceId: "instance" };
const entry = { path: "change.txt", mode: 0o600 as const, sizeBytes: 6, digest: `sha256:${createHash("sha256").update("after\n").digest("hex")}`, contentBase64: Buffer.from("after\n").toString("base64") };
const files = { format: "konteks-file-tree-v1" as const, entries: [entry], treeDigest: computeRemoteFileTreeDigest([entry]) };
const body = { binding, claimId: "claim", invocationRef: "invocation", resultId: "result", inputSelectionDigest: `sha256:${"a".repeat(64)}`, baseRevision: "revision", files, deletions: [] };
const candidate = { ...body, resultDigest: computeRemoteDeliveryOutputDigest(body) };
const receipt = { version: 1 as const, acceptanceId: "accepted", invocationRef: "invocation", binding, claimId: "claim", resultId: "result", resultDigest: candidate.resultDigest,
  inputSelectionDigest: candidate.inputSelectionDigest, baseRevision: "revision", acceptedAt: "2026-09-11T01:00:00Z" };

describe("native claim-scoped output client", () => {
  it("does not let restart recovery widen the frozen candidate's durable owner", async () => {
    const fetchFn = vi.fn();
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn });
    await expect(client.acceptRetained({ instanceId: "instance", workspaceId: "tenant", assignmentId: "other", attempt: 1, claimId: "claim" }, candidate)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("prepares then commits exact candidate bytes before returning acceptance", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => new Response(JSON.stringify(String(url).endsWith("/prepare")
      ? { resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt: "2026-09-11T01:05:00Z" }
      : receipt), { headers: { "content-type": "application/json" } }));
    const accepted = await new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn }).accept(assignment, candidate);
    expect(accepted).toEqual(receipt);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body))).toEqual({ attempt: 1, claimId: "claim", invocationRef: "invocation", resultId: "result", inputSelectionDigest: candidate.inputSelectionDigest, baseRevision: "revision", files, deletions: [], resultDigest: candidate.resultDigest });
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body))).toMatchObject({ attempt: 1, claimId: "claim", resultId: "result", stagedReceiptId: "staged" });
  });

  it("resolves a lost commit response through status without uploading bytes again", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt: "2026-09-11T01:05:00Z" }), { headers: { "content-type": "application/json" } }))
      .mockRejectedValueOnce(new Error("response lost"))
      .mockRejectedValueOnce(new Error("response still lost"))
      .mockRejectedValueOnce(new Error("response still lost"))
      .mockRejectedValueOnce(new Error("response still lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "accepted", receipt, publication: "pending" }), { headers: { "content-type": "application/json" } }));
    await expect(new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn, retrySleep: async () => undefined }).accept(assignment, candidate)).resolves.toEqual(receipt);
    expect(String(fetchFn.mock.calls[5]![0])).toMatch(/\/outputs\/status$/);
    expect(String(fetchFn.mock.calls[5]![1]?.body)).not.toContain("contentBase64");
  });

  it("reconciles a lost prepare response and retries the identical candidate when status is absent", async () => {
    const prepared = { resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt: "2026-09-11T01:05:00Z" };
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("prepare response lost"))
      .mockRejectedValueOnce(new Error("prepare response still lost"))
      .mockRejectedValueOnce(new Error("prepare response still lost"))
      .mockRejectedValueOnce(new Error("prepare response still lost"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(prepared), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { headers: { "content-type": "application/json" } }));
    await expect(new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn, retrySleep: async () => undefined }).accept(assignment, candidate)).resolves.toEqual(receipt);
    expect(String(fetchFn.mock.calls[4]![0])).toMatch(/\/outputs\/status$/);
    expect(fetchFn.mock.calls[0]![1]?.body).toBe(fetchFn.mock.calls[5]![1]?.body);
  });

  it("continues an uncertain staged commit with the same staged receipt", async () => {
    const prepared = { resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt: "2026-09-11T01:05:00Z" };
    const staged = { state: "staged", receipt: null, publication: "not_started" };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(prepared), { headers: { "content-type": "application/json" } }))
      .mockRejectedValueOnce(new Error("commit response lost"))
      .mockRejectedValueOnce(new Error("commit response still lost"))
      .mockRejectedValueOnce(new Error("commit response still lost"))
      .mockRejectedValueOnce(new Error("commit response still lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify(staged), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { headers: { "content-type": "application/json" } }));
    await expect(new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn, retrySleep: async () => undefined }).accept(assignment, candidate)).resolves.toEqual(receipt);
    expect(fetchFn.mock.calls[1]![1]?.body).toBe(fetchFn.mock.calls[6]![1]?.body);
  });
  it("names an assignment Core no longer knows instead of an ordinary refusal", async () => {
    const notFound = () => new Response(JSON.stringify({ code: "not_found", message: "assignment not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const fetchFn = vi.fn(async () => notFound());
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn, retrySleep: async () => undefined });
    const failure = await client.acceptRetained({ instanceId: "instance", workspaceId: "tenant", assignmentId: "assignment", attempt: 1, claimId: "claim" }, candidate).catch((error: unknown) => error);
    expect(isAssignmentGone(failure)).toBe(true);
    // prepare then the status probe; a plain refusal on a live assignment stays "unavailable"
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const refusedOnce = vi.fn()
      .mockResolvedValueOnce(new Response("over limit", { status: 413, headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "missing" }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("over limit", { status: 413, headers: { "content-type": "text/plain" } }));
    const plain = await new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn: refusedOnce, retrySleep: async () => undefined })
      .acceptRetained({ instanceId: "instance", workspaceId: "tenant", assignmentId: "assignment", attempt: 1, claimId: "claim" }, candidate).catch((error: unknown) => error);
    expect(isAssignmentGone(plain)).toBe(false);
    expect(plain).toMatchObject({ code: "capability_unavailable" });
  });
});
