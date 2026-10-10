import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { isFsErrorWithCode, writeSecretFile } from "@konteks/remote-common";
import {
  RuntimeSkillShareRequestSchema,
  RuntimeSkillPublicationReceiptSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { unrestrictedStateMutation, type StateMutation } from "./mutation-gate.js";

const recordSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().min(1).max(256),
    runtimeId: z.string().min(1).max(256),
    selection: RuntimeSkillShareRequestSchema,
    receipt: RuntimeSkillPublicationReceiptSchema,
    sourcePath: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (value) => value.selection.treeDigest === value.receipt.treeDigest,
    "Publication receipt differs from source",
  );
type Record = z.infer<typeof recordSchema>;
function sameAcceptance(previous: Record, current: Record): boolean {
  const repeated = {
    ...current,
    selection: {
      ...current.selection,
      requestId: previous.selection.requestId,
      expectedRevision: previous.selection.expectedRevision,
      ...(previous.selection.skillId === undefined ? { skillId: undefined } : {}),
    },
  };
  return JSON.stringify(previous) === JSON.stringify(repeated);
}

function assertPublicationIdentity(previous: Record | null, current: Record): void {
  if (!previous) return;
  if (previous.receipt.publicationId !== current.receipt.publicationId)
    throw new Error("Skill publication relationship changed");
  if (previous.selection.skillId && previous.selection.skillId !== current.selection.skillId)
    throw new Error("Skill publication identity changed");
}

/** Private publication intent and acceptance; this never represents agent load proof. */
export class SkillPublicationStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly mutate: StateMutation = unrestrictedStateMutation,
  ) {}
  private path(value: Pick<Record, "tenantId" | "runtimeId" | "selection">): string {
    const key = createHash("sha256")
      .update(JSON.stringify([value.tenantId, value.runtimeId, value.selection.localId]))
      .digest("hex");
    return join(this.directory, `${key}.json`);
  }
  private async previous(value: Record): Promise<Record | null> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(this.path(value), "utf8")));
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
  }
  async list(tenantId: string, runtimeId: string): Promise<Record[]> {
    await this.tail;
    const files = await this.files();
    const records: Record[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      if (!file.isFile()) throw new Error("Skill publication record is not a regular file");
      const record = recordSchema.parse(
        JSON.parse(await readFile(join(this.directory, file.name), "utf8")),
      );
      if (this.path(record) !== join(this.directory, file.name))
        throw new Error("Skill publication record identity changed");
      if (record.tenantId === tenantId && record.runtimeId === runtimeId) records.push(record);
    }
    return records;
  }
  private async files() {
    try {
      return await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return [];
      throw error;
    }
  }
  private async retainRepeated(previous: Record, current: Record): Promise<void> {
    if (!sameAcceptance(previous, current)) throw new Error("Skill publication revision changed");
    if (previous.selection.skillId || !current.selection.skillId) return;
    await writeSecretFile(
      this.path(previous),
      `${JSON.stringify({
        ...previous,
        selection: {
          ...previous.selection,
          skillId: current.selection.skillId,
          expectedRevision: current.selection.expectedRevision,
        },
      })}\n`,
    );
  }
  save(input: unknown): Promise<void> {
    const record = recordSchema.parse(input);
    const task = this.tail.then(() =>
      this.mutate(async () => {
        const previous = await this.previous(record);
        assertPublicationIdentity(previous, record);
        if (previous && previous.receipt.acceptedSequence > record.receipt.acceptedSequence) return;
        if (previous?.receipt.acceptedSequence === record.receipt.acceptedSequence) {
          await this.retainRepeated(previous, record);
          return;
        }
        await writeSecretFile(this.path(record), `${JSON.stringify(record)}\n`);
      }),
    );
    this.tail = task.catch(() => undefined);
    return task;
  }
}
