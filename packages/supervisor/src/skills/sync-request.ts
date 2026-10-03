import { RuntimeSkillSyncRequestSchema, runtimeSkillSyncRequestSigningBytes, type RuntimeSkillSyncRequest } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { sha256Hex } from "@konteks/remote-common";

/** The transport must supply an atomic, durable, owner-bound replay reservation. */
export async function admitSkillSyncRequest(candidate: unknown, deps: {
  verify(request: RuntimeSkillSyncRequest): boolean;
  owner(): { workspaceId: string; instanceId: string; active: boolean };
  now(): number;
  reserve(request: RuntimeSkillSyncRequest, digest: string): Promise<boolean>;
  sync(): Promise<unknown>;
}): Promise<"executed" | "duplicate"> {
  const request = RuntimeSkillSyncRequestSchema.parse(candidate);
  const check = () => {
    const owner = deps.owner(), now = deps.now();
    if (!owner.active || owner.workspaceId !== request.workspaceId || owner.instanceId !== request.instanceId ||
      !Number.isFinite(now) || Date.parse(request.issuedAt) > now + 1000 || Date.parse(request.expiresAt) <= now || !deps.verify(request)) {
      throw new Error("Skill sync request is unavailable");
    }
  };
  check();
  const accepted = await deps.reserve(request, sha256Hex(runtimeSkillSyncRequestSigningBytes(request)));
  check();
  if (!accepted) return "duplicate";
  await deps.sync();
  return "executed";
}
