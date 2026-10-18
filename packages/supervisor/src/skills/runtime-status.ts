import { REMOTE_SKILL_AGENT_FRESHNESS_MIN_CORE_CONTRACT_VERSION, RuntimeSkillStatusSchema, type RuntimeSkillStatus } from "@konteks/backstage-plugin-common";
import { coreContractAtLeast } from "@konteks/remote-common";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RuntimeSkillProfile, RuntimeSkillSyncReport } from "./manual-sync.js";

type ProfileProjectionInput = {
  report: RuntimeSkillSyncReport;
  configuredProfiles?: readonly RuntimeSkillProfile[];
  runtimeIdentity?: { workspaceId: string; instanceId: string };
  previous?: RuntimeSkillStatus;
};

function profileStates(input: ProfileProjectionInput): RuntimeSkillStatus["profiles"] {
  const identity = input.runtimeIdentity;
  if (!identity || !input.configuredProfiles) return undefined;
  const configured = input.configuredProfiles.map(profile => {
    const profileId = `profile:${createHash("sha256").update(JSON.stringify([
      "konteks-skill-profile-v1", identity.workspaceId, identity.instanceId, profile.agentId, resolve(profile.home),
    ])).digest("hex")}`;
    const result = input.report.profiles.find(row => row.profileId === profile.profileId && row.agentId === profile.agentId);
    const synchronized = result?.status === "synchronized";
    const previous = input.previous?.profiles?.find(row => row.profileId === profileId);
    const loadedCatalogRevision = previous?.loadedCatalogRevision ?? null;
    return { profileId, profileKind: "general" as const, agentId: profile.agentId,
      desiredCatalogRevision: input.report.catalogRevision,
      installedCatalogRevision: synchronized ? input.report.catalogRevision : null,
      loadedCatalogRevision, syncStatus: synchronized ? "synchronized" as const : "failed" as const,
      ...agentLoadState(synchronized, loadedCatalogRevision, input.report.catalogRevision) };
  });
  return [...configured, ...governedProfilesAfterSync(input)].sort((left, right) => left.profileId.localeCompare(right.profileId));
}

function governedProfilesAfterSync(input: ProfileProjectionInput): NonNullable<RuntimeSkillStatus["profiles"]> {
  const unchanged = input.previous?.agents?.some(agent => agent.desiredCatalogRevision === input.report.catalogRevision) ?? false;
  return (input.previous?.profiles ?? []).filter(profile => profile.profileKind === "governed").map(profile => {
    if (unchanged) return profile;
    return { ...profile, desiredCatalogRevision: null,
      loadStatus: profile.loadedCatalogRevision === null ? "unknown" as const : "stale" as const,
      reasonCode: profile.loadedCatalogRevision === null ? "load_proof_unavailable" as const : "loaded_revision_stale" as const };
  });
}

function agentLoadState(synchronized: boolean, loadedRevision: string | null, desiredRevision: string) {
  if (!synchronized) return { loadStatus: "failed" as const, reasonCode: "sync_failed" as const };
  if (loadedRevision === null) return { loadStatus: "unknown" as const, reasonCode: "load_proof_unavailable" as const };
  if (loadedRevision !== desiredRevision) return { loadStatus: "stale" as const, reasonCode: "loaded_revision_stale" as const };
  return { loadStatus: "current" as const };
}

/**
 * Project private configured-home results onto the public runtime × coding
 * agent view. Home order is not a stable profile identity, so it is deliberately
 * collapsed by agent family before leaving the runtime.
 */
export function runtimeSkillStatusFromSyncReport(input: ProfileProjectionInput & {
  configuredAgentIds: readonly string[];
  syncedAt: string;
  previous?: RuntimeSkillStatus;
}): RuntimeSkillStatus {
  const agentIds = [...new Set(input.configuredAgentIds)].sort();
  const agents = agentIds.map((agentId): NonNullable<RuntimeSkillStatus["agents"]>[number] => {
    const homeReports = input.report.profiles.filter((profile) => profile.agentId === agentId);
    if (homeReports.length === 0) {
      return {
        agentId,
        desiredCatalogRevision: input.report.catalogRevision,
        installedCatalogRevision: null,
        loadedCatalogRevision: null,
        syncStatus: "unsupported",
        loadStatus: "unsupported",
        reasonCode: "agent_adapter_unsupported",
      };
    }

    const allHomesSynchronized = homeReports.every((profile) => profile.status === "synchronized");
    const previous = input.previous?.agents?.find((agent) => agent.agentId === agentId);
    const loadedCatalogRevision = previous?.loadedCatalogRevision ?? null;
    return {
      agentId,
      desiredCatalogRevision: input.report.catalogRevision,
      installedCatalogRevision: allHomesSynchronized ? input.report.catalogRevision : null,
      loadedCatalogRevision,
      syncStatus: allHomesSynchronized ? "synchronized" : "failed",
      ...agentLoadState(allHomesSynchronized, loadedCatalogRevision, input.report.catalogRevision),
    };
  });

  const fullySynchronized = input.report.status === "succeeded" &&
    agents.length > 0 && agents.every((agent) => agent.syncStatus === "synchronized");
  const lastSuccess = fullySynchronized
    ? {
        syncedAt: input.syncedAt,
        skills: input.report.skills
          .map((skill) => ({
            skillId: skill.skillId,
            name: skill.name,
            description: skill.description,
            version: skill.desiredVersion,
          }))
          .sort((left, right) => left.skillId.localeCompare(right.skillId)),
      }
    : input.previous?.lastSuccess ?? null;

  return RuntimeSkillStatusSchema.parse({
    syncing: false,
    agents,
    profiles: profileStates(input),
    lastSuccess,
  });
}

export function runtimeSkillSyncStarted(previous?: RuntimeSkillStatus): RuntimeSkillStatus {
  return RuntimeSkillStatusSchema.parse({
    syncing: true,
    ...(previous?.agents ? { agents: previous.agents } : {}),
    ...(previous?.profiles ? { profiles: previous.profiles } : {}),
    lastSuccess: previous?.lastSuccess ?? null,
  });
}

/** Keep known revisions visible and report first-refresh failures without inventing versions. */
function unresolvedAgents(configuredAgentIds: readonly string[]): NonNullable<RuntimeSkillStatus["agents"]> {
  return [...new Set(configuredAgentIds)].sort().map(agentId => ({
    agentId,
    desiredCatalogRevision: null,
    installedCatalogRevision: null,
    loadedCatalogRevision: null,
    syncStatus: "failed" as const,
    loadStatus: "failed" as const,
    reasonCode: "sync_failed" as const,
  }));
}

function failedFreshnessRows<T extends NonNullable<RuntimeSkillStatus["agents"]>[number]>(rows: readonly T[] | undefined) {
  return rows?.map(row => row.syncStatus === "unsupported" ? row : {
    ...row, syncStatus: "failed" as const, loadStatus: "failed" as const, reasonCode: "sync_failed" as const,
  });
}

export function runtimeSkillSyncFailed(previous?: RuntimeSkillStatus, configuredAgentIds: readonly string[] = []): RuntimeSkillStatus | undefined {
  const prior: RuntimeSkillStatus = previous ?? { syncing: false, lastSuccess: null };
  const agents = prior.agents?.length ? prior.agents : unresolvedAgents(configuredAgentIds);
  if (!agents.length) return undefined;
  return RuntimeSkillStatusSchema.parse({
    syncing: false,
    agents: failedFreshnessRows(agents),
    profiles: failedFreshnessRows(prior.profiles),
    lastSuccess: prior.lastSuccess,
  });
}

/** Older strict Core schemas accept known revisions only. */
export function runtimeSkillStatusForCore(status: RuntimeSkillStatus | undefined, coreContractVersion: string | undefined): RuntimeSkillStatus | undefined {
  return coreContractAtLeast(coreContractVersion, REMOTE_SKILL_AGENT_FRESHNESS_MIN_CORE_CONTRACT_VERSION) ? status : undefined;
}

type ProfileProof = { agentId: string; catalogRevision: string; profileId: string };

/** Retire a closed execution's live freshness row; usage history belongs to Core. */
export function runtimeSkillProfileClosed(previous: RuntimeSkillStatus | undefined, profileId: string): RuntimeSkillStatus | undefined {
  if (!previous?.profiles) return previous;
  const profiles = previous.profiles.filter(profile => profile.profileId !== profileId || profile.profileKind !== "governed");
  return profiles.length === previous.profiles.length ? previous : { ...previous, profiles };
}

/** The verified staged snapshot belongs to this isolated execution profile only. */
export function runtimeSkillProfilePrepared(previous: RuntimeSkillStatus | undefined, proof: ProfileProof): RuntimeSkillStatus {
  const prior = previous ?? { syncing: false, lastSuccess: null };
  const existing = prior.profiles?.find(row => row.profileId === proof.profileId && row.agentId === proof.agentId);
  const loadedCatalogRevision = existing?.loadedCatalogRevision ?? null;
  const profile = { profileId: proof.profileId, profileKind: "governed" as const, agentId: proof.agentId,
    desiredCatalogRevision: proof.catalogRevision, installedCatalogRevision: proof.catalogRevision,
    loadedCatalogRevision, syncStatus: "synchronized" as const,
    ...agentLoadState(true, loadedCatalogRevision, proof.catalogRevision) };
  return RuntimeSkillStatusSchema.parse({ ...prior,
    profiles: [...(prior.profiles ?? []).filter(row => row.profileId !== proof.profileId), profile] });
}

/** A completed load proves exactly one previously prepared isolated profile. */
export function runtimeSkillStatusFromLoadProof(
  previous: RuntimeSkillStatus | undefined,
  proof: { agentId: string; catalogRevision: string; profileId?: string },
): RuntimeSkillStatus | undefined {
  if (!previous?.profiles?.length || !proof.profileId) return previous;
  let changed = false;
  const profiles = previous.profiles.map(profile => {
    if (profile.profileKind !== "governed" || profile.profileId !== proof.profileId ||
        profile.agentId !== proof.agentId || profile.syncStatus !== "synchronized" ||
        profile.desiredCatalogRevision !== proof.catalogRevision || profile.installedCatalogRevision !== proof.catalogRevision) return profile;
    changed = true;
    return { ...profile, loadedCatalogRevision: proof.catalogRevision, loadStatus: "current" as const, reasonCode: undefined };
  });
  return changed ? RuntimeSkillStatusSchema.parse({ ...previous, profiles }) : previous;
}
