import { open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DesiredConfigurationAckSchema, DesiredConfigurationAckResultSchema, isFsErrorWithCode, jcsDigest, type JsonValue } from "@konteks/remote-common";
import { unrestrictedStateMutation, type StateMutation } from "./mutation-gate.js";

/**
 * The local durable outbox. Anything the supervisor must eventually deliver
 * to Core — assignment claims/reports, observations, control acks — is
 * journaled here BEFORE it is sent and removed only after Core durably
 * acknowledges it (a `ReportAck`, an observation receipt, or a control ack
 * receipt). Restart, relay failover, and HTTPS fallback all replay from here
 * with the same idempotency keys.
 */
export const OutboxItemSchema = z
  .object({
    id: z.string().min(1),
    channel: z.enum(["assignment", "observation", "control", "heartbeat"]),
    /** Stable idempotency key (e.g. `report:<assignmentId>:<attempt>:<claimId>:<reportSequence>`). */
    key: z.string().min(1),
    /** Ordering group; items in a group are sent strictly in `order`. */
    group: z.string().min(1),
    order: z.number().int().nonnegative(),
    body: z.unknown(),
    createdAt: z.string(),
    attempts: z.number().int().nonnegative(),
    lastAttemptAt: z.string().nullable(),
  })
  .strict();
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

const MAX_OUTBOX_ITEMS = 10_000;

export class DurableOutbox {
  private readonly items = new Map<string, OutboxItem>();
  private loaded = false;
  private appends = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, private readonly mutate: StateMutation = unrestrictedStateMutation) {}

  private get path(): string {
    return join(this.dir, "outbox.jsonl");
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(() => this.mutate(operation));
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  load(): Promise<void> { return this.serialized(() => this.loadInternal()); }

  private async loadInternal(): Promise<void> {
    if (this.loaded) return;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) throw error;
      this.loaded = true;
      return;
    }
    const restored = new Map<string, OutboxItem>();
    const completeLength = raw.lastIndexOf("\n") + 1;
    for (const line of raw.slice(0, completeLength).split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch { throw new Error("outbox contains a corrupt complete record"); }
      const record = z.discriminatedUnion("op", [z.object({ op: z.literal("put"), item: OutboxItemSchema }).strict(), z.object({ op: z.literal("ack"), id: z.string().min(1) }).strict(), z.object({ op: z.literal("configuration_superseded"), id: z.string().min(1), receipt: DesiredConfigurationAckResultSchema }).strict()]).parse(parsed);
      if (record.op === "put") restored.set(record.item.id, record.item);
      else if (record.op === "configuration_superseded") {
        this.assertSupersession(restored.get(record.id), record.receipt);
        restored.delete(record.id);
      }
      else restored.delete(record.id);
    }
    if (restored.size > MAX_OUTBOX_ITEMS) throw new Error("outbox exceeds its item bound");
    // A write not terminated by a newline was never committed. Remove the
    // torn tail before another append, otherwise two records become one.
    if (completeLength !== raw.length) {
      const file = await open(this.path, "r+");
      try { await file.truncate(Buffer.byteLength(raw.slice(0, completeLength))); await file.sync(); }
      finally { await file.close(); }
    }
    this.items.clear();
    for (const [id, item] of restored) this.items.set(id, item);
    this.loaded = true;
  }

  get depth(): number {
    return this.items.size;
  }

  has(key: string): boolean {
    for (const item of this.items.values()) if (item.key === key) return true;
    return false;
  }

  all(channel?: OutboxItem["channel"]): OutboxItem[] {
    return structuredClone([...this.items.values()].filter(item => !channel || item.channel === channel));
  }

  async enqueue(item: Omit<OutboxItem, "attempts" | "lastAttemptAt">): Promise<OutboxItem> {
    const full = OutboxItemSchema.parse(structuredClone({ ...item, attempts: 0, lastAttemptAt: null }));
    return this.serialized(async () => {
      await this.loadInternal();
      const existing = [...this.items.values()].find((candidate) => candidate.key === full.key);
      if (existing) return structuredClone(existing);
      if (this.items.size >= MAX_OUTBOX_ITEMS) {
        throw new Error("outbox is full; refusing to accept more work until Core acknowledges");
      }
      if (this.items.has(full.id)) throw new Error("outbox item ID already belongs to another key");
      await this.append({ op: "put", item: full });
      this.items.set(full.id, full);
      await this.maybeCompact();
      return structuredClone(full);
    });
  }

  /** Items ready to send, in group order; only the head of each group is eligible. */
  heads(channel?: OutboxItem["channel"]): OutboxItem[] {
    const byGroup = new Map<string, OutboxItem>();
    for (const item of this.items.values()) {
      if (channel && item.channel !== channel) continue;
      const head = byGroup.get(item.group);
      if (!head || item.order < head.order) byGroup.set(item.group, item);
    }
    return structuredClone([...byGroup.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
  }

  /** Every item of a group at or after `fromOrder` (used for `sequence_gap` resend). */
  groupFrom(group: string, fromOrder: number): OutboxItem[] {
    return structuredClone([...this.items.values()].filter((item) => item.group === group && item.order >= fromOrder).sort((a, b) => a.order - b.order));
  }

  async markAttempt(id: string, at: string): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      const item = this.items.get(id);
      if (!item) return;
      const next = { ...item, attempts: item.attempts + 1, lastAttemptAt: at };
      await this.append({ op: "put", item: next });
      this.items.set(id, next);
      await this.maybeCompact();
    });
  }

  async ack(id: string): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      await this.ackInternal(id);
    });
  }

  /** Retire an obsolete configuration message, never record it as accepted. */
  async supersedeConfigurationAck(id: string, value: unknown): Promise<void> {
    const receipt = DesiredConfigurationAckResultSchema.parse(value);
    return this.serialized(async () => {
      await this.loadInternal();
      const item = this.items.get(id);
      if (!item) return;
      this.assertSupersession(item, receipt);
      await this.append({ op: "configuration_superseded", id, receipt });
      this.items.delete(id);
      await this.maybeCompact();
    });
  }

  private assertSupersession(item: OutboxItem | undefined, receipt: ReturnType<typeof DesiredConfigurationAckResultSchema.parse>): void {
    const parsed = DesiredConfigurationAckSchema.safeParse(item?.body);
    if (!item || item.channel !== "control" || !parsed.success || receipt.status !== "superseded" || receipt.instanceId !== parsed.data.instanceId || receipt.revision !== parsed.data.revision || receipt.requestDigest !== jcsDigest(parsed.data as unknown as JsonValue) || (receipt.appliedRevision === parsed.data.revision && parsed.data.status === "applied")) {
      throw new Error("outbox configuration supersession receipt mismatch");
    }
  }

  private async ackInternal(id: string): Promise<void> {
    if (!this.items.has(id)) return;
    await this.append({ op: "ack", id });
    this.items.delete(id);
    await this.maybeCompact();
  }

  async ackKey(key: string): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      for (const item of this.items.values()) if (item.key === key) await this.ackInternal(item.id);
    });
  }

  async removeGroup(group: string): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      for (const item of this.items.values()) if (item.group === group) await this.ackInternal(item.id);
    });
  }

  private async append(record: unknown): Promise<void> {
    const file = await open(this.path, "a+", 0o600);
    const size = (await file.stat()).size;
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
      await file.sync();
      if (size === 0) await this.syncDirectory();
    } catch (error) {
      try { await file.truncate(size); await file.sync(); }
      catch { this.loaded = false; }
      throw error;
    } finally { await file.close(); }
    this.appends += 1;
  }

  private async syncDirectory(): Promise<void> {
    // Windows does not expose POSIX directory fsync; platform crash proof is
    // separate. File flush remains mandatory on every platform.
    if (process.platform === "win32") return;
    const directory = await open(this.dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async maybeCompact(): Promise<void> {
    // The append has already committed. A failed optimization must not report
    // that committed operation as failed; retain the log and retry later.
    if (this.appends >= 1_000) await this.compactInternal().catch(() => undefined);
  }

  private async compactInternal(items = this.items): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      const lines = [...items.values()].map((item) => JSON.stringify({ op: "put", item }));
      await file.writeFile(lines.length > 0 ? `${lines.join("\n")}\n` : "");
      await file.sync();
      await file.close();
      await rename(tmp, this.path);
      await this.syncDirectory();
      this.appends = 0;
    } finally { await file.close(); await rm(tmp, { force: true }); }
  }

  compact(): Promise<void> {
    return this.serialized(async () => { await this.loadInternal(); await this.compactInternal(); });
  }

  async clear(): Promise<void> {
    return this.serialized(async () => {
      await this.loadInternal();
      await this.compactInternal(new Map());
      this.items.clear();
    });
  }
}
