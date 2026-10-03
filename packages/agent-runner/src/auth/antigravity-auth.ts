import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  ANTIGRAVITY_LOGIN_OPTIONS,
  AgentLoginGcpSchema,
  GEMINI_ENTERPRISE_LOCATIONS,
  GeminiEnterpriseLocationSchema,
  GoogleCloudProjectIdSchema,
  RemoteInstanceError,
  agentLoginUrlAllowed,
  withoutUndefined,
  deleteSecretFile,
  keyedFingerprint,
  readOrCreateSecretFile,
  readSecretFileIfPresent,
  writeSecretFile,
  type AgentLoginGcp,
  type ConnectedAgentCredential,
  type Logger,
} from "@konteks/remote-common";
import { classifyAgentBilling, geminiEnterpriseCredentialLabel } from "@konteks/backstage-plugin-common/known-models";
import type { RequestError } from "@agentclientprotocol/sdk";
import type { BridgeProcess, SpawnBridgeOptions } from "../bridge/process.js";
import type { BridgeSpawnSpec } from "../bridge/spec.js";
import type { RunnerEventBus } from "../events.js";
import type { HostAgentSettings, HostLoginRequest, HostSpawn } from "../host/host-agent.js";
import {
  antigravityRuntimePaths,
  antigravityTokenFiles,
  antigravityTokenPresent,
  holdAntigravityHomeForSignIn,
  prepareAntigravityHome,
  readAntigravitySignIn,
  renderAntigravitySettings,
  writeAntigravitySignIn,
  clearAntigravityAdminObservation,
  readAntigravityAdminObservation,
  type AntigravitySignIn,
} from "../host/antigravity.js";
import type { LoginEvent, LoginFailureReason, LoginFlow } from "./login-flow.js";
import { checkApiKey, type KeyVerdict } from "./key-check.js";

/**
 * Google Antigravity's sign-ins, driven by the connector the way the other agents' are:
 * - **Gemini API key** (as DeepSeek Harness's): typed into the launcher's
 *   hidden prompt, checked with Google's free model list, kept in the
 *   connector's own store outside the agent's home (`<root>/relay`), never an
 *   argument, environment variable, event or log line. The server never sees
 *   it: every process gets a loopback relay and a per-process token instead
 *   (`antigravity-relay.ts`).
 * - **Gemini Enterprise** (as Claude Code's machine-browser sign-in): the
 *   project and location go into the private `settings.json`, the connector
 *   runs ACP `authenticate oauth-business` on a process of its own, relays
 *   only Google's own `accounts.google.com` link (never the licence picker the
 *   server serves on loopback), and reads back the project the server
 *   resolved after the picker. The token stays a file the server wrote in the
 *   private home (forced file storage); the connector checks it exists and
 *   never reads it.
 * - **Personal Google sign-in** exists only behind packages'
 *   `ANTIGRAVITY_LOGIN_OPTIONS['google-account'].released`, which is off:
 *   never offered, never started.
 */

const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/;
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
/** Google's own sign-in times out after 300 s; a little more for the licence page. */
const ANTIGRAVITY_SIGN_IN_TIMEOUT_MS = 330_000;
const REQUIRE_REVIEW_LINE = "Your Google Cloud admin must set Terminal auto-execution to Require review. Otherwise Konteks stops Google Antigravity after its first command.";

/** Where the connector keeps the person's Gemini API key: 0600, outside the agent's home. */
export function antigravityKeyFile(credentialDir: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(antigravityRuntimePaths(credentialDir, platform).relay, "gemini-api-key");
}

export async function readAntigravityApiKey(credentialDir: string): Promise<string | null> {
  const stored = await readSecretFileIfPresent(antigravityKeyFile(credentialDir)).catch(() => null);
  const key = stored?.trim();
  return key && KEY_SHAPE.test(key) ? key : null;
}

export async function writeAntigravityApiKey(credentialDir: string, key: string): Promise<void> {
  if (!KEY_SHAPE.test(key)) throw new Error("not an API key");
  await mkdir(antigravityRuntimePaths(credentialDir).relay, { recursive: true, mode: 0o700 });
  await writeSecretFile(antigravityKeyFile(credentialDir), `${key}\n`);
}

async function removeAntigravityApiKey(credentialDir: string): Promise<boolean> {
  const held = await readAntigravityApiKey(credentialDir) !== null;
  await deleteSecretFile(antigravityKeyFile(credentialDir));
  return held;
}

/**
 * Check a key with Google's model list: free, no tokens spent. Google answers
 * a key it does not know with 400 API_KEY_INVALID.
 */
function verifyGeminiApiKey(key: string, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<KeyVerdict> {
  return checkApiKey(MODELS_URL, { "x-goog-api-key": key, accept: "application/json" }, [400, 401, 403], deps);
}

// ── Gemini Enterprise over ACP ────────────────────────────────────────────────

/** What the server printed during a Google sign-in, read line by line from its stderr. */
interface GoogleSignInSignals {
  /** Google's own page (`accounts.google.com`), relayed to the person. */
  googleUrl?: string;
  /** The server's licence picker opened on loopback (never relayed). */
  licencePicker: boolean;
  /** "has no available license": the project has none the server could find. */
  noLicence: boolean;
  /** "Gemini Enterprise sign-in resolved: project=… location=… user_tier=…". */
  resolved?: { project: string; location: string; tier: string };
  /** "using file credential storage": the token went to a file, never the keychain. */
  fileStore: boolean;
}

const GOOGLE_LINK = /Open the following link to authenticate the ACP server:\s*(https:\/\/\S+)/;
const PICKER = /Open the following link to choose your Gemini Enterprise license/;
const RESOLVED = /Gemini Enterprise sign-in resolved: project=(\S+) location=(\S+) user_tier=(\S+)/;

/** Read one stderr line of the server into `signals`; returns what changed, for the relay. */
function readGoogleSignInLine(line: string, signals: GoogleSignInSignals): "google_url" | "picker" | "no_licence" | "resolved" | null {
  const link = GOOGLE_LINK.exec(line)?.[1];
  if (link) {
    signals.googleUrl = link;
    return "google_url";
  }
  if (PICKER.test(line)) { signals.licencePicker = true; return "picker"; }
  if (/has no available license/i.test(line)) { signals.noLicence = true; return "no_licence"; }
  const resolved = RESOLVED.exec(line);
  if (resolved) { signals.resolved = { project: resolved[1]!, location: resolved[2]!, tier: resolved[3]! }; return "resolved"; }
  if (/using file credential storage/i.test(line)) signals.fileStore = true;
  return null;
}

export interface GoogleSignInProcess {
  /** The spawn spec of the connector's own Antigravity process (private home, allow-list environment). */
  spec: BridgeSpawnSpec;
  /** The runtime's process spawn (a test's fake server). */
  spawn: HostSpawn;
  clientVersion: string;
  initializeTimeoutMs: number;
}

type GoogleSignInOutcome =
  | { outcome: "signed_in"; gcp?: AgentLoginGcp; tier?: string }
  | { outcome: "failed"; reason?: LoginFailureReason; message: string };

type GoogleSignInRun = {
  credentialDir: string;
  method: "oauth-business" | "oauth-personal";
  gcp?: AgentLoginGcp;
  process: GoogleSignInProcess;
  onLine: (change: ReturnType<typeof readGoogleSignInLine>, signals: GoogleSignInSignals) => void;
  signal: AbortSignal;
  timeoutMs?: number;
};

/**
 * One Google sign-in over ACP on a process of the connector's own (never an
 * execution process, whose stderr reading ends a session at these very
 * lines). `settings.json` names the method (and Enterprise's project) while
 * the server signs in; the home is held so nothing rewrites it meanwhile.
 */
async function runGoogleSignIn(options: GoogleSignInRun): Promise<GoogleSignInOutcome> {
  const release = holdAntigravityHomeForSignIn(options.credentialDir);
  const paths = antigravityRuntimePaths(options.credentialDir);
  const signals: GoogleSignInSignals = { licencePicker: false, noLicence: false, fileStore: false };
  let bridge: BridgeProcess | null = null;
  try {
    await prepareAntigravityHome(options.credentialDir);
    const settings: AntigravitySignIn = options.method === "oauth-business" ? { method: "oauth-business", gcp: options.gcp! } : { method: "oauth-personal" };
    await writeSecretFile(paths.settingsFile, renderAntigravitySettings(settings));
    if (options.signal.aborted) return { outcome: "failed", message: "The sign-in was stopped." };
    bridge = await options.process.spawn(signInSpawnOptions(options, paths.home, signals));
    await authenticateWithin(bridge, options);
    return await signedInOutcome(options, paths.settingsFile, signals);
  } catch (error) {
    return signInFailure(error, signals);
  } finally {
    await bridge?.stop().catch(() => undefined);
    release();
  }
}

/** A process that runs nothing: every permission or elicitation is refused. */
function signInSpawnOptions(options: GoogleSignInRun, home: string, signals: GoogleSignInSignals): SpawnBridgeOptions {
  const refuse = async (): Promise<never> => { throw new RemoteInstanceError("permission_denied", "Nothing runs during a sign-in."); };
  return {
    spec: { ...options.process.spec, cwd: home },
    initializeTimeoutMs: options.process.initializeTimeoutMs,
    clientVersion: options.process.clientVersion,
    handlers: { onSessionUpdate: () => undefined, onRequestPermission: refuse, onCreateElicitation: refuse, onExit: () => undefined },
    onStderrLine: line => { const change = readGoogleSignInLine(line, signals); if (change) options.onLine(change, signals); },
  };
}

/** ACP `authenticate`, until the person stops the sign-in or Google's own timeout passes. */
async function authenticateWithin(bridge: BridgeProcess, options: GoogleSignInRun): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new RemoteInstanceError("temporarily_unavailable", "The sign-in was stopped."));
    if (options.signal.aborted) stop();
    options.signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => reject(new RemoteInstanceError("temporarily_unavailable", "The sign-in timed out.", { diagnostic: "antigravity_sign_in_timed_out" })), options.timeoutMs ?? ANTIGRAVITY_SIGN_IN_TIMEOUT_MS);
    timer.unref();
  });
  void stopped.catch(() => undefined);
  try {
    await Promise.race([bridge.connection.authenticate({ methodId: options.method }), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function signedInOutcome(options: GoogleSignInRun, settingsFile: string, signals: GoogleSignInSignals): Promise<GoogleSignInOutcome> {
  // The file store, never the keychain: the token is a file in the private home.
  const tokenFiles = antigravityTokenFiles(options.credentialDir);
  const tokenFile = options.method === "oauth-business" ? tokenFiles.business : tokenFiles.personal;
  if (!await antigravityTokenPresent(tokenFile)) {
    return { outcome: "failed", message: "Google Antigravity did not keep its sign-in in the connector's private folder, so it was not used." };
  }
  if (options.method === "oauth-personal") return { outcome: "signed_in" };
  // Its "resolved" line (the tier) travels on stderr, which may trail the answer by a moment.
  for (let waited = 0; signals.resolved === undefined && waited < 1_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  return { outcome: "signed_in", gcp: await resolvedGcp(settingsFile, signals, options.gcp!), ...(signals.resolved ? { tier: signals.resolved.tier } : {}) };
}

/** The connector stopped the sign-in, or Google's own time ran out. */
function endedByConnector(error: RemoteInstanceError, licence: boolean): GoogleSignInOutcome | null {
  if (/stopped/.test(error.message)) return { outcome: "failed", message: "The sign-in was stopped." };
  if (error.diagnostic !== "antigravity_sign_in_timed_out") return null;
  return { outcome: "failed", ...(licence ? { reason: "no_license" as const } : {}), message: "The sign-in timed out. Run it again when you can finish it in the browser." };
}

function signInFailure(error: unknown, signals: GoogleSignInSignals): GoogleSignInOutcome {
  const reason = ((error as RequestError | undefined)?.data as { reason?: unknown } | undefined)?.reason;
  const licence = signals.noLicence || reason === "ge_license_failed";
  if (error instanceof RemoteInstanceError) {
    const ended = endedByConnector(error, licence);
    if (ended) return ended;
  }
  if (licence) return { outcome: "failed", reason: "no_license", message: "Gemini Enterprise found no licence for this Google Cloud project." };
  if (reason === "ge_license_cancelled") return { outcome: "failed", message: "The licence page was closed before a licence was chosen. Sign in again to choose one." };
  return { outcome: "failed", message: "Google Antigravity did not finish signing in." };
}

/** The project the server settled on: its own `settings.json` after the picker, else its "resolved" line, else what was asked. */
async function resolvedGcp(settingsFile: string, signals: GoogleSignInSignals, asked: AgentLoginGcp): Promise<AgentLoginGcp> {
  try {
    const written = JSON.parse(await readFile(settingsFile, "utf8")) as { gcp?: unknown };
    const parsed = AgentLoginGcpSchema.safeParse(written.gcp);
    if (parsed.success) return parsed.data;
  } catch { /* fall through */ }
  const line = AgentLoginGcpSchema.safeParse(signals.resolved ? { project: signals.resolved.project, location: signals.resolved.location } : undefined);
  return line.success ? line.data : asked;
}

// ── The login flow ────────────────────────────────────────────────────────────

interface AntigravityLoginOptions {
  credentialDir: string;
  events: RunnerEventBus;
  loginId?: string;
  logger?: Pick<Logger, "info" | "warn">;
  request?: HostLoginRequest;
  /** How the Google sign-in process is started. */
  process: GoogleSignInProcess;
  verifyKey?: (key: string) => Promise<KeyVerdict>;
  /** The whole flow, prompts included (the runner's login timeout). */
  timeoutMs?: number;
  /** Google's own sign-in (300 s). */
  signInTimeoutMs?: number;
  /** Test seam: packages' switch for personal Google sign-in. */
  googleSignInReleased?: boolean;
}

type Choice = "key" | "enterprise" | "personal";
type Step = "choose" | "key" | "project" | "location" | "running" | "done";

const METHOD_CHOICES: ReadonlyMap<string, Choice> = new Map([
  ["gemini-api-key", "key"], ["key", "key"], ["api-key", "key"],
  ["oauth-business", "enterprise"], ["enterprise", "enterprise"], ["gemini-enterprise", "enterprise"],
  ["oauth-personal", "personal"], ["google", "personal"],
]);

/** Which sign-in a request names, or null when the person is asked. Refuses another agent's option and anything held back. */
export function antigravityLoginChoice(request: HostLoginRequest | undefined, googleSignInReleased = ANTIGRAVITY_LOGIN_OPTIONS["google-account"].released): Choice | null {
  if (!request) return null;
  if (request.loginOption !== undefined) return optionChoice(request.loginOption, googleSignInReleased);
  if (request.method === undefined) return request.gcp !== undefined ? "enterprise" : null;
  const choice = METHOD_CHOICES.get(request.method);
  if (!choice) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity signs in with a Gemini API key or Gemini Enterprise.");
  return choice === "personal" ? personalChoice(googleSignInReleased) : choice;
}

function optionChoice(loginOption: string, googleSignInReleased: boolean): Choice {
  if (loginOption === "gemini-enterprise") return "enterprise";
  if (loginOption === "google-account") return personalChoice(googleSignInReleased);
  throw new RemoteInstanceError("agent_unavailable", "That sign-in is not one of Google Antigravity's.");
}

function personalChoice(googleSignInReleased: boolean): Choice {
  if (!googleSignInReleased) throw new RemoteInstanceError("prerequisite_missing", "Signing Google Antigravity in with a personal Google account is not available on Konteks. Use a Gemini API key or Gemini Enterprise.");
  return "personal";
}

/**
 * `konteks-remote auth login antigravity [--api-key | --enterprise --project P
 * --location L]` and the site's "Sign in with Gemini Enterprise": one
 * LoginFlow, the same relay contract as the other agents'. Without a choice
 * the person types 1 (key) or 2 (Enterprise) in the open; a key is asked
 * hidden; Enterprise asks the project and location in the open (the site
 * sends both, so it is never asked a question).
 */
export function startAntigravityLogin(options: AntigravityLoginOptions): LoginFlow {
  const { loginId, verify, choice, timeoutMs, gcp: requested } = loginSetup(options);
  const abort = new AbortController();
  let step: Step = "choose";
  let busy = false;
  let finished = false;
  let keyAttempts = 0;
  let asks = 0;
  let project: string | undefined = requested?.project;
  let location: string | undefined = requested?.location;
  let suggested: AgentLoginGcp | undefined;
  let resolveDone!: (value: { code: number | null; reason?: LoginFailureReason }) => void;
  const done = new Promise<{ code: number | null; reason?: LoginFailureReason }>(resolve => { resolveDone = resolve; });
  const emit = (event: LoginEvent) => options.events.publish({ kind: "login_event", loginId, event });
  const display = (text: string) => emit({ type: "display", text });
  const ask = (label: string, secret: boolean) => emit({ type: "prompt", label, secret, ...(secret ? {} : { visible: true as const }) });
  const finish = (code: number, reason?: LoginFailureReason) => {
    if (finished) return;
    finished = true;
    step = "done";
    clearTimeout(timer);
    abort.abort();
    resolveDone({ code, ...(reason ? { reason } : {}) });
  };
  const timer = setTimeout(() => { display("The sign-in timed out. Run it again when you are ready."); finish(1); }, timeoutMs);
  timer.unref();

  const askChoice = () => { step = "choose"; ask("Sign Google Antigravity in with: 1 a Gemini API key, 2 Gemini Enterprise (type 1 or 2)", false); };
  const askKey = () => { step = "key"; ask("Gemini API key", true); };
  const askProject = () => { step = "project"; ask(`Google Cloud project ID${suggested ? ` [${suggested.project}]` : ""}`, false); };
  const askLocation = () => { step = "location"; ask(`Location: ${GEMINI_ENTERPRISE_LOCATIONS.join(", ")} [${suggested?.location ?? "global"}]`, false); };
  const tooMany = () => { asks += 1; if (asks > 5) { display("Too many answers that did not fit. Run the sign-in again."); finish(1); return true; } return false; };

  const beginKey = () => {
    display("Paste your Gemini API key (from https://aistudio.google.com/apikey). Konteks checks it with Google and keeps it only on this computer; Google Antigravity itself never sees it. Google bills its use to your key.");
    askKey();
  };
  const beginEnterprise = async () => {
    suggested = (await readAntigravitySignIn(options.credentialDir))?.gcp;
    if (project === undefined) { askProject(); return; }
    if (location === undefined) { askLocation(); return; }
    runEnterprise("oauth-business");
  };
  const begin = (picked: Choice) => {
    if (picked === "key") beginKey();
    else if (picked === "enterprise") void beginEnterprise().catch(() => { display("The sign-in could not start on this computer."); finish(1); });
    else runEnterprise("oauth-personal");
  };

  const runEnterprise = (method: "oauth-business" | "oauth-personal") => {
    let gcp: AgentLoginGcp | undefined;
    if (method === "oauth-business") {
      const parsed = AgentLoginGcpSchema.safeParse({ project, location });
      if (!parsed.success) { display("That is not a Google Cloud project ID and location Konteks can use."); finish(1); return; }
      gcp = parsed.data;
      display(REQUIRE_REVIEW_LINE);
      display("If Google asks, sign in in the browser that opens on this computer with the account that holds the Gemini Enterprise licence, then confirm the licence on the page that follows.");
    } else {
      display("If Google asks, sign in in the browser that opens on this computer.");
    }
    step = "running";
    void runGoogleSignIn({
      credentialDir: options.credentialDir, method, ...(gcp ? { gcp } : {}), process: options.process, signal: abort.signal,
      ...(options.signInTimeoutMs === undefined ? {} : { timeoutMs: options.signInTimeoutMs }),
      onLine: (change, signals) => {
        if (change === "google_url" && signals.googleUrl && agentLoginUrlAllowed("antigravity", signals.googleUrl, method === "oauth-business" ? "gemini-enterprise" : "google-account")) {
          emit({ type: "open_url", url: signals.googleUrl });
        } else if (change === "picker") {
          display("Now confirm your Gemini Enterprise licence on the page that opened in the same browser.");
        } else if (change === "no_licence" && gcp) {
          // Shown on this computer only: the project id never goes to the site.
          display(`Google found no Gemini Enterprise licence for ${gcp.project}. Pick another on the licence page, or turn on the Business AI Code API with \`gcloud services enable businessaicode.googleapis.com --project ${gcp.project}\` and sign in again.`);
        }
      },
    }).then(async outcome => {
      if (finished) return;
      if (outcome.outcome === "failed") {
        if (outcome.reason === "no_license" && gcp) await markNoLicence(options.credentialDir, gcp).catch(() => undefined);
        display(outcome.message);
        finish(1, outcome.reason);
        return;
      }
      await recordGoogleSignIn(options.credentialDir, method, outcome);
      options.logger?.info({ event: "antigravity.sign_in.saved", method }, "Google Antigravity signed in");
      display(method === "oauth-business" ? `Signed in to ${geminiEnterpriseCredentialLabel(outcome.tier)}.` : "Signed in with Google.");
      finish(0);
    }).catch(() => {
      display("Google Antigravity could not finish signing in on this computer. Run the sign-in again.");
      finish(1);
    });
  };

  const onKey = (text: string) => {
    const key = text.trim();
    if (key.length === 0) { display("No key was entered. Paste the key, or press Ctrl+C to stop."); askKey(); return; }
    if (!KEY_SHAPE.test(key)) { display("That does not look like an API key. Paste the key from aistudio.google.com/apikey, or press Ctrl+C to stop."); askKey(); return; }
    busy = true;
    keyAttempts += 1;
    void verify(key).then(async verdict => {
      if (finished) return;
      if (verdict === "valid") {
        await writeAntigravityApiKey(options.credentialDir, key);
        const record = await readAntigravitySignIn(options.credentialDir);
        await writeAntigravitySignIn(options.credentialDir, { ...(record ?? {}), method: "gemini-api-key" });
        options.logger?.info({ event: "antigravity.key.saved" }, "Gemini API key saved");
        display("Key saved. Google Antigravity now runs on your Gemini API key.");
        finish(0);
      } else if (verdict === "unreachable") {
        display("Konteks could not reach Google to check the key. Check the connection, then run the sign-in again.");
        finish(1);
      } else if (keyAttempts >= 3) {
        display("Google did not accept the key. Run the sign-in again with a key from aistudio.google.com/apikey.");
        finish(1);
      } else {
        display("Google did not accept that key. Paste it again, or press Ctrl+C to stop.");
        askKey();
      }
    }).catch(() => {
      display("The key could not be saved on this computer. Run the sign-in again.");
      finish(1);
    }).finally(() => { busy = false; });
  };

  if (choice === null) askChoice();
  else begin(choice);

  /** An answer that did not fit is asked again, until there have been too many. */
  const askAgain = (hint: string, again: () => void) => { if (!tooMany()) { display(hint); again(); } };
  const onChoice = (answer: string) => {
    if (answer === "1") begin("key");
    else if (answer === "2") begin("enterprise");
    else askAgain("Type 1 for a Gemini API key or 2 for Gemini Enterprise.", askChoice);
  };
  const onProject = (answer: string) => {
    const value = answer === "" && suggested ? suggested.project : answer;
    if (!GoogleCloudProjectIdSchema.safeParse(value).success) return askAgain("A Google Cloud project ID is 6 to 30 lower-case letters, digits or hyphens, starting with a letter.", askProject);
    project = value;
    if (location === undefined) askLocation(); else runEnterprise("oauth-business");
  };
  const onLocation = (answer: string) => {
    const value = answer === "" ? suggested?.location ?? "global" : answer.toLowerCase();
    if (!GeminiEnterpriseLocationSchema.safeParse(value).success) return askAgain("Type global, us or eu.", askLocation);
    location = value;
    runEnterprise("oauth-business");
  };
  const answers: Partial<Record<Step, (text: string) => void>> = {
    choose: text => onChoice(text.trim()),
    key: onKey,
    project: text => onProject(text.trim()),
    location: text => onLocation(text.trim()),
  };

  return {
    loginId,
    input(text) {
      if (finished || busy) return;
      answers[step]?.(text);
    },
    cancel: async () => { finish(1); },
    done,
  };
}

function loginSetup(options: AntigravityLoginOptions) {
  const released = options.googleSignInReleased ?? ANTIGRAVITY_LOGIN_OPTIONS["google-account"].released;
  return {
    loginId: options.loginId ?? `login-${randomUUID()}`,
    verify: options.verifyKey ?? ((key: string) => verifyGeminiApiKey(key)),
    choice: antigravityLoginChoice(options.request, released),
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    gcp: options.request?.gcp,
  };
}

/** A Google sign-in that went through becomes the method the server uses; Enterprise keeps the project the server resolved and its tier. */
async function recordGoogleSignIn(credentialDir: string, method: "oauth-business" | "oauth-personal", outcome: Extract<GoogleSignInOutcome, { outcome: "signed_in" }>): Promise<void> {
  const record = await readAntigravitySignIn(credentialDir);
  if (method === "oauth-personal") {
    await writeAntigravitySignIn(credentialDir, { ...(record?.gcp ? { gcp: record.gcp } : {}), ...(record?.tier ? { tier: record.tier } : {}), method: "oauth-personal" });
    return;
  }
  await writeAntigravitySignIn(credentialDir, { method: "oauth-business", gcp: outcome.gcp!, ...(outcome.tier ? { tier: outcome.tier } : {}) });
  // A new sign-in may come after the organisation changed its settings: what doctor showed of them is seen afresh.
  await clearAntigravityAdminObservation(credentialDir);
}

/**
 * The server found no Gemini Enterprise licence (at sign-in, or when a
 * session started): the Enterprise credential reads "Needs sign-in" with
 * reason `no_license` until the next sign-in. The method in use is kept.
 */
export async function markNoLicence(credentialDir: string, gcp?: AgentLoginGcp): Promise<void> {
  const record = await readAntigravitySignIn(credentialDir);
  const project = gcp ?? record?.gcp;
  await writeAntigravitySignIn(credentialDir, { ...(record ?? { method: "none" as const }), ...(project ? { gcp: project } : {}), licence: "none" });
}

// ── Identity, credentials, readiness ──────────────────────────────────────────

/** Same file as `FINGERPRINT_KEY_FILE` in auth/identity.ts (kept literal to avoid an import cycle). */
const FINGERPRINT_KEY_FILE = "fingerprint.key";

interface AntigravityHeld {
  record: AntigravitySignIn | null;
  key: boolean;
  enterpriseToken: boolean;
}

/** What the connector holds for Antigravity: its sign-in record, whether a key is stored, whether the server kept an Enterprise token file (never read). */
async function antigravityHeld(credentialDir: string): Promise<AntigravityHeld> {
  const [record, key, enterpriseToken] = await Promise.all([
    readAntigravitySignIn(credentialDir),
    readAntigravityApiKey(credentialDir).then(value => value !== null),
    antigravityTokenPresent(antigravityTokenFiles(credentialDir).business),
  ]);
  return { record, key, enterpriseToken };
}

/**
 * The credentials the connected agent reports: the one in use
 * first. Gemini Enterprise (`google`, `sign_in`, `oauth-business`, labelled
 * by its tier, billed by `classifyAgentBilling` with that tier: a
 * subscription, or pay-per-use for the Pay-as-you-go edition) is ready while
 * the server's token file exists and no licence was found missing; a Gemini
 * API key (`api_key`, `gemini-api-key`, pay-per-use) is ready while stored.
 * `reason: 'no_license'` rides only to a Core that takes it.
 */
export function antigravityCredentialViews(held: AntigravityHeld, settings: Pick<HostAgentSettings, "coreAcceptsRouteBilling">): ConnectedAgentCredential[] {
  const views = [enterpriseCredential(held, settings), keyCredential(held)].filter(view => view !== null);
  return views.sort((a, b) => Number(b.active) - Number(a.active)).map(({ active: _active, ...view }) => view);
}

type CredentialEntry = ConnectedAgentCredential & { active: boolean };

function enterpriseCredential(held: AntigravityHeld, settings: Pick<HostAgentSettings, "coreAcceptsRouteBilling">): CredentialEntry | null {
  const { record } = held;
  if (record?.gcp === undefined || !holdsEnterprise(held)) return null;
  const ready = held.enterpriseToken && record.licence !== "none";
  // `reason: 'no_license'` rides only to a Core that takes it.
  const noLicence = record.licence === "none" && settings.coreAcceptsRouteBilling;
  return {
    providerId: "google", label: geminiEnterpriseCredentialLabel(record.tier), kind: "sign_in", method: "oauth-business",
    billing: enterpriseBilling(record.tier),
    state: ready ? "ready" : "needs_sign_in",
    ...(noLicence ? { reason: "no_license" as const } : {}),
    active: record.method === "oauth-business",
  };
}

/** Gemini Enterprise is billed by its tier: a subscription, or pay-per-use for the Pay-as-you-go edition. */
function enterpriseBilling(tier: string | undefined) {
  return classifyAgentBilling({ agentId: "antigravity", providerId: "google", credential: "sign_in", ...(tier ? { tier } : {}) });
}

/** Anything of Gemini Enterprise the connector holds: its token, its method in use, or a licence found missing. */
function holdsEnterprise(held: AntigravityHeld): boolean {
  return held.enterpriseToken || held.record?.method === "oauth-business" || held.record?.licence === "none";
}

function keyCredential(held: AntigravityHeld): CredentialEntry | null {
  if (!held.key) return null;
  return { providerId: "google", label: "Gemini API key", kind: "api_key", method: "gemini-api-key",
    billing: classifyAgentBilling({ agentId: "antigravity", providerId: "google", credential: "api_key" }), state: "ready", active: held.record?.method === "gemini-api-key" };
}

/** The sign-in the server uses, when what it needs is in place; null otherwise. */
export function antigravityActiveSignIn(held: AntigravityHeld): "gemini-api-key" | "oauth-business" | null {
  const method = held.record?.method;
  if (method === "gemini-api-key") return held.key ? method : null;
  if (method === "oauth-business") return held.enterpriseToken && held.record?.licence !== "none" ? method : null;
  return null;
}

/**
 * The identity signal of what the connector holds, never a secret:
 * a keyed hash of the method in use and, for Gemini Enterprise, the project,
 * location and tier. Nothing ready: signed out, so readiness reads
 * `not_configured` with `login_locally`.
 */
export async function antigravityIdentity(credentialDir: string, settings: Pick<HostAgentSettings, "coreAcceptsRouteBilling">): Promise<{ kind: "signal"; fingerprint: string; credentials: ConnectedAgentCredential[]; tokenUsageObservable: boolean; providerAdminBlocked?: boolean } | { kind: "logged_out"; credentials: ConnectedAgentCredential[] }> {
  const held = await antigravityHeld(credentialDir);
  const credentials = antigravityCredentialViews(held, settings);
  const active = antigravityActiveSignIn(held);
  if (active === null) return { kind: "logged_out", credentials };
  const material = active === "gemini-api-key"
    ? "antigravity\ngemini-api-key"
    : `antigravity\noauth-business\n${held.record!.gcp!.project}\n${held.record!.gcp!.location}\n${held.record!.tier ?? ""}`;
  const key = await readOrCreateSecretFile({ bytes: 32, dataDir: credentialDir, encoding: "base64url", fileName: FINGERPRINT_KEY_FILE });
  // The organisation's MCP Servers setting governs Gemini Enterprise only; a
  // Gemini API key is not held back by it.
  const blocked = active === "oauth-business" && await readAntigravityAdminObservation(credentialDir) !== null;
  return { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), material), credentials, tokenUsageObservable: active === "gemini-api-key", ...(blocked ? { providerAdminBlocked: true } : {}) };
}

// ── Sign-out ──────────────────────────────────────────────────────────────────

/**
 * `konteks-remote auth logout antigravity [--api-key | --enterprise]` (both
 * when neither is named): Gemini Enterprise signs out through ACP `logout`
 * on a process of the connector's own when the server offers it, and its
 * token file is removed whatever the server did; the key is deleted from the
 * connector's store. The project is kept so the next sign-in offers it; the
 * method in use falls back to what is still held.
 */
export async function antigravityLogout(options: { credentialDir: string; request?: HostLoginRequest; process: GoogleSignInProcess }): Promise<void> {
  const which = options.request?.method;
  const { enterprise, apiKey } = logoutTargets(which);
  const held = await antigravityHeld(options.credentialDir);
  if (which !== undefined) assertHeldForLogout(held, enterprise, apiKey);
  if (enterprise) await signOutEnterprise(options, held);
  if (apiKey) await removeAntigravityApiKey(options.credentialDir);
  await writeAntigravitySignIn(options.credentialDir, remainingSignIn(await antigravityHeld(options.credentialDir), enterprise));
}

/** What a sign-out names: both when neither is named. */
function logoutTargets(which: string | undefined): { enterprise: boolean; apiKey: boolean } {
  const enterprise = which === undefined || which === "oauth-business" || which === "enterprise";
  const apiKey = which === undefined || which === "gemini-api-key" || which === "key" || which === "api-key";
  if (!enterprise && !apiKey) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity signs out of its Gemini API key or Gemini Enterprise.");
  return { enterprise, apiKey };
}

function assertHeldForLogout(held: AntigravityHeld, enterprise: boolean, apiKey: boolean): void {
  if (enterprise && !holdsEnterprise(held)) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity is not signed in to Gemini Enterprise on this computer.");
  if (apiKey && !held.key) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity holds no Gemini API key on this computer.");
}

/** ACP `logout` when the server holds a token, then the token file goes whatever the server did. */
async function signOutEnterprise(options: { credentialDir: string; process: GoogleSignInProcess }, held: AntigravityHeld): Promise<void> {
  if (held.enterpriseToken && held.record?.gcp) await acpLogout(options.credentialDir, held.record.gcp, options.process).catch(() => undefined);
  await rm(antigravityTokenFiles(options.credentialDir).business, { force: true });
  await clearAntigravityAdminObservation(options.credentialDir);
}

/** The project is kept so the next sign-in offers it; the method in use falls back to what is still held. */
function remainingSignIn(after: AntigravityHeld, enterpriseSignedOut: boolean): AntigravitySignIn {
  const record = after.record;
  const kept = enterpriseSignedOut ? {} : withoutUndefined({ tier: record?.tier || undefined, licence: record?.licence || undefined });
  return { method: remainingMethod(after), ...withoutUndefined({ gcp: record?.gcp }), ...kept } as AntigravitySignIn;
}

function remainingMethod(after: AntigravityHeld): AntigravitySignIn["method"] {
  if (after.key) return "gemini-api-key";
  return after.enterpriseToken && after.record?.gcp ? "oauth-business" : "none";
}

/** ACP `logout` on a process of the connector's own, with Enterprise's settings in place. */
async function acpLogout(credentialDir: string, gcp: AgentLoginGcp, process: GoogleSignInProcess): Promise<void> {
  const release = holdAntigravityHomeForSignIn(credentialDir);
  const paths = antigravityRuntimePaths(credentialDir);
  let bridge: BridgeProcess | null = null;
  try {
    await prepareAntigravityHome(credentialDir);
    await writeSecretFile(paths.settingsFile, renderAntigravitySettings({ method: "oauth-business", gcp }));
    const refuse = async (): Promise<never> => { throw new RemoteInstanceError("permission_denied", "Nothing runs during a sign-out."); };
    bridge = await process.spawn({
      spec: { ...process.spec, cwd: paths.home }, initializeTimeoutMs: process.initializeTimeoutMs, clientVersion: process.clientVersion,
      handlers: { onSessionUpdate: () => undefined, onRequestPermission: refuse, onCreateElicitation: refuse, onExit: () => undefined },
    });
    if (bridge.initializeResult.agentCapabilities?.auth?.logout == null) return;
    await Promise.race([bridge.connection.logout({}), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("logout timed out")), 30_000).unref())]);
  } finally {
    await bridge?.stop().catch(() => undefined);
    release();
  }
}
