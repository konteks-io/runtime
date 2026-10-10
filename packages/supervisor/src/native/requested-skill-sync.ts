import type { NativeSkillSyncClient } from "./skill-sync-client.js";
import { SkillPublicationPartialFailure } from "./skill-publication-refresh.js";

async function synchronizeSkills<T>(
  refresh: () => Promise<T>,
  signal: AbortSignal,
  exchange?: () => Promise<void>,
): Promise<T> {
  let publicationFailure: SkillPublicationPartialFailure | undefined;
  try {
    await exchange?.();
  } catch (error) {
    if (!(error instanceof SkillPublicationPartialFailure)) throw error;
    publicationFailure = error;
  }
  signal.throwIfAborted();
  const result = await refresh();
  signal.throwIfAborted();
  if (publicationFailure) throw publicationFailure;
  return result;
}

/** The transport verifies Core signature, tenant/runtime binding, and request lifetime. */
export async function runRequestedSkillSync<T>(
  client: Pick<NativeSkillSyncClient, "pendingRequest" | "receipt">,
  refresh: () => Promise<T>,
  signal: AbortSignal,
  exchange?: () => Promise<void>,
): Promise<T> {
  const synchronize = () => synchronizeSkills(refresh, signal, exchange);
  const request = await client.pendingRequest(signal);
  if (!request) return synchronize();
  if (!(await client.receipt({ requestId: request.requestId, state: "accepted" }, signal)))
    throw new Error("Skill sync request acceptance was refused");
  let result: T;
  try {
    result = await synchronize();
  } catch (error) {
    await client
      .receipt({ requestId: request.requestId, state: "failed" }, signal)
      .catch(() => undefined);
    throw error;
  }
  if (!(await client.receipt({ requestId: request.requestId, state: "succeeded" }, signal)))
    throw new Error("Skill sync completion was not acknowledged");
  return result;
}
