import { randomUUID } from "node:crypto";
import { isNativeAgentRuntimeId } from "@konteks/backstage-plugin-common";
import { classifyAgentBilling, credentialKindFor } from "@konteks/backstage-plugin-common/known-models";
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
  offeredOptions?: Array<{ value: string; name?: string; group?: string; groupName?: string; billing?: "subscription" | "pay_per_use" }>;
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
  /**
   * How one offered value is billed on this machine (OpenCode: by route
   * provider and the credential that serves it; CP3). Undefined leaves the
   * option unlabelled, which an older Core requires.
   */
  optionBilling?: (agentId: string, value: string, agent: ConnectedAgentView) => "subscription" | "pay_per_use" | undefined;
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
      const offeredOptions = this.options.optionBilling
        ? (observed.offeredOptions?.length ? observed.offeredOptions : observed.offeredValues.map(value => ({ value }))).map(option => {
          const billing = this.options.optionBilling!(resolved.agentId, option.value, currentAgent);
          return billing === undefined ? option : { ...option, billing };
        })
        : observed.offeredOptions;
      const labelled = offeredOptions?.some(option => "billing" in option) ? offeredOptions : observed.offeredOptions;
      const body = {
        version: 1 as const, snapshotId: (this.options.newId ?? randomUUID)(), snapshotRevision,
        instanceId: this.options.instanceId(), agentId: resolved.agentId,
        authIdentityFingerprint: currentAgent.authIdentityFingerprint,
        runnerIncarnation: this.options.runnerIncarnation(), manifestId,
        mappingId: resolved.mappingId, mappingRevision: resolved.mappingRevision,
        mappingDigest: resolved.mappingDigest, configId: resolved.configId,
        currentValue: observed.currentValue, offeredValues: observed.offeredValues,
        ...(labelled?.length ? { offeredOptions: labelled } : {}),
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

/**
 * How one offered OpenCode value is billed on this machine (CP3, O7/O11):
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
 * How Google Antigravity's offered models are billed (antigravity CP3): by how
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
