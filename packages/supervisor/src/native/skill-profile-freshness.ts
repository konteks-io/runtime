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
  return [...new Set(input.agentIds)].map(agentId => profileForAgent(agentId, input, previous));
}

function profileForAgent(
  agentId: string,
  input: Parameters<typeof skillProfileFreshness>[0],
  previous: ReadonlyMap<string, RuntimeSkillProfileFreshness>,
): RuntimeSkillProfileFreshness {
  const old = previous.get(agentId);
  if (!input.inventory) return unavailableProfile(agentId, old, input.unavailableReason);
  const observed = digest(input.inventory.catalogDigest);
  const reports = input.inventory.profiles.filter(profile => profile.agentId === agentId);
  if (reports.length === 0) return unprovenProfile(agentId, observed, old);
  if (allProfilesInstalled(reports, observed)) return currentProfile(agentId, observed!, old);
  return failedProfile(agentId, observed, reports);
}

function unavailableProfile(
  agentId: string,
  old: RuntimeSkillProfileFreshness | undefined,
  unavailableReason: Parameters<typeof skillProfileFreshness>[0]["unavailableReason"],
): RuntimeSkillProfileFreshness {
  const reason = unavailableReason ?? "catalog_unavailable";
  return {
    agentId, desiredRevision: null,
    installedRevision: old?.installedRevision ?? null,
    loadedRevision: old?.loadedRevision ?? null,
    state: reason === "skill_home_unavailable" ? "failed" : "unknown",
    reason,
  };
}

function unprovenProfile(
  agentId: string,
  observed: string | null,
  old: RuntimeSkillProfileFreshness | undefined,
): RuntimeSkillProfileFreshness {
  return {
    agentId, desiredRevision: observed,
    installedRevision: old?.installedRevision ?? null,
    loadedRevision: old?.loadedRevision ?? null,
    state: "unknown", reason: "no_sync_proof",
  };
}

function allProfilesInstalled(reports: readonly ProfileReport[], observed: string | null): observed is string {
  return observed !== null && reports.every(profile => profile.status === "installed");
}

function currentProfile(
  agentId: string,
  observed: string,
  old: RuntimeSkillProfileFreshness | undefined,
): RuntimeSkillProfileFreshness {
  return {
    agentId, desiredRevision: observed, installedRevision: observed,
    loadedRevision: old?.loadedRevision === observed ? observed : null,
    state: "current",
  };
}

function failedProfile(
  agentId: string,
  observed: string | null,
  reports: readonly ProfileReport[],
): RuntimeSkillProfileFreshness {
  const failure = reports.find(profile => profile.status === "failed");
  // Publication can partially complete across an agent's discovery homes, so
  // no single installed revision can be claimed after a failed profile.
  return {
    agentId, desiredRevision: observed, installedRevision: null, loadedRevision: null,
    state: "failed", reason: failure ? reasonFor(failure) : "profile_publication_failed",
  };
}

function reasonFor(profile: ProfileReport): "skill_home_unavailable" | "profile_publication_failed" {
  return profile.reason === "native_profile_unconfigured" ? "skill_home_unavailable" : "profile_publication_failed";
}
