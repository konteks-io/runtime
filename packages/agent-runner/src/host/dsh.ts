import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { keyedFingerprint, readOrCreateSecretFile, RemoteInstanceError } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { readDshApiKey, removeDshApiKey, startDshKeyLogin } from "../auth/dsh-key.js";
import { dshRuntimePaths, renderDshKonteksProfile, writeDshKonteksProfile } from "../bridge/dsh-profile.js";
import { dshControlReadPaths, prepareDshControlReadProfile, prepareDshReadProfile } from "../bridge/dsh-read-profile.js";
import { sweepDshDiscoverySessions } from "../bridge/dsh-session-sweep.js";
import type { HostAgentRunnerAdapter } from "./host-agent.js";

/** Same file as `FINGERPRINT_KEY_FILE` in auth/identity.ts (kept literal to avoid an import cycle). */
const FINGERPRINT_KEY_FILE = "fingerprint.key";

const safe = (path: string | undefined): path is string => path !== undefined && isAbsolute(path) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(path);

/** The located launcher and Node for a host-installed DeepSeek Harness runner; refuses anything else. */
function launcher(config: RunnerConfig, family: AgentBridgeFamily): { node: string; entry: string } {
  const node = config.RUNNER_NATIVE_DSH_NODE, entry = config.RUNNER_NATIVE_DSH_ENTRY;
  if (family.agentId !== "dsh" || family.hostInstall === undefined || config.RUNNER_AUTH_MODE !== "agent_local_subscription" || !safe(node) || !safe(entry) || !safe(config.RUNNER_NATIVE_DSH_ROOT)) {
    throw new RemoteInstanceError("agent_unavailable", "A DeepSeek Harness runner requires the person's installed DeepSeek Harness launcher and Node at absolute local paths.");
  }
  return { node, entry };
}

/**
 * The person's own DeepSeek Harness (dsh-runtime-support): launched as
 * `<their Node> <bin.dsh> --profile acp --patch …` with the Konteks overlay,
 * in a runtime-owned `DSH_HOME`; the API key is typed on the machine into the
 * runtime's own key prompt (dsh has no login command).
 */
export const dshRunnerAdapter: HostAgentRunnerAdapter = {
  agentId: "dsh",
  carriesSettings: config => config.RUNNER_NATIVE_DSH_ROOT !== undefined || config.RUNNER_NATIVE_DSH_ENTRY !== undefined || config.RUNNER_NATIVE_DSH_NODE !== undefined,
  assertRunner: (config, family) => { launcher(config, family); },
  launch(config, family) {
    const { node, entry } = launcher(config, family);
    const { patches } = renderDshKonteksProfile(dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR).konteksDir, process.platform);
    return { command: node, args: [entry, ...family.command, ...patches.flatMap(patch => ["--patch", patch]), "--patch", dshControlReadPaths(config.RUNNER_CREDENTIAL_DIR).patchPath] };
  },
  environment(config, family, generic) {
    const { node } = launcher(config, family);
    const env = { ...generic };
    // The person's own DeepSeek Harness, in a runtime-owned home: its key is
    // read from the credential document there, never from this environment.
    const { dshHome } = dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
    env.DSH_HOME = dshHome;
    env.DSH_PERMISSION_MODE = "workspace-write";
    delete env.DSH_BUNDLED_SKILL_DIR;
    env.DSH_TELEMETRY_DISABLED = "1";
    const separator = process.platform === "win32" ? ";" : ":";
    env.PATH = [dirname(node), generic.PATH ?? ""].join(separator);
    if (process.platform === "win32") {
      env.USERPROFILE = config.RUNNER_CREDENTIAL_DIR;
      env.APPDATA = join(config.RUNNER_CREDENTIAL_DIR, "AppData", "Roaming");
      env.LOCALAPPDATA = join(config.RUNNER_CREDENTIAL_DIR, "AppData", "Local");
    }
    const extraCa = process.env.NODE_EXTRA_CA_CERTS;
    if (extraCa) {
      if (!isAbsolute(extraCa) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(extraCa)) throw new RemoteInstanceError("agent_unavailable", "Native additional CA certificate path must be absolute.");
      env.NODE_EXTRA_CA_CERTS = extraCa;
    }
    return env;
  },
  // Every dsh process reads the overlay at boot, so a changed copy heals on
  // the next spawn instead of leaving it unguarded.
  prepareToSpawn: async config => {
    const { dshHome, konteksDir } = dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
    await writeDshKonteksProfile(konteksDir);
    await prepareDshControlReadProfile(config.RUNNER_CREDENTIAL_DIR);
    // Before dsh boots: the model checks' leftover sessions, which stop it booting once they pile up.
    await sweepDshDiscoverySessions(dshHome);
  },
  bindWorkingCopy: async (config, family, cwd, readOnlyRoots, environment) => {
    const { entry } = launcher(config, family);
    return prepareDshReadProfile({ credentialDir: config.RUNNER_CREDENTIAL_DIR, entry, command: family.command, cwd, readOnlyRoots, environment });
  },
  // dsh has no login command: the runtime asks for the API key itself, checks
  // it with DeepSeek and stores it in its dsh home.
  startLogin: ({ config, events, logger, loginId }) => startDshKeyLogin({ credentialsFile: dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR).credentialsFile, events, logger,
    ...(loginId === undefined ? {} : { loginId }) }),
  logout: async config => { await removeDshApiKey(dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR).credentialsFile); },
  loginFailedMessage: "the DeepSeek API key was not saved",
  async identity(config) {
    // The identity is the API key the runtime stored in its own dsh home
    // (dsh-key.ts). Only a hash of it is keyed here.
    const apiKey = await readDshApiKey(dshRuntimePaths(config.RUNNER_CREDENTIAL_DIR).credentialsFile);
    if (apiKey === null) return { kind: "logged_out" };
    const key = await readOrCreateSecretFile({ bytes: 32, dataDir: config.RUNNER_CREDENTIAL_DIR, encoding: "base64url", fileName: FINGERPRINT_KEY_FILE });
    return { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), `dsh\n${createHash("sha256").update(apiKey).digest("hex")}`) };
  },
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // dsh returns no usage with a turn; its usage_update is context occupancy,
  // not billing tokens (dsh-runtime-support D4).
  tokenUsageObservable: false,
};
