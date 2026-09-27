import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyedFingerprint } from "../digest.js";
import { AgentModelOfferedValuesSnapshotSchema, catalogueModelAuthority, computeAgentModelOfferedValuesSnapshotDigest } from "../contracts.js";

describe("keyed identity fingerprints", () => {
  it("keeps HMAC fingerprints valid as opaque snapshot identifiers", () => {
    const key = Buffer.alloc(32);
    for (const [identity, initial] of [["identity-28", "_"], ["identity-53", "-"]]) {
      expect(createHmac("sha256", key).update(identity).digest("base64url").startsWith(initial)).toBe(true);
      const fingerprint = keyedFingerprint(key, identity);
      expect(fingerprint).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
      expect(fingerprint).toBe(keyedFingerprint(key, identity));

      const body = {
        version: 1 as const, snapshotId: "snapshot", snapshotRevision: 1,
        instanceId: "instance", agentId: "dsh", authIdentityFingerprint: fingerprint,
        runnerIncarnation: "incarnation", manifestId: "manifest", ...catalogueModelAuthority("dsh"),
        currentValue: '["deepseek-official","deepseek-flash"]',
        offeredValues: ['["deepseek-official","deepseek-flash"]'],
        observedAt: "2026-09-27T00:00:00Z", expiresAt: "2026-09-27T00:05:00Z",
      };
      expect(AgentModelOfferedValuesSnapshotSchema.safeParse({
        ...body, snapshotDigest: computeAgentModelOfferedValuesSnapshotDigest(body),
      }).success).toBe(true);
    }
  });

  it("preserves existing fingerprints that already begin with an alphanumeric character", () => {
    const key = Buffer.alloc(32);
    const digest = createHmac("sha256", key).update("identity-0").digest("base64url");
    expect(digest).toMatch(/^[A-Za-z0-9]/);
    expect(keyedFingerprint(key, "identity-0")).toBe(digest);
  });
});
