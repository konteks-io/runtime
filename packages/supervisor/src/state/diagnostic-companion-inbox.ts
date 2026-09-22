import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DiagnosticCarrierCompanionSchema,
  RemoteInstanceError,
  type DiagnosticCarrierCompanion,
} from "@konteks/remote-common";

const DeliveryDigestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A bounded, redacted join record for a separately delivered C01 companion. */
const DiagnosticCompanionInboxRecordBaseSchema = z
  .object({
    version: z.literal(1),
    companion: DiagnosticCarrierCompanionSchema,
    deliveryDigest: DeliveryDigestSchema,
    runnerIncarnation: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(200),
    connectionRef: z.string().min(1).max(200),
    connectionEpoch: z.number().int().positive(),
    receivedAt: z.string().datetime(),
  })
  .strict();

export const DiagnosticCompanionInboxRecordSchema =
  DiagnosticCompanionInboxRecordBaseSchema.superRefine((record, ctx) => {
    if (record.deliveryDigest !== diagnosticCompanionDigest(record.companion)) {
      ctx.addIssue({
        code: "custom",
        path: ["deliveryDigest"],
        message: "Diagnostic companion delivery identity mismatch",
      });
    }
  });

export type DiagnosticCompanionInboxRecord = z.infer<
  typeof DiagnosticCompanionInboxRecordSchema
>;

const DiagnosticCompanionInboxInputSchema =
  DiagnosticCompanionInboxRecordBaseSchema.omit({ version: true, receivedAt: true });

export interface DiagnosticCompanionInboxLog {
  all(): DiagnosticCompanionInboxRecord[];
  update(
    key: string,
    derive: (
      existing: DiagnosticCompanionInboxRecord | undefined,
    ) => DiagnosticCompanionInboxRecord,
  ): Promise<void>;
}

/** This digest identifies only the diagnostic sidecar, never work or authority. */
export function diagnosticCompanionDigest(
  companion: DiagnosticCarrierCompanion,
): string {
  return createHash("sha256")
    .update(JSON.stringify(DiagnosticCarrierCompanionSchema.parse(companion)), "utf8")
    .digest("base64url");
}

/**
 * Durable C01 diagnostic intake. The record is a correlation aid only: it
 * cannot admit, retry, acknowledge, fence, or terminate an assignment.
 */
export class DiagnosticCompanionInbox {
  constructor(
    private readonly log: DiagnosticCompanionInboxLog,
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
      throw new Error("Diagnostic companion inbox capacity must be bounded");
    }
  }

  all(): DiagnosticCompanionInboxRecord[] {
    return structuredClone(this.log.all());
  }

  async receiveVerified(
    candidate: unknown,
    receivedAt: string,
    assertCurrent: () => void,
  ): Promise<DiagnosticCompanionInboxRecord> {
    const input = DiagnosticCompanionInboxInputSchema.parse(candidate);
    const record = DiagnosticCompanionInboxRecordSchema.parse({
      version: 1,
      ...input,
      receivedAt,
    });
    let accepted: DiagnosticCompanionInboxRecord | undefined;

    await this.log.update(record.companion.deliveryId, existing => {
      assertCurrent();
      if (existing) {
        if (
          existing.deliveryDigest !== record.deliveryDigest ||
          existing.runnerIncarnation !== record.runnerIncarnation ||
          existing.nodeId !== record.nodeId
        ) {
          throw new RemoteInstanceError(
            "recovery_required",
            "Diagnostic companion conflicts with retained evidence",
          );
        }
        accepted = existing;
        return existing;
      }
      const records = this.log.all();
      const bytes = records.reduce(
        (total, value) => total + Buffer.byteLength(JSON.stringify(value), "utf8"),
        Buffer.byteLength(JSON.stringify(record), "utf8"),
      );
      if (records.length >= this.maxEntries || bytes > this.maxBytes) {
        throw new RemoteInstanceError(
          "recovery_required",
          "Diagnostic companion inbox capacity requires recovery",
        );
      }
      accepted = record;
      return record;
    });

    // Retain a completed local write even if socket ownership changes later;
    // the stale socket must never claim that diagnostic delivery was current.
    assertCurrent();
    if (!accepted) {
      throw new RemoteInstanceError(
        "recovery_required",
        "Diagnostic companion receipt is not durable",
      );
    }
    return structuredClone(accepted);
  }
}
