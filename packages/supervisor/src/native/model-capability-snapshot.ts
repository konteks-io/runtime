import { randomUUID } from "node:crypto";
import {
  AgentModelOfferedValuesSnapshotSchema,
  computeAgentModelOfferedValuesSnapshotDigest,
  parseRfc3339,
  type AgentModelCapabilityMapping,
  type AgentModelOfferedValuesSnapshot,
  type Clock,
  type ConnectedAgentView,
} from "@konteks/remote-common";

export interface ResolvedModelCapabilityMapping { agentId: string; mapping: AgentModelCapabilityMapping }

export interface ModelCapabilitySnapshotProducerOptions {
  clock: Clock;
  instanceId: () => string;
  runnerIncarnation: () => string;
  manifestId: () => string | null;
  mappings: () => readonly ResolvedModelCapabilityMapping[];
  discover: (agentId: string, configId: string) => Promise<{ currentValue: string; offeredValues: string[] }>;
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

  invalidateForAgents(agents: readonly ConnectedAgentView[]): void {
    this.agents = structuredClone(agents);
    const now = this.options.clock.now();
    const manifestId = this.options.manifestId();
    const mappings = new Map(this.options.mappings().map(value => [identity(value), value]));
    const agentMap = new Map(agents.map(agent => [agent.agentId, agent]));
    for (const [id, entry] of this.cache) {
      const resolved = mappings.get(id), agent = resolved ? agentMap.get(resolved.agentId) : undefined;
      if (!resolved || !eligible(agent) || manifestId === null || entry.authorityKey !== this.authorityKey(resolved, agent!, manifestId)
        || parseRfc3339(entry.snapshot.expiresAt) <= now) this.cache.delete(id);
    }
  }

  invalidateAgent(agentId: string): void {
    this.agentEpochs.set(agentId, (this.agentEpochs.get(agentId) ?? 0) + 1);
    for (const resolved of this.options.mappings()) {
      if (resolved.agentId === agentId) this.cache.delete(identity(resolved));
    }
  }

  async refresh(agents: readonly ConnectedAgentView[]): Promise<void> {
    this.invalidateForAgents(agents);
    const manifestId = this.options.manifestId();
    if (manifestId === null) return;
    const work: Promise<void>[] = [];
    for (const resolved of this.options.mappings().slice(0, 8)) {
      const agent = agents.find(candidate => candidate.agentId === resolved.agentId);
      if (!eligible(agent) || parseRfc3339(resolved.mapping.expiresAt) <= this.options.clock.now()) continue;
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

  private async discoverOne(id: string, key: string, resolved: ResolvedModelCapabilityMapping, agent: ConnectedAgentView, manifestId: string): Promise<void> {
    try {
      const observed = await this.options.discover(resolved.agentId, resolved.mapping.configId);
      const currentAgent = this.agents.find(candidate => candidate.agentId === resolved.agentId);
      if (!eligible(currentAgent) || key !== this.authorityKey(resolved, currentAgent, this.options.manifestId() ?? "")) return;
      const now = this.options.clock.now();
      const expires = Math.min(parseRfc3339(resolved.mapping.expiresAt), now + (this.options.ttlMs ?? 5 * 60_000));
      if (expires <= now) return;
      const snapshotRevision = (this.revisions.get(id) ?? 0) + 1;
      const body = {
        version: 1 as const, snapshotId: (this.options.newId ?? randomUUID)(), snapshotRevision,
        instanceId: this.options.instanceId(), agentId: resolved.agentId,
        authIdentityFingerprint: currentAgent.authIdentityFingerprint,
        runnerIncarnation: this.options.runnerIncarnation(), manifestId,
        mappingId: resolved.mapping.mappingId, mappingRevision: resolved.mapping.mappingRevision,
        mappingDigest: resolved.mapping.mappingDigest, configId: resolved.mapping.configId,
        currentValue: observed.currentValue, offeredValues: observed.offeredValues,
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

  private authorityKey(value: ResolvedModelCapabilityMapping, agent: ConnectedAgentView & { authIdentityFingerprint: string }, manifestId: string): string {
    return JSON.stringify([manifestId, value.mapping.mappingId, value.mapping.mappingRevision, value.mapping.mappingDigest,
      agent.authIdentityFingerprint, this.options.runnerIncarnation(), this.agentEpochs.get(value.agentId) ?? 0]);
  }
}

function eligible(agent: ConnectedAgentView | undefined): agent is ConnectedAgentView & { authIdentityFingerprint: string } {
  return agent?.authMode === "agent_local_subscription" && agent.readiness === "ready" && agent.connectionState === "ready" && typeof agent.authIdentityFingerprint === "string" && agent.authIdentityFingerprint.length > 0;
}
function identity(value: ResolvedModelCapabilityMapping): string { return `${value.agentId}\0${value.mapping.mappingId}`; }
