import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { RemoteInstanceError, createLogger, type Logger } from "@konteks/remote-common";
import { classifyBridgeError, spawnBridge, type BridgeProcess, type SpawnBridgeOptions } from "./process.js";
import type { BridgeSpawnSpec } from "./spec.js";
import { konteksSessionMetadata } from "../sessions/title.js";
import { orderKnownFirst, recogniseNativeModel } from "@konteks/backstage-plugin-common/known-models";
import { readModelOffer, type ModelOffer } from "./model-offer.js";

interface DiscoverBridgeModelCapabilityOptions {
  configId: string;
  workspaceRoot: string;
  spec: BridgeSpawnSpec;
  initializeTimeoutMs: number;
  clientVersion: string;
  spawn?: typeof spawnBridge;
  /** An idle resident bridge lent by the runtime: used for the one discovery
   * `session/new` and its `session/close`. It is stopped here only when that
   * close is not confirmed, because the agent then still holds the session. */
  bridge?: BridgeProcess;
  /** The first attempt's `session/new` deadline; each later attempt waits longer (`discoverySessionTimeoutMs`). */
  sessionTimeoutMs?: number;
  logger?: Logger;
  retrySleep?: (delayMs: number) => Promise<void>;
  retryRandom?: () => number;
  /** The agent's own `session/new` `_meta` (Antigravity's tool filter). */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /** The agent's reading of its stderr (`HostAgentRunnerAdapter.stderrFailure`): a discovery that needs the person fails at once. */
  stderrFailure?: SpawnBridgeOptions["stderrFailure"];
}

/** One offered value as the agent presents it: display name and group (dsh groups by provider). */
export interface DiscoveredModelOption {
  value: string;
  name?: string;
  group?: string;
  groupName?: string;
}

export interface DiscoveredBridgeModelCapability {
  currentValue: string;
  offeredValues: string[];
  /** Parallel to `offeredValues`: same values, same order. */
  offeredOptions: DiscoveredModelOption[];
  /**
   * How long ago the agent gave this answer, when it was given earlier
   * (`AgentRuntime.discoverModelCapability` caches it, and serves the last
   * good one while a refresh runs or after one failed for a transient
   * reason). Absent: just observed.
   */
  observedAgoMs?: number;
}

export const MODEL_DISCOVERY_MIN_SESSION_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_SESSION_TIMEOUT_MS = 120_000;

/**
 * Model discovery is a background check, not a turn: a loaded computer can
 * take well over the session bootstrap deadline to answer `session/new`
 * (Claude Code and Codex have timed out four times at 10 s while signed in
 * and fine). The runtime starts from at least
 * `MODEL_DISCOVERY_MIN_SESSION_TIMEOUT_MS`; each attempt waits twice as long
 * as the one before, up to 2 min, and every attempt stops its own process
 * before the next starts, so the total stays bounded (four attempts, at most
 * one process at a time).
 */
export function discoverySessionTimeoutMs(baseMs: number, attempt: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : MODEL_DISCOVERY_MIN_SESSION_TIMEOUT_MS;
  return Math.min(Math.max(base, MAX_DISCOVERY_SESSION_TIMEOUT_MS), base * 2 ** (attempt - 1));
}
/** How long a lent resident bridge may take to close the discovery session before it is stopped instead. */
const LENT_CLOSE_DEADLINE_MS = 15_000;

/**
 * A discovery failure that says something definite about the agent's offer:
 * it needs signing in, or it refused or malformed the answer. Anything else
 * (a deadline, an internal or provider error, a process that could not
 * start) is transient: the agent may still offer exactly what it last did.
 */
export function definiteModelDiscoveryFailure(error: unknown): boolean {
  if (refusedOrSignedOut(error)) return true;
  const cause = error instanceof RemoteInstanceError && error.cause !== undefined ? error.cause : error;
  if (cause !== error && refusedOrSignedOut(cause)) return true;
  return DEFINITE_BRIDGE_ERRORS.has(classifyBridgeError(cause).class);
}

const DEFINITE_BRIDGE_ERRORS: ReadonlySet<string> = new Set(["agent_auth_required", "invalid_params", "unknown_request", "malformed_response"]);

function refusedOrSignedOut(error: unknown): boolean {
  return (
    error instanceof RemoteInstanceError && (error.code === "agent_auth_required" || error.diagnostic === MODEL_DISCOVERY_REFUSED)
  );
}

/**
 * What may be offered under the agent's settings (OpenCode: Zen's free models
 * only when the person switched them on). A hidden current value gives way
 * to the first offered one; nothing left to offer reads as needing a sign-in.
 */
export function offerableModelCapability(capability: DiscoveredBridgeModelCapability, offers: (value: string) => boolean, family: { agentId: string; displayName: string }): DiscoveredBridgeModelCapability {
  const keep = capability.offeredValues.map(value => offers(value));
  const offeredValues = capability.offeredValues.filter((_, index) => keep[index]);
  if (offeredValues.length === 0) {
    throw new RemoteInstanceError("agent_auth_required", `${family.displayName} has no model it may use here: sign it in, or switch on its free models.`, { recoveryActions: [{ kind: "login_agent", agentId: family.agentId }] });
  }
  return {
    currentValue: offeredValues.includes(capability.currentValue) ? capability.currentValue : offeredValues[0]!,
    offeredValues,
    offeredOptions: capability.offeredOptions.filter((_, index) => keep[index]),
  };
}

/** The most values one snapshot may carry (the Core wire bound). */
export const MAX_OFFERED_MODEL_VALUES = 128;

const MODEL_DISCOVERY_REFUSED = "model_discovery_refused";
const unavailable = () => new RemoteInstanceError("agent_unavailable", "ACP model capability discovery was refused or malformed", { diagnostic: MODEL_DISCOVERY_REFUSED });

/**
 * One non-executing ACP discovery `session/new` in an empty private cwd with
 * no MCP. It never touches a bridge that owns an assignment session: it runs
 * on the idle resident bridge the runtime lends (`options.bridge`, whose
 * client requests the session manager already answers with cancellation for
 * an unknown session) or, when none is idle, on its own isolated process
 * that refuses every bridge-to-client request and is stopped afterwards.
 */
export async function discoverBridgeModelCapability(options: DiscoverBridgeModelCapabilityOptions): Promise<DiscoveredBridgeModelCapability> {
  if (!options.configId || options.configId.length > 256) throw unavailable();
  const cwd = await mkdtemp(join(options.workspaceRoot, ".model-discovery-"));
  await chmod(cwd, 0o700);
  const run = discoveryRun(options, cwd);
  try {
    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt += 1) {
      const capability = await discoveryAttempt(run, attempt);
      if (capability) return capability;
      await retryPause(run, attempt);
    }
    throw unavailable();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const DISCOVERY_ATTEMPTS = 4;

interface DiscoveryRun {
  options: DiscoverBridgeModelCapabilityOptions;
  cwd: string;
  logger: Logger;
  agentId: string;
  baseTimeoutMs: number;
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
}

function discoveryRun(options: DiscoverBridgeModelCapabilityOptions, cwd: string): DiscoveryRun {
  return {
    options, cwd,
    logger: options.logger ?? createLogger({ name: "runner-model-discovery" }),
    agentId: options.spec.family.agentId,
    baseTimeoutMs: options.sessionTimeoutMs ?? 10_000,
    sleep: options.retrySleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs))),
    random: options.retryRandom ?? Math.random,
  };
}

/** One attempt's bridge: the lent one on the first attempt, else a process of its own (`spawned`). */
interface AttemptState {
  bridge: BridgeProcess | null;
  spawned: BridgeProcess | null;
  bridgeAcquired: boolean;
  sessionCreated: boolean;
  stopped: boolean;
}

/** The capability, or null when the attempt failed in a way worth another one (it already stopped its process). */
async function discoveryAttempt(run: DiscoveryRun, attempt: number,
): Promise<DiscoveredBridgeModelCapability | null> {
  const { options } = run;
  const timeoutMs = discoverySessionTimeoutMs(run.baseTimeoutMs, attempt);
  // Only the first attempt uses the lent bridge; a retry always gets a fresh process.
  const lent = attempt === 1 && options.bridge ? options.bridge : null;
  const state: AttemptState = { bridge: lent, spawned: null, bridgeAcquired: lent !== null, sessionCreated: false, stopped: false };
  const deadline = sessionDeadline(timeoutMs);
  try {
    const bridge = state.bridge ?? (await spawnDiscoveryBridge(run, state));
    const created = await Promise.race([
      bridge.connection.newSession({ cwd: run.cwd, mcpServers: [], _meta: { ...konteksSessionMetadata("Model capability check", run.agentId), ...options.sessionMeta } }),
      deadline.start(),
      ...failureOf(bridge),
    ]);
    state.sessionCreated = true;
    const capability = exactSelect(selectedConfigOption(created.configOptions, options.configId), run.agentId);
    if (lent) await closeLentSession(lent, created.sessionId, run.logger, run.agentId);
    return capability;
  } catch (error) {
    await failedAttempt(run, state, error, attempt, timeoutMs);
    return null;
  } finally {
    deadline.clear();
    if (state.spawned && !state.stopped) await state.spawned.stop().catch(() => undefined);
  }
}

function failureOf(bridge: BridgeProcess): Promise<never>[] {
  return bridge.failure ? [bridge.failure] : [];
}

/** An isolated process that refuses every bridge-to-client request. */
async function spawnDiscoveryBridge(run: DiscoveryRun, state: AttemptState): Promise<BridgeProcess> {
  const { options } = run;
  const rejectDiscoveryRequest = async (): Promise<never> => { throw unavailable(); };
  const spawnOptions: SpawnBridgeOptions = {
    spec: options.spec,
    initializeTimeoutMs: options.initializeTimeoutMs,
    clientVersion: options.clientVersion,
    logger: run.logger,
    handlers: {
      onSessionUpdate: () => undefined,
      onRequestPermission: rejectDiscoveryRequest,
      onCreateElicitation: rejectDiscoveryRequest,
      onExit: () => undefined,
    },
    ...(options.stderrFailure ? { stderrFailure: options.stderrFailure } : {}),
  };
  const bridge = await (options.spawn ?? spawnBridge)(spawnOptions);
  state.spawned = state.bridge = bridge;
  state.bridgeAcquired = true;
  return bridge;
}

/** The `session/new` deadline, started once the bridge is up. */
function sessionDeadline(timeoutMs: number): { start(): Promise<never>; clear(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    start: () => new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RemoteInstanceError("agent_unavailable", "ACP model discovery session deadline elapsed.", {
        retryable: true, diagnostic: "model_discovery_session_new_deadline",
      })), timeoutMs);
      timer.unref();
    }),
    clear: () => { if (timer) clearTimeout(timer); },
  };
}

/** Exactly one select option with the configured id. */
function selectedConfigOption(configOptions: SessionConfigOption[] | null | undefined, configId: string): Extract<SessionConfigOption, { type: "select" }> {
  const matches = (configOptions ?? []).filter(option => option.id === configId);
  const selected = matches[0];
  if (matches.length !== 1 || selected === undefined || selected.type !== "select") throw unavailable();
  return selected;
}

/**
 * A failed attempt stops its process when another may follow (or when the
 * process was its own), logs what the agent said, and throws once no attempt
 * is left or the failure is not worth retrying.
 */
async function failedAttempt(run: DiscoveryRun, state: AttemptState, error: unknown, attempt: number, timeoutMs: number): Promise<void> {
  const classified = classifyBridgeError(error);
  const retryable = attemptRetryable(state, error, classified.retryable);
  const stopConfirmed = await stopAfterFailure(run, state, retryable, attempt, timeoutMs);
  const exhausted = !retryable || attempt === DISCOVERY_ATTEMPTS;
  run.logger.warn({ agentId: run.agentId, attempt, maxAttempts: DISCOVERY_ATTEMPTS, timeoutMs, stopConfirmed,
    retryable, exhausted, errorClass: classified.class,
    errorCode: error instanceof RemoteInstanceError ? error.code : "model_discovery_failed",
    // What the agent said, so a failure that repeats can be told apart.
    acpCode: classified.code, reason: logReason(classified.message) },
  "ACP model capability discovery attempt failed");
  if (!exhausted) return;
  if (error instanceof RemoteInstanceError) throw error;
  throw new RemoteInstanceError("agent_unavailable", "ACP model capability discovery failed", { cause: error });
}

/** Retried only before a session exists: a bridge that never came up, or a transient answer. */
function attemptRetryable(state: AttemptState, error: unknown, classifiedRetryable: boolean,
): boolean {
  if (state.sessionCreated) return false;
  if (!state.bridgeAcquired || classifiedRetryable) return true;
  return (
    error instanceof RemoteInstanceError && (error.retryable || error.code === "agent_unavailable")
  );
}

/** Whether the attempt's process is known to be stopped; an unconfirmed stop needs recovery. */
async function stopAfterFailure(run: DiscoveryRun, state: AttemptState, retryable: boolean, attempt: number, timeoutMs: number): Promise<boolean> {
  if (!retryable && state.spawned === null) return true;
  if (!state.bridge) return false;
  try {
    await state.bridge.stop();
    state.stopped = true;
    return true;
  } catch (stopError) {
    run.logger.error({ agentId: run.agentId, attempt, timeoutMs, stopConfirmed: false,
      errorClass: classifyBridgeError(stopError).class,
      errorCode: stopError instanceof RemoteInstanceError ? stopError.code : "bridge_stop_failed" },
    "model discovery bridge stop is unconfirmed");
    throw new RemoteInstanceError("recovery_required", "Model discovery bridge stop is unconfirmed.", {
      diagnostic: "model_discovery_stop_unconfirmed", cause: stopError,
    });
  }
}

/** Exponential backoff with jitter before a fresh bridge tries again. */
async function retryPause(run: DiscoveryRun, attempt: number): Promise<void> {
  const exponentialMs = 500 * 2 ** (attempt - 1);
  const delayMs = Math.min(2_000, Math.max(1, Math.round(exponentialMs * (0.75 + run.random() * 0.5))),
  );
  run.logger.warn({ agentId: run.agentId, attempt, nextAttempt: attempt + 1, maxAttempts: DISCOVERY_ATTEMPTS, delayMs,
    recovery: "fresh_bridge" }, "retrying model capability discovery with exponential backoff");
  await run.sleep(delayMs);
}

/**
 * Close the discovery session on a lent resident bridge. The agent keeps a
 * session it was never told to close (Claude Code: a `claude` child), and the
 * runtime parks the bridge again for the next turn, so a close that is not
 * confirmed stops the bridge: the runtime then never parks it.
 */
async function closeLentSession(bridge: BridgeProcess, sessionId: string, logger: Logger, agentId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close == null) throw new Error("the agent cannot close sessions");
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("discovery session close deadline elapsed")), LENT_CLOSE_DEADLINE_MS);
      timer.unref();
    });
    await Promise.race([bridge.connection.closeSession({ sessionId }), deadline]);
  } catch (error) {
    logger.warn({ agentId, errorClass: classifyBridgeError(error).class }, "the resident process did not confirm closing the model discovery session; stopping it");
    await bridge.stop().catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One line of an agent's error for the log: bounded, control characters and home folders taken out. */
function logReason(message: string): string {
  return [...message].filter(char => !isControl(char.codePointAt(0) ?? 0)).join("")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "~").slice(0, 200);
}

function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** A display label safe for the wire: no control characters, at most 128 characters. */
function label(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const cleaned = [...text].map(char => (isControl(char.charCodeAt(0)) ? " " : char)).join("").trim().slice(0, 128);
  return cleaned.length > 0 ? cleaned : undefined;
}

function validValue(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256
    && ![...value].some(char => isControl(char.charCodeAt(0))));
}

/**
 * Every option the agent offers, with its name and group. Malformed entries and repeats are skipped rather than failing the
 * whole report. Above the wire bound the known models come first, then the
 * recognised, so a DeepSeek Harness fronting many providers still reports
 * what Konteks can price; the current value is always kept.
 */
function discoveryModelOffer(
  option: Extract<SessionConfigOption, { type: "select" }>, agentId: string,
): ModelOffer | null {
  const requireRaw = agentId === "codex" && option.id === "model";
  if (!requireRaw && option._meta?.konteksModelOffer === undefined) return null;
  const authority = readModelOffer(option, requireRaw);
  if (authority.currentValue === null) throw unavailable();
  return authority;
}

function valueOffered(authority: ModelOffer | null, value: string): boolean {
  return authority === null || authority.values.has(value);
}

function discoveredOption(
  entry: SessionConfigSelectOption,
  group: { group: string; name: string } | undefined,
): DiscoveredModelOption {
  const name = label(entry.name);
  const groupId = group ? label(group.group) : undefined;
  const groupName = group ? label(group.name) : undefined;
  return { value: entry.value, ...(name ? { name } : {}), ...(groupId ? { group: groupId } : {}), ...(groupName ? { groupName } : {}) };
}

function boundedOptions(
  all: DiscoveredModelOption[],
  currentValue: string,
  agentId: string,
): DiscoveredModelOption[] {
  if (all.length <= MAX_OFFERED_MODEL_VALUES) return all;
  const ranked = orderKnownFirst(all.map(entry => ({ entry, status: recogniseNativeModel(agentId, entry.value).status })));
  const current = ranked.find((item) => item.entry.value === currentValue)!;
  const kept = new Set([current, ...ranked.filter(item => item !== current).slice(0, MAX_OFFERED_MODEL_VALUES - 1)]
      .map(item => item.entry));
  // Keep the agent's own order among what is kept.
  return all.filter(entry => kept.has(entry));
}

export function exactSelect(option: Extract<SessionConfigOption, { type: "select" }>, agentId: string,
): DiscoveredBridgeModelCapability {
  const authority = discoveryModelOffer(option, agentId);
  const currentValue = authority?.currentValue ?? option.currentValue;
  if (!validValue(currentValue)) throw unavailable();
  const seen = new Set<string>();
  const all: DiscoveredModelOption[] = [];
  const add = (entry: SessionConfigSelectOption, group?: { group: string; name: string }) => {
    if (!validValue(entry.value) || seen.has(entry.value) || !valueOffered(authority, entry.value)) return;
    seen.add(entry.value);
    all.push(discoveredOption(entry, group));
  };
  for (const entry of option.options) {
    if ("value" in entry) add(entry);
    else for (const nested of entry.options) add(nested, { group: entry.group, name: entry.name });
  }
  if (!seen.has(currentValue)) throw unavailable();
  const offered = boundedOptions(all, currentValue, agentId);
  return {
    currentValue,
    offeredValues: offered.map(entry => entry.value),
    offeredOptions: offered,
  };
}
