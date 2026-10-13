import { openCodeSkillSources } from "./opencode-skill-sources.js";
import { createOpenCodeActivation } from "./opencode-activation.js";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import { OpenCodeLoginOptionIdSchema, RemoteInstanceError, keyedFingerprint, readOrCreateSecretFile } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import type { HostAgentRunnerAdapter, HostLoginRequest, HostWorkingCopyBinding } from "./host-agent.js";
import { allowListEnvironment } from "./allow-list-environment.js";
import { instructionsInside } from "./working-copy-instructions.js";
import {
  isOpenCodeFreeModel,
  listOpenCodeCredentials,
  listOpenCodeIntegrations,
  openCodeCredentialViews,
  openCodeIdentityMaterial,
  openCodeLogout,
  openCodeSiteLoginOptions,
  personalOpenCodeHome,
  startOpenCodeLogin,
  type OpenCodeCommandContext,
  type OpenCodeLoginRequest,
} from "../auth/opencode-auth.js";

/** Same file as `FINGERPRINT_KEY_FILE` in auth/identity.ts (kept literal to avoid an import cycle). */
const FINGERPRINT_KEY_FILE = "fingerprint.key";

/**
 * The person's own OpenCode 2 (opencode-runtime-support). OpenCode signs in
 * from its environment (`auth list` showed "GitHub Copilot ·
 * GITHUB_TOKEN · environment"), so every execution of the binary by the
 * connector (sessions, `--version`, `debug`, `auth`) gets an environment built
 * from an ALLOW-LIST: nothing inherited but what is named below, never a
 * provider key, token or other credential variable, never an inherited
 * `OPENCODE_*`. What OpenCode keeps lives in a private home the connector owns.
 */

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
  /** Parent of the per-working-copy XDG_CONFIG_HOME folders. */
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

interface OpenCodeEnvironmentOptions {
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
  const { home, data, state, cache, config } = options.home;
  return allowListEnvironment({
    agentName: "OpenCode",
    paths: { HOME: home, XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: config },
    windowsProfile: home,
    settingName: /^OPENCODE_[A-Z0-9_]+$/,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.inherited === undefined ? {} : { inherited: options.inherited }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
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
 * rule and puts its own defaults before ours (verified with `opencode
 * debug agents`), so the leading `* ask` overrides every default, and the
 * named file reads and searches all ask before the session judges their
 * paths. `external_directory`, Code Mode's built-in browser and
 * OpenCode's own Code Mode tools are denied outright (no request reaches
 * Konteks). The start self-check asserts these rows end every agent's
 * resolved list, followed by nothing but OpenCode's own denies (2.0.21
 * appends `browser * deny` after the configuration).
 */
export const OPENCODE_KONTEKS_PERMISSIONS: readonly OpenCodePermissionRule[] = Object.freeze([
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "ask" },
  { action: "list", resource: "*", effect: "ask" },
  { action: "glob", resource: "*", effect: "ask" },
  { action: "grep", resource: "*", effect: "ask" },
  { action: "todowrite", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
  // Code Mode's catalogue (`execute`) also holds tools that run WITHOUT any
  // permission request: the built-in browser (`tools.browser.*`, permission
  // `browser`) and OpenCode's own (`tools.opencode.session_move`, which moves
  // the session to another folder, `session_rename`, `models`, the MCP
  // resource readers; permission `opencode_<tool>`). A deny drops a tool from
  // the catalogue (live on 2.0.18: `browser.*` and `opencode.*` do not).
  { action: "browser", resource: "*", effect: "deny" },
  { action: "opencode_*", resource: "*", effect: "deny" },
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
 * `opencode.json` or `.opencode/agent` would otherwise re-allow everything), and no
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

/** `XDG_CONFIG_HOME` bound to the working copy and its authorized immutable Skill roots. */
export function openCodeWorkingCopyConfig(credentialDir: string, workingCopy: string, platform: NodeJS.Platform = process.platform, readOnlyRoots: readonly string[] = []): string {
  const path = platform === "win32" ? win32 : posix;
  const key = openCodeWorkingCopyKey(workingCopy);
  if (!readOnlyRoots.length) return path.join(openCodeRuntimePaths(credentialDir, platform).configs, key);
  const roots = normalizedSkillRoots(readOnlyRoots, path);
  const digest = createHash("sha256").update(JSON.stringify(roots)).digest("hex");
  return path.join(openCodeRuntimePaths(credentialDir, platform).configs, `${key}-skills-${digest}`);
}
function normalizedSkillRoots(roots: readonly string[], path: typeof posix): string[] {
  if (roots.some(root => !path.isAbsolute(root) || CONTROL.test(root))) throw new RemoteInstanceError("agent_unavailable", "OpenCode Skill roots must be absolute local paths.");
  return [...new Set(roots.map(root => path.normalize(root)))].sort();
}

/** How a config folder carries the working copy's `AGENTS.md`. */
type OpenCodeInstructions = "link" | "copy" | "none";

interface OpenCodeInstructionsDeps {
  /** Replaced only in tests (a Windows account without the symlink privilege). */
  symlink?: typeof symlink;
}

/**
 * OpenCode loads a repository's `AGENTS.md` only while project config is on,
 * which the lock switches off, but always loads the `AGENTS.md` in its own
 * config folder. So each working copy's process gets a config
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
  if (source !== null && await linksTo(target, current, source)) return "link";
  if (current) await rm(target, { recursive: true, force: true });
  if (source === null) return "none";
  return linkOrCopy(source, target, deps.symlink ?? symlink);
}

async function linksTo(target: string, current: Stats | null, source: string): Promise<boolean> {
  return current !== null && current.isSymbolicLink() && await readlink(target).catch(() => null) === source;
}

/** Codes of a symlink the account may not make (Windows without the privilege): the file is copied instead. */
const SYMLINK_REFUSED = ["EPERM", "EACCES", "ENOTSUP", "EINVAL", "UNKNOWN"];

async function linkOrCopy(source: string, target: string, link: typeof symlink): Promise<OpenCodeInstructions> {
  try {
    await link(source, target, "file");
    return "link";
  } catch (error) {
    if (!SYMLINK_REFUSED.includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await copyFile(source, target);
    return "copy";
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

/** Prepare one OpenCode execution profile, isolated by working copy and authorized Skill roots. */
export async function bindOpenCodeWorkingCopy(credentialDir: string, workingCopy: string, deps: OpenCodeInstructionsDeps & { inherited?: NodeJS.ProcessEnv } = {}, readOnlyRoots: readonly string[] = []): Promise<HostWorkingCopyBinding> {
  if (!isAbsolute(workingCopy) || CONTROL.test(workingCopy)) throw new RemoteInstanceError("agent_unavailable", "An OpenCode working copy must be an absolute local path.");
  const skillRoots = Object.freeze([...readOnlyRoots]);
  const configHome = openCodeWorkingCopyConfig(credentialDir, workingCopy, process.platform, skillRoots);
  const sources = await openCodeSkillSources(skillRoots);
  const activation = skillRoots.length ? await createOpenCodeActivation(configHome, skillRoots) : undefined;
  const env = openCodeProcessEnvironment(credentialDir, configHome, deps.inherited);
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...renderOpenCodeKonteksConfig(), skills: sources, ...(activation ? { plugins: [activation.plugin] } : {}) });
  await serial(configHome, async hold => {
    hold.count += 1;
    try { await syncOpenCodeInstructions(configHome, workingCopy, deps); }
    catch (error) { hold.count -= 1; await activation?.release(); throw error; }
  });
  let released = false;
  return {
    env,
    beforePrompt: async turn => {
      if (released) throw new RemoteInstanceError("agent_unavailable", "The OpenCode execution context has been released. Start a new execution context before retrying.");
      await activation?.wait();
      return serial(configHome, async () => {
        if (released) throw new RemoteInstanceError("agent_unavailable", "The OpenCode execution context has been released. Start a new execution context before retrying.");
        await openCodeSkillSources(skillRoots);
        await syncOpenCodeInstructions(configHome, workingCopy, deps);
        activation?.prepareTurn(turn);
      });
    },
    afterPrompt: turn => activation?.finishTurn(turn),
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      return serial(configHome, async hold => {
        hold.count -= 1;
        await activation?.release();
        if (hold.count === 0) await rm(configHome, { recursive: true, force: true });
      });
    },
  };
}

/**
 * How the connector runs OpenCode's own `auth` and `api` commands: the
 * located binary, the control process's environment (allow-list, locked
 * config, private home) and the private home as the working folder, so no
 * repository config is in reach and `--standalone` keeps its private server
 * to itself (it exits with the command; no background service is started).
 */
async function preparedOpenCodeCommandContext(config: RunnerConfig): Promise<OpenCodeCommandContext> {
  const context = openCodeCommandContext(config);
  await prepareOpenCodeHome(config);
  return context;
}

/** The private folders every OpenCode process of this runner uses (0700); the control config never carries a working copy's instructions. */
async function prepareOpenCodeHome(config: RunnerConfig): Promise<void> {
  const paths = openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
  for (const folder of [paths.home, paths.data, paths.state, paths.cache, paths.configs, paths.controlConfig]) await mkdir(folder, { recursive: true, mode: 0o700 });
  await rm((process.platform === "win32" ? win32 : posix).join(paths.controlConfig, "opencode", "AGENTS.md"), { recursive: true, force: true });
}

export function openCodeCommandContext(config: RunnerConfig): OpenCodeCommandContext {
  const located = config.RUNNER_NATIVE_OPENCODE_BINARY;
  if (located === undefined || !isAbsolute(located) || CONTROL.test(located)) {
    throw new RemoteInstanceError("agent_unavailable", "An OpenCode runner requires the person's installed OpenCode 2 at an absolute local path.");
  }
  const paths = openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
  return { binary: located, env: openCodeProcessEnvironment(config.RUNNER_CREDENTIAL_DIR, paths.controlConfig), cwd: paths.home };
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

/** A sign-in request narrowed to OpenCode's: only its own reviewed options, never another agent's (or a Google Cloud project). */
function openCodeLoginRequest(request: HostLoginRequest): OpenCodeLoginRequest {
  const { loginOption, gcp: _gcp, ...rest } = request;
  if (loginOption === undefined) return rest;
  const option = OpenCodeLoginOptionIdSchema.safeParse(loginOption);
  if (!option.success) throw new RemoteInstanceError("agent_unavailable", "That sign-in is not one of OpenCode's.");
  return { ...rest, loginOption: option.data };
}

/**
 * OpenCode 2, launched as `<binary> acp` (no Node) with the allow-list
 * environment, the locked Konteks configuration and a private home shared by
 * every OpenCode process of this runner (sign-ins and sessions). The control
 * process (discovery, sign-in) uses a config folder with no instructions;
 * each execution process gets its working copy's own (`bindWorkingCopy`).
 * Offered on the install side (`openCodeInstallAdapter.offered`).
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
    await prepareOpenCodeHome(config);
  },
  bindWorkingCopy: async (config, family, workingCopy, readOnlyRoots = []) => {
    binary(config, family);
    return bindOpenCodeWorkingCopy(config.RUNNER_CREDENTIAL_DIR, workingCopy, {}, readOnlyRoots);
  },
  // OpenCode's own `auth login`, driven and relayed (link and code for a
  // subscription, OpenCode's own key prompt for an API key); the one-time
  // offer to repeat the person's own OpenCode sign-ins.
  startLogin: ({ config, events, logger, loginId, request }) => {
    const context = openCodeCommandContext(config);
    const paths = openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
    return startOpenCodeLogin({ context, events, logger, stateDir: paths.root, timeoutMs: config.RUNNER_LOGIN_TIMEOUT_MS, prepare: () => prepareOpenCodeHome(config),
      ...(loginId === undefined ? {} : { loginId }), ...(request === undefined ? {} : { request: openCodeLoginRequest(request) }),
      personal: personalOpenCodeHome({ binary: context.binary, scratchDir: (process.platform === "win32" ? win32 : posix).join(paths.root, "personal-list"),
        allowList: home => openCodeEnvironment({ home }) }) });
  },
  logout: async (config, request) => { await openCodeLogout(await preparedOpenCodeCommandContext(config), request?.provider); },
  loginFailedMessage: "OpenCode did not finish signing in",
  async identity(config, settings) {
    // What OpenCode's own `auth list` reports in the private home: provider,
    // method and credential id, never a secret. With nothing signed in, Zen's
    // free models make it ready only when the person switched them on.
    const stored = await listOpenCodeCredentials(await preparedOpenCodeCommandContext(config));
    const credentials = openCodeCredentialViews(stored);
    const material = openCodeIdentityMaterial(stored, settings.openCodeFreeModels);
    if (material === null) return { kind: "logged_out", credentials };
    const key = await readOrCreateSecretFile({ bytes: 32, dataDir: config.RUNNER_CREDENTIAL_DIR, encoding: "base64url", fileName: FINGERPRINT_KEY_FILE });
    return { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), material), credentials };
  },
  siteLoginOptions: async config => openCodeSiteLoginOptions(await listOpenCodeIntegrations(await preparedOpenCodeCommandContext(config))),
  offersModel: (value, settings) => settings.openCodeFreeModels || !isOpenCodeFreeModel(value),
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // OpenCode returns usage with each prompt response.
  tokenUsageObservable: true,
  // ACP still offers `plan` with the plan agent switched off, accepts it, and
  // a prompt in that mode hangs; plan mode also runs shell unasked.
  refusedSessionModes: { modeIds: ["plan"], message: "OpenCode's plan mode is not available on Konteks." },
};
