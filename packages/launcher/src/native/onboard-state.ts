import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isFsErrorWithCode, writeSecretFile } from "@konteks/remote-common";

/**
 * What one onboarding conversation remembers between commands
 * (onboarding-simplified OS9, "Onboard state").
 *
 * Every `konteks-remote onboard` invocation is a fresh process: the person's
 * agent runs the command, relays the question, waits for a human, and runs it
 * again. Without this file there is no conversation, only a sequence of
 * unrelated commands — and, worse, the second invocation might be made from a
 * different directory than the first, and would then register the wrong
 * repository.
 *
 * It holds no secret. The code is consumed by the call that receives it and
 * the owner token lives in its own secret file.
 */

export const OnboardStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The step that will run next. */
    step: z.enum([
      "identity",
      "email",
      "code",
      "workspace",
      "start",
      "inspect",
      "system",
      "push",
      "first_task",
      "done",
    ]),
    intentRef: z.string().min(1).optional(),
    /** Masked, for re-asking without holding the address. */
    emailMasked: z.string().min(1).optional(),
    /** The address the person gave, needed once more at bind (OS6). */
    email: z.string().min(1).optional(),
    decision: z.enum(["join", "choose", "create"]).optional(),
    workspaces: z.array(z.object({ tenantId: z.string(), displayName: z.string() }).strict()).optional(),
    proposedTenantId: z.string().optional(),
    tenantId: z.string().optional(),
    instanceId: z.string().optional(),
    /** Code attempts left on the live challenge, for the re-ask. */
    attemptsRemaining: z.number().int().min(0).optional(),
    /** Roles the service advertised at the first heartbeat, if it was seen. */
    advertisedRoles: z.array(z.string()).optional(),
    /** The repository captured at the first inspect; later runs use it. */
    repositoryPath: z.string().optional(),
    repositoryName: z.string().optional(),
    remoteUrl: z.string().optional(),
    defaultBranch: z.string().optional(),
    repositoryKind: z.enum(["existing", "managed"]).optional(),
    systemId: z.string().optional(),
    systemEntityRef: z.string().optional(),
    managedRemoteUrl: z.string().optional(),
    sessionUrl: z.string().optional(),
    updatedAt: z.string().min(1),
  })
  .strict();

export type OnboardState = z.infer<typeof OnboardStateSchema>;

const FILE = "onboard-state.json";

export function onboardStatePath(root: string): string {
  return join(root, FILE);
}

export async function readOnboardState(root: string): Promise<OnboardState | null> {
  const raw = await readFile(onboardStatePath(root), "utf8").catch(error => {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (raw === null) return null;
  const parsed = OnboardStateSchema.safeParse(JSON.parse(raw));
  // A state file we cannot read is a conversation we cannot continue; starting
  // over is correct and costs the person one email.
  return parsed.success ? parsed.data : null;
}

export async function writeOnboardState(
  root: string,
  state: Omit<OnboardState, "schemaVersion" | "updatedAt">,
): Promise<OnboardState> {
  const next = OnboardStateSchema.parse({
    ...state,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  });
  await writeSecretFile(onboardStatePath(root), JSON.stringify(next));
  return next;
}
