import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixedClock, computeRemoteFileTreeDigest } from "@konteks/remote-common";
import {
  RuntimeSkillSyncEnvelopeSchema,
  computeRuntimeSkillSyncCatalogDigest,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { CoreClient } from "../core/client.js";

const instanceId = "instance-a";
const content = Buffer.from("---\nname: fixture\ndescription: fixture\n---\n");
const entries = [
  {
    path: "SKILL.md" as const,
    mode: 0o600 as const,
    sizeBytes: content.length,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    contentBase64: content.toString("base64"),
  },
];
const tree = {
  format: "konteks-file-tree-v1" as const,
  entries,
  treeDigest: computeRemoteFileTreeDigest(entries),
};
const binding = { workspaceId: "tenant-a", instanceId, syncId: "sync-a" };
const catalog = {
  version: 1 as const,
  complete: true as const,
  binding,
  catalogRevision: `sha256:${"a".repeat(64)}`,
  skills: [
    {
      skillId: "04c6eb8c-244b-4f73-92cc-2f1956be4995",
      version: "1.0.0",
      name: "fixture",
      description: "fixture",
      treeDigest: tree.treeDigest,
      sizeBytes: content.length,
      fileCount: 1,
    },
  ],
};
const envelope = RuntimeSkillSyncEnvelopeSchema.parse({
  type: "runtime_skill_sync",
  instanceId,
  catalog,
  catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog),
  issuedAt: "2026-10-13T00:00:00.000Z",
  expiresAt: "2026-10-13T00:01:00.000Z",
  signature: Buffer.alloc(64).toString("base64url"),
});

describe("Core runtime Skill sync client", () => {
  it("uses the lease-authenticated prepare, read and authorize routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const body = url.endsWith("/prepare")
        ? envelope
        : url.endsWith("/read")
          ? tree
          : { authorized: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = new CoreClient({
      baseUrl: "https://core.example",
      clock: new FixedClock(Date.parse(envelope.issuedAt)),
      key: () => {
        throw new Error("Skill sync must not make an instance-key proof");
      },
      credential: () => "lease-token",
      fetchFn,
    });

    const current = await client.prepareRuntimeSkillSync(instanceId);
    await client.readRuntimeSkillSync(instanceId, current, catalog.skills[0]!.skillId);
    await client.authorizeRuntimeSkillSync(instanceId, current);

    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining(`/skills/sync/prepare`),
      expect.stringContaining(`/skills/sync/read`),
      expect.stringContaining(`/skills/sync/authorize`),
    ]);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer lease-token");
      expect(new Headers(call.init.headers).get("idempotency-key")).toBeTruthy();
    }
  });

  it("refuses to read or authorize an envelope for another runtime", async () => {
    const fetchFn: typeof fetch = async () => new Response("{}", { status: 200 });
    const client = new CoreClient({
      baseUrl: "https://core.example",
      clock: new FixedClock(Date.parse(envelope.issuedAt)),
      key: () => {
        throw new Error("Skill sync must not make an instance-key proof");
      },
      credential: () => "lease-token",
      fetchFn,
    });
    const foreignBinding = { ...binding, instanceId: "instance-b" };
    const foreignCatalog = { ...catalog, binding: foreignBinding };
    const foreign = RuntimeSkillSyncEnvelopeSchema.parse({
      ...envelope,
      instanceId: "instance-b",
      catalog: foreignCatalog,
      catalogDigest: computeRuntimeSkillSyncCatalogDigest(foreignCatalog),
    });
    await expect(
      client.readRuntimeSkillSync(instanceId, foreign, catalog.skills[0]!.skillId),
    ).rejects.toMatchObject({ code: "registration_mismatch" });
    await expect(client.authorizeRuntimeSkillSync(instanceId, foreign)).rejects.toMatchObject({
      code: "registration_mismatch",
    });
  });

  it("sends confirmed unsharing over the lease-authenticated Core route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new CoreClient({
      baseUrl: "https://core.example",
      clock: new FixedClock(Date.parse(envelope.issuedAt)),
      key: () => {
        throw new Error("Skill unsharing must not make an instance-key proof");
      },
      credential: () => "lease-token",
      fetchFn: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ unshared: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(
      client.unshareRuntimeSkillSync(instanceId, { localId: "a".repeat(64), confirm: true }),
    ).resolves.toEqual({ unshared: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/skills/sync/unshare`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      localId: "a".repeat(64),
      confirm: true,
    });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer lease-token");
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBeTruthy();
  });

  it("accepts the server's publication change kind over the Core route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new CoreClient({
      baseUrl: "https://core.example",
      clock: new FixedClock(Date.parse(envelope.issuedAt)),
      key: () => {
        throw new Error("Skill sharing must not make an instance-key proof");
      },
      credential: () => "lease-token",
      fetchFn: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            id: catalog.skills[0]!.skillId,
            name: "org-fixture",
            acceptedVersion: "1.0.1",
            changeKind: "scope_changed",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const share = {
      localId: "a".repeat(64),
      publication: {
        audience: { kind: "organization" as const },
        context: { kind: "global" as const },
        confirmOngoingPublication: true as const,
      },
      tree,
    };

    await expect(client.shareRuntimeSkillSync(instanceId, share)).resolves.toEqual({
      id: catalog.skills[0]!.skillId,
      name: "org-fixture",
      acceptedVersion: "1.0.1",
      changeKind: "scope_changed",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/skills/sync/share`);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      localId: share.localId,
      publication: share.publication,
      tree,
    });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer lease-token");
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBeTruthy();
  });
});
