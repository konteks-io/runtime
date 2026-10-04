import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ConnectedAgentCredentialSchema,
  MAX_CONNECTED_AGENT_CREDENTIALS,
  OPENCODE_LOGIN_OPTIONS,
  OPENCODE_LOGIN_OPTION_IDS,
  RemoteInstanceError,
  redactText,
  runCommand,
  spawnPiped,
  stopProcessGroupLeaderFirst,
  type ConnectedAgentCredential,
  type Logger,
  type OpenCodeLoginOptionId,
  type PipedChildProcess,
} from "@konteks/remote-common";
import { classifyAgentBilling } from "@konteks/backstage-plugin-common/known-models";
import type { RunnerEventBus } from "../events.js";
import { withoutTerminalEscapes, type LoginEvent, type LoginFlow } from "./login-flow.js";

/**
 * OpenCode 2's own sign-ins, driven by the connector. Everything goes through OpenCode's OWN commands in the private
 * home, with the allow-list environment (never a provider key, token or other
 * credential variable, never an inherited `OPENCODE_*`):
 * - what can be signed in: `opencode api --standalone integration.list`
 *   (machine-readable: integrations, their methods and forms);
 * - what is signed in: `opencode auth list --standalone --format json`
 *   (provider, credential id, label, method; never a secret);
 * - a sign-in: `opencode auth login <provider> --method <id> --standalone`,
 *   its link and device code relayed; an API key goes into OpenCode's OWN key
 *   prompt on a pseudo-terminal (OpenCode refuses key entry without one), typed
 *   by the person into the launcher's hidden prompt: never an argument, never
 *   an environment variable, never a log line or an event;
 * - a sign-out: `opencode auth logout <provider> <credential id> --standalone`.
 * The connector never opens OpenCode's database.
 */

/** How the connector runs one OpenCode command. */
export interface OpenCodeCommandContext {
  /** The person's OpenCode 2 executable (located and version-checked on the install side). */
  binary: string;
  /** The allow-list environment of the private home (`openCodeProcessEnvironment`). */
  env: NodeJS.ProcessEnv;
  /** The private home: never a working copy, so no repository config is in reach. */
  cwd: string;
}

type OpenCodeRun = typeof runCommand;

/** One way to sign an integration in, as the installed OpenCode offers it. */
interface OpenCodeLoginMethod {
  /** OpenCode's `--method` id (`device`, `chatgpt-headless`, `key`, …). */
  id: string;
  kind: "sign_in" | "api_key";
  /** OpenCode's own label ("OpenCode Console account", "API key"). */
  label: string;
  /** Non-secret form answers the method needs, each `key=value` (a default, or the first choice). */
  answers: string[];
}

interface OpenCodeIntegration {
  /** OpenCode's integration id: the provider id its models use (`opencode`, `openai`, `deepseek`). */
  id: string;
  name: string;
  /** Methods the connector can drive (a form field with no default and no choices is left to the person's own OpenCode). */
  methods: OpenCodeLoginMethod[];
}

/** One credential OpenCode keeps for an integration, as `auth list` reports it (no secret). */
export interface OpenCodeStoredCredential {
  integrationId: string;
  integrationName: string;
  credentialId: string;
  /** OpenCode's method word: `oauth` for a sign-in, `key` for an API key. */
  method: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const plain = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && !CONTROL.test(value) ? value.trim().slice(0, max) : undefined;

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in OpenCode's output");
  return JSON.parse(text.slice(start));
}

/** Parse `opencode api integration.list` (`{data: [...]}` or a bare array). */
export function parseOpenCodeIntegrations(stdout: string): OpenCodeIntegration[] {
  return integrationEntries(parseJson(stdout)).flatMap(raw => {
    const integration = parseIntegration(raw);
    return integration ? [integration] : [];
  });
}

function integrationEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/** A plain lower-case provider id, else undefined. */
function providerId(value: unknown): string | undefined {
  const id = plain(value, 64)?.toLowerCase();
  return id && PROVIDER_ID.test(id) ? id : undefined;
}

function parseIntegration(raw: unknown): OpenCodeIntegration | null {
  const entry = raw as { id?: unknown; name?: unknown; methods?: unknown };
  const id = providerId(entry.id);
  if (!id) return null;
  const name = plain(entry.name, 64) ?? id;
  const methods = (Array.isArray(entry.methods) ? entry.methods : []).flatMap(rawMethod => {
    const method = parseLoginMethod(rawMethod, name);
    return method ? [method] : [];
  });
  return { id, name, methods };
}

function parseLoginMethod(raw: unknown, integrationName: string): OpenCodeLoginMethod | null {
  const method = raw as { id?: unknown; type?: unknown; label?: unknown; form?: unknown };
  const answers = formAnswers(method.form);
  if (answers === null) return null;
  if (method.type === "key") return { id: "key", kind: "api_key", label: plain(method.label, 80) ?? "API key", answers };
  if (method.type !== "oauth") return null;
  const methodId = plain(method.id, 64);
  return methodId && /^[A-Za-z0-9._-]+$/.test(methodId) ? { id: methodId, kind: "sign_in", label: plain(method.label, 80) ?? integrationName, answers } : null;
}

type FormField = { key?: unknown; required?: unknown; default?: unknown; hidden?: unknown; options?: unknown; when?: unknown };

/**
 * The non-secret answers a method's form needs so it runs without a
 * terminal: a hidden or defaulted field takes its default, a required choice
 * its first choice (GitHub Copilot: github.com). A required field with no
 * default and no choices (a Snowflake account, a GitHub Enterprise URL) makes
 * the method one the person signs in with in their own OpenCode: null.
 */
function formAnswers(form: unknown): string[] | null {
  const answers: string[] = [];
  for (const field of Array.isArray(form) ? form : []) {
    const answer = fieldAnswer(field as FormField);
    if (answer === null) return null;
    if (answer !== undefined) answers.push(answer);
  }
  return answers;
}

/** One field's `key=value` answer; undefined when it needs none, null when only a terminal could answer it. */
function fieldAnswer(field: FormField): string | null | undefined {
  const key = fieldKey(field.key);
  if (!key) return null;
  if (field.when !== undefined) return undefined; // only asked for another choice (GitHub Enterprise)
  if (field.hidden === true) return undefined; // OpenCode fills it itself
  const fallback = fieldDefault(field);
  if (fallback === undefined) return field.required === true ? null : undefined;
  return CONTROL.test(fallback) || fallback.length > 256 ? null : `${key}=${fallback}`;
}

function fieldKey(value: unknown): string | undefined {
  const key = plain(value, 64);
  return key && /^[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

function fieldDefault(field: FormField): string | undefined {
  if (typeof field.default === "string") return field.default;
  return Array.isArray(field.options) ? plain((field.options[0] as { value?: unknown } | undefined)?.value, 256) : undefined;
}

/** Parse `opencode auth list --format json`: stored credentials only (never an environment one). */
export function parseOpenCodeAuthList(stdout: string): OpenCodeStoredCredential[] {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) throw new Error("OpenCode's credential list is not a list");
  return parsed.flatMap(storedCredentials);
}

function storedCredentials(raw: unknown): OpenCodeStoredCredential[] {
  const entry = raw as { id?: unknown; name?: unknown; connections?: unknown };
  const integrationId = providerId(entry.id);
  if (!integrationId) return [];
  const integrationName = plain(entry.name, 64) ?? integrationId;
  return (Array.isArray(entry.connections) ? entry.connections : []).flatMap(rawConnection => {
    const connection = storedConnection(rawConnection);
    return connection ? [{ integrationId, integrationName, ...connection }] : [];
  });
}

function storedConnection(raw: unknown): { credentialId: string; method: string } | null {
  const connection = raw as { type?: unknown; id?: unknown; method?: unknown };
  if (connection.type !== "credential") return null;
  const credentialId = plain(connection.id, 128);
  if (!credentialId || !/^[A-Za-z0-9_-]+$/.test(credentialId)) return null;
  return { credentialId, method: plain(connection.method, 32)?.toLowerCase() ?? "unknown" };
}

async function runOpenCode(context: OpenCodeCommandContext, args: string[], run: OpenCodeRun = runCommand, timeoutMs = 30_000) {
  const result = await run({ command: context.binary, args, env: context.env, cwd: context.cwd, timeoutMs, outputCapBytes: 1024 * 1024 });
  if (result.code !== 0) {
    throw new RemoteInstanceError("agent_unavailable", `OpenCode's ${args.slice(0, 2).join(" ")} did not complete.`, { recoveryActions: [{ kind: "run_doctor" }] });
  }
  return result.stdout;
}

/** What the installed OpenCode can sign in to (its own machine-readable list). */
export async function listOpenCodeIntegrations(context: OpenCodeCommandContext, run?: OpenCodeRun): Promise<OpenCodeIntegration[]> {
  return parseOpenCodeIntegrations(await runOpenCode(context, ["api", "--standalone", "integration.list"], run));
}

/** What the private home is signed in to. */
export async function listOpenCodeCredentials(context: OpenCodeCommandContext, run?: OpenCodeRun): Promise<OpenCodeStoredCredential[]> {
  return parseOpenCodeAuthList(await runOpenCode(context, ["auth", "list", "--standalone", "--format", "json"], run));
}

/** The reviewed sign-in option an integration's sign-in is (by integration: `auth list` names no method id). */
function reviewedOptionFor(integrationId: string) {
  return Object.values(OPENCODE_LOGIN_OPTIONS).find(option => option.integration === integrationId);
}

/**
 * The credentials the connected agent reports: one per stored
 * credential, a plain label ("ChatGPT Plus or Pro", "DeepSeek key"; never an
 * account), how it signed in, OpenCode's method id when known, and how the
 * provider bills it (`classifyAgentBilling`). `authRequired`: OpenCode refused
 * a credential at the last turn, so none reads ready until the next sign-in.
 */
export function openCodeCredentialViews(stored: readonly OpenCodeStoredCredential[], authRequired = false): ConnectedAgentCredential[] {
  const views: ConnectedAgentCredential[] = [];
  for (const credential of stored) {
    const view = ConnectedAgentCredentialSchema.safeParse(credentialView(credential, authRequired));
    if (view.success) views.push(view.data);
    if (views.length >= MAX_CONNECTED_AGENT_CREDENTIALS) break;
  }
  return views;
}

function credentialView(credential: OpenCodeStoredCredential, authRequired: boolean): unknown {
  const kind = credential.method === "key" || credential.method === "api" ? "api_key" as const : "sign_in" as const;
  const { label, method } = kind === "api_key" ? { label: `${credential.integrationName} key`, method: "key" } : signInLabel(credential);
  return {
    providerId: credential.integrationId, label: label.slice(0, 80), kind, ...(method ? { method } : {}),
    billing: classifyAgentBilling({ agentId: "opencode", providerId: credential.integrationId, credential: kind }),
    state: authRequired ? "needs_sign_in" : "ready",
  };
}

function signInLabel(credential: OpenCodeStoredCredential): { label: string; method: string | undefined } {
  const option = reviewedOptionFor(credential.integrationId);
  return { label: option?.label ?? `${credential.integrationName} sign-in`, method: option?.methodId };
}

/**
 * The identity signal: what `auth list` reports, as (provider, method,
 * credential id) lines, sorted. No secret is part of it. Adding or removing a
 * credential changes it; so does switching free models on with none signed in.
 */
export function openCodeIdentityMaterial(stored: readonly OpenCodeStoredCredential[], freeModels: boolean): string | null {
  if (stored.length === 0) return freeModels ? "opencode\nfree-models" : null;
  return ["opencode", ...stored.map(credential => `${credential.integrationId}\t${credential.method}\t${credential.credentialId}`).sort()].join("\n");
}

/** OpenCode Zen's free models (`opencode/<id>-free`): offered only with the person's say-so. */
export function isOpenCodeFreeModel(value: string): boolean {
  return /^opencode\/[^/\s]+-free$/i.test(value.trim());
}

/** The sign-ins the site may start on this machine, from what the installed OpenCode offers (reviewed options only). */
export function openCodeSiteLoginOptions(integrations: readonly OpenCodeIntegration[]): OpenCodeLoginOptionId[] {
  return OPENCODE_LOGIN_OPTION_IDS.filter(id => {
    const option = OPENCODE_LOGIN_OPTIONS[id];
    return integrations.some(integration => integration.id === option.integration && integration.methods.some(method => method.kind === "sign_in" && method.id === option.methodId));
  });
}

/** `auth logout` for every credential of `provider` (every provider when absent). */
export async function openCodeLogout(context: OpenCodeCommandContext, provider?: string, run?: OpenCodeRun): Promise<number> {
  const wanted = provider?.trim().toLowerCase();
  const stored = await listOpenCodeCredentials(context, run);
  const targets = stored.filter(credential => wanted === undefined || credential.integrationId === wanted);
  if (wanted !== undefined && targets.length === 0) {
    throw new RemoteInstanceError("prerequisite_missing", `OpenCode is not signed in to ${wanted} on this computer.`);
  }
  for (const credential of targets) {
    await runOpenCode(context, ["auth", "logout", credential.integrationId, credential.credentialId, "--standalone"], run);
  }
  return targets.length;
}

// ── The sign-in relay ─────────────────────────────────────────────────────────

/** What the person (or the site) asked to sign in to. */
export interface OpenCodeLoginRequest {
  /** OpenCode's integration id (`--provider`). */
  provider?: string;
  /** OpenCode's method id (`--method`), or `key`. */
  method?: string;
  /** A reviewed option the site started (device or machine-browser methods only). */
  loginOption?: OpenCodeLoginOptionId;
  /** Offer to repeat the sign-ins of the person's own OpenCode. */
  reuse?: boolean;
}

/** The person's own OpenCode, read only through its own `auth list`, only after their yes. */
interface OpenCodePersonalHome {
  /** Their own OpenCode data exists on this computer (nothing is read to know it). */
  exists(): boolean;
  /** What their own OpenCode is signed in to (provider names and kinds). */
  list(): Promise<OpenCodeStoredCredential[]>;
}

interface OpenCodeLoginOptions {
  context: OpenCodeCommandContext;
  events: RunnerEventBus;
  request?: OpenCodeLoginRequest;
  /** The runner's private OpenCode root (`<credentials>/opencode`), where the one-time reuse offer is remembered. */
  stateDir: string;
  loginId?: string;
  logger?: Pick<Logger, "info" | "warn">;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  run?: OpenCodeRun;
  spawn?: typeof spawnPiped;
  personal?: OpenCodePersonalHome;
  /** Before the first command: create the private home (its folders are the commands' working folder). */
  prepare?: () => Promise<void>;
}

const REUSE_OFFERED_FILE = "reuse-offered";
const SPINNER_OR_BOX = /^[\s│┌└├┐┘─◇◆●○◒◐◓◑▲■◼◻▪◉⬡◯◎✔✖✓✗⚠·•…|>]+/u;
const MASK = /^[▪•*·●\s_]+$/u;
const CODE_LINE = /\bcode\b[^A-Za-z0-9]*([A-Za-z0-9]{4,9}(?:-[A-Za-z0-9]{3,9})?)\b/i;
const URL_PATTERN = /https:\/\/[^\s<>"')\]]+/;
const KEY_PROMPT = /\b(api key|key|token|paste)\b/i;

/** The pseudo-terminal wrapper OpenCode's key prompt needs, around `argv` (never carrying the key). */
export function openCodePtyCommand(argv: readonly string[], platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): { command: string; args: string[] } | null {
  if (platform === "win32") return null;
  const script = ["/usr/bin/script", "/bin/script"].find(exists);
  if (!script) return null;
  // The terminal gets a size (OpenCode's prompt draws nothing at 0x0) and no
  // echo; `cat |` gives `script` a real pipe for input (BSD script refuses a socket).
  const setup = "stty rows 40 cols 120 -echo 2>/dev/null";
  const inner = platform === "linux"
    ? [script, "-q", "-e", "-c", `${setup}; exec ${argv.map(shellQuote).join(" ")}`, "/dev/null"]
    : [script, "-q", "/dev/null", "/bin/sh", "-c", `${setup}; exec "$@"`, "sh", ...argv];
  return { command: "/bin/sh", args: ["-c", 'cat | exec "$@"', "sh", ...inner] };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type Step =
  | { kind: "reuse" }
  | { kind: "provider"; choices: Array<{ integration: OpenCodeIntegration; method: OpenCodeLoginMethod }> }
  | { kind: "method"; integration: OpenCodeIntegration }
  | { kind: "key" }
  | { kind: "running" }
  | { kind: "done" };

/**
 * `konteks-remote auth login opencode [--provider X] [--method Y] [--reuse]`
 * and the site's sign-in: one LoginFlow, the same relay contract as Codex's
 * and DeepSeek Harness's. The person picks a provider (subscriptions first)
 * and a method; a subscription's link and code are relayed; an API key is
 * asked for with the launcher's hidden prompt and typed into OpenCode's own
 * key prompt.
 */
export function startOpenCodeLogin(options: OpenCodeLoginOptions): LoginFlow {
  const loginId = options.loginId ?? `login-${randomUUID()}`;
  const request = options.request ?? {};
  let step: Step = { kind: "running" };
  let finished = false;
  let child: PipedChildProcess | null = null;
  let pendingKey: string | null = null;
  let keyPromptSeen = false;
  let typedKey: string | null = null;
  let integrations: OpenCodeIntegration[] = [];
  let reusable: OpenCodeStoredCredential[] = [];
  let resolveDone!: (value: { code: number | null }) => void;
  const done = new Promise<{ code: number | null }>(resolve => { resolveDone = resolve; });
  const publish = (event: LoginEvent) => options.events.publish({ kind: "login_event", loginId, event });
  const display = (text: string) => publish({ type: "display", text: text.slice(0, 16_000) });
  const ask = (label: string, secret: boolean) => publish(secret ? { type: "prompt", label, secret: true } : { type: "prompt", label, secret: false, visible: true });
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    step = { kind: "done" };
    clearTimeout(timer);
    pendingKey = null;
    typedKey = null;
    resolveDone({ code });
  };
  const fail = (text: string) => { display(text); finish(1); };
  const timer = setTimeout(() => {
    display("The sign-in timed out. Run it again when you are ready.");
    if (child) void stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
    finish(1);
  }, options.timeoutMs ?? 15 * 60_000);
  timer.unref();

  const begin = async () => {
    await options.prepare?.();
    integrations = await listOpenCodeIntegrations(options.context, options.run);
    if (request.loginOption !== undefined) return beginReviewedOption(request.loginOption);
    if (request.provider !== undefined) return beginProvider(request.provider);
    if (await offerReuse()) return;
    if (request.reuse === true) display("There is no OpenCode of your own on this computer to reuse sign-ins from.");
    return chooseProvider();
  };

  const beginReviewedOption = (id: OpenCodeLoginOptionId) => {
    const signIn = reviewedSignIn(integrations, id);
    if (!signIn) return fail(`This OpenCode does not offer ${OPENCODE_LOGIN_OPTIONS[id].label} sign-in.`);
    return run(signIn.integration, signIn.method);
  };

  const beginProvider = (provider: string) => {
    const integration = findIntegration(integrations, provider);
    if (!integration) return fail(`OpenCode has no provider called ${provider}. Run \`konteks-remote auth login opencode\` to pick one.`);
    return chooseMethod(integration);
  };

  /** Offers once (or again on --reuse) to read which providers the person's own OpenCode uses. */
  const offerReuse = async (): Promise<boolean> => {
    const offered = existsSync(join(options.stateDir, REUSE_OFFERED_FILE));
    if (!options.personal?.exists() || (request.reuse !== true && offered)) return false;
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(options.stateDir, REUSE_OFFERED_FILE), "offered\n", { mode: 0o600 });
    display("You already use OpenCode on this computer. Konteks keeps its own OpenCode sign-ins, separate from yours.");
    step = { kind: "reuse" };
    ask("Check which providers your own OpenCode is signed in to, so you can sign in to the same ones here? Konteks reads only their names. (yes/no)", false);
    return true;
  };

  const chooseProvider = () => {
    const signIns = OPENCODE_LOGIN_OPTION_IDS.flatMap(id => {
      const signIn = reviewedSignIn(integrations, id);
      return signIn ? [{ integration: signIn.integration, method: { ...signIn.method, label: OPENCODE_LOGIN_OPTIONS[id].label } }] : [];
    });
    // The person's own sign-ins first, when they asked to repeat them.
    const theirs = new Set(reusable.map(credential => credential.integrationId));
    signIns.sort((a, b) => Number(theirs.has(b.integration.id)) - Number(theirs.has(a.integration.id)));
    display(providerMenu(signIns, theirs, reusable));
    step = { kind: "provider", choices: signIns };
    ask("Number or provider id", false);
  };

  const chooseMethod = (integration: OpenCodeIntegration) => {
    const methods = integration.methods;
    const wanted = request.method?.trim();
    if (wanted) return runNamedMethod(integration, wanted);
    if (methods.length === 0) return fail(`${integration.name} needs details only your own OpenCode can ask for. Konteks cannot sign it in yet.`);
    if (methods.length === 1) return run(integration, methods[0]!);
    display([`${integration.name} can sign in these ways:`, ...methods.map((method, index) => `  ${index + 1}. ${method.kind === "api_key" ? "API key" : method.label}`)].join("\n"));
    step = { kind: "method", integration };
    return ask("Number", false);
  };

  const runNamedMethod = (integration: OpenCodeIntegration, wanted: string) => {
    const method = integration.methods.find(candidate => candidate.id === wanted);
    if (!method) return fail(`OpenCode cannot sign ${integration.name} in with "${wanted}" from Konteks. Methods: ${integration.methods.map(candidate => candidate.id).join(", ") || "none"}.`);
    return run(integration, method);
  };

  const run = (integration: OpenCodeIntegration, method: OpenCodeLoginMethod) => {
    const argv = [options.context.binary, "auth", "login", integration.id, "--method", method.id, ...method.answers.flatMap(answer => ["--answer", answer]), "--standalone"];
    const spec = method.kind === "api_key" ? openCodePtyCommand(argv, options.platform ?? process.platform) : { command: argv[0]!, args: argv.slice(1) };
    if (spec === null) return fail("Adding an API key from Konteks needs macOS or Linux for now. Sign in with a subscription instead.");
    const started = startChild(spec);
    if (!started) return fail("OpenCode's sign-in could not be started. Check the installation with `konteks-remote doctor`.");
    child = started;
    options.logger?.info({ event: "opencode.login.started", provider: integration.id, method: method.id, kind: method.kind }, "OpenCode sign-in started");
    if (method.kind === "api_key") {
      step = { kind: "key" };
      display(`OpenCode asks for your ${integration.name} API key. It is typed into OpenCode's own prompt on this computer and never leaves it.`);
      ask(`${integration.name} API key`, true);
    } else {
      step = { kind: "running" };
      started.stdin.end();
    }
    const relay = outputRelay(method);
    started.stdout.setEncoding("utf8");
    started.stderr.setEncoding("utf8");
    started.stdout.on("data", relay);
    started.stderr.on("data", relay);
    started.once("close", exitCode => onExit(integration, method, exitCode));
  };

  const startChild = (spec: { command: string; args: string[] }): PipedChildProcess | null => {
    try {
      return (options.spawn ?? spawnPiped)({ command: spec.command, args: spec.args, cwd: options.context.cwd, env: options.context.env, detached: true });
    } catch {
      return null;
    }
  };

  /** Relays OpenCode's output once per line, never the typed key, and its sign-in link with its code. */
  const outputRelay = (method: OpenCodeLoginMethod) => {
    const seen = new Set<string>();
    const link: { url?: string; code?: string } = {};
    const relayLine = (raw: string) => {
      const line = visibleLine(raw, typedKey);
      if (line === null) return;
      if (method.kind === "api_key" && !keyPromptSeen && KEY_PROMPT.test(line)) { keyPromptSeen = true; sendKey(); }
      const text = redactText(line).slice(0, 4_096);
      const dedupe = text.replace(/\.+$/, "");
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      display(text);
      for (const event of signInLinkEvents(text, link)) publish(event);
    };
    return (chunk: string) => { for (const raw of splitTerminalOutput(chunk)) relayLine(raw); };
  };

  const onExit = (integration: OpenCodeIntegration, method: OpenCodeLoginMethod, exitCode: number | null) => {
    child = null;
    if (finished) return;
    if (exitCode !== 0) return fail(method.kind === "api_key" && typedKey === null ? "No key was entered." : `OpenCode did not finish signing ${integration.name} in.`);
    options.logger?.info({ event: "opencode.login.completed", provider: integration.id, kind: method.kind }, "OpenCode sign-in completed");
    display(method.kind === "api_key" ? `${integration.name} key saved for Konteks' OpenCode.` : `${integration.name} signed in for Konteks' OpenCode.`);
    finish(0);
  };

  const sendKey = () => {
    if (pendingKey === null || !keyPromptSeen || child === null) return;
    const key = pendingKey;
    pendingKey = null;
    typedKey = key;
    // OpenCode's prompt reads the pseudo-terminal raw: carriage return submits.
    // Nothing else is ever typed, so the input closes (the wrapper's `cat`
    // then exits, and the wrapper with OpenCode).
    child.stdin.end(`${key}\r`);
  };

  const onReuseAnswer = async (answer: string) => {
    if (/^y(es)?$/i.test(answer)) {
      try {
        reusable = await options.personal!.list();
        display(reusedSignInsLine(reusable));
      } catch {
        display("Your own OpenCode's sign-ins could not be listed. Pick a provider below.");
      }
    }
    return chooseProvider();
  };

  const onProviderAnswer = (answer: string, choices: Extract<Step, { kind: "provider" }>["choices"]) => {
    const picked = choices[menuIndex(answer)];
    if (picked) return run(picked.integration, picked.method);
    const integration = findIntegration(integrations, answer);
    if (!integration) { display(`OpenCode has no provider called "${answer.slice(0, 64)}".`); return ask("Number or provider id", false); }
    const keyMethod = integration.methods.find(method => method.kind === "api_key");
    // A typed provider id means its key; a provider with only sign-ins asks which.
    return keyMethod && !request.method ? run(integration, keyMethod) : chooseMethod(integration);
  };

  const onMethodAnswer = (answer: string, integration: OpenCodeIntegration) => {
    const method = integration.methods[menuIndex(answer)];
    if (!method) { display("Pick one of the numbers above."); return ask("Number", false); }
    return run(integration, method);
  };

  const onKeyAnswer = (answer: string) => {
    if (answer.length === 0) { display("No key was entered. Paste the key, or press Ctrl+C to stop."); return ask("API key", true); }
    if (answer.length > 4_096 || CONTROL.test(answer)) { display("That does not look like an API key."); return ask("API key", true); }
    pendingKey = answer;
    step = { kind: "running" };
    sendKey();
  };

  const onInput = async (text: string) => {
    const answer = text.trim();
    switch (step.kind) {
      case "reuse": return onReuseAnswer(answer);
      case "provider": return onProviderAnswer(answer, step.choices);
      case "method": return onMethodAnswer(answer, step.integration);
      case "key": return onKeyAnswer(answer);
      default: return;
    }
  };

  void begin().catch(() => fail("OpenCode could not list what it can sign in to. Check the installation with `konteks-remote doctor`."));
  return {
    loginId,
    input(text) {
      // The person's input (a choice, or a key for OpenCode's own prompt) is never logged or echoed.
      if (finished) return;
      void onInput(text).catch(() => fail("The sign-in could not continue. Run it again."));
    },
    cancel: async () => {
      const running = child;
      finish(1);
      if (running) await stopProcessGroupLeaderFirst({ child: running, timeoutMs: 2_000, killGraceMs: 1_000 });
    },
    done,
  };
}

/** A reviewed sign-in option the installed OpenCode offers, with its integration and method. */
function reviewedSignIn(integrations: readonly OpenCodeIntegration[], id: OpenCodeLoginOptionId): { integration: OpenCodeIntegration; method: OpenCodeLoginMethod } | null {
  const option = OPENCODE_LOGIN_OPTIONS[id];
  const integration = integrations.find(candidate => candidate.id === option.integration);
  const method = integration?.methods.find(candidate => candidate.kind === "sign_in" && candidate.id === option.methodId);
  return integration && method ? { integration, method } : null;
}

function providerMenu(signIns: ReadonlyArray<{ integration: OpenCodeIntegration; method: OpenCodeLoginMethod }>, theirs: ReadonlySet<string>, reusable: readonly OpenCodeStoredCredential[]): string {
  const lines = ["Sign OpenCode in on this computer. Subscriptions and accounts this OpenCode offers:",
    ...signIns.map((choice, index) => `  ${index + 1}. ${choice.method.label}${theirs.has(choice.integration.id) ? " (your own OpenCode uses it)" : ""}`),
    "Or add an API key for any provider OpenCode supports: type the provider's id, for example deepseek, anthropic or openrouter."];
  const keyed = reusable.filter(credential => credential.method === "key").map(credential => credential.integrationId);
  if (keyed.length > 0) lines.push(`Your own OpenCode has keys for: ${[...new Set(keyed)].join(", ")}.`);
  return lines.join("\n");
}

function reusedSignInsLine(reusable: readonly OpenCodeStoredCredential[]): string {
  const names = [...new Set(reusable.map(credential => `${credential.integrationName} (${credential.method === "key" ? "key" : "sign-in"})`))];
  return names.length > 0
    ? `Your own OpenCode is signed in to: ${names.join(", ")}. OpenCode cannot copy a sign-in, so sign in to the same ones here.`
    : "Your own OpenCode is not signed in to anything yet.";
}

/** A 1-based menu answer as an index; -1 for anything else. */
function menuIndex(answer: string): number {
  return /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
}

/** A terminal line worth showing: never the typed key, a spinner or box drawing, or a masked echo. */
function visibleLine(raw: string, typedKey: string | null): string | null {
  if (typedKey !== null && raw.includes(typedKey)) return null;
  const line = raw.replace(SPINNER_OR_BOX, "").trim();
  return line.length === 0 || MASK.test(line) ? null : line;
}

/**
 * The `open_url` events a line brings: a new code is sent with the link
 * already seen, a new link with the code already seen.
 */
function signInLinkEvents(text: string, link: { url?: string; code?: string }): LoginEvent[] {
  return [...newCodeEvents(CODE_LINE.exec(text)?.[1], link), ...newLinkEvents(URL_PATTERN.exec(text)?.[0], link)];
}

function newCodeEvents(code: string | undefined, link: { url?: string; code?: string }): LoginEvent[] {
  if (!code || code === link.code) return [];
  link.code = code;
  return link.url ? [{ type: "open_url", url: link.url, userCode: code }] : [];
}

function newLinkEvents(url: string | undefined, link: { url?: string; code?: string }): LoginEvent[] {
  if (!url || url === link.url) return [];
  link.url = url;
  return [{ type: "open_url", url, ...(link.code ? { userCode: link.code } : {}) }];
}

function findIntegration(integrations: readonly OpenCodeIntegration[], value: string): OpenCodeIntegration | undefined {
  const wanted = value.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  return integrations.find(integration => integration.id === wanted) ?? integrations.find(integration => integration.name.toLowerCase() === wanted);
}

/**
 * OpenCode's prompts redraw lines in place (spinners, cursor moves). Every
 * terminal control sequence and carriage return becomes a line break, so each
 * redraw is one short line the relay can de-duplicate.
 */
export function splitTerminalOutput(chunk: string): string[] {
  const marked = chunk.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g, "\n");
  return withoutTerminalEscapes(marked).split(/\r\n|\r|\n/).map(line => line.trimEnd()).filter(line => line.length > 0);
}

/** The person's own OpenCode (their HOME, their XDG folders), read only through `auth list`. */
export function personalOpenCodeHome(options: { binary: string; scratchDir: string; allowList: (home: { home: string; data: string; state: string; cache: string; config: string }) => NodeJS.ProcessEnv; run?: OpenCodeRun; inherited?: NodeJS.ProcessEnv }): OpenCodePersonalHome {
  const folders = personalOpenCodeFolders(options.inherited ?? process.env);
  return {
    exists: () => existsSync(join(folders.data, "opencode", "opencode.db")),
    async list() {
      await mkdir(options.scratchDir, { recursive: true, mode: 0o700 });
      // Their own OpenCode, their own config; still no credential variable of
      // this process, no repository config, and a private server that exits with the command.
      const env = { ...options.allowList(folders), OPENCODE_CONFIG_PROJECT_DISABLE: "1" };
      return listOpenCodeCredentials({ binary: options.binary, env, cwd: options.scratchDir }, options.run);
    },
  };
}

/** The person's own OpenCode folders (their HOME and XDG folders, as OpenCode resolves them). */
function personalOpenCodeFolders(inherited: NodeJS.ProcessEnv): { home: string; data: string; state: string; cache: string; config: string } {
  const home = inherited.HOME && isAbsolute(inherited.HOME) ? inherited.HOME : homedir();
  const xdg = (name: string, fallback: string) => {
    const value = inherited[name];
    return value && isAbsolute(value) ? value : join(home, fallback);
  };
  return { home, data: xdg("XDG_DATA_HOME", join(".local", "share")), state: xdg("XDG_STATE_HOME", join(".local", "state")), cache: xdg("XDG_CACHE_HOME", ".cache"), config: xdg("XDG_CONFIG_HOME", ".config") };
}

/**
 * Whether the person's own OpenCode keeps data (and so, likely, sign-ins) on
 * this machine: the database file's existence only, nothing read. Used
 * by onboarding to name `auth login opencode --reuse`.
 */
export function personalOpenCodeDataExists(inherited: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(personalOpenCodeFolders(inherited).data, "opencode", "opencode.db"));
}
