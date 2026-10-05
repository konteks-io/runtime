import { expect, it, vi } from "vitest";
import { sha256Hex } from "@konteks/remote-common";
import { machineSkillPermissionAuthorizer } from "../native/skill-permission.js";
import type { NativeSkillSyncClient } from "../native/skill-sync-client.js";
import type { StagedOrganizationSkills } from "../skills/staging.js";

const skillId = "11111111-1111-4111-8111-111111111111";
const id = `konteks-${sha256Hex(skillId)}`;
function fixture() {
  const skill = { skillId, version: "1", treeDigest: "sha256:tree", name: "probe", description: "probe", directory: "/private/tree", skillFile: "/private/tree/SKILL.md", fileModes: {} };
  const staged: StagedOrganizationSkills = { root: "/private", catalogDigest: "digest", skills: [skill] };
  const owner = { workspaceId: "org-a", instanceId: "machine-a" };
  const envelope = { instanceId: owner.instanceId, catalog: { binding: { ...owner }, skills: [{ ...skill }] } };
  const prepare = vi.fn(async () => envelope), authorize = vi.fn(async () => {}), verify = vi.fn(async () => true), assertOwned = vi.fn(() => {});
  const allow = machineSkillPermissionAuthorizer({ staged, owner, assertOwned, verify,
    client: { prepare, authorize } as unknown as Pick<NativeSkillSyncClient, "prepare" | "authorize"> });
  return { allow, envelope, prepare, authorize, verify, assertOwned };
}
it("freshly authorizes the exact installed Skill before allowing its tool", async () => {
  const f = fixture();
  expect(await f.allow(id)).toBe(true);
  expect(f.authorize).toHaveBeenCalledWith(f.envelope, expect.any(AbortSignal));
  expect(f.verify).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: skillId, version: "1" }));
});
it("does not request authority for an unknown or display-name Skill", async () => {
  const f = fixture();
  expect(await f.allow("probe")).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each(["revoked", "version", "digest", "tenant", "instance", "local", "lease", "transport"])("refuses %s without accepting stale authority", async kind => {
  const f = fixture();
  if (kind === "revoked") f.envelope.catalog.skills = [];
  if (kind === "version") f.envelope.catalog.skills[0]!.version = "2";
  if (kind === "digest") f.envelope.catalog.skills[0]!.treeDigest = "sha256:changed";
  if (kind === "tenant") f.envelope.catalog.binding.workspaceId = "other";
  if (kind === "instance") f.envelope.instanceId = "other";
  if (kind === "local") f.verify.mockResolvedValue(false);
  if (kind === "lease") f.assertOwned.mockImplementation(() => { throw new Error("lost lease"); });
  if (kind === "transport") f.authorize.mockRejectedValue(new Error("offline"));
  expect(await f.allow(id)).toBe(false);
});
