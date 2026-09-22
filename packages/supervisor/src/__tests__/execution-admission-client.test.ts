import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, jcsDigest, generateInstanceKey, verifyInstanceProof, remoteExecutionInstanceProofSubject } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

function fixture(response: object) {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200 }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-10T00:00:00Z")),
    key: () => key, credential: () => "test-native-lease", fetchFn });
  return { client, fetchFn, key };
}

describe("observation HTTPS receipts", () => {
  const usage = { instanceId: "instance", assignmentId: "a", agentId: "codex", attempt: 1,
    moneyBasis: "unavailable_local_subscription", observedAt: "2026-09-22T00:00:00Z" };
  const digest = jcsDigest(usage);
  const receipt = { stored: false, observationId: `ri:turn:instance:a:1:${digest.slice(0,24)}`, observationDigest: digest };
  it("posts the single observation and accepts a committed duplicate", async () => {
    const f = fixture(receipt);
    await expect(f.client.submitObservation("instance", usage)).resolves.toBeUndefined();
    expect(JSON.parse(f.fetchFn.mock.calls[0]![1]!.body as string)).toEqual(usage);
  });
  it.each([{ observationDigest: "x".repeat(43) }, { observationId: "other" }, { accepted: 1 }])("rejects an unbound receipt", async patch => {
    const f = fixture({ ...receipt, ...patch });
    await expect(f.client.submitObservation("instance", usage)).rejects.toBeDefined();
  });
});

describe("native execution admission HTTPS proofs", () => {
  it("binds consume proofs to both path identities and fresh retry nonces", async () => {
    const f = fixture({ outcome: "admitted", admissionId: "admission", receipt: "a.b.c" });
    const request = { permitId: "permit", operationId: "operation", payloadDigest: "a".repeat(43), runnerIncarnation: "runner", executionRevision: 1 };
    await f.client.consumeExecution("instance", "execution", request);
    await f.client.consumeExecution("instance", "execution", request);
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/executions/execution/consume");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-native-lease" });
    const { proof, ...body } = JSON.parse(String(init?.body));
    expect(body).toEqual(request);
    const binding = { method: "execution_consume", audience: CORE_AUDIENCE, subject: remoteExecutionInstanceProofSubject("instance", "execution"), body };
    expect(verifyInstanceProof(f.key.publicKey, binding, proof)).toBe(true);
    expect(verifyInstanceProof(f.key.publicKey, { ...binding, subject: remoteExecutionInstanceProofSubject("instance", "other") }, proof)).toBe(false);
    expect(verifyInstanceProof(f.key.publicKey, { ...binding, method: "execution_check" }, proof)).toBe(false);
    expect(JSON.parse(String(f.fetchFn.mock.calls[1]![1]?.body)).proof.nonce).not.toBe(proof.nonce);
  });

  it("signs strict check intent and rejects another execution response", async () => {
    const response = { executionId: "execution", executionRevision: 1, expiresAt: "2026-09-10T00:00:30Z", lease: "a.b.c" };
    const f = fixture(response);
    const request = { executionRevision: 1, readyRevision: 1, runnerIncarnation: "runner" };
    await expect(f.client.checkExecution("instance", "execution", request)).resolves.toEqual(response);
    const { proof, ...body } = JSON.parse(String(f.fetchFn.mock.calls[0]![1]?.body));
    expect(body).toEqual(request);
    expect(verifyInstanceProof(f.key.publicKey, { method: "execution_check", audience: CORE_AUDIENCE,
      subject: remoteExecutionInstanceProofSubject("instance", "execution"), body }, proof)).toBe(true);
    await expect(fixture({ ...response, executionId: "other" }).client.checkExecution("instance", "execution", request)).rejects.toMatchObject({ code: "execution_fenced" });
    await expect(f.client.checkExecution("instance", "../other", request)).rejects.toThrow();
  });

  it("carries a caller renewal deadline to the JSON request budget", async () => {
    const response = { executionId: "execution", executionRevision: 1, expiresAt: "2026-09-10T00:00:30Z", lease: "a.b.c" };
    const f = fixture(response);
    const request = { executionRevision: 1, readyRevision: 1, runnerIncarnation: "runner" };
    const http = (f.client as unknown as { http: { request: ReturnType<typeof vi.fn> } }).http;
    const requestSpy = vi.spyOn(http, "request");

    const deadlineAtMs = Date.now() + 5_000;
    await (f.client.checkExecution as (...args: unknown[]) => Promise<unknown>)("instance", "execution", request, deadlineAtMs);

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ deadlineAtMs, operationPolicy: "executionCheck" }));
  });

  it.each(["checkExecution", "checkDeliveryExecution"] as const)("%s reads a slow response within the existing five-second lease budget", async method => {
    const response = { executionId: "execution", executionRevision: 1, expiresAt: "2026-09-10T00:00:30Z", lease: "a.b.c" };
    const f = fixture(response);
    f.fetchFn.mockImplementation(async (_url, init) => {
      const result = new Response(JSON.stringify(response));
      result.json = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", abort); resolve(response); }, 2_100);
        const abort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
      return result;
    });
    await expect(f.client[method]("instance", "execution", { executionRevision: 1, readyRevision: 1, runnerIncarnation: "runner" }, Date.now() + 5_000)).resolves.toEqual(response);
    expect(f.fetchFn).toHaveBeenCalledOnce();
  });

  it("assigns the bounded renewal policy to credential refresh", async () => {
    const f = fixture({});
    const http = (f.client as unknown as { http: { request: ReturnType<typeof vi.fn> } }).http;
    const requestSpy = vi.spyOn(http, "request").mockResolvedValue({} as never);

    await f.client.refreshProvisioningCredential({ instanceId: "instance", manifestDigest: "a".repeat(43) });

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ operationPolicy: "renewal",
      idempotencyKey: `provisioning-refresh:instance:${"a".repeat(43)}` }));
  });

  it("accepts only bounded public RSA trust from configured Core, without sending a credential", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "core", alg: "RS256", use: "sig" };
    const f = fixture({ keys: [key] });
    expect((await f.client.executionSigningKeys()).get("core")?.type).toBe("public");
    expect(String(f.fetchFn.mock.calls[0]![0])).toBe("https://core.example/api/remote-instances/internal/remote-instances/jwks");
    expect(f.fetchFn.mock.calls[0]![1]?.headers).not.toHaveProperty("authorization");
    for (const keys of [[key, key], [{ ...key, d: "private" }], [{ ...key, alg: "HS256" }], []]) {
      await expect(fixture({ keys }).client.executionSigningKeys()).rejects.toMatchObject({ code: "execution_authority_unavailable" });
    }
  });

  it("coalesces concurrent signing-key reads from active execution gates", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "core", alg: "RS256", use: "sig" };
    const f = fixture({ keys: [key] });

    const results = await Promise.all(Array.from({ length: 40 }, () => f.client.executionSigningKeys()));

    expect(results.every(keys => keys.get("core")?.type === "public")).toBe(true);
    expect(f.fetchFn).toHaveBeenCalledOnce();
  });

  it("coalesces one configured-origin refresh when a cached keyset lacks an operation key", async () => {
    const oldPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oldKey = { ...oldPair.publicKey.export({ format: "jwk" }), kid: "old", alg: "RS256", use: "sig" };
    const rotatedKey = { ...rotatedPair.publicKey.export({ format: "jwk" }), kid: "rotated", alg: "RS256", use: "sig" };
    const responses = [{ keys: [oldKey] }, { keys: [rotatedKey] }];
    const key = generateInstanceKey();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-10T00:00:00Z")),
      key: () => key, credential: () => "test-native-lease", fetchFn });

    await client.executionSigningKeys();
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      (client.executionSigningKeys as (deadlineAtMs?: number, expectedKid?: string) => Promise<ReadonlyMap<string, unknown>>)(undefined, "rotated")));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(results.every(keys => keys.has("rotated"))).toBe(true);
    await client.executionSigningKeys(undefined, "another-unknown-kid");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refreshes configured-origin signing keys after the 60-second cache bound", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "core", alg: "RS256", use: "sig" };
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const f = fixture({ keys: [key] });
      await f.client.executionSigningKeys();
      now.mockReturnValue(60_999);
      await f.client.executionSigningKeys();
      now.mockReturnValue(61_000);
      await f.client.executionSigningKeys();
      expect(f.fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
