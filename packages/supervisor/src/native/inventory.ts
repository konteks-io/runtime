import { z } from "zod";
import { ConnectedAgentViewSchema, REMOTE_AGENT_LOGIN_BROWSER_CAPABILITY, REMOTE_AGENT_LOGIN_CAPABILITY, REMOTE_CANCELLATION_DELIVERY_CAPABILITY, REMOTE_EXECUTION_PERMITS_CAPABILITY, REMOTE_DELIVERY_PERMITS_CAPABILITY, REMOTE_SESSION_LABEL_CAPABILITY, type ConnectedAgentView } from "@konteks/remote-common";
import { hostPressureRatio, UtilizationSignalsSchema, type SignalSampler } from "@konteks/remote-sysmon";
import type { InventorySnapshot } from "../inventory/snapshot.js";
import type { RunnerPort } from "../runner-port.js";
import { onboardCapabilities } from "../inventory/roles.js";

const readinessSchema = z.object({
  agent: ConnectedAgentViewSchema,
  utilization: z.object({ activeSessions: z.number().int().nonnegative(), activeTurns: z.number().int().nonnegative() }).strict(),
}).strict();

export interface NativeInventoryOptions {
  runners: ReadonlyMap<string, Pick<RunnerPort, "readiness">>;
  sampler: Pick<SignalSampler, "sample">;
  bundleVersion: string;
  /** Live composition/ownership check; absence never advertises permit support. */
  executionPermitsReady?: () => boolean;
  /** Dedicated delivery protocol composition; Assistant support is not enough. */
  deliveryExecutionPermitsReady?: () => boolean;
  /** Cancellation remains available independently of agent sign-in/readiness. */
  cancellationDeliveryReady?: () => boolean;
  /** A person may start this machine's Codex login from the site (WS1-115). */
  agentLoginReady?: () => boolean;
  /** ...and Claude Code's, which needs a browser this machine can open. */
  agentLoginBrowserReady?: () => boolean;
  /** The machine's git probe (OB6 §1); omitted, the runtime is not `onboard`. */
  gitVersion?: () => Promise<string | null>;
  now?: () => Date;
}

/** No domain-service URLs, sysmon HTTP endpoint or fictitious gateway health. */
/** A login that opens a browser here can only finish where someone sits at this machine. */
export function machineHasDesktop(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === "darwin" || platform === "win32") return env.SSH_CONNECTION === undefined;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export class NativeInventoryCollector {
  private readonly cached = new Map<string, ConnectedAgentView>();
  private readonly now: () => Date;

  constructor(private readonly options: NativeInventoryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  agents(): ConnectedAgentView[] { return structuredClone([...this.cached.values()]); }

  updateAgent(value: ConnectedAgentView): void {
    const parsed = ConnectedAgentViewSchema.safeParse(value);
    if (parsed.success && this.options.runners.has(parsed.data.agentId) && parsed.data.authMode === "agent_local_subscription") {
      this.cached.set(parsed.data.agentId, parsed.data);
    }
  }

  async collect(): Promise<InventorySnapshot> {
    const at = this.now().toISOString();
    const gitVersion = await (this.options.gitVersion?.().catch(() => null) ?? Promise.resolve(null));
    const [signals, results] = await Promise.all([
      this.options.sampler.sample(this.now).then(value => UtilizationSignalsSchema.safeParse(value)).catch(() => null),
      Promise.all([...this.options.runners].map(async ([agentId, runner]) => {
        try {
          const parsed = readinessSchema.safeParse(await runner.readiness());
          if (parsed.success && parsed.data.agent.agentId === agentId && parsed.data.agent.authMode === "agent_local_subscription") return { agentId, readiness: parsed.data };
        } catch { /* Closed unavailable projection below; never publish probe errors. */ }
        return { agentId, readiness: null };
      })),
    ]);
    let healthyRunners = 0;
    let activeSessions = 0;
    let activeTurns = 0;
    const agents: ConnectedAgentView[] = [];
    for (const { agentId, readiness } of results) {
      if (readiness) {
        healthyRunners += 1;
        activeSessions += readiness.utilization.activeSessions;
        activeTurns += readiness.utilization.activeTurns;
        agents.push(readiness.agent);
      } else {
        const cached = this.cached.get(agentId);
        if (cached) agents.push({ ...cached, readiness: "unavailable", connectionState: "unavailable" });
      }
    }
    this.cached.clear();
    for (const agent of agents) this.cached.set(agent.agentId, structuredClone(agent));
    const metrics = signals?.success ? signals.data : null;
    const capabilities = agents.filter(agent => agent.readiness === "ready" && agent.connectionState === "ready").map(agent => `agent:${agent.agentId}`);
    if (capabilities.length > 0 && this.options.executionPermitsReady?.()) capabilities.push(REMOTE_EXECUTION_PERMITS_CAPABILITY);
    if (agents.some(agent => agent.readiness === 'ready' && agent.connectionState === 'ready') &&
      this.options.deliveryExecutionPermitsReady?.()) capabilities.push(REMOTE_DELIVERY_PERMITS_CAPABILITY);
    if (this.options.cancellationDeliveryReady?.()) capabilities.push(REMOTE_CANCELLATION_DELIVERY_CAPABILITY);
    if (this.options.agentLoginReady?.()) capabilities.push(REMOTE_AGENT_LOGIN_CAPABILITY);
    if (this.options.agentLoginBrowserReady?.()) capabilities.push(REMOTE_AGENT_LOGIN_BROWSER_CAPABILITY);
    // The onboard role is git on THIS machine, not a signed-in agent: the
    // capabilities are advertised whenever git answers, and withheld the moment
    // it does not (OB6 §1).
    capabilities.push(...onboardCapabilities(gitVersion));
    // This build names the person's coding sessions from Core's display label;
    // an older one rejects the field, so Core sends it only on this signal.
    if (agents.some(agent => agent.readiness === "ready" && agent.connectionState === "ready")) capabilities.push(REMOTE_SESSION_LABEL_CAPABILITY);
    return {
      components: [{ kind: "agent_runner", version: this.options.bundleVersion,
        healthStatus: healthyRunners === 0 ? "unhealthy" : healthyRunners === results.length ? "healthy" : "degraded",
        capabilities, lastProbeAt: at }],
      agents,
      hostPressure: metrics ? hostPressureRatio(metrics) : 1,
      activeSessions,
      activeTurns,
      gitVersion,
      diskFreeBytes: metrics?.diskFreeBytes ?? 0,
    };
  }
}
