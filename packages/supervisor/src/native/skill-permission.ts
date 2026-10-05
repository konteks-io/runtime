import { sha256Hex } from "@konteks/remote-common";
import type { NativeSkillSyncClient } from "./skill-sync-client.js";
import type { StagedOrganizationSkills } from "../skills/staging.js";
import type { CompletedSkillRead } from "../skills/read-tracker.js";

/** A machine inventory is telemetry until Core freshly authorizes its exact bytes. */
export function machineSkillPermissionAuthorizer(options: {
  staged: StagedOrganizationSkills;
  owner: { workspaceId: string; instanceId: string };
  client: Pick<NativeSkillSyncClient, "prepare" | "authorize">;
  assertOwned(): void;
  verify(read: CompletedSkillRead): Promise<boolean>;
}): (id: string) => Promise<boolean> {
  const staged = structuredClone(options.staged), owner = { ...options.owner };
  return async id => {
    const skill = staged.skills.find(item => `konteks-${sha256Hex(item.skillId)}` === id);
    if (!skill) return false;
    const signal = AbortSignal.timeout(10_000);
    try {
      options.assertOwned();
      const envelope = await options.client.prepare(signal);
      options.assertOwned();
      if (envelope.instanceId !== owner.instanceId || envelope.catalog.binding.instanceId !== owner.instanceId ||
          envelope.catalog.binding.workspaceId !== owner.workspaceId) return false;
      const selected = envelope.catalog.skills.find(item => item.skillId === skill.skillId);
      if (!selected || selected.version !== skill.version || selected.treeDigest !== skill.treeDigest) return false;
      const verified = await options.verify({ toolCallId: "skill-permission", capabilityId: skill.skillId, version: skill.version });
      if (!verified || signal.aborted) return false;
      await options.client.authorize(envelope, signal);
      options.assertOwned();
      return !signal.aborted;
    } catch { return false; }
  };
}
