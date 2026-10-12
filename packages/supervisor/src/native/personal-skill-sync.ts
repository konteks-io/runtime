import { randomUUID } from "node:crypto";
import {
  RuntimeSkillPublicationSelectionSchema,
  type RuntimeSkillSyncItem,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import type { SkillPublicationStore } from "../state/skill-publications.js";
import type { NativeSkillSyncClient } from "./skill-sync-client.js";
import {
  discoverLocalSkills,
  exportLocalSkill,
  findLocalSkillPath,
} from "../skills/local-skills.js";

export class PersonalSkillSyncPartialFailure extends AggregateError {
  constructor(failures: unknown[]) {
    super(failures, "One or more personal Skills could not be synchronized");
  }
}

type PersonalSkillTarget = Pick<
  RuntimeSkillSyncItem,
  "name" | "skillId" | "revisionId" | "treeDigest"
>;
type PersonalSkillTargets = Map<string, PersonalSkillTarget[]>;

function ownerPersonalTargets(skills: readonly RuntimeSkillSyncItem[]): PersonalSkillTargets {
  const targets: PersonalSkillTargets = new Map();
  for (const skill of skills) {
    if (skill.scope?.audience.kind !== "personal") continue;
    const target = {
      name: skill.name,
      skillId: skill.skillId,
      revisionId: skill.revisionId,
      treeDigest: skill.treeDigest,
    };
    targets.set(skill.name, [...(targets.get(skill.name) ?? []), target]);
  }
  return targets;
}

function ownerTargetForSkill(targets: PersonalSkillTargets, name: string) {
  const matches = targets.get(name) ?? [];
  if (matches.length > 1) throw new Error("Personal Skill name is ambiguous in the owner catalog");
  const target = matches[0];
  if (target && (!target.revisionId || !target.treeDigest))
    throw new Error("Personal Skill revision is missing from the owner catalog");
  return target;
}

async function publishPersonalSkill(
  options: {
    store: Pick<SkillPublicationStore, "save">;
    client: Pick<NativeSkillSyncClient, "share">;
    homes: readonly string[];
    tenantId: string;
    runtimeId: string;
  },
  skill: Awaited<ReturnType<typeof discoverLocalSkills>>[number],
  targets: PersonalSkillTargets,
  signal: AbortSignal,
  check: () => void,
): Promise<void> {
  const target = ownerTargetForSkill(targets, skill.name);
  const selection = RuntimeSkillPublicationSelectionSchema.parse({
    requestId: randomUUID(),
    localId: skill.localId,
    treeDigest: skill.treeDigest,
    audience: { kind: "personal" },
    context: { kind: "global" },
    ...(target ? { skillId: target.skillId, expectedRevision: target.revisionId } : {}),
  });
  const sourcePath = await findLocalSkillPath(options.homes, skill.localId);
  if (!sourcePath) throw new Error("Personal Skill source is no longer available");
  const tree = await exportLocalSkill(options.homes, skill, sourcePath);
  check();
  const result = await options.client.share({ ...selection, tree }, signal);
  check();
  const receipt = result.runtimePublication;
  if (!receipt || receipt.treeDigest !== skill.treeDigest)
    throw new Error("Personal Skill publication was not acknowledged");
  await options.store.save({
    version: 1,
    tenantId: options.tenantId,
    runtimeId: options.runtimeId,
    selection: { ...selection, skillId: result.id, expectedRevision: receipt.revisionId },
    receipt,
    sourcePath,
  });
  targets.set(skill.name, [
    {
      name: skill.name,
      skillId: result.id,
      revisionId: receipt.revisionId,
      treeDigest: receipt.treeDigest,
    },
  ]);
}

/** Automatically publish local private sources and reconcile them to their owner's catalog. */
export async function syncPersonalSkills(
  options: {
    store: Pick<SkillPublicationStore, "list" | "save">;
    client: Pick<NativeSkillSyncClient, "prepare" | "share">;
    homes: readonly string[];
    tenantId: string;
    runtimeId: string;
    assertReady: () => void;
  },
  signal: AbortSignal,
): Promise<void> {
  const check = () => {
    signal.throwIfAborted();
    options.assertReady();
  };
  check();
  const records = await options.store.list(options.tenantId, options.runtimeId);
  const recordedSources = new Set(records.map((record) => record.selection.localId));
  const localSkills = (await discoverLocalSkills(options.homes))
    .filter((skill) => !recordedSources.has(skill.localId))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.localId.localeCompare(right.localId),
    );
  if (!localSkills.length) return;

  const envelope = await options.client.prepare(signal);
  check();
  const targets = ownerPersonalTargets(envelope.catalog.skills);
  const failures: unknown[] = [];
  for (const skill of localSkills) {
    check();
    try {
      await publishPersonalSkill(options, skill, targets, signal, check);
    } catch (error) {
      check();
      failures.push(error);
    }
  }
  check();
  if (failures.length) throw new PersonalSkillSyncPartialFailure(failures);
}
