import { isAbsolute, posix, win32 } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { fetchedAgentPlatformPin, type AgentBridgeFamily, type FetchedAgentPlatformPin } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { HostAgentRunnerAdapter } from "./host-agent.js";
import { allowListEnvironment } from "./allow-list-environment.js";

/**
 * Google Antigravity (antigravity-runtime-support): Google's own
 * `antigravity-acp` server, fetched by the connector (A2) and run from its own
 * folder. Everything the server gets reaches its `run_command` tool (CP0: a
 * planted `GITHUB_TOKEN` did), and it signs in from its environment unless
 * told otherwise, so every execution of it by the connector gets an
 * ALLOW-LIST environment (A5): nothing inherited but PATH, locale, temporary
 * folders, proxies and extra CA trust; a private `HOME` and `GEMINI_HOME` the
 * connector owns; `AGY_ACP_FORCE_FILE_STORAGE=1` so it never touches the
 * macOS keychain service `gemini`; and never `GEMINI_*`, `GOOGLE_*`,
 * `CLOUDSDK_*`, `AGY_*`, `ANTIGRAVITY_*`, `GITHUB_TOKEN`/`GH_TOKEN` or any
 * provider key. The person's `~/.gemini`, `~/.antigravity` and the
 * Antigravity app are never read or written.
 */

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** Where an Antigravity runner keeps its private state, all inside its credential directory. */
export interface AntigravityRuntimePaths {
  /** `<credentials>/antigravity`. */
  root: string;
  /** HOME (and USERPROFILE on Windows) of every Antigravity process. */
  home: string;
  /** GEMINI_HOME: everything the server reads or writes (`antigravity-acp/`, `config/`, …). */
  geminiHome: string;
  /** `<GEMINI_HOME>/antigravity-acp/settings.json`: the sign-in method (and Gemini Enterprise's project), written by the connector (CP2/CP3). */
  settingsFile: string;
  /** `<GEMINI_HOME>/antigravity-acp/trusted_workspaces.json`: removed before each spawn (nothing trusted, CP2). */
  trustFile: string;
  /** Where the connector keeps an API key: outside the agent's home, never in its environment (CP3). */
  relay: string;
}

export function antigravityRuntimePaths(credentialDir: string, platform: NodeJS.Platform = process.platform): AntigravityRuntimePaths {
  const path = platform === "win32" ? win32 : posix;
  const root = path.join(credentialDir, "antigravity");
  const home = path.join(root, "home");
  const geminiHome = path.join(home, ".gemini");
  return {
    root, home, geminiHome,
    settingsFile: path.join(geminiHome, "antigravity-acp", "settings.json"),
    trustFile: path.join(geminiHome, "antigravity-acp", "trusted_workspaces.json"),
    relay: path.join(root, "relay"),
  };
}

/** The only settings the connector gives the server; any other `AGY_*`, `GEMINI_*` or `GOOGLE_*` name is refused. */
export const ANTIGRAVITY_SETTING_NAMES: readonly string[] = Object.freeze(["AGY_ACP_FORCE_FILE_STORAGE", "GOOGLE_GEMINI_BASE_URL"]);

export interface AntigravityEnvironmentOptions {
  /** The private home and the GEMINI_HOME inside it (both absolute). */
  home: { home: string; geminiHome: string };
  /**
   * API-key sign-in only (A7, CP3): the connector's loopback relay, which
   * the server reaches through `GOOGLE_GEMINI_BASE_URL`. Never the key.
   */
  relayBaseUrl?: string;
  /** Where the allow-listed variables are read from (default: this process). */
  inherited?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * The complete environment of an Antigravity process: the host-agent
 * allow-list, the private home, `GEMINI_HOME`, forced file storage for its
 * tokens, the relay's loopback address when there is one, and nothing else.
 */
export function antigravityEnvironment(options: AntigravityEnvironmentOptions): NodeJS.ProcessEnv {
  const settings: Record<string, string> = { AGY_ACP_FORCE_FILE_STORAGE: "1" };
  if (options.relayBaseUrl !== undefined) settings.GOOGLE_GEMINI_BASE_URL = loopbackRelayUrl(options.relayBaseUrl);
  return allowListEnvironment({
    agentName: "Google Antigravity",
    paths: { HOME: options.home.home, GEMINI_HOME: options.home.geminiHome },
    windowsProfile: options.home.home,
    settings,
    settingName: new RegExp(`^(?:${ANTIGRAVITY_SETTING_NAMES.join("|")})$`),
    ...(options.inherited === undefined ? {} : { inherited: options.inherited }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
}

/** The environment of every Antigravity process of the runner whose credential directory is `credentialDir`. */
export function antigravityProcessEnvironment(credentialDir: string, options: { relayBaseUrl?: string; inherited?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): NodeJS.ProcessEnv {
  const paths = antigravityRuntimePaths(credentialDir, options.platform);
  return antigravityEnvironment({ home: { home: paths.home, geminiHome: paths.geminiHome }, ...options });
}

/** Only `http://127.0.0.1:<port>` (the relay listens on loopback and nowhere else). */
function loopbackRelayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw relayRefused(); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw relayRefused();
  return `http://127.0.0.1:${url.port}`;
}
function relayRefused() { return new RemoteInstanceError("agent_unavailable", "The Google Antigravity relay must listen on 127.0.0.1."); }

function notYet(): RemoteInstanceError {
  // Spawning waits for the private home, the tool filter and the start
  // self-check (CP2), sign-in for CP3, and offering it for its security
  // checkpoint (CP4): fail closed until then.
  return new RemoteInstanceError("agent_unavailable", "Google Antigravity cannot run Konteks work on this computer yet.");
}

/** The verified fetched folder of an Antigravity runner and this platform's pin; refuses anything else. */
function fetched(config: RunnerConfig, family: AgentBridgeFamily): { root: string; pin: FetchedAgentPlatformPin } {
  const root = config.RUNNER_NATIVE_ANTIGRAVITY_ROOT;
  if (family.agentId !== "antigravity" || family.hostInstall?.launch !== "fetched" || config.RUNNER_AUTH_MODE !== "agent_local_subscription"
      || root === undefined || !isAbsolute(root) || CONTROL.test(root)) {
    throw new RemoteInstanceError("agent_unavailable", "A Google Antigravity runner requires the copy the connector fetched, at an absolute local path.");
  }
  const pin = fetchedAgentPlatformPin("antigravity");
  if (!pin) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity is not available for this computer yet.");
  return { root, pin };
}

/**
 * Google's Antigravity ACP server, launched as `<fetched folder>/<pinned
 * command> <pinned args>` with the allow-list environment and a private
 * home. CP1 registers it and fetches it only: every spawn and sign-in refuses
 * until CP2/CP3, so nothing ungoverned ever runs. Not offered until CP4
 * (`antigravityInstallAdapter.offered` in the supervisor).
 */
export const antigravityRunnerAdapter: HostAgentRunnerAdapter = {
  agentId: "antigravity",
  carriesSettings: config => config.RUNNER_NATIVE_ANTIGRAVITY_ROOT !== undefined,
  assertRunner: (config, family) => { fetched(config, family); },
  launch(config, family) {
    const { root, pin } = fetched(config, family);
    const path = win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
    return { command: path.join(root, ...pin.command.split("/")), args: [...pin.args] };
  },
  environment(config, family) {
    fetched(config, family);
    return antigravityProcessEnvironment(config.RUNNER_CREDENTIAL_DIR);
  },
  prepareToSpawn: async () => { throw notYet(); },
  startLogin: () => { throw notYet(); },
  logout: async () => { throw notYet(); },
  loginFailedMessage: "Google Antigravity did not finish signing in",
  identity: async () => ({ kind: "logged_out" }),
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // The server reports no usage (CP0 B11); the relay counts tokens for an
  // API key from CP3 on, and Gemini Enterprise is a subscription (A7, A8).
  tokenUsageObservable: false,
};
