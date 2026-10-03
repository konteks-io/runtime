import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { fetchedAgentPlatformPin, findAgentBridge, type AgentBridgeFamily, type FetchedAgentPlatformPin } from "@konteks/remote-release";
import { ANTIGRAVITY_GOOGLE_SIGN_IN_RELEASED, ANTIGRAVITY_LOGIN_OPTIONS, AgentLoginGcpSchema } from "@konteks/backstage-plugin-common/remote-instance-internal";
import type { RunnerConfig } from "../config.js";
import { ANTIGRAVITY_LICENCE_REASON, spawnBridge, type BridgeProcess } from "../bridge/process.js";
import type { HostAgentRunnerAdapter, HostPromptPrelude, HostPromptSession, HostSpawn, HostTurnError } from "./host-agent.js";
import { geminiMeasuredTurn } from "../sessions/usage-label.js";
import { startAntigravityRelay, type AntigravityRelay, type GeminiRelayUpstream } from "./antigravity-relay.js";
import {
  antigravityIdentity, antigravityLoginChoice, antigravityLogout, markNoLicence, readAntigravityApiKey, startAntigravityLogin, type GoogleSignInProcess,
} from "../auth/antigravity-auth.js";
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
  /** What a Gemini Enterprise session showed of the organisation's admin settings (MCP Servers off, A21), for doctor. */
  adminControls: string;
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
    adminControls: path.join(root, "admin-controls.json"),
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
/** Antigravity's own slash commands Konteks never sends (A4). */
export const ANTIGRAVITY_REFUSED_COMMANDS: readonly string[] = Object.freeze(["plan", "logout"]);

/**
 * Which sign-in the connector holds for Antigravity: the file the connector
 * writes `settings.json` from before every spawn (the server treats
 * `auth.type` there as the single source of truth). CP3's sign-in and
 * sign-out write it; without one the settings name no method and a session
 * reads "Needs sign-in". Never read from the person's `~/.gemini`.
 * - `method`: the sign-in the server uses (`none` after signing out of all);
 * - `gcp`: Gemini Enterprise's project and location as the server resolved
 *   them after its licence picker; kept after a sign-out so the next sign-in
 *   offers it again;
 * - `tier`: the licence tier the server logged at sign-in
 *   (`gcp-ge-plus-tier`), which names the credential and its billing;
 * - `licence: "none"`: the last Gemini Enterprise attempt found no licence
 *   (the credential then reads "Needs sign-in" with that reason).
 */
const TIER = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
export const ANTIGRAVITY_SIGN_IN_METHODS = ["gemini-api-key", "oauth-business", "oauth-personal", "none"] as const;
export const AntigravitySignInSchema = z.object({
  method: z.enum(ANTIGRAVITY_SIGN_IN_METHODS),
  gcp: AgentLoginGcpSchema.optional(),
  tier: TIER.optional(),
  licence: z.literal("none").optional(),
}).strict().superRefine((value, ctx) => {
  if (value.method === "oauth-business" && value.gcp === undefined) ctx.addIssue({ code: "custom", path: ["gcp"], message: "Gemini Enterprise names its Google Cloud project" });
});
export type AntigravitySignIn = z.infer<typeof AntigravitySignInSchema>;
export type AntigravitySignInMethod = AntigravitySignIn["method"];

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
 * {"project": …, "location": …}}`; `{}` when nothing is signed in. Personal
 * Google sign-in (`oauth-personal`, A10) is written only while its switch is
 * on, which it is not.
 */
export function renderAntigravitySettings(signIn: AntigravitySignIn | null): string {
  if (signIn === null || signIn.method === "none") return "{}\n";
  if (signIn.method === "gemini-api-key") return `${JSON.stringify({ auth: { type: "gemini-api-key" } })}\n`;
  if (signIn.method === "oauth-personal") return ANTIGRAVITY_GOOGLE_SIGN_IN_RELEASED ? `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n` : "{}\n";
  return `${JSON.stringify({ auth: { type: "oauth-business" }, gcp: { project: signIn.gcp!.project, location: signIn.gcp!.location } })}\n`;
}

/**
 * While the connector drives a sign-in or sign-out over ACP, the server reads
 * and rewrites `settings.json` itself (the licence picker writes the project
 * it resolved); no other preparation of the home may overwrite it meanwhile.
 */
const signInsUnderWay = new Set<string>();

/** Hold the private home for a sign-in; the returned function releases it. */
export function holdAntigravityHomeForSignIn(credentialDir: string, platform: NodeJS.Platform = process.platform): () => void {
  const home = antigravityRuntimePaths(credentialDir, platform).home;
  if (signInsUnderWay.has(home)) throw new RemoteInstanceError("temporarily_unavailable", "Google Antigravity is already signing in on this computer.");
  signInsUnderWay.add(home);
  let released = false;
  return () => { if (!released) { released = true; signInsUnderWay.delete(home); } };
}

/** The server's own token files in the private home (Gemini Enterprise, and personal Google sign-in behind its switch). The connector only checks they exist. */
export function antigravityTokenFiles(credentialDir: string, platform: NodeJS.Platform = process.platform): { business: string; personal: string } {
  const path = platform === "win32" ? win32 : posix;
  const acp = path.join(antigravityRuntimePaths(credentialDir, platform).geminiHome, "antigravity-acp");
  return { business: path.join(acp, "acp_business_token.json"), personal: path.join(acp, "acp_token.json") };
}

/** Whether a token file the server wrote is there (a regular file, never a link); its contents are never read. */
export async function antigravityTokenPresent(file: string): Promise<boolean> {
  const found = await lstat(file).catch(() => null);
  return found !== null && found.isFile() && found.size > 0;
}

/**
 * Before every Antigravity process starts: the private folders exist and are
 * the person's alone (0700), `settings.json` says exactly what the connector
 * holds, nothing is trusted (the trust file is removed, so a repository's
 * `.agents/hooks.json` never runs, A4), and the global `config/` and the
 * CLI's skills folder expose only the connector-owned Skill store (no global
 * hooks or MCP servers from anyone else). Token files are the server's; the
 * connector never reads them.
 */
/** Stable receipt-owned Skill storage, outside the reset discovery/config folders. */
export function antigravitySkillHome(credentialDir: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(antigravityRuntimePaths(credentialDir, platform).geminiHome, "konteks-skills");
}
export async function prepareAntigravityHome(credentialDir: string, platform: NodeJS.Platform = process.platform): Promise<AntigravityRuntimePaths> {
  const paths = antigravityRuntimePaths(credentialDir, platform);
  const path = platform === "win32" ? win32 : posix;
  const acp = path.join(paths.geminiHome, "antigravity-acp");
  const config = path.join(paths.geminiHome, "config");
  const cliSkills = path.join(paths.geminiHome, "antigravity-cli", "skills");
  const skillHome = antigravitySkillHome(credentialDir, platform);
  const managedSkills = path.join(skillHome, "skills");
  for (const folder of [paths.root, paths.home, paths.geminiHome, acp, skillHome, managedSkills, path.dirname(cliSkills)]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const found = await lstat(folder);
    if (!found.isDirectory() || found.isSymbolicLink()) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity's private folder is not a folder.", { diagnostic: "antigravity_home_unsafe" });
    if (platform !== "win32") await chmod(folder, 0o700);
  }
  // A sign-in under way owns settings.json until it ends (the server writes it too).
  if (!signInsUnderWay.has(paths.home)) await writeSecretFile(paths.settingsFile, renderAntigravitySettings(await readAntigravitySignIn(credentialDir, platform)));
  await rm(paths.trustFile, { force: true, recursive: true });
  await rm(config, { force: true, recursive: true });
  await mkdir(config, { recursive: true, mode: 0o700 });
  await rm(cliSkills, { force: true, recursive: true });
  await mkdir(path.dirname(cliSkills), { recursive: true, mode: 0o700 });
  for (const discovery of [path.join(config, "skills"), cliSkills]) {
    await symlink(managedSkills, discovery, platform === "win32" ? "junction" : "dir");
  }
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
export function antigravityStderrFailure(line: string, credentialDir?: string): RemoteInstanceError | null {
  // The organisation dropped the Konteks servers this session asked for: no
  // Konteks tool can run in it, so it ends now as an access error instead of
  // a turn that cannot read its own discussion (WS1-196). The observation is
  // written before this returns, so the identity read that follows sees it.
  const dropped = MCP_DROPPED.exec(line);
  if (dropped && Number(dropped[1]) > 0) {
    if (credentialDir !== undefined) {
      try { recordMcpServersOff(credentialDir, new Date()); } catch { /* doctor and readiness then miss it; the session still ends */ }
    }
    return new RemoteInstanceError("agent_unavailable", ANTIGRAVITY_MCP_SERVERS_OFF, { diagnostic: "antigravity_mcp_servers_off" });
  }
  if (credentialDir !== undefined) void observeAntigravityAdminLine(line, credentialDir).catch(() => undefined);
  const auth = (message: string, diagnostic: string) => new RemoteInstanceError("agent_auth_required", message, { diagnostic, recoveryActions: [{ kind: "login_agent", agentId: "antigravity" }] });
  if (/has no available license/i.test(line)) {
    // The Enterprise credential reads "Needs sign-in" with this reason until the next sign-in (CP3).
    if (credentialDir !== undefined) void markNoLicence(credentialDir).catch(() => undefined);
    return auth(ANTIGRAVITY_LICENCE_REASON, "antigravity_no_licence");
  }
  if (/Open the following link to (?:authenticate|choose your Gemini Enterprise license)|Launching browser login flow/i.test(line)) {
    return auth("Google Antigravity needs to sign in again. Run `konteks-remote auth login antigravity`.", "antigravity_sign_in_needed");
  }
  return null;
}

/**
 * The organisation's "MCP Servers" setting as a Gemini Enterprise session
 * showed it (A21, CP4 found it off on the owner's organisation): the server
 * logs "Admin MCP control active: dropping N client-requested custom MCP
 * server(s)" when it drops the servers a session asked for (every Konteks
 * session asks for `konteks-result` at least), or an allowlist that leaves
 * ours out. Then no Konteks tool can run: the session ends at once
 * (`antigravityStderrFailure`), Antigravity reads unavailable with "contact
 * your provider's admin" until it clears, and doctor says so. An allowlist
 * that keeps ours, a new Gemini Enterprise sign-in or a sign-out clears it. Never a secret, never
 * the project.
 */
export interface AntigravityAdminObservation {
  /** When a session last had the Konteks MCP servers dropped by the organisation's settings. */
  mcpServersOffAt: string;
}

/** Why an Antigravity session on Gemini Enterprise cannot run Konteks work while the organisation's MCP Servers setting is off. */
export const ANTIGRAVITY_MCP_SERVERS_OFF = "Google Antigravity cannot use Konteks tools: MCP Servers is turned off in your Gemini Enterprise settings. Ask your admin to turn it on, or pick another agent in Customize → Models.";

function recordMcpServersOff(credentialDir: string, at: Date): void {
  const paths = antigravityRuntimePaths(credentialDir);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  writeFileSync(paths.adminControls, `${JSON.stringify({ mcpServersOffAt: at.toISOString() } satisfies AntigravityAdminObservation)}\n`, { mode: 0o600 });
  chmodSync(paths.adminControls, 0o600);
}

const MCP_DROPPED = /Admin MCP control active: dropping (\d+) client-requested custom MCP server/i;
const MCP_ALLOWLIST = /Admin MCP allowlist active: custom MCP servers (.*?) -> (.*)$/i;

/** Read one stderr line of an execution or discovery process for the admin settings it shows; writes the observation. */
export async function observeAntigravityAdminLine(line: string, credentialDir: string, now: () => Date = () => new Date()): Promise<void> {
  const dropped = MCP_DROPPED.exec(line);
  const allowlist = dropped ? null : MCP_ALLOWLIST.exec(line);
  if (!dropped && !allowlist) return;
  const file = antigravityRuntimePaths(credentialDir).adminControls;
  if (allowlist && /konteks-result/.test(allowlist[2] ?? "")) { await clearAntigravityAdminObservation(credentialDir); return; }
  if (dropped && Number(dropped[1]) === 0) return;
  await mkdir(antigravityRuntimePaths(credentialDir).root, { recursive: true, mode: 0o700 });
  await writeSecretFile(file, `${JSON.stringify({ mcpServersOffAt: now().toISOString() } satisfies AntigravityAdminObservation)}\n`);
}

/** The last observation, or null (none, or unreadable). */
export async function readAntigravityAdminObservation(credentialDir: string): Promise<AntigravityAdminObservation | null> {
  try {
    const value = JSON.parse(await readFile(antigravityRuntimePaths(credentialDir).adminControls, "utf8")) as Partial<AntigravityAdminObservation>;
    return typeof value.mcpServersOffAt === "string" && !Number.isNaN(Date.parse(value.mcpServersOffAt)) ? { mcpServersOffAt: value.mcpServersOffAt } : null;
  } catch {
    return null;
  }
}

/** Forget the observation (a new Gemini Enterprise sign-in or a sign-out). */
export async function clearAntigravityAdminObservation(credentialDir: string): Promise<void> {
  await rm(antigravityRuntimePaths(credentialDir).adminControls, { force: true });
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

/** The relay of every live Antigravity process that runs on a Gemini API key. */
const relays = new WeakMap<BridgeProcess, AntigravityRelay>();

/** Test and live-proof seam only: where relays forward (a fake Google endpoint). Never from config, Core or the environment. */
let relayUpstream: GeminiRelayUpstream | undefined;
export function setAntigravityRelayUpstreamForTests(upstream: GeminiRelayUpstream | undefined): void {
  relayUpstream = upstream;
}

/**
 * Every Antigravity process (control, execution, discovery) spawned while
 * the connector holds a Gemini API key and uses it (A7): a relay of its own
 * starts first on 127.0.0.1, the server gets only its address
 * (`GOOGLE_GEMINI_BASE_URL`) and, once initialized, a per-process token
 * through `authenticate` `_meta["api-key"]`; the relay stops when the process
 * exits. Gemini Enterprise and nothing signed in spawn as before.
 */
export function antigravitySpawn(credentialDir: string, spawn: HostSpawn): HostSpawn {
  return async options => {
    const record = await readAntigravitySignIn(credentialDir);
    const key = record?.method === "gemini-api-key" ? await readAntigravityApiKey(credentialDir) : null;
    if (key === null) return spawn(options);
    const relay = await startAntigravityRelay({ key, ...(options.logger ? { logger: options.logger } : {}), ...(relayUpstream ? { upstream: relayUpstream } : {}) });
    const env = antigravityProcessEnvironment(credentialDir, { relayBaseUrl: relay.url });
    let bridge: BridgeProcess;
    try {
      bridge = await spawn({ ...options, spec: { ...options.spec, env },
        handlers: { ...options.handlers, onExit: info => { void relay.close(); options.handlers.onExit(info); } } });
    } catch (error) {
      await relay.close();
      throw error;
    }
    try {
      await bridge.connection.authenticate({ methodId: "gemini-api-key", _meta: { "api-key": relay.token } });
    } catch (error) {
      await bridge.stop().catch(() => undefined);
      await relay.close();
      throw new RemoteInstanceError("agent_auth_required", "Google Antigravity did not take the Gemini API key. Run `konteks-remote auth login antigravity`.", {
        cause: error, diagnostic: "antigravity_key_refused", recoveryActions: [{ kind: "login_agent", agentId: "antigravity" }],
      });
    }
    relays.set(bridge, relay);
    return bridge;
  };
}

/** The process a Google sign-in or sign-out runs on: the fetched server, the private home, the allow-list environment, no relay. */
function signInProcess(config: RunnerConfig, spawn: HostSpawn | undefined): GoogleSignInProcess {
  const family = findAgentBridge("antigravity");
  if (!family) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity is not known to this connector.");
  const { command, args } = antigravityRunnerAdapter.launch(config, family);
  const paths = antigravityRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
  return {
    spec: { family, command, args, env: antigravityProcessEnvironment(config.RUNNER_CREDENTIAL_DIR), cwd: paths.home },
    spawn: spawn ?? spawnBridge,
    clientVersion: config.RUNNER_BRIDGE_VERSION,
    initializeTimeoutMs: config.RUNNER_INITIALIZE_TIMEOUT_MS,
  };
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
 * prompt, at most two sessions at once. CP3: signs in with a Gemini API key
 * (through a loopback relay per process) or Gemini Enterprise. Not offered
 * until CP4 (`antigravityInstallAdapter.offered` in the supervisor).
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
  // CP3: a Gemini API key typed on this computer, or Gemini Enterprise
  // through Google's own sign-in on this computer (from here or the site).
  startLogin: ({ config, events, logger, loginId, request, spawn }) => {
    // Request policy is platform-independent. Refuse a held-back or foreign
    // sign-in before checking whether this host has an Antigravity build, so
    // the same unsafe request never receives a different answer by OS.
    antigravityLoginChoice(request);
    fetched(config, findAgentBridge("antigravity")!);
    return startAntigravityLogin({ credentialDir: config.RUNNER_CREDENTIAL_DIR, events, logger, process: signInProcess(config, spawn),
      timeoutMs: config.RUNNER_LOGIN_TIMEOUT_MS, ...(loginId === undefined ? {} : { loginId }), ...(request === undefined ? {} : { request }) });
  },
  logout: async (config, request, spawn) => {
    fetched(config, findAgentBridge("antigravity")!);
    await antigravityLogout({ credentialDir: config.RUNNER_CREDENTIAL_DIR, process: signInProcess(config, spawn), ...(request === undefined ? {} : { request }) });
  },
  loginFailedMessage: "Google Antigravity did not finish signing in",
  identity: (config, settings) => antigravityIdentity(config.RUNNER_CREDENTIAL_DIR, settings),
  // Gemini Enterprise is the one sign-in the site may start (a browser on this
  // computer); personal Google sign-in stays held back (A10).
  siteLoginOptions: async () => Object.values(ANTIGRAVITY_LOGIN_OPTIONS).filter(option => option.released).map(option => option.id),
  hostVersion: config => config.RUNNER_BRIDGE_VERSION !== "unknown" ? config.RUNNER_BRIDGE_VERSION : undefined,
  // The server reports no usage (CP0 B11). On a Gemini API key the relay
  // counts it (the identity says so, A7); Gemini Enterprise reports none (A8).
  tokenUsageObservable: false,
  wrapSpawn: (config, spawn) => antigravitySpawn(config.RUNNER_CREDENTIAL_DIR, spawn),
  measureTurn: bridge => {
    const relay = relays.get(bridge);
    if (!relay) return null;
    const mark = relay.meter.mark();
    return () => geminiMeasuredTurn(relay.meter.since(mark));
  },
  refusedSessionModes: { modeIds: ANTIGRAVITY_REFUSED_MODES, message: "Google Antigravity runs only in its default mode on Konteks, where it asks before commands and edits." },
  // `/plan` waits on its own approval outside Konteks' governance; `/logout`
  // would sign the connector's Antigravity out (A4: never sent).
  refusedPromptCommands: { commands: ANTIGRAVITY_REFUSED_COMMANDS, message: "Google Antigravity's /plan and /logout commands are not available on Konteks." },
  sessionMeta: ANTIGRAVITY_SESSION_META,
  verifySession: verifyAntigravitySession,
  promptPrelude: (config, session) => antigravityPromptPrelude(config.RUNNER_CREDENTIAL_DIR, session),
  processLimits: ANTIGRAVITY_PROCESS_LIMITS,
  // Enterprise `session/new` fetches the organisation's settings first (3 to 7 s live, CP2).
  sessionBootstrapTimeoutMs: 30_000,
  stderrFailure: (line, config) => antigravityStderrFailure(line, config.RUNNER_CREDENTIAL_DIR),
  agentErrorText: antigravityAgentErrorText,
  sweepLeftovers: async config => { await sweepAntigravityProcesses(config.RUNNER_CREDENTIAL_DIR); },
};
