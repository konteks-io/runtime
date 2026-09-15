import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { AgentRuntime, RunnerConfigSchema, SessionContextSchema, verifyNativeRunnerPackage, type AgentRuntimeOptions, type RunnerConfig, type RunnerEvent } from "@konteks/remote-agent-runner";
import { RemoteInstanceError, SessionToRuntimeMessageSchema, stopRetainedProcessOwner, type RetainedProcessOwner } from "@konteks/remote-common";
import type { RunnerPort, RunnerSessionInput, RunnerSessionLifecycle } from "../runner-port.js";

const idSchema = z.string().min(1).max(128);
const inputSchema = z.object({
  context: SessionContextSchema,
  readinessDeadlineAt: z.string().datetime({ offset: true }),
  cwd: z.string().min(1).refine(isAbsolute).refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)),
  mcpServers: z.array(z.object({
    type: z.enum(["http", "sse"]), name: z.string().min(1).max(256), url: z.string().url(),
    headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(32),
  }).strict()).max(8),
  sessionConfig: z.record(z.string(), z.string()).optional(),
  acpSessionRef: z.string().min(1).max(256).optional(),
  restoreAcpSessionRef: z.string().min(1).max(256).optional(),
  freshProviderSessionOnRestore: z.boolean().optional(),
}).strict().refine(value => value.acpSessionRef === undefined || value.restoreAcpSessionRef === undefined);

export interface NativeRunnerOptions {
  instanceId: string;
  config: RunnerConfig;
  onEvent: (event: RunnerEvent) => void;
  runtimeOptions?: Pick<AgentRuntimeOptions, "spawn" | "probe" | "now" | "logger">;
  executionBridgeLimit?: () => number;
}

/** Host-only runtime adapter. It never starts the legacy runner HTTP/WS API. */
export class NativeRunner implements RunnerPort {
  readonly agentId: string;
  private readonly runtime: AgentRuntime;
  private started = false;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: NativeRunnerOptions) {
    const config = RunnerConfigSchema.safeParse(options.config);
    if (!config.success || config.data.RUNNER_AUTH_MODE !== "agent_local_subscription" || config.data.RUNNER_GATEWAY_BASE_URL !== undefined ||
        !options.instanceId || ![config.data.RUNNER_CREDENTIAL_DIR, config.data.RUNNER_WORKSPACE_DIR, config.data.RUNNER_BRIDGE_PREFIX].every(isAbsolute)) {
      throw new RemoteInstanceError("protocol_incompatible", "A native runner requires local subscription authentication and absolute host paths.");
    }
    this.agentId = config.data.RUNNER_AGENT_ID;
    this.runtime = new AgentRuntime({ ...options.runtimeOptions, config: config.data,
      // Same four-per-ready-agent basis as Supervisor headroom; a lower
      // configured ceiling is supplied by the supervisor. Slots include
      // uncertain owners, not just currently running prompts.
      executionBridgeLimit: options.executionBridgeLimit ?? (() => 4) });
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(unavailable());
    this.startPromise ??= Promise.resolve().then(async () => {
      this.startEvents();
      await this.runtime.start();
      this.started = !this.stopping;
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.stopPromise ??= Promise.resolve().then(async () => {
      await this.startPromise?.catch(() => undefined);
      await this.runtime.stop();
      this.stopEvents();
    });
    return this.stopPromise;
  }

  startEvents(): void {
    if (!this.stopping) this.unsubscribe ??= this.runtime.events.subscribe(this.options.onEvent);
  }

  stopEvents(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async readiness() {
    this.requireStarted();
    return { agent: this.runtime.readiness(), utilization: this.runtime.utilization() };
  }

  async discoverModelCapability(configId: string) {
    this.requireReady();
    return this.runtime.discoverModelCapability(configId);
  }

  private requireStarted(): void {
    if (!this.started || this.stopping) throw unavailable();
  }

  private requireReady(): void {
    this.requireStarted();
    const view = this.runtime.readiness();
    if (view.readiness === "not_configured" || view.readiness === "reconnect_required") {
      throw new RemoteInstanceError("agent_auth_required", "Sign in to the selected local agent.", { recoveryActions: [{ kind: "login_agent", agentId: this.agentId }] });
    }
    if (view.readiness !== "ready" || view.connectionState !== "ready") throw unavailable();
  }

  async createSession(input: RunnerSessionInput, lifecycle?: RunnerSessionLifecycle) {
    this.requireReady();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    if (parsed.data.context.instanceId !== this.options.instanceId || parsed.data.context.agentId !== this.agentId) throw bindingInvalid();
    const { context, readinessDeadlineAt, cwd, mcpServers, sessionConfig, acpSessionRef, restoreAcpSessionRef, freshProviderSessionOnRestore } = parsed.data;
    const args = { context, readinessDeadlineAt, cwd, mcpServers, ...(sessionConfig === undefined ? {} : { sessionConfig }), ...(acpSessionRef === undefined ? {} : { acpSessionRef }),
      ...(freshProviderSessionOnRestore === undefined ? {} : { freshProviderSessionOnRestore }), lifecycle: {
      beforeCreate: async (ref: string) => { await lifecycle?.beforeCreate(ref); },
      recordProcessOwner: async (owner: RetainedProcessOwner) => { await lifecycle?.recordProcessOwner(owner); },
      replaceProcessOwner: async (previous: RetainedProcessOwner, replacement: RetainedProcessOwner) => {
        if (!lifecycle?.replaceProcessOwner) throw new RemoteInstanceError("recovery_required", "Durable bootstrap process-owner replacement is unavailable.");
        await lifecycle.replaceProcessOwner(previous, replacement);
      },
      assertCurrent: () => { this.requireReady(); lifecycle?.assertCurrent(); },
    } };
    if (acpSessionRef !== undefined) return this.runtime.sessions.continueLive(args);
    if (restoreAcpSessionRef !== undefined) return this.runtime.sessions.restore(args, restoreAcpSessionRef);
    return this.runtime.sessions.create(args);
  }

  private request(ref: string, id: string, method: "session/prompt" | "session/set_mode" | "session/set_config_option", params: unknown) {
    this.requireReady();
    const parsed = SessionToRuntimeMessageSchema.safeParse({ kind: "acp", method, id, params });
    if (!parsed.success || parsed.data.kind !== "acp") throw invalid();
    if (parsed.data.params.sessionId !== ref) throw bindingInvalid();
    return parsed.data;
  }

  async prompt(ref: string, id: string, params: unknown) {
    const request = this.request(ref, id, "session/prompt", params);
    if (request.method !== "session/prompt") throw invalid();
    // Shared schemas allow explicit undefined on optional fields; the SDK's
    // exact-optional types do not. JSON normalization removes only those fields.
    const sdkParams = JSON.parse(JSON.stringify(request.params)) as PromptRequest;
    this.runtime.sessions.prompt(ref, id, sdkParams);
  }

  async setMode(ref: string, id: string, params: unknown) {
    const request = this.request(ref, id, "session/set_mode", params);
    if (request.method !== "session/set_mode") throw invalid();
    this.runtime.sessions.setMode(ref, id, request.params);
  }

  async setConfigOption(ref: string, id: string, params: unknown) {
    const request = this.request(ref, id, "session/set_config_option", params);
    if (request.method !== "session/set_config_option") throw invalid();
    this.runtime.sessions.setConfigOption(ref, id, request.params);
  }

  async cancel(ref: string) {
    this.requireStarted();
    this.runtime.sessions.cancel(ref);
  }

  async closeSession(ref: string, options?: { completed: true }) {
    this.requireStarted();
    if (options?.completed) {
      await this.runtime.sessions.sealCompletedTurn(ref);
      return { completion: "native_continuation_ready" as const };
    }
    this.runtime.sessions.close(ref);
    // The session record is gone and its bridge stopped, so this owner is
    // finalized and returns its capacity slot. Its reference stays retained.
    await this.runtime.stopExecutionBridge(ref, { finalize: true });
    return undefined;
  }

  /** Release an idle sealed session nobody will continue and finalize its bridge. */
  async releaseSealedSession(ref: string): Promise<{ processRetained: boolean }> {
    this.requireStarted();
    // `releaseSealed` refuses anything that is not an idle sealed owner, so
    // reaching the release proves this is the qualified finalization the
    // bounded execution allocation waits for. That same idleness proof is
    // what lets the runtime keep the process resident for the next session.
    this.runtime.sessions.releaseSealed(ref);
    const { retained } = await this.runtime.releaseExecutionBridge(ref);
    return { processRetained: retained };
  }

  async stopForRecovery(ref: string): Promise<void> {
    this.requireStarted();
    try {
      await this.runtime.sessions.stopForRecovery(ref);
    } finally {
      // Failed ACP settlement must not leave the exact execution process
      // running. A successful process stop does not clear that failure or
      // establish qualified quiescence; both ownership records stay retained.
      await this.runtime.stopExecutionBridge(ref);
    }
  }

  async stopRetainedExecution(owner: RetainedProcessOwner): Promise<void> {
    this.requireStarted();
    // A resident process keeps its durable identity across references. The
    // runtime refuses this restart-only signal while that identity is live
    // under a current owner and stops an idle match itself first.
    await this.runtime.yieldRetainedProcess(owner);
    await stopRetainedProcessOwner(owner);
  }

  async answer(ref: string, id: string, response: unknown) {
    this.requireStarted();
    const valid = ["session/request_permission", "elicitation/create"].some(method => SessionToRuntimeMessageSchema.safeParse({ kind: "acp_result", method, id, result: response }).success);
    if (!valid) throw invalid();
    // Authorization and option/schema matching stay with the supervisor broker.
    return { delivered: this.runtime.sessions.answer(ref, id, response) };
  }

  async login(organization: boolean, loginId: string) {
    this.requireStarted();
    if (typeof organization !== "boolean" || !idSchema.safeParse(loginId).success) throw invalid();
    await verifyNativeRunnerPackage(this.options.config);
    this.requireStarted();
    return { loginId: this.runtime.startLogin({ organization, loginId }).loginId };
  }

  async loginInput(loginId: string, text: string) {
    this.requireStarted();
    if (!idSchema.safeParse(loginId).success || typeof text !== "string" || text.length > 8192) throw invalid();
    return { delivered: this.runtime.loginInput(loginId, text) };
  }

  async loginCancel(loginId: string) {
    this.requireStarted();
    if (!idSchema.safeParse(loginId).success) throw invalid();
    return { cancelled: await this.runtime.loginCancel(loginId) };
  }

  async logout() { this.requireStarted(); await verifyNativeRunnerPackage(this.options.config); this.requireStarted(); return this.runtime.logout(); }
  async probe() { this.requireStarted(); return this.runtime.probe(false); }
}

function unavailable() { return new RemoteInstanceError("agent_unavailable", "The native agent runner is not available."); }
function invalid() { return new RemoteInstanceError("protocol_incompatible", "The native runner request failed validation."); }
function bindingInvalid() { return new RemoteInstanceError("workspace_binding_invalid", "The request does not match the selected local agent session."); }
