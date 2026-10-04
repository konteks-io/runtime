import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeEnvironment,
  claudeMcpStatusLaunch,
  codexDiscoveryConnection,
  readClaudeMcpStatus,
  readCodexMcpServerStatus,
  resolveBridgeFamily,
  resolveToolingCommand,
  verifyNativeRunnerPackage,
  type RunnerConfig,
} from "@konteks/remote-agent-runner";
import type { AgentTurnUsageObservation, Logger } from "@konteks/remote-common";
import type { RunnerPort } from "../runner-port.js";
import type { SupervisorJournal } from "../state/journal.js";
import type { WorkloadDefinition } from "../work/workload.js";
import { IntegrationTaskCarrier, integrationFixturesEnabled, type IntegrationWorkAssignment } from "./carrier.js";
import { NativeIntegrationDiscovery, e2eFixtureServers, readFixtureInventory } from "./discovery.js";
import { OfficialSetupRunner, type SetupCommandLaunch } from "./setup.js";
import { journalWriteLedger } from "./tool-gate.js";

interface IntegrationCompositionInputs {
  /** The installation's native runner configurations. */
  configs: readonly RunnerConfig[];
  runners: () => ReadonlyMap<string, RunnerPort>;
  fetchWorkload: (assignment: IntegrationWorkAssignment) => Promise<WorkloadDefinition>;
  instanceId: () => string;
  journal: SupervisorJournal;
  onUsage?: (observation: AgentTurnUsageObservation) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

/** Codex's own pinned CLI from the release package, with the runner's environment (the person's Codex profile). */
export function codexSetupLaunch(config: RunnerConfig): SetupCommandLaunch {
  const family = resolveBridgeFamily("codex");
  const { command, args } = resolveToolingCommand(config, family, [family.tooling.login[0]!]);
  return { command, args, env: bridgeEnvironment(config, family) };
}

/**
 * The integration lane for a native installation:
 * discovery through each agent's reviewed listing interface, the reviewed
 * setup catalogue, the runners for gated sessions, and the journal's
 * one-use write grants.
 */
export function composeIntegrationCarrier(inputs: IntegrationCompositionInputs): IntegrationTaskCarrier {
  const claude = inputs.configs.find(config => config.RUNNER_AGENT_ID === "claude-code" && config.RUNNER_NATIVE_CLAUDE_EXECUTABLE !== undefined);
  const codex = inputs.configs.find(config => config.RUNNER_AGENT_ID === "codex");
  const codexSocket = codex?.RUNNER_NATIVE_CODEX_SOCKET;
  const fixtureServers = integrationFixturesEnabled(inputs.env) ? e2eFixtureServers(inputs.env) : [];
  return new IntegrationTaskCarrier({
    fetchWorkload: inputs.fetchWorkload,
    discovery: new NativeIntegrationDiscovery({
      ...(claude ? {
        claude: async () => {
          // The child runs the release's bundled SDK: check the package first.
          await verifyNativeRunnerPackage(claude);
          const cwd = await mkdtemp(join(tmpdir(), "konteks-integration-discovery-"));
          try { return await readClaudeMcpStatus(claudeMcpStatusLaunch(claude, cwd)); }
          finally { await rm(cwd, { recursive: true, force: true }).catch(() => undefined); }
        },
      } : {}),
      ...(codexSocket ? { codex: () => readCodexMcpServerStatus(codexDiscoveryConnection(codexSocket)) } : {}),
      // E2E only: the controller's synthetic providers as Claude `fixture_mcp` sources.
      ...(fixtureServers.length > 0 ? { fixtures: () => readFixtureInventory(fixtureServers) } : {}),
    }),
    setup: new OfficialSetupRunner({
      codex: () => {
        if (!codex) return null;
        try { return codexSetupLaunch(codex); } catch { return null; }
      },
      logger: inputs.logger,
    }),
    runners: inputs.runners,
    instanceId: inputs.instanceId,
    workspaceRoot: agentId => inputs.configs.find(config => config.RUNNER_AGENT_ID === agentId)?.RUNNER_WORKSPACE_DIR ?? tmpdir(),
    writes: journalWriteLedger(inputs.journal),
    e2eFixtures: integrationFixturesEnabled(inputs.env),
    ...(inputs.onUsage ? { onUsage: inputs.onUsage } : {}),
    logger: inputs.logger,
  });
}
