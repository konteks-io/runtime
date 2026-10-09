import { lstat } from "node:fs/promises";
import { isFsErrorWithCode } from "@konteks/remote-common";
import { randomUUID } from "node:crypto";
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
    if (isFsErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
  return inspectLocalSkillPath(path);
}

/** Reconcile only previously consented publications; missing sources never delete shared history. */
export async function refreshSkillPublications(
  options: {
    store: Pick<SkillPublicationStore, "list" | "save">;
    client: Pick<NativeSkillSyncClient, "share">;
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
  const refresh = async (record: Awaited<ReturnType<typeof options.store.list>>[number]) => {
    check();
    const current =
      record.sourcePath === undefined
        ? discovered.find((skill) => skill.localId === record.selection.localId)
        : await inspectPublicationSource(record.sourcePath);
    if (!current) return;
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
  };
  for (const record of records) {
    check();
    try {
      await refresh(record);
    } catch (error) {
      check();
      failures.push(error);
    }
  }
  check();
  if (failures.length) throw new SkillPublicationPartialFailure(failures);
}
