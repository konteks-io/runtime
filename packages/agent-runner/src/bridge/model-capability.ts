import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { RemoteInstanceError, createLogger, type Logger } from "@konteks/remote-common";
import { classifyBridgeError, spawnBridge, type BridgeProcess, type SpawnBridgeOptions } from "./process.js";
import type { BridgeSpawnSpec } from "./spec.js";
import { konteksSessionMetadata } from "../sessions/title.js";

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

export interface DiscoveredBridgeModelCapability {
  currentValue: string;
  offeredValues: string[];
}

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
        const capability = exactSelect(selected);
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

function exactSelect(option: Extract<SessionConfigOption, { type: "select" }>): DiscoveredBridgeModelCapability {
  const flattened: SessionConfigSelectOption[] = [];
  if (option.options.length > 128) throw unavailable();
  for (const entry of option.options) {
    if ("value" in entry) flattened.push(entry);
    else {
      if (entry.options.length > 128 || flattened.length + entry.options.length > 128) throw unavailable();
      flattened.push(...entry.options);
    }
  }
  const offeredValues = flattened.map(entry => entry.value);
  if (offeredValues.length === 0 || offeredValues.some(value => value.length === 0 || value.length > 256)
    || new Set(offeredValues).size !== offeredValues.length || !offeredValues.includes(option.currentValue)) throw unavailable();
  return { currentValue: option.currentValue, offeredValues };
}
