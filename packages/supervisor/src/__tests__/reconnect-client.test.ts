import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";

const claims = { iss: "konteks:control-plane", aud: "konteks:remote-instance:lease", sub: "instance", workspace_id: "tenant", jti: "lease", iat: 1788652800, exp: 1788652860, protocol: "1.0", bundle_version: "1.0.0", deployment_kind: "native_connector", components: ["agent_runner"], ownership_scope: "personal", administrative_status: "active", lease_mode: "active" };
// Synthetic payload for response compatibility, not JWS verification evidence.
const token = (body: object) => `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.synthetic-signature`;
const manifest = { instanceId: "instance", runnerIncarnation: "process", reconnectIntentId: "intent", ownerRevision: 1, applyDeadlineAt: "2026-09-06T00:01:00Z", acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 2, lease: token(claims), manifestId: "manifest", issuedAt: "2026-09-06T00:00:00Z", decisions: [], pendingClaimDecisions: [] };
const request = { instanceId: "instance", runnerIncarnation: "process", reconnectIntentId: "intent", establishment: { expectedOwnerRevision: 0, expectedCurrentIncarnation: null }, connection: { kind: "https" as const }, lastHeartbeatSequence: 2, bundleVersion: "1.0.0", protocolVersion: "1.0", claims: [], pendingClaims: [] };
function fixture(response: object, credential: () => string | null = () => null) {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200 }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(claims.iat * 1000), key: () => key, credential, fetchFn });
  return { client, fetchFn, key };
}

describe("canonical reconnect HTTP response", () => {
  it("establishes with a fresh exact machine proof without requiring a predecessor bearer", async () => {
    const credential = vi.fn(() => { throw new Error("expired predecessor"); });
    const f = fixture(manifest, credential);
    await f.client.reconnect(request); await f.client.reconnect(request);
    const { proof, ...body } = JSON.parse(String(f.fetchFn.mock.calls[0]![1]?.body));
    expect(verifyInstanceProof(f.key.publicKey, { method: "reconnect", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
    expect(JSON.parse(String(f.fetchFn.mock.calls[1]![1]?.body)).proof.nonce).not.toBe(proof.nonce);
    expect(credential).not.toHaveBeenCalled();
  });

  it.each(["runnerIncarnation", "reconnectIntentId"])("rejects another %s even for the same machine", async key => {
    await expect(fixture({ ...manifest, [key]: "foreign" }).client.reconnect(request)).rejects.toMatchObject({ code: "registration_mismatch" });
  });

  it.each([{ extra: true }, { runnerIncarnation: "" }, { establishment: undefined }, { connection: undefined }])("rejects malformed request before I/O: %j", async patch => {
    const f = fixture(manifest);
    await expect(f.client.reconnect({ ...request, ...patch } as never)).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("compares against the detached signed request despite caller mutation during I/O", async () => {
    const f = fixture(manifest); const input = structuredClone(request);
    f.fetchFn.mockImplementationOnce(async () => { input.instanceId = "foreign"; input.reconnectIntentId = "changed"; return new Response(JSON.stringify(manifest)); });
    await expect(f.client.reconnect(input)).resolves.toMatchObject({ manifest });
  });

  it("consumes Core's flat manifest and derives internal lease scheduling from its claims", async () => {
    const f = fixture(manifest);
    await expect(f.client.reconnect(request)).resolves.toEqual({ lease: manifest.lease, leaseExpiresAt: "2026-09-06T00:01:00.000Z", manifest });
    expect(String(f.fetchFn.mock.calls[0]![0])).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/reconnect");
    expect(JSON.parse(String(f.fetchFn.mock.calls[0]![1]?.body))).toMatchObject({ ...request, proof: { algorithm: "ES256" } });
  });

  it.each([
    { ...manifest, instanceId: "foreign" },
    { ...manifest, lease: token({ ...claims, sub: "foreign" }) },
    { ...manifest, lease: token({ ...claims, exp: claims.iat }) },
    { ...manifest, lease: "" },
    { ...manifest, leaseExpiresAt: "2026-09-06T01:00:00Z" },
    { lease: manifest.lease, leaseExpiresAt: "2026-09-06T00:01:00Z", manifest },
  ])("rejects foreign, invalid and obsolete wrapper responses", async response => {
    await expect(fixture(response).client.reconnect(request)).rejects.toThrow();
  });
});
