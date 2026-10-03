import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { AgentRuntime, RunnerConfigSchema, SessionContextSchema, browserMcpServer, runnerBrowserVersion, verifyNativeRunnerPackage, type AgentRuntimeOptions, type RunnerConfig, type RunnerEvent } from "@konteks/remote-agent-runner";
import { AgentLoginGcpSchema, AgentLoginOptionIdSchema, RemoteInstanceError, RemoteSessionLabelSchema, SessionToRuntimeMessageSchema, stopRetainedProcessOwner, type RetainedProcessOwner } from "@konteks/remote-common";
import type { RunnerHostSettings, RunnerLoginRequest, RunnerPort, RunnerSessionInput, RunnerSessionLifecycle } from "../runner-port.js";
import type { checkDshKonteksProfile } from "./dsh-profile-check.js";
import type { checkOpenCodeKonteksConfig } from "./opencode-self-check.js";
import type { checkAntigravityServer } from "./antigravity-self-check.js";
import { hostAgentInstallAdapter } from "./host-agents.js";

const idSchema = z.string().min(1).max(128);
const loginRequestSchema = z.object({
  provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  method: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  loginOption: AgentLoginOptionIdSchema.optional(),
  reuse: z.boolean().optional(),
  gcp: AgentLoginGcpSchema.optional(),
}).strict();
function withoutUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
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
  sessionLabel: RemoteSessionLabelSchema.optional(),
  agentTitled: z.literal(true).optional(),
  browser: z.object({
    proxyUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
    outputDir: z.string().min(1).refine(isAbsolute),
    browsersPath: z.string().min(1).refine(isAbsolute),
  }).strict().optional(),
  // An integration task's own session: server names are bounded tokens (the
  // bridge patches re-check them), at most a handful per session.
  integration: z.object({
    admittedMcpServerNames: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(8),
    accountConnectors: z.boolean(),
  }).strict().optional(),
}).strict().refine(value => value.acpSessionRef === undefined || value.restoreAcpSessionRef === undefined);

export interface NativeRunnerOptions {
  instanceId: string;
  config: RunnerConfig;
  onEvent: (event: RunnerEvent) => void;
  runtimeOptions?: Pick<AgentRuntimeOptions, "spawn" | "probe" | "now" | "logger">;
  executionBridgeLimit?: () => number;
  afterSuccessfulLogin?: () => Promise<void>;
  /** The DeepSeek Harness overlay self-check; replaced only in tests. */
  dshProfileCheck?: typeof checkDshKonteksProfile;
  /** The OpenCode locked-config self-check; replaced only in tests. */
  openCodeSelfCheck?: typeof checkOpenCodeKonteksConfig;
  /** The Google Antigravity `initialize` start check; replaced only in tests. */
  antigravitySelfCheck?: typeof checkAntigravityServer;
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

  /**
   * The browser (Playwright MCP) version this agent's sessions get: its own
   * package's, or the connector's (O8) for an agent without one; null when
   * the connector has no browser.
   */
  browserVersion(): string | null {
    return runnerBrowserVersion(this.options.config);
  }

  constructor(private readonly options: NativeRunnerOptions) {
    const config = RunnerConfigSchema.safeParse(options.config);
    if (!config.success || config.data.RUNNER_AUTH_MODE !== "agent_local_subscription" ||
        !options.instanceId || ![config.data.RUNNER_CREDENTIAL_DIR, config.data.RUNNER_WORKSPACE_DIR, config.data.RUNNER_BRIDGE_PREFIX].every(isAbsolute)) {
      throw new RemoteInstanceError("protocol_incompatible", "A native runner requires local subscription authentication and absolute host paths.");
    }
    this.agentId = config.data.RUNNER_AGENT_ID;
    this.runtime = new AgentRuntime({ ...options.runtimeOptions, config: config.data,
      ...(options.afterSuccessfulLogin ? { afterSuccessfulLogin: options.afterSuccessfulLogin } : {}),
      // Same four-per-ready-agent basis as Supervisor headroom; a lower
      // configured ceiling is supplied by the supervisor. Slots include
      // uncertain owners, not just currently running prompts.
      executionBridgeLimit: options.executionBridgeLimit ?? (() => 4) });
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(unavailable());
    if (this.startPromise === null) {
      const starting = Promise.resolve().then(async () => {
        await this.checkHostAgent();
        this.startEvents();
        await this.runtime.start();
        this.started = !this.stopping;
      });
      // A failed start is forgotten, so the supervisor's background retry
      // starts it afresh instead of replaying the same rejection.
      starting.catch(() => {
        if (this.startPromise !== starting) return;
        this.startPromise = null;
        this.stopEvents();
      });
      this.startPromise = starting;
    }
    return this.startPromise;
  }

  /**
   * An agent used from the person's own installation runs only once its host
   * adapter proved the Konteks overlay or config in force in that exact
   * installation (for dsh, dsh-profile-check.ts): an upgrade that stops it
   * applying, the ask hook included, never spawns.
   */
  private async checkHostAgent(): Promise<void> {
    const host = hostAgentInstallAdapter(this.options.config.RUNNER_AGENT_ID);
    if (!host) return;
    try {
      await host.selfCheck(this.options.config, {
        ...(this.options.dshProfileCheck ? { dshProfileCheck: this.options.dshProfileCheck } : {}),
        ...(this.options.openCodeSelfCheck ? { openCodeSelfCheck: this.options.openCodeSelfCheck } : {}),
        ...(this.options.antigravitySelfCheck ? { antigravitySelfCheck: this.options.antigravitySelfCheck } : {}),
      });
      this.hostSelfCheck = "passed";
    } catch (error) {
      this.hostSelfCheck = "failed";
      throw error;
    }
  }

  private hostSelfCheck: "passed" | "failed" | "not_run" = "not_run";

  /**
   * The person's own installation this host-agent runner runs (doctor): its
   * version, its executable, and how the last start self-check went. Null for
   * an agent from a release package.
   */
  hostInstallation(): { version: string; executable: string | null; fetchedRoot?: string; selfCheck: "passed" | "failed" | "not_run" } | null {
    const config = this.options.config;
    if (!hostAgentInstallAdapter(config.RUNNER_AGENT_ID)) return null;
    return { version: config.RUNNER_BRIDGE_VERSION, executable: config.RUNNER_NATIVE_OPENCODE_BINARY ?? config.RUNNER_NATIVE_DSH_ENTRY ?? null,
      // A fetched agent's own folder (Google Antigravity), for its download state; never shown.
      ...(config.RUNNER_NATIVE_ANTIGRAVITY_ROOT === undefined ? {} : { fetchedRoot: config.RUNNER_NATIVE_ANTIGRAVITY_ROOT }),
      selfCheck: this.hostSelfCheck };
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

  /** Why this agent was taken out of service, or null (doctor). */
  /** The agent was signed in and the sign-in no longer works (runtime-view R21). */
  signInLost(): boolean {
    return this.runtime.signInLost();
  }

  quarantineReason(): string | null {
    return this.runtime.quarantineReason();
  }

  async quarantine(reason: string): Promise<void> {
    await this.runtime.quarantine(reason);
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
    const { context, readinessDeadlineAt, cwd, sessionConfig, acpSessionRef, restoreAcpSessionRef, freshProviderSessionOnRestore, sessionLabel, agentTitled, browser, integration } = parsed.data;
    // The session's browser is a stdio MCP server the agent launches (its own
    // package's, or the connector's for an agent without one); composed here,
    // where the paths are known.
    const browserServer = browser === undefined ? null : browserMcpServer(this.options.config, browser);
    const mcpServers = browserServer === null ? parsed.data.mcpServers : [...parsed.data.mcpServers, browserServer];
    const args = { context, readinessDeadlineAt, cwd, mcpServers, ...(sessionConfig === undefined ? {} : { sessionConfig }), ...(acpSessionRef === undefined ? {} : { acpSessionRef }),
      ...(freshProviderSessionOnRestore === undefined ? {} : { freshProviderSessionOnRestore }),
      ...(sessionLabel === undefined ? {} : { sessionLabel }), ...(agentTitled ? { agentTitled } : {}), ...(integration === undefined ? {} : { integration }), lifecycle: {
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
    // bounded execution allocation waits for. That same idleness proof, plus
    // the agent's confirmed close of the released session, is what lets the
    // runtime keep the process resident for the next session; without the
    // close the process is stopped and finalized as before.
    await this.runtime.sessions.releaseSealed(ref);
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

  async login(organization: boolean, loginId: string, personal = false, request?: RunnerLoginRequest) {
    this.requireStarted();
    if (typeof organization !== "boolean" || typeof personal !== "boolean" || !idSchema.safeParse(loginId).success) throw invalid();
    const parsed = request === undefined ? undefined : loginRequestSchema.safeParse(request);
    if (parsed && !parsed.success) throw invalid();
    await verifyNativeRunnerPackage(this.options.config);
    this.requireStarted();
    return { loginId: this.runtime.startLogin({ organization, loginId, personal, ...(parsed?.data ? { request: withoutUndefined(parsed.data) } : {}) }).loginId };
  }

  async applyHostSettings(settings: RunnerHostSettings): Promise<void> {
    await this.runtime.applyHostSettings({ openCodeFreeModels: settings.openCodeFreeModels === true, coreAcceptsRouteBilling: settings.coreAcceptsRouteBilling === true });
  }

  siteLoginOptions() {
    return this.started && !this.stopping ? this.runtime.siteLoginOptions() : [];
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

  async logout(request?: RunnerLoginRequest) {
    this.requireStarted();
    const parsed = request === undefined ? undefined : loginRequestSchema.safeParse(request);
    if (parsed && !parsed.success) throw invalid();
    await verifyNativeRunnerPackage(this.options.config);
    this.requireStarted();
    return this.runtime.logout(parsed?.data ? withoutUndefined(parsed.data) : undefined);
  }
  async probe() { this.requireStarted(); return this.runtime.probe(false); }
}

function unavailable() { return new RemoteInstanceError("agent_unavailable", "The native agent runner is not available."); }
function invalid() { return new RemoteInstanceError("protocol_incompatible", "The native runner request failed validation."); }
function bindingInvalid() { return new RemoteInstanceError("workspace_binding_invalid", "The request does not match the selected local agent session."); }
