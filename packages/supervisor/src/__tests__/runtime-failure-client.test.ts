import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, jcsDigest, type JsonValue } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

// This suite imports the existing client. Its initial RED is the absent
// dedicated HTTP operation, rather than failure to import a proposed module.
type FailureClient = CoreClient & {
  submitRuntimeFailure(instanceId: string, body: unknown): Promise<unknown>;
};

const observedAt = "2026-10-17T18:00:00Z";
const failure = () => ({
  schemaVersion: 1,
  failureId: "failure-one",
  observedAt,
  instanceId: "instance",
  scope: { kind: "assignment", assignmentId: "assignment", attempt: 1, claimId: "claim" },
  phase: "preparation",
  stage: "workspace_read",
  code: "repository_access_refused",
  evidence: { kind: "runtime_exception", errno: "EACCES" },
  pathRole: "repository",
});

function receipt(value: unknown, status = "stored") {
  const body = value as { instanceId: string; failureId: string };
  return {
    schemaVersion: 1,
    instanceId: body.instanceId,
    failureId: body.failureId,
    failureDigest: jcsDigest(value as JsonValue),
    status,
  };
}

function fixture(response: unknown = receipt(failure())) {
  const fetchFn = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
  );
  let credential = "fixture-lease";
  const client = new CoreClient({
    baseUrl: "https://core.example",
    fetchFn,
    clock: new FixedClock(Date.parse(observedAt)),
    key: () => generateInstanceKey(),
    credential: () => credential,
  }) as FailureClient;
  return {
    client,
    fetchFn,
    rotate: () => {
      credential = "next-fixture-lease";
    },
  };
}

describe("dedicated Runtime failure HTTPS operation", () => {
  it.each(["stored", "duplicate", "expired"])(
    "returns only a content-bound %s receipt",
    async (status) => {
      const value = failure();
      const accepted = receipt(value, status);
      const f = fixture(accepted);
      await expect(f.client.submitRuntimeFailure("instance", value)).resolves.toEqual(accepted);
      expect(f.fetchFn).toHaveBeenCalledOnce();
      const [url, init] = f.fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
      expect(new URL(url).pathname).toBe(
        "/api/remote-instances/internal/remote-instances/instance/runtime-failures",
      );
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer fixture-lease");
      expect(headers.get("idempotency-key")).toContain(value.failureId);
      expect(JSON.parse(String(init.body))).toEqual(value);
    },
  );

  it.each([
    { instanceId: "foreign" },
    { failureId: "different" },
    { failureDigest: "B".repeat(43) },
    { schemaVersion: 2 },
    { status: "accepted" },
    { accepted: true },
  ])("rejects a foreign, changed or noncanonical receipt %#", async (patch) => {
    const f = fixture({ ...receipt(failure()), ...patch });
    await expect(f.client.submitRuntimeFailure("instance", failure())).rejects.toThrow();
  });

  it("does not replace a durable receipt with an unbound generic success", async () => {
    const f = fixture({ accepted: true });
    await expect(f.client.submitRuntimeFailure("instance", failure())).rejects.toThrow();
  });

  it("rejects a different instance before sending", async () => {
    const f = fixture();
    await expect(f.client.submitRuntimeFailure("foreign", failure())).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { message: "private provider detail" },
    { stage: "x".repeat(4097) },
    { evidence: { kind: "runtime_exception", errno: "UNTRUSTED_PROVIDER_TEXT" } },
  ])("refuses private or overlarge input before HTTP %#", async (patch) => {
    const f = fixture();
    await expect(
      f.client.submitRuntimeFailure("instance", { ...failure(), ...patch }),
    ).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("refreshes authentication without changing the frozen event identity or bytes", async () => {
    const value = failure();
    const f = fixture();
    await f.client.submitRuntimeFailure("instance", value);
    f.rotate();
    await f.client.submitRuntimeFailure("instance", value);
    const first = f.fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    const second = f.fetchFn.mock.calls[1]! as unknown as [string, RequestInit];
    expect(second[1].body).toBe(first[1].body);
    expect(new Headers(second[1].headers).get("idempotency-key")).toBe(
      new Headers(first[1].headers).get("idempotency-key"),
    );
    expect(new Headers(second[1].headers).get("authorization")).toBe("Bearer next-fixture-lease");
  });
});
