import type { NativeSkillSyncClient } from "./skill-sync-client.js";

/** The transport verifies Core signature, tenant/runtime binding, and request lifetime. */
export async function runRequestedSkillSync<T>(
  client: Pick<NativeSkillSyncClient, "pendingRequest" | "receipt">,
  refresh: () => Promise<T>, signal: AbortSignal,
): Promise<T> {
  const request = await client.pendingRequest(signal);
  if (!request) return refresh();
  if (!await client.receipt({ requestId: request.requestId, state: "accepted" }, signal)) throw new Error("Skill sync request acceptance was refused");
  let result: T;
  try { result = await refresh(); }
  catch (error) {
    await client.receipt({ requestId: request.requestId, state: "failed" }, signal).catch(() => undefined);
    throw error;
  }
  if (!await client.receipt({ requestId: request.requestId, state: "succeeded" }, signal)) throw new Error("Skill sync completion was not acknowledged");
  return result;
}
