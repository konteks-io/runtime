import { isAbsolute, posix, win32 } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { HostAgentRunnerAdapter } from "./host-agent.js";

/**
 * The person's own OpenCode 2 (opencode-runtime-support). OpenCode signs in
 * from its environment (CP0: `auth list` showed "GitHub Copilot ·
 * GITHUB_TOKEN · environment"), so every execution of the binary by the
 * connector (sessions, `--version`, `debug`, `auth`) gets an environment built
 * from an ALLOW-LIST: nothing inherited but what is named below, never a
 * provider key, token or other credential variable, never an inherited
 * `OPENCODE_*`. What OpenCode keeps lives in a private home the connector owns.
 */

/** Inherited variables OpenCode may see (compared case-insensitively on Windows). */
export const OPENCODE_INHERITED_VARIABLES: readonly string[] = Object.freeze([
  "PATH",
  // Locale and time zone.
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY", "TZ",
  // Temporary files.
  "TMPDIR", "TEMP", "TMP",
  // The person's network: proxies and extra CA trust (a path).
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "NODE_EXTRA_CA_CERTS",
]);

/** Windows system variables a native program needs to start and reach the network; none carries a credential. */
const WINDOWS_SYSTEM_VARIABLES: readonly string[] = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"];

/** A name that looks like it carries a credential is never passed, whatever put it there. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE/i;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** Where an OpenCode runner keeps its private state, all inside its credential directory. */
export interface OpenCodeRuntimePaths {
  /** `<credentials>/opencode`. */
  root: string;
  /** HOME (and USERPROFILE on Windows). */
  home: string;
  /** XDG_DATA_HOME: sign-ins and sessions, shared by every OpenCode process of this connector. */
  data: string;
  state: string;
  cache: string;
  /** Parent of the per-working-copy XDG_CONFIG_HOME folders (CP2). */
  configs: string;
  /** XDG_CONFIG_HOME of the control process (discovery, sign-in), which has no working copy. */
  controlConfig: string;
}

export function openCodeRuntimePaths(credentialDir: string, platform: NodeJS.Platform = process.platform): OpenCodeRuntimePaths {
  const path = platform === "win32" ? win32 : posix;
  const root = path.join(credentialDir, "opencode");
  const configs = path.join(root, "config");
  return { root, home: path.join(root, "home"), data: path.join(root, "data"), state: path.join(root, "state"), cache: path.join(root, "cache"), configs, controlConfig: path.join(configs, "control") };
}

export interface OpenCodeEnvironmentOptions {
  /** The private home: HOME and the XDG folders (all absolute). */
  home: { home: string; data: string; state: string; cache: string; config: string };
  /** Konteks' own `OPENCODE_*` settings (never inherited ones). */
  settings?: Readonly<Record<string, string>>;
  /** Where the allow-listed variables are read from (default: this process). */
  inherited?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * The complete environment of an OpenCode process: the allow-listed inherited
 * variables, the private home, our own `OPENCODE_*` settings, and nothing else.
 */
export function openCodeEnvironment(options: OpenCodeEnvironmentOptions): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const inherited = options.inherited ?? process.env;
  const windows = platform === "win32";
  const allowed = new Set([...OPENCODE_INHERITED_VARIABLES, ...(windows ? WINDOWS_SYSTEM_VARIABLES : [])].map(name => (windows ? name.toUpperCase() : name)));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || !allowed.has(windows ? name.toUpperCase() : name) || value.includes("\u0000")) continue;
    env[name] = value;
  }
  // A shell for OpenCode's own shell tool: a path, only when absolute.
  if (inherited.SHELL && isAbsolute(inherited.SHELL) && !CONTROL.test(inherited.SHELL)) env.SHELL = inherited.SHELL;
  const extraCa = env.NODE_EXTRA_CA_CERTS;
  if (extraCa !== undefined && (!isAbsolute(extraCa) || CONTROL.test(extraCa))) throw new RemoteInstanceError("agent_unavailable", "Native additional CA certificate path must be absolute.");
  const { home, data, state, cache, config } = options.home;
  for (const path of [home, data, state, cache, config]) {
    if (!isAbsolute(path) || CONTROL.test(path)) throw new RemoteInstanceError("agent_unavailable", "The OpenCode home must be an absolute local path.");
  }
  env.HOME = home;
  env.XDG_DATA_HOME = data;
  env.XDG_STATE_HOME = state;
  env.XDG_CACHE_HOME = cache;
  env.XDG_CONFIG_HOME = config;
  if (windows) {
    env.USERPROFILE = home;
    env.APPDATA = win32.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = win32.join(home, "AppData", "Local");
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  for (const [name, value] of Object.entries(options.settings ?? {})) {
    if (!/^OPENCODE_[A-Z0-9_]+$/.test(name) || value.includes("\u0000")) throw new RemoteInstanceError("agent_unavailable", `not an OpenCode setting: ${name}`);
    env[name] = value;
  }
  // Last line of defence: the allow-list above can never be widened into a credential.
  for (const name of Object.keys(env)) {
    if (CREDENTIAL_NAME.test(name)) delete env[name];
  }
  return env;
}

/** The environment for one short OpenCode command (`--version`) run in a throwaway private home. */
export function openCodeScratchEnvironment(scratchDir: string, inherited: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const paths = openCodeRuntimePaths(scratchDir, platform);
  return openCodeEnvironment({ home: { home: paths.home, data: paths.data, state: paths.state, cache: paths.cache, config: paths.controlConfig }, inherited, platform });
}

function notYet(): RemoteInstanceError {
  // Spawning waits for the locked configuration and its self-check (CP2), and
  // offering it for its security checkpoint (CP4): fail closed until then.
  return new RemoteInstanceError("agent_unavailable", "OpenCode cannot run Konteks work on this computer yet.");
}

/** The located OpenCode binary of an OpenCode runner; refuses anything else. */
function binary(config: RunnerConfig, family: AgentBridgeFamily): string {
  const located = config.RUNNER_NATIVE_OPENCODE_BINARY;
  if (family.agentId !== "opencode" || family.hostInstall?.launch !== "binary" || config.RUNNER_AUTH_MODE !== "agent_local_subscription"
      || located === undefined || !isAbsolute(located) || CONTROL.test(located)) {
    throw new RemoteInstanceError("agent_unavailable", "An OpenCode runner requires the person's installed OpenCode 2 at an absolute local path.");
  }
  return located;
}

/**
 * OpenCode 2, launched as `<binary> acp` (no Node) with the allow-list
 * environment and a private home. CP1 registers and detects it only: every
 * spawn and sign-in refuses until CP2/CP3, so nothing ungoverned ever runs.
 */
export const openCodeRunnerAdapter: HostAgentRunnerAdapter = {
  agentId: "opencode",
  carriesSettings: config => config.RUNNER_NATIVE_OPENCODE_BINARY !== undefined,
  assertRunner: (config, family) => { binary(config, family); },
  launch: (config, family) => ({ command: binary(config, family), args: [...family.command] }),
  environment(config, family) {
    binary(config, family);
    const paths = openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
    return openCodeEnvironment({ home: { home: paths.home, data: paths.data, state: paths.state, cache: paths.cache, config: paths.controlConfig } });
  },
  prepareToSpawn: async () => { throw notYet(); },
  startLogin: () => { throw notYet(); },
  logout: async () => { throw notYet(); },
  loginFailedMessage: "OpenCode did not finish signing in",
  identity: async () => ({ kind: "logged_out" }),
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // OpenCode returns usage with each prompt response (CP0-v2).
  tokenUsageObservable: true,
};
