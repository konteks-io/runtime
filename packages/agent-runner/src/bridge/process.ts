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
  isProcessGroupAlive,
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
  /**
   * Rejects once the agent printed a line its host adapter reads as "cannot
   * go on without the person" (`stderrFailure`); never settles otherwise.
   */
  readonly failure?: Promise<never>;
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
  /** A host agent's reading of its stderr lines (`HostAgentRunnerAdapter.stderrFailure`). */
  stderrFailure?: (line: string) => RemoteInstanceError | null;
  /**
   * Every complete stderr line, as it arrives (a sign-in driven over ACP
   * reads the link and the result the agent prints there). Never logged.
   */
  onStderrLine?: (line: string) => void;
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
  let failWith: ((error: RemoteInstanceError) => void) | null = null;
  const failure = options.stderrFailure ? new Promise<never>((_resolve, reject) => { failWith = reject; }) : undefined;
  // Observed through races only; never an unhandled rejection of its own.
  void failure?.catch(() => undefined);
  let partial = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (options.spec.family.agentId === "claude-code") observeInstructionScope(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      stderrLines.push(line.slice(0, 512));
      if (stderrLines.length > STDERR_TAIL_MAX_LINES) stderrLines.shift();
    }
    if (options.onStderrLine || (options.stderrFailure && failWith)) {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = (lines.pop() ?? "").slice(-4_096);
      for (const line of lines) {
        if (line && options.onStderrLine) {
          try { options.onStderrLine(line.slice(0, 4_096)); } catch { /* an observer never breaks the process */ }
        }
        if (!options.stderrFailure || !failWith) continue;
        const refusal = line ? options.stderrFailure(line.slice(0, 4_096)) : null;
        if (refusal && failWith) {
          const fail: (error: RemoteInstanceError) => void = failWith;
          failWith = null;
          logger.warn({ agentId: options.spec.family.agentId, errorCode: refusal.code, diagnostic: refusal.diagnostic }, "the agent cannot go on without the person");
          fail(refusal);
          break;
        }
      }
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
      if (isProcessGroupAlive(child)) {
        throw new RemoteInstanceError("recovery_required", "Bridge process group exit remains unconfirmed.");
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
    // No fs/terminal capabilities are offered: the agent operates inside its
    // working copy through its own tools, which Konteks governs, never through
    // the runner acting on its behalf. An agent that calls them anyway gets
    // "method not found" (the SDK would otherwise answer a write with an empty
    // success and a read with nothing).
    readTextFile: async () => { throw RequestError.methodNotFound("fs/read_text_file"); },
    writeTextFile: async () => { throw RequestError.methodNotFound("fs/write_text_file"); },
    createTerminal: async () => { throw RequestError.methodNotFound("terminal/create"); },
    terminalOutput: async () => { throw RequestError.methodNotFound("terminal/output"); },
    releaseTerminal: async () => { throw RequestError.methodNotFound("terminal/release"); },
    waitForTerminalExit: async () => { throw RequestError.methodNotFound("terminal/wait_for_exit"); },
    killTerminal: async () => { throw RequestError.methodNotFound("terminal/kill"); },
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
    ...(failure ? { failure } : {}),
    stop: processOwner.stop,
  };
}

/**
 * Codex reports a sign-in it can no longer refresh as a JSON-RPC internal
 * error (-32603) whose data says "unauthorized"; read as "internal" it
 * surfaced as "the provider call failed" instead of "sign in again" (WS2-141).
 */
/**
 * DeepSeek Harness reports a missing or unusable API key as a failed turn
 * (-32603) whose text names neither auth nor a status; these are its exact
 * llm-deepseek messages (dsh-runtime-support CP0 #7). A revoked key already
 * reads "Authentication Fails".
 */
const DSH_KEY_MISSING = /llm-deepseek: (?:no API key for provider route|the API key resolved from \S+ contains characters no HTTP header can carry)/;

/**
 * DeepSeek Harness's own adapter wording for a provider it could not reach
 * or that sent nothing (dsh 0.1.7-rc.2 llm-deepseek/src/adapter.ts). The ACP
 * error drops dsh's stable failure code, so these fixed messages are all a
 * client can route on until dsh forwards the code.
 */
const DSH_PROVIDER_FAILURE = /turn failed: DeepSeek Messages (?:stream idle timeout|transport failed|returned no response body)$/;

type BridgeErrorClass = ReturnType<typeof classifyBridgeError>;

/**
 * OpenCode 2 fails a turn as JSON-RPC -32603 whose data names the failure:
 * `{ service: "session", errorName: "provider.<reason>" }` (CP0-v2: an empty
 * Zen balance was `provider.quota`, a model outside the account
 * `provider.no-route`); a failed sign-in is ACP's auth-required error. The
 * provider's HTTP status is not forwarded, so 429 arrives as
 * `provider.rate-limit` and 5xx as `provider.internal`, `timeout` or
 * `transport`. Wording is for the person, plain and short.
 */
const OPENCODE_PROVIDER_ERRORS: Readonly<Record<string, { class: BridgeErrorClass["class"]; message: string; retryable: boolean }>> = {
  "provider.auth": { class: "agent_auth_required", message: "agent authentication required", retryable: false },
  "provider.quota": { class: "provider_failure", message: "The provider account OpenCode uses is out of credit. Add credit or pick another model.", retryable: false },
  "provider.no-route": { class: "provider_failure", message: "This model is not available to the account OpenCode is signed in with. Pick another model.", retryable: false },
  // Transient: OpenCode already retried with backoff. The session is kept, so
  // the work resumes on the same session once the provider answers again.
  "provider.rate-limit": { class: "provider_failure", message: "The provider is limiting requests right now. The session is kept and can continue shortly.", retryable: true },
  "provider.internal": { class: "provider_failure", message: "The provider had a problem answering. The session is kept and can continue shortly.", retryable: true },
  "provider.timeout": { class: "provider_failure", message: "The provider did not answer in time. The session is kept and can continue shortly.", retryable: true },
  "provider.transport": { class: "provider_failure", message: "OpenCode could not reach the provider. The session is kept and can continue shortly.", retryable: true },
  "provider.content-filter": { class: "provider_failure", message: "The provider declined this request under its content rules.", retryable: false },
};

function openCodeProviderError(error: RequestError): BridgeErrorClass | null {
  const data = error.data as { service?: unknown; errorName?: unknown } | null | undefined;
  if (data === null || typeof data !== "object" || typeof data.errorName !== "string" || !data.errorName.startsWith("provider.")) return null;
  const text = error.message.slice(0, 1_024);
  // A provider that answered 401/403 behind another reason still means sign in again.
  if (/\b40[13]\b|unauthori[sz]ed|forbidden/i.test(text)) return { code: error.code, ...OPENCODE_PROVIDER_ERRORS["provider.auth"]! };
  const known = OPENCODE_PROVIDER_ERRORS[data.errorName];
  if (known) return { code: error.code, ...known };
  if (/\b(429|503)\b/.test(text)) return { code: error.code, ...OPENCODE_PROVIDER_ERRORS["provider.internal"]! };
  return { code: error.code, class: "provider_failure", message: "The provider could not handle this request.", retryable: false };
}

/**
 * Google Antigravity's ACP server (antigravity-acp 1.2.1, `server.py`,
 * `admin_controls_manager.py`) names its sign-in, licence and organisation
 * failures by `data.reason`: `-32000` with `ge_license_failed`,
 * `ge_license_cancelled`, `ge_license_superseded`, `ge_auth_failed` or
 * `onboarding_failed`; `-32001` with `admin_controls_permission_denied` or
 * `admin_controls_verification_failed` when the organisation's Gemini
 * Enterprise settings could not be read (the session is blocked). Its own
 * text names paths and projects, so none of it reaches the person: fixed
 * plain lines only. A licensed account whose project has the Business AI
 * Code API switched off reads "no license" (CP0 part 2), so the licence line
 * names that API and the command that turns it on.
 */
export const ANTIGRAVITY_LICENCE_REASON = "Gemini Enterprise found no licence for this Google Cloud project. Turn on the Business AI Code API with `gcloud services enable businessaicode.googleapis.com --project <project id>`, then sign in again with `konteks-remote auth login antigravity`.";
export const ANTIGRAVITY_ADMIN_SETTINGS_REASON = "Your organisation's Gemini Enterprise settings could not be checked. Sign in again or ask your Google Cloud admin.";
const ANTIGRAVITY_SIGN_IN_AGAIN = "Google Antigravity needs to sign in again. Run `konteks-remote auth login antigravity`.";

function antigravityError(error: RequestError): BridgeErrorClass | null {
  const data = error.data as { reason?: unknown } | null | undefined;
  const reason = data !== null && typeof data === "object" && typeof data.reason === "string" ? data.reason : undefined;
  const text = error.message.slice(0, 2_048);
  const auth = (message: string): BridgeErrorClass => ({ code: error.code, class: "agent_auth_required", message, retryable: false });
  if (reason === "admin_controls_permission_denied" || reason === "admin_controls_verification_failed") return auth(ANTIGRAVITY_ADMIN_SETTINGS_REASON);
  if (reason === "ge_license_failed") {
    // No answer from Google at all, or a server error there: nothing was learned about the licence.
    if (/failed to reach the backend|\(HTTP 5\d\d\)/i.test(text)) {
      return { code: error.code, class: "provider_failure", message: "Google Antigravity could not reach Gemini Enterprise. Try again shortly.", retryable: true };
    }
    if (/setup incomplete/i.test(text)) return auth("Gemini Enterprise needs a Google Cloud project and location. Sign in again with `konteks-remote auth login antigravity`.");
    return auth(ANTIGRAVITY_LICENCE_REASON);
  }
  if (reason === "ge_license_cancelled" || reason === "ge_license_superseded") return auth("The Gemini Enterprise licence was not chosen. Sign in again with `konteks-remote auth login antigravity`.");
  if (reason === "ge_auth_failed" || reason === "onboarding_failed") return auth(ANTIGRAVITY_SIGN_IN_AGAIN);
  return null;
}

function signInLapsed(data: unknown): boolean {
  if (data === undefined || data === null) return false;
  let text: string;
  try { text = typeof data === "string" ? data : JSON.stringify(data); } catch { return false; }
  return /unauthori[sz]ed|\b401\b|could not be refreshed|logged out/i.test(text.slice(0, 4_096));
}

/** Maps an SDK/JSON-RPC failure to the closed AcpJsonRpcError classification. */
export function classifyBridgeError(error: unknown): {
  code: number;
  class: "cancelled" | "provider_failure" | "agent_auth_required" | "invalid_params" | "unknown_request" | "malformed_response" | "internal";
  message: string;
  retryable: boolean;
} {
  if (error instanceof RequestError) {
    const openCode = openCodeProviderError(error) ?? antigravityError(error);
    if (openCode) return openCode;
    const message = error.message.slice(0, 1_024);
    if (error.code === -32000 || /auth/i.test(message) || signInLapsed(error.data) || DSH_KEY_MISSING.test(message)) {
      return { code: error.code, class: "agent_auth_required", message: "agent authentication required", retryable: false };
    }
    // dsh already retried these five times; a turn is not idempotent, so name
    // the provider and let the person decide, never retry the whole turn.
    if (DSH_PROVIDER_FAILURE.test(message)) return { code: error.code, class: "provider_failure", message, retryable: false };
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
