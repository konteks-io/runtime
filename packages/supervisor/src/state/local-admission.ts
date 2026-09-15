import { z } from "zod";

/** Retained native identity, not proof that Core accepted the chosen claim. */
export const LocalAdmissionSchema = z.object({
  instanceId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256),
  runnerIncarnation: z.string().min(1).max(256), assignmentId: z.string().min(1).max(256),
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  claimId: z.string().min(1).max(256), agentId: z.string().min(1).max(256),
  executionGeneration: z.string().min(1).max(256), openedAt: z.string().datetime(),
}).strict();
export type LocalAdmission = z.infer<typeof LocalAdmissionSchema>;
