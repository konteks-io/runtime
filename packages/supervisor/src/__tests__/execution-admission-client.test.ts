import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof, remoteExecutionInstanceProofSubject } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

function fixture(response: object) {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200 }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-10T00:00:00Z")),
    key: () => key, credential: () => "test-native-lease", fetchFn });
  return { client, fetchFn, key };
}

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

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ deadlineAtMs, operationPolicy: "progressRead" }));
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
});
