import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { jcsDigest, RuntimeUpdateFailureSchema, RuntimeUpdateIntentSchema, writeSecretFile } from "@konteks/remote-common";
import { unrestrictedStateMutation, type StateMutation } from "../state/mutation-gate.js";

const RecordSchema = z.object({
  intent: RuntimeUpdateIntentSchema,
  intentDigest: z.string().min(1).max(128),
  receivedAt: z.string().datetime({ offset: true }),
  /** Previously observed attempts cannot settle this newly received action. */
  knownAttemptIds: z.array(z.string().min(1).max(128)).max(50),
  state: z.enum(["requested", "updating", "succeeded", "failed"]),
  failure: RuntimeUpdateFailureSchema.optional(),
  reportPending: z.boolean(),
}).strict().refine(value => (value.state === "failed") === (value.failure !== undefined))
  .refine(value => value.intentDigest === jcsDigest(value.intent));
const DeliverySchema = z.object({ keyId: z.string(), nonce: z.string(), intentDigest: z.string(), expiresAt: z.string().datetime({ offset: true }) }).strict();
const JournalSchema = z.object({ schemaVersion: z.literal(1), records: z.array(RecordSchema).max(50), deliveries: z.array(DeliverySchema).max(200) }).strict();

export type RuntimeUpdateRecord = z.infer<typeof RecordSchema>;
export type RuntimeUpdateJournal = z.infer<typeof JournalSchema>;

/** Atomic, root-owned memory of the fixed operations, not a queue of commands.
 * Invalid memory refuses admission; it is never discarded to permit a replay. */
export class RuntimeUpdateStore {
  constructor(private readonly path: string, private readonly mutate: StateMutation = unrestrictedStateMutation) {}

  async read(): Promise<RuntimeUpdateJournal> {
    const info = await lstat(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return { schemaVersion: 1, records: [], deliveries: [] };
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("runtime update memory is not a readable file");
    return JournalSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
  }

  write(journal: RuntimeUpdateJournal, assertCurrent: () => void): Promise<void> {
    const serialized = JSON.stringify(JournalSchema.parse(journal));
    return this.mutate(async () => {
      assertCurrent();
      await writeSecretFile(this.path, serialized);
      assertCurrent();
    });
  }
}
