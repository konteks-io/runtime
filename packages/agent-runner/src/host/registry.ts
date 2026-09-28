import { RemoteInstanceError } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { HostAgentRunnerAdapter } from "./host-agent.js";
import { dshRunnerAdapter } from "./dsh.js";
import { openCodeRunnerAdapter } from "./opencode.js";

/** Every host-installed agent's runner adapter, one per `HOST_AGENT_BRIDGES` family. */
export const HOST_AGENT_RUNNER_ADAPTERS: readonly HostAgentRunnerAdapter[] = Object.freeze([dshRunnerAdapter, openCodeRunnerAdapter]);

/** The runner adapter of a host-installed agent id, if any. */
export function hostAgentRunnerAdapter(agentId: string): HostAgentRunnerAdapter | undefined {
  return HOST_AGENT_RUNNER_ADAPTERS.find(adapter => adapter.agentId === agentId);
}

/**
 * The host adapter a runner uses, or null for a bundled agent. Every adapter
 * whose settings the config carries, or whose agent the family is, must accept
 * the runner: host settings never leak into another family's process.
 */
export function hostAdapterForRunner(config: RunnerConfig, family: AgentBridgeFamily): HostAgentRunnerAdapter | null {
  const involved = HOST_AGENT_RUNNER_ADAPTERS.filter(adapter => adapter.agentId === family.agentId || adapter.carriesSettings(config));
  for (const adapter of involved) adapter.assertRunner(config, family);
  if (family.hostInstall === undefined) return null;
  const own = hostAgentRunnerAdapter(family.agentId);
  if (!own) throw new RemoteInstanceError("agent_unavailable", `no host adapter for agent family: ${family.agentId}`);
  return own;
}
