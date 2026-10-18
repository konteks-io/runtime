import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  computeRemoteSkillCatalogDigest,
  RemoteFileTreeSchema,
  RemoteInstanceError,
  RemoteSkillCatalogSchema,
  RemoteTransferBindingSchema,
} from "@konteks/remote-common";
import {
  RuntimeSkillSyncEnvelopeSchema,
  LocalSkillPublicationSchema,
  LocalRuntimeSkillShareSchema,
  LocalRuntimeSkillUnshareSchema,
  type RuntimeSkillSyncEnvelope,
  type RuntimeSkillSyncItem,
  type LocalSkillPublication,
  type LocalRuntimeSkillShare,
  type LocalRuntimeSkillUnshare,
  type RuntimeSkillSyncOwnerPublishResponse,
  type RuntimeSkillSyncOwnerUnshareResponse,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { stageOrganizationSkills, type StagedOrganizationSkills } from "./staging.js";
import { inspectAgentHomeSkillSync, syncAgentHomeSkills } from "./home-sync.js";
import {
  makeLocalPersonalSkillShare,
  makeLocalSkillShare,
  snapshotLocalSkill,
} from "./local-share.js";
import {
  LocalSkillPublicationStore,
  type LocalSkillPublicationRecord,
} from "./local-publications.js";

export interface RuntimeSkillProfile {
  profileId: string;
  agentId: string;
  home: string;
}

export interface RuntimeSkillSyncClient {
  prepareRuntimeSkillSync(instanceId: string): Promise<unknown>;
  readRuntimeSkillSync(
    instanceId: string,
    envelope: RuntimeSkillSyncEnvelope,
    skillId: string,
  ): Promise<unknown>;
  authorizeRuntimeSkillSync(instanceId: string, envelope: RuntimeSkillSyncEnvelope): Promise<void>;
  shareRuntimeSkillSync(
    instanceId: string,
    share: LocalRuntimeSkillShare,
  ): Promise<RuntimeSkillSyncOwnerPublishResponse>;
  unshareRuntimeSkillSync(
    instanceId: string,
    request: LocalRuntimeSkillUnshare,
  ): Promise<RuntimeSkillSyncOwnerUnshareResponse>;
}

function recordConcurrentReplacement(
  replacements: Array<{
    localId: string;
    skill: string;
    replacedConcurrentVersion: string;
    acceptedVersion: string;
  }>,
  localId: string,
  receipt: RuntimeSkillSyncOwnerPublishResponse,
): void {
  if (!receipt.replacedConcurrentVersion || !receipt.acceptedVersion) return;
  replacements.push({
    localId,
    skill: receipt.name,
    replacedConcurrentVersion: receipt.replacedConcurrentVersion,
    acceptedVersion: receipt.acceptedVersion,
  });
}

export type RuntimeSkillShareAudience =
  { level: "organization" } | { level: "systems"; systemIds: string[] };

type DesiredSkillAudience = NonNullable<RuntimeSkillSyncItem["scope"]>["audience"];
type SkillAudienceView = { audience: DesiredSkillAudience | null; initiativeIds: string[] | null };
type DesiredSkillView = SkillAudienceView &
  Pick<RuntimeSkillSyncItem, "skillId" | "name" | "description"> & {
    treeDigest: string | null;
    desiredVersion: string;
  };

export interface RuntimeSkillListReport {
  catalogRevision: string;
  skills: DesiredSkillView[];
  profiles: Array<{
    profileId: string;
    agentId: string;
    profileState: "ready" | "not_configured" | "unavailable";
    reason?: string;
    skills: Array<
      DesiredSkillView & {
        installedVersion: string | null;
        installedDigest: string | null;
        installedStatus:
          "current" | "stale" | "missing" | "changed" | "pending" | "unknown" | "restricted";
        loadedVersion: null;
        loadedStatus: "unknown";
      }
    >;
  }>;
}

export interface RuntimeSkillSyncReport {
  catalogRevision: string;
  status: "succeeded" | "partial" | "failed";
  skills: DesiredSkillView[];
  profiles: Array<{
    profileId: string;
    agentId: string;
    status: "synchronized" | "failed";
    installedSkills: number | null;
    loadedStatus: "unknown";
    reason?: string;
  }>;
}

interface SkillSyncFailure {
  localId: string;
  reason: string;
}

interface PersonalSkillSource {
  name: string;
  identity: string;
}

interface PersonalSkillSyncReport {
  configured: boolean;
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failures: SkillSyncFailure[];
}

interface PublishedSkillSyncReport {
  configured: boolean;
  scanned: number;
  updated: number;
  unchanged: number;
  ignored: number;
  concurrentReplacements: Array<{
    localId: string;
    skill: string;
    replacedConcurrentVersion: string;
    acceptedVersion: string;
  }>;
  failures: SkillSyncFailure[];
}

/** A user-requested refresh of the current Core-authorized catalog. */
export class ManualRuntimeSkillSync {
  constructor(
    private readonly options: {
      core: RuntimeSkillSyncClient;
      verifyEnvelope(candidate: unknown, instanceId: string): boolean;
      instanceId: string;
      workspaceId: string;
      profiles: readonly RuntimeSkillProfile[];
      scratchRoot: string;
      now: () => number;
      publications?: LocalSkillPublicationStore;
    },
  ) {}

  async list(): Promise<RuntimeSkillListReport> {
    const envelope = await this.envelope();
    const skills = desiredSkills(envelope, true);
    const homeSkillIds = new Set(
      envelope.catalog.skills.filter(isGeneralHomeItem).map((skill) => skill.skillId),
    );
    const profiles: RuntimeSkillListReport["profiles"] = await Promise.all(
      uniqueProfiles(this.options.profiles).map((profile) =>
        listProfile({
          profile,
          skills,
          homeSkillIds,
          owner: { workspaceId: this.options.workspaceId, instanceId: this.options.instanceId },
        }),
      ),
    );
    return { catalogRevision: envelope.catalog.catalogRevision, skills, profiles };
  }

  async share(input: {
    skill: string;
    audience: RuntimeSkillShareAudience;
    initiativeIds?: readonly string[];
  }): Promise<RuntimeSkillSyncOwnerPublishResponse & { treeDigest: string }> {
    const snapshot = await snapshotLocalSkill(input.skill, this.options.profiles);
    const publication: LocalSkillPublication = LocalSkillPublicationSchema.parse({
      audience:
        input.audience.level === "organization"
          ? { kind: "organization" }
          : { kind: "systems", systemIds: input.audience.systemIds },
      context: input.initiativeIds?.length
        ? { kind: "initiatives", initiativeIds: [...input.initiativeIds] }
        : { kind: "global" },
      confirmOngoingPublication: true,
    });
    const tracked = this.options.publications
      ? (await this.options.publications.list()).filter(
          (record) =>
            record.identity === snapshot.identity ||
            (record.treeDigest === snapshot.tree.treeDigest &&
              record.skill.split(/[\\/]/).at(-1) === snapshot.name),
        )
      : [];
    const privateIdentity = makeLocalPersonalSkillShare(snapshot, this.options.instanceId).localId;
    const reuseLocalId = tracked.length === 1 ? tracked[0]!.localId : privateIdentity;
    const share = LocalRuntimeSkillShareSchema.parse(
      makeLocalSkillShare(snapshot, this.options.instanceId, publication, reuseLocalId),
    );
    const published = await this.options.core.shareRuntimeSkillSync(this.options.instanceId, share);
    if (this.options.publications) {
      try {
        await this.options.publications.save({
          binding: { workspaceId: this.options.workspaceId, instanceId: this.options.instanceId },
          localId: share.localId,
          skill: input.skill,
          identity: snapshot.identity,
          treeDigest: snapshot.tree.treeDigest,
          publication,
        });
      } catch {
        throw new RemoteInstanceError(
          "local_io_failure",
          "The Skill was published, but this runtime could not save automatic update tracking.",
        );
      }
    }
    return { ...published, treeDigest: snapshot.tree.treeDigest };
  }

  /** Automatically register private sources and reconcile their edits and removals. */
  async syncPersonal(): Promise<PersonalSkillSyncReport> {
    const store = this.options.publications;
    if (!store) return emptyPersonalSkillSyncReport(false);
    const profiles = uniqueProfiles(this.options.profiles);
    const report = emptyPersonalSkillSyncReport(true);
    if (!profiles.length) return report;
    const sources = await enumeratePersonalSkillSources(profiles);
    const records = await store.list();
    const seen = new Set<string>();
    let complete = sources.complete;
    for (const source of sources.items) {
      if (!(await this.syncPersonalSource(store, profiles, records, source, seen, report)))
        complete = false;
    }
    if (complete) await this.removeMissingPersonalSources(store, records, seen, report);
    return report;
  }

  private async syncPersonalSource(
    store: LocalSkillPublicationStore,
    profiles: readonly RuntimeSkillProfile[],
    records: readonly LocalSkillPublicationRecord[],
    source: PersonalSkillSource,
    seen: Set<string>,
    report: PersonalSkillSyncReport,
  ): Promise<boolean> {
    let share: LocalRuntimeSkillShare | undefined;
    try {
      const snapshot = await snapshotLocalSkill(source.name, profiles, source.identity);
      const privateShare = makeLocalPersonalSkillShare(snapshot, this.options.instanceId);
      const existing = findPersonalPublication(records, privateShare.localId, source.identity);
      share = preservePublicationId(snapshot, this.options.instanceId, privateShare, existing);
      seen.add(share.localId);
      if (isSharedPublication(existing)) return true;
      report.scanned += 1;
      if (existing?.treeDigest === share.tree.treeDigest) {
        report.unchanged += 1;
        return true;
      }
      await this.options.core.shareRuntimeSkillSync(this.options.instanceId, share);
      await store.save({
        binding: { workspaceId: this.options.workspaceId, instanceId: this.options.instanceId },
        localId: share.localId,
        skill: source.name,
        identity: source.identity,
        treeDigest: share.tree.treeDigest,
        publication: share.publication,
      });
      if (existing) report.updated += 1;
      else report.created += 1;
      return true;
    } catch (error) {
      report.failures.push({
        localId: share?.localId ?? source.identity,
        reason: errorCode(error),
      });
      return false;
    }
  }

  private async removeMissingPersonalSources(
    store: LocalSkillPublicationStore,
    records: readonly LocalSkillPublicationRecord[],
    seen: ReadonlySet<string>,
    report: PersonalSkillSyncReport,
  ): Promise<void> {
    for (const record of records) {
      if (record.publication.audience.kind !== "personal") continue;
      if (seen.has(record.localId)) continue;
      try {
        const request = LocalRuntimeSkillUnshareSchema.parse({
          localId: record.localId,
          confirm: true,
          removePersonal: true,
        });
        await this.options.core.unshareRuntimeSkillSync(this.options.instanceId, request);
        await store.remove(record.localId);
        report.deleted += 1;
      } catch (error) {
        report.failures.push({ localId: record.localId, reason: errorCode(error) });
      }
    }
  }

  async unshare(skill: string): Promise<{ skill: string; unshared: boolean }> {
    const store = this.options.publications;
    if (!store) throw unavailable();
    const matches = (await store.list()).filter((record) => record.skill === skill);
    if (matches.length !== 1) {
      throw new RemoteInstanceError(
        matches.length ? "protocol_incompatible" : "capability_unavailable",
        matches.length
          ? "More than one shared Skill matches; use the exact local path."
          : "No shared Skill with that name is tracked on this runtime.",
      );
    }
    const record = matches[0]!;
    if (record.publication.audience.kind === "personal") {
      throw new RemoteInstanceError(
        "capability_unavailable",
        "Personal Skills sync automatically; remove the local source to remove its private synced copy.",
      );
    }
    const request = LocalRuntimeSkillUnshareSchema.parse({
      localId: record.localId,
      confirm: true,
    });
    await store.markRevoking(record.localId);
    const result = await this.options.core.unshareRuntimeSkillSync(
      this.options.instanceId,
      request,
    );
    await store.save({
      ...record,
      revoking: false,
      publication: { audience: { kind: "personal" }, context: { kind: "global" } },
    });
    return { skill, unshared: result.unshared };
  }

  async syncPublished(): Promise<PublishedSkillSyncReport> {
    const store = this.options.publications;
    if (!store) return emptyPublishedSkillSyncReport(false);
    const report = emptyPublishedSkillSyncReport(true);
    for (const record of await store.list()) await this.syncPublishedRecord(store, record, report);
    return report;
  }

  private async syncPublishedRecord(
    store: LocalSkillPublicationStore,
    record: LocalSkillPublicationRecord,
    report: PublishedSkillSyncReport,
  ): Promise<void> {
    if (
      !isCurrentPublicationBinding(record, this.options.workspaceId, this.options.instanceId) ||
      record.revoking
    ) {
      report.ignored += 1;
      return;
    }
    report.scanned += 1;
    try {
      const snapshot = await snapshotLocalSkill(
        record.skill,
        this.options.profiles,
        record.identity,
      );
      const share = LocalRuntimeSkillShareSchema.parse(
        makeLocalSkillShare(snapshot, this.options.instanceId, record.publication, record.localId),
      );
      if (share.localId !== record.localId) throw unavailable();
      if (share.tree.treeDigest === record.treeDigest) {
        report.unchanged += 1;
        return;
      }
      const receipt = await this.options.core.shareRuntimeSkillSync(this.options.instanceId, share);
      recordConcurrentReplacement(report.concurrentReplacements, record.localId, receipt);
      await store.updateDigest(record.localId, share.tree.treeDigest);
      report.updated += 1;
    } catch (error) {
      report.failures.push({ localId: record.localId, reason: errorCode(error) });
    }
  }

  async sync(): Promise<RuntimeSkillSyncReport> {
    const envelope = await this.envelope();
    const desired = desiredSkills(envelope);
    const homeSkillIds = new Set(
      envelope.catalog.skills.filter(isGeneralHomeItem).map((skill) => skill.skillId),
    );
    const skills = desired.filter((skill) => homeSkillIds.has(skill.skillId));
    const profiles = uniqueProfiles(this.options.profiles);
    if (!profiles.length)
      return { catalogRevision: envelope.catalog.catalogRevision, status: "failed", skills, profiles: [] };
    const catalog = localCatalog(envelope, envelope.catalog.skills.filter(isGeneralHomeItem));
    const staged = await stageOrganizationSkills({
      scratchRoot: this.options.scratchRoot,
      catalog,
      authority: { binding: catalog.binding, catalogDigest: catalog.catalogDigest },
      assertAuthorized: () => this.authorize(envelope),
      fetchTree: async (manifest) => {
        const item = envelope.catalog.skills.find((skill) => skill.skillId === manifest.transferId);
        if (!item) throw unavailable();
        const tree = RemoteFileTreeSchema.parse(
          await this.options.core.readRuntimeSkillSync(
            this.options.instanceId,
            envelope,
            item.skillId,
          ),
        );
        if (
          tree.treeDigest !== item.treeDigest ||
          tree.entries.length !== item.fileCount ||
          tree.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) !== item.sizeBytes
        )
          throw unavailable();
        return tree;
      },
      now: this.options.now,
    });
    const results: RuntimeSkillSyncReport["profiles"] = [];
    const homes = new Map<string, Promise<Omit<RuntimeSkillSyncReport["profiles"][number], "profileId" | "agentId">>>();
    for (const profile of profiles) {
      let outcome = homes.get(profile.home);
      if (!outcome) {
        outcome = this.syncHome(profile.home, staged, envelope);
        homes.set(profile.home, outcome);
      }
      results.push({ ...await outcome, profileId: profile.profileId, agentId: profile.agentId });
    }
    const failures = results.filter((profile) => profile.status === "failed").length;
    return {
      catalogRevision: envelope.catalog.catalogRevision,
      status: failures === 0 ? "succeeded" : failures === results.length ? "failed" : "partial",
      skills,
      profiles: results,
    };
  }

  /** Shared general discovery homes need one write, but each profile keeps its own result. */
  private async syncHome(home: string, staged: StagedOrganizationSkills, envelope: RuntimeSkillSyncEnvelope): Promise<Omit<RuntimeSkillSyncReport["profiles"][number], "profileId" | "agentId">> {
    try {
      await syncAgentHomeSkills({
        home,
        owner: { workspaceId: this.options.workspaceId, instanceId: this.options.instanceId },
        staged,
        assertAuthorized: () => this.authorize(envelope),
      });
      return { status: "synchronized", installedSkills: staged.skills.length, loadedStatus: "unknown" };
    } catch (error) {
      return { status: "failed", installedSkills: null, loadedStatus: "unknown", reason: errorCode(error) };
    }
  }

  private async envelope(): Promise<RuntimeSkillSyncEnvelope> {
    const envelope = RuntimeSkillSyncEnvelopeSchema.safeParse(
      await this.options.core.prepareRuntimeSkillSync(this.options.instanceId),
    );
    const now = this.options.now();
    if (
      !envelope.success ||
      envelope.data.instanceId !== this.options.instanceId ||
      envelope.data.catalog.binding.workspaceId !== this.options.workspaceId ||
      envelope.data.catalog.binding.instanceId !== this.options.instanceId ||
      Date.parse(envelope.data.issuedAt) > now ||
      Date.parse(envelope.data.expiresAt) <= now ||
      !this.options.verifyEnvelope(envelope.data, this.options.instanceId)
    )
      throw unavailable();
    return envelope.data;
  }

  private async authorize(envelope: RuntimeSkillSyncEnvelope): Promise<void> {
    if (
      Date.parse(envelope.expiresAt) <= this.options.now() ||
      !this.options.verifyEnvelope(envelope, this.options.instanceId)
    )
      throw unavailable();
    await this.options.core.authorizeRuntimeSkillSync(this.options.instanceId, envelope);
  }
}

function localCatalog(envelope: RuntimeSkillSyncEnvelope, homeSkills = envelope.catalog.skills) {
  const binding = RemoteTransferBindingSchema.parse({
    workspaceId: envelope.catalog.binding.workspaceId,
    instanceId: envelope.catalog.binding.instanceId,
    sessionId: envelope.catalog.binding.syncId,
    assignmentId: envelope.catalog.binding.syncId,
    attempt: 1,
  });
  const body = {
    version: 1 as const,
    binding,
    catalogRevision: envelope.catalog.catalogRevision,
    skills: homeSkills.map((skill) => ({
      skillId: skill.skillId,
      version: skill.version,
      name: skill.name,
      description: skill.description,
      required: true as const,
      transfer: {
        version: 1 as const,
        transferId: skill.skillId,
        binding,
        direction: "to_runtime" as const,
        purpose: "organization_skill" as const,
        revision: skill.version,
        artifactRef: skill.skillId,
        treeDigest: skill.treeDigest,
        sizeBytes: skill.sizeBytes,
        fileCount: skill.fileCount,
        expiresAt: envelope.expiresAt,
      },
    })),
  };
  return RemoteSkillCatalogSchema.parse({
    ...body,
    catalogDigest: computeRemoteSkillCatalogDigest(body),
  });
}

function desiredSkills(
  envelope: RuntimeSkillSyncEnvelope,
  includeRestrictedInventory = false,
): DesiredSkillView[] {
  const transferable: DesiredSkillView[] = envelope.catalog.skills.map((skill) => ({
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    desiredVersion: skill.version,
    treeDigest: skill.treeDigest,
    audience: skill.scope?.audience ?? null,
    initiativeIds:
      skill.scope?.context.kind === "initiatives"
        ? [...skill.scope.context.initiativeIds]
        : skill.scope
          ? []
          : null,
  }));
  if (!includeRestrictedInventory) return transferable;
  const inventory: DesiredSkillView[] = (envelope.catalog.inventory ?? []).map((skill) => ({
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    desiredVersion: skill.version,
    treeDigest: null,
    audience: skill.scope.audience,
    initiativeIds:
      skill.scope.context.kind === "initiatives" ? [...skill.scope.context.initiativeIds] : [],
  }));
  return [...transferable, ...inventory].sort((left, right) =>
    left.skillId.localeCompare(right.skillId),
  );
}

function isGeneralHomeItem(skill: RuntimeSkillSyncItem): boolean {
  const scope = skill.scope;
  return Boolean(
    scope &&
    scope.context.kind === "global" &&
    (scope.audience.kind === "personal" || scope.audience.kind === "organization"),
  );
}

async function enumeratePersonalSkillSources(profiles: readonly RuntimeSkillProfile[]): Promise<{
  complete: boolean;
  items: PersonalSkillSource[];
}> {
  const items: PersonalSkillSource[] = [];
  let complete = true;
  for (const profile of profiles) {
    const scan = await enumeratePersonalSkillProfile(profile);
    if (!scan.complete) complete = false;
    items.push(...scan.items);
  }
  items.sort((left, right) => left.identity.localeCompare(right.identity, "en"));
  return { complete, items };
}

async function enumeratePersonalSkillProfile(profile: RuntimeSkillProfile): Promise<{
  complete: boolean;
  items: PersonalSkillSource[];
}> {
  const homeInfo = await stat(profile.home).catch(() => undefined);
  if (!homeInfo?.isDirectory()) return { complete: false, items: [] };
  const entries = await readPersonalSkillNames(profile.home);
  if (!entries) return { complete: false, items: [] };
  const items: PersonalSkillSource[] = [];
  let complete = true;
  for (const name of entries) {
    const source = await inspectPersonalSkillEntry(profile, name);
    if (source === undefined) complete = false;
    else if (source) items.push(source);
  }
  return { complete, items };
}

async function readPersonalSkillNames(home: string): Promise<string[] | undefined> {
  try {
    return await readdir(join(home, "skills"));
  } catch {
    return undefined;
  }
}

async function inspectPersonalSkillEntry(
  profile: RuntimeSkillProfile,
  name: string,
): Promise<PersonalSkillSource | null | undefined> {
  const info = await lstat(join(profile.home, "skills", name)).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  return { name, identity: `${profile.profileId}:skills/${name}` };
}

function uniqueProfiles(profiles: readonly RuntimeSkillProfile[]): RuntimeSkillProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const key = `${profile.agentId}\0${profile.profileId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function listProfile(input: {
  profile: RuntimeSkillProfile;
  skills: DesiredSkillView[];
  homeSkillIds: ReadonlySet<string>;
  owner: { workspaceId: string; instanceId: string };
}): Promise<RuntimeSkillListReport["profiles"][number]> {
  const { profile, skills, homeSkillIds, owner } = input;
  try {
    const inventory = await inspectAgentHomeSkillSync({
      home: profile.home,
      owner,
      skills: skills.filter((skill) => homeSkillIds.has(skill.skillId)),
    });
    const statuses = new Map(inventory.skills.map((skill) => [skill.skillId, skill]));
    return {
      profileId: profile.profileId,
      agentId: profile.agentId,
      profileState: inventory.profileState,
      skills: skills.map((skill) =>
        listedSkill(skill, statuses.get(skill.skillId), !homeSkillIds.has(skill.skillId)),
      ),
    };
  } catch (error) {
    return {
      profileId: profile.profileId,
      agentId: profile.agentId,
      profileState: "unavailable",
      reason: errorCode(error),
      skills: skills.map((skill) => listedSkill(skill, undefined, true)),
    };
  }
}

function listedSkill(
  skill: DesiredSkillView,
  installed?: Awaited<ReturnType<typeof inspectAgentHomeSkillSync>>["skills"][number],
  unavailable = false,
) {
  return {
    ...skill,
    installedVersion: installed?.installedVersion ?? null,
    installedDigest: installed?.installedDigest ?? null,
    installedStatus: resolveInstalledStatus(skill, installed, unavailable),
    loadedVersion: null,
    loadedStatus: "unknown" as const,
  };
}

function resolveInstalledStatus(
  skill: DesiredSkillView,
  installed: Awaited<ReturnType<typeof inspectAgentHomeSkillSync>>["skills"][number] | undefined,
  unavailable: boolean,
): RuntimeSkillListReport["profiles"][number]["skills"][number]["installedStatus"] {
  if (isContextRestrictedSkill(skill)) return "restricted";
  if (!installed) return unavailable ? "unknown" : "missing";
  if (installed.status !== "installed") return installed.status;
  return installedMatchesDesiredSkill(skill, installed) ? "current" : "stale";
}

function isContextRestrictedSkill(skill: DesiredSkillView): boolean {
  return skill.audience?.kind === "systems" || (skill.initiativeIds?.length ?? 0) > 0;
}

function installedMatchesDesiredSkill(
  skill: DesiredSkillView,
  installed: Awaited<ReturnType<typeof inspectAgentHomeSkillSync>>["skills"][number],
): boolean {
  return (
    installed.installedVersion === skill.desiredVersion &&
    installed.installedDigest === skill.treeDigest
  );
}

function emptyPersonalSkillSyncReport(configured: boolean): PersonalSkillSyncReport {
  return { configured, scanned: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, failures: [] };
}

function emptyPublishedSkillSyncReport(configured: boolean): PublishedSkillSyncReport {
  return {
    configured,
    scanned: 0,
    updated: 0,
    unchanged: 0,
    ignored: 0,
    concurrentReplacements: [],
    failures: [],
  };
}

function findPersonalPublication(
  records: readonly LocalSkillPublicationRecord[],
  localId: string,
  identity: string,
): LocalSkillPublicationRecord | undefined {
  const exact = records.find((record) => record.localId === localId);
  if (exact) return exact;
  const sameSource = records.filter((record) => record.identity === identity);
  return sameSource.length === 1 ? sameSource[0] : undefined;
}

function isSharedPublication(record: LocalSkillPublicationRecord | undefined): boolean {
  return Boolean(record && record.publication.audience.kind !== "personal");
}

function preservePublicationId(
  snapshot: Awaited<ReturnType<typeof snapshotLocalSkill>>,
  instanceId: string,
  personalShare: LocalRuntimeSkillShare,
  existing: LocalSkillPublicationRecord | undefined,
): LocalRuntimeSkillShare {
  if (existing && existing.localId !== personalShare.localId) {
    return makeLocalSkillShare(snapshot, instanceId, personalShare.publication, existing.localId);
  }
  return personalShare;
}

function isCurrentPublicationBinding(
  record: LocalSkillPublicationRecord,
  workspaceId: string,
  instanceId: string,
): boolean {
  return record.binding.workspaceId === workspaceId && record.binding.instanceId === instanceId;
}

function errorCode(error: unknown): string {
  return error instanceof RemoteInstanceError ? error.code : "capability_unavailable";
}

const unavailable = () =>
  new RemoteInstanceError(
    "capability_unavailable",
    "The current Skill catalog could not be verified or synchronized.",
  );
