import { describe, expect, it } from "vitest";
import * as decoder from "../lease/lease.js";
const claims = { iss: "konteks:control-plane", aud: "konteks:remote-instance:lease", sub: "instance", workspace_id: "tenant", jti: "lease", iat: 1788652800, exp: 1788652860, protocol: "1.0", bundle_version: "1.0.0", deployment_kind: "native_connector", components: ["agent_runner"], ownership_scope: "personal", administrative_status: "active", lease_mode: "active" };
const token = (body: object) => `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.not-a-real-signature`;
const expected = { instanceId: "instance", audience: "konteks:remote-instance:lease", deploymentKind: "native_connector" as const };
describe("canonical native lease decoding (not signature verification)", () => {
  it("accepts actual Core claims and normalizes only local deadline scheduling", () => {
    const body = { ...claims, lease_mode: "drain_only", drain_deadline: "2026-09-06T00:02:00.123Z" };
    const parsed = decoder.decodeLeaseClaims(token(body), expected);
    expect(parsed.administrative_status).toBe("active");
    expect(decoder.leaseRecordFromClaims(token(body), parsed).drainDeadline).toBe(body.drain_deadline);
  });
  it.each([{ iss: "foreign" }, { administrative_status: undefined }, { administrative_state: "active" }, { extra: true }, { exp: claims.iat }, { components: ["agent_runner", "agent_runner"] }, { lease_mode: "drain_only", drain_deadline: claims.exp + 60 }])("rejects noncanonical live metadata %j", patch => {
    expect(() => decoder.decodeLeaseClaims(token({ ...claims, ...patch }), expected)).toThrow();
  });
  it("confines numeric deadline compatibility to stored records without changing token bytes", () => {
    const historical = token({ ...claims, lease_mode: "drain_only", drain_deadline: claims.exp + 60 });
    const parsed = decoder.decodeStoredLeaseClaims(historical, expected);
    expect(decoder.leaseRecordFromClaims(historical, parsed).lease).toBe(historical);
    expect(parsed.drain_deadline).toBe(claims.exp + 60);
  });
});
