import { describe, expect, it } from "vitest";
import { generateEd25519 } from "@konteks/remote-common";
import { CoreSignatureVerifier } from "../control/core-signature.js";
// Cross-repository interoperability proof: the actual Core producer beside the
// actual connector consumer. It runs only next to a Core checkout; the public
// repository ships without one, so the proof is skipped there, never faked.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const CORE_SIGNING_SERVICE = fileURLToPath(new URL("../../../../../core/plugins/remote-instance-backend/src/services/CoreControlSigningService.ts", import.meta.url));
const coreSigning: { CoreControlSigningService: new (options: never) => { sign(payload: Record<string, unknown>): Promise<unknown> } } | null =
  existsSync(CORE_SIGNING_SERVICE) ? await import(CORE_SIGNING_SERVICE) : null;

const body = { type: "drain", instanceId: "instance", reason: "user", issuedAt: "2026-09-06T00:00:00Z" };
function fixture(keyId = "control-1") {
  const key = generateEd25519();
  const descriptor = { keyId, publicKeyJwk: key.publicJwk };
  const stored = { keyId: descriptor.keyId, key: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const signer = new coreSigning!.CoreControlSigningService({ vault: { retrieveSecret: async () => ({ value: stored }) }, cluster: "local", key: descriptor } as never);
  const root = { keyId: "release", publicKeyJwk: generateEd25519().publicJwk, coreControlKeys: [descriptor] };
  return { signer, root, verifier: new CoreSignatureVerifier([root]) };
}
describe.skipIf(coreSigning === null)("Core/connector detached control signatures", () => {
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
describe.skipIf(coreSigning === null)("site-started agent login delivery (WS1-115)", () => {
  const unsigned = {
    type: "runtime_agent_login_delivery", method: "POST", path: { instanceId: "instance" }, nodeId: "node-1",
    connectionRef: "conn-1", connectionEpoch: 3, keyId: "control-1", nonce: "A".repeat(22),
    intent: { loginId: "login-1", tenantId: "tenant", instanceId: "instance", agentId: "codex", action: "start" },
    issuedAt: "2026-09-24T05:00:00.000Z", expiresAt: "2026-09-24T05:00:10.000Z",
  };
  it("accepts Core's signed start and rejects a changed login, agent or key", async () => {
    const f = fixture();
    const signature = await f.signer.sign(unsigned) as string;
    expect(f.verifier.verifyAgentLoginDelivery({ ...unsigned, signature })).toBe(true);
    expect(f.verifier.verifyAgentLoginDelivery({ ...unsigned, intent: { ...unsigned.intent, loginId: "login-2" }, signature })).toBe(false);
    expect(f.verifier.verifyAgentLoginDelivery({ ...unsigned, intent: { ...unsigned.intent, action: "cancel" }, signature })).toBe(false);
    expect(f.verifier.verifyAgentLoginDelivery({ ...unsigned, intent: { ...unsigned.intent, agentId: "claude-code" }, signature })).toBe(false);
    expect(f.verifier.verifyAgentLoginDelivery({ ...unsigned, keyId: "control-2", signature })).toBe(false);
    expect(f.verifier.verifyAgentLoginDelivery({ ...unsigned, signature: `${signature}==` })).toBe(false);
  });
});
