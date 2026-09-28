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
  type AntigravitySignIn,
} from "../host/antigravity.js";
import type { LoginEvent, LoginFailureReason, LoginFlow } from "./login-flow.js";

/**
 * Google Antigravity's sign-ins (antigravity-runtime-support A6, A7, A10,
 * CP3), driven by the connector the way the other agents' are:
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
 *   `ANTIGRAVITY_LOGIN_OPTIONS['google-account'].released`, which is off
 *   (A10): never offered, never started.
 */

const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/;
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
/** Google's own sign-in times out after 300 s (CP0); a little more for the licence page. */
export const ANTIGRAVITY_SIGN_IN_TIMEOUT_MS = 330_000;
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

/** Check a key with Google's model list: free, no tokens spent. */
export async function verifyGeminiApiKey(key: string, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<"valid" | "rejected" | "unreachable"> {
  try {
    const response = await (deps.fetch ?? fetch)(MODELS_URL, {
      headers: { "x-goog-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "valid";
    // Google answers a key it does not know with 400 API_KEY_INVALID.
    if (response.status === 400 || response.status === 401 || response.status === 403) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

// ── Gemini Enterprise over ACP ────────────────────────────────────────────────

/** What the server printed during a Google sign-in, read line by line from its stderr. */
export interface GoogleSignInSignals {
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
export function readGoogleSignInLine(line: string, signals: GoogleSignInSignals): "google_url" | "picker" | "no_licence" | "resolved" | null {
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

export type GoogleSignInOutcome =
  | { outcome: "signed_in"; gcp?: AgentLoginGcp; tier?: string }
  | { outcome: "failed"; reason?: LoginFailureReason; message: string };

/**
 * One Google sign-in over ACP on a process of the connector's own (never an
 * execution process, whose stderr reading ends a session at these very
 * lines). `settings.json` names the method (and Enterprise's project) while
 * the server signs in; the home is held so nothing rewrites it meanwhile.
 */
export async function runGoogleSignIn(options: {
  credentialDir: string;
  method: "oauth-business" | "oauth-personal";
  gcp?: AgentLoginGcp;
  process: GoogleSignInProcess;
  onLine: (change: ReturnType<typeof readGoogleSignInLine>, signals: GoogleSignInSignals) => void;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<GoogleSignInOutcome> {
  const release = holdAntigravityHomeForSignIn(options.credentialDir);
  const paths = antigravityRuntimePaths(options.credentialDir);
  const signals: GoogleSignInSignals = { licencePicker: false, noLicence: false, fileStore: false };
  let bridge: BridgeProcess | null = null;
  try {
    await prepareAntigravityHome(options.credentialDir);
    const settings: AntigravitySignIn = options.method === "oauth-business" ? { method: "oauth-business", gcp: options.gcp! } : { method: "oauth-personal" };
    await writeSecretFile(paths.settingsFile, renderAntigravitySettings(settings));
    if (options.signal.aborted) return { outcome: "failed", message: "The sign-in was stopped." };
    const refuse = async (): Promise<never> => { throw new RemoteInstanceError("permission_denied", "Nothing runs during a sign-in."); };
    const spawnOptions: SpawnBridgeOptions = {
      spec: { ...options.process.spec, cwd: paths.home },
      initializeTimeoutMs: options.process.initializeTimeoutMs,
      clientVersion: options.process.clientVersion,
      handlers: { onSessionUpdate: () => undefined, onRequestPermission: refuse, onCreateElicitation: refuse, onExit: () => undefined },
      onStderrLine: line => { const change = readGoogleSignInLine(line, signals); if (change) options.onLine(change, signals); },
    };
    bridge = await options.process.spawn(spawnOptions);
    const started = bridge;
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
      await Promise.race([started.connection.authenticate({ methodId: options.method }), stopped]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // The file store, never the keychain (A5): the token is a file in the private home.
    const tokenFile = options.method === "oauth-business" ? antigravityTokenFiles(options.credentialDir).business : antigravityTokenFiles(options.credentialDir).personal;
    if (!await antigravityTokenPresent(tokenFile)) {
      return { outcome: "failed", message: "Google Antigravity did not keep its sign-in in the connector's private folder, so it was not used." };
    }
    if (options.method === "oauth-personal") return { outcome: "signed_in" };
    // Its "resolved" line (the tier) travels on stderr, which may trail the answer by a moment.
    for (let waited = 0; signals.resolved === undefined && waited < 1_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    return { outcome: "signed_in", gcp: await resolvedGcp(paths.settingsFile, signals, options.gcp!), ...(signals.resolved ? { tier: signals.resolved.tier } : {}) };
  } catch (error) {
    const reason = (error as RequestError | undefined)?.data as { reason?: unknown } | undefined;
    const licence = signals.noLicence || reason?.reason === "ge_license_failed";
    if (error instanceof RemoteInstanceError && /stopped/.test(error.message)) return { outcome: "failed", message: "The sign-in was stopped." };
    if (error instanceof RemoteInstanceError && error.diagnostic === "antigravity_sign_in_timed_out") return { outcome: "failed", ...(licence ? { reason: "no_license" as const } : {}), message: "The sign-in timed out. Run it again when you can finish it in the browser." };
    if (licence) return { outcome: "failed", reason: "no_license", message: "Gemini Enterprise found no licence for this Google Cloud project." };
    if (reason?.reason === "ge_license_cancelled") return { outcome: "failed", message: "The licence page was closed before a licence was chosen. Sign in again to choose one." };
    return { outcome: "failed", message: "Google Antigravity did not finish signing in." };
  } finally {
    await bridge?.stop().catch(() => undefined);
    release();
  }
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

export interface AntigravityLoginOptions {
  credentialDir: string;
  events: RunnerEventBus;
  loginId?: string;
  logger?: Pick<Logger, "info" | "warn">;
  request?: HostLoginRequest;
  /** How the Google sign-in process is started. */
  process: GoogleSignInProcess;
  verifyKey?: (key: string) => Promise<"valid" | "rejected" | "unreachable">;
  /** The whole flow, prompts included (the runner's login timeout). */
  timeoutMs?: number;
  /** Google's own sign-in (300 s). */
  signInTimeoutMs?: number;
  /** Test seam: packages' switch for personal Google sign-in (A10). */
  googleSignInReleased?: boolean;
}

type Choice = "key" | "enterprise" | "personal";
type Step = "choose" | "key" | "project" | "location" | "running" | "done";

/** Which sign-in a request names, or null when the person is asked. Refuses another agent's option and anything held back. */
export function antigravityLoginChoice(request: HostLoginRequest | undefined, googleSignInReleased = ANTIGRAVITY_LOGIN_OPTIONS["google-account"].released): Choice | null {
  const personalRefused = () => new RemoteInstanceError("prerequisite_missing", "Signing Google Antigravity in with a personal Google account is not available on Konteks. Use a Gemini API key or Gemini Enterprise.");
  if (request?.loginOption !== undefined) {
    if (request.loginOption === "gemini-enterprise") return "enterprise";
    if (request.loginOption === "google-account") { if (!googleSignInReleased) throw personalRefused(); return "personal"; }
    throw new RemoteInstanceError("agent_unavailable", "That sign-in is not one of Google Antigravity's.");
  }
  switch (request?.method) {
    case undefined: return request?.gcp !== undefined ? "enterprise" : null;
    case "gemini-api-key": case "key": case "api-key": return "key";
    case "oauth-business": case "enterprise": case "gemini-enterprise": return "enterprise";
    case "oauth-personal": case "google": if (!googleSignInReleased) throw personalRefused(); return "personal";
    default: throw new RemoteInstanceError("agent_unavailable", "Google Antigravity signs in with a Gemini API key or Gemini Enterprise.");
  }
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
  const loginId = options.loginId ?? `login-${randomUUID()}`;
  const verify = options.verifyKey ?? (key => verifyGeminiApiKey(key));
  const released = options.googleSignInReleased ?? ANTIGRAVITY_LOGIN_OPTIONS["google-account"].released;
  const choice = antigravityLoginChoice(options.request, released);
  const abort = new AbortController();
  let step: Step = "choose";
  let busy = false;
  let finished = false;
  let keyAttempts = 0;
  let asks = 0;
  let project: string | undefined = options.request?.gcp?.project;
  let location: string | undefined = options.request?.gcp?.location;
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
  const timer = setTimeout(() => { display("The sign-in timed out. Run it again when you are ready."); finish(1); }, options.timeoutMs ?? 15 * 60_000);
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

  return {
    loginId,
    input(text) {
      if (finished || busy) return;
      const answer = text.trim();
      if (step === "choose") {
        if (answer === "1") begin("key");
        else if (answer === "2") begin("enterprise");
        else if (!tooMany()) { display("Type 1 for a Gemini API key or 2 for Gemini Enterprise."); askChoice(); }
      } else if (step === "key") {
        onKey(text);
      } else if (step === "project") {
        const value = answer === "" && suggested ? suggested.project : answer;
        if (!GoogleCloudProjectIdSchema.safeParse(value).success) { if (!tooMany()) { display("A Google Cloud project ID is 6 to 30 lower-case letters, digits or hyphens, starting with a letter."); askProject(); } return; }
        project = value;
        if (location === undefined) askLocation(); else runEnterprise("oauth-business");
      } else if (step === "location") {
        const value = answer === "" ? suggested?.location ?? "global" : answer.toLowerCase();
        if (!GeminiEnterpriseLocationSchema.safeParse(value).success) { if (!tooMany()) { display("Type global, us or eu."); askLocation(); } return; }
        location = value;
        runEnterprise("oauth-business");
      }
    },
    cancel: async () => { finish(1); },
    done,
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

export interface AntigravityHeld {
  record: AntigravitySignIn | null;
  key: boolean;
  enterpriseToken: boolean;
}

/** What the connector holds for Antigravity: its sign-in record, whether a key is stored, whether the server kept an Enterprise token file (never read). */
export async function antigravityHeld(credentialDir: string): Promise<AntigravityHeld> {
  const [record, key, enterpriseToken] = await Promise.all([
    readAntigravitySignIn(credentialDir),
    readAntigravityApiKey(credentialDir).then(value => value !== null),
    antigravityTokenPresent(antigravityTokenFiles(credentialDir).business),
  ]);
  return { record, key, enterpriseToken };
}

/**
 * The credentials the connected agent reports (CP3 prep): the one in use
 * first. Gemini Enterprise (`google`, `sign_in`, `oauth-business`, labelled
 * by its tier, billed by `classifyAgentBilling` with that tier: a
 * subscription, or pay-per-use for the Pay-as-you-go edition) is ready while
 * the server's token file exists and no licence was found missing; a Gemini
 * API key (`api_key`, `gemini-api-key`, pay-per-use) is ready while stored.
 * `reason: 'no_license'` rides only to a Core that takes it.
 */
export function antigravityCredentialViews(held: AntigravityHeld, settings: Pick<HostAgentSettings, "coreAcceptsRouteBilling">): ConnectedAgentCredential[] {
  const { record } = held;
  const views: Array<ConnectedAgentCredential & { active: boolean }> = [];
  const enterprise = record?.gcp !== undefined && (record.method === "oauth-business" || held.enterpriseToken || record.licence === "none");
  if (enterprise) {
    const ready = held.enterpriseToken && record!.licence !== "none";
    views.push({
      providerId: "google", label: geminiEnterpriseCredentialLabel(record!.tier), kind: "sign_in", method: "oauth-business",
      billing: classifyAgentBilling({ agentId: "antigravity", providerId: "google", credential: "sign_in", ...(record!.tier ? { tier: record!.tier } : {}) }),
      state: ready ? "ready" : "needs_sign_in",
      ...(!ready && record!.licence === "none" && settings.coreAcceptsRouteBilling ? { reason: "no_license" as const } : {}),
      active: record!.method === "oauth-business",
    });
  }
  if (held.key) {
    views.push({ providerId: "google", label: "Gemini API key", kind: "api_key", method: "gemini-api-key",
      billing: classifyAgentBilling({ agentId: "antigravity", providerId: "google", credential: "api_key" }), state: "ready", active: record?.method === "gemini-api-key" });
  }
  return views.sort((a, b) => Number(b.active) - Number(a.active)).map(({ active: _active, ...view }) => view);
}

/** The sign-in the server uses, when what it needs is in place; null otherwise. */
export function antigravityActiveSignIn(held: AntigravityHeld): "gemini-api-key" | "oauth-business" | null {
  const method = held.record?.method;
  if (method === "gemini-api-key") return held.key ? method : null;
  if (method === "oauth-business") return held.enterpriseToken && held.record?.licence !== "none" ? method : null;
  return null;
}

/**
 * The identity signal (D111) of what the connector holds, never a secret:
 * a keyed hash of the method in use and, for Gemini Enterprise, the project,
 * location and tier. Nothing ready: signed out, so readiness reads
 * `not_configured` with `login_locally`.
 */
export async function antigravityIdentity(credentialDir: string, settings: Pick<HostAgentSettings, "coreAcceptsRouteBilling">): Promise<{ kind: "signal"; fingerprint: string; credentials: ConnectedAgentCredential[]; tokenUsageObservable: boolean } | { kind: "logged_out"; credentials: ConnectedAgentCredential[] }> {
  const held = await antigravityHeld(credentialDir);
  const credentials = antigravityCredentialViews(held, settings);
  const active = antigravityActiveSignIn(held);
  if (active === null) return { kind: "logged_out", credentials };
  const material = active === "gemini-api-key"
    ? "antigravity\ngemini-api-key"
    : `antigravity\noauth-business\n${held.record!.gcp!.project}\n${held.record!.gcp!.location}\n${held.record!.tier ?? ""}`;
  const key = await readOrCreateSecretFile({ bytes: 32, dataDir: credentialDir, encoding: "base64url", fileName: FINGERPRINT_KEY_FILE });
  return { kind: "signal", fingerprint: keyedFingerprint(Buffer.from(key, "base64url"), material), credentials, tokenUsageObservable: active === "gemini-api-key" };
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
  const enterprise = which === undefined || which === "oauth-business" || which === "enterprise";
  const apiKey = which === undefined || which === "gemini-api-key" || which === "key" || which === "api-key";
  if (!enterprise && !apiKey) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity signs out of its Gemini API key or Gemini Enterprise.");
  const held = await antigravityHeld(options.credentialDir);
  const holdsEnterprise = held.enterpriseToken || held.record?.method === "oauth-business" || held.record?.licence === "none";
  if (which !== undefined && enterprise && !holdsEnterprise) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity is not signed in to Gemini Enterprise on this computer.");
  if (which !== undefined && apiKey && !held.key) throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity holds no Gemini API key on this computer.");
  if (enterprise && held.enterpriseToken && held.record?.gcp) await acpLogout(options.credentialDir, held.record.gcp, options.process).catch(() => undefined);
  if (enterprise) await rm(antigravityTokenFiles(options.credentialDir).business, { force: true });
  if (enterprise) await clearAntigravityAdminObservation(options.credentialDir);
  if (apiKey) await removeAntigravityApiKey(options.credentialDir);
  const after = await antigravityHeld(options.credentialDir);
  const method = after.key ? "gemini-api-key" : after.enterpriseToken && after.record?.gcp ? "oauth-business" : "none";
  const record = after.record;
  await writeAntigravitySignIn(options.credentialDir, {
    method, ...(record?.gcp ? { gcp: record.gcp } : {}),
    ...(!enterprise && record?.tier ? { tier: record.tier } : {}), ...(!enterprise && record?.licence ? { licence: record.licence } : {}),
  });
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
