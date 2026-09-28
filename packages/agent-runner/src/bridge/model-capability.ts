import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { RemoteInstanceError, createLogger, type Logger } from "@konteks/remote-common";
import { classifyBridgeError, spawnBridge, type BridgeProcess, type SpawnBridgeOptions } from "./process.js";
import type { BridgeSpawnSpec } from "./spec.js";
import { konteksSessionMetadata } from "../sessions/title.js";
import { orderKnownFirst, recogniseNativeModel } from "@konteks/backstage-plugin-common/known-models";

export interface DiscoverBridgeModelCapabilityOptions {
  configId: string;
  workspaceRoot: string;
  spec: BridgeSpawnSpec;
  initializeTimeoutMs: number;
  clientVersion: string;
  spawn?: typeof spawnBridge;
  /** An idle resident bridge lent by the runtime: used for the one discovery
   * `session/new`, never stopped here, its session closed when the agent can. */
  bridge?: BridgeProcess;
  sessionTimeoutMs?: number;
  logger?: Logger;
  retrySleep?: (delayMs: number) => Promise<void>;
  retryRandom?: () => number;
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
}

/** The most values one snapshot may carry (the Core wire bound). */
export const MAX_OFFERED_MODEL_VALUES = 128;

const unavailable = () => new RemoteInstanceError("agent_unavailable", "ACP model capability discovery was refused or malformed");

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
  const timeoutMs = options.sessionTimeoutMs ?? 10_000;
  const sleep = options.retrySleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const random = options.retryRandom ?? Math.random;
  const rejectDiscoveryRequest = async (): Promise<never> => { throw unavailable(); };
  try {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
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
          bridge.connection.newSession({ cwd, mcpServers: [], _meta: konteksSessionMetadata("Model capability check", options.spec.family.agentId) }),
          deadline,
        ]);
        sessionCreated = true;
        const matches = (created.configOptions ?? []).filter(option => option.id === options.configId);
        const selected = matches[0];
        if (matches.length !== 1 || selected === undefined || selected.type !== "select") throw unavailable();
        const capability = exactSelect(selected, options.spec.family.agentId);
        if (attempt === 1 && options.bridge && options.bridge.initializeResult.agentCapabilities?.sessionCapabilities?.close != null) {
          await options.bridge.connection.closeSession({ sessionId: created.sessionId }).catch(() => undefined);
        }
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
          errorCode: error instanceof RemoteInstanceError ? error.code : "model_discovery_failed" },
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
