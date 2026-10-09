import { LOCAL_SKILL_PROMOTION_CAPABILITY, REMOTE_RUNTIME_SKILL_SYNC_CAPABILITY } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { z } from "zod";
import { DELIVERY_TURN_RENEWAL_CAPABILITY } from "./delivery-turn-renewal.js";
import { ConnectedAgentViewSchema, REMOTE_CORE_CONTRACT_CAPABILITY,
  REMOTE_DIRECT_MODEL_FALLBACK_CAPABILITY,
  REMOTE_AGENT_LOGIN_BROWSER_CAPABILITY, REMOTE_AGENT_LOGIN_CAPABILITY, REMOTE_CANCELLATION_DELIVERY_CAPABILITY, REMOTE_EXECUTION_PERMITS_CAPABILITY, REMOTE_DELIVERY_PERMITS_CAPABILITY, REMOTE_PREVIEW_CAPABILITY, REMOTE_SESSION_LABEL_CAPABILITY, type ConnectedAgentView,
} from "@konteks/remote-common";
import { hostPressureRatio, UtilizationSignalsSchema, type SignalSampler } from "@konteks/remote-sysmon";
import type { InventorySnapshot } from "../inventory/snapshot.js";
import type { RunnerPort } from "../runner-port.js";
import { onboardCapabilities } from "../inventory/roles.js";

const readinessSchema = z.object({
  agent: ConnectedAgentViewSchema,
  utilization: z.object({ activeSessions: z.number().int().nonnegative(), activeTurns: z.number().int().nonnegative() }).strict(),
}).strict();

interface NativeInventoryOptions {
  runners: ReadonlyMap<string, Pick<RunnerPort, "readiness">>;
  sampler: Pick<SignalSampler, "sample">;
  bundleVersion: string;
  /** Live composition/ownership check; absence never advertises permit support. */
  executionPermitsReady?: () => boolean;
  /** Dedicated delivery protocol composition; Assistant support is not enough. */
  deliveryExecutionPermitsReady?: () => boolean;
  /** Cancellation remains available independently of agent sign-in/readiness. */
  cancellationDeliveryReady?: () => boolean;
  /** The owned runtime has the signed Skill sync transport and request consumer. */
  skillSyncReady?: () => boolean;
  /** A person may start this machine's Codex login from the site. */
  agentLoginReady?: () => boolean;
  /** ...and Claude Code's, which needs a browser this machine can open. */
  agentLoginBrowserReady?: () => boolean;
  /** Further agent capabilities (OpenCode: its free-models switch and the sign-ins the site may start). */
  additionalCapabilities?: () => readonly string[];
  /**
   * This connector can serve session previews over the relay
   * (`preview.dev_server`). Core offers the `preview` attach scope, and the
   * relay opens `preview:<sessionId>`, only for a connector that says so.
   */
  previewReady?: () => boolean;
  /**
   * What the connector adds to the agents it reports, beside each runner's own
   * view (Google Antigravity's download state, and its entry while no runner
   * of it can start). Never changes readiness or capabilities.
   */
  decorateAgents?: (agents: ConnectedAgentView[]) => Promise<ConnectedAgentView[]>;
  /** The machine's git probe; omitted, the runtime is not `onboard`. */
  gitVersion?: () => Promise<string | null>;
  /**
   * The personal Claude Code executable's identity
   * (`claude-code-executable:<version>:sha256:<hex>`, `claude-executable-identity.ts`):
   * a change invalidates anything certified against the previous one.
   */
  claudeExecutable?: () => Promise<string | null>;
  now?: () => Date;
}

/** No domain-service URLs, sysmon HTTP endpoint or fictitious gateway health. */
/** A login that opens a browser here can only finish where someone sits at this machine. */
export function machineHasDesktop(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === "darwin" || platform === "win32") return env.SSH_CONNECTION === undefined;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** A probe's answer, or null when there is no probe or it failed. */
function settledProbe(pending: Promise<string | null> | undefined): Promise<string | null> {
  return pending?.catch(() => null) ?? Promise.resolve(null);
}

/** A runner's readiness when it parses and names its own agent; null otherwise (probe errors are never published). */
async function runnerReadiness(agentId: string, runner: Pick<RunnerPort, "readiness">): Promise<{ agentId: string; readiness: z.infer<typeof readinessSchema> | null }> {
  try {
    const parsed = readinessSchema.safeParse(await runner.readiness());
    if (parsed.success && parsed.data.agent.agentId === agentId && parsed.data.agent.authMode === "agent_local_subscription") return { agentId, readiness: parsed.data };
  } catch { /* Closed unavailable projection below; never publish probe errors. */ }
  return { agentId, readiness: null };
}

function parsedSignals<T>(signals: { success: true; data: T } | { success: false } | null): T | null {
  return signals?.success ? signals.data : null;
}

function runnerHealth(healthy: number, total: number): "unhealthy" | "healthy" | "degraded" {
  if (healthy === 0) return "unhealthy";
  return healthy === total ? "healthy" : "degraded";
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
    const gitVersion = await settledProbe(this.options.gitVersion?.());
    const claudeExecutable = await settledProbe(this.options.claudeExecutable?.());
    const [signals, results] = await Promise.all([
      this.options.sampler.sample(this.now).then(value => UtilizationSignalsSchema.safeParse(value)).catch(() => null),
      Promise.all([...this.options.runners].map(([agentId, runner]) => runnerReadiness(agentId, runner))),
    ]);
    const tally = this.tally(results);
    this.cached.clear();
    for (const agent of tally.agents) this.cached.set(agent.agentId, structuredClone(agent));
    const metrics = parsedSignals(signals);
    const capabilities = this.capabilities(tally.agents, gitVersion, claudeExecutable);
    const reported = await this.decorated(tally.agents);
    return {
      components: [{ kind: "agent_runner", version: this.options.bundleVersion, healthStatus: runnerHealth(tally.healthyRunners, results.length), capabilities, lastProbeAt: at }],
      agents: reported,
      hostPressure: metrics ? hostPressureRatio(metrics) : 1,
      activeSessions: tally.activeSessions,
      activeTurns: tally.activeTurns,
      gitVersion,
      diskFreeBytes: metrics?.diskFreeBytes ?? 0,
    };
  }

  /** Runner totals and the agents to report: each ready runner's view, else its last view marked unavailable. */
  private tally(results: ReadonlyArray<{ agentId: string; readiness: z.infer<typeof readinessSchema> | null }>) {
    const tally = { healthyRunners: 0, activeSessions: 0, activeTurns: 0, agents: [] as ConnectedAgentView[] };
    for (const { agentId, readiness } of results) {
      if (readiness) {
        tally.healthyRunners += 1;
        tally.activeSessions += readiness.utilization.activeSessions;
        tally.activeTurns += readiness.utilization.activeTurns;
        tally.agents.push(readiness.agent);
        continue;
      }
      const cached = this.cached.get(agentId);
      if (cached) tally.agents.push({ ...cached, readiness: "unavailable", connectionState: "unavailable" });
    }
    return tally;
  }

  private decorated(agents: ConnectedAgentView[]): Promise<ConnectedAgentView[]> {
    if (!this.options.decorateAgents) return Promise.resolve(agents);
    return this.options.decorateAgents(structuredClone(agents)).catch(() => agents);
  }

  private capabilities(agents: readonly ConnectedAgentView[], gitVersion: string | null, claudeExecutable: string | null): string[] {
    const ready = agents.filter(agent => agent.readiness === "ready" && agent.connectionState === "ready");
    const capabilities = this.withAdditional([...ready.map(agent => `agent:${agent.agentId}`), ...this.permitCapabilities(ready.length > 0), ...this.deliveryChannelCapabilities()]);
    // The onboard role is git on THIS machine, not a signed-in agent: the
    // capabilities are advertised whenever git answers, and withheld the moment
    // it does not.
    capabilities.push(...onboardCapabilities(gitVersion));
    if (claudeExecutable !== null) capabilities.push(claudeExecutable);
    // This build names the person's coding sessions from Core's display label;
    // an older one rejects the field, so Core sends it only on this signal.
    if (ready.length > 0) capabilities.push(REMOTE_SESSION_LABEL_CAPABILITY);
    // Always, whatever agents are installed: this build reads the Core
    // wire-contract version (`coreContractVersion`) Core signs into the desired
    // configuration of a connector that asks for it, and takes Core's 7.1
    // fields (pay-per-use turns, the download state, a credential's reason)
    // from it.
    capabilities.push(REMOTE_CORE_CONTRACT_CAPABILITY);
    if (this.options.previewReady?.()) capabilities.push(REMOTE_PREVIEW_CAPABILITY);
    return capabilities;
  }

  /** Signed execution and delivery permits, only while some agent is ready to use them. */
  private permitCapabilities(anyReady: boolean): string[] {
    const permits: string[] = [];
    if (anyReady && this.options.executionPermitsReady?.()) permits.push(REMOTE_EXECUTION_PERMITS_CAPABILITY, REMOTE_DIRECT_MODEL_FALLBACK_CAPABILITY);
    if (anyReady && this.options.deliveryExecutionPermitsReady?.()) permits.push(REMOTE_DELIVERY_PERMITS_CAPABILITY, DELIVERY_TURN_RENEWAL_CAPABILITY);
    return permits;
  }

  /** Cancellation delivery and site-started logins, whatever the agents' readiness. */
  private deliveryChannelCapabilities(): string[] {
    const readiness: Array<[string, (() => boolean) | undefined]> = [
      [REMOTE_RUNTIME_SKILL_SYNC_CAPABILITY, this.options.skillSyncReady],
      [LOCAL_SKILL_PROMOTION_CAPABILITY, this.options.skillSyncReady],
      [REMOTE_CANCELLATION_DELIVERY_CAPABILITY, this.options.cancellationDeliveryReady],
      [REMOTE_AGENT_LOGIN_CAPABILITY, this.options.agentLoginReady],
      [REMOTE_AGENT_LOGIN_BROWSER_CAPABILITY, this.options.agentLoginBrowserReady],
    ];
    return readiness.filter(([, ready]) => ready?.() === true).map(([capability]) => capability);
  }

  private withAdditional(capabilities: string[]): string[] {
    for (const capability of this.options.additionalCapabilities?.() ?? []) if (!capabilities.includes(capability)) capabilities.push(capability);
    return capabilities;
  }}
