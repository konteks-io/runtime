import { expect, it, vi } from "vitest";
import { createHash, sign } from "node:crypto";
import { generateEd25519 } from "@konteks/remote-common";
import { computeRemoteFileTreeDigest, computeRuntimeSkillSyncCatalogDigest, runtimeSkillSyncSigningBytes, runtimeSkillSyncRequestSigningBytes, localSkillExportSigningBytes } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { NativeSkillSyncClient, NativeSkillSyncTransportFailure } from "../native/skill-sync-client.js";
function fixture() {
  const key = generateEd25519(); const now = Date.now();
  const catalog = { version: 1, complete: true, binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills: [] };
  const body = { type: "runtime_skill_sync", instanceId: "machine-a", catalog, catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
  const envelope = { ...body, signature: sign(null, runtimeSkillSyncSigningBytes(body), key.privateKey).toString("base64url") };
  const fetchFn = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } }));
  const options = { coreContractVersion: () => "7.5", baseUrl: "https://core.test", roots: [{ keyId: "release", publicKeyJwk: key.publicJwk, coreControlKeys: [{ keyId: "core", publicKeyJwk: key.publicJwk }] }], identity: () => ({ workspaceId: "tenant-a", instanceId: "machine-a" }), credential: () => "lease", now: () => now, fetchFn };
  return { key, body, envelope, fetchFn, options, client: new NativeSkillSyncClient(options) };
}
it("retains only the HTTP status for local transport diagnostics", async () => {
  const f = fixture();
  f.fetchFn.mockImplementation(async () => new Response("secret proof artifact /private", { status: 503 }));
  const error = await f.client.prepare().catch(value => value);
  expect(error).toBeInstanceOf(NativeSkillSyncTransportFailure);
  expect(error.httpStatus).toBe(503);
  expect(error.message).toBe("Organization Skill synchronization is unavailable");
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toMatch(/secret|proof|artifact|private/);
});
it("prepares a signed organization snapshot without assignment or caller identity", async () => {
  const f = fixture(); expect(await f.client.prepare()).toEqual(f.envelope);
  expect(f.fetchFn.mock.calls[0]).toEqual(["https://core.test/api/remote-instances/internal/remote-instances/machine-a/skills/sync/prepare", expect.objectContaining({ body: "{}", redirect: "error", credentials: "omit", headers: expect.objectContaining({ authorization: "Bearer lease" }) })]);
});
it("refuses a foreign organization and expired envelope", async () => {
  const f = fixture();
  await expect(new NativeSkillSyncClient({ ...f.options, identity: () => ({ workspaceId: "tenant-b", instanceId: "machine-a" }) }).prepare()).rejects.toThrow("unavailable");
  await expect(new NativeSkillSyncClient({ ...f.options, now: () => Date.now() + 120000 }).prepare()).rejects.toThrow("unavailable");
});
it("requires fresh Core approval before publication", async () => {
  const f = fixture(); f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } }));
  await f.client.authorize(f.envelope);
  expect(f.fetchFn.mock.calls[0]?.[0]).toContain("/authorize");
  f.fetchFn.mockImplementation(async () => new Response("private failure", { status: 503 }));
  await expect(f.client.authorize(f.envelope)).rejects.toThrow("unavailable");
});

it("reads only selected immutable files and rejects a changed tree", async () => {
  const f = fixture(); const content = Buffer.from("# Skill");
  const entries = [{ path: "SKILL.md", mode: 0o600 as const, sizeBytes: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") }];
  const tree = { format: "konteks-file-tree-v1", entries, treeDigest: computeRemoteFileTreeDigest(entries) };
  const skill = { skillId: "11111111-1111-4111-8111-111111111111", name: "org-example", description: "Example", version: "1.0.0", treeDigest: tree.treeDigest, sizeBytes: content.length, fileCount: 1 };
  const catalog = { ...f.body.catalog, skills: [skill] };
  const body = { ...f.body, catalog, catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog) };
  const envelope = { ...body, signature: sign(null, runtimeSkillSyncSigningBytes(body), f.key.privateKey).toString("base64url") };
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify(tree), { headers: { "content-type": "application/json" } }));
  expect(await f.client.read(envelope, skill.skillId)).toEqual(tree);
  const count = f.fetchFn.mock.calls.length;
  await expect(f.client.read(envelope, "22222222-2222-4222-8222-222222222222")).rejects.toThrow("unavailable");
  expect(f.fetchFn).toHaveBeenCalledTimes(count);
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ ...tree, treeDigest: `sha256:${"f".repeat(64)}` }), { headers: { "content-type": "application/json" } }));
  await expect(f.client.read(envelope, skill.skillId)).rejects.toThrow("unavailable");
});
it("holds transport capacity until a canceled non-cooperative fetch settles", async () => {
  const f = fixture(); let finish!: (value: Response) => void;
  f.fetchFn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const abort = new AbortController(); const pending = f.client.prepare(abort.signal);
  abort.abort(); await expect(pending).rejects.toThrow("unavailable");
  await expect(f.client.prepare()).rejects.toThrow("unavailable"); expect(f.fetchFn).toHaveBeenCalledTimes(1);
  const cancel = vi.fn(); const response = new Response(new ReadableStream({ cancel }));
  finish(response); await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancel).toHaveBeenCalledTimes(1);
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify(f.envelope), { headers: { "content-type": "application/json" } }));
  expect(await f.client.prepare()).toEqual(f.envelope);
});
it.each([
  { status: 206, headers: { "content-type": "application/json" } },
  { status: 200, headers: { "content-type": "text/plain" } },
  { status: 200, headers: { "content-type": "application/json", "content-range": "bytes 0-2/3" } },
])("rejects partial or non-JSON responses", async init => {
  const f = fixture(); f.fetchFn.mockImplementation(async () => new Response(JSON.stringify(f.envelope), init));
  await expect(f.client.prepare()).rejects.toThrow("unavailable");
});

it("retrieves only a signed current machine manual request", async () => {
  const f = fixture();
  const body = { type: "runtime_skill_sync_request", workspaceId: "tenant-a", instanceId: "machine-a", requestId: "manual", issuedAt: f.body.issuedAt, expiresAt: new Date(f.options.now() + 30000).toISOString() };
  const request = { ...body, signature: sign(null, runtimeSkillSyncRequestSigningBytes(body), f.key.privateKey).toString("base64url") };
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ request }), { headers: { "content-type": "application/json" } }));
  expect(await f.client.pendingRequest()).toEqual(request);
  expect(f.fetchFn.mock.calls[0]?.[0]).toContain("/request");
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ request: { ...request, workspaceId: "foreign" } }), { headers: { "content-type": "application/json" } }));
  await expect(f.client.pendingRequest()).rejects.toThrow("unavailable");
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ request: null }), { headers: { "content-type": "application/json" } }));
  expect(await f.client.pendingRequest()).toBeNull();
});
it("reports closed receipts without caller-selected machine authority", async () => {
  const f = fixture(); f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ accepted: true }), { headers: { "content-type": "application/json" } }));
  expect(await f.client.receipt({ requestId: "manual", state: "succeeded" })).toBe(true);
  expect(f.fetchFn.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ requestId: "manual", state: "succeeded" }));
  await expect(f.client.receipt({ requestId: "manual", state: "accepted", workspaceId: "foreign" } as never)).rejects.toThrow("unavailable");
  expect(f.fetchFn).toHaveBeenCalledTimes(1);
});

it.each([undefined, "7.4", "invalid"])("does not contact unsupported Core %s", async version => {
  const f = fixture();
  const client = new NativeSkillSyncClient({ ...f.options, coreContractVersion: () => version });
  await expect(client.prepare()).rejects.toThrow("unavailable");
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it("accepts only signed tenant-bound local export selections and refuses stale authority", async () => {
  const f = fixture();
  const body = { type: "runtime_skill_export", workspaceId: "tenant-a", instanceId: "machine-a", requestId: "export-a", localId: "a".repeat(64), treeDigest: `sha256:${"b".repeat(64)}`, issuedAt: f.body.issuedAt, expiresAt: f.body.expiresAt };
  const request = { ...body, signature: sign(null, localSkillExportSigningBytes(body), f.key.privateKey).toString("base64url") };
  f.fetchFn.mockImplementation(async () => new Response(JSON.stringify({ request }), { headers: { "content-type": "application/json" } }));
  expect(await f.client.pendingLocalExport()).toEqual(request);
  expect(() => new NativeSkillSyncClient({ ...f.options, identity: () => ({ workspaceId: "other", instanceId: "machine-a" }) }).assertLocalExport(request)).toThrow();
  expect(() => new NativeSkillSyncClient({ ...f.options, now: () => NaN }).assertLocalExport(request)).toThrow();
  expect(() => new NativeSkillSyncClient({ ...f.options, now: () => Date.parse(body.expiresAt) }).assertLocalExport(request)).toThrow();
  expect(() => f.client.assertLocalExport({ ...request, localId: "c".repeat(64) })).toThrow();
});
