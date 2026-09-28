import { randomUUID } from "node:crypto";
import { isNativeAgentRuntimeId } from "@konteks/backstage-plugin-common";
import {
  AgentModelOfferedValuesSnapshotSchema,
  catalogueModelAuthority,
  computeAgentModelOfferedValuesSnapshotDigest,
  parseRfc3339,
  type AgentModelCapabilityMapping,
  type AgentModelOfferedValuesSnapshot,
  type Clock,
  type ConnectedAgentView,
} from "@konteks/remote-common";

export interface ResolvedModelCapabilityMapping { agentId: string; mapping: AgentModelCapabilityMapping }

/**
 * What one snapshot is bound to: a reviewed signed mapping from the release,
 * or, for an agent the release signed nothing for, the fixed catalogue
 * authority Core resolves through its own known-model catalogue (System One
 * §6a, KM5). A catalogue authority has no expiry of its own.
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
  offeredOptions?: Array<{ value: string; name?: string; group?: string; groupName?: string }>;
}

export interface ModelCapabilitySnapshotProducerOptions {
  clock: Clock;
  instanceId: () => string;
  runnerIncarnation: () => string;
  manifestId: () => string | null;
  mappings: () => readonly ResolvedModelCapabilityMapping[];
  /** Installed native agents; each one without a current signed mapping reports under its catalogue authority. */
  catalogueAgents?: () => readonly string[];
  discover: (agentId: string, configId: string) => Promise<DiscoveredOffer>;
  newId?: () => string;
  ttlMs?: number;
  /** Renew asynchronously before expiry so heartbeat publication never gaps. */
  refreshAheadMs?: number;
}

interface CacheEntry { authorityKey: string; snapshot: AgentModelOfferedValuesSnapshot }
interface RetryEntry { failures: number; nextAt: number }

/** Incremental, bounded owner for D150 snapshots; it never scans history. */
export class ModelCapabilitySnapshotProducer {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retry = new Map<string, RetryEntry>();
  private readonly revisions = new Map<string, number>();
  private readonly agentEpochs = new Map<string, number>();
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
        || parseRfc3339(entry.snapshot.expiresAt) <= now) this.cache.delete(id);
    }
  }

  invalidateAgent(agentId: string): void {
    this.agentEpochs.set(agentId, (this.agentEpochs.get(agentId) ?? 0) + 1);
    for (const id of [...this.cache.keys()]) {
      if (id.startsWith(`${agentId}\0`)) this.cache.delete(id);
    }
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
      const cached = this.cache.get(id);
      const refreshAheadMs = this.options.refreshAheadMs ?? Math.min(2 * 60_000, (this.options.ttlMs ?? 5 * 60_000) / 2);
      if (cached?.authorityKey === key
        && parseRfc3339(cached.snapshot.expiresAt) - this.options.clock.now() > refreshAheadMs) continue;
      const retry = this.retry.get(key);
      if (retry && retry.nextAt > this.options.clock.now()) continue;
      let operation = this.inFlight.get(key);
      if (!operation) {
        operation = this.discoverOne(id, key, resolved, agent, manifestId);
        this.inFlight.set(key, operation);
        void operation.finally(() => { if (this.inFlight.get(key) === operation) this.inFlight.delete(key); }).catch(() => undefined);
      }
      work.push(operation);
    }
    await Promise.all(work);
  }

  snapshots(): AgentModelOfferedValuesSnapshot[] {
    this.invalidateForAgents(this.agents);
    return [...this.cache.values()].map(value => structuredClone(value.snapshot)).sort((a, b) => a.agentId.localeCompare(b.agentId) || a.mappingId.localeCompare(b.mappingId));
  }

  private async discoverOne(id: string, key: string, resolved: OfferedAuthority, agent: ConnectedAgentView, manifestId: string): Promise<void> {
    try {
      const observed = await this.options.discover(resolved.agentId, resolved.configId);
      const currentAgent = this.agents.find(candidate => candidate.agentId === resolved.agentId);
      if (!eligible(currentAgent) || key !== this.authorityKey(resolved, currentAgent, this.options.manifestId() ?? "")) return;
      const now = this.options.clock.now();
      const ttlEnd = now + (this.options.ttlMs ?? 5 * 60_000);
      const expires = resolved.expiresAt ? Math.min(parseRfc3339(resolved.expiresAt), ttlEnd) : ttlEnd;
      if (expires <= now) return;
      const snapshotRevision = (this.revisions.get(id) ?? 0) + 1;
      const body = {
        version: 1 as const, snapshotId: (this.options.newId ?? randomUUID)(), snapshotRevision,
        instanceId: this.options.instanceId(), agentId: resolved.agentId,
        authIdentityFingerprint: currentAgent.authIdentityFingerprint,
        runnerIncarnation: this.options.runnerIncarnation(), manifestId,
        mappingId: resolved.mappingId, mappingRevision: resolved.mappingRevision,
        mappingDigest: resolved.mappingDigest, configId: resolved.configId,
        currentValue: observed.currentValue, offeredValues: observed.offeredValues,
        ...(observed.offeredOptions?.length ? { offeredOptions: observed.offeredOptions } : {}),
        observedAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(),
      };
      const snapshot = AgentModelOfferedValuesSnapshotSchema.parse({ ...body, snapshotDigest: computeAgentModelOfferedValuesSnapshotDigest(body) });
      this.revisions.set(id, snapshotRevision); this.cache.set(id, { authorityKey: key, snapshot }); this.retry.delete(key);
    } catch {
      const previous = this.retry.get(key)?.failures ?? 0, failures = Math.min(previous + 1, 8);
      this.retry.set(key, { failures, nextAt: this.options.clock.now() + Math.min(300_000, 5_000 * 2 ** (failures - 1)) });
      // A transient discovery failure must not punch a readiness hole. The
      // existing same-authority snapshot remains usable until its signed
      // expiry; `snapshots()` removes it at that boundary.
      const cached = this.cache.get(id);
      if (!cached || cached.authorityKey !== key
        || parseRfc3339(cached.snapshot.expiresAt) <= this.options.clock.now()) this.cache.delete(id);
    }
  }

  private authorityKey(value: OfferedAuthority, agent: ConnectedAgentView & { authIdentityFingerprint: string }, manifestId: string): string {
    return JSON.stringify([manifestId, value.mappingId, value.mappingRevision, value.mappingDigest,
      agent.authIdentityFingerprint, this.options.runnerIncarnation(), this.agentEpochs.get(value.agentId) ?? 0]);
  }
}

function eligible(agent: ConnectedAgentView | undefined): agent is ConnectedAgentView & { authIdentityFingerprint: string } {
  return agent?.authMode === "agent_local_subscription" && agent.readiness === "ready" && agent.connectionState === "ready" && typeof agent.authIdentityFingerprint === "string" && agent.authIdentityFingerprint.length > 0;
}
function identity(value: OfferedAuthority): string { return `${value.agentId}\0${value.mappingId}`; }
