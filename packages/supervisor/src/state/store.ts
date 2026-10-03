import { SkillSyncReceiptSchema, type SkillSyncSuccess } from "../skills/sync-receipt.js";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { mkdir, readFile, rm } from "node:fs/promises";
import type { SchemaParser } from "@konteks/remote-common";
import { join } from "node:path";
import { z } from "zod";
import { unrestrictedStateMutation, type StateMutation } from "./mutation-gate.js";
import {
  CONTROL_TOKEN_FILE_NAME,
  DesiredConfigurationSchema,
  ToCoreRelayFrameSchema,
  assertRestrictedMode,
  exportPrivateJwk,
  generateInstanceKey,
  instanceKeyFromPrivateJwk,
  isFsErrorWithCode,
  readOrCreateSecretFile,
  writeSecretFile,
  type InstanceKeyPair,
  type RemoteSignedBundleManifest,
} from "@konteks/remote-common";
import type { RelayDurableState } from "../relay/channel-mux.js";

const PendingSkillReceiptSchema = z.object({ version: z.literal(1),
  owner: z.object({ workspaceId: z.string().min(1).max(512), instanceId: z.string().min(1).max(512) }).strict(),
  result: z.object({ requestId: z.string().min(1).max(512), state: z.enum(["succeeded", "failed"]) }).strict().nullable(),
}).strict();

/**
 * The supervisor's restricted volume. Layout (all files 0600, directory 0700):
 *
 *   instance-key.jwk     ES256 private key (never mounted elsewhere)
 *   identity.json        instanceId, workspaceId, activation lineage
 *   provisioning.json    provisioning credential + window (until readiness)
 *   lease.json           current lease token + decoded mode/expiry
 *   manifest.json        the verified exchange manifest + digest
 *   config.json          acknowledged desired configuration
 *   heartbeat.json       monotonic heartbeat sequence
 *   cursors.json         legacy durable receive cursors (migration fallback)
 *   relay-state.json     atomic cursors, allocation floors, and unacked relay frames
 *   last-exit.json       last controlled nonzero exit classification and timestamp
 *   shutdown-progress.json  last reached native shutdown phase and timestamp
 *   control.token        loopback control-socket token
 *   journal/             assignment recovery journal, pending requests, decisions, erase
 *   outbox/              durable outbox
 *
 * Nothing under this root is ever a checkpoint payload, agent stdio, a
 * provider key, or a capability token.
 */
/** Said when a machine with an identity has lost its key (W1-L1). */
export const MACHINE_KEY_LOST =
  "This machine's Konteks key is missing, so it can no longer prove which runtime it is. Run `konteks-remote onboard` to connect it again; it will replace its old runtime.";

export const IdentitySchema = z
  .object({
    instanceId: z.string().min(1),
    workspaceId: z.string().min(1).nullable(),
    activationId: z.string().min(1),
    activatedAt: z.string(),
    administrativeStatus: z.enum(["provisioning", "active", "draining", "suspended", "revoked", "removed"]),
    /** The exchange nonce is persisted so an interrupted exchange retries idempotently. */
    exchangeNonce: z.string().min(1),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;

const ActivationAttemptSchema = z.object({
  activationId: z.string().min(1), nonce: z.string().min(1),
  keyDigest: z.string().min(1), manifestDigest: z.string().min(1),
  platformDigest: z.string().min(1), createdAt: z.string().datetime(),
}).strict();
export type ActivationAttempt = z.infer<typeof ActivationAttemptSchema>;

export const ProvisioningSchema = z
  .object({
    provisioningCredential: z.string().min(1),
    provisioningCredentialExpiresAt: z.string(),
    provisioningWindowExpiresAt: z.string(),
    manifestDigest: z.string().min(1),
    lastRefreshAt: z.string().nullable(),
  })
  .strict();
export type Provisioning = z.infer<typeof ProvisioningSchema>;

export const LeaseRecordSchema = z
  .object({
    lease: z.string().min(1),
    mode: z.enum(["active", "drain_only"]),
    expiresAt: z.string(),
    drainDeadline: z.string().nullable(),
    issuedAt: z.string(),
    workspaceId: z.string().min(1),
  })
  .strict();
export type LeaseRecord = z.infer<typeof LeaseRecordSchema>;

export const ManifestRecordSchema = z.object({ manifest: z.unknown(), manifestDigest: z.string().min(1) }).strict();

export const ConfigRecordSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    digest: z.string(),
    configuration: DesiredConfigurationSchema,
    acknowledgedAt: z.string(),
  })
  .strict();
export type ConfigRecord = z.infer<typeof ConfigRecordSchema>;

export const DEFAULT_CONFIG: ConfigRecord["configuration"] = {
  heartbeatIntervalSeconds: 15,
  logLevel: "info",
  updateChannel: "stable",
  evidenceUpload: "structured_only",
  permissionResponderDeadlineSeconds: 300,
  humanDeferralAllowed: true,
  deploymentKind: "native_connector",
  roleBindings: [],
};

const CursorsSchema = z.record(z.string(), z.object({ to_core: z.number().int().nonnegative(), to_runtime: z.number().int().nonnegative(),
  /** Highest to_core sequence ever allocated; absent in files written before it existed. */
  allocated: z.number().int().nonnegative().optional() }).strict());
export type Cursors = z.infer<typeof CursorsSchema>;

const RelayDurableStateSchema = z.object({
  cursors: CursorsSchema,
  outbound: z.record(z.string(), z.array(z.object({
    frame: ToCoreRelayFrameSchema,
    bytes: z.number().int().nonnegative(),
    enqueuedAt: z.number().int().nonnegative(),
  }).strict())),
}).strict();

const HeartbeatSeqSchema = z.object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();

export const ControlledExitReasonSchema = z.enum([
  "liveness_lost", "uncaught_exception", "unhandled_rejection", "startup_failed", "shutdown_step_failed", "other",
]);
export type ControlledExitReason = z.infer<typeof ControlledExitReasonSchema>;
export const LastExitSchema = z.object({
  schemaVersion: z.literal(1),
  reason: ControlledExitReasonSchema,
  occurredAt: z.string().datetime(),
}).strict();
export type LastExit = z.infer<typeof LastExitSchema>;

/** Diagnostic progress only. The shutdown-complete receipt remains the sole
 * attestation that every native shutdown step finished. */
export const ShutdownProgressSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(["supervisor_prelude", "work_drain", "preview_close", "runner_stop", "codex_owner_stop", "state_close", "control_close", "receipt"]),
  state: z.enum(["entered", "completed"]),
  observedAt: z.string().datetime(),
}).strict();
export type ShutdownProgress = z.infer<typeof ShutdownProgressSchema>;

export class SupervisorStore {
  private heartbeatWrites: Promise<void> = Promise.resolve();
  /**
   * Serialized JSON of each buffered relay frame already validated here. A
   * buffered frame is never changed after it is sent, so it is validated and
   * serialized once instead of on every relay-state write (WS2-157).
   */
  private readonly relayFrameJson = new WeakMap<object, string>();
  constructor(readonly dataDir: string, private readonly mutate: StateMutation = unrestrictedStateMutation) {}

  path(name: string): string {
    return join(this.dataDir, name);
  }

  async init(): Promise<void> {
    return this.mutate(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await mkdir(this.path("journal"), { recursive: true, mode: 0o700 });
      await mkdir(this.path("outbox"), { recursive: true, mode: 0o700 });
      for (const secret of ["instance-key.jwk", "lease.json", "provisioning.json", "owner-token.json", CONTROL_TOKEN_FILE_NAME]) {
        try {
          await assertRestrictedMode(this.path(secret));
        } catch (error) {
          if (!isFsErrorWithCode(error, "ENOENT")) throw error;
        }
      }
    });
  }

  private async readJson<T>(name: string, schema: SchemaParser<T>): Promise<T | null> {
    try {
      return schema.parse(JSON.parse(await readFile(this.path(name), "utf8")));
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.mutate(() => writeSecretFile(this.path(name), `${JSON.stringify(value)}\n`));
  }

  async saveSkillSyncSuccess(owner: { workspaceId: string; instanceId: string }, success: SkillSyncSuccess): Promise<void> {
    const receipt = SkillSyncReceiptSchema.parse({ version: 1, owner, success });
    if (Buffer.byteLength(JSON.stringify(receipt)) > 2 * 1024 * 1024) throw new Error("Skill sync receipt is unavailable");
    await this.writeJson("skill-sync-success.json", receipt);
  }

  private async readPrivateJson<T>(name: string, schema: SchemaParser<T>, maxBytes: number): Promise<T | null> {
    try {
      const path = this.path(name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0) || stat.size > maxBytes) throw new Error("Skill sync receipt is unavailable");
      await assertRestrictedMode(path);
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let receipt;
      try {
        const current = await handle.stat();
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || !current.isFile() || current.nlink !== 1) throw new Error("Skill sync receipt is unavailable");
        const bytes = Buffer.alloc(stat.size + 1); let count = 0;
        while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
        if (count !== stat.size) throw new Error("Skill sync receipt is unavailable");
        receipt = schema.parse(JSON.parse(bytes.subarray(0, count).toString("utf8")));
      } finally { await handle.close(); }
      return receipt;
    } catch (error) { if (isFsErrorWithCode(error, "ENOENT")) return null; throw error; }
  }

  async skillSyncSuccess(owner: { workspaceId: string; instanceId: string }): Promise<SkillSyncSuccess | null> {
    const receipt = await this.readPrivateJson("skill-sync-success.json", SkillSyncReceiptSchema, 2 * 1024 * 1024);
    if (!receipt) return null;
    if (receipt.owner.workspaceId !== owner.workspaceId || receipt.owner.instanceId !== owner.instanceId) throw new Error("Skill sync receipt owner differs from enrollment");
    return receipt.success;
  }

  async savePendingSkillReceipt(owner: { workspaceId: string; instanceId: string }, result: { requestId: string; state: "succeeded" | "failed" } | null): Promise<void> {
    await this.writeJson("skill-sync-pending.json", PendingSkillReceiptSchema.parse({ version: 1, owner, result }));
  }

  async pendingSkillReceipt(owner: { workspaceId: string; instanceId: string }) {
    const receipt = await this.readPrivateJson("skill-sync-pending.json", PendingSkillReceiptSchema, 4096);
    if (!receipt) return null;
    if (receipt.owner.workspaceId !== owner.workspaceId || receipt.owner.instanceId !== owner.instanceId) throw new Error("Skill sync receipt owner differs from enrollment");
    return receipt.result;
  }

  /** Replaces the single private record before a controlled nonzero exit. */
  async recordLastExit(reason: ControlledExitReason, occurredAt = new Date().toISOString()): Promise<void> {
    await this.writeJson("last-exit.json", LastExitSchema.parse({ schemaVersion: 1, reason, occurredAt }));
  }

  /** Readable after the service has stopped, without its control socket. */
  async lastExit(): Promise<LastExit | null> {
    const path = this.path("last-exit.json");
    try {
      await assertRestrictedMode(path);
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
    return this.readJson("last-exit.json", LastExitSchema);
  }

  /** One restricted, bounded marker for the last reached shutdown boundary. */
  async recordShutdownProgress(phase: ShutdownProgress["phase"], state: ShutdownProgress["state"], observedAt = new Date().toISOString()): Promise<void> {
    await this.writeJson("shutdown-progress.json", ShutdownProgressSchema.parse({ schemaVersion: 1, phase, state, observedAt }));
  }

  async shutdownProgress(): Promise<ShutdownProgress | null> {
    const path = this.path("shutdown-progress.json");
    try {
      await assertRestrictedMode(path);
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
    return this.readJson("shutdown-progress.json", ShutdownProgressSchema);
  }

  /** The machine key, or null when there is none on disk. */
  async loadInstanceKey(): Promise<InstanceKeyPair | null> {
    const existing = await this.readJson("instance-key.jwk", z.record(z.string(), z.unknown()));
    return existing ? instanceKeyFromPrivateJwk(existing as JsonWebKey) : null;
  }

  async loadOrCreateInstanceKey(): Promise<InstanceKeyPair> {
    const existing = await this.readJson("instance-key.jwk", z.record(z.string(), z.unknown()));
    if (existing) return instanceKeyFromPrivateJwk(existing as JsonWebKey);
    const key = generateInstanceKey();
    await this.writeJson("instance-key.jwk", exportPrivateJwk(key));
    return key;
  }

  async replaceInstanceKey(key: InstanceKeyPair): Promise<void> {
    await this.writeJson("instance-key.jwk", exportPrivateJwk(key));
  }

  identity(): Promise<Identity | null> {
    return this.readJson("identity.json", IdentitySchema);
  }

  saveIdentity(identity: Identity): Promise<void> {
    return this.writeJson("identity.json", identity);
  }

  activationAttempt(): Promise<ActivationAttempt | null> {
    return this.readJson("activation-attempt.json", ActivationAttemptSchema);
  }

  saveActivationAttempt(attempt: ActivationAttempt): Promise<void> {
    return this.writeJson("activation-attempt.json", ActivationAttemptSchema.parse(attempt));
  }

  provisioning(): Promise<Provisioning | null> {
    return this.readJson("provisioning.json", ProvisioningSchema);
  }

  saveProvisioning(value: Provisioning): Promise<void> {
    return this.writeJson("provisioning.json", value);
  }

  clearProvisioning(): Promise<void> {
    return this.mutate(() => rm(this.path("provisioning.json"), { force: true }));
  }

  lease(): Promise<LeaseRecord | null> {
    return this.readJson("lease.json", LeaseRecordSchema);
  }

  saveLease(value: LeaseRecord): Promise<void> {
    return this.writeJson("lease.json", value);
  }

  clearLease(): Promise<void> {
    return this.mutate(() => rm(this.path("lease.json"), { force: true }));
  }

  async manifest(): Promise<{ manifest: RemoteSignedBundleManifest; manifestDigest: string } | null> {
    const record = await this.readJson("manifest.json", ManifestRecordSchema);
    return record ? { manifest: record.manifest as RemoteSignedBundleManifest, manifestDigest: record.manifestDigest } : null;
  }

  saveManifest(manifest: RemoteSignedBundleManifest, manifestDigest: string): Promise<void> {
    return this.writeJson("manifest.json", { manifest, manifestDigest });
  }

  config(): Promise<ConfigRecord | null> {
    return this.readJson("config.json", ConfigRecordSchema);
  }

  saveConfig(value: ConfigRecord): Promise<void> {
    return this.writeJson("config.json", value);
  }

  async cursors(): Promise<Cursors> {
    return (await this.readJson("cursors.json", CursorsSchema)) ?? {};
  }

  saveCursors(value: Cursors): Promise<void> {
    return this.writeJson("cursors.json", value);
  }

  async relayState(): Promise<RelayDurableState | null> {
    return this.readJson("relay-state.json", RelayDurableStateSchema) as Promise<RelayDurableState | null>;
  }

  saveRelayState(value: RelayDurableState): Promise<void> {
    // Full validation of cursors, entry metadata and every frame not seen
    // before; a known frame reuses its checked JSON. Same file as before.
    const unseen: RelayDurableState["outbound"] = {};
    for (const [channelId, entries] of Object.entries(value.outbound)) {
      unseen[channelId] = entries.filter(entry => !this.relayFrameJson.has(entry.frame));
      for (const entry of entries) {
        if (this.relayFrameJson.has(entry.frame) && !(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 &&
            Number.isSafeInteger(entry.enqueuedAt) && entry.enqueuedAt >= 0)) throw new TypeError("relay outbound entry is invalid");
      }
    }
    RelayDurableStateSchema.parse({ cursors: value.cursors, outbound: unseen });
    for (const entries of Object.values(unseen)) {
      for (const entry of entries) this.relayFrameJson.set(entry.frame, JSON.stringify(entry.frame));
    }
    const outbound = Object.entries(value.outbound).map(([channelId, entries]) => `${JSON.stringify(channelId)}:[${entries
      .map(entry => `{"frame":${this.relayFrameJson.get(entry.frame)!},"bytes":${entry.bytes},"enqueuedAt":${entry.enqueuedAt}}`).join(",")}]`);
    const text = `{"cursors":${JSON.stringify(value.cursors)},"outbound":{${outbound.join(",")}}}\n`;
    return this.mutate(() => writeSecretFile(this.path("relay-state.json"), text));
  }

  async heartbeatSequence(): Promise<number> {
    return (await this.readJson("heartbeat.json", HeartbeatSeqSchema))?.sequence ?? 0;
  }

  async saveHeartbeatSequence(sequence: number): Promise<void> {
    await this.reserveHeartbeatFloor(sequence);
  }

  /** A reservation is allocation metadata only, never an accepted heartbeat. */
  async reserveHeartbeatFloor(floor: number): Promise<number> {
    HeartbeatSeqSchema.parse({ sequence: floor });
    return this.updateHeartbeatSequence(current => Math.max(current, floor));
  }

  allocateHeartbeatSequence(): Promise<number> {
    return this.updateHeartbeatSequence(current => current + 1);
  }

  private updateHeartbeatSequence(next: (current: number) => number): Promise<number> {
    const operation = this.heartbeatWrites.then(() => this.mutate(async () => {
      const sequence = HeartbeatSeqSchema.parse({ sequence: next(await this.heartbeatSequence()) }).sequence;
      // Use the same atomic restricted writer; never publish an allocation
      // before persistence, or recursively enter the state mutation gate.
      await writeSecretFile(this.path("heartbeat.json"), `${JSON.stringify({ sequence })}\n`);
      return sequence;
    }));
    this.heartbeatWrites = operation.then(() => undefined, () => undefined);
    return operation;
  }

  controlToken(): Promise<string> {
    return this.mutate(() => readOrCreateSecretFile({ bytes: 32, dataDir: this.dataDir, encoding: "base64url", fileName: CONTROL_TOKEN_FILE_NAME }));
  }

  async eraseAllKonteksData(): Promise<void> {
    return this.mutate(async () => {
      for (const name of ["journal", "outbox", "cursors.json", "relay-state.json", "heartbeat.json", "config.json", "manifest.json"]) {
        await rm(this.path(name), { recursive: true, force: true });
      }
      await mkdir(this.path("journal"), { recursive: true, mode: 0o700 });
      await mkdir(this.path("outbox"), { recursive: true, mode: 0o700 });
    });
  }
}

type JsonWebKey = import("node:crypto").JsonWebKey;
