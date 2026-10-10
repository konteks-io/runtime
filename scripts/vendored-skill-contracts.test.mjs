import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("the shipped common contract supports scoped Skill synchronization", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = manifest.konteksContracts["@konteks/backstage-plugin-common"];
  const archive = join(root, "vendor", `konteks-backstage-plugin-common-${version}.tgz`);
  const temporary = mkdtempSync(join(tmpdir(), "konteks-skill-contract-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", temporary]);
    mkdirSync(join(temporary, "node_modules"));
    symlinkSync(dirname(require.resolve("zod/package.json")), join(temporary, "node_modules", "zod"), "junction");
    const contract = require(join(temporary, "package", "dist", "remote-instance-internal.js"));
    for (const name of ["RuntimeSkillSyncItemSchema", "RuntimeSkillSyncEnvelopeSchema", "RuntimeSkillShareOwnerRequestSchema",
      "RuntimeSkillSharePublishRequestSchema", "RuntimeSkillShareRequestSchema", "RuntimeSkillSharePublicationResultSchema", "RuntimeSkillPublicationReceiptSchema",
      "LocalSkillExportIntentSchema", "skillScopeAllows", "skillFreshnessFailure"]) {
      assert.ok(contract[name], `Vendored common@${version} is missing ${name}`);
    }
    assert.equal(contract.RUNTIME_SKILL_SHARE_MIN_CORE_CONTRACT_VERSION, "7.6");
    assert.equal(contract.RUNTIME_SKILL_REVISION_MIN_CORE_CONTRACT_VERSION, "7.7");
    const selection = { requestId: "11111111-1111-4111-8111-111111111111", localId: "a".repeat(64),
      treeDigest: `sha256:${"a".repeat(64)}`, audience: { kind: "organization" }, context: { kind: "global" },
      confirmation: { ongoingPublication: true }, skillId: "22222222-2222-4222-8222-222222222222",
      expectedRevision: "33333333-3333-4333-8333-333333333333" };
    assert.deepEqual(contract.RuntimeSkillShareRequestSchema.parse(selection), selection);
    assert.throws(() => contract.RuntimeSkillShareRequestSchema.parse({ ...selection, expectedRevision: "revision-a" }));
    const digest = `sha256:${"a".repeat(64)}`;
    const receipt = { publicationId: "11111111-1111-4111-8111-111111111111", revisionId: "22222222-2222-4222-8222-222222222222", acceptedSequence: 1, treeDigest: digest };
    const result = { id: receipt.publicationId, tenantId: "tenant-a", type: "skill", metadata: { runtimePromotionKey: `runtime-a:local-a:${digest}` }, runtimePublication: receipt };
    assert.deepEqual(contract.RuntimeSkillSharePublicationResultSchema.parse(result), result);
    assert.throws(() => contract.RuntimeSkillSharePublicationResultSchema.parse({ ...result, runtimePublication: { ...receipt, treeDigest: `sha256:${"b".repeat(64)}` } }));

    const scope = { tenantId: "tenant-a", audience: { kind: "systems", systemRefs: ["system-a"] }, context: { kind: "initiatives", initiativeRefs: ["initiative-a"] } };
    assert.ok(contract.SkillScopeSchema.parse(scope));
    assert.throws(() => contract.SkillScopeSchema.parse({ ...scope, audience: { kind: "systems", systemRefs: [] } }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
