import { RemoteInstanceError } from "@konteks/remote-common";
import { dirname } from "node:path";
import { dshRuntimePaths, type RunnerConfig } from "@konteks/remote-agent-runner";
import type { NativeRuntimeRecord } from "./installation.js";
import { locateNativeDsh, resolveNativeDshInstallation, resolveNativeDshNode, verifyNativeDshRoot } from "./dsh-installation.js";
import { checkDshKonteksProfile } from "./dsh-profile-check.js";
import { locateNativeOpenCode, resolveNativeOpenCodeInstallation, verifyNativeOpenCodeBinary } from "./opencode-installation.js";

/** The runner settings a host adapter derives from an install record (merged into `RunnerConfigSchema`). */
export type HostAgentRunnerSettings = Partial<RunnerConfig> & { RUNNER_BRIDGE_PREFIX: string; RUNNER_BRIDGE_VERSION: string };

/** Replaceable checks, for tests only. */
export interface HostAgentSelfCheckDeps {
  dshProfileCheck?: typeof checkDshKonteksProfile;
}

/**
 * The install side of an agent used from the person's own installation
 * (DeepSeek Harness, OpenCode): find it, keep what the install record needs,
 * re-verify that record on every load, and prove the Konteks overlay or config
 * is in force before the runner starts. The runner side (spawn, private home,
 * environment, sign-in, identity) is `HostAgentRunnerAdapter` in
 * `@konteks/remote-agent-runner`.
 */
export interface HostAgentInstallAdapter {
  readonly agentId: string;
  /**
   * Whether the agent may be installed, detected at enrollment, or loaded from
   * a record. False until the agent's security checkpoint passes: a gated
   * agent is refused on install and skipped (with a warning) when a stored
   * record lists it.
   */
  readonly offered: boolean;
  /** Locate the person's installation now; the install-record fields to keep. Operator configuration only. */
  locate(env?: NodeJS.ProcessEnv): Promise<Partial<NativeRuntimeRecord>>;
  /** Re-locate or re-verify the recorded installation (every load); the runner settings for it. */
  runnerSettings(record: NativeRuntimeRecord): Promise<HostAgentRunnerSettings>;
  /** Before the runner starts: the Konteks overlay or config is proven in force in this exact installation. */
  selfCheck(config: RunnerConfig, deps?: HostAgentSelfCheckDeps): Promise<void>;
}

/** The person's own DeepSeek Harness (dsh-runtime-support CP1-CP5). */
export const dshInstallAdapter: HostAgentInstallAdapter = {
  agentId: "dsh",
  offered: true,
  locate: env => locateNativeDsh(env),
  async runnerSettings(record) {
    const dsh = record.dshRoot === undefined ? await resolveNativeDshInstallation() : await verifyNativeDshRoot(record.dshRoot);
    const node = await resolveNativeDshNode(dsh, record.dshNode === undefined ? process.env : { DSH_NODE: record.dshNode });
    return {
      RUNNER_NATIVE_DSH_ROOT: dsh.root, RUNNER_NATIVE_DSH_ENTRY: dsh.entry, RUNNER_NATIVE_DSH_NODE: node,
      RUNNER_BRIDGE_PREFIX: dsh.root, RUNNER_BRIDGE_VERSION: dsh.version,
    };
  },
  // A dsh upgrade that stops a patch applying, the ask hook included, never spawns.
  async selfCheck(config, deps = {}) {
    const { dshHome, konteksDir } = dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
    if (!config.RUNNER_NATIVE_DSH_ROOT || !config.RUNNER_NATIVE_DSH_ENTRY || !config.RUNNER_NATIVE_DSH_NODE) {
      throw new RemoteInstanceError("prerequisite_missing", "DeepSeek Harness was not located on this machine.", { diagnostic: "dsh_not_found" });
    }
    await (deps.dshProfileCheck ?? checkDshKonteksProfile)({
      node: config.RUNNER_NATIVE_DSH_NODE,
      installation: { root: config.RUNNER_NATIVE_DSH_ROOT, entry: config.RUNNER_NATIVE_DSH_ENTRY, version: config.RUNNER_BRIDGE_VERSION },
      dshHome, konteksDir,
    });
  },
};

/**
 * The person's own OpenCode 2 (opencode-runtime-support CP1): found, version
 * checked and recorded like dsh, but NOT offered until its security
 * checkpoint (CP4) lifts the gate: until then it is refused on install, never
 * detected at enrollment, skipped when a stored record lists it, and its
 * runner refuses to start.
 */
export const openCodeInstallAdapter: HostAgentInstallAdapter = {
  agentId: "opencode",
  offered: false,
  locate: env => locateNativeOpenCode(env),
  async runnerSettings(record) {
    const opencode = record.opencodeBinary === undefined ? await resolveNativeOpenCodeInstallation() : await verifyNativeOpenCodeBinary(record.opencodeBinary);
    return { RUNNER_NATIVE_OPENCODE_BINARY: opencode.binary, RUNNER_BRIDGE_PREFIX: dirname(opencode.binary), RUNNER_BRIDGE_VERSION: opencode.version };
  },
  // The locked-config self-check (`opencode debug agents` in the private home) arrives in CP2.
  async selfCheck() {
    throw new RemoteInstanceError("agent_unavailable", "OpenCode cannot run Konteks work on this computer yet.");
  },
};

/** Every host-installed agent's install adapter, one per `HOST_AGENT_BRIDGES` family. */
export const HOST_AGENT_INSTALL_ADAPTERS: readonly HostAgentInstallAdapter[] = Object.freeze([dshInstallAdapter, openCodeInstallAdapter]);

/** The install adapter of a host-installed agent id, if any. */
export function hostAgentInstallAdapter(agentId: string): HostAgentInstallAdapter | undefined {
  return HOST_AGENT_INSTALL_ADAPTERS.find(adapter => adapter.agentId === agentId);
}

/** Whether an agent may be installed and run here: every bundled agent, and a host agent once offered. */
export function nativeAgentOffered(agentId: string): boolean {
  return hostAgentInstallAdapter(agentId)?.offered ?? true;
}
