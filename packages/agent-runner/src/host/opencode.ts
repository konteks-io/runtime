import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { HostAgentRunnerAdapter, HostWorkingCopyBinding } from "./host-agent.js";

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

/** One OpenCode 2 permission rule (its native `permissions` shape). */
export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "ask" | "deny";
}

/**
 * The Konteks permission rules, in order. OpenCode applies the LAST matching
 * rule and puts its own defaults before ours (CP0-v2, verified with `opencode
 * debug agents`), so the leading `* ask` overrides every default, and the
 * `.env` rows are restated after our `read` allow, which would otherwise
 * re-open them. `external_directory` and the built-in browser are denied
 * outright (no request reaches Konteks). The start self-check asserts these
 * rows end every agent's resolved list.
 */
export const OPENCODE_KONTEKS_PERMISSIONS: readonly OpenCodePermissionRule[] = Object.freeze([
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "todowrite", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
  // Code Mode's catalogue carries a built-in browser (`tools.browser.*`) that
  // reaches any site; a deny removes it from the catalogue (CP0 part 2).
  { action: "browser.*", resource: "*", effect: "deny" },
].map(rule => Object.freeze(rule as OpenCodePermissionRule)));

/** Agents the Konteks configuration switches off (`plan` runs shell unasked; `title` spends a model call per session). */
export const OPENCODE_DISABLED_AGENTS: readonly string[] = Object.freeze(["title", "plan"]);

/**
 * The locked Konteks configuration every OpenCode process boots with
 * (opencode-runtime-support, "The Konteks OpenCode configuration"), in
 * OpenCode 2's own key names. It is passed as `OPENCODE_CONFIG_CONTENT` and
 * never read from the person's home or the repository.
 */
export function renderOpenCodeKonteksConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    permissions: OPENCODE_KONTEKS_PERMISSIONS.map(rule => ({ ...rule })),
    share: "disabled",
    update: "disable",
    snapshots: false,
    lsp: false,
    formatter: false,
    plugins: [],
    agents: Object.fromEntries(OPENCODE_DISABLED_AGENTS.map(agent => [agent, { disabled: true }])),
  };
}

/**
 * Konteks' own `OPENCODE_*` settings for every OpenCode process: the locked
 * configuration, the repository's own config switched off (a repo
 * `opencode.json` or `.opencode/agent` re-allowed everything in CP0), and no
 * file watcher (it otherwise watches every parent folder up to `/`).
 */
export function openCodeKonteksSettings(): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(renderOpenCodeKonteksConfig()),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
  };
}

/** The complete environment of an OpenCode process of this runner whose config folder is `configHome`. */
export function openCodeProcessEnvironment(credentialDir: string, configHome: string, inherited?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const paths = openCodeRuntimePaths(credentialDir, platform);
  return openCodeEnvironment({ home: { home: paths.home, data: paths.data, state: paths.state, cache: paths.cache, config: configHome },
    settings: openCodeKonteksSettings(), platform, ...(inherited === undefined ? {} : { inherited }) });
}

/**
 * The decision OpenCode reaches for `action` on `resource` under `rules`: the
 * last matching rule wins; `*` matches any run of characters and `?` one.
 * Used to prove the resolved rules, never to answer a request.
 */
export function openCodePermissionDecision(rules: readonly OpenCodePermissionRule[], action: string, resource: string): OpenCodePermissionRule["effect"] | undefined {
  let decision: OpenCodePermissionRule["effect"] | undefined;
  for (const rule of rules) if (wildcard(rule.action, action) && wildcard(rule.resource, resource)) decision = rule.effect;
  return decision;
}

function wildcard(pattern: string, value: string): boolean {
  const source = pattern.split("").map(char => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$+.()|[\]{}]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`, "s").test(value);
}

/** The key of a working copy's config folder: a hash of its absolute path. */
export function openCodeWorkingCopyKey(workingCopy: string): string {
  return createHash("sha256").update(resolve(workingCopy)).digest("hex").slice(0, 16);
}

/** `XDG_CONFIG_HOME` of the OpenCode process serving `workingCopy`. */
export function openCodeWorkingCopyConfig(credentialDir: string, workingCopy: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(openCodeRuntimePaths(credentialDir, platform).configs, openCodeWorkingCopyKey(workingCopy));
}

/** How a config folder carries the working copy's `AGENTS.md`. */
export type OpenCodeInstructions = "link" | "copy" | "none";

export interface OpenCodeInstructionsDeps {
  /** Replaced only in tests (a Windows account without the symlink privilege). */
  symlink?: typeof symlink;
}

/**
 * OpenCode loads a repository's `AGENTS.md` only while project config is on,
 * which the lock switches off, but always loads the `AGENTS.md` in its own
 * config folder (CP0-v2 row 6). So each working copy's process gets a config
 * folder whose `opencode/AGENTS.md` is a symlink to the working copy's, or a
 * copy where symlinks are not allowed (Windows without the privilege). Only a
 * regular file inside the working copy is ever linked, so a repository cannot
 * point it at a file elsewhere on the machine; otherwise there is none.
 * Idempotent: called before spawn and again before every prompt.
 */
export async function syncOpenCodeInstructions(configHome: string, workingCopy: string, deps: OpenCodeInstructionsDeps = {}): Promise<OpenCodeInstructions> {
  const folder = posixOrWin(configHome).join(configHome, "opencode");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = posixOrWin(configHome).join(folder, "AGENTS.md");
  const source = await instructionsInside(workingCopy);
  const current = await lstat(target).catch(() => null);
  if (source === null) {
    if (current) await rm(target, { recursive: true, force: true });
    return "none";
  }
  if (current?.isSymbolicLink() && await readlink(target).catch(() => null) === source) return "link";
  if (current) await rm(target, { recursive: true, force: true });
  try {
    await (deps.symlink ?? symlink)(source, target, "file");
    return "link";
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EINVAL", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await copyFile(source, target);
    return "copy";
  }
}

/** The real path of `<workingCopy>/AGENTS.md` when it is a regular file inside the working copy; else null. */
async function instructionsInside(workingCopy: string): Promise<string | null> {
  try {
    const root = await realpath(workingCopy);
    const file = await realpath(posixOrWin(workingCopy).join(workingCopy, "AGENTS.md"));
    const inside = relative(root, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

function posixOrWin(path: string): typeof posix {
  return win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix;
}

/**
 * Processes of one runner per config folder: the folder (and its link) is
 * created before the first process of a working copy spawns and removed once
 * the last one is gone. Operations on one folder run one at a time.
 */
const workingCopyHolds = new Map<string, { count: number; queue: Promise<unknown> }>();

function serial<T>(configHome: string, work: (hold: { count: number }) => Promise<T>): Promise<T> {
  let hold = workingCopyHolds.get(configHome);
  if (!hold) workingCopyHolds.set(configHome, hold = { count: 0, queue: Promise.resolve() });
  const entry = hold;
  const run = entry.queue.then(() => work(entry));
  entry.queue = run.catch(() => undefined).then(() => {
    if (entry.count === 0 && workingCopyHolds.get(configHome) === entry) workingCopyHolds.delete(configHome);
  });
  return run;
}

/** Prepare the config folder of one OpenCode execution process for `workingCopy`. */
export async function bindOpenCodeWorkingCopy(credentialDir: string, workingCopy: string, deps: OpenCodeInstructionsDeps & { inherited?: NodeJS.ProcessEnv } = {}): Promise<HostWorkingCopyBinding> {
  if (!isAbsolute(workingCopy) || CONTROL.test(workingCopy)) throw new RemoteInstanceError("agent_unavailable", "An OpenCode working copy must be an absolute local path.");
  const configHome = openCodeWorkingCopyConfig(credentialDir, workingCopy);
  const env = openCodeProcessEnvironment(credentialDir, configHome, deps.inherited);
  await serial(configHome, async hold => {
    hold.count += 1;
    try { await syncOpenCodeInstructions(configHome, workingCopy, deps); }
    catch (error) { hold.count -= 1; throw error; }
  });
  let released = false;
  return {
    env,
    beforePrompt: () => serial(configHome, async () => { if (!released) await syncOpenCodeInstructions(configHome, workingCopy, deps); }),
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      return serial(configHome, async hold => {
        hold.count -= 1;
        if (hold.count === 0) await rm(configHome, { recursive: true, force: true });
      });
    },
  };
}

function notYet(): RemoteInstanceError {
  // Sign-in and sign-out arrive in CP3; fail closed until then.
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
 * environment, the locked Konteks configuration and a private home shared by
 * every OpenCode process of this runner (sign-ins and sessions). The control
 * process (discovery, sign-in) uses a config folder with no instructions;
 * each execution process gets its working copy's own (`bindWorkingCopy`).
 * Offering it to anyone is gated on the install side until CP4
 * (`openCodeInstallAdapter.offered`); sign-in and sign-out arrive in CP3.
 */
export const openCodeRunnerAdapter: HostAgentRunnerAdapter = {
  agentId: "opencode",
  carriesSettings: config => config.RUNNER_NATIVE_OPENCODE_BINARY !== undefined,
  assertRunner: (config, family) => { binary(config, family); },
  launch: (config, family) => ({ command: binary(config, family), args: [...family.command] }),
  environment(config, family) {
    binary(config, family);
    return openCodeProcessEnvironment(config.RUNNER_CREDENTIAL_DIR, openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR).controlConfig);
  },
  async prepareToSpawn(config) {
    const located = config.RUNNER_NATIVE_OPENCODE_BINARY;
    if (located === undefined || !isAbsolute(located) || CONTROL.test(located)) {
      throw new RemoteInstanceError("agent_unavailable", "An OpenCode runner requires the person's installed OpenCode 2 at an absolute local path.");
    }
    const paths = openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
    for (const folder of [paths.home, paths.data, paths.state, paths.cache, paths.configs, paths.controlConfig]) await mkdir(folder, { recursive: true, mode: 0o700 });
    // The control process never carries a working copy's instructions.
    await rm((process.platform === "win32" ? win32 : posix).join(paths.controlConfig, "opencode", "AGENTS.md"), { recursive: true, force: true });
  },
  bindWorkingCopy: async (config, family, workingCopy) => {
    binary(config, family);
    return bindOpenCodeWorkingCopy(config.RUNNER_CREDENTIAL_DIR, workingCopy);
  },
  startLogin: () => { throw notYet(); },
  logout: async () => { throw notYet(); },
  loginFailedMessage: "OpenCode did not finish signing in",
  identity: async () => ({ kind: "logged_out" }),
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // OpenCode returns usage with each prompt response (CP0-v2).
  tokenUsageObservable: true,
  // ACP still offers `plan` with the plan agent switched off, accepts it, and
  // a prompt in that mode hangs (CP2); plan mode also runs shell unasked.
  refusedSessionModes: { modeIds: ["plan"], message: "OpenCode's plan mode is not available on Konteks." },
};
