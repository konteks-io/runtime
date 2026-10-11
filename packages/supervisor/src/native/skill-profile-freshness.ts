import type { RuntimeSkillProfileFreshness } from "@konteks/backstage-plugin-common";
import type { MachineSkillInventory } from "./skill-refresh.js";

type ProfileReport = MachineSkillInventory["profiles"][number];
const digest = (value: string | undefined): string | null => value ?? null;

/** Build a closed, path-free status row for each configured coding agent. */
export function skillProfileFreshness(input: {
  agentIds: readonly string[];
  inventory?: MachineSkillInventory;
  previous?: readonly RuntimeSkillProfileFreshness[];
  unavailableReason?: "catalog_unavailable" | "skill_home_unavailable";
}): RuntimeSkillProfileFreshness[] {
  const previous = new Map((input.previous ?? []).map(profile => [profile.agentId, profile]));
  return [...new Set(input.agentIds)].map(agentId => {
    const old = previous.get(agentId);
    if (!input.inventory) {
      const reason = input.unavailableReason ?? "catalog_unavailable";
      return {
        agentId, desiredRevision: null,
        installedRevision: old?.installedRevision ?? null,
        loadedRevision: old?.loadedRevision ?? null,
        state: reason === "skill_home_unavailable" ? "failed" : "unknown",
        reason,
      };
    }
    const observed = digest(input.inventory.catalogDigest);
    const reports = input.inventory.profiles.filter(profile => profile.agentId === agentId);
    if (reports.length === 0) return {
      agentId, desiredRevision: observed,
      installedRevision: old?.installedRevision ?? null,
      loadedRevision: old?.loadedRevision ?? null,
      state: "unknown" as const, reason: "no_sync_proof" as const,
    };
    if (observed && reports.every(profile => profile.status === "installed")) return {
      agentId, desiredRevision: observed, installedRevision: observed,
      loadedRevision: old?.loadedRevision === observed ? observed : null,
      state: "current" as const,
    };
    const failure = reports.find(profile => profile.status === "failed");
    const reason = failure ? reasonFor(failure) : "profile_publication_failed" as const;
    return {
      // Publication spans multiple native homes and can partially complete.
      // A failed profile therefore has no single revision we can prove is
      // installed across that agent's discovery homes.
      agentId, desiredRevision: observed, installedRevision: null, loadedRevision: null,
      state: "failed" as const, reason,
    };
  });
}

function reasonFor(profile: ProfileReport): "skill_home_unavailable" | "profile_publication_failed" {
  return profile.reason === "native_profile_unconfigured" ? "skill_home_unavailable" : "profile_publication_failed";
}
