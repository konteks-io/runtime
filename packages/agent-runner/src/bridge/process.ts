import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import {
  RemoteInstanceError,
  captureRetainedProcessOwner,
  createLogger,
  spawnPiped,
  stopProcessGroupLeaderFirst,
  type Logger,
  type PipedChildProcess,
  type RetainedProcessOwner,
} from "@konteks/remote-common";
import { instructionScopeObserver } from "./instruction-scope-observer.js";
import type { BridgeSpawnSpec } from "./spec.js";

/**
 * One pinned bridge process over stdio (D98: `initialize` happens here, once
 * per process, and is never relayed). Adapted from bb's
 * `provider-bridge-acp/bridge/agent-connection.ts` process lifecycle, using
 * the official `@agentclientprotocol/sdk` connection instead of a hand-rolled
 * JSON-RPC loop. Bridge stdout is the protocol stream; stderr is kept as a
 * bounded, redacted tail for diagnostics and is never a heartbeat field.
 */
export interface BridgeClientHandlers {
  onSessionUpdate(params: SessionNotification): void;
  onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onCreateElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void;
}

const STDERR_TAIL_MAX_LINES = 40;

export interface BridgeStopOwner {
  readonly exited: boolean;
  readonly retainedProcessOwner?: RetainedProcessOwner;
  stop(): Promise<void>;
}

export interface BridgeProcess extends BridgeStopOwner {
  readonly connection: ClientSideConnection;
  readonly initializeResult: InitializeResponse;
  readonly exited: boolean;
  readonly stderrTail: () => string[];
  stop(): Promise<void>;
}

export interface SpawnBridgeOptions {
  spec: BridgeSpawnSpec;
  handlers: BridgeClientHandlers;
  initializeTimeoutMs: number;
  clientVersion: string;
  logger?: Logger;
  /** Internally selected execution owner; never a caller-supplied wire field. */
  spawnProcess?: typeof spawnPiped;
  /** Captured synchronously after spawn, before ACP initialization can fail.
   * This is an exact retryable stop handle, not qualified quiescence evidence. */
  onProcessOwner?: (owner: BridgeStopOwner) => void | Promise<void>;
}

export async function spawnBridge(options: SpawnBridgeOptions): Promise<BridgeProcess> {
  const logger = options.logger ?? createLogger({ name: `bridge-${options.spec.family.agentId}` });
  let child: PipedChildProcess;
  try {
    child = (options.spawnProcess ?? spawnPiped)({
      command: options.spec.command,
      args: options.spec.args,
      cwd: options.spec.cwd,
      env: options.spec.env,
      detached: true,
    });
  } catch (error) {
    throw new RemoteInstanceError("agent_unavailable", "bridge could not be spawned", {
      cause: error,
      recoveryActions: [{ kind: "update" }, { kind: "run_doctor" }],
    });
  }
  const stderrLines: string[] = [];
  const observeInstructionScope = instructionScopeObserver(scope => {
    logger.info({ event: "agent.instruction_scope", agentId: options.spec.family.agentId, bridgePid: child.pid, source: "bridge_report", ...scope }, "agent instruction scope applied");
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (options.spec.family.agentId === "claude-code") observeInstructionScope(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      stderrLines.push(line.slice(0, 512));
      if (stderrLines.length > STDERR_TAIL_MAX_LINES) stderrLines.shift();
    }
  });
  let exited = false;
  child.once("exit", (code, signal) => {
    exited = true;
    logger.info({ code, signal }, "bridge exited");
    options.handlers.onExit({ code, signal });
  });
  let retainedProcessOwner: RetainedProcessOwner | undefined;
  try {
    if (process.platform === "darwin" && child.pid !== undefined) retainedProcessOwner = captureRetainedProcessOwner(child.pid);
  } catch (error) {
    await stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
    throw error;
  }
  const processOwner: BridgeStopOwner = {
    get exited() { return exited; },
    ...(retainedProcessOwner ? { retainedProcessOwner } : {}),
    stop: async () => {
      await stopProcessGroupLeaderFirst({ child, timeoutMs: 5_000, killGraceMs: 2_000 });
      // The bounded group helper may finish on its grace timeout. Require
      // actual leader-exit observation; this still does not prove tool/MCP
      // quiescence or authorize release of retained execution capacity.
      if (!exited && child.exitCode === null && child.signalCode === null) {
        throw new RemoteInstanceError("recovery_required", "Bridge process exit remains unconfirmed.");
      }
    },
  };
  try { await options.onProcessOwner?.(processOwner); }
  catch (error) { await processOwner.stop(); throw error; }
  child.stdin.on("error", () => {
    // The connection surfaces the failure through its own rejected requests.
  });

  const client: Client = {
    sessionUpdate: (params) => options.handlers.onSessionUpdate(params),
    requestPermission: (params) => options.handlers.onRequestPermission(params),
    createElicitation: (params) => options.handlers.onCreateElicitation(params),
    // No fs/terminal capabilities are offered: the agent operates inside the
    // component's container boundary through its own tools, never through the
    // runner acting on its behalf.
  };
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = new ClientSideConnection(() => client, stream);

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new RemoteInstanceError("agent_unavailable", `bridge did not answer initialize within ${options.initializeTimeoutMs}ms`, { recoveryActions: [{ kind: "run_doctor" }] })),
      options.initializeTimeoutMs,
    ).unref();
  });
  let initializeResult: InitializeResponse;
  try {
    initializeResult = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "konteks-remote-agent-runner", version: options.clientVersion },
      }),
      timeout,
    ]);
  } catch (error) {
    await stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
    if (error instanceof RemoteInstanceError) throw error;
    throw new RemoteInstanceError("agent_unavailable", "bridge initialize failed", { cause: error, recoveryActions: [{ kind: "update" }] });
  }
  if (initializeResult.protocolVersion !== PROTOCOL_VERSION) {
    await stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
    throw new RemoteInstanceError("protocol_incompatible", `bridge speaks ACP protocol ${initializeResult.protocolVersion}, runner pins ${PROTOCOL_VERSION}`, {
      recoveryActions: [{ kind: "update" }],
    });
  }
  logger.info({ agentId: options.spec.family.agentId }, "bridge initialized");
  return {
    connection,
    initializeResult,
    get exited() {
      return exited;
    },
    stderrTail: () => [...stderrLines],
    stop: processOwner.stop,
  };
}

/** Maps an SDK/JSON-RPC failure to the closed AcpJsonRpcError classification. */
export function classifyBridgeError(error: unknown): {
  code: number;
  class: "cancelled" | "provider_failure" | "agent_auth_required" | "invalid_params" | "unknown_request" | "malformed_response" | "internal";
  message: string;
  retryable: boolean;
} {
  if (error instanceof RequestError) {
    const message = error.message.slice(0, 1_024);
    if (error.code === -32000 || /auth/i.test(message)) {
      return { code: error.code, class: "agent_auth_required", message: "agent authentication required", retryable: false };
    }
    if (error.code === -32602) return { code: error.code, class: "invalid_params", message, retryable: false };
    if (error.code === -32601) return { code: error.code, class: "unknown_request", message, retryable: false };
    if (error.code === -32603) return { code: error.code, class: "internal", message, retryable: false };
    return { code: error.code, class: "provider_failure", message, retryable: true };
  }
  if (error instanceof RemoteInstanceError && error.code === "agent_auth_required") {
    return { code: -32000, class: "agent_auth_required", message: error.message, retryable: false };
  }
  const message = error instanceof Error ? error.message.slice(0, 1_024) : "bridge request failed";
  return { code: -32603, class: "internal", message, retryable: false };
}
