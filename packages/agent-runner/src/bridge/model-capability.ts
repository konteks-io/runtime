import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { RemoteInstanceError, createLogger, type Logger } from "@konteks/remote-common";
import { classifyBridgeError, spawnBridge, type BridgeProcess, type SpawnBridgeOptions } from "./process.js";
import type { BridgeSpawnSpec } from "./spec.js";
import { konteksSessionMetadata } from "../sessions/title.js";
import { orderKnownFirst, recogniseNativeModel } from "@konteks/backstage-plugin-common/known-models";

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
 * (2026-10-02: Claude Code and Codex both timed out four times at 10 s while
 * signed in and fine). The runtime starts from at least
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
  if (error instanceof RemoteInstanceError && (error.code === "agent_auth_required" || error.diagnostic === MODEL_DISCOVERY_REFUSED)) return true;
  const cause = error instanceof RemoteInstanceError && error.cause !== undefined ? error.cause : error;
  if (cause !== error && cause instanceof RemoteInstanceError && (cause.code === "agent_auth_required" || cause.diagnostic === MODEL_DISCOVERY_REFUSED)) return true;
  const kind = classifyBridgeError(cause).class;
  return kind === "agent_auth_required" || kind === "invalid_params" || kind === "unknown_request" || kind === "malformed_response";
}

/**
 * What may be offered under the agent's settings (OpenCode: Zen's free models
 * only when the person switched them on, O6). A hidden current value gives way
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
  const logger = options.logger ?? createLogger({ name: "runner-model-discovery" });
  const baseTimeoutMs = options.sessionTimeoutMs ?? 10_000;
  const sleep = options.retrySleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const random = options.retryRandom ?? Math.random;
  const rejectDiscoveryRequest = async (): Promise<never> => { throw unavailable(); };
  try {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const timeoutMs = discoverySessionTimeoutMs(baseTimeoutMs, attempt);
      let bridge = attempt === 1 ? options.bridge ?? null : null;
      let bridgeAcquired = bridge !== null;
      let spawned: BridgeProcess | null = null;
      let timer: NodeJS.Timeout | undefined;
      let sessionCreated = false;
      let stopped = false;
      try {
        if (!bridge) {
          const spawnOptions: SpawnBridgeOptions = {
            spec: options.spec,
            initializeTimeoutMs: options.initializeTimeoutMs,
            clientVersion: options.clientVersion,
            logger,
            handlers: {
              onSessionUpdate: () => undefined,
              onRequestPermission: rejectDiscoveryRequest,
              onCreateElicitation: rejectDiscoveryRequest,
              onExit: () => undefined,
            },
            ...(options.stderrFailure ? { stderrFailure: options.stderrFailure } : {}),
          };
          spawned = bridge = await (options.spawn ?? spawnBridge)(spawnOptions);
          bridgeAcquired = true;
        }
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RemoteInstanceError("agent_unavailable", "ACP model discovery session deadline elapsed.", {
            retryable: true, diagnostic: "model_discovery_session_new_deadline",
          })), timeoutMs);
          timer.unref();
        });
        const created = await Promise.race([
          bridge.connection.newSession({ cwd, mcpServers: [], _meta: { ...konteksSessionMetadata("Model capability check", options.spec.family.agentId), ...options.sessionMeta } }),
          deadline,
          ...(bridge.failure ? [bridge.failure] : []),
        ]);
        sessionCreated = true;
        const matches = (created.configOptions ?? []).filter(option => option.id === options.configId);
        const selected = matches[0];
        if (matches.length !== 1 || selected === undefined || selected.type !== "select") throw unavailable();
        const capability = exactSelect(selected, options.spec.family.agentId);
        if (attempt === 1 && options.bridge) await closeLentSession(options.bridge, created.sessionId, logger, options.spec.family.agentId);
        return capability;
      } catch (error) {
        const classified = classifyBridgeError(error);
        const retryable = !sessionCreated && (!bridgeAcquired ||
          (error instanceof RemoteInstanceError && (error.retryable || error.code === "agent_unavailable")) || classified.retryable);
        const mustStop = retryable || spawned !== null;
        let stopConfirmed = !mustStop;
        if (mustStop && bridge) {
          try { await bridge.stop(); stopped = true; stopConfirmed = true; }
          catch (stopError) {
            logger.error({ agentId: options.spec.family.agentId, attempt, timeoutMs, stopConfirmed: false,
              errorClass: classifyBridgeError(stopError).class,
              errorCode: stopError instanceof RemoteInstanceError ? stopError.code : "bridge_stop_failed" },
            "model discovery bridge stop is unconfirmed");
            throw new RemoteInstanceError("recovery_required", "Model discovery bridge stop is unconfirmed.", {
              diagnostic: "model_discovery_stop_unconfirmed", cause: stopError,
            });
          }
        }
        const exhausted = !retryable || attempt === 4;
        logger.warn({ agentId: options.spec.family.agentId, attempt, maxAttempts: 4, timeoutMs, stopConfirmed,
          retryable, exhausted, errorClass: classified.class,
          errorCode: error instanceof RemoteInstanceError ? error.code : "model_discovery_failed",
          // What the agent said, so a failure that repeats can be told apart
          // (WS1-216: Codex failed as "internal" every five minutes, unexplained).
          acpCode: classified.code, reason: logReason(classified.message) },
        "ACP model capability discovery attempt failed");
        if (exhausted) {
          if (error instanceof RemoteInstanceError) throw error;
          throw new RemoteInstanceError("agent_unavailable", "ACP model capability discovery failed", { cause: error });
        }
        const exponentialMs = 500 * (2 ** (attempt - 1));
        const delayMs = Math.min(2_000, Math.max(1, Math.round(exponentialMs * (0.75 + (random() * 0.5)))));
        logger.warn({ agentId: options.spec.family.agentId, attempt, nextAttempt: attempt + 1, maxAttempts: 4, delayMs,
          recovery: "fresh_bridge" }, "retrying model capability discovery with exponential backoff");
        await sleep(delayMs);
      } finally {
        if (timer) clearTimeout(timer);
        if (spawned && !stopped) await spawned.stop().catch(() => undefined);
      }
    }
    throw unavailable();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && ![...value].some(char => isControl(char.charCodeAt(0)));
}

/**
 * Every option the agent offers, with its name and group (System One §6a,
 * KM6). Malformed entries and repeats are skipped rather than failing the
 * whole report. Above the wire bound the known models come first, then the
 * recognised, so a DeepSeek Harness fronting many providers still reports
 * what Konteks can price; the current value is always kept.
 */
export function exactSelect(option: Extract<SessionConfigOption, { type: "select" }>, agentId: string): DiscoveredBridgeModelCapability {
  if (!validValue(option.currentValue)) throw unavailable();
  const seen = new Set<string>();
  const all: DiscoveredModelOption[] = [];
  const add = (entry: SessionConfigSelectOption, group?: { group: string; name: string }) => {
    if (!validValue(entry.value) || seen.has(entry.value)) return;
    seen.add(entry.value);
    const name = label(entry.name);
    const groupId = group ? label(group.group) : undefined;
    const groupName = group ? label(group.name) : undefined;
    all.push({ value: entry.value, ...(name ? { name } : {}), ...(groupId ? { group: groupId } : {}), ...(groupName ? { groupName } : {}) });
  };
  for (const entry of option.options) {
    if ("value" in entry) add(entry);
    else for (const nested of entry.options) add(nested, { group: entry.group, name: entry.name });
  }
  if (!seen.has(option.currentValue)) throw unavailable();
  let offered = all;
  if (all.length > MAX_OFFERED_MODEL_VALUES) {
    const ranked = orderKnownFirst(all.map(entry => ({ entry, status: recogniseNativeModel(agentId, entry.value).status })));
    const current = ranked.find(item => item.entry.value === option.currentValue)!;
    const kept = new Set([current, ...ranked.filter(item => item !== current).slice(0, MAX_OFFERED_MODEL_VALUES - 1)]
      .map(item => item.entry));
    // Keep the agent's own order among what is kept.
    offered = all.filter(entry => kept.has(entry));
  }
  return {
    currentValue: option.currentValue,
    offeredValues: offered.map(entry => entry.value),
    offeredOptions: offered,
  };
}
