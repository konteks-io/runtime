import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RemoteInstanceError, type ControlRequest, type SupervisorStatus } from "@konteks/remote-common";
import { agents, authLogin, previewStatus, status, type ControlContext } from "../native/control-commands.js";
import { createOutput } from "../output.js";

const supervisorStatus: SupervisorStatus = {
  instanceId: "inst-1",
  workspaceId: "ws",
  administrativeStatus: "active",
  connectivity: { transport: "relay", relayConnected: true, lastConnectedAt: null, reconciliationComplete: true },
  lease: { mode: "active", expiresAt: null, drainDeadline: null },
  version: { bundle: "1.0.0", protocol: "1", manifestDigest: null, updateAvailable: false, targetBundle: null },
  configRevision: 1,
  components: [],
  roles: [],
  roleBindings: [],
  utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 },
  pendingErase: 0,
  pendingRevocation: false,
  journal: { assignments: 0, outboxDepth: 0, recoveryRequired: 0 },
};

const PREVIEWS = {
  capabilityAdvertised: true, idleStopMinutes: 30, maxRunning: 3, lastFailure: null, previews: [
    { sessionId: "sess-1", state: "running", url: "http://127.0.0.1:43100", port: 43100, command: "npm run dev", source: "inferred", explanation: "Inferred from package.json.", message: "Running.", startedAt: null, readyAt: null, viewerConnected: true },
  ],
};

/** The running supervisor's answer to one control request; a login streams its events through `emit`. */
function fakeReply(request: ControlRequest, emit: (event: unknown) => void, loginFailure: boolean | undefined): unknown {
  if (request.op === "status") return supervisorStatus;
  if (request.op === "preview.status") return PREVIEWS;
  if (request.op !== "auth.login") return {};
  emit({ kind: "started", loginId: "l1", agentId: request.agentId });
  if (loginFailure) {
    emit({ kind: "failed", loginId: "l1", code: "agent_auth_required", message: "the DeepSeek API key was not saved" });
    return { loginId: "l1" };
  }
  emit({ kind: "open_url", loginId: "l1", url: "https://login.example/device", userCode: "ABCD-1234" });
  emit({ kind: "prompt", loginId: "l1", label: "Paste the code", secret: true });
  emit({ kind: "completed", loginId: "l1", readiness: "ready" });
  return { loginId: "l1" };
}

/** Yields once between two scripted login events. */
const TICK = Symbol("tick");
type ControlCall = (request: ControlRequest, schema: { parse: (value: unknown) => unknown }, options?: { onEvent?: (event: unknown) => void }) => Promise<unknown>;

/** A control call whose `auth.login` emits `events` in order; every other op answers `{}`. Requests are recorded in `seen`. */
function scriptedLogin(events: unknown[] | ((request: ControlRequest) => unknown[]), seen?: ControlRequest[]): ControlCall {
  return async (request, schema, options) => {
    seen?.push(request);
    if (request.op !== "auth.login") return schema.parse({});
    const emit = options?.onEvent ?? (() => undefined);
    for (const event of typeof events === "function" ? events(request) : events) {
      if (event === TICK) await new Promise(resolve => setTimeout(resolve, 0));
      else emit(event);
    }
    return schema.parse({ loginId: "l1" });
  };
}

function fake(options: { json?: boolean; confirm?: boolean; loginFailure?: boolean } = {}) {
  const calls: ControlRequest[] = [];
  let text = "";
  const sink = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const control = {
    call: async <T,>(request: ControlRequest, schema: { parse: (value: unknown) => T }, callOptions?: { onEvent?: (event: unknown) => void }): Promise<T> => {
      calls.push(request);
      return schema.parse(fakeReply(request, callOptions?.onEvent ?? (() => undefined), options.loginFailure));
    },
  };
  const context: ControlContext = {
    output: createOutput({ json: options.json ?? false, stdout: sink, stderr: sink }),
    control: control as never,
    confirm: async () => options.confirm ?? true,
    promptSecret: async () => "pasted-secret-value",
  };
  return { context, calls, text: () => text };
}

describe("native control commands", () => {
  it("shows Claude sign-in guidance in the selected Indonesian locale", async () => {
    const f = fake();
    f.context.output = { ...f.context.output, setupLocale: "id" };
    await authLogin(f.context, "claude-code", false);
    expect(f.text()).toContain("Menghubungkan ke konektor lokal");
    expect(f.text()).toContain("tekan Ctrl+C untuk membatalkan");
    expect(f.text()).toContain("konteks-remote doctor");
  });
  it("explains Claude login before waiting for the connector", async () => {
    const f = fake();
    f.context.control.call = (async (_request: unknown, schema: { parse: (value: unknown) => unknown }) => {
      expect(f.text()).toContain("Connecting to the local connector for Claude Code sign-in");
      expect(f.text()).toContain("claude auth login");
      return schema.parse({ loginId: "l1" });
    }) as typeof f.context.control.call;
    await authLogin(f.context, "claude-code", false);
  });
  it("fails the command when the supervisor reports a failed login", async () => {
    const f = fake({ loginFailure: true });
    await expect(authLogin(f.context, "dsh", false)).rejects.toMatchObject({ code: "agent_auth_required", message: "the DeepSeek API key was not saved" });
    expect(f.text()).not.toContain("pasted-secret-value");
  });
  it("names the agent when a sign-in finishes, with no internal start line", async () => {
    const f = fake();
    f.context.control.call = scriptedLogin([
      { kind: "display", loginId: "l1", text: "Paste your DeepSeek API key." },
      { kind: "prompt", loginId: "l1", label: "DeepSeek API key", secret: true },
      { kind: "started", loginId: "l1", agentId: "dsh" },
      TICK,
      { kind: "display", loginId: "l1", text: "Checking the key with DeepSeek…" },
      { kind: "completed", loginId: "l1", readiness: "ready" },
    ]) as typeof f.context.control.call;
    await authLogin(f.context, "dsh", false);
    expect(f.text()).toBe("Paste your DeepSeek API key.\nChecking the key with DeepSeek…\nDeepSeek Harness is ready.\n");
    expect(f.text()).not.toMatch(/\bdsh\b|official tooling|login (started|complete)/i);
  });
  it("in the window the site opened, ends with one line that says the window can close", async () => {
    const f = fake();
    f.context.onComputer = true;
    await authLogin(f.context, "dsh", false);
    expect(f.text().trim().split("\n").at(-1)).toBe("DeepSeek Harness is ready. You can close this window.");
    expect(f.text()).not.toMatch(/\bdsh\b/);
  });
  it("leaves a failure at the flow's own plain line, and shows the error only when nothing said why", async () => {
    const run = async (lines: string[]) => {
      let text = "";
      const sink = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
      const f = fake();
      const output = createOutput({ json: false, stdout: sink, stderr: sink });
      f.context.output = output;
      f.context.control.call = scriptedLogin([
        { kind: "started", loginId: "l1", agentId: "dsh" },
        ...lines.map(line => ({ kind: "display", loginId: "l1", text: line })),
        { kind: "failed", loginId: "l1", code: "agent_auth_required", message: "the DeepSeek API key was not saved" },
      ]) as typeof f.context.control.call;
      const error = await authLogin(f.context, "dsh", false).then(() => null, (failure: unknown) => failure);
      expect(error).toMatchObject({ code: "agent_auth_required" });
      output.error(error);
      return text;
    };
    expect(await run(["Checking the key with DeepSeek…", "Konteks could not reach DeepSeek. Check your connection and try again."]))
      .toBe("Checking the key with DeepSeek…\nKonteks could not reach DeepSeek. Check your connection and try again.\n");
    // A progress line explains nothing: the error still shows.
    expect(await run(["Checking the key with DeepSeek…"])).toContain("the DeepSeek API key was not saved");
  });
  it("starts an agent's own sign-in with its name, in plain words", async () => {
    const f = fake();
    await authLogin(f.context, "codex", false);
    expect(f.text().split("\n")[0]).toBe("Starting Codex's own sign-in. Follow its steps below.");
  });
  it("asks OpenCode's provider choice in the open and its key hidden, and passes the chosen sign-in on", async () => {
    const f = fake();
    const typed: string[] = [];
    const hidden: string[] = [];
    f.context.promptLine = async label => { typed.push(label); return "deepseek"; };
    f.context.promptSecret = async label => { hidden.push(label); return "sk-typed-key-never-shown"; };
    f.context.control.call = scriptedLogin([
      { kind: "prompt", loginId: "l1", label: "Number or provider id", secret: false, visible: true },
      { kind: "prompt", loginId: "l1", label: "DeepSeek API key", secret: true },
      TICK,
      { kind: "completed", loginId: "l1", readiness: "ready" },
    ], f.calls) as typeof f.context.control.call;
    await authLogin(f.context, "opencode", false, { provider: "deepseek", method: "key", reuse: true });
    expect(typed).toEqual(["Number or provider id"]);
    expect(hidden).toEqual(["DeepSeek API key"]);
    expect(f.calls[0]).toEqual({ op: "auth.login", agentId: "opencode", organization: false, provider: "deepseek", method: "key", reuse: true });
    expect(f.calls.slice(1)).toEqual([{ op: "auth.input", loginId: "l1", text: "deepseek" }, { op: "auth.input", loginId: "l1", text: "sk-typed-key-never-shown" }]);
    expect(f.text()).not.toContain("sk-typed-key-never-shown");
  });
  it("passes Google Antigravity's Gemini Enterprise project and location on, and its key only through the hidden prompt", async () => {
    const f = fake();
    const hidden: string[] = [];
    f.context.promptSecret = async label => { hidden.push(label); return "AIzaSyTYPED-never-shown-000000000000"; };
    f.context.control.call = scriptedLogin(request => [
      request.op === "auth.login" && request.method === "gemini-api-key"
        ? { kind: "prompt", loginId: "l1", label: "Gemini API key", secret: true }
        : { kind: "open_url", loginId: "l1", url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" },
      TICK,
      { kind: "completed", loginId: "l1", readiness: "ready" },
    ], f.calls) as typeof f.context.control.call;
    await authLogin(f.context, "antigravity", false, { method: "oauth-business", project: "gemini-enterprise-qa-25d3", location: "global" });
    expect(f.calls[0]).toEqual({ op: "auth.login", agentId: "antigravity", organization: false, method: "oauth-business", project: "gemini-enterprise-qa-25d3", location: "global" });
    expect(f.text()).toContain("open this URL to sign in: https://accounts.google.com/");
    await authLogin(f.context, "antigravity", false, { method: "gemini-api-key" });
    expect(hidden).toEqual(["Gemini API key"]);
    expect(f.calls.at(-1)).toEqual({ op: "auth.input", loginId: "l1", text: "AIzaSyTYPED-never-shown-000000000000" });
    expect(f.text()).not.toContain("AIzaSyTYPED");
  });
  it("ends the login connection when the hidden prompt is interrupted", async () => {
    const f = fake();
    let signal: AbortSignal | undefined;
    f.context.promptSecret = async () => { throw new RemoteInstanceError("temporarily_unavailable", "key entry interrupted"); };
    f.context.control.call = (async (request: ControlRequest, _schema: unknown, options?: { onEvent?: (event: unknown) => void; signal?: AbortSignal }) => {
      if (request.op !== "auth.login") throw new Error("unexpected control request");
      signal = options?.signal;
      options?.onEvent?.({ kind: "prompt", loginId: "l1", label: "DeepSeek API key", secret: true });
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new RemoteInstanceError("temporarily_unavailable", "control operation interrupted")), { once: true }));
    }) as typeof f.context.control.call;
    await expect(authLogin(f.context, "dsh", false)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(signal?.aborted).toBe(true);
  });
  it("shows session previews read-only and points to Konteks for the per-machine switch", async () => {
    const f = fake();
    await previewStatus(f.context);
    expect(f.calls).toEqual([{ op: "preview.status" }]);
    expect(f.text()).toContain("sess-1: running at http://127.0.0.1:43100 (a viewer is connected)");
    expect(f.text()).toContain("command: npm run dev — Inferred from package.json.");
    expect(f.text()).toContain("Customize → Runtimes");
  });

  it("names Google Antigravity's download state in the agent list, with the command that changes it", async () => {
    let text = "";
    const sink = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
    const view = (state: string) => ({ agentId: "antigravity", readiness: "unavailable", authMode: "agent_local_subscription", accountScope: "personal", hostAgentDownload: { state } });
    const context = { output: createOutput({ json: false, stdout: sink, stderr: sink }), control: { call: async <T,>(_request: ControlRequest, schema: { parse: (value: unknown) => T }) => schema.parse({
      agents: [view("not_downloaded"), view("downloading"), view("integrity_failed"), { ...view("ready"), readiness: "ready" }, { agentId: "codex", readiness: "ready", authMode: "agent_local_subscription", accountScope: "personal" }], roles: [], roleBindings: [] }) } } as never;
    await agents(context);
    expect(text.split("\n").slice(0, 5)).toEqual([
      "antigravity: unavailable (agent_local_subscription, scope personal) — not downloaded (konteks-remote agent add antigravity)",
      "antigravity: unavailable (agent_local_subscription, scope personal) — downloading from Google",
      "antigravity: unavailable (agent_local_subscription, scope personal) — does not match Google's release (konteks-remote agent add antigravity)",
      "antigravity: ready (agent_local_subscription, scope personal)",
      "codex: ready (agent_local_subscription, scope personal)",
    ]);
  });

  it("reads a connector status with a running preview", async () => {
    const f = fake();
    supervisorStatus.previewEnabled = true;
    supervisorStatus.previewExposure = { port: 43100, grantPresent: false };
    try { await status(f.context); } finally { delete supervisorStatus.previewEnabled; delete supervisorStatus.previewExposure; }
    expect(f.text()).toContain("running on 127.0.0.1:43100");
  });

  it("says in status when updates cannot arrive, and leaves the line out for a connector without update.channel (RCA 2026-09-30)", async () => {
    const withChannel = (report: unknown) => {
      const f = fake();
      const call = f.context.control.call;
      f.context.control.call = (async (request: ControlRequest, schema: { parse: (value: unknown) => unknown }, options?: { onEvent?: (event: unknown) => void }) =>
        request.op === "update.channel" ? schema.parse(report) : call(request, schema as never, options)) as typeof f.context.control.call;
      return f;
    };
    const dead = withChannel({ host: "127.0.0.1:7444", override: true, lastCheckedAt: "2026-09-30T00:00:00Z", error: "The native release channel could not be read" });
    await status(dead.context);
    expect(dead.text()).toContain("127.0.0.1:7444 (override: KONTEKS_RELEASE_MANIFEST_URL) — cannot be read, no update can arrive");
    const healthy = withChannel({ host: "github.com", override: false, lastCheckedAt: "2026-09-30T00:00:00Z", error: null });
    await status(healthy.context);
    expect(healthy.text()).toContain("github.com, checked 2026-09-30T00:00:00Z");
    const older = fake();
    await status(older.context);
    expect(older.text()).not.toContain("updates");
  });

  it("exposes only the public lease summary in machine-readable status", async () => {
    const f = fake({ json: true });
    await status(f.context);
    const result = JSON.parse(f.text());
    expect(result.leaseStatus).toEqual({ mode: "active", expiresAt: null, drainDeadline: null });
    expect(typeof result.lease).toBe("string"); // generic bearer redaction remains intact
  });

  it("relays the official tooling's URL/code, answers a secret prompt without echo, and records the organization attestation only after consent", async () => {
    const f = fake();
    await authLogin(f.context, "codex", true);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.text()).toContain("https://login.example/device");
    expect(f.text()).toContain("ABCD-1234");
    expect(f.text()).not.toContain("pasted-secret-value");
    expect(f.calls.find(call => call.op === "auth.login")).toMatchObject({ agentId: "codex", organization: true });
    expect(f.calls.find(call => call.op === "auth.input")).toMatchObject({ loginId: "l1", text: "pasted-secret-value" });
    const declined = fake({ confirm: false });
    await expect(authLogin(declined.context, "codex", true)).rejects.toMatchObject({ code: "ownership_promotion_denied" });
  });
});
