import { z } from "zod";
import {
  computeExecutionRevisionControlIntentDigest,
  RemoteExecutionRevisionControlIntentSchema,
  RemoteInstanceError,
  type RemoteExecutionRevisionControlIntent,
} from "@konteks/remote-common";

const DigestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Immutable native evidence accepted before the matching execution gate is
 * fenced. It deliberately contains no stop, provider, or terminal outcome.
 */
const ExecutionRevisionFenceInboxRecordBaseSchema = z
  .object({
    version: z.literal(1),
    intent: RemoteExecutionRevisionControlIntentSchema,
    intentDigest: DigestSchema,
    runnerIncarnation: z.string().min(1).max(200),
    connectionRef: z.string().min(1).max(200),
    connectionEpoch: z.number().int().positive(),
    receivedAt: z.string().datetime(),
  })
  .strict();

export const ExecutionRevisionFenceInboxRecordSchema =
  ExecutionRevisionFenceInboxRecordBaseSchema.superRefine((record, ctx) => {
    if (
      record.intentDigest !==
      computeExecutionRevisionControlIntentDigest(record.intent)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["intentDigest"],
        message: "Revision fence inbox identity mismatch",
      });
    }
    const receivedAt = Date.parse(record.receivedAt);
    const issuedAt = Date.parse(record.intent.issuedAt);
    const deadlineAt = Date.parse(record.intent.deadlineAt);
    if (receivedAt < issuedAt || receivedAt > deadlineAt) {
      ctx.addIssue({
        code: "custom",
        path: ["receivedAt"],
        message: "Revision fence inbox record is outside the control deadline",
      });
    }
  });

export type ExecutionRevisionFenceInboxRecord = z.infer<
  typeof ExecutionRevisionFenceInboxRecordSchema
>;

const ExecutionRevisionFenceInboxInputSchema =
  ExecutionRevisionFenceInboxRecordBaseSchema.omit({
    version: true,
    receivedAt: true,
  });

export interface ExecutionRevisionFenceInboxLog {
  all(): ExecutionRevisionFenceInboxRecord[];
  update(
    key: string,
    derive: (
      existing: ExecutionRevisionFenceInboxRecord | undefined,
    ) => ExecutionRevisionFenceInboxRecord,
  ): Promise<void>;
}

/**
 * A revision tuple is the authority target. A second digest for the same tuple
 * would make a retained native fence ambiguous, so it requires recovery.
 */
export function executionRevisionFenceTuple(
  intent: RemoteExecutionRevisionControlIntent,
): string {
  return JSON.stringify([
    intent.tenantId,
    intent.instanceId,
    intent.executionId,
    intent.executionRevision,
    intent.checkId,
    intent.policyRevision,
  ]);
}

/**
 * Durable, bounded pre-fence intake. The receiver owns signature and current
 * socket checks; this boundary independently validates immutable identity and
 * deadline before it writes evidence.
 */
export class ExecutionRevisionFenceInbox {
  constructor(
    private readonly log: ExecutionRevisionFenceInboxLog,
    private readonly maxEntries = 2_000,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 2_000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 8 * 1024 * 1024
    ) {
      throw new Error("Revision fence inbox capacity must be bounded");
    }
  }

  pending(): ExecutionRevisionFenceInboxRecord[] {
    return structuredClone(this.log.all());
  }

  async receiveVerified(
    candidate: unknown,
    receivedAt: string,
    assertCurrent: () => void,
  ): Promise<ExecutionRevisionFenceInboxRecord> {
    const input = ExecutionRevisionFenceInboxInputSchema.parse(candidate);
    const record = ExecutionRevisionFenceInboxRecordSchema.parse({
      version: 1,
      ...input,
      receivedAt,
    });
    const tuple = executionRevisionFenceTuple(record.intent);
    let accepted: ExecutionRevisionFenceInboxRecord | undefined;

    await this.log.update(record.intent.intentId, (existing) => {
      assertCurrent();
      if (existing) {
        if (
          existing.intentDigest !== record.intentDigest ||
          executionRevisionFenceTuple(existing.intent) !== tuple
        ) {
          throw new RemoteInstanceError(
            "recovery_required",
            "Revision fence intent conflicts with retained evidence",
          );
        }
        accepted = existing;
        return existing;
      }

      const records = this.log.all();
      if (
        records.some(
          (value) =>
            executionRevisionFenceTuple(value.intent) === tuple &&
            value.intentDigest !== record.intentDigest,
        )
      ) {
        throw new RemoteInstanceError(
          "recovery_required",
          "Revision fence target conflicts with retained evidence",
        );
      }
      const bytes = records.reduce(
        (total, value) => total + Buffer.byteLength(JSON.stringify(value), "utf8"),
        Buffer.byteLength(JSON.stringify(record), "utf8"),
      );
      if (records.length >= this.maxEntries || bytes > this.maxBytes) {
        throw new RemoteInstanceError(
          "recovery_required",
          "Revision fence inbox capacity requires recovery",
        );
      }
      accepted = record;
      return record;
    });

    // Retain the fsynced fact if ownership changed while writing, but never
    // let the stale owner continue to a fence or receipt step.
    assertCurrent();
    if (!accepted) {
      throw new RemoteInstanceError(
        "recovery_required",
        "Revision fence receipt is not durable",
      );
    }
    return structuredClone(accepted);
  }
}
