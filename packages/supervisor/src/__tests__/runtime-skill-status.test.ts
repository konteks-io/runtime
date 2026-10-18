import { describe, expect, it } from "vitest";
import { REMOTE_CORE_CONTRACT_VERSION } from "@konteks/backstage-plugin-common";
import { runtimeSkillProfileClosed, runtimeSkillProfilePrepared, runtimeSkillStatusForCore, runtimeSkillStatusFromLoadProof, runtimeSkillStatusFromSyncReport, runtimeSkillSyncFailed, runtimeSkillSyncStarted } from "../skills/runtime-status.js";
import type { RuntimeSkillSyncReport } from "../skills/manual-sync.js";

const revision = `sha256:${"a".repeat(64)}`;
const skill = {
  skillId: "11111111-1111-4111-8111-111111111111",
  name: "review-api",
  description: "Review API changes",
  desiredVersion: "2.0.0",
  treeDigest: revision,
  audience: null,
  initiativeIds: null,
};

function report(overrides: Partial<RuntimeSkillSyncReport> = {}): RuntimeSkillSyncReport {
  return {
    catalogRevision: revision,
    status: "succeeded",
    skills: [skill],
    profiles: [
      { profileId: "codex-profile-1", agentId: "codex", status: "synchronized", installedSkills: 1, loadedStatus: "unknown" },
      { profileId: "codex-profile-2", agentId: "codex", status: "synchronized", installedSkills: 1, loadedStatus: "unknown" },
    ],
    ...overrides,
  };
}

describe("runtime coding-agent Skill freshness projection", () => {
  it("retires completed profiles without accumulating past the live report limit", () => {
    let status = runtimeSkillStatusFromSyncReport({ report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-14T00:00:00.000Z" });
    for (let index = 0; index < 300; index++) {
      const profileId = `profile:${index.toString(16).padStart(64, "0")}`;
      status = runtimeSkillProfilePrepared(status, { profileId, agentId: "codex", catalogRevision: revision });
      status = runtimeSkillProfileClosed(status, profileId)!;
    }
    expect(status.profiles).toEqual([]);
    expect(status.agents?.[0].installedCatalogRevision).toBe(revision);
  });
  it("attributes a governed load only to its prepared profile", () => {
    const base = runtimeSkillStatusFromSyncReport({ report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-14T00:00:00.000Z" });
    const first = { profileId: `profile:${"a".repeat(64)}`, agentId: "codex", catalogRevision: revision };
    const second = { ...first, profileId: `profile:${"b".repeat(64)}` };
    const prepared = runtimeSkillProfilePrepared(runtimeSkillProfilePrepared(base, first), second);
    const loaded = runtimeSkillStatusFromLoadProof(prepared, first)!;
    expect(loaded.profiles?.find(row => row.profileId === first.profileId)?.loadStatus).toBe("current");
    expect(loaded.profiles?.find(row => row.profileId === second.profileId)?.loadStatus).toBe("unknown");
    expect(loaded.agents?.[0].loadStatus).toBe("unknown");
    expect(runtimeSkillStatusFromLoadProof(prepared, { ...first, catalogRevision: `sha256:${"c".repeat(64)}` })).toBe(prepared);
    const projected = runtimeSkillStatusFromSyncReport({ report: report(), configuredAgentIds: ["codex"],
      configuredProfiles: [], runtimeIdentity: { workspaceId: "tenant-a", instanceId: "runtime-a" },
      syncedAt: "2026-10-14T00:00:00.000Z", previous: loaded });
    expect(projected.profiles).toEqual(loaded.profiles);
    const changed = runtimeSkillStatusFromSyncReport({ report: report({ catalogRevision: `sha256:${"d".repeat(64)}` }),
      configuredAgentIds: ["codex"], configuredProfiles: [], runtimeIdentity: { workspaceId: "tenant-a", instanceId: "runtime-a" },
      syncedAt: "2026-10-14T00:00:00.000Z", previous: loaded });
    expect(changed.profiles?.find(row => row.profileId === first.profileId)).toMatchObject({
      desiredCatalogRevision: null, loadedCatalogRevision: revision, loadStatus: "stale" });
  });
  it("publishes stable profile identities without changing private publication identifiers", () => {
    const configuredProfiles = [
      { profileId: "codex-profile-1", agentId: "codex", home: "/test/alice/first" },
      { profileId: "codex-profile-2", agentId: "codex", home: "/test/alice/second" },
    ];
    const input = { report: report(), configuredAgentIds: ["codex"], configuredProfiles,
      runtimeIdentity: { workspaceId: "tenant-a", instanceId: "runtime-a" }, syncedAt: "2026-10-14T00:00:00.000Z" };
    const status = runtimeSkillStatusFromSyncReport(input);
    expect(status.profiles).toHaveLength(2);
    expect(status.profiles?.map(profile => profile.profileId)).toEqual(expect.arrayContaining([expect.stringMatching(/^profile:[a-f0-9]{64}$/)]));
    expect(JSON.stringify(status.profiles)).not.toContain("/test/alice");
    expect(runtimeSkillStatusFromSyncReport({ ...input, configuredProfiles: [...configuredProfiles].reverse() }).profiles).toEqual(status.profiles);
    expect(configuredProfiles[0].profileId).toBe("codex-profile-1");
  });
  it("sends exact profile states only to Core versions accepting the profile contract", () => {
    const status = runtimeSkillStatusFromSyncReport({ report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-14T00:00:00.000Z" });
    const withProfiles = { ...status, profiles: [{ ...status.agents![0],
      profileId: `profile:${"a".repeat(64)}`, profileKind: "general" as const }] };
    expect(runtimeSkillStatusForCore(withProfiles, REMOTE_CORE_CONTRACT_VERSION)).toEqual(withProfiles);
    expect(runtimeSkillStatusForCore(withProfiles, "7.12")).toBeUndefined();
    expect(runtimeSkillStatusForCore(withProfiles, "7.11")).toBeUndefined();
    expect(runtimeSkillStatusForCore(withProfiles, "7.9")).toBeUndefined();
    expect(runtimeSkillStatusForCore(withProfiles, "7.8")).toBeUndefined();
  });
  it("reports unresolved failures only to Core versions accepting unknown desired revisions", () => {
    const known = runtimeSkillStatusFromSyncReport({ report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-13T00:00:00.000Z" });
    const failed = runtimeSkillSyncFailed(undefined, ["opencode"])!;
    const combined = { ...failed, agents: [...known.agents!, ...failed.agents!] };
    expect(runtimeSkillStatusForCore(combined, REMOTE_CORE_CONTRACT_VERSION)).toEqual(combined);
    expect(runtimeSkillStatusForCore(combined, "7.12")).toBeUndefined();
    expect(runtimeSkillStatusForCore(combined, "7.8")).toBeUndefined();
    expect(runtimeSkillStatusForCore(combined, "7.11")).toBeUndefined();
    expect(runtimeSkillStatusForCore(undefined, "7.9")).toBeUndefined();
  });
  it("aggregates configured homes by coding agent and never exports home-order profile labels", () => {
    const status = runtimeSkillStatusFromSyncReport({
      report: report(),
      configuredAgentIds: ["codex", "codex"],
      syncedAt: "2026-10-13T00:00:00.000Z",
    });

    expect(status).toEqual({
      syncing: false,
      agents: [{
        agentId: "codex",
        desiredCatalogRevision: revision,
        installedCatalogRevision: revision,
        loadedCatalogRevision: null,
        syncStatus: "synchronized",
        loadStatus: "unknown",
        reasonCode: "load_proof_unavailable",
      }],
      lastSuccess: {
        syncedAt: "2026-10-13T00:00:00.000Z",
        skills: [{ skillId: skill.skillId, name: skill.name, description: skill.description, version: skill.desiredVersion }],
      },
    });
  });

  it("reports partial installation as failed and preserves only the prior full-success inventory", () => {
    const previous = runtimeSkillStatusFromSyncReport({
      report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-12T00:00:00.000Z",
    });
    const next = runtimeSkillStatusFromSyncReport({
      report: report({
        catalogRevision: `sha256:${"b".repeat(64)}`,
        status: "partial",
        profiles: [
          { profileId: "codex-profile-1", agentId: "codex", status: "synchronized", installedSkills: 1, loadedStatus: "unknown" },
          { profileId: "codex-profile-2", agentId: "codex", status: "failed", installedSkills: null, loadedStatus: "unknown", reason: "local_io_failure" },
        ],
      }),
      configuredAgentIds: ["codex"],
      syncedAt: "2026-10-13T00:00:00.000Z",
      previous,
    });

    expect(next.agents?.[0]).toMatchObject({ syncStatus: "failed", loadStatus: "failed", installedCatalogRevision: null, reasonCode: "sync_failed" });
    expect(next.lastSuccess).toEqual(previous.lastSuccess);
  });

  it("preserves matching load proof across a repeat sync and marks the prior proof stale after a revision change", () => {
    const previous = runtimeSkillStatusFromSyncReport({
      report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-12T00:00:00.000Z",
    });
    const loaded = {
      ...previous,
      agents: previous.agents?.map((agent) => ({
        ...agent,
        loadedCatalogRevision: revision,
        loadStatus: "current" as const,
      })),
    };

    expect(runtimeSkillStatusFromSyncReport({
      report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-13T00:00:00.000Z", previous: loaded,
    }).agents?.[0]).toMatchObject({ loadedCatalogRevision: revision, loadStatus: "current" });
    expect(runtimeSkillStatusFromSyncReport({
      report: report({ catalogRevision: `sha256:${"b".repeat(64)}` }),
      configuredAgentIds: ["codex"], syncedAt: "2026-10-13T00:00:00.000Z", previous: loaded,
    }).agents?.[0]).toMatchObject({
      desiredCatalogRevision: `sha256:${"b".repeat(64)}`,
      loadedCatalogRevision: revision,
      loadStatus: "stale",
      reasonCode: "loaded_revision_stale",
    });
  });

  it("never treats an unbound session proof as proof for general agent homes", () => {
    const installed = runtimeSkillStatusFromSyncReport({ report: report(), configuredAgentIds: ["codex"], syncedAt: "2026-10-14T00:00:00.000Z" });
    expect(runtimeSkillStatusFromLoadProof(installed, { agentId: "codex", catalogRevision: revision })?.agents?.[0]).toMatchObject({
      desiredCatalogRevision: revision,
      installedCatalogRevision: revision,
      loadedCatalogRevision: null,
      syncStatus: "synchronized",
      loadStatus: "unknown",
    });
    expect(runtimeSkillStatusFromLoadProof(installed, { agentId: "codex", catalogRevision: `sha256:${"b".repeat(64)}` })).toBe(installed);
    expect(runtimeSkillStatusFromLoadProof(installed, { agentId: "opencode", catalogRevision: revision })).toBe(installed);
    expect(runtimeSkillStatusFromLoadProof({ ...installed, syncing: true }, { agentId: "codex", catalogRevision: revision })?.agents?.[0].loadStatus).toBe("unknown");
  });

  it("marks agents without a supported Skill home as unsupported and keeps failed refreshes non-current", () => {
    const unsupported = runtimeSkillStatusFromSyncReport({
      report: report({ status: "failed", profiles: [] }),
      configuredAgentIds: ["dsh"],
      syncedAt: "2026-10-13T00:00:00.000Z",
    });
    expect(unsupported.agents?.[0]).toMatchObject({ syncStatus: "unsupported", loadStatus: "unsupported", reasonCode: "agent_adapter_unsupported" });
    expect(runtimeSkillSyncStarted(unsupported).syncing).toBe(true);
    expect(runtimeSkillSyncFailed(unsupported)?.agents?.[0]).toMatchObject({ syncStatus: "unsupported", loadStatus: "unsupported" });
  });
  it("reports the first failed refresh for each configured agent without inventing revisions", () => {
    const failed = runtimeSkillSyncFailed(runtimeSkillSyncStarted(), ["opencode", "codex", "opencode"]);
    expect(failed).toMatchObject({
      syncing: false,
      lastSuccess: null,
      agents: ["codex", "opencode"].map(agentId => ({
        agentId,
        desiredCatalogRevision: null,
        installedCatalogRevision: null,
        loadedCatalogRevision: null,
        syncStatus: "failed",
        loadStatus: "failed",
        reasonCode: "sync_failed",
      })),
    });
    expect(runtimeSkillStatusFromLoadProof(failed, { agentId: "opencode", catalogRevision: revision })).toEqual(failed);
  });
});
