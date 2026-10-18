import { describe, expect, it } from "vitest";
import { sign as ed25519Sign } from "node:crypto";
import { generateEd25519, remoteControlSigningBytes } from "@konteks/remote-common";
import {
  computeRuntimeSkillSyncCatalogDigest, RuntimeSkillSyncEnvelopeSchema, runtimeSkillSyncSigningBytes,
  RuntimeSkillCatalogChangedSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { CoreSignatureVerifier } from "../control/core-signature.js";
// Cross-repository interoperability proof: the actual Core producer beside the
// actual connector consumer. It runs only next to a Core checkout; the public
// repository ships without one, so the proof is skipped there, never faked.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const CORE_SIGNING_SERVICE = fileURLToPath(new URL("../../../../../core/plugins/remote-instance-backend/src/services/CoreControlSigningService.ts", import.meta.url));
const coreSigning: { CoreControlSigningService: new (options: never) => {
  sign(payload: Record<string, unknown>): Promise<unknown>;
  signRuntimeSkillCatalogChanged(payload: Record<string, unknown>): Promise<string>;
} } | null =
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

describe("Core-signed runtime Skill catalogs", () => {
  it("verifies the dedicated signature and refuses changed or foreign catalogs", () => {
    const key = generateEd25519();
    const root = {
      keyId: "release",
      publicKeyJwk: generateEd25519().publicJwk,
      coreControlKeys: [{ keyId: "control-1", publicKeyJwk: key.publicJwk }],
    };
    const binding = { workspaceId: "tenant-a", instanceId: "instance-a", syncId: "sync-a" };
    const catalog = { version: 1 as const, complete: true as const, binding, catalogRevision: `sha256:${"a".repeat(64)}`, skills: [] };
    const body = {
      type: "runtime_skill_sync" as const,
      instanceId: binding.instanceId,
      catalog,
      catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog),
      issuedAt: "2026-10-13T00:00:00.000Z",
      expiresAt: "2026-10-13T00:01:00.000Z",
    };
    const unsigned = RuntimeSkillSyncEnvelopeSchema.parse({ ...body, signature: "A".repeat(86) });
    const signature = ed25519Sign(null, runtimeSkillSyncSigningBytes(unsigned), key.privateKey).toString("base64url");
    const verifier = new CoreSignatureVerifier([root]);
    const envelope = { ...body, signature };

    expect(verifier.verifyRuntimeSkillSyncEnvelope(envelope, binding.instanceId)).toBe(true);
    expect(verifier.verifyRuntimeSkillSyncEnvelope({ ...envelope, catalog: { ...catalog, binding: { ...binding, workspaceId: "tenant-b" } } }, binding.instanceId)).toBe(false);
    expect(verifier.verifyRuntimeSkillSyncEnvelope(envelope, "another-instance")).toBe(false);
    expect(new CoreSignatureVerifier([{ ...root, coreControlKeys: [] }]).verifyRuntimeSkillSyncEnvelope(envelope, binding.instanceId)).toBe(false);
  });
});

describe("Core-signed runtime Skill catalog change hints", () => {
  it.skipIf(coreSigning === null)("verifies Core's signed bounded notice and rejects tenant, instance, and revision tampering", async () => {
    const f = fixture();
    const now = Date.now();
    const body = {
      type: "runtime_skill_catalog_changed" as const,
      workspaceId: "tenant-a",
      instanceId: "instance-a",
      notificationId: "notice-a",
      catalogRevision: `sha256:${"a".repeat(64)}`,
      changeKind: "updated" as const,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    };
    const signature = await f.signer.signRuntimeSkillCatalogChanged(body);
    RuntimeSkillCatalogChangedSchema.parse({ ...body, signature });
    const notice = { ...body, signature };

    expect(f.verifier.verifyRuntimeSkillCatalogChanged(notice)).toBe(true);
    expect(f.verifier.verifyRuntimeSkillCatalogChanged({ ...notice, workspaceId: "tenant-b" })).toBe(false);
    expect(f.verifier.verifyRuntimeSkillCatalogChanged({ ...notice, instanceId: "instance-b" })).toBe(false);
    expect(f.verifier.verifyRuntimeSkillCatalogChanged({ ...notice, catalogRevision: `sha256:${"b".repeat(64)}` })).toBe(false);
    expect(f.verifier.verifyRuntimeSkillCatalogChanged({ ...notice, skillContents: "must never be delivered" })).toBe(false);
    expect(new CoreSignatureVerifier([{ ...f.root, coreControlKeys: [] }]).verifyRuntimeSkillCatalogChanged(notice)).toBe(false);
  });
});
describe.skipIf(coreSigning === null)("site-started agent login delivery", () => {
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

describe.skipIf(coreSigning === null)("site-started fixed runtime update delivery", () => {
  const unsigned = { type: "runtime_update_delivery", method: "POST", path: { instanceId: "instance" }, nodeId: "node",
    connectionRef: "connection", connectionEpoch: 3, keyId: "control-1", nonce: "A".repeat(22),
    intent: { updateId: "update", tenantId: "tenant", instanceId: "instance", leaseId: "lease", runnerIncarnation: "runner",
      targetBundle: "1.1.0", manifestDigest: "a".repeat(43), deadlineAt: "2026-10-01T00:30:00.000Z" },
    issuedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:10.000Z" };
  it("accepts the actual Core producer and refuses changed owner, target, signing key or executable input", async () => {
    const f = fixture();
    const signature = await f.signer.sign(unsigned) as string;
    expect(f.verifier.verifyRuntimeUpdateDelivery({ ...unsigned, signature })).toBe(true);
    for (const change of [{ updateId: "other" }, { leaseId: "other" }, { runnerIncarnation: "other" }, { targetBundle: "1.2.0" }, { manifestDigest: "b".repeat(43) }]) {
      expect(f.verifier.verifyRuntimeUpdateDelivery({ ...unsigned, intent: { ...unsigned.intent, ...change }, signature })).toBe(false);
    }
    expect(f.verifier.verifyRuntimeUpdateDelivery({ ...unsigned, keyId: "other", signature })).toBe(false);
    expect(f.verifier.verifyRuntimeUpdateDelivery({ ...unsigned, command: "arbitrary", signature })).toBe(false);
    expect(f.verifier.verifyRuntimeUpdateDelivery({ ...unsigned, url: "https://other.example", signature })).toBe(false);
    expect(f.verifier.verifyRuntimeUpdateDelivery({ ...unsigned, signature: `${signature}==` })).toBe(false);
  });
});
describe("assignment-available nudge delivery", () => {
  const unsigned = {
    type: "runtime_assignment_available_delivery", method: "POST", path: { instanceId: "instance" }, nodeId: "node-1",
    connectionRef: "conn-1", connectionEpoch: 3, keyId: "control-1", nonce: "A".repeat(22),
    intent: { tenantId: "tenant", instanceId: "instance", queuedAt: "2026-10-11T02:06:02.400Z" },
    issuedAt: "2026-10-11T02:06:02.500Z", expiresAt: "2026-10-11T02:06:12.500Z",
  };
  // Signed here with the contract's own signing bytes: the Core beside this
  // checkout may not know the 7.9.0 delivery yet.
  it("accepts a signed nudge and rejects one moved to another runtime or key", () => {
    const key = generateEd25519();
    const verifier = new CoreSignatureVerifier([{ keyId: "release", publicKeyJwk: generateEd25519().publicJwk, coreControlKeys: [{ keyId: "control-1", publicKeyJwk: key.publicJwk }] }]);
    const signature = ed25519Sign(null, remoteControlSigningBytes(unsigned), key.privateKey).toString("base64url");
    expect(verifier.verifyAssignmentAvailableDelivery({ ...unsigned, signature })).toBe(true);
    expect(verifier.verifyAssignmentAvailableDelivery({ ...unsigned, intent: { ...unsigned.intent, tenantId: "other" }, signature })).toBe(false);
    expect(verifier.verifyAssignmentAvailableDelivery({ ...unsigned, keyId: "control-2", signature })).toBe(false);
    expect(verifier.verifyAssignmentAvailableDelivery({ ...unsigned, signature: `${signature}==` })).toBe(false);
  });
});
