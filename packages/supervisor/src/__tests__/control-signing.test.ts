import { describe, expect, it } from "vitest";
import { generateEd25519 } from "@konteks/remote-common";
import { CoreSignatureVerifier } from "../control/core-signature.js";
// Workspace interoperability proof: actual Core producer, actual connector consumer.
import { CoreControlSigningService } from "../../../../../core/plugins/remote-instance-backend/src/services/CoreControlSigningService";

const body = { type: "drain", instanceId: "instance", reason: "user", issuedAt: "2026-09-06T00:00:00Z" };
function fixture(keyId = "control-1") {
  const key = generateEd25519();
  const descriptor = { keyId, publicKeyJwk: key.publicJwk };
  const stored = { keyId: descriptor.keyId, key: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const signer = new CoreControlSigningService({ vault: { retrieveSecret: async () => ({ value: stored }) }, cluster: "local", key: descriptor });
  const root = { keyId: "release", publicKeyJwk: generateEd25519().publicJwk, coreControlKeys: [descriptor] };
  return { signer, root, verifier: new CoreSignatureVerifier([root]) };
}
describe("Core/connector detached control signatures", () => {
  it("accepts real Core output and rejects body tampering, padded signatures and unknown commands", async () => {
    const f = fixture();
    const signature = await f.signer.sign(body);
    expect(f.verifier.verify({ ...body, signature }, signature)).toBe(true);
    expect(f.verifier.verify({ ...body, instanceId: "another" }, signature)).toBe(false);
    expect(f.verifier.verify(body, `${signature}==`)).toBe(false);
    expect(f.verifier.verify({ ...body, command: "arbitrary" }, signature)).toBe(false);
    expect(f.verifier.verify(body, "header.payload.signature")).toBe(false);
  });
  it("supports explicit key overlap and rejects retired or conflicting key identities", async () => {
    const old = fixture();
    const next = fixture("control-2");
    const overlap = new CoreSignatureVerifier([{ ...old.root, coreControlKeys: [...old.root.coreControlKeys, ...next.root.coreControlKeys] }]);
    const oldSignature = await old.signer.sign(body);
    const nextSignature = await next.signer.sign(body);
    expect(overlap.verify(body, oldSignature)).toBe(true);
    expect(overlap.verify(body, nextSignature)).toBe(true);
    expect(new CoreSignatureVerifier([next.root]).verify(body, oldSignature)).toBe(false);
    expect(new CoreSignatureVerifier([{ ...old.root, coreControlKeys: [] }]).verify(body, oldSignature)).toBe(false);
    expect(() => new CoreSignatureVerifier([{ ...old.root, coreControlKeys: [old.root.coreControlKeys[0]!, { ...next.root.coreControlKeys[0]!, keyId: "control-1" }] }])).toThrow();
  });
});
