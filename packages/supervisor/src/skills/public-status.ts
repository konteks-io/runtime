import { RuntimeSkillStatusSchema, type RuntimeSkillStatus } from "@konteks/backstage-plugin-common";
import type { SkillSyncSuccess } from "./sync-receipt.js";
/** The hosted projection carries installed metadata, never agent discovery paths. */
export function publicSkillStatus(status: { syncing: boolean; lastSuccess?: SkillSyncSuccess }): RuntimeSkillStatus {
  return RuntimeSkillStatusSchema.parse({ syncing: status.syncing, lastSuccess: status.lastSuccess ? {
    syncedAt: status.lastSuccess.syncedAt,
    skills: status.lastSuccess.inventory.skills.map(({ skillId, name, description, version }) => ({ skillId, name, description, version }))
      .sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0),
  } : null });
}
