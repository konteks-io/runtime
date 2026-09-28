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

function fake(options: { json?: boolean; confirm?: boolean; loginFailure?: boolean } = {}) {
  const calls: ControlRequest[] = [];
  let text = "";
  const sink = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const control = {
    call: async <T,>(request: ControlRequest, schema: { parse: (value: unknown) => T }, callOptions?: { onEvent?: (event: unknown) => void }): Promise<T> => {
      calls.push(request);
      if (request.op === "status") return schema.parse(supervisorStatus);
      if (request.op === "preview.status") {
        return schema.parse({ capabilityAdvertised: true, idleStopMinutes: 30, maxRunning: 3, lastFailure: null, previews: [
          { sessionId: "sess-1", state: "running", url: "http://127.0.0.1:43100", port: 43100, command: "npm run dev", source: "inferred", explanation: "Inferred from package.json.", message: "Running.", startedAt: null, readyAt: null, viewerConnected: true },
        ] });
      }
      if (request.op === "auth.login") {
        callOptions?.onEvent?.({ kind: "started", loginId: "l1", agentId: request.agentId });
        if (options.loginFailure) {
          callOptions?.onEvent?.({ kind: "failed", loginId: "l1", code: "agent_auth_required", message: "the DeepSeek API key was not saved" });
          return schema.parse({ loginId: "l1" });
        }
        callOptions?.onEvent?.({ kind: "open_url", loginId: "l1", url: "https://login.example/device", userCode: "ABCD-1234" });
        callOptions?.onEvent?.({ kind: "prompt", loginId: "l1", label: "Paste the code", secret: true });
        callOptions?.onEvent?.({ kind: "completed", loginId: "l1", readiness: "ready" });
        return schema.parse({ loginId: "l1" });
      }
      return schema.parse({});
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
  it("fails the command when the supervisor reports a failed login", async () => {
    const f = fake({ loginFailure: true });
    await expect(authLogin(f.context, "dsh", false)).rejects.toMatchObject({ code: "agent_auth_required" });
    expect(f.text()).not.toContain("pasted-secret-value");
  });
  it("asks OpenCode's provider choice in the open and its key hidden, and passes the chosen sign-in on (CP3)", async () => {
    const f = fake();
    const typed: string[] = [];
    const hidden: string[] = [];
    f.context.promptLine = async label => { typed.push(label); return "deepseek"; };
    f.context.promptSecret = async label => { hidden.push(label); return "sk-typed-key-never-shown"; };
    f.context.control.call = (async (request: ControlRequest, schema: { parse: (value: unknown) => unknown }, options?: { onEvent?: (event: unknown) => void }) => {
      f.calls.push(request);
      if (request.op !== "auth.login") return schema.parse({});
      options?.onEvent?.({ kind: "prompt", loginId: "l1", label: "Number or provider id", secret: false, visible: true });
      options?.onEvent?.({ kind: "prompt", loginId: "l1", label: "DeepSeek API key", secret: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      options?.onEvent?.({ kind: "completed", loginId: "l1", readiness: "ready" });
      return schema.parse({ loginId: "l1" });
    }) as typeof f.context.control.call;
    await authLogin(f.context, "opencode", false, { provider: "deepseek", method: "key", reuse: true });
    expect(typed).toEqual(["Number or provider id"]);
    expect(hidden).toEqual(["DeepSeek API key"]);
    expect(f.calls[0]).toEqual({ op: "auth.login", agentId: "opencode", organization: false, provider: "deepseek", method: "key", reuse: true });
    expect(f.calls.slice(1)).toEqual([{ op: "auth.input", loginId: "l1", text: "deepseek" }, { op: "auth.input", loginId: "l1", text: "sk-typed-key-never-shown" }]);
    expect(f.text()).not.toContain("sk-typed-key-never-shown");
  });
  it("passes Google Antigravity's Gemini Enterprise project and location on, and its key only through the hidden prompt (antigravity CP3)", async () => {
    const f = fake();
    const hidden: string[] = [];
    f.context.promptSecret = async label => { hidden.push(label); return "AIzaSyTYPED-never-shown-000000000000"; };
    f.context.control.call = (async (request: ControlRequest, schema: { parse: (value: unknown) => unknown }, options?: { onEvent?: (event: unknown) => void }) => {
      f.calls.push(request);
      if (request.op !== "auth.login") return schema.parse({});
      if (request.method === "gemini-api-key") options?.onEvent?.({ kind: "prompt", loginId: "l1", label: "Gemini API key", secret: true });
      else options?.onEvent?.({ kind: "open_url", loginId: "l1", url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" });
      await new Promise(resolve => setTimeout(resolve, 0));
      options?.onEvent?.({ kind: "completed", loginId: "l1", readiness: "ready" });
      return schema.parse({ loginId: "l1" });
    }) as typeof f.context.control.call;
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

  it("names Google Antigravity's download state in the agent list, with the command that changes it (antigravity CP6)", async () => {
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
