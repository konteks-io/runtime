import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, computeRemoteDeliveryOutputDigest, computeRemoteFileTreeDigest, RemoteDeliveryOutputStatusResultSchema, type RemoteWorkAssignment } from "@konteks/remote-common";
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

const expiredStage = { resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt: "2026-09-11T00:59:59Z" };
const jsonReply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("expired output staging reconciliation", () => {
  it.each(["staged", "rejected"] as const)("does not commit or invent acceptance for %s output", async state => {
    const status = RemoteDeliveryOutputStatusResultSchema.parse({ state, receipt: null, publication: "not_started" });
    const fetchFn = vi.fn(async (url: string | URL) => jsonReply(String(url).endsWith("/prepare") ? expiredStage : status));
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn });
    await expect(client.accept(assignment, candidate)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(fetchFn.mock.calls.map(call => String(call[0]).split("/").at(-1))).toEqual(["prepare", "status"]);
  });

  it.each([
    ["invocation", { invocationRef: "other" }], ["claim", { claimId: "other" }], ["result", { resultId: "other" }],
    ["digest", { resultDigest: `sha256:${"b".repeat(64)}` }], ["input selection", { inputSelectionDigest: `sha256:${"b".repeat(64)}` }],
    ["base revision", { baseRevision: "other" }],
    ...Object.keys(binding).map(key => [`binding ${key}`, { binding: { ...binding, [key]: key === "attempt" ? 2 : "other" } }]),
  ])("rejects an accepted receipt with another %s", async (_label, patch) => {
    const fetchFn = vi.fn(async (url: string | URL) => jsonReply(String(url).endsWith("/prepare") ? expiredStage : { state: "accepted", receipt: { ...receipt, ...patch as object }, publication: "pending" }));
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn });
    await expect(client.accept(assignment, candidate)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(fetchFn.mock.calls.map(call => String(call[0]).split("/").at(-1))).toEqual(["prepare", "status"]);
  });

  it.each([403, 404, 503])("fails closed when the status read returns HTTP%s", async status => {
    const fetchFn = vi.fn(async (url: string | URL) => String(url).endsWith("/prepare") ? jsonReply(expiredStage) : jsonReply({}, status));
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn, retrySleep: async () => undefined });
    await expect(client.accept(assignment, candidate)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(fetchFn.mock.calls.filter(call => String(call[0]).endsWith("/prepare"))).toHaveLength(1);
    expect(fetchFn.mock.calls.some(call => String(call[0]).endsWith("/commit"))).toBe(false);
  });

  it("does not widen identity or probe status for a mismatched prepared result", async () => {
    const fetchFn = vi.fn(async () => jsonReply({ ...expiredStage, resultId: "other" }));
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn });
    await expect(client.accept(assignment, candidate)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not extend the transfer deadline to recover an accepted result", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const fetchFn = vi.fn(async () => { now.mockReturnValue(32_001); return jsonReply(expiredStage); });
      const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn });
      await expect(client.accept(assignment, candidate)).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally { now.mockRestore(); }
  });
});

describe("native claim-scoped output client", () => {
  it.each(["2026-09-11T00:59:59Z", "2026-09-11T01:00:00Z"])("recovers the exact accepted receipt when replayed staging expires at %s", async expiresAt => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return jsonReply(String(url).endsWith("/prepare")
        ? { resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt }
        : { state: "accepted", receipt, publication: "pending" });
    });
    const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn });

    await expect(client.accept(assignment, candidate)).resolves.toEqual(receipt);
    await expect(client.acceptRetained({ instanceId: "instance", workspaceId: "tenant", assignmentId: "assignment", attempt: 1, claimId: "claim" }, candidate)).resolves.toEqual(receipt);
    expect(fetchFn.mock.calls.map(call => String(call[0]).split("/").at(-1))).toEqual(["prepare", "status", "prepare", "status"]);
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body))).toEqual({ attempt: 1, claimId: "claim", invocationRef: "invocation", resultId: "result", resultDigest: candidate.resultDigest });
  });
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

  it("emits correlated prepare, commit, and acceptance timing without payloads or credentials", async () => {
    const info = vi.fn();
    const fetchFn = vi.fn(async (url: string | URL) => new Response(JSON.stringify(String(url).endsWith("/prepare")
      ? { resultId: "result", resultDigest: candidate.resultDigest, stagedReceiptId: "staged", expiresAt: "2026-09-11T01:05:00Z" }
      : receipt), { headers: { "content-type": "application/json" } }));
    await expect(new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "credential-canary", fetchFn,
      logger: { info } as never }).accept(assignment, candidate)).resolves.toEqual(receipt);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "native.output.request_completed", correlationId: "invocation",
      stage: "prepare", outcome: "success", durationMs: expect.any(Number), requestBytes: expect.any(Number) }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "native.output.accept_completed", correlationId: "invocation",
      stage: "accept", outcome: "success", cacheOutcome: "miss", durationMs: expect.any(Number), bytes: 6 }), expect.any(String));
    expect(JSON.stringify(info.mock.calls)).not.toContain("after\\n");
    expect(JSON.stringify(info.mock.calls)).not.toContain("credential-canary");
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

  it("does not let repeated output retries outlive one logical transfer budget", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
      const client = new NativeOutputClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-11T01:00:00Z")), credential: () => "lease", fetchFn,
        retrySleep: async () => { now.mockReturnValue(32_001); } });

      await expect(client.accept(assignment, candidate)).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
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
