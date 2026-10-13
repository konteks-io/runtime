import type { StagedOrganizationSkills } from "../skills/staging.js";
import { verifyAgentHomeSkillInstallation } from "../skills/home-sync.js";

export interface SkillInstallationSnapshot {
  staged: StagedOrganizationSkills;
  owner: { workspaceId: string; instanceId: string };
}
export async function inspectSkillInstallation(input: {
  snapshot?: SkillInstallationSnapshot | undefined;
  owner: SkillInstallationSnapshot["owner"];
  catalogDigest: string;
  home: string;
}): Promise<"verified" | "stale" | "unknown"> {
  const snapshot = input.snapshot;
  if (
    !snapshot ||
    snapshot.owner.workspaceId !== input.owner.workspaceId ||
    snapshot.owner.instanceId !== input.owner.instanceId
  )
    return "unknown";
  if (snapshot.staged.catalogDigest !== input.catalogDigest) return "stale";
  for (const skill of snapshot.staged.skills) {
    if (!(await verifyAgentHomeSkillInstallation({ home: input.home, owner: input.owner, skill })))
      return "stale";
  }
  return snapshot.staged.skills.length ? "verified" : "unknown";
}
