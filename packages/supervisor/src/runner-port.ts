import type { ConnectedAgentView, RemoteSessionLabel, RetainedProcessOwner } from "@konteks/remote-common";

export interface RunnerSessionInput {
  context: { instanceId: string; assignmentId: string; attempt: number; agentId: string };
  /** Absolute outer readiness deadline; every nested native retry clips to it. */
  readinessDeadlineAt: string;
  cwd: string;
  mcpServers: Array<{ type: "http" | "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
  sessionConfig?: Record<string, string>;
  /** Exact live predecessor owned in this process. */
  acpSessionRef?: string;
  /** Durable prior ref whose provider session must be loaded under a new local ref. */
  restoreAcpSessionRef?: string;
  /** Start with staged platform context rather than loading the provider transcript. */
  freshProviderSessionOnRestore?: boolean;
  /** Display-only naming for the provider session list; never authority. */
  sessionLabel?: RemoteSessionLabel;
}

export interface RunnerSessionCreated {
  acpSessionRef: string;
  resumed: boolean;
  capabilities: { forkSession: boolean; sessionResume: boolean };
}

/** In-process native ownership only; never serialized onto ACP or HTTP. */
export interface RunnerSessionLifecycle {
  beforeCreate(opaqueRef: string): Promise<void>;
  recordProcessOwner(owner: RetainedProcessOwner): Promise<void>;
  /** Pre-ready only: atomically replace one confirmed-stopped bootstrap owner. */
  replaceProcessOwner?(previous: RetainedProcessOwner, replacement: RetainedProcessOwner): Promise<void>;
  assertCurrent(): void;
}

/** The supervisor depends on behavior, not an appliance HTTP endpoint. */
export interface RunnerPort {
  readonly agentId: string;
  readiness(): Promise<{ agent: ConnectedAgentView; utilization: { activeSessions: number; activeTurns: number } }>;
  createSession(input: RunnerSessionInput, lifecycle?: RunnerSessionLifecycle): Promise<RunnerSessionCreated>;
  closeSession(ref: string, options?: { completed: true }): Promise<unknown>;
  /** Native stage one: tracked ACP settlement only, NEVER D139 quiescence.
   * Retains the fenced live owner; no close-only fallback or finalization. */
  stopForRecovery?(ref: string): Promise<void>;
  /** Native: release an idle sealed completion no successor continues and
   * finalize its bridge. `processRetained` says the runtime kept the healthy
   * process resident for the next session instead of stopping it; a `void`
   * result means the process was stopped as before. */
  releaseSealedSession?(ref: string): Promise<{ processRetained: boolean } | void>;
  /** Restart-only exact process stop. This is not qualified quiescence, and a
   * native runner refuses it for an identity still live under a local owner. */
  stopRetainedExecution?(owner: RetainedProcessOwner): Promise<void>;
  prompt(ref: string, id: string, params: unknown): Promise<unknown>;
  cancel(ref: string): Promise<unknown>;
  setMode(ref: string, id: string, params: unknown): Promise<unknown>;
  setConfigOption(ref: string, id: string, params: unknown): Promise<unknown>;
  answer(ref: string, id: string, response: unknown): Promise<{ delivered: boolean }>;
  /** `personal`: the person asked for their own device login on this machine (WS1-115). */
  login(organization: boolean, loginId: string, personal?: boolean): Promise<{ loginId: string }>;
  loginInput(loginId: string, text: string): Promise<unknown>;
  loginCancel(loginId: string): Promise<unknown>;
  logout(): Promise<ConnectedAgentView>;
  probe(): Promise<ConnectedAgentView>;
  startEvents(): void;
  stopEvents(): void;
}
