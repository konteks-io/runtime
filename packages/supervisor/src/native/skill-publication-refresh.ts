import { lstat } from "node:fs/promises";
import { isFsErrorWithCode } from "@konteks/remote-common";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { SkillPublicationStore } from "../state/skill-publications.js";
import {
  discoverLocalSkills,
  exportLocalSkill,
  inspectLocalSkillPath,
} from "../skills/local-skills.js";
import type { NativeSkillSyncClient } from "./skill-sync-client.js";

/** Independent source failures; runtime authority and cancellation were rechecked. */
export class SkillPublicationPartialFailure extends AggregateError {
  constructor(failures: unknown[]) {
    super(failures, "One or more Skill publications failed");
  }
}

async function inspectPublicationSource(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      let parent;
      try {
        parent = await lstat(dirname(path));
      } catch {
        throw new Error("Skill source home is unavailable");
      }
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Skill source home is unavailable");
      return undefined;
    }
    throw error;
  }
  return inspectLocalSkillPath(path);
}

type PublicationRecord = Awaited<ReturnType<SkillPublicationStore["list"]>>[number];
type RefreshOptions = {
  store: Pick<SkillPublicationStore, "save" | "remove">;
  client: Pick<NativeSkillSyncClient, "share" | "unshare">;
  homes: readonly string[];
  tenantId: string;
  runtimeId: string;
};

async function revokeDeletedPersonalSource(
  record: PublicationRecord,
  options: RefreshOptions,
  signal: AbortSignal,
  check: () => void,
): Promise<void> {
  if (record.selection.audience.kind !== "personal" || !record.sourcePath) return;
  if (!record.selection.skillId)
    throw new Error("Personal Skill removal requires its accepted publication identity");
  const receipt = await options.client.unshare(
    {
      requestId: randomUUID(),
      publicationId: record.receipt.publicationId,
      skillId: record.selection.skillId,
      confirmation: { revokePublication: true },
    },
    signal,
  );
  check();
  if (
    receipt.publicationId !== record.receipt.publicationId ||
    receipt.skillId !== record.selection.skillId
  )
    throw new Error("Personal Skill removal was not acknowledged");
  await options.store.remove(options.tenantId, options.runtimeId, record.selection.localId);
}

async function publishChangedSource(
  record: PublicationRecord,
  current: NonNullable<Awaited<ReturnType<typeof inspectPublicationSource>>>,
  options: RefreshOptions,
  signal: AbortSignal,
  check: () => void,
): Promise<void> {
  if (current.localId !== record.selection.localId)
    throw new Error("Shared Skill source identity changed");
  if (current.treeDigest === record.receipt.treeDigest) return;
  if (!record.selection.skillId)
    throw new Error(
      "Shared Skill requires a new sharing confirmation before automatic publication",
    );
  const selection = {
    ...record.selection,
    treeDigest: current.treeDigest,
    requestId: randomUUID(),
    expectedRevision: record.receipt.revisionId,
  };
  const tree = await exportLocalSkill(options.homes, selection, record.sourcePath);
  check();
  const result = await options.client.share({ ...selection, tree }, signal);
  check();
  if (!result.runtimePublication) throw new Error("Shared Skill revision was not acknowledged");
  await options.store.save({ ...record, selection, receipt: result.runtimePublication });
}

async function refreshPublicationRecord(
  record: PublicationRecord,
  discovered: Awaited<ReturnType<typeof discoverLocalSkills>>,
  options: RefreshOptions,
  signal: AbortSignal,
  check: () => void,
): Promise<void> {
  check();
  const current =
    record.sourcePath === undefined
      ? discovered.find((skill) => skill.localId === record.selection.localId)
      : await inspectPublicationSource(record.sourcePath);
  if (!current) return revokeDeletedPersonalSource(record, options, signal, check);
  await publishChangedSource(record, current, options, signal, check);
}

/** Reconcile consented publications; only a missing personal source revokes its private copy. */
export async function refreshSkillPublications(
  options: {
    store: Pick<SkillPublicationStore, "list" | "save" | "remove">;
    client: Pick<NativeSkillSyncClient, "share" | "unshare">;
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
  const discovered = await discoverLocalSkills(options.homes);
  const failures: unknown[] = [];
  for (const record of records) {
    check();
    try {
      await refreshPublicationRecord(record, discovered, options, signal, check);
    } catch (error) {
      check();
      failures.push(error);
    }
  }
  check();
  if (failures.length) throw new SkillPublicationPartialFailure(failures);
}
