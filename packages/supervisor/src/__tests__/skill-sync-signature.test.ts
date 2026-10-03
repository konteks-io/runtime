import { expect, it } from "vitest";
import { sign } from "node:crypto";
import { generateEd25519 } from "@konteks/remote-common";
import { computeRuntimeSkillSyncCatalogDigest, runtimeSkillSyncSigningBytes, runtimeSkillSyncRequestSigningBytes } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { CoreSignatureVerifier } from "../control/core-signature.js";
it("verifies only the dedicated machine Skill domain under release-certified Core keys", () => {
  const key = generateEd25519();
  const root = { keyId: "release", publicKeyJwk: generateEd25519().publicJwk, coreControlKeys: [{ keyId: "core", publicKeyJwk: key.publicJwk }] };
  const catalog = { version: 1, complete: true, binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills: [] };
  const body = { type: "runtime_skill_sync", instanceId: "machine-a", catalog, catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: "2026-10-03T00:00:00.000Z", expiresAt: "2026-10-03T00:01:00.000Z" };
  const signature = sign(null, runtimeSkillSyncSigningBytes(body), key.privateKey).toString("base64url");
  const envelope = { ...body, signature }; const verifier = new CoreSignatureVerifier([root]);
  expect(verifier.verifyRuntimeSkillSync(envelope)).toBe(true);
  expect(verifier.verifyRuntimeSkillSync({ ...envelope, instanceId: "machine-b" })).toBe(false);
  expect(verifier.verifyRuntimeSkillSync({ ...envelope, signature: signature + "=" })).toBe(false);
  expect(new CoreSignatureVerifier([]).verifyRuntimeSkillSync(envelope)).toBe(false);
  expect(verifier.verify(envelope, signature)).toBe(false);
});
it("verifies manual requests independently from catalog and ordinary control signatures", () => {
  const key = generateEd25519();
  const root = { keyId: "release", publicKeyJwk: generateEd25519().publicJwk, coreControlKeys: [{ keyId: "core", publicKeyJwk: key.publicJwk }] };
  const body = { type: "runtime_skill_sync_request", workspaceId: "tenant-a", instanceId: "machine-a", requestId: "manual-a", issuedAt: "2026-10-03T00:00:00Z", expiresAt: "2026-10-03T00:01:00Z" };
  const signature = sign(null, runtimeSkillSyncRequestSigningBytes(body), key.privateKey).toString("base64url");
  const request = { ...body, signature }, verifier = new CoreSignatureVerifier([root]);
  expect(verifier.verifyRuntimeSkillSyncRequest(request)).toBe(true);
  for (const changed of [{ workspaceId: "tenant-b" }, { instanceId: "machine-b" }, { requestId: "manual-b" }, { signature: signature + "=" }]) {
    expect(verifier.verifyRuntimeSkillSyncRequest({ ...request, ...changed })).toBe(false);
  }
  expect(new CoreSignatureVerifier([]).verifyRuntimeSkillSyncRequest(request)).toBe(false);
  expect(verifier.verifyRuntimeSkillSync(request)).toBe(false);
  expect(verifier.verify(request, signature)).toBe(false);
});
