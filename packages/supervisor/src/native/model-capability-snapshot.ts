import { randomUUID } from "node:crypto";
import { isNativeAgentRuntimeId } from "@konteks/backstage-plugin-common";
import { classifyAgentBilling, credentialKindFor } from "@konteks/backstage-plugin-common/known-models";
import {
  AgentModelOfferedValuesSnapshotSchema,
  RemoteInstanceError,
  catalogueModelAuthority,
  computeAgentModelOfferedValuesSnapshotDigest,
  parseRfc3339,
  type AgentModelCapabilityMapping,
  type AgentModelOfferedValuesSnapshot,
  type Clock,
  type ConnectedAgentView,
} from "@konteks/remote-common";

interface ResolvedModelCapabilityMapping { agentId: string; mapping: AgentModelCapabilityMapping }

/**
 * What one snapshot is bound to: a reviewed signed mapping from the release,
 * or, for an agent the release signed nothing for, the fixed catalogue
 * authority Core resolves through its own known-model catalogue. A catalogue authority has no expiry of its own.
 */
interface OfferedAuthority {
  agentId: string;
  mappingId: string;
  mappingRevision: number;
  mappingDigest: string;
  configId: string;
  expiresAt?: string;
}

interface DiscoveredOffer {
  currentValue: string;
  offeredValues: string[];
  offeredOptions?: Array<{ value: string; name?: string; group?: string; groupName?: string; billing?: "subscription" | "pay_per_use" }>;
  /** How long ago the agent gave this answer, when the runner served an earlier one (cached, or kept while it is read again). */
  observedAgoMs?: number;
}

/** Where one agent's offered-models read stands, for `agents` and `doctor`; no path or provider text ever enters it. */
export type ModelCapabilityDiscoveryState = "never_attempted" | "in_progress" | "timed_out" | "failed" | "ready";

export interface ModelCapabilityDiscoveryStatus {
  agentId: string;
  state: ModelCapabilityDiscoveryState;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
}

/** One agent's discovery may not hold the shared refresh lane longer than this. */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
const DISCOVERY_DEADLINE_DIAGNOSTIC = "model_capability_discovery_deadline";

interface ModelCapabilitySnapshotProducerOptions {
  clock: Clock;
  instanceId: () => string;
  runnerIncarnation: () => string;
  manifestId: () => string | null;
  mappings: () => readonly ResolvedModelCapabilityMapping[];
  /** Installed native agents; each one without a current signed mapping reports under its catalogue authority. */
  catalogueAgents?: () => readonly string[];
  discover: (agentId: string, configId: string) => Promise<DiscoveredOffer>;
  /**
   * How one offered value is billed on this machine (OpenCode: by route
   * provider and the credential that serves it). Undefined leaves the
   * option unlabelled, which an older Core requires.
   */
  optionBilling?: (agentId: string, value: string, agent: ConnectedAgentView) => "subscription" | "pay_per_use" | undefined;
  onDiagnostic?: (detail: { reason: string; agentId?: string; errorKind?: string }) => void;
  /** The first snapshot for an agent landed: one heartbeat may carry it now instead of on the next interval. */
  onFirstSnapshot?: (agentId: string) => void;
  newId?: () => string;
  ttlMs?: number;
  /** Renew asynchronously before expiry so heartbeat publication never gaps. */
  refreshAheadMs?: number;
  /** How long one agent's discovery may take before it is abandoned, recorded and retried in the background. */
  discoveryTimeoutMs?: number;
}

interface CacheEntry { authorityKey: string; snapshot: AgentModelOfferedValuesSnapshot }
interface RetryEntry { failures: number; nextAt: number }

/** Incremental, bounded owner for model capability snapshots; it never scans history. */
export class ModelCapabilitySnapshotProducer {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retry = new Map<string, RetryEntry>();
  private readonly revisions = new Map<string, number>();
  private readonly agentEpochs = new Map<string, number>();
  private readonly discoveryStates = new Map<string, ModelCapabilityDiscoveryStatus>();
  private readonly announced = new Set<string>();
  private agents: readonly ConnectedAgentView[] = [];

  constructor(private readonly options: ModelCapabilitySnapshotProducerOptions) {}

  /** Every authority snapshots may be taken under now: signed mappings first, then catalogue authorities. */
  private authorities(): OfferedAuthority[] {
    const now = this.options.clock.now();
    const signed: OfferedAuthority[] = this.options.mappings()
      .filter(value => parseRfc3339(value.mapping.expiresAt) > now)
      .map(value => ({ agentId: value.agentId, mappingId: value.mapping.mappingId, mappingRevision: value.mapping.mappingRevision,
        mappingDigest: value.mapping.mappingDigest, configId: value.mapping.configId, expiresAt: value.mapping.expiresAt }));
    const covered = new Set(signed.map(value => value.agentId));
    const catalogue = [...new Set(this.options.catalogueAgents?.() ?? [])]
      .filter(agentId => isNativeAgentRuntimeId(agentId) && !covered.has(agentId))
      .map(agentId => ({ agentId, ...catalogueModelAuthority(agentId) }));
    return [...signed, ...catalogue];
  }

  invalidateForAgents(agents: readonly ConnectedAgentView[]): void {
    this.agents = structuredClone(agents);
    const now = this.options.clock.now();
    const manifestId = this.options.manifestId();
    const mappings = new Map(this.authorities().map(value => [identity(value), value]));
    const agentMap = new Map(agents.map(agent => [agent.agentId, agent]));
    for (const [id, entry] of this.cache) {
      const resolved = mappings.get(id), agent = resolved ? agentMap.get(resolved.agentId) : undefined;
      if (!resolved || !eligible(agent) || manifestId === null || entry.authorityKey !== this.authorityKey(resolved, agent!, manifestId)
        || parseRfc3339(entry.snapshot.expiresAt) <= now) {
        this.cache.delete(id);
        this.announced.delete(entry.snapshot.agentId);
      }
    }
  }

  invalidateAgent(agentId: string): void {
    this.agentEpochs.set(agentId, (this.agentEpochs.get(agentId) ?? 0) + 1);
    for (const id of [...this.cache.keys()]) {
      if (id.startsWith(`${agentId}\0`)) this.cache.delete(id);
    }
    this.discoveryStates.delete(agentId);
    this.announced.delete(agentId);
  }

  /**
   * One agent's offered-models read, as `agents` and `doctor` show it. No
   * snapshot means the list is unknown, never that the agent offers nothing.
   */
  discoveryState(agentId: string): ModelCapabilityDiscoveryStatus | undefined {
    const recorded = this.discoveryStates.get(agentId);
    if (this.hasSnapshot(agentId)) {
      return { agentId, state: "ready", lastAttemptAt: recorded?.lastAttemptAt ?? null, nextRetryAt: null };
    }
    if (recorded) return recorded.state === "ready" ? { agentId, state: "never_attempted", lastAttemptAt: recorded.lastAttemptAt, nextRetryAt: null } : { ...recorded };
    return this.authorities().some(resolved => resolved.agentId === agentId)
      ? { agentId, state: "never_attempted", lastAttemptAt: null, nextRetryAt: null }
      : undefined;
  }

  private hasSnapshot(agentId: string): boolean {
    return [...this.cache.values()].some(entry => entry.snapshot.agentId === agentId);
  }

  async refresh(agents: readonly ConnectedAgentView[]): Promise<void> {
    this.invalidateForAgents(agents);
    const manifestId = this.options.manifestId();
    if (manifestId === null) return;
    const work: Promise<void>[] = [];
    for (const resolved of this.authorities().slice(0, 8)) {
      const agent = agents.find(candidate => candidate.agentId === resolved.agentId);
      if (!eligible(agent)) continue;
      const id = identity(resolved), key = this.authorityKey(resolved, agent, manifestId);
      if (this.fresh(id, key) || this.backingOff(key)) continue;
      work.push(this.discovery(id, key, resolved, agent, manifestId));
    }
    await Promise.all(work);
  }

  /** A cached snapshot of the same authority that is not yet due for its refresh-ahead. */
  private fresh(id: string, key: string): boolean {
    const cached = this.cache.get(id);
    const refreshAheadMs = this.options.refreshAheadMs ?? Math.min(2 * 60_000, (this.options.ttlMs ?? 5 * 60_000) / 2);
    return cached?.authorityKey === key && parseRfc3339(cached.snapshot.expiresAt) - this.options.clock.now() > refreshAheadMs;
  }

  private backingOff(key: string): boolean {
    const retry = this.retry.get(key);
    return Boolean(retry && retry.nextAt > this.options.clock.now());
  }

  /** The discovery under way for this authority, or a new one. */
  private discovery(id: string, key: string, resolved: OfferedAuthority, agent: ConnectedAgentView & { authIdentityFingerprint: string }, manifestId: string): Promise<void> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const operation = this.discoverOne(id, key, resolved, agent, manifestId);
    this.inFlight.set(key, operation);
    void operation.finally(() => { if (this.inFlight.get(key) === operation) this.inFlight.delete(key); }).catch(() => undefined);
    return operation;
  }

  snapshots(): AgentModelOfferedValuesSnapshot[] {
    this.invalidateForAgents(this.agents);
    return [...this.cache.values()].map(value => structuredClone(value.snapshot)).sort((a, b) => a.agentId.localeCompare(b.agentId) || a.mappingId.localeCompare(b.mappingId));
  }

  private async discoverOne(id: string, key: string, resolved: OfferedAuthority, agent: ConnectedAgentView, manifestId: string): Promise<void> {
    const startedAt = this.options.clock.now();
    this.recordStart(resolved.agentId, startedAt);
    try {
      const observed = await withDiscoveryDeadline(this.options.discover(resolved.agentId, resolved.configId),
        this.options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
      this.acceptDiscovery(id, key, resolved, observed, manifestId, startedAt);
    } catch (error) {
      this.recordDiscoveryFailure(id, key, resolved.agentId, error, startedAt);
    }
  }

  private acceptDiscovery(id: string, key: string, resolved: OfferedAuthority, observed: DiscoveredOffer, manifestId: string, startedAt: number): void {
    const currentAgent = this.agents.find(candidate => candidate.agentId === resolved.agentId);
    if (!eligible(currentAgent) || key !== this.authorityKey(resolved, currentAgent, this.options.manifestId() ?? "")) return;
    const now = this.options.clock.now();
    const window = this.validity(observed, resolved, now);
    if (window.expires <= now) return;
    const snapshotRevision = (this.revisions.get(id) ?? 0) + 1;
    const snapshot = this.snapshotFor({ resolved, observed, currentAgent, manifestId, window, snapshotRevision });
    this.revisions.set(id, snapshotRevision); this.cache.set(id, { authorityKey: key, snapshot }); this.retry.delete(key);
    this.recordState(resolved.agentId, "ready", startedAt, null);
    this.announce(resolved.agentId);
  }

  private recordDiscoveryFailure(id: string, key: string, agentId: string, error: unknown, startedAt: number): void {
    const timedOut = discoveryTimedOut(error);
    this.options.onDiagnostic?.({ reason: timedOut ? "discovery_timed_out" : "discovery_failed", agentId,
      errorKind: timedOut ? "timeout" : discoveryErrorKind(error) });
    const nextAt = this.recordFailure(id, key, agentId);
    this.recordState(agentId, timedOut ? "timed_out" : "failed", startedAt, nextAt);
  }

  private recordStart(agentId: string, at: number): void {
    this.recordState(agentId, "in_progress", at, null);
  }

  private recordState(agentId: string, state: ModelCapabilityDiscoveryState, at: number, nextAt: number | null): void {
    this.discoveryStates.set(agentId, { agentId, state, lastAttemptAt: new Date(at).toISOString(),
      nextRetryAt: nextAt === null ? null : new Date(nextAt).toISOString() });
  }

  /** Ask for one heartbeat the first time this process has an answer for the agent. */
  private announce(agentId: string): void {
    if (this.announced.has(agentId)) return;
    this.announced.add(agentId);
    this.options.onFirstSnapshot?.(agentId);
  }

  /**
   * A kept answer is advertised with the time the agent actually gave it and
   * a fresh validity window from now: Core takes any observedAt not after its
   * own time with expiresAt still ahead, so the offer stays placeable while
   * the agent is read again, and nothing claims it was observed later than it
   * was.
   */
  private validity(observed: DiscoveredOffer, resolved: OfferedAuthority, now: number): { observedAt: number; expires: number } {
    const ageMs = typeof observed.observedAgoMs === "number" && Number.isFinite(observed.observedAgoMs) && observed.observedAgoMs > 0 ? observed.observedAgoMs : 0;
    const ttlEnd = now + (this.options.ttlMs ?? 5 * 60_000);
    const expires = resolved.expiresAt ? Math.min(parseRfc3339(resolved.expiresAt), ttlEnd) : ttlEnd;
    return { observedAt: now - ageMs, expires };
  }

  private snapshotFor(input: {
    resolved: OfferedAuthority;
    observed: DiscoveredOffer;
    currentAgent: ConnectedAgentView & { authIdentityFingerprint: string };
    manifestId: string;
    window: { observedAt: number; expires: number };
    snapshotRevision: number;
  }): AgentModelOfferedValuesSnapshot {
    const { resolved, observed, currentAgent, manifestId, window, snapshotRevision } = input;
    const labelled = this.offeredOptions(observed, resolved, currentAgent);
    const body = {
      version: 1 as const, snapshotId: (this.options.newId ?? randomUUID)(), snapshotRevision,
      instanceId: this.options.instanceId(), agentId: resolved.agentId,
      authIdentityFingerprint: currentAgent.authIdentityFingerprint,
      runnerIncarnation: this.options.runnerIncarnation(), manifestId,
      mappingId: resolved.mappingId, mappingRevision: resolved.mappingRevision,
      mappingDigest: resolved.mappingDigest, configId: resolved.configId,
      currentValue: observed.currentValue, offeredValues: observed.offeredValues,
      ...(labelled?.length ? { offeredOptions: labelled } : {}),
      observedAt: new Date(window.observedAt).toISOString(), expiresAt: new Date(window.expires).toISOString(),
    };
    return AgentModelOfferedValuesSnapshotSchema.parse({ ...body, snapshotDigest: computeAgentModelOfferedValuesSnapshotDigest(body) });
  }

  /** The offered options, each labelled with its billing when the connector knows it; unlabelled options as the agent gave them. */
  private offeredOptions(observed: DiscoveredOffer, resolved: OfferedAuthority, currentAgent: ConnectedAgentView): DiscoveredOffer["offeredOptions"] {
    if (!this.options.optionBilling) return observed.offeredOptions;
    const options = (observed.offeredOptions?.length ? observed.offeredOptions : observed.offeredValues.map(value => ({ value }))).map(option => {
      const billing = this.options.optionBilling!(resolved.agentId, option.value, currentAgent);
      return billing === undefined ? option : { ...option, billing };
    });
    return options.some(option => "billing" in option) ? options : observed.offeredOptions;
  }

  /**
   * Back off this authority. A transient discovery failure must not punch a
   * readiness hole: the existing same-authority snapshot remains usable until
   * its signed expiry; `snapshots()` removes it at that boundary.
   */
  private recordFailure(id: string, key: string, agentId: string): number {
    const previous = this.retry.get(key)?.failures ?? 0, failures = Math.min(previous + 1, 8);
    const nextAt = this.options.clock.now() + Math.min(300_000, 5_000 * 2 ** (failures - 1));
    this.retry.set(key, { failures, nextAt });
    const cached = this.cache.get(id);
    if (!cached || cached.authorityKey !== key
      || parseRfc3339(cached.snapshot.expiresAt) <= this.options.clock.now()) this.cache.delete(id);
    if (!this.hasSnapshot(agentId)) this.announced.delete(agentId);
    return nextAt;
  }

  private authorityKey(value: OfferedAuthority, agent: ConnectedAgentView & { authIdentityFingerprint: string }, manifestId: string): string {
    return JSON.stringify([manifestId, value.mappingId, value.mappingRevision, value.mappingDigest,
      agent.authIdentityFingerprint, this.options.runnerIncarnation(), this.agentEpochs.get(value.agentId) ?? 0]);
  }
}

/**
 * How one offered OpenCode value is billed on this machine:
 * its route provider (`openai` in `openai/gpt-5.5`) and the credential kind
 * the agent reports for that provider. Undefined for every other agent (Core
 * classifies those by agent) and for a value without a provider.
 */
export function openCodeOptionBilling(agent: Pick<ConnectedAgentView, "agentId" | "credentials">, value: string): "subscription" | "pay_per_use" | undefined {
  if (agent.agentId !== "opencode") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const providerId = value.slice(0, slash).toLowerCase();
  const credential = credentialKindFor(agent.credentials, providerId);
  return classifyAgentBilling({ agentId: "opencode", providerId, ...(credential ? { credential } : {}) });
}

/**
 * How Google Antigravity's offered models are billed: by how
 * Google is signed in, i.e. the credential in use, which the connector lists
 * first among the ready ones (Gemini Enterprise: a subscription, or
 * pay-per-use for its Pay-as-you-go edition; a Gemini API key: pay-per-use).
 * Undefined for every other agent and with nothing ready.
 */
export function antigravityOptionBilling(agent: Pick<ConnectedAgentView, "agentId" | "credentials">): "subscription" | "pay_per_use" | undefined {
  if (agent.agentId !== "antigravity") return undefined;
  return agent.credentials?.find(credential => credential.state === "ready" && credential.providerId === "google")?.billing;
}

function eligible(agent: ConnectedAgentView | undefined): agent is ConnectedAgentView & { authIdentityFingerprint: string } {
  return agent?.authMode === "agent_local_subscription" && agent.readiness === "ready" && agent.connectionState === "ready" && typeof agent.authIdentityFingerprint === "string" && agent.authIdentityFingerprint.length > 0;
}
function identity(value: OfferedAuthority): string { return `${value.agentId}\0${value.mappingId}`; }

function discoveryErrorKind(error: unknown): "invalid_snapshot" | "discovery_error" {
  return error instanceof Error && error.name === "ZodError" ? "invalid_snapshot" : "discovery_error";
}

/** One agent's read may not hold the shared lane or an in-flight slot past its deadline. */
function withDiscoveryDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(discoveryDeadlineElapsed());
    }, timeoutMs);
    timer.unref();
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

function discoveryDeadlineElapsed(): RemoteInstanceError {
  return new RemoteInstanceError("temporarily_unavailable", "Model capability discovery did not answer within its deadline.", {
    retryable: true, diagnostic: DISCOVERY_DEADLINE_DIAGNOSTIC,
  });
}

/** A deadline is still a timeout when the bridge itself gave up on ACP initialize before our own bound. */
function discoveryTimedOut(error: unknown): boolean {
  if (!(error instanceof RemoteInstanceError)) return false;
  if (error.diagnostic === DISCOVERY_DEADLINE_DIAGNOSTIC || error.diagnostic === "model_discovery_deadline") return true;
  if (error.diagnostic === "model_discovery_session_new_deadline") return true;
  return /did not answer initialize within/i.test(error.message);
}
