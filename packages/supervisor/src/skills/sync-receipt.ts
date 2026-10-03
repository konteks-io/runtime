import { z } from "zod";
import { RuntimeSkillSyncItemSchema } from "@konteks/backstage-plugin-common/remote-instance-internal";
export const SkillSyncSuccessSchema = z.object({ syncedAt: z.iso.datetime(), inventory: z.object({
  skills: z.array(RuntimeSkillSyncItemSchema).max(64),
  profiles: z.array(z.object({ home: z.string().min(1).max(4096), paths: z.array(z.string().min(1).max(4096)).max(64) }).strict()).max(16),
}).strict() }).strict();
export type SkillSyncSuccess = z.infer<typeof SkillSyncSuccessSchema>;
export const SkillSyncReceiptSchema = z.object({ version: z.literal(1),
  owner: z.object({ workspaceId: z.string().min(1).max(512), instanceId: z.string().min(1).max(512) }).strict(),
  success: SkillSyncSuccessSchema,
}).strict();
