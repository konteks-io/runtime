import { isAbsolute, win32 } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * The environment of a host agent that must never see the person's
 * credentials (OpenCode, Google Antigravity): built from an ALLOW-LIST, not
 * by removing names. Nothing is inherited but the variables named here; the
 * agent's private home and its own settings are added by the connector; a
 * final pass drops any name that looks like a credential, whatever put it
 * there. Every execution of such an agent (sessions, `--version`, sign-in)
 * gets it.
 */

/** Inherited variables a host agent may see (compared case-insensitively on Windows). */
export const HOST_INHERITED_VARIABLES: readonly string[] = Object.freeze([
  "PATH",
  // Locale and time zone.
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY", "TZ",
  // Temporary files.
  "TMPDIR", "TEMP", "TMP",
  // The person's network: proxies and extra CA trust (a path).
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "NODE_EXTRA_CA_CERTS",
]);

/** Windows system variables a native program needs to start and reach the network; none carries a credential. */
export const WINDOWS_SYSTEM_VARIABLES: readonly string[] = Object.freeze(["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"]);

/** A name that looks like it carries a credential is never passed, whatever put it there. */
export const CREDENTIAL_VARIABLE_NAME = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE/i;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export interface AllowListEnvironmentOptions {
  /** The agent's name in refusals ("OpenCode", "Google Antigravity"). */
  agentName: string;
  /** Private-home variables (HOME, XDG_*, GEMINI_HOME …): each an absolute path the connector owns. */
  paths: Readonly<Record<string, string>>;
  /** Windows only: USERPROFILE, and APPDATA/LOCALAPPDATA inside it (the private home). */
  windowsProfile?: string;
  /** The agent's own settings, set by the connector (never inherited ones). */
  settings?: Readonly<Record<string, string>>;
  /** Which names count as this agent's settings; any other name is refused. */
  settingName: RegExp;
  /** Where the allow-listed variables are read from (default: this process). */
  inherited?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * The complete environment of a host-agent process: the allow-listed
 * inherited variables, an absolute `SHELL`, the private home, `NO_COLOR` and
 * `TERM=dumb`, the agent's own settings, and nothing else.
 */
export function allowListEnvironment(options: AllowListEnvironmentOptions): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const inherited = options.inherited ?? process.env;
  const windows = platform === "win32";
  const allowed = new Set([...HOST_INHERITED_VARIABLES, ...(windows ? WINDOWS_SYSTEM_VARIABLES : [])].map(name => (windows ? name.toUpperCase() : name)));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || !allowed.has(windows ? name.toUpperCase() : name) || value.includes("\u0000")) continue;
    env[name] = value;
  }
  // A shell for the agent's own shell tool: a path, only when absolute.
  if (inherited.SHELL && isAbsolute(inherited.SHELL) && !CONTROL.test(inherited.SHELL)) env.SHELL = inherited.SHELL;
  const extraCa = env.NODE_EXTRA_CA_CERTS;
  if (extraCa !== undefined && (!isAbsolute(extraCa) || CONTROL.test(extraCa))) throw new RemoteInstanceError("agent_unavailable", "Native additional CA certificate path must be absolute.");
  const homes = [...Object.values(options.paths), ...(options.windowsProfile === undefined ? [] : [options.windowsProfile])];
  for (const path of homes) {
    if (!isAbsolute(path) || CONTROL.test(path)) throw new RemoteInstanceError("agent_unavailable", `The ${options.agentName} home must be an absolute local path.`);
  }
  for (const [name, path] of Object.entries(options.paths)) env[name] = path;
  if (windows && options.windowsProfile !== undefined) {
    env.USERPROFILE = options.windowsProfile;
    env.APPDATA = win32.join(options.windowsProfile, "AppData", "Roaming");
    env.LOCALAPPDATA = win32.join(options.windowsProfile, "AppData", "Local");
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  for (const [name, value] of Object.entries(options.settings ?? {})) {
    if (!options.settingName.test(name) || value.includes("\u0000")) throw new RemoteInstanceError("agent_unavailable", `not ${/^[aeiou]/i.test(options.agentName) ? "an" : "a"} ${options.agentName} setting: ${name}`);
    env[name] = value;
  }
  // Last line of defence: the allow-list above can never be widened into a credential.
  for (const name of Object.keys(env)) {
    if (CREDENTIAL_VARIABLE_NAME.test(name)) delete env[name];
  }
  return env;
}
