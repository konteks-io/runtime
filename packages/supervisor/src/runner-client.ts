import { WebSocket as NodeWebSocket } from "ws";
import type { SchemaParser } from "@konteks/remote-common";
import { z } from "zod";
import { ConnectedAgentViewSchema, ReconnectBackoff, RemoteInstanceError, createLogger, withJitter, type ConnectedAgentView, type Logger } from "@konteks/remote-common";
import { RunnerEventSchema, type RunnerEvent } from "@konteks/remote-agent-runner";
import type { RunnerPort, RunnerSessionInput } from "./runner-port.js";
import { NATIVE_TRANSIENT_MAX_ATTEMPTS, logNativeRetryExhausted, transientHttpClassification, waitForNativeRetry,
  type NativeTransientClassification } from "./native/transient-retry.js";

/**
 * Supervisor-side client for one agent runner: its internal HTTP API and its
 * event stream. The capability token composed into `mcpServers` passes
 * through this client in memory only.
 */
const CreatedSessionSchema = z.object({ acpSessionRef: z.string().min(1), resumed: z.boolean(), capabilities: z.object({ forkSession: z.boolean(), sessionResume: z.boolean() }).strict() }).strict();
export type CreatedSession = z.infer<typeof CreatedSessionSchema>;

export interface RunnerClientOptions {
  agentId: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
  createWebSocket?: (url: string) => NodeWebSocket;
  onEvent: (event: RunnerEvent) => void;
  logger?: Logger;
  retrySleep?: (delayMs: number) => Promise<void>;
  retryBaseDelayMs?: number;
}

export class RunnerClient implements RunnerPort {
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;
  private socket: NodeWebSocket | null = null;
  private stopped = false;
  private readonly backoff = new ReconnectBackoff();
  private eventReconnectAttempt = 0;

  constructor(readonly options: RunnerClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? createLogger({ name: `runner-client-${options.agentId}` });
  }

  get agentId(): string {
    return this.options.agentId;
  }

  // Structural on purpose: inferring T through `z.ZodType<T>` from the piped
  // public-object schemas costs the checker about a minute per call site.
  private async call<T>(method: string, path: string, body: unknown, schema: SchemaParser<T>, replaySafe = false): Promise<T> {
    const maxAttempts = replaySafe ? NATIVE_TRANSIENT_MAX_ATTEMPTS : 1;
    const operation = `runner.${method.toLowerCase()}.${path.split("/", 2)[1] || "root"}`;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFn(new URL(path, this.options.baseUrl), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
      } catch (error) {
        const classification: NativeTransientClassification = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "transport";
        if (attempt === maxAttempts) {
          if (replaySafe) logNativeRetryExhausted({ logger: this.logger, operation, classification });
          throw new RemoteInstanceError("agent_unavailable", `agent runner ${this.options.agentId} is unreachable`, { cause: error, retryable: true, recoveryActions: [{ kind: "run_doctor" }] });
        }
        await waitForNativeRetry({ logger: this.logger, operation, attempt, classification,
          sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
        continue;
      }
      const transient = transientHttpClassification(response.status);
      if (transient && replaySafe) {
        void response.body?.cancel().catch(() => undefined);
        if (attempt === maxAttempts) {
          logNativeRetryExhausted({ logger: this.logger, operation, classification: transient, status: response.status });
          throw new RemoteInstanceError("agent_unavailable", `agent runner ${this.options.agentId} is temporarily unavailable`, { retryable: true, recoveryActions: [{ kind: "run_doctor" }] });
        }
        await waitForNativeRetry({ logger: this.logger, operation, attempt, classification: transient, status: response.status,
          sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
        continue;
      }
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = z.object({ code: z.string(), message: z.string() }).passthrough().safeParse(payload);
        const code = error.success && error.data.code === "agent_auth_required" ? "agent_auth_required" : error.success && error.data.code === "recovery_required" ? "recovery_required" : "agent_unavailable";
        throw new RemoteInstanceError(code, error.success ? error.data.message : `runner returned HTTP ${response.status}`, { recoveryActions: code === "agent_auth_required" ? [{ kind: "login_agent", agentId: this.options.agentId }] : [] });
      }
      if (attempt > 1) this.logger.info({ operation, attempt, retries: attempt - 1, maxAttempts,
        maxRetries: maxAttempts - 1 }, "transient native transport request recovered");
      return schema.parse(payload);
    }
    throw new RemoteInstanceError("agent_unavailable", `agent runner ${this.options.agentId} is unreachable`, { retryable: true });
  }

  readiness(): Promise<{ agent: ConnectedAgentView; utilization: { activeSessions: number; activeTurns: number } }> {
    return this.call("GET", "/readiness", undefined, z.object({ agent: ConnectedAgentViewSchema, utilization: z.object({ activeSessions: z.number().int(), activeTurns: z.number().int() }).strict() }).strict(), true);
  }

  createSession(body: RunnerSessionInput): Promise<CreatedSession> {
    return this.call("POST", "/sessions", body, CreatedSessionSchema);
  }

  closeSession(acpSessionRef: string): Promise<unknown> {
    return this.call("DELETE", `/sessions/${encodeURIComponent(acpSessionRef)}`, undefined, z.unknown());
  }

  prompt(acpSessionRef: string, id: string, params: unknown): Promise<unknown> {
    return this.call("POST", `/sessions/${encodeURIComponent(acpSessionRef)}/prompt`, { id, params }, z.unknown());
  }

  cancel(acpSessionRef: string): Promise<unknown> {
    return this.call("POST", `/sessions/${encodeURIComponent(acpSessionRef)}/cancel`, undefined, z.unknown(), true);
  }

  setMode(acpSessionRef: string, id: string, params: unknown): Promise<unknown> {
    return this.call("POST", `/sessions/${encodeURIComponent(acpSessionRef)}/set_mode`, { id, params }, z.unknown());
  }

  setConfigOption(acpSessionRef: string, id: string, params: unknown): Promise<unknown> {
    return this.call("POST", `/sessions/${encodeURIComponent(acpSessionRef)}/set_config_option`, { id, params }, z.unknown());
  }

  answer(acpSessionRef: string, requestId: string, response: unknown): Promise<{ delivered: boolean }> {
    return this.call("POST", `/sessions/${encodeURIComponent(acpSessionRef)}/answers`, { requestId, response }, z.object({ delivered: z.boolean() }).strict());
  }

  login(organization: boolean, loginId: string): Promise<{ loginId: string }> {
    return this.call("POST", "/auth/login", { organization, loginId }, z.object({ loginId: z.string() }).strict());
  }

  loginInput(loginId: string, text: string): Promise<unknown> {
    return this.call("POST", "/auth/input", { loginId, text }, z.unknown());
  }

  loginCancel(loginId: string): Promise<unknown> {
    return this.call("POST", "/auth/cancel", { loginId }, z.unknown(), true);
  }

  logout(): Promise<ConnectedAgentView> {
    return this.call("POST", "/auth/logout", {}, ConnectedAgentViewSchema, true);
  }

  probe(): Promise<ConnectedAgentView> {
    return this.call("POST", "/probe", {}, ConnectedAgentViewSchema, true);
  }

  /** Long-lived event subscription with reconnect. */
  startEvents(): void {
    this.stopped = false;
    this.connectEvents();
  }

  stopEvents(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private connectEvents(): void {
    if (this.stopped) return;
    const url = new URL("/events", this.options.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.options.createWebSocket ?? ((target) => new NodeWebSocket(target)))(url.toString());
    this.socket = socket;
    const connectedAt = Date.now();
    socket.on("open", () => { this.eventReconnectAttempt = 0; });
    socket.on("message", (data) => {
      const parsed = RunnerEventSchema.safeParse(safeJson(String(data)));
      if (parsed.success) this.options.onEvent(parsed.data);
    });
    socket.on("error", (error) => this.logger.debug({ err: error }, "runner event socket error"));
    socket.on("close", () => {
      if (this.stopped) return;
      const delayMs = withJitter(this.backoff.nextDelayAfterClose(Date.now() - connectedAt));
      this.eventReconnectAttempt += 1;
      this.logger.warn({ operation: "runner.events", attempt: this.eventReconnectAttempt, delayMs,
        classification: "socket_closed", retryMode: "durable_unbounded" }, "agent runner event stream disconnected; reconnecting");
      setTimeout(() => this.connectEvents(), delayMs).unref();
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
