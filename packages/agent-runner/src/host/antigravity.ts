import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { fetchedAgentPlatformPin, type AgentBridgeFamily, type FetchedAgentPlatformPin } from "@konteks/remote-release";
import { AgentLoginGcpSchema } from "@konteks/backstage-plugin-common/remote-instance-internal";
import type { RunnerConfig } from "../config.js";
import { ANTIGRAVITY_LICENCE_REASON } from "../bridge/process.js";
import type { HostAgentRunnerAdapter, HostPromptPrelude, HostPromptSession, HostTurnError } from "./host-agent.js";
import { allowListEnvironment } from "./allow-list-environment.js";
import { privateHomeProcesses, type PrivateHomeProcesses } from "./process-sweep.js";
import { instructionsInside } from "./working-copy-instructions.js";

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
  /** Which sign-in this connector holds (`AntigravitySignIn`): outside the agent's home; `settings.json` is written from it. */
  signIn: string;
  /** What each session was last given as its `AGENTS.md` (A9), by the agent's own session id. */
  instructions: string;
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
    signIn: path.join(root, "sign-in.json"),
    instructions: path.join(root, "instructions.json"),
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

/**
 * The built-in tools a Konteks session of Google Antigravity may have (A4):
 * `session/new` `_meta.agy.enabledTools`, re-sent on `session/load` and
 * `session/resume` because a persisted filter can be overridden there
 * (`tool_filter.py`). Everything outside it is off, `start_subagent` (whose
 * subagents' own calls never ask, CP0 B8), `generate_image` and
 * `ask_question` among them; `disabledTools` names those again so a server
 * that ever stopped honouring the allowlist still drops them. A runtime copy
 * of packages' `ANTIGRAVITY_ENABLED_TOOLS` (agent-adapters), as for OpenCode.
 */
export const ANTIGRAVITY_ENABLED_TOOLS: readonly string[] = Object.freeze([
  "view_file", "list_directory", "search_directory", "find_file", "create_file", "edit_file", "run_command", "read_url_content", "search_web", "finish",
]);
export const ANTIGRAVITY_DISABLED_TOOLS: readonly string[] = Object.freeze(["start_subagent", "generate_image", "ask_question"]);
export const ANTIGRAVITY_SESSION_META: Readonly<Record<string, unknown>> = Object.freeze({
  agy: Object.freeze({ enabledTools: ANTIGRAVITY_ENABLED_TOOLS, disabledTools: ANTIGRAVITY_DISABLED_TOOLS }),
});

/** Modes Konteks never lets Antigravity enter (A4): only `default` asks before commands and edits. */
export const ANTIGRAVITY_REFUSED_MODES: readonly string[] = Object.freeze(["auto_edit", "yolo"]);

/**
 * Which sign-in the connector holds for Antigravity: the file the connector
 * writes `settings.json` from before every spawn (the server treats
 * `auth.type` there as the single source of truth). CP3's sign-in writes it;
 * without one the settings name no method and a session reads "Needs
 * sign-in". Never read from the person's `~/.gemini`.
 */
export const AntigravitySignInSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("gemini-api-key") }).strict(),
  z.object({ method: z.literal("oauth-business"), gcp: AgentLoginGcpSchema }).strict(),
]);
export type AntigravitySignIn = z.infer<typeof AntigravitySignInSchema>;

/** The connector's sign-in record, or null when there is none or it is not one Konteks wrote. */
export async function readAntigravitySignIn(credentialDir: string, platform: NodeJS.Platform = process.platform): Promise<AntigravitySignIn | null> {
  const raw = await readFile(antigravityRuntimePaths(credentialDir, platform).signIn, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = AntigravitySignInSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeAntigravitySignIn(credentialDir: string, signIn: AntigravitySignIn, platform: NodeJS.Platform = process.platform): Promise<void> {
  const record = AntigravitySignInSchema.parse(signIn);
  const paths = antigravityRuntimePaths(credentialDir, platform);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeSecretFile(paths.signIn, `${JSON.stringify(record)}\n`);
}

/**
 * `settings.json` exactly as the contract names it: `{"auth": {"type":
 * "gemini-api-key"}}`, or `{"auth": {"type": "oauth-business"}, "gcp":
 * {"project": …, "location": …}}`; `{}` when nothing is signed in.
 */
export function renderAntigravitySettings(signIn: AntigravitySignIn | null): string {
  if (signIn === null) return "{}\n";
  if (signIn.method === "gemini-api-key") return `${JSON.stringify({ auth: { type: "gemini-api-key" } })}\n`;
  return `${JSON.stringify({ auth: { type: "oauth-business" }, gcp: { project: signIn.gcp.project, location: signIn.gcp.location } })}\n`;
}

/**
 * Before every Antigravity process starts: the private folders exist and are
 * the person's alone (0700), `settings.json` says exactly what the connector
 * holds, nothing is trusted (the trust file is removed, so a repository's
 * `.agents/hooks.json` never runs, A4), and the global `config/` and the
 * CLI's skills folder are empty folders the connector owns (no global hooks,
 * MCP servers or skills from anyone else). Token files are the server's; the
 * connector never reads them.
 */
export async function prepareAntigravityHome(credentialDir: string, platform: NodeJS.Platform = process.platform): Promise<AntigravityRuntimePaths> {
  const paths = antigravityRuntimePaths(credentialDir, platform);
  const path = platform === "win32" ? win32 : posix;
  const acp = path.join(paths.geminiHome, "antigravity-acp");
  const config = path.join(paths.geminiHome, "config");
  const cliSkills = path.join(paths.geminiHome, "antigravity-cli", "skills");
  for (const folder of [paths.root, paths.home, paths.geminiHome, acp]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const found = await lstat(folder);
    if (!found.isDirectory() || found.isSymbolicLink()) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity's private folder is not a folder.", { diagnostic: "antigravity_home_unsafe" });
    if (platform !== "win32") await chmod(folder, 0o700);
  }
  await writeSecretFile(paths.settingsFile, renderAntigravitySettings(await readAntigravitySignIn(credentialDir, platform)));
  await rm(paths.trustFile, { force: true, recursive: true });
  for (const owned of [config, cliSkills]) {
    await rm(owned, { force: true, recursive: true });
    await mkdir(owned, { recursive: true, mode: 0o700 });
  }
  await mkdir(path.join(config, "skills"), { recursive: true, mode: 0o700 });
  return paths;
}

/** Larger than this, a working copy's `AGENTS.md` is not sent (a prompt is not the place for a book). */
export const ANTIGRAVITY_MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const INSTRUCTIONS_LINE = "This is the working copy's AGENTS.md: the project's instructions for you. Follow them in this session.";
const MAX_REMEMBERED_SESSIONS = 256;

/** One write at a time per store file. */
const instructionWrites = new Map<string, Promise<unknown>>();

async function readDelivered(file: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/**
 * The working copy's `AGENTS.md` for a prompt of one session (A9): the
 * server loads no rules file at all (CP0 B7), so the connector sends it
 * itself as an embedded resource, in the session's first prompt and, after a
 * load or resume (or an edit), again only when the file changed since it was
 * last delivered to that session. Only a regular file whose real path is
 * inside the working copy counts (a link to `~/.ssh/...` is never read).
 */
export async function antigravityPromptPrelude(credentialDir: string, session: HostPromptSession, platform: NodeJS.Platform = process.platform): Promise<HostPromptPrelude | null> {
  const file = await instructionsInside(session.cwd);
  if (file === null) return null;
  const size = (await stat(file)).size;
  if (size === 0 || size > ANTIGRAVITY_MAX_INSTRUCTIONS_BYTES) return null;
  const text = await readFile(file, "utf8");
  const digest = createHash("sha256").update(text).digest("hex");
  const store = antigravityRuntimePaths(credentialDir, platform).instructions;
  if ((await readDelivered(store))[session.sessionKey] === digest) return null;
  return {
    blocks: [
      { type: "text", text: INSTRUCTIONS_LINE },
      { type: "resource", resource: { uri: pathToFileURL(file).href, mimeType: "text/markdown", text } },
    ],
    delivered: () => {
      const previous = instructionWrites.get(store) ?? Promise.resolve();
      const write = previous.catch(() => undefined).then(async () => {
        const delivered = await readDelivered(store);
        delete delivered[session.sessionKey];
        delivered[session.sessionKey] = digest;
        const keys = Object.keys(delivered);
        for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_SESSIONS))) delete delivered[key];
        await writeSecretFile(store, `${JSON.stringify(delivered)}\n`);
      });
      instructionWrites.set(store, write);
      return write;
    },
  };
}

/**
 * What a new, loaded or resumed session must report (A3/A4): a `model`
 * select (model discovery and Customize read it) and the `default` mode, the
 * only one that asks before commands and edits. Anything else is a server
 * Konteks does not know how to govern.
 */
export function verifyAntigravitySession(response: { configOptions?: unknown; modes?: unknown }): void {
  const options = Array.isArray(response.configOptions) ? response.configOptions as Array<{ id?: unknown; type?: unknown; currentValue?: unknown }> : [];
  const model = options.find(option => option?.id === "model");
  if (!model || model.type !== "select" || typeof model.currentValue !== "string") {
    throw new RemoteInstanceError("agent_unavailable", "Unsupported Google Antigravity version: its session offers no model choice. Update the connector.", { diagnostic: "antigravity_unsupported_version" });
  }
  const modeOption = options.find(option => option?.id === "mode");
  const modes = response.modes as { currentModeId?: unknown } | null | undefined;
  const current = typeof modeOption?.currentValue === "string" ? modeOption.currentValue : typeof modes?.currentModeId === "string" ? modes.currentModeId : undefined;
  if (current !== undefined && current !== "default") {
    throw new RemoteInstanceError("agent_unavailable", "Google Antigravity started a session outside its default mode, where it would not ask before commands. Update the connector.", { diagnostic: "antigravity_session_mode" });
  }
}

/**
 * Lines the server prints when it cannot go on without the person: a licence
 * it cannot find (its Business AI Code API off, CP0 part 2), or a sign-in or
 * licence page it would open in a browser on this computer. A session must
 * not wait on them: it fails at once as "Needs sign-in" with a plain reason.
 * Only execution and discovery processes are read this way; the sign-in flow
 * (CP3) expects these lines.
 */
export function antigravityStderrFailure(line: string): RemoteInstanceError | null {
  const auth = (message: string, diagnostic: string) => new RemoteInstanceError("agent_auth_required", message, { diagnostic, recoveryActions: [{ kind: "login_agent", agentId: "antigravity" }] });
  if (/has no available license/i.test(line)) return auth(ANTIGRAVITY_LICENCE_REASON, "antigravity_no_licence");
  if (/Open the following link to (?:authenticate|choose your Gemini Enterprise license)|Launching browser login flow/i.test(line)) {
    return auth("Google Antigravity needs to sign in again. Run `konteks-remote auth login antigravity`.", "antigravity_sign_in_needed");
  }
  return null;
}

/**
 * The server reports quota and model failures as its own reply text and then
 * ends the turn (`quota_errors.py`: "Usage Limit Reached" with stop reason
 * `refusal`; otherwise "Agent execution error: …"). Classified here, and the
 * text (Google's own words, with project and model detail) never reaches the
 * person.
 */
export function antigravityAgentErrorText(text: string): HostTurnError | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("Usage Limit Reached")) {
    return { class: "provider_failure", message: "Your Gemini quota for this period is used up. The session is kept and can continue once it resets.", retryable: true };
  }
  if (!trimmed.startsWith("Agent execution error:")) return null;
  const detail = trimmed.slice(0, 4_096);
  if (/\b(?:401|403)\b|UNAUTHENTICATED|PERMISSION_DENIED|unauthori[sz]ed/i.test(detail)) {
    return { class: "agent_auth_required", message: "Google Antigravity needs to sign in again. Run `konteks-remote auth login antigravity`.", retryable: false };
  }
  if (/\bmodel\b/i.test(detail) && /not (?:allowed|available|authori[sz]ed|permitted|supported)|not found/i.test(detail)) {
    return { class: "provider_failure", message: "This model is not available to your Gemini Enterprise licence. Pick another model.", retryable: false };
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(detail)) {
    return { class: "provider_failure", message: "Google is limiting requests right now. The session is kept and can continue shortly.", retryable: true };
  }
  if (/\b(?:500|502|503|504)\b|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|timed? ?out/i.test(detail)) {
    return { class: "provider_failure", message: "Google had a problem answering. The session is kept and can continue shortly.", retryable: true };
  }
  return { class: "provider_failure", message: "Google Antigravity could not finish this turn.", retryable: false };
}

/** The server's two programs (`agy_acp_server.par` runs `localharness_external`). */
export const ANTIGRAVITY_PROGRAMS: readonly string[] = Object.freeze(["agy_acp_server", "localharness"]);

/**
 * Stop every Antigravity process whose `HOME` is this runner's private home:
 * what a stopped (or crashed) server left running. The person's own
 * Antigravity never has that home, so it is never touched.
 */
export async function sweepAntigravityProcesses(credentialDir: string, control: PrivateHomeProcesses = privateHomeProcesses()): Promise<number> {
  const pids = await control.list(antigravityRuntimePaths(credentialDir).home, ANTIGRAVITY_PROGRAMS);
  if (pids.length > 0) await control.stop(pids);
  return pids.length;
}

/**
 * About 350 MB per process pair (the server and its harness, CP0 B15), so at
 * most two sessions run at once and a third waits for one (A12); a finished
 * session's process stays five minutes for the next one, and the control
 * process (readiness, sign-in) stops after a minute with nothing to do.
 */
export const ANTIGRAVITY_PROCESS_LIMITS = Object.freeze({ executionProcesses: 2, queueMs: 120_000, idleExecutionMs: 5 * 60_000, controlIdleMs: 60_000 });

function notYet(): RemoteInstanceError {
  // Sign-in (the Gemini API key relay and Gemini Enterprise) is CP3; until
  // then the connector holds no Antigravity credential to use or remove.
  return new RemoteInstanceError("agent_unavailable", "Google Antigravity cannot sign in on this computer yet.");
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
 * command> <pinned args>` with the allow-list environment, from the private
 * home the connector prepares before every spawn (CP2): the locked
 * configuration (settings, no trust, owned `config/`), the tool filter on
 * every session, `default` mode only, the working copy's `AGENTS.md` in the
 * prompt, at most two sessions at once. Sign-in is CP3; not offered until
 * CP4 (`antigravityInstallAdapter.offered` in the supervisor).
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
  async prepareToSpawn(config) {
    const root = config.RUNNER_NATIVE_ANTIGRAVITY_ROOT;
    if (root === undefined || !isAbsolute(root) || CONTROL.test(root)) {
      throw new RemoteInstanceError("agent_unavailable", "A Google Antigravity runner requires the copy the connector fetched, at an absolute local path.");
    }
    await prepareAntigravityHome(config.RUNNER_CREDENTIAL_DIR);
  },
  startLogin: () => { throw notYet(); },
  logout: async () => { throw notYet(); },
  loginFailedMessage: "Google Antigravity did not finish signing in",
  identity: async () => ({ kind: "logged_out" }),
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // The server reports no usage (CP0 B11); the relay counts tokens for an
  // API key from CP3 on, and Gemini Enterprise is a subscription (A7, A8).
  tokenUsageObservable: false,
  refusedSessionModes: { modeIds: ANTIGRAVITY_REFUSED_MODES, message: "Google Antigravity runs only in its default mode on Konteks, where it asks before commands and edits." },
  sessionMeta: ANTIGRAVITY_SESSION_META,
  verifySession: verifyAntigravitySession,
  promptPrelude: (config, session) => antigravityPromptPrelude(config.RUNNER_CREDENTIAL_DIR, session),
  processLimits: ANTIGRAVITY_PROCESS_LIMITS,
  // Enterprise `session/new` fetches the organisation's settings first (3 to 7 s live, CP2).
  sessionBootstrapTimeoutMs: 30_000,
  stderrFailure: antigravityStderrFailure,
  agentErrorText: antigravityAgentErrorText,
  sweepLeftovers: async config => { await sweepAntigravityProcesses(config.RUNNER_CREDENTIAL_DIR); },
};
