import { z } from "zod";
import { RemoteInstanceError, RuntimeCancellationIntentSchema, runtimeCancellationIntentDigest } from "@konteks/remote-common";

export const CancellationInboxRecordSchema = z.object({
  version: z.literal(1), intent: RuntimeCancellationIntentSchema,
  intentDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), receivedAt: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  if (record.intentDigest !== runtimeCancellationIntentDigest(record.intent)) {
    ctx.addIssue({ code: "custom", message: "Cancellation inbox identity mismatch" });
  }
});
export type CancellationInboxRecord = z.infer<typeof CancellationInboxRecordSchema>;
export interface CancellationInboxLog {
  all(): CancellationInboxRecord[];
  update(key: string, derive: (existing: CancellationInboxRecord | undefined) => CancellationInboxRecord): Promise<void>;
}

/** Storage only. Receiver must verify both signatures and exact destination
 * before invoking this owner. All accepted records remain replayable: no
 * automatic pruning, timeout expiry or fabricated execution-stop transition.
 */
export class CancellationInbox {
  constructor(private readonly log: CancellationInboxLog,
    private readonly maxEntries = 2000, private readonly maxBytes = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
      throw new Error("Cancellation inbox capacity must be bounded");
    }
  }

  pending(): CancellationInboxRecord[] {
    return structuredClone(this.log.all());
  }

  async receiveVerified(candidate: unknown, receivedAt: string, assertCurrent: () => void): Promise<CancellationInboxRecord> {
    const intent = RuntimeCancellationIntentSchema.parse(candidate);
    const record = CancellationInboxRecordSchema.parse({ version: 1, intent,
      intentDigest: runtimeCancellationIntentDigest(intent), receivedAt });
    let accepted: CancellationInboxRecord | undefined;
    await this.log.update(intent.intentId, existing => {
      assertCurrent();
      if (existing) {
        if (existing.intentDigest !== record.intentDigest) {
          throw new RemoteInstanceError("recovery_required", "Cancellation intent conflicts with retained evidence");
        }
        accepted = existing;
        return existing;
      }
      const records = this.log.all();
      const bytes = records.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value), "utf8"),
        Buffer.byteLength(JSON.stringify(record), "utf8"));
      if (records.length >= this.maxEntries || bytes > this.maxBytes) {
        throw new RemoteInstanceError("recovery_required", "Cancellation inbox capacity requires recovery");
      }
      accepted = record;
      return record;
    });
    // A connection can change while fsync is pending. Keep the durable inbox,
    // but withhold the old connection's acknowledgement; a current retry dedups.
    assertCurrent();
    if (!accepted) throw new RemoteInstanceError("recovery_required", "Cancellation receipt is not durable");
    return structuredClone(accepted);
  }
}
