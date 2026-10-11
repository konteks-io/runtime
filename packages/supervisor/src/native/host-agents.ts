import { RemoteInstanceError } from "@konteks/remote-common";
import { dirname, isAbsolute } from "node:path";
import { dshRuntimePaths, type RunnerConfig } from "@konteks/remote-agent-runner";
import type { NativeRuntimeRecord } from "./installation.js";
import { locateNativeDsh, resolveNativeDshInstallation, resolveNativeDshNode, verifyNativeDshRoot } from "./dsh-installation.js";
import { checkDshKonteksProfile } from "./dsh-profile-check.js";
import { locateNativeOpenCode, resolveNativeOpenCodeInstallation, verifyNativeOpenCodeBinary } from "./opencode-installation.js";
import { checkOpenCodeKonteksConfig } from "./opencode-self-check.js";
import { ANTIGRAVITY_CONSENT_TEXT, antigravityPin, fetchNativeAntigravity, locateNativeAntigravity, verifyNativeAntigravityFolder, verifyNativeAntigravityRecord, type AntigravityInstallDeps } from "./antigravity-installation.js";
import { checkAntigravityServer } from "./antigravity-self-check.js";

/** The runner settings a host adapter derives from an install record (merged into `RunnerConfigSchema`). */
export type HostAgentRunnerSettings = Partial<RunnerConfig> & { RUNNER_BRIDGE_PREFIX: string; RUNNER_BRIDGE_VERSION: string };

/** Replaceable checks, for tests only. */
export interface HostAgentSelfCheckDeps {
  dshProfileCheck?: typeof checkDshKonteksProfile;
  openCodeSelfCheck?: typeof checkOpenCodeKonteksConfig;
  /** Antigravity's fetch and integrity checks (a fixture pin and signature check). */
  antigravity?: AntigravityInstallDeps;
  /** Antigravity's `initialize` start check. */
  antigravitySelfCheck?: typeof checkAntigravityServer;
}

/** The connector's own install root (`native-runtime.json` lives there); a fetched agent is kept under `<root>/agents/<id>/`. */
export interface HostAgentInstallContext {
  root: string;
}

/** What a fetched agent's `fetch` needs: where, and the person's answer to its consent line. */
export interface HostAgentFetchRequest extends HostAgentInstallContext {
  /** The person's answer to `consentText`. Anything but an explicit yes (`true`) downloads nothing. */
  consent: boolean;
}

/**
 * The install side of an agent used from the person's own installation
 * (DeepSeek Harness, OpenCode) or fetched by the connector on the person's
 * yes (`hostInstall.launch: "fetched"`): find it, keep what the install
 * record needs, re-verify that record on every load, and prove the Konteks
 * overlay or config is in force before the runner starts. The runner side
 * (spawn, private home, environment, sign-in, identity) is
 * `HostAgentRunnerAdapter` in `@konteks/remote-agent-runner`.
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
  /**
   * Locate the installation now; the install-record fields to keep. Operator
   * configuration only. A fetched agent looks in the connector's own folder
   * (`context.root`) and never downloads anything here.
   */
  locate(env?: NodeJS.ProcessEnv, context?: HostAgentInstallContext): Promise<Partial<NativeRuntimeRecord>>;
  /** Re-locate or re-verify the recorded installation (every load); the runner settings for it. */
  runnerSettings(record: NativeRuntimeRecord, context?: HostAgentInstallContext): Promise<HostAgentRunnerSettings>;
  /** A fetched agent only: the plain line the person answers before anything is downloaded. */
  readonly consentText?: string;
  /**
   * A fetched agent only: refuses, before the consent question, on a computer
   * the release pins no copy for (the plain "not available for this computer
   * yet" line).
   */
  assertFetchable?(): void;
  /**
   * A fetched agent only, used by the launcher: download the pinned release
   * on the person's yes, verify it, and keep it in the connector's own folder;
   * the install-record fields to keep. Refuses without consent.
   */
  fetch?(request: HostAgentFetchRequest): Promise<Partial<NativeRuntimeRecord>>;
  /** Before the runner starts: the Konteks overlay or config is proven in force in this exact installation. */
  selfCheck(config: RunnerConfig, deps?: HostAgentSelfCheckDeps): Promise<void>;
}

/**
 * npm's global prefix for the Node DeepSeek Harness runs with, when nothing
 * else names one: `npm install -g` with that Node puts the package under it.
 * The connector runs as a service without the person's shell PATH, so a
 * version manager's prefix (`~/.nvm/versions/node/<v>`) was never searched
 * (10-10: the owner's global install read "Not installed" on 0.12.18).
 */
function withRecordedNodePrefix(env: NodeJS.ProcessEnv, node: string | undefined): NodeJS.ProcessEnv {
  if (env.npm_config_prefix || !node || !isAbsolute(node)) return env;
  return { ...env, npm_config_prefix: dirname(dirname(node)) };
}

/** The person's own DeepSeek Harness. */
const dshInstallAdapter: HostAgentInstallAdapter = {
  agentId: "dsh",
  offered: true,
  locate: env => locateNativeDsh(env),
  // The recorded copy first. When it no longer verifies, the documented places
  // are searched again, as for OpenCode: an `npx` copy lives in npm's cache,
  // which npm may clear at any time (10-09: the recorded `_npx` copy vanished
  // and DeepSeek Harness read "Not installed" for good, even after the global
  // install its own message asked for). With nothing found the recorded
  // refusal stands.
  async runnerSettings(record) {
    const recorded = record.dshRoot;
    const env = withRecordedNodePrefix(process.env, record.dshNode);
    const dsh = recorded === undefined
      ? await resolveNativeDshInstallation(env)
      : await verifyNativeDshRoot(recorded).catch(async (error: unknown) => resolveNativeDshInstallation(env).catch(() => { throw error; }));
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
 * The person's own OpenCode 2: found,
 * version checked and recorded like dsh, and proven at runner start to run
 * with the locked Konteks configuration (`opencode debug agents`). Offered,
 * with its tool governance and sign-in:
 * installs, enrollment detection, `agent add opencode` and stored records
 * take it like DeepSeek Harness.
 */
export const openCodeInstallAdapter: HostAgentInstallAdapter = {
  agentId: "opencode",
  offered: true,
  locate: env => locateNativeOpenCode(env),
  // The recorded executable first. When it no longer verifies (the person
  // reinstalled OpenCode 2 another way, or replaced it), the documented
  // places are searched again, so a fix needs no `agent add`; with nothing
  // found the recorded refusal stands.
  async runnerSettings(record) {
    const recorded = record.opencodeBinary;
    const opencode = recorded === undefined
      ? await resolveNativeOpenCodeInstallation()
      : await verifyNativeOpenCodeBinary(recorded).catch(async (error: unknown) => resolveNativeOpenCodeInstallation().catch(() => { throw error; }));
    return { RUNNER_NATIVE_OPENCODE_BINARY: opencode.binary, RUNNER_BRIDGE_PREFIX: dirname(opencode.binary), RUNNER_BRIDGE_VERSION: opencode.version };
  },
  // A release that stops honouring the locked configuration never spawns.
  async selfCheck(config, deps = {}) {
    if (!config.RUNNER_NATIVE_OPENCODE_BINARY) {
      throw new RemoteInstanceError("prerequisite_missing", "OpenCode was not located on this machine.", { diagnostic: "opencode_not_found" });
    }
    await (deps.openCodeSelfCheck ?? checkOpenCodeKonteksConfig)({
      binary: config.RUNNER_NATIVE_OPENCODE_BINARY, version: config.RUNNER_BRIDGE_VERSION, credentialDir: config.RUNNER_CREDENTIAL_DIR,
    });
  },
};

/**
 * Google Antigravity: the first
 * FETCHED host agent. Nothing is located on the person's machine: `fetch`
 * downloads Google's pinned zip into `<root>/agents/antigravity/` on the
 * person's yes, `locate` and every load re-verify that copy against the
 * release's pin (sizes, sha256, Google's signature), and the start check
 * verifies it again, then proves its `initialize` (antigravity-self-check.ts).
 * Offered, with its governance and sign-in:
 * `install --agents …,antigravity` and `agent add antigravity` ask the
 * consent line and fetch, a stored record keeps it (and, after an update
 * carried a new pin, fetches that on the first yes). Never detected at
 * enrollment: it is fetched, not found.
 */
export const antigravityInstallAdapter: HostAgentInstallAdapter = {
  agentId: "antigravity",
  offered: true,
  consentText: ANTIGRAVITY_CONSENT_TEXT,
  assertFetchable: () => { antigravityPin(); },
  async locate(_env, context) {
    if (!context) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity is kept in the connector's own folder; its location was not given.", { diagnostic: "antigravity_not_fetched" });
    return locateNativeAntigravity(context.root);
  },
  async runnerSettings(record, context) {
    if (!context) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity is kept in the connector's own folder; its location was not given.", { diagnostic: "antigravity_not_fetched" });
    const installation = await verifyNativeAntigravityRecord(record, context.root);
    return { RUNNER_NATIVE_ANTIGRAVITY_ROOT: installation.root, RUNNER_BRIDGE_PREFIX: installation.root, RUNNER_BRIDGE_VERSION: installation.version };
  },
  fetch: request => fetchNativeAntigravity(request),
  // Integrity on every start, then one `initialize` in the private home
  // proves the server answers as the one Konteks governs.
  async selfCheck(config, deps = {}) {
    const folder = config.RUNNER_NATIVE_ANTIGRAVITY_ROOT;
    if (!folder) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity has not been downloaded to this computer.", { diagnostic: "antigravity_not_fetched" });
    // `<root>/agents/antigravity/<version>-<platform>` → `<root>`.
    const verified = await verifyNativeAntigravityFolder(dirname(dirname(dirname(folder))), deps.antigravity);
    if (verified.root !== folder) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity on this computer does not match Google's release.", { diagnostic: "antigravity_unsafe_install" });
    await (deps.antigravitySelfCheck ?? checkAntigravityServer)({ config });
  },
};

/** Every host-installed agent's install adapter, one per `HOST_AGENT_BRIDGES` family. */
export const HOST_AGENT_INSTALL_ADAPTERS: readonly HostAgentInstallAdapter[] = Object.freeze([dshInstallAdapter, openCodeInstallAdapter, antigravityInstallAdapter]);

/** The install adapter of a host-installed agent id, if any. */
export function hostAgentInstallAdapter(agentId: string): HostAgentInstallAdapter | undefined {
  return HOST_AGENT_INSTALL_ADAPTERS.find(adapter => adapter.agentId === agentId);
}

/** Whether an agent may be installed and run here: every bundled agent, and a host agent once offered. */
export function nativeAgentOffered(agentId: string): boolean {
  return hostAgentInstallAdapter(agentId)?.offered ?? true;
}
