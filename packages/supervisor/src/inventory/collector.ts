import { z } from "zod";
import type { SchemaParser } from "@konteks/remote-common";
import { ConnectedAgentViewSchema, createLogger, type ConnectedAgentView, type Logger, type RemoteInstanceView } from "@konteks/remote-common";
import { UtilizationSignalsSchema, hostPressureRatio } from "@konteks/remote-sysmon";

/**
 * Collects the sanitized inventory the heartbeat carries: component health
 * (harness, validation_runtime, gateway, agent_runner), agent readiness from
 * every runner, and host pressure from sysmon. Raw probe output never leaves
 * this module; only the closed projections do.
 */
export type ComponentInventory = RemoteInstanceView["components"][number];

/** How long a component's own pushed health outranks the supervisor's probe. */
const PUSHED_VIEW_TTL_MS = 90_000;

export interface InventorySources {
  harnessUrl: string;
  validationUrl: string;
  gatewayAdminUrl: string;
  sysmonUrl: string;
  browserToolUrl: string;
  runnerUrls: Map<string, string>;
  fetchFn?: typeof fetch;
  now?: () => Date;
  logger?: Logger;
}

const GatewayHealthSchema = z.object({ version: z.string(), healthy: z.boolean(), capEnforcementStage: z.string(), egressAllowlistRevision: z.string(), dialects: z.array(z.string()), rollupIncompleteSince: z.string().nullable() }).passthrough();
const RunnerReadinessSchema = z.object({ agent: ConnectedAgentViewSchema, utilization: z.object({ activeSessions: z.number().int(), activeTurns: z.number().int() }).strict() }).strict();
const ComponentHealthSchema = z.object({ status: z.string().optional(), version: z.string().optional(), capabilities: z.array(z.string()).optional() }).passthrough();

export interface InventorySnapshot {
  components: ComponentInventory[];
  agents: ConnectedAgentView[];
  hostPressure: number;
  activeSessions: number;
  activeTurns: number;
  browserToolAvailable: boolean;
  gatewayRollupIncompleteSince: string | null;
  diskFreeBytes: number;
}

export class InventoryCollector {
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private lastAgents: ConnectedAgentView[] = [];
  private readonly pushedComponents = new Map<ComponentInventory["kind"], { view: ComponentInventory; draining: boolean; at: number }>();

  constructor(private readonly sources: InventorySources) {
    this.logger = sources.logger ?? createLogger({ name: "inventory" });
    this.fetchFn = sources.fetchFn ?? fetch;
    this.now = sources.now ?? (() => new Date());
  }

  /**
   * A component's own pushed health, which is richer than the liveness probe
   * (it knows its accepted kinds and whether it is draining). A push newer
   * than {@link PUSHED_VIEW_TTL_MS} wins; anything older is treated as stale
   * and the probe speaks instead.
   */
  updateComponent(view: ComponentInventory, draining: boolean): void {
    this.pushedComponents.set(view.kind, { view, draining, at: this.now().getTime() });
  }

  /** Whether a component said it is draining, as of its last fresh push. */
  componentDraining(kind: ComponentInventory["kind"]): boolean {
    const pushed = this.pushedComponents.get(kind);
    return pushed !== undefined && this.now().getTime() - pushed.at <= PUSHED_VIEW_TTL_MS && pushed.draining;
  }

  private freshPush(kind: ComponentInventory["kind"]): ComponentInventory | null {
    const pushed = this.pushedComponents.get(kind);
    if (!pushed || this.now().getTime() - pushed.at > PUSHED_VIEW_TTL_MS) return null;
    return pushed.view;
  }

  /** Runner readiness events update the cache between full collections. */
  updateAgent(agent: ConnectedAgentView): void {
    this.lastAgents = [...this.lastAgents.filter((candidate) => candidate.agentId !== agent.agentId), agent];
  }

  agents(): ConnectedAgentView[] {
    return [...this.lastAgents];
  }

  private async probeJson<T>(url: string, schema: SchemaParser<T>, timeoutMs = 4_000): Promise<T | null> {
    try {
      const response = await this.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async collect(): Promise<InventorySnapshot> {
    const at = this.now().toISOString();
    const [harness, validation, gateway, sysmon, browser] = await Promise.all([
      this.probeJson(new URL("/health", this.sources.harnessUrl).toString(), ComponentHealthSchema),
      this.probeJson(new URL("/health", this.sources.validationUrl).toString(), ComponentHealthSchema),
      this.probeJson(new URL("/health", this.sources.gatewayAdminUrl).toString(), GatewayHealthSchema),
      this.probeJson(new URL("/metrics", this.sources.sysmonUrl).toString(), UtilizationSignalsSchema),
      this.probeJson(new URL("/health", this.sources.browserToolUrl).toString(), z.object({ ok: z.boolean() }).passthrough()),
    ]);
    const agents: ConnectedAgentView[] = [];
    let activeSessions = 0;
    let activeTurns = 0;
    let anyRunnerHealthy = false;
    for (const [agentId, url] of this.sources.runnerUrls) {
      const readiness = await this.probeJson(new URL("/readiness", url).toString(), RunnerReadinessSchema);
      if (!readiness) {
        const cached = this.lastAgents.find((agent) => agent.agentId === agentId);
        if (cached) agents.push({ ...cached, connectionState: "unavailable", readiness: "unavailable" });
        continue;
      }
      anyRunnerHealthy = true;
      agents.push(readiness.agent);
      activeSessions += readiness.utilization.activeSessions;
      activeTurns += readiness.utilization.activeTurns;
    }
    this.lastAgents = agents;
    const components: ComponentInventory[] = [
      this.freshPush("harness") ?? { kind: "harness", version: harness?.version ?? "unknown", healthStatus: harness ? healthFrom(harness.status) : "unhealthy", capabilities: harness?.capabilities ?? [], lastProbeAt: at },
      this.freshPush("validation_runtime") ?? { kind: "validation_runtime", version: validation?.version ?? "unknown", healthStatus: validation ? healthFrom(validation.status) : "unhealthy", capabilities: validation?.capabilities ?? [], lastProbeAt: at },
      { kind: "agent_runner", version: "bundle", healthStatus: anyRunnerHealthy ? "healthy" : "unhealthy", capabilities: agents.filter((agent) => agent.readiness === "ready").map((agent) => `agent:${agent.agentId}`), lastProbeAt: at },
      {
        kind: "gateway",
        version: gateway?.version ?? "unknown",
        healthStatus: gateway ? (gateway.healthy ? (gateway.rollupIncompleteSince ? "degraded" : "healthy") : "unhealthy") : "unhealthy",
        capabilities: gateway ? [`cap:${gateway.capEnforcementStage}`, `allowlist:${gateway.egressAllowlistRevision}`, ...gateway.dialects.map((dialect) => `dialect:${dialect}`)] : [],
        lastProbeAt: at,
      },
    ];
    if (!sysmon) this.logger.debug("sysmon unreachable; host pressure unknown (treated as full)");
    return {
      components,
      agents,
      hostPressure: sysmon ? hostPressureRatio(sysmon) : 1,
      activeSessions,
      activeTurns,
      browserToolAvailable: browser?.ok === true,
      gatewayRollupIncompleteSince: gateway?.rollupIncompleteSince ?? null,
      diskFreeBytes: sysmon?.diskFreeBytes ?? 0,
    };
  }
}

function healthFrom(status: string | undefined): ComponentInventory["healthStatus"] {
  switch (status) {
    case "ok":
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case undefined:
      return "healthy";
    default:
      return "unhealthy";
  }
}
