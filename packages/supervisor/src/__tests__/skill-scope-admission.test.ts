import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { computeRemoteFileTreeDigest, computeRemoteSkillCatalogDigest } from "../../../common/src/contracts.js";
import { stageOrganizationSkills } from "../skills/staging.js";
import { prepareOrganizationSkillSession } from "../skills/session-inputs.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "konteks-scoped-inputs-")); roots.push(root);
  const cwd = join(root, "checkout"); await mkdir(cwd);
  const binding = { workspaceId: "tenant-a", sessionId: "session", assignmentId: "assignment", instanceId: "runtime", attempt: 1 };
  const bytes = Buffer.from("# Required Skill");
  const entries = [{ path: "SKILL.md", mode: 0o600 as const, sizeBytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, contentBase64: bytes.toString("base64") }];
  const tree = { format: "konteks-file-tree-v1", entries, treeDigest: computeRemoteFileTreeDigest(entries) };
  const scope = { tenantId: "tenant-a", audience: { kind: "systems", systemRefs: ["shop"] }, context: { kind: "initiatives", initiativeRefs: ["checkout"] } };
  const body = { version: 1, binding, skills: [{ skillId: "review", version: "1", name: "review", description: "Review", required: true, scope, transfer: { version: 1, transferId: "transfer", binding, direction: "to_runtime", purpose: "organization_skill", revision: "revision", artifactRef: "artifact", treeDigest: tree.treeDigest, fileCount: 1, sizeBytes: bytes.length, expiresAt: "2026-10-09T00:00:00Z" } }] };
  const catalog = { ...body, catalogDigest: computeRemoteSkillCatalogDigest(body) };
  return { cwd, scratchRoot: join(root, "private"), catalog, authority: { binding, catalogDigest: catalog.catalogDigest }, executionContext: { tenantId: "tenant-a", userRef: "alice", systemRef: "shop", initiativeRef: "checkout" }, now: () => Date.parse("2026-10-08T00:00:00Z"), assertAuthorized: async () => undefined, fetchTree: vi.fn(async () => tree) };
}

it("denies mismatched or missing execution context before fetching any bytes", async () => {
  const input = await fixture();
  await expect(prepareOrganizationSkillSession({ ...input, executionContext: undefined })).rejects.toMatchObject({ code: "capability_unavailable" });
  await expect(prepareOrganizationSkillSession({ ...input, executionContext: { ...input.executionContext, initiativeRef: "other" } })).rejects.toMatchObject({ code: "capability_unavailable" });
  expect(input.fetchTree).not.toHaveBeenCalled();
});

it("does not treat verified installation as proof of an agent load", async () => {
  const input = await fixture();
  const prepared = await prepareOrganizationSkillSession(input);
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ code: "capability_unavailable" });
});

it("rechecks freshness before every turn and rejects a substituted desired digest", async () => {
  const input = await fixture();
  const digest = input.catalog.skills[0]!.transfer.treeDigest;
  const proof = { desiredVersion: "1", installedVersion: "1", loadedVersion: "1", desiredDigest: digest, installedDigest: digest, loadedDigest: digest, state: "verified" as const };
  const evidence = vi.fn(async () => proof);
  const prepared = await prepareOrganizationSkillSession({ ...input, skillFreshness: evidence });
  await prepared.beforePrompt();
  evidence.mockResolvedValueOnce({ ...proof, loadedDigest: "sha256:" + "b".repeat(64) });
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ code: "capability_unavailable", diagnostic: "skill_freshness_stale" });
  evidence.mockResolvedValueOnce({ ...proof, desiredDigest: "sha256:" + "b".repeat(64), installedDigest: "sha256:" + "b".repeat(64), loadedDigest: "sha256:" + "b".repeat(64) });
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ code: "capability_unavailable", diagnostic: "skill_freshness_stale" });
  expect(evidence).toHaveBeenCalledTimes(3);
});

it("binds scope restrictions to the catalog digest", async () => {
  const input = await fixture();
  input.catalog.skills[0]!.scope.context.initiativeRefs = ["other"];
  await expect(prepareOrganizationSkillSession(input)).rejects.toMatchObject({ code: "capability_unavailable" });
  expect(input.fetchTree).not.toHaveBeenCalled();
});

it("uses execution context covered by the signed catalog without granting agent load freshness", async () => {
  const input = await fixture();
  const { catalogDigest: _digest, ...body } = input.catalog;
  const signedBody = { ...body, executionContext: input.executionContext };
  const catalog = { ...signedBody, catalogDigest: computeRemoteSkillCatalogDigest(signedBody) };
  const prepared = await prepareOrganizationSkillSession({ ...input, executionContext: undefined, catalog, authority: { ...input.authority, catalogDigest: catalog.catalogDigest } });
  expect(input.fetchTree).toHaveBeenCalledTimes(1);
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ code: "capability_unavailable" });
});

it("does not let a local context override restrictions in the signed catalog", async () => {
  const input = await fixture();
  const { catalogDigest: _digest, ...body } = input.catalog;
  const signedBody = { ...body, executionContext: { ...input.executionContext, initiativeRef: "other" } };
  const catalog = { ...signedBody, catalogDigest: computeRemoteSkillCatalogDigest(signedBody) };
  await expect(prepareOrganizationSkillSession({ ...input, catalog, authority: { ...input.authority, catalogDigest: catalog.catalogDigest } })).rejects.toMatchObject({ code: "capability_unavailable" });
  expect(input.fetchTree).not.toHaveBeenCalled();
});

it("enforces signed scope at the staging boundary even without the session wrapper", async () => {
  const input = await fixture();
  const { catalogDigest: _digest, ...body } = input.catalog;
  const signedBody = { ...body, executionContext: { ...input.executionContext, initiativeRef: "other" } };
  const catalog = { ...signedBody, catalogDigest: computeRemoteSkillCatalogDigest(signedBody) };
  await expect(stageOrganizationSkills({ ...input, catalog, authority: { ...input.authority, catalogDigest: catalog.catalogDigest } })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
  expect(input.fetchTree).not.toHaveBeenCalled();
});

it.each(["offline", "failed", "unsupported", "unknown"] as const)("reports actionable %s freshness refusal without retrying delivery", async state => {
  const input = await fixture();
  const prepared = await prepareOrganizationSkillSession({ ...input, skillFreshness: async () => ({ desiredVersion: "1", desiredDigest: input.catalog.skills[0]!.transfer.treeDigest, state }) });
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ code: "capability_unavailable", diagnostic: `skill_freshness_${state}` });
  expect(input.fetchTree).toHaveBeenCalledTimes(1);
});

it("redacts adapter observation errors into failed freshness proof", async () => {
  const input = await fixture();
  const prepared = await prepareOrganizationSkillSession({ ...input, skillFreshness: async () => { throw new Error("private adapter output"); } });
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ diagnostic: "skill_freshness_failed" });
  await expect(prepared.beforePrompt()).rejects.not.toThrow("private adapter output");
});

it("does not let a required legacy Skill bypass the load-proof gate by omitting scope", async () => {
  const input = await fixture();
  const { catalogDigest: _digest, ...body } = input.catalog;
  const { scope: _scope, ...skill } = body.skills[0]!;
  const legacyBody = { ...body, skills: [skill] };
  const catalog = { ...legacyBody, catalogDigest: computeRemoteSkillCatalogDigest(legacyBody) };
  const prepared = await prepareOrganizationSkillSession({ ...input, catalog, authority: { ...input.authority, catalogDigest: catalog.catalogDigest } });
  await expect(prepared.beforePrompt()).rejects.toMatchObject({ diagnostic: "skill_freshness_unknown" });
});
