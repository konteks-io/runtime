import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
      "LocalSkillExportIntentSchema", "skillScopeAllows", "skillFreshnessFailure"]) {
      assert.ok(contract[name], `Vendored common@${version} is missing ${name}`);
    }
    const scope = { tenantId: "tenant-a", audience: { kind: "systems", systemRefs: ["system-a"] }, context: { kind: "initiatives", initiativeRefs: ["initiative-a"] } };
    assert.ok(contract.SkillScopeSchema.parse(scope));
    assert.throws(() => contract.SkillScopeSchema.parse({ ...scope, audience: { kind: "systems", systemRefs: [] } }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
