import {
  DesiredConfigurationEnvelopeSchema,
  DrainDirectiveSchema,
  EraseDirectiveSchema,
  InstanceKeyRotationChallengeSchema,
  VersionPolicySchema,
  createLogger,
  generateInstanceKey,
  jcsDigest,
  parseRfc3339,
  signBody,
  type Clock,
  type ControlAck,
  type DesiredConfigurationAck,
  type DesiredConfigurationEnvelope,
  type DrainDirective,
  type EraseDirective,
  type EraseReceipt,
  type InstanceKeyPair,
  type InstanceKeyRotationChallenge,
  type InstanceKeyRotationComplete,
  type JsonValue,
  type Logger,
  type VersionAcknowledgement,
  type VersionPolicy,
} from "@konteks/remote-common";
import type { CoreSignatureVerifier } from "./core-signature.js";
import type { SupervisorStore } from "../state/store.js";
import type { SupervisorJournal } from "../state/journal.js";

/**
 * The closed control protocol: desired configuration, version policy, key
 * rotation, erase, and drain. Every directive is a strict CP1 schema, must
 * carry a verifying Core signature and a fresh (monotonic or unexpired)
 * revision/nonce, and is acknowledged with a signed body. There is no
 * arbitrary directive; anything else is dropped and counted.
 */
export interface ControlDeps {
  store: SupervisorStore;
  journal: SupervisorJournal;
  clock: Clock;
  key: () => InstanceKeyPair;
  replaceKey: (next: InstanceKeyPair) => Promise<void>;
  verifier: CoreSignatureVerifier;
  instanceId: () => string;
  bundleVersion: string;
  protocolVersion: string;
  manifestDigest: () => string;
  onConfigurationApplied?: (configuration: DesiredConfigurationEnvelope["configuration"]) => void;
  /** Local capacity check for `softMaxConcurrent`. */
  localCapacity: () => number;
  onDrain: (directive: DrainDirective) => Promise<number>;
  eraseAssignments: (assignmentIds: string[]) => Promise<{ failed: string[]; reason?: EraseReceipt["reason"] }>;
  eraseAll: () => Promise<{ ok: boolean; reason?: EraseReceipt["reason"] }>;
  onUpdateRequired: (policy: VersionPolicy) => void;
  sendAck: (ack: ControlAck) => void | Promise<void>;
  logger?: Logger;
}

export interface ControlCounters {
  rejectedSignature: number;
  rejectedStale: number;
  rejectedUnknown: number;
}

export class ControlHandlers {
  readonly counters: ControlCounters = { rejectedSignature: 0, rejectedStale: 0, rejectedUnknown: 0 };
  private readonly logger: Logger;
  private pendingRotation: { rotationId: string; next: InstanceKeyPair } | null = null;
  private appliedRevision = 0;
  private configurationQueue: Promise<void> = Promise.resolve();
  /** The last verified `version_policy`; surfaces `updateAvailable`/`targetBundle` to status (Core cannot send a shell command). */
  versionPolicy: Pick<VersionPolicy, "targetBundle" | "updateAvailable" | "minimumSupportedBundle" | "manifestDigest"> | null = null;

  constructor(private readonly deps: ControlDeps) {
    this.logger = deps.logger ?? createLogger({ name: "control" });
  }

  async load(): Promise<void> {
    const stored = await this.deps.store.config();
    if (!stored) return;
    if (stored.digest !== jcsDigest(stored.configuration as unknown as JsonValue)) throw new Error("Stored configuration digest mismatch");
    this.deps.onConfigurationApplied?.(stored.configuration);
    this.appliedRevision = stored.revision;
  }

  get configRevision(): number {
    return this.appliedRevision;
  }

  private signed<T extends Record<string, unknown>>(body: T): T & { signature: string } {
    return { ...body, signature: signBody(this.deps.key(), body as unknown as { [key: string]: JsonValue }) };
  }

  private verify(body: { [key: string]: JsonValue }, signature: string, what: string): boolean {
    if (!this.deps.verifier.verify(body, signature)) {
      this.counters.rejectedSignature += 1;
      this.logger.warn({ what }, "control directive signature rejected");
      return false;
    }
    return true;
  }

  /** Dispatch a validated `control` body from either transport. */
  async handle(body: unknown): Promise<void> {
    const config = DesiredConfigurationEnvelopeSchema.safeParse(body);
    if (config.success) return this.handleDesiredConfiguration(config.data);
    const version = VersionPolicySchema.safeParse(body);
    if (version.success) return this.handleVersionPolicy(version.data);
    const rotation = InstanceKeyRotationChallengeSchema.safeParse(body);
    if (rotation.success) return this.handleKeyRotation(rotation.data);
    const erase = EraseDirectiveSchema.safeParse(body);
    if (erase.success) return this.handleErase(erase.data);
    const drain = DrainDirectiveSchema.safeParse(body);
    if (drain.success) return this.handleDrain(drain.data);
    this.counters.rejectedUnknown += 1;
    this.logger.warn("dropped an unknown control directive");
  }

  handleDesiredConfiguration(envelope: DesiredConfigurationEnvelope): Promise<void> {
    // Relay delivery and HTTPS refresh can overlap. Serialize persistence and
    // live application, including retries, so slow older writes cannot win.
    const parsed = DesiredConfigurationEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      this.counters.rejectedUnknown += 1;
      return Promise.resolve();
    }
    const pending = this.configurationQueue.then(() => this.applyDesiredConfiguration(parsed.data));
    this.configurationQueue = pending.catch(() => undefined);
    return pending;
  }

  private async applyDesiredConfiguration(envelope: DesiredConfigurationEnvelope): Promise<void> {
    if (envelope.instanceId !== this.deps.instanceId()) return void (this.counters.rejectedUnknown += 1);
    if (!this.verify(envelope as unknown as { [key: string]: JsonValue }, envelope.signature, "desired_configuration")) return;
    const ackBase = { type: "desired_configuration_ack" as const, instanceId: envelope.instanceId, revision: envelope.revision, digest: envelope.digest, acknowledgedAt: this.deps.clock.nowIso() };
    const reject = async (reason: DesiredConfigurationAck["reason"]): Promise<void> => { await this.deps.sendAck(this.signed({ ...ackBase, status: "rejected", reason })); };
    const configuration = envelope.configuration;
    if (envelope.digest !== jcsDigest(configuration as unknown as JsonValue)) return reject("invalid_value");
    if (parseRfc3339(envelope.expiresAt) <= this.deps.clock.coreNow()) {
      this.counters.rejectedStale += 1;
      return reject("unsupported_revision");
    }
    if (envelope.revision === this.appliedRevision) {
      const stored = await this.deps.store.config();
      if (stored?.digest === envelope.digest) {
        await this.deps.sendAck(this.signed({ ...ackBase, status: "applied" }));
        return;
      }
    }
    if (envelope.revision <= this.appliedRevision) {
      this.counters.rejectedStale += 1;
      return reject("unsupported_revision");
    }
    if (configuration.softMaxConcurrent !== undefined && configuration.softMaxConcurrent > this.deps.localCapacity()) return reject("local_capacity_too_low");
    if (configuration.heartbeatIntervalSeconds < 5 || configuration.permissionResponderDeadlineSeconds < 1) return reject("invalid_value");
    await this.deps.store.saveConfig({ revision: envelope.revision, digest: envelope.digest, configuration, acknowledgedAt: ackBase.acknowledgedAt });
    this.deps.onConfigurationApplied?.(configuration);
    this.appliedRevision = envelope.revision;
    await this.deps.sendAck(this.signed({ ...ackBase, status: "applied" }));
  }

  async handleVersionPolicy(policy: VersionPolicy): Promise<void> {
    if (policy.instanceId !== this.deps.instanceId()) return void (this.counters.rejectedUnknown += 1);
    if (!this.verify(policy as unknown as { [key: string]: JsonValue }, policy.signature, "version_policy")) return;
    this.versionPolicy = { targetBundle: policy.targetBundle, updateAvailable: policy.updateAvailable, minimumSupportedBundle: policy.minimumSupportedBundle, manifestDigest: policy.manifestDigest };
    const ack: Omit<VersionAcknowledgement, "signature"> = {
      type: "version_ack",
      instanceId: policy.instanceId,
      bundleVersion: this.deps.bundleVersion,
      protocolVersion: this.deps.protocolVersion,
      manifestDigest: this.deps.manifestDigest(),
      status: "running",
      acknowledgedAt: this.deps.clock.nowIso(),
    };
    if (compareSemver(this.deps.bundleVersion, policy.minimumSupportedBundle) < 0) this.deps.onUpdateRequired(policy);
    await this.deps.sendAck(this.signed(ack as unknown as { [key: string]: JsonValue }) as unknown as VersionAcknowledgement);
  }

  /**
   * Dual-proof rotation: generate the successor key, sign the challenge nonce
   * with both keys, send `key_rotation_complete`; the successor becomes the
   * signing key only once Core has the completion (`commitRotation`).
   */
  async handleKeyRotation(challenge: InstanceKeyRotationChallenge): Promise<void> {
    if (challenge.instanceId !== this.deps.instanceId()) return void (this.counters.rejectedUnknown += 1);
    if (parseRfc3339(challenge.expiresAt) <= this.deps.clock.coreNow()) {
      this.counters.rejectedStale += 1;
      return;
    }
    const next = this.pendingRotation?.rotationId === challenge.rotationId ? this.pendingRotation.next : generateInstanceKey();
    this.pendingRotation = { rotationId: challenge.rotationId, next };
    const material = { type: "key_rotation", instanceId: challenge.instanceId, rotationId: challenge.rotationId, nonce: challenge.nonce, newPublicKeyJwk: next.publicKeyJwk as unknown as JsonValue };
    const complete: InstanceKeyRotationComplete = {
      type: "key_rotation_complete",
      instanceId: challenge.instanceId,
      rotationId: challenge.rotationId,
      newPublicKeyJwk: next.publicKeyJwk,
      oldKeySignature: signBody(this.deps.key(), material),
      newKeySignature: signBody(next, material),
    };
    await this.deps.sendAck(complete);
  }

  /** Called when Core acknowledges the rotation (next lease/config carries the new key id). */
  async commitRotation(rotationId: string): Promise<void> {
    if (!this.pendingRotation || this.pendingRotation.rotationId !== rotationId) return;
    await this.deps.replaceKey(this.pendingRotation.next);
    this.pendingRotation = null;
  }

  async handleErase(directive: EraseDirective): Promise<void> {
    if (directive.instanceId !== this.deps.instanceId()) return void (this.counters.rejectedUnknown += 1);
    if (!this.verify(directive as unknown as { [key: string]: JsonValue }, directive.signature, "erase_directive")) return;
    const existing = this.deps.journal.erase.get(directive.directiveId);
    if (existing && existing.receiptSent) return; // idempotent by directiveId
    if (parseRfc3339(directive.expiresAt) <= this.deps.clock.coreNow()) {
      this.counters.rejectedStale += 1;
      return;
    }
    await this.deps.journal.erase.put({ directiveId: directive.directiveId, scope: directive.scope, status: "pending", receiptSent: false, updatedAt: this.deps.clock.nowIso() });
    let status: EraseReceipt["status"] = "completed";
    let failedAssignmentIds: string[] | undefined;
    let reason: EraseReceipt["reason"] | undefined;
    if (directive.scope === "assignment_data") {
      const result = await this.deps.eraseAssignments(directive.assignmentIds ?? []);
      if (result.failed.length > 0) {
        status = result.failed.length === (directive.assignmentIds ?? []).length ? "failed" : "partially_completed";
        failedAssignmentIds = result.failed;
        reason = result.reason ?? "local_io_failure";
      }
    } else {
      const result = await this.deps.eraseAll();
      if (!result.ok) {
        status = "failed";
        reason = result.reason ?? "local_io_failure";
      }
    }
    const receipt: Omit<EraseReceipt, "signature"> = {
      type: "erase_receipt",
      directiveId: directive.directiveId,
      instanceId: directive.instanceId,
      status,
      completedAt: this.deps.clock.nowIso(),
      ...(failedAssignmentIds === undefined ? {} : { failedAssignmentIds }),
      ...(reason === undefined ? {} : { reason }),
    };
    await this.deps.journal.erase.put({ directiveId: directive.directiveId, scope: directive.scope, status, receiptSent: true, updatedAt: receipt.completedAt });
    await this.deps.sendAck(this.signed(receipt as unknown as { [key: string]: JsonValue }) as unknown as EraseReceipt);
  }

  async handleDrain(directive: DrainDirective): Promise<void> {
    if (directive.instanceId !== this.deps.instanceId()) return void (this.counters.rejectedUnknown += 1);
    if (!this.verify(directive as unknown as { [key: string]: JsonValue }, directive.signature, "drain")) return;
    const activeAssignments = await this.deps.onDrain(directive);
    await this.deps.sendAck(this.signed({ type: "drain_ack" as const, instanceId: directive.instanceId, activeAssignments, acknowledgedAt: this.deps.clock.nowIso() }));
  }
}

export function compareSemver(a: string, b: string): number {
  const parse = (value: string): number[] => value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
