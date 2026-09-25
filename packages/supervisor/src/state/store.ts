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
  gateway: { capEnforcementStage: "observe", egressAllowlistRevision: "" },
  permissionResponderDeadlineSeconds: 300,
  humanDeferralAllowed: true,
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
