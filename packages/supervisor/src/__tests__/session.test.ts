import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, SECRET_CANARIES, generateInstanceKey, type PendingPermissionView, type RemoteWorkAssignment, type RelayAck, type ToCoreRelayFrame } from "@konteks/remote-common";
import { ChannelMux } from "../relay/channel-mux.js";
import { SupervisorJournal } from "../state/journal.js";
import { PermissionBroker, answerIsValid, registerDeferral, sanitizeElicitationRequest, sanitizePermissionRequest } from "../session/permissions.js";
import type { DeferredPermissionBody } from "../core/client.js";
import { EvaluatorPolicyResponder, isSignInElicitation } from "../session/policy-responder.js";
import { createWorkspaceToolPolicy } from "../session/workspace-tool-policy.js";
import { RelayedSession, type RelayedSessionDeps } from "../session/relayed-session.js";
import { renderStructuredOutputContract } from "@konteks/agent-core";
import type { RunnerPort } from "../runner-port.js";
import type { TransportManager } from "../transport/relay-transport.js";
import type { OutboundMessage } from "../transport/transport.js";
import { RunnerEventBus } from "../../../agent-runner/src/events.js";
import { InMemorySessionRefStore, SessionManager } from "../../../agent-runner/src/sessions/manager.js";
import type { BridgeProcess } from "../../../agent-runner/src/bridge/process.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-sess-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
const permissionRequest = { sessionId: "bridge", toolCall: { toolCallId: "t1", title: "Run `rm -rf` in /home/user/secret‮", kind: "execute", rawInput: { command: "rm" } }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }, { optionId: "reject", name: "Reject", kind: "reject_once" as const }] };

describe("sanitized permission facts (D102)", () => {
  it("keeps title/kind/options only, strips directional overrides, and digests the sanitized view", () => {
    const sanitized = sanitizePermissionRequest(permissionRequest as never);
    expect(sanitized.params.title).not.toContain("‮");
    expect(JSON.stringify(sanitized)).not.toContain("rawInput");
    expect(sanitized.requestDigest).toHaveLength(43);
    expect(answerIsValid(sanitized, { outcome: { outcome: "selected", optionId: "allow" } })).toBe(true);
    expect(answerIsValid(sanitized, { outcome: { outcome: "selected", optionId: "not-listed" } })).toBe(false);
  });

  it("marks sign-in elicitations and never accepts an answer for them", () => {
    const elicitation = sanitizeElicitationRequest({ mode: "url", url: "https://login.example", elicitationId: "e", message: "Sign in to continue" } as never);
    expect(elicitation.isSignIn).toBe(true);
    expect(answerIsValid(elicitation, { action: "accept" })).toBe(false);
    expect(isSignInElicitation({ mode: "form", message: "Pick a color", requestedSchema: { type: "object" } } as never)).toBe(false);
  });
});

describe("policy responder (D87 step 1)", () => {
  it("answers allow/deny locally from the PolicyEvaluator and defers only when policy defers", async () => {
    const allow = new EvaluatorPolicyResponder({ evaluateToolUse: async () => ({ allowed: true }) }, () => true);
    expect(await allow.evaluatePermission(permissionRequest as never, { assignmentId: "a", agentId: "codex", workspaceRoot: "/w" })).toEqual({ kind: "allow", optionId: "allow" });
    const deny = new EvaluatorPolicyResponder({ evaluateToolUse: async () => ({ allowed: false, denyMessage: "no" }) }, () => true);
    expect(await deny.evaluatePermission(permissionRequest as never, { assignmentId: "a", agentId: "codex", workspaceRoot: "/w" })).toEqual({ kind: "deny", optionId: "reject", message: "no" });
    const none = new EvaluatorPolicyResponder(null, () => true);
    expect(await none.evaluatePermission(permissionRequest as never, { assignmentId: "a", agentId: "codex", workspaceRoot: "/w" })).toEqual({ kind: "defer" });
    const headless = new EvaluatorPolicyResponder(null, () => false);
    expect(await headless.evaluatePermission(permissionRequest as never, { assignmentId: "a", agentId: "codex", workspaceRoot: "/w" })).toEqual({ kind: "deny", optionId: "reject" });
  });
});

describe("permission broker", () => {
  it("delivers the first valid answer exactly once and fails closed at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: string[] = [];
      const broker = new PermissionBroker({ clock, deadlineSeconds: () => 1, onTimeout: async (request) => void timeouts.push(request.requestId) });
      const sanitized = sanitizePermissionRequest(permissionRequest as never);
      broker.defer({ acpSessionRef: "acp", requestId: "r1", assignmentId: "a", attempt: 1, agentId: "codex", sanitized });
      broker.defer({ acpSessionRef: "acp", requestId: "r2", assignmentId: "a", attempt: 1, agentId: "codex", sanitized });
      expect(broker.answer("acp", "r1", { outcome: { outcome: "selected", optionId: "nope" } })).toEqual({ ok: false, reason: "permission_schema_mismatch" });
      expect(broker.answer("acp", "r1", { outcome: { outcome: "selected", optionId: "allow" } }).ok).toBe(true);
      expect(broker.answer("acp", "r1", { outcome: { outcome: "selected", optionId: "allow" } })).toEqual({ ok: false, reason: "unknown_request" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(timeouts).toEqual(["r2"]);
      expect(broker.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Core deferral registration (bb interactive-request registration)", () => {
  const body: DeferredPermissionBody = { kind: "permission", sessionId: "s", assignmentId: "asg", attempt: 1, agentId: "codex", requestId: "perm-1",
    permission: { title: "Run", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } };
  const view = { kind: "permission", pendingRef: "pend_1", requestId: "perm-1", requestDigest: "d".repeat(43), assignmentId: "asg", agentId: "codex",
    raisedAt: "2026-09-06T00:00:00.000Z", deadlineAt: "2026-09-06T00:05:00.000Z", permission: body.permission } as unknown as PendingPermissionView;
  const sleep = vi.fn(async () => undefined);

  it("retries only transient failures with bounded backoff and returns Core's exact view", async () => {
    const register = vi.fn()
      .mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "later", { retryable: true }))
      .mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "later", { retryable: true }))
      .mockResolvedValueOnce(view);
    await expect(registerDeferral(register, body, { sleep })).resolves.toBe(view);
    expect(register).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(call => (call as unknown[])[0])).toEqual([100, 200]);
  });

  it("fails closed on a permanent refusal, on exhausted retries, and on a different registered request", async () => {
    await expect(registerDeferral(vi.fn().mockRejectedValue(new RemoteInstanceError("schema_invalid", "no")), body, { sleep })).resolves.toBeNull();
    const flaky = vi.fn().mockRejectedValue(new RemoteInstanceError("temporarily_unavailable", "later", { retryable: true }));
    await expect(registerDeferral(flaky, body, { sleep })).resolves.toBeNull();
    expect(flaky).toHaveBeenCalledTimes(6);
    await expect(registerDeferral(vi.fn().mockResolvedValue({ ...view, requestId: "other" }), body, { sleep })).resolves.toBeNull();
  });
});

describe("relayed session (D98/D113/D114)", () => {
  const assignment: RemoteWorkAssignment = {
    id: "asg", kind: "assistant_execution", placementId: "pl", instanceId: "inst", workspaceId: "ws", taskId: "2026-09-06T00:00:00Z", correlationId: "c", attempt: 1, expiresAt: "2026-09-07T00:00:00Z", requiredCapabilities: [],
    agentRoute: { requiredRole: "assistant", agentId: "codex", mcpCapabilityTokenRef: "ref-1" },
    source: { kind: "conversation", portability: "portable_before_claim", sessionId: "s", turnRef: "turn" },
    policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: "2026-09-07T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
  };

  async function build(overrides: Partial<RelayedSessionDeps> = {}, work = assignment) {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    const sent: OutboundMessage[] = [];
    const transport = { send: (message: OutboundMessage) => void sent.push(message), openChannel: vi.fn(), closeChannel: vi.fn() } as unknown as TransportManager;
    const runnerCalls: Array<[string, unknown[]]> = [];
    const runner = {
      createSession: vi.fn(async (body: unknown) => {
        runnerCalls.push(["createSession", [body]]);
        return { acpSessionRef: "acp-1", resumed: false, capabilities: { forkSession: false, sessionResume: true } };
      }),
      prompt: vi.fn(async (...args: unknown[]) => void runnerCalls.push(["prompt", args])),
      cancel: vi.fn(async () => undefined),
      setMode: vi.fn(async () => undefined),
      setConfigOption: vi.fn(async () => undefined),
      answer: vi.fn(async (...args: unknown[]) => {
        runnerCalls.push(["answer", args]);
        return { delivered: true };
      }),
      closeSession: vi.fn(async () => undefined),
    } as unknown as RunnerPort;
    const broker = new PermissionBroker({ clock, deadlineSeconds: () => 60, onTimeout: async () => undefined });
    const closed: string[] = [];
    const session = new RelayedSession(work, {
      clock,
      journal,
      transport,
      runner,
      policy: new EvaluatorPolicyResponder(null, () => true),
      broker,
      instanceId: "inst",
      redeemCapabilityToken: async () => ({ mcpServer: { name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }, expiresAt: "2026-09-07T00:00:00Z" }),
      // The runner's workspace folder; prepared inputs check out beneath it.
      workspaceRoot: "/private/native",
      // The native path is the only path: verified inputs, then Core readiness.
      prepareInputs: async (target: RemoteWorkAssignment) => ({ binding: { workspaceId: target.workspaceId, sessionId: target.source.kind === "conversation" ? target.source.sessionId : "s", assignmentId: target.id, instanceId: target.instanceId, attempt: target.attempt }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      registerReady: async (target: RemoteWorkAssignment, binding: { sessionId: string }, acpSessionRef: string) => ({ workspaceId: target.workspaceId, instanceId: target.instanceId, sessionId: binding.sessionId, channelId: `session:${binding.sessionId}`, assignmentId: target.id, attempt: target.attempt, claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "runner-process", agentId: target.agentRoute.agentId, acpSessionRef, readyRevision: 1, registeredAt: clock.nowIso() }),
      onUsage: async () => undefined,
      onClosed: async (_session, reason) => void closed.push(reason),
      ...overrides,
    });
    return { session, sent, runner, runnerCalls, journal, closed, transport };
  }

  it.each([false, true])("admits a legacy Codex reference only when the pinned owner proves it unloaded (unloaded=%s)", async unloaded => {
    const assertLegacyCodexThreadUnloaded = vi.fn(async () => unloaded);
    const f = await build({ restoreReference: "legacy-acp-ref", assertLegacyCodexThreadUnloaded });
    try {
      if (unloaded) {
        await f.session.bootstrap();
        expect(f.runner.createSession).toHaveBeenCalledWith(expect.objectContaining({ restoreAcpSessionRef: "legacy-acp-ref" }), undefined);
      } else {
        await expect(f.session.bootstrap()).rejects.toMatchObject({ code: "recovery_required" });
        expect(f.runner.createSession).not.toHaveBeenCalled();
      }
      expect(assertLegacyCodexThreadUnloaded).toHaveBeenCalledWith("legacy-acp-ref");
    } finally { await f.session.close("cancelled"); }
  });

  it("bootstraps with the redeemed token in mcpServers and announces session_ready", async () => {
    const { session, sent, runnerCalls, journal } = await build();
    await session.bootstrap();
    // The agent reaches the platform through the local capability facade; the bearer never leaves memory.
    const mcpServers = (runnerCalls[0]?.[1][0] as { mcpServers: Array<{ url: string; headers: Array<{ value: string }> }> }).mcpServers;
    // Every session also gets the turn result tool (submit_result), generic until a turn asks for a result.
    expect(mcpServers).toEqual([
      { type: "http", name: "konteks", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer /) }] },
      { type: "http", name: "konteks-result", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer /) }] },
    ]);
    expect(JSON.stringify(mcpServers)).not.toContain("cap-token");
    expect(sent[0]?.body).toMatchObject({ kind: "session_ready", assignmentId: "asg", acpSessionRef: "acp-1", resumed: false, agentId: "codex" });
    expect(JSON.stringify(journal.assignments.all())).not.toContain("cap-token");
    await session.close("cancelled");
  });

  it.each(["live", "restored"] as const)("keeps a %s Codex thread's MCP transport bound to only the current fenced turn", async continuation => {
    const seen: string[] = [];
    let holdNext = false;
    let inFlightStarted!: () => void;
    let releaseInFlight!: () => void;
    const inFlightSeen = new Promise<void>(resolve => { inFlightStarted = resolve; });
    const inFlightRelease = new Promise<void>(resolve => { releaseInFlight = resolve; });
    const upstream = createServer((request, response) => {
      seen.push(request.headers.authorization ?? "");
      const finish = () => {
        response.setHeader("content-type", "application/json");
        response.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      };
      if (holdNext) {
        holdNext = false;
        inFlightStarted();
        void inFlightRelease.then(finish);
      } else finish();
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream address");
    const upstreamUrl = `http://127.0.0.1:${address.port}/mcp`;
    const capability = (bearer: string) => ({ mcpServer: { name: "konteks", url: upstreamUrl,
      headers: [{ name: "authorization", value: `Bearer ${bearer}` }] }, expiresAt: "2026-09-07T00:00:00Z" });
    const call = (entry: { url: string; headers: Array<{ name: string; value: string }> }) =>
      fetch(entry.url, { method: "POST", headers: { ...Object.fromEntries(entry.headers.map(header => [header.name, header.value])), "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    let first: Awaited<ReturnType<typeof build>> | undefined;
    let second: Awaited<ReturnType<typeof build>> | undefined;
    try {
      first = await build({ redeemCapabilityToken: async () => capability("turn-A"), recordCompletedSettlement: async () => undefined });
      vi.mocked(first.runner.closeSession).mockResolvedValue({ completion: "native_continuation_ready" });
      await first.session.bootstrap();
      const firstEntry = (first.runnerCalls[0]?.[1][0] as { mcpServers: Array<{ url: string; headers: Array<{ name: string; value: string }> }> }).mcpServers[0]!;
      expect((await call(firstEntry)).status).toBe(200);
      expect(seen).toEqual(["Bearer turn-A"]);

      // Hold a request admitted under A across the ownership handoff.
      holdNext = true;
      const inFlight = call(firstEntry).catch(() => undefined);
      await inFlightSeen;

      // A completed owner has no authority while the provider thread remains loaded.
      await first.session.close("completed");
      const betweenTurns = await call(firstEntry).then(response => response.status, () => "connection_refused" as const);
      expect([503, "connection_refused"]).toContain(betweenTurns);
      expect(seen).toEqual(["Bearer turn-A", "Bearer turn-A"]);

      const nextAssignment = { ...assignment, id: "asg-B", attempt: 2, source: { ...assignment.source, turnRef: "turn-B" } } as RemoteWorkAssignment;
      second = await build({ redeemCapabilityToken: async () => capability("turn-B"),
        mcpLocalTransport: { port: Number(new URL(firstEntry.url).port), credential: firstEntry.headers[0]!.value.slice("Bearer ".length) },
        activateExecution: async () => continuation === "live" ? { continueReference: "acp-1" } : { restoreReference: "acp-1" } }, nextAssignment);
      vi.mocked(second.runner.createSession).mockResolvedValue({ acpSessionRef: "acp-1", resumed: true, capabilities: { forkSession: false, sessionResume: true } });
      await second.session.bootstrap();
      // Codex app-server can accept thread/resume yet ignore the new MCP config
      // for a loaded thread. The provider therefore keeps calling firstEntry.
      expect((await call(firstEntry)).status).toBe(200);
      releaseInFlight();
      await inFlight;
      expect(seen).toEqual(["Bearer turn-A", "Bearer turn-A", "Bearer turn-B"]);
    } finally {
      releaseInFlight();
      await second?.session.close("cancelled");
      await first?.session.close("cancelled");
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  describe("preview tools (native preview)", () => {
    function previewAccess() {
      const status = (sessionId: string, state: "running" | "stopped") => ({ sessionId, state, phase: null, url: null, port: null, command: null, install: null, prepare: null, source: null, explanation: null, notes: [], message: state, startedAt: null, readyAt: null, idleStopMinutes: 30, logTail: [] });
      return { start: vi.fn(async (sessionId: string) => status(sessionId, "running")), stop: vi.fn(async (sessionId: string) => status(sessionId, "stopped")), status: vi.fn((sessionId: string) => status(sessionId, "running")), touch: vi.fn(), permit: vi.fn(), forget: vi.fn() };
    }

    it("mounts the session's preview tools beside the platform facade, bound to its session and worktree", async () => {
      const preview = previewAccess();
      const f = await build({ preview });
      await f.session.bootstrap();
      const mcpServers = (f.runnerCalls[0]?.[1][0] as { mcpServers: Array<{ name: string; url: string; headers: Array<{ value: string }> }> }).mcpServers;
      expect(mcpServers.map(server => server.name)).toEqual(["konteks", "konteks-preview", "konteks-result"]);
      const tools = mcpServers[1]!;
      expect(tools.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const answer = await (await fetch(tools.url, { method: "POST", headers: { authorization: tools.headers[0]!.value, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_start", arguments: {} } }) })).json();
      expect(answer).toMatchObject({ result: { structuredContent: { sessionId: "s", state: "running" } } });
      expect(preview.start).toHaveBeenCalledWith("s", "/private/native/checkout");
      await f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
      expect(preview.touch).toHaveBeenCalledWith("s");
      await f.session.close("cancelled");
      expect(preview.stop).toHaveBeenCalledWith("s", "cancelled");
      await expect(fetch(tools.url, { method: "POST", headers: { authorization: tools.headers[0]!.value }, body: "{}" })).rejects.toThrow();
    });

    it("lets a viewer start the preview in the session's worktree while the session lasts", async () => {
      const preview = previewAccess();
      const f = await build({ preview });
      await f.session.bootstrap();
      expect(preview.permit).toHaveBeenCalledWith("s", "/private/native/checkout");
      expect(preview.forget).not.toHaveBeenCalled();
      await f.session.close("cancelled");
      expect(preview.forget).toHaveBeenCalledWith("s");
    });

    it("gives planning sessions no preview tools", async () => {
      const preview = previewAccess();
      const f = await build({ preview }, { ...assignment, kind: "planning" } as RemoteWorkAssignment);
      await f.session.bootstrap();
      const mcpServers = (f.runnerCalls[0]?.[1][0] as { mcpServers: Array<{ name: string }> }).mcpServers;
      expect(mcpServers.map(server => server.name)).toEqual(["konteks", "konteks-result"]);
      await f.session.close("cancelled");
      expect(preview.stop).not.toHaveBeenCalled();
      expect(preview.permit).not.toHaveBeenCalled();
    });
  });

  describe("QA browser (a connector capability: every agent, O8)", () => {
    function access(origin: () => string | null) {
      const status = (sessionId: string) => ({ sessionId, state: "running" as const, phase: null, url: null, port: null, command: null, install: null, prepare: null, source: null, explanation: null, notes: [], message: "running", startedAt: null, readyAt: null, idleStopMinutes: 30, logTail: [], startedBy: null });
      return { start: vi.fn(async (sessionId: string) => status(sessionId)), stop: vi.fn(async (sessionId: string) => status(sessionId)), status: vi.fn(status), touch: vi.fn(), permit: vi.fn(), forget: vi.fn(),
        origin: vi.fn((_sessionId: string) => origin()), browsersPath: "/private/native/browsers" };
    }
    const viaProxy = (proxyUrl: string, url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const proxy = new URL(proxyUrl);
      const req = httpRequest({ host: proxy.hostname, port: proxy.port, method: "GET", path: url, headers: { host: new URL(url).host } }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

    it("gives a validation session a browser whose gateway reaches only the session's running preview", async () => {
      const upstream = createServer((_req, res) => res.end("the preview"));
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const preview = access(() => origin);
      const f = await build({ preview }, { ...assignment, kind: "validation" } as RemoteWorkAssignment);
      (f.runner as { browserVersion?: () => string | null }).browserVersion = () => "0.0.82";
      await f.session.bootstrap();
      const input = f.runnerCalls[0]?.[1][0] as { browser?: { proxyUrl: string; outputDir: string; browsersPath: string }; mcpServers: Array<{ name: string }> };
      expect(input.mcpServers.map(server => server.name)).toEqual(["konteks", "konteks-preview", "konteks-result"]);
      expect(input.browser).toMatchObject({ proxyUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), browsersPath: "/private/native/browsers" });
      expect(existsSync(input.browser!.outputDir)).toBe(true);
      await expect(viaProxy(input.browser!.proxyUrl, `${origin}/`)).resolves.toEqual({ status: 200, body: "the preview" });
      expect(preview.touch).toHaveBeenCalledWith("s");
      expect((await viaProxy(input.browser!.proxyUrl, "http://127.0.0.1:1/")).status).toBe(403);
      await f.session.close("cancelled");
      await expect(viaProxy(input.browser!.proxyUrl, `${origin}/`)).rejects.toThrow();
      expect(existsSync(input.browser!.outputDir)).toBe(false);
      upstream.close();
    });

    it("gives a conversation turn (a QA-mode chat) the browser too, but not planning or an agent on a connector without one", async () => {
      const assistant = await build({ preview: access(() => null) });
      (assistant.runner as { browserVersion?: () => string | null }).browserVersion = () => "0.0.82";
      await assistant.session.bootstrap();
      expect((assistant.runnerCalls[0]?.[1][0] as { browser?: unknown }).browser).toMatchObject({ proxyUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
      await assistant.session.close("cancelled");
      const planning = await build({ preview: access(() => null) }, { ...assignment, kind: "planning" } as RemoteWorkAssignment);
      (planning.runner as { browserVersion?: () => string | null }).browserVersion = () => "0.0.82";
      await planning.session.bootstrap();
      expect((planning.runnerCalls[0]?.[1][0] as { browser?: unknown }).browser).toBeUndefined();
      await planning.session.close("cancelled");
      const none = await build({ preview: access(() => null) }, { ...assignment, kind: "validation", agentRoute: { ...assignment.agentRoute, agentId: "dsh" } } as RemoteWorkAssignment);
      (none.runner as { browserVersion?: () => string | null }).browserVersion = () => null;
      await none.session.bootstrap();
      expect((none.runnerCalls[0]?.[1][0] as { browser?: unknown }).browser).toBeUndefined();
      await none.session.close("cancelled");
    });

    it("gives DeepSeek Harness and OpenCode the connector's browser, behind the same gateway, and lets them use it (O8)", async () => {
      const upstream = createServer((_req, res) => res.end("the preview"));
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const options = [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
      for (const agentId of ["dsh", "opencode"] as const) {
        const f = await build({ preview: access(() => origin), policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true) },
          { ...assignment, kind: "qa", agentRoute: { requiredRole: "qa", agentId } } as RemoteWorkAssignment);
        (f.runner as { browserVersion?: () => string | null }).browserVersion = () => "0.0.82";
        await f.session.bootstrap();
        const input = f.runnerCalls[0]?.[1][0] as { browser?: { proxyUrl: string } };
        expect(input.browser, agentId).toMatchObject({ proxyUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), browsersPath: "/private/native/browsers" });
        // The gateway confines it exactly as for Claude Code and Codex.
        await expect(viaProxy(input.browser!.proxyUrl, `${origin}/`)).resolves.toEqual({ status: 200, body: "the preview" });
        expect((await viaProxy(input.browser!.proxyUrl, "http://127.0.0.1:1/")).status).toBe(403);
        const update = (value: Record<string, unknown>) => f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: value } });
        const ask = (requestId: string, toolCallId: string, kind: string, title: string, rawInput: Record<string, unknown>) =>
          f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId, params: { sessionId: "acp-1", toolCall: { toolCallId, kind, title, rawInput }, options } });
        const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string } } | undefined)?.outcome.optionId ?? "none";
        if (agentId === "dsh") {
          for (const [id, tool] of [["n", "browser_navigate"], ["u", "browser_run_code_unsafe"]]) {
            await update({ sessionUpdate: "tool_call", toolCallId: id, title: `mcp__konteks-browser__${tool}`, kind: "other", status: "in_progress", rawInput: { url: origin } });
            await ask(`p-${id}`, id, "other", `mcp__konteks-browser__${tool}`, {});
          }
        } else {
          // OpenCode reaches it through Code Mode, and its tools line names it.
          await f.session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "Check the page." }] } });
          const forwarded = (vi.mocked(f.runner.prompt).mock.calls[0]![2] as { prompt: Array<{ text: string }> }).prompt;
          expect(forwarded[0]!.text).toContain("`konteks-browser`");
          for (const [id, tool] of [["n", "browser_navigate"], ["u", "browser_run_code_unsafe"]]) {
            const code = `const page = await tools["konteks-browser"].${tool}({ url: "${origin}/" });\nreturn page;`;
            await update({ sessionUpdate: "tool_call", toolCallId: id, title: "execute", kind: "other", status: "pending", locations: [], rawInput: {} });
            await update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: { code } });
            await ask(`p-${id}`, id, "other", "execute", { code });
          }
        }
        expect({ agentId, navigate: answer("p-n"), unsafe: answer("p-u") }).toEqual({ agentId, navigate: "once", unsafe: "reject" });
        await f.session.close("cancelled");
      }
      upstream.close();
    });

    it("refuses every MCP server's tool but the session's own: account connectors, a repository's, the person's (S0-2)", async () => {
      const options = [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
      const f = await build({ policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true) },
        { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "claude-code" } } as RemoteWorkAssignment);
      await f.session.bootstrap();
      const names = (f.runnerCalls[0]?.[1][0] as { mcpServers: Array<{ name: string }> }).mcpServers.map(server => server.name);
      const ask = (requestId: string, toolName: string) => f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId,
        params: { sessionId: "acp-1", options, toolCall: { toolCallId: requestId, kind: "other", title: toolName, _meta: { claudeCode: { toolName } } } } } as never);
      await ask("own", `mcp__${names[0]}__platform__builtin__list_sessions`);
      await ask("connector", "mcp__claude_ai_Atlassian__getJiraIssue");
      await ask("repository", "mcp__project_fixture__echo_allowed");
      const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string } } | undefined)?.outcome.optionId ?? "none";
      expect({ own: answer("own"), connector: answer("connector"), repository: answer("repository") }).toEqual({ own: "once", connector: "reject", repository: "reject" });
      expect(f.sent.some(message => (message.body as { method?: string }).method === "session/request_permission")).toBe(false);
      await f.session.close("cancelled");
    });

    it("decides Claude Code's and Codex's browser calls by the tool's structured identity, never by a title (S0-4)", async () => {
      const options = [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
      for (const agentId of ["claude-code", "codex"] as const) {
        const f = await build({ preview: access(() => "http://127.0.0.1:9"), policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => false) },
          { ...assignment, kind: "qa", agentRoute: { requiredRole: "qa", agentId } } as RemoteWorkAssignment);
        (f.runner as { browserVersion?: () => string | null }).browserVersion = () => "0.0.82";
        await f.session.bootstrap();
        const update = (value: Record<string, unknown>) => f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: value } });
        const ask = (requestId: string, params: Record<string, unknown>) =>
          f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId, params: { sessionId: "acp-1", options, ...params } } as never);
        const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string } } | undefined)?.outcome.optionId ?? "none";
        if (agentId === "claude-code") {
          const tool = (toolName: string, toolCall: Record<string, unknown> = {}) => ({ toolCall: { toolCallId: toolName, kind: "other", title: toolName, ...toolCall, _meta: { claudeCode: { toolName } } } });
          await ask("navigate", tool("mcp__konteks-browser__browser_navigate"));
          await ask("spoof", tool("Bash", { kind: "execute", title: "mcp__konteks-browser__browser_navigate", rawInput: { command: "git push origin main" } }));
          await ask("bare", { toolCall: { toolCallId: "bare", kind: "other", title: "mcp__konteks-browser__browser_navigate" } });
        } else {
          await update({ sessionUpdate: "tool_call", toolCallId: "item-1", kind: "execute", title: "mcp.konteks-browser.browser_navigate", status: "in_progress",
            rawInput: { server: "konteks-browser", tool: "browser_navigate", arguments: {} }, _meta: { is_mcp_tool_call: true } });
          await ask("navigate", { toolCall: { toolCallId: "item-1", kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true } });
          await ask("spoof", { toolCall: { toolCallId: "never-announced", kind: "execute", status: "pending", title: "mcp.konteks-browser.browser_navigate" }, _meta: { is_mcp_tool_approval: true } });
          await ask("bare", { toolCall: { toolCallId: "bare", kind: "other", title: "mcp__konteks-browser__browser_navigate" } });
        }
        expect({ agentId, navigate: answer("navigate"), spoof: answer("spoof"), bare: answer("bare") }).toEqual({ agentId, navigate: "once", spoof: "reject", bare: "reject" });
        await f.session.close("cancelled");
      }
    });
  });

  it("reports native interruption even when the broken relay cannot carry session_closed", async () => {
    const f = await build({
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    await f.session.bootstrap();
    vi.spyOn(f.transport, "send").mockImplementation(() => { throw new RemoteInstanceError("recovery_required", "replay gap"); });
    await expect(f.session.close("relay_replay_gap")).resolves.toBeUndefined();
    expect(f.runner.cancel).toHaveBeenCalledWith("acp-1");
    expect(f.closed).toEqual(["relay_replay_gap"]);
    await f.session.close("relay_replay_gap");
    expect(f.closed).toHaveLength(1);
  });

  describe("a person's direct session (runtime-view R11, R13, R14)", () => {
    const directWork: RemoteWorkAssignment = { ...assignment, kind: "direct",
      agentRoute: { requiredRole: "assistant", agentId: "claude-code", mcpCapabilityTokenRef: "ref-1" },
      source: { kind: "direct_session", portability: "instance_bound", ownerInstanceId: "inst", sessionId: "s", turnRef: "turn-2", acpSessionRef: "acp-0" } };
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];

    it("gives the agent nothing of Konteks: no platform tools even when named, no result tool, no preview; it continues its own transcript", async () => {
      const redeemCapabilityToken = vi.fn(async () => { throw new Error("a direct session never redeems platform tools"); });
      const preview = { start: vi.fn(), stop: vi.fn(), status: vi.fn(), touch: vi.fn(), permit: vi.fn() };
      const f = await build({ redeemCapabilityToken, preview: preview as never, activateExecution: async () => ({ restoreReference: "acp-0" }) }, directWork);
      try {
        await f.session.bootstrap();
        expect(redeemCapabilityToken).not.toHaveBeenCalled();
        expect(preview.permit).not.toHaveBeenCalled();
        const created = f.runnerCalls[0]?.[1][0] as { mcpServers: unknown[]; restoreAcpSessionRef?: string; freshProviderSessionOnRestore?: boolean; browser?: unknown };
        expect(created.mcpServers).toEqual([]);
        expect(created.browser).toBeUndefined();
        // The agent's own transcript is loaded: Konteks restages nothing for it.
        expect(created.restoreAcpSessionRef).toBe("acp-0");
        expect(created.freshProviderSessionOnRestore).toBeUndefined();
        expect(f.sent[0]?.body).toMatchObject({ kind: "session_ready", assignmentId: "asg", agentId: "claude-code" });
      } finally { await f.session.close("cancelled"); }
    });

    it("lets the agent title the session itself and asks only for the [konteks] prefix (D130)", async () => {
      const f = await build({ activateExecution: async () => ({ restoreReference: "acp-0" }) }, directWork);
      try {
        await f.session.bootstrap();
        const created = f.runnerCalls[0]?.[1][0] as { agentTitled?: boolean; sessionLabel?: unknown };
        expect(created.agentTitled).toBe(true);
        expect(created.sessionLabel).toBeUndefined();
      } finally { await f.session.close("cancelled"); }
      const engineering = await build();
      try {
        await engineering.session.bootstrap();
        expect(engineering.runnerCalls[0]?.[1][0]).not.toHaveProperty("agentTitled");
      } finally { await engineering.session.close("cancelled"); }
    });

    it("judges file changes against its own session folder, never another session's; blocked commands stay blocked", async () => {
      const own = join(dir, "session-own", "source"), other = join(dir, "session-other", "source");
      await mkdir(own, { recursive: true }); await mkdir(other, { recursive: true });
      const prepareInputs = async (target: RemoteWorkAssignment) => ({ binding: { workspaceId: target.workspaceId, sessionId: "s", assignmentId: target.id, instanceId: target.instanceId, attempt: target.attempt },
        cwd: own, skillInstructions: "", beforePrompt: async () => undefined });
      const decide = async (work: RemoteWorkAssignment) => {
        const f = await build({ workspaceRoot: dir, prepareInputs, policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => false) }, work);
        try {
          await f.session.bootstrap();
          const ask = (requestId: string, toolCall: Record<string, unknown>) => f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId, params: { sessionId: "acp-1", toolCall: { toolCallId: requestId, ...toolCall }, options } } as never);
          await ask("inside", { kind: "edit", title: "Write notes", rawInput: { file_path: join(own, "notes.txt") } });
          await ask("relative", { kind: "edit", title: "Write notes", rawInput: { file_path: "notes.txt" } });
          await ask("other", { kind: "edit", title: "Write elsewhere", rawInput: { file_path: join(other, "x.txt") } });
          await ask("push", { kind: "execute", title: "git push", rawInput: { command: "git push origin main" } });
          const answer = (id: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === id)?.[2] as { outcome: { optionId?: string } } | undefined)?.outcome.optionId;
          return { inside: answer("inside"), relative: answer("relative"), other: answer("other"), push: answer("push") };
        } finally { await f.session.close("cancelled"); }
      };
      expect(await decide(directWork)).toEqual({ inside: "allow", relative: "allow", other: "reject", push: "reject" });
      // Konteks's own conversations keep the workspace root (unchanged here).
      expect((await decide({ ...assignment, agentRoute: { ...assignment.agentRoute, mcpCapabilityTokenRef: undefined } } as RemoteWorkAssignment)).other).toBe("allow");
    });

    // T1 (2026-10-02): a Codex "Edit files" call named four paths, one written
    // from the filesystem root; the connector refused the whole call and said
    // nothing about which path or why (D114).
    it("refuses a multi-path edit naming the outside path, notes why on the call, and logs it without host paths", async () => {
      const own = join(dir, "own"), page = "/storefront/app/checkout/confirmation/[orderId]/page.tsx";
      await mkdir(join(own, "storefront", "lib"), { recursive: true });
      const warn = vi.fn();
      const f = await build({
        workspaceRoot: dir,
        prepareInputs: async (target: RemoteWorkAssignment) => ({ binding: { workspaceId: target.workspaceId, sessionId: "s", assignmentId: target.id, instanceId: target.instanceId, attempt: target.attempt },
          cwd: own, skillInstructions: "", beforePrompt: async () => undefined }),
        policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => false),
        logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as never,
      });
      try {
        await f.session.bootstrap();
        await f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "edit-1", params: { sessionId: "acp-1",
          toolCall: { toolCallId: "exec-1", kind: "edit", title: "Edit files", locations: [
            { path: join(own, "storefront", "lib", "orders.ts") }, { path: join(own, "storefront", "lib", "order-store.ts") },
            { path: page }, { path: join(own, "storefront", "lib", "cart-snapshot.ts") },
          ] }, options } } as never);
        const answered = vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === "edit-1")?.[2] as { outcome: { optionId?: string } };
        expect(answered.outcome.optionId).toBe("reject");
        const note = f.sent.map(message => message.body as { method?: string; params?: { update?: Record<string, unknown> } })
          .filter(body => body.method === "session/update").map(body => body.params!.update!)
          .find(update => update.toolCallId === "exec-1");
        expect(note).toMatchObject({ sessionUpdate: "tool_call_update" });
        expect(note).not.toHaveProperty("status");
        const text = (note!.content as Array<{ content: { text: string } }>)[0]!.content.text;
        expect(text).toBe("Konteks refused this file change: 1 of 4 paths is outside the workspace `[workspace]/`. " +
          "`" + page + "` starts at the filesystem root; inside the workspace it is `storefront/app/checkout/confirmation/[orderId]/page.tsx`. " +
          "Nothing in it was applied. Use paths inside the workspace, relative to it, and try again.");
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({
          toolCallId: "exec-1", decision: "deny",
          refusal: { reason: "outside_workspace", pathCount: 4, outside: [{ path: page, rootAnchored: true, suggestion: "storefront/app/checkout/confirmation/[orderId]/page.tsx" }] },
        }), "tool permission not allowed by policy");
        expect(JSON.stringify(warn.mock.calls)).not.toContain(dir);
        expect(JSON.stringify(f.sent)).not.toContain(dir);
      } finally { await f.session.close("cancelled"); }
    });

    it("threads a question it defers to a person onto the direct session", async () => {
      const registered: DeferredPermissionBody[] = [];
      const f = await build({ registerDeferral: async body => { registered.push(body); return null as never; } }, directWork);
      try {
        await f.session.bootstrap();
        await f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "q", params: { sessionId: "acp-1", toolCall: { toolCallId: "q", kind: "fetch", title: "Fetch a page" }, options } } as never);
        await vi.waitFor(() => expect(registered).toHaveLength(1));
        expect(registered[0]).toMatchObject({ sessionId: "s", assignmentId: "asg" });
      } finally { await f.session.close("cancelled"); }
    });
  });

  describe("DeepSeek Harness tool governance (dsh-runtime-support CP3)", () => {
    const dshWork: RemoteWorkAssignment = { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "dsh" } };
    const options = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }];
    async function dshSession() {
      const quarantine = vi.fn(async () => undefined);
      const f = await build({ policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true) }, dshWork);
      (f.runner as unknown as { quarantine: typeof quarantine }).quarantine = quarantine;
      await f.session.bootstrap();
      const toolCall = (toolCallId: string, title: string, rawInput: Record<string, unknown>) =>
        f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress", rawInput } } });
      const finished = (toolCallId: string) =>
        f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [] } } });
      const ask = (requestId: string, toolCallId: string) =>
        f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId, params: { sessionId: "acp-1", toolCall: { toolCallId }, options } });
      const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string } } | undefined)?.outcome.optionId;
      return { ...f, quarantine, toolCall, finished, ask, answer };
    }

    it("judges the real command and path behind each dsh request with the native policy", async () => {
      const f = await dshSession();
      await f.toolCall("t-echo", "bash", { command: "echo hello" }); await f.ask("p-echo", "t-echo");
      await f.toolCall("t-push", "bash", { command: "git push origin main" }); await f.ask("p-push", "t-push");
      await f.toolCall("t-sudo", "bash", { command: "sudo rm -rf /tmp/x" }); await f.ask("p-sudo", "t-sudo");
      await f.toolCall("t-in", "write", { file_path: "notes.txt", content: "hi" }); await f.ask("p-in", "t-in");
      await f.toolCall("t-out", "write", { file_path: "/etc/outside.txt", content: "no" }); await f.ask("p-out", "t-out");
      await f.toolCall("t-mcp", "mcp__konteks-platform__platform__builtin__echo", { text: "ping" }); await f.ask("p-mcp", "t-mcp");
      await f.toolCall("t-esc", "bash", { command: "ls", sandbox_permissions: "danger-full-access", justification: "x" }); await f.ask("p-esc", "t-esc");
      await f.ask("p-ghost", "t-never-seen");
      expect({ echo: f.answer("p-echo"), push: f.answer("p-push"), sudo: f.answer("p-sudo"), inside: f.answer("p-in"), outside: f.answer("p-out"), mcp: f.answer("p-mcp"), escalation: f.answer("p-esc"), ghost: f.answer("p-ghost") })
        .toEqual({ echo: "allow-once", push: "reject-once", sudo: "reject-once", inside: "allow-once", outside: "reject-once", mcp: "allow-once", escalation: "reject-once", ghost: "reject-once" });
      expect(f.quarantine).not.toHaveBeenCalled();
    });

    it("gives dsh tool calls their ACP kind and the platform tool name in relayed activity", async () => {
      const f = await dshSession();
      await f.toolCall("t-1", "bash", { command: "ls" });
      await f.toolCall("t-2", "mcp__konteks-platform__platform__builtin__echo", { text: "ping" });
      const updates = f.sent.map(message => message.body as { method?: string; params?: { update?: Record<string, unknown> } }).filter(body => body.method === "session/update").map(body => body.params!.update!);
      expect(updates[0]).toMatchObject({ toolCallId: "t-1", kind: "execute", title: "bash" });
      expect(updates[1]).toMatchObject({ toolCallId: "t-2", name: "platform__builtin__echo" });
    });

    it("stops the turn and takes dsh out of service when a gated tool ran without asking", async () => {
      const f = await dshSession();
      await f.toolCall("t-ok", "bash", { command: "ls" }); await f.ask("p-ok", "t-ok"); await f.finished("t-ok");
      await f.toolCall("t-read", "read", { file_path: "a" }); await f.finished("t-read");
      expect(f.quarantine).not.toHaveBeenCalled();
      await f.toolCall("t-bypass", "bash", { command: "curl https://example.com" }); await f.finished("t-bypass");
      expect(f.runner.cancel).toHaveBeenCalledWith("acp-1");
      expect(f.quarantine).toHaveBeenCalledWith(expect.stringMatching(/without asking/));
      expect(f.closed).toEqual(["agent_exited"]);
    });
  });

  describe("OpenCode tool governance (opencode-runtime-support CP4)", () => {
    const openCodeWork: RemoteWorkAssignment = { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "opencode" } };
    // OpenCode 2 always offers once / always / reject; Konteks never picks "always".
    const options = [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
    const CWD = "/private/native/checkout";
    const KINDS: Record<string, string> = { shell: "execute", write: "edit", edit: "edit", execute: "other", subagent: "think", read: "read" };
    async function openCodeSession(work: RemoteWorkAssignment = openCodeWork) {
      const quarantine = vi.fn(async () => undefined);
      const f = await build({
        policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true),
        // The platform facade under the name Core gives it (core/client.ts).
        redeemCapabilityToken: async () => ({ mcpServer: { name: "konteks-platform", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }, expiresAt: "2026-09-07T00:00:00Z" }),
      }, work);
      (f.runner as unknown as { quarantine: typeof quarantine }).quarantine = quarantine;
      await f.session.bootstrap();
      const update = (value: Record<string, unknown>) => f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: value } });
      const toolCall = async (toolCallId: string, title: string, rawInput: Record<string, unknown>) => {
        await update({ sessionUpdate: "tool_call", toolCallId, title, kind: KINDS[title.split(": ").at(-1)!] ?? "other", status: "pending", locations: [], rawInput: {} });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawInput });
      };
      const finished = (toolCallId: string, rawOutput?: unknown) => update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [], ...(rawOutput ? { rawOutput } : {}) });
      const ask = (requestId: string, toolCallId: string, kind: string, title: string, rawInput: Record<string, unknown>) =>
        f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId, params: { sessionId: "acp-1", toolCall: { toolCallId, kind, title, rawInput }, options } });
      const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string; outcome: string } } | undefined)?.outcome.optionId ?? "none";
      return { ...f, quarantine, toolCall, finished, ask, answer, update };
    }

    it("refuses git push, sudo, outside writes and hostile Code Mode, allows echo, in-folder writes and Konteks tools", async () => {
      const f = await openCodeSession();
      const shell = async (id: string, command: string) => { await f.toolCall(id, "shell", { command, description: "run" }); await f.ask(`p-${id}`, id, "execute", command, { command, timeout: 60000, cwd: CWD }); };
      await shell("echo", "echo hello");
      await shell("push", "git push origin main");
      await shell("sudo", "sudo rm -rf /tmp/x");
      await f.toolCall("in", "write", { path: `${CWD}/notes.txt`, content: "hi" }); await f.ask("p-in", "in", "edit", "notes.txt", { path: `${CWD}/notes.txt`, content: "hi" });
      await f.toolCall("out", "write", { path: "/etc/outside.txt", content: "no" }); await f.ask("p-out", "out", "edit", "/etc/outside.txt", { path: "/etc/outside.txt", content: "no" });
      await f.toolCall("multi", "edit", {}); await f.ask("p-multi", "multi", "edit", "2 files", { files: [{ file: "src/a.ts", patch: "@@" }, { file: "../../../etc/b", patch: "@@" }] });
      // A subagent may start; its own git push is refused like the parent's.
      await f.toolCall("sub", "subagent", { agent: "general", prompt: "push it" }); await f.ask("p-sub", "sub", "think", "subagent", { agent: "general", prompt: "push it" });
      await f.toolCall("ses_c1:call_1", "Push it: shell", { command: "git push" }); await f.ask("p-subpush", "ses_c1:call_1", "execute", "Push it: git push", { command: "git push", cwd: CWD });
      const code = async (id: string, source: string) => { await f.toolCall(id, "execute", { code: source }); await f.ask(`p-${id}`, id, "other", "execute", { code: source }); };
      await code("ours", 'const plan = await tools["konteks-platform"].platform__harness__plan_get({ planId: "p-1" });\nreturn plan;');
      await code("result", 'return await tools["konteks-result"].submit_result({ verdict: "pass" });');
      await code("move", 'await tools.opencode.session_move({ directory: "/" });');
      await code("computed", 'const name = "submit_result"; await tools["konteks-result"][name]({});');
      await code("loop", 'for (const x of [1, 2]) { await tools["konteks-result"].submit_result({ x: 1 }); }');
      await code("preview", 'await tools["konteks-preview"].preview_start();');
      await f.ask("p-ghost", "never-seen", "execute", "echo", { command: "echo" });
      expect({
        echo: f.answer("p-echo"), push: f.answer("p-push"), sudo: f.answer("p-sudo"), inside: f.answer("p-in"), outside: f.answer("p-out"), multi: f.answer("p-multi"),
        subagent: f.answer("p-sub"), subagentPush: f.answer("p-subpush"), ours: f.answer("p-ours"), result: f.answer("p-result"), move: f.answer("p-move"),
        computed: f.answer("p-computed"), loop: f.answer("p-loop"), noPreviewHere: f.answer("p-preview"), ghost: f.answer("p-ghost"),
      }).toEqual({
        echo: "once", push: "reject", sudo: "reject", inside: "once", outside: "reject", multi: "reject",
        subagent: "once", subagentPush: "reject", ours: "once", result: "once", move: "reject",
        computed: "reject", loop: "reject", noPreviewHere: "reject", ghost: "reject",
      });
      expect(JSON.stringify(vi.mocked(f.runner.answer).mock.calls.map(call => call[2]))).not.toContain('"always"');
      expect(f.quarantine).not.toHaveBeenCalled();
      await f.session.close("cancelled");
    });

    it("names OpenCode's tools in plain words, and a Code Mode block as the Konteks tool it calls", async () => {
      const f = await openCodeSession();
      await f.toolCall("t-1", "shell", { command: "ls" });
      await f.toolCall("t-2", "execute", { code: 'return await tools["konteks-result"].submit_result({ verdict: "pass" });' });
      await f.toolCall("t-3", "execute", { code: "await tools.opencode.session_move({});" });
      const updates = f.sent.map(message => message.body as { method?: string; params?: { update?: Record<string, unknown> } }).filter(body => body.method === "session/update").map(body => body.params!.update!);
      expect(updates[0]).toMatchObject({ toolCallId: "t-1", name: "shell", kind: "execute" });
      expect(updates.filter(update => update.toolCallId === "t-2").at(-1)).toMatchObject({ name: "submit_result", title: "submit_result", kind: "other" });
      expect(updates.filter(update => update.toolCallId === "t-3").at(-1)).toMatchObject({ name: "code_mode", title: "Code Mode", kind: "other" });
      expect(JSON.stringify(updates)).not.toContain("session_move");
      await f.session.close("cancelled");
    });

    it("stops the turn and takes OpenCode out of service when a gated tool ran without asking", async () => {
      const f = await openCodeSession();
      await f.toolCall("t-ok", "shell", { command: "ls" }); await f.ask("p-ok", "t-ok", "execute", "ls", { command: "ls", cwd: CWD }); await f.finished("t-ok");
      await f.toolCall("t-read", "read", { filePath: `${CWD}/a.ts` }); await f.finished("t-read");
      expect(f.quarantine).not.toHaveBeenCalled();
      await f.toolCall("t-bypass", "shell", { command: "curl https://example.com" }); await f.finished("t-bypass");
      expect(f.runner.cancel).toHaveBeenCalledWith("acp-1");
      expect(f.quarantine).toHaveBeenCalledWith("OpenCode ran a tool without Konteks' approval. Update or reinstall OpenCode, then restart the connector.");
      expect(f.closed).toEqual(["agent_exited"]);
    });

    it("trips when an approved Code Mode block ran a call Konteks did not approve", async () => {
      const f = await openCodeSession();
      const source = 'return await tools["konteks-result"].submit_result({ verdict: "pass" });';
      await f.toolCall("x-1", "execute", { code: source }); await f.ask("p-x1", "x-1", "other", "execute", { code: source });
      await f.finished("x-1", { metadata: { toolCalls: [{ tool: "konteks-result.submit_result", status: "completed" }] } });
      expect(f.quarantine).not.toHaveBeenCalled();
      await f.toolCall("x-2", "execute", { code: source }); await f.ask("p-x2", "x-2", "other", "execute", { code: source });
      await f.finished("x-2", { metadata: { toolCalls: [{ tool: "konteks-result.submit_result", status: "completed" }, { tool: "opencode.session_move", status: "completed" }] } });
      expect(f.quarantine).toHaveBeenCalledOnce();
      expect(f.closed).toEqual(["agent_exited"]);
    });

    it("tells an OpenCode session how Konteks runs its tools, and asks for the result in that form", async () => {
      const f = await openCodeSession({ ...validation, agentRoute: { requiredRole: "qa", agentId: "opencode" } });
      await f.session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "Review the change." }, { type: "text", text: renderStructuredOutputContract({ type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] }) }] } });
      const forwarded = (vi.mocked(f.runner.prompt).mock.calls[0]![2] as { prompt: Array<{ text: string }> }).prompt;
      expect(forwarded[0]!.text).toBe("Call Konteks tools (`konteks-result`) from your `execute` tool, only in this form: `const result = await tools[\"konteks-result\"].<tool>({ ...literal arguments... });`, one call per statement, then `return result;`. Konteks refuses any other code: no other tools, loops, variables in arguments or built names.");
      expect(forwarded.at(-1)!.text).toContain('call `await tools["konteks-result"].submit_result({ ... })` once');
      await f.session.close("cancelled");
    });
  });

  describe("Google Antigravity tool governance (antigravity-runtime-support CP4)", () => {
    const agyWork: RemoteWorkAssignment = { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "antigravity" } };
    // antigravity-acp 1.2.1 with an API key offers allow_always too; Gemini Enterprise only once / reject.
    const options = [{ optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
    const CWD = "/private/native/checkout";
    const SESSION = "7f941318-42d2-4710-9eca-c791fbc0770a";
    async function agySession(work: RemoteWorkAssignment = agyWork, credentialMethod?: string) {
      const quarantine = vi.fn(async () => undefined);
      const f = await build({
        policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true),
        redeemCapabilityToken: async () => ({ mcpServer: { name: "konteks-platform", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }, expiresAt: "2026-09-07T00:00:00Z" }),
      }, work);
      (f.runner as unknown as { quarantine: typeof quarantine }).quarantine = quarantine;
      (f.runner as unknown as { readiness: () => Promise<unknown> }).readiness = async () => ({
        agent: { agentId: "antigravity", credentials: credentialMethod === undefined ? [] : [{ providerId: "google", label: "x", kind: credentialMethod === "gemini-api-key" ? "api_key" : "sign_in", method: credentialMethod, state: "ready" }] },
        utilization: { activeSessions: 1, activeTurns: 1 },
      });
      await f.session.bootstrap();
      const update = (value: Record<string, unknown>) => f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: value } });
      /** The call as the server reports it, then its request with the same title, kind and input. */
      const asked = async (requestId: string, call: Record<string, unknown>) => {
        await update({ sessionUpdate: "tool_call", status: "pending", ...call });
        await f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId, params: { sessionId: "acp-1", toolCall: { ...call, status: "pending" }, options } as never });
      };
      const command = (id: string, line: string, cwd = CWD) => ({ toolCallId: id, title: line, kind: "execute", rawInput: { CommandLine: line, Cwd: cwd, WaitMsBeforeAsync: 5000 } });
      const createFile = (id: string, path: string) => ({ toolCallId: id, title: "Run create_file?", kind: "edit", rawInput: { CodeContent: "hi", Description: "probe", Overwrite: true, TargetFile: path }, locations: [{ path }], content: [{ path, newText: "hi", type: "diff" }] });
      const mcp = (id: string, server: string, tool: string) => ({ toolCallId: id, title: `${server}_${tool}`, kind: "other", rawInput: { arguments: {} }, _meta: { mcp: { server, tool }, is_mcp_tool_call: true } });
      const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string; outcome: string } } | undefined)?.outcome.optionId ?? "none";
      return { ...f, quarantine, update, asked, command, createFile, mcp, answer };
    }

    it("refuses git push, sudo, outside writes, other MCP servers, subagents and the trust question; allows echo, in-folder writes and our tools; never allow_always", async () => {
      const f = await agySession();
      await f.asked("p-echo", f.command("c-echo", "echo hello"));
      await f.asked("p-push", f.command("c-push", "git push origin HEAD:probe-push"));
      await f.asked("p-sudo", f.command("c-sudo", "sudo rm -rf /tmp/x"));
      await f.asked("p-cwd", f.command("c-cwd", "ls", "/etc"));
      await f.asked("p-in", f.createFile("e-in", `${CWD}/inside.txt`));
      await f.asked("p-out", f.createFile("e-out", "/private/native/outside.txt"));
      await f.asked("p-result", f.mcp("m-result", "konteks-result", "submit_result"));
      await f.asked("p-platform", f.mcp("m-platform", "konteks-platform", "platform__harness__plan_get"));
      // A hostile repository's `.agents/mcp_config.json` server, had it loaded.
      await f.asked("p-repo", f.mcp("m-repo", "repo-tools", "exfiltrate"));
      // A hostile repository's `.agents/hooks.json`: the server first asks whether to trust it.
      await f.asked("p-trust", { toolCallId: "interaction_9cf7b4aa", title: "Do you trust the authors of this workspace to execute automated agent hooks?", rawInput: {} });
      await f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "p-ghost", params: { sessionId: "acp-1", toolCall: f.command("never-seen", "echo"), options } as never });
      expect({
        echo: f.answer("p-echo"), push: f.answer("p-push"), sudo: f.answer("p-sudo"), cwd: f.answer("p-cwd"), inside: f.answer("p-in"), outside: f.answer("p-out"),
        result: f.answer("p-result"), platform: f.answer("p-platform"), repo: f.answer("p-repo"), trust: f.answer("p-trust"), ghost: f.answer("p-ghost"),
      }).toEqual({
        echo: "allow", push: "deny", sudo: "deny", cwd: "deny", inside: "allow", outside: "deny",
        result: "allow", platform: "allow", repo: "deny", trust: "deny", ghost: "deny",
      });
      expect(JSON.stringify(vi.mocked(f.runner.answer).mock.calls.map(call => call[2]))).not.toContain("allow_always");
      expect(f.quarantine).not.toHaveBeenCalled();
      await f.session.close("cancelled");
    });

    it("pairs Gemini Enterprise's approved create_file with the Running edit_file that writes it, and trips on one nobody allowed", async () => {
      const f = await agySession(agyWork, "oauth-business");
      const path = `${CWD}/inside.txt`;
      await f.asked("p-1", f.createFile("67f8e438", path));
      expect(f.answer("p-1")).toBe("allow");
      await f.update({ sessionUpdate: "tool_call", toolCallId: `${SESSION}:2`, title: "Running edit_file", kind: "edit", status: "in_progress", rawInput: { file_path: path }, locations: [{ path }] });
      await f.update({ sessionUpdate: "tool_call_update", toolCallId: `${SESSION}:2`, status: "completed" });
      await f.update({ sessionUpdate: "tool_call_update", toolCallId: "67f8e438", status: "failed", rawOutput: "Tool call was approved but never executed." });
      expect(f.quarantine).not.toHaveBeenCalled();
      await f.update({ sessionUpdate: "tool_call", toolCallId: `${SESSION}:3`, title: "Running edit_file", kind: "edit", status: "in_progress", rawInput: { file_path: `${CWD}/other.txt` }, locations: [{ path: `${CWD}/other.txt` }] });
      await f.update({ sessionUpdate: "tool_call_update", toolCallId: `${SESSION}:3`, status: "completed" });
      expect(f.runner.cancel).toHaveBeenCalledWith("acp-1");
      // Not a command: the generic line, even on Gemini Enterprise.
      expect(f.quarantine).toHaveBeenCalledWith("Google Antigravity ran a tool without Konteks' approval. Update the connector, then restart it.");
      expect(f.closed).toEqual(["agent_exited"]);
    });

    it("A21: a command that ran with no request on Gemini Enterprise names the Require review setting", async () => {
      const f = await agySession(agyWork, "oauth-business");
      await f.update({ sessionUpdate: "tool_call", status: "in_progress", ...f.command("auto", "echo unasked") });
      await f.update({ sessionUpdate: "tool_call_update", toolCallId: "auto", status: "completed", rawOutput: { exitCode: 0, combinedOutput: "unasked\n" } });
      expect(f.quarantine).toHaveBeenCalledWith("Your organisation's Gemini Enterprise settings let Antigravity run commands without asking. Ask your Google Cloud admin to set Terminal auto-execution to Require review, then restart the connector.");
      expect(f.closed).toEqual(["agent_exited"]);
    });

    it("a subagent's command (never asked) trips; on a Gemini API key the line is the generic one", async () => {
      const f = await agySession(agyWork, "gemini-api-key");
      const id = "e1b92d65-1f8c-4c53-8885-e7cc4443b095:1";
      await f.update({ sessionUpdate: "tool_call", toolCallId: id, title: "git push origin HEAD:probe-push", kind: "execute", status: "in_progress", rawInput: { command_line: "git push origin HEAD:probe-push", working_dir: CWD } });
      await f.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { exitCode: 0 } });
      expect(f.quarantine).toHaveBeenCalledWith("Google Antigravity ran a tool without Konteks' approval. Update the connector, then restart it.");
    });

    it("a subagent tool in a tool_call takes Antigravity out of service at once", async () => {
      const f = await agySession();
      await f.update({ sessionUpdate: "tool_call", toolCallId: "sub", title: "Run invoke_subagent?", kind: "other", status: "pending", rawInput: { Subagents: [{ Prompt: "push the code" }] } });
      expect(f.quarantine).toHaveBeenCalledOnce();
      expect(f.closed).toEqual(["agent_exited"]);
    });

    it("admits the connector's QA browser as konteks-browser, never its hidden tools", async () => {
      const upstream = createServer((_req, res) => res.end("the preview"));
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const status = (sessionId: string) => ({ sessionId, state: "running" as const, phase: null, url: null, port: null, command: null, install: null, prepare: null, source: null, explanation: null, notes: [], message: "running", startedAt: null, readyAt: null, idleStopMinutes: 30, logTail: [], startedBy: null });
      const preview = { start: vi.fn(async (sessionId: string) => status(sessionId)), stop: vi.fn(async (sessionId: string) => status(sessionId)), status: vi.fn(status), touch: vi.fn(), permit: vi.fn(), forget: vi.fn(),
        origin: vi.fn((_sessionId: string) => origin), browsersPath: "/private/native/browsers" };
      const f = await build({ preview,
        policy: new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true) }, { ...agyWork, kind: "qa", agentRoute: { requiredRole: "qa", agentId: "antigravity" } } as RemoteWorkAssignment);
      (f.runner as { browserVersion?: () => string | null }).browserVersion = () => "0.0.82";
      await f.session.bootstrap();
      expect((f.runnerCalls[0]?.[1][0] as { browser?: unknown }).browser).toBeDefined();
      await f.session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "Check the page." }] } });
      const forwarded = (vi.mocked(f.runner.prompt).mock.calls[0]![2] as { prompt: Array<{ text: string }> }).prompt;
      expect(forwarded[0]!.text).toContain("`konteks-browser`");
      for (const [id, tool] of [["n", "browser_navigate"], ["u", "browser_run_code_unsafe"]]) {
        const call = { toolCallId: id, title: `konteks-browser_${tool}`, kind: "other", rawInput: { url: origin }, _meta: { mcp: { server: "konteks-browser", tool }, is_mcp_tool_call: true } };
        await f.session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "tool_call", status: "pending", ...call } } });
        await f.session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: `p-${id}`, params: { sessionId: "acp-1", toolCall: call, options } as never });
      }
      const answer = (requestId: string) => (vi.mocked(f.runner.answer).mock.calls.find(call => call[1] === requestId)?.[2] as { outcome: { optionId?: string } } | undefined)?.outcome.optionId;
      expect({ navigate: answer("p-n"), unsafe: answer("p-u") }).toEqual({ navigate: "allow", unsafe: "deny" });
      await f.session.close("cancelled");
      upstream.close();
    });

    it("tells an Antigravity session the call_mcp_tool form with its own servers, and asks for the result that way", async () => {
      const f = await agySession({ ...validation, agentRoute: { requiredRole: "qa", agentId: "antigravity", mcpCapabilityTokenRef: "ref-1" } } as RemoteWorkAssignment);
      await f.session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "Review the change." }, { type: "text", text: renderStructuredOutputContract({ type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] }) }] } });
      const forwarded = (vi.mocked(f.runner.prompt).mock.calls[0]![2] as { prompt: Array<{ text: string }> }).prompt;
      expect(forwarded[0]!.text).toBe("Call Konteks tools through your `call_mcp_tool` tool: `ServerName` is the server (`konteks-platform`, `konteks-result`), `ToolName` is the tool's name exactly as listed, and its parameters go in `Arguments` (for example `ServerName` `konteks-platform`). Konteks refuses every other MCP server, subagents and commands outside this working copy.");
      expect(forwarded.at(-1)!.text).toContain("call `submit_result` through your `call_mcp_tool` tool (`ServerName` `konteks-result`, `ToolName` `submit_result`, its arguments in `Arguments`) once");
      // Only the first prompt carries the line.
      await f.session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } } as never);
      await f.session.close("cancelled");
    });

    it("names Antigravity's tools in plain words and an MCP call as the Konteks tool it calls", async () => {
      const f = await agySession();
      await f.update({ sessionUpdate: "tool_call", status: "pending", ...f.createFile("t-1", `${CWD}/a.txt`) });
      await f.update({ sessionUpdate: "tool_call", status: "pending", ...f.mcp("t-2", "konteks-platform", "platform__harness__plan_get") });
      await f.update({ sessionUpdate: "tool_call", status: "in_progress", toolCallId: `${SESSION}:1`, title: "Running list_directory", kind: "search", rawInput: { directory_path: CWD } });
      await f.update({ sessionUpdate: "tool_call", status: "pending", ...f.command("t-3", "npm test") });
      const updates = f.sent.map(message => message.body as { method?: string; params?: { update?: Record<string, unknown> } }).filter(body => body.method === "session/update").map(body => body.params!.update!);
      expect(updates.find(update => update.toolCallId === "t-1")).toMatchObject({ name: "create_file", kind: "edit", title: "Create file" });
      expect(updates.find(update => update.toolCallId === "t-2")).toMatchObject({ name: "platform__harness__plan_get", kind: "other", title: "platform__harness__plan_get" });
      expect(updates.find(update => update.toolCallId === `${SESSION}:1`)).toMatchObject({ name: "list_directory", kind: "search", title: "List folder" });
      expect(updates.find(update => update.toolCallId === "t-3")).toMatchObject({ name: "run_command", kind: "execute", title: "npm test" });
      await f.session.close("cancelled");
    });
  });

  it("relays actual runner message/tool updates with the opaque session reference, never hidden thoughts", async () => {
    const events = new RunnerEventBus();
    const bridge = { exited: false, initializeResult: { protocolVersion: 1 }, connection: { newSession: async () => ({ sessionId: "private-bridge-session" }) } } as unknown as BridgeProcess;
    const manager = new SessionManager({ bridge: () => bridge, events, refStore: new InMemorySessionRefStore() });
    const base = await build();
    vi.mocked(base.runner.createSession).mockImplementation(args => manager.create(args));
    const handled: Promise<void>[] = [];
    events.subscribe(event => { handled.push(base.session.onRunnerEvent(event)); });
    const { acpSessionRef } = await base.session.bootstrap();
    manager.onSessionUpdate({ sessionId: "private-bridge-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running tests" } } });
    manager.onSessionUpdate({ sessionId: "private-bridge-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private-thought-canary" } } });
    manager.onSessionUpdate({ sessionId: "private-bridge-session", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run tests", status: "in_progress" } });
    manager.onSessionUpdate({ sessionId: "private-bridge-session", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } });
    manager.onSessionUpdate({ sessionId: "unknown-bridge-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong-session-canary" } } });
    await Promise.all(handled);
    const updates = base.sent.map(message => message.body).filter(body => (body as { method?: string }).method === "session/update");
    expect(updates).toHaveLength(3);
    expect(updates).toEqual([
      { kind: "acp", method: "session/update", params: { sessionId: acpSessionRef, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running tests" } } } },
      { kind: "acp", method: "session/update", params: { sessionId: acpSessionRef, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run tests", status: "in_progress" } } },
      { kind: "acp", method: "session/update", params: { sessionId: acpSessionRef, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } } },
    ]);
    expect(base.session.counters.malformedResponses).toBe(0);
    expect(JSON.stringify(base.sent)).not.toMatch(/private-bridge-session|private-thought-canary|wrong-session-canary/);
  });

  it("never announces readiness after a staging failure", async () => {
    const warn = vi.fn();
    const failed = await build({
      prepareInputs: async () => { throw new Error("input delivery failed secret-body"); },
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as never,
    });
    await expect(failed.session.bootstrap()).rejects.toThrow();
    expect(failed.runner.createSession).not.toHaveBeenCalled();
    expect(failed.sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: "asg",
      attempt: 1,
      stage: "input_preparation",
      code: "unexpected_error",
      retryable: false,
    }), "native session bootstrap stage failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-body");
  });

  it("finishes fallible cloud preparation before activating local execution ownership", async () => {
    const order: string[] = [];
    const activateExecution = vi.fn(async () => {
      order.push("activate");
      return { continueReference: "continued-ref" };
    });
    const { session, runner } = await build({
      prepareInputs: async () => {
        order.push("inputs");
        return { binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined };
      },
      redeemCapabilityToken: async () => {
        order.push("capability");
        return { mcpServer: { name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }, expiresAt: "2026-09-07T00:00:00Z" };
      },
      reserveChannel: () => () => undefined,
      activateExecution,
    }, { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "claude-code" } });

    await session.bootstrap();

    expect(order).toEqual(["inputs", "capability", "activate"]);
    expect(activateExecution).toHaveBeenCalledOnce();
    expect(vi.mocked(runner.createSession).mock.calls[0]?.[0]).toEqual(expect.objectContaining({ acpSessionRef: "continued-ref" }));
  });

  it("runs tool wiring alongside redemption, settles it before activation and the agent, and logs every stage (WS2-156)", async () => {
    const order: string[] = [];
    let finishWiring!: () => void;
    const toolWiring = new Promise<void>(resolve => { finishWiring = resolve; });
    const info = vi.fn();
    const { session, runner } = await build({
      logger: { warn: vi.fn(), info, error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as never,
      prepareInputs: async () => {
        order.push("inputs");
        return { binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout",
          skillInstructions: "", beforePrompt: async () => undefined, toolWiring: toolWiring.then(() => void order.push("wired")) };
      },
      redeemCapabilityToken: async () => {
        order.push("capability");
        return { mcpServer: { name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }, expiresAt: "2026-09-07T00:00:00Z" };
      },
      reserveChannel: () => () => undefined,
      activateExecution: async () => { order.push("activate"); return {}; },
    });
    vi.mocked(runner.createSession).mockImplementation(async () => {
      order.push("acp");
      return { acpSessionRef: "acp-1", resumed: false, capabilities: { forkSession: false, sessionResume: true } } as never;
    });

    const booting = session.bootstrap();
    await vi.waitFor(() => expect(order).toContain("capability"));
    await new Promise(resolve => setTimeout(resolve, 10));
    // Redemption did not wait for the wiring, and nothing past it started.
    expect(order).toEqual(["inputs", "capability"]);
    expect(runner.createSession).not.toHaveBeenCalled();
    finishWiring();
    await booting;

    expect(order).toEqual(["inputs", "capability", "wired", "activate", "acp"]);
    const stages = info.mock.calls.filter(call => (call[0] as { event?: string }).event === "native.bootstrap.stage")
      .map(call => call[0] as { stage: string; durationMs: number });
    expect(stages.map(stage => stage.stage)).toEqual(["input_preparation", "capability_redemption", "facade", "result_tool", "tool_wiring_wait",
      "activation", "acp_session_bootstrap", "readiness"]);
    for (const stage of stages) expect(stage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes Core's display label to the runner so the provider session is named after the work", async () => {
    const sessionLabel = { system: "Todo List", kind: "initiative", title: "[v3] Stand up the todo list API" };
    const { session, runner } = await build({}, { ...assignment, sessionLabel });
    await session.bootstrap();
    expect(vi.mocked(runner.createSession).mock.calls[0]?.[0]).toMatchObject({ sessionLabel });
    const unlabelled = await build();
    await unlabelled.session.bootstrap();
    expect(vi.mocked(unlabelled.runner.createSession).mock.calls[0]?.[0]).not.toHaveProperty("sessionLabel");
  });

  it("prefers a live continuation over the restart-only restore fallback", async () => {
    const { session, runner } = await build({
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      reserveChannel: () => () => undefined,
      restoreReference: "durable-restart-ref",
      activateExecution: async () => ({ continueReference: "live-ref" }),
    }, { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "claude-code" } });

    await session.bootstrap();

    expect(vi.mocked(runner.createSession)).toHaveBeenCalledWith(
      expect.objectContaining({ acpSessionRef: "live-ref" }),
      undefined,
    );
    expect(vi.mocked(runner.createSession).mock.calls[0]?.[0]).not.toHaveProperty("restoreAcpSessionRef");
  });

  it("uses staged conversation context instead of stale Claude provider tools after restart", async () => {
    const claude = { ...assignment, agentRoute: { ...assignment.agentRoute, agentId: "claude-code" } };
    const { session, runner } = await build({
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      reserveChannel: () => () => undefined,
      restoreReference: "durable-restart-ref",
    }, claude);

    await session.bootstrap();

    expect(vi.mocked(runner.createSession)).toHaveBeenCalledWith(expect.objectContaining({
      restoreAcpSessionRef: "durable-restart-ref",
      freshProviderSessionOnRestore: true,
    }), undefined);
  });

  it("does not activate local execution ownership when cloud preparation fails", async () => {
    const activateExecution = vi.fn(async () => ({ continueReference: "continued-ref" }));
    const { session, runner } = await build({
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      redeemCapabilityToken: async () => { throw new RemoteInstanceError("temporarily_unavailable", "Core is restarting.", { retryable: true }); },
      activateExecution,
    });

    await expect(session.bootstrap()).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(activateExecution).not.toHaveBeenCalled();
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("closes a native turn that ends without end_turn as an agent exit so a terminal reaches Core", async () => {
    const { session, closed, runner, journal, sent } = await build({
      reserveChannel: () => vi.fn(),
      reserveExecutionReference: async () => undefined,
      recordExecutionProcessOwner: async () => undefined,
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    vi.mocked(runner.createSession).mockImplementation(async (_input, lifecycle) => {
      await lifecycle!.beforeCreate("acp-1");
      lifecycle!.assertCurrent();
      return { acpSessionRef: "acp-1", resumed: false, capabilities: { forkSession: false, sessionResume: true } };
    });
    await session.bootstrap();
    await journal.pendingRequests.put({ acpSessionRef: "acp-1", id: "p1", method: "session/prompt", direction: "received", openedAt: clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
    // A rejected tool interrupts Claude Code's turn as `cancelled`; the turn is over either way.
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "cancelled" } });
    expect(closed).toEqual(["agent_exited"]);
    expect(runner.closeSession).toHaveBeenCalledWith("acp-1");
    expect(sent.at(-1)?.body).toMatchObject({ kind: "session_closed", assignmentId: "asg", reason: "agent_exited" });
  });

  it("says when a turn ends, so the computer's busy state reaches Core at once (WS1-179)", async () => {
    const onTurnActivity = vi.fn();
    const { session, runner, journal } = await build({
      onTurnActivity,
      reserveChannel: () => vi.fn(),
      reserveExecutionReference: async () => undefined,
      recordExecutionProcessOwner: async () => undefined,
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    vi.mocked(runner.createSession).mockImplementation(async (_input, lifecycle) => {
      await lifecycle!.beforeCreate("acp-1");
      lifecycle!.assertCurrent();
      return { acpSessionRef: "acp-1", resumed: false, capabilities: { forkSession: false, sessionResume: true } };
    });
    await session.bootstrap();
    await journal.pendingRequests.put({ acpSessionRef: "acp-1", id: "p1", method: "session/prompt", direction: "received", openedAt: clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "cancelled" } });
    expect(onTurnActivity).toHaveBeenCalled();
  });

  it("uses the verified logical session channel across native assignment attempts and retains replay on close", async () => {
    for (const attempt of [1, 2]) {
      const work = { ...assignment, id: `asg-${attempt}`, attempt };
      const { session, sent, transport } = await build({
        prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: work.id, instanceId: "inst", attempt }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      }, work);
      expect(session.channelId).toBeNull();
      await session.bootstrap();
      expect(session.channelId).toBe("session:s");
      expect(transport.openChannel).toHaveBeenCalledWith("session:s", "session");
      await session.close("cancelled");
      expect(sent.map(message => message.channelId)).toEqual(["session:s", "session:s"]);
      expect(sent.at(-1)?.body).toMatchObject({ kind: "session_closed", assignmentId: work.id });
      // Assignment completion is not logical-channel deletion: its final frame
      // and the next attempt must retain the same replay sequence space.
      expect(transport.closeChannel).not.toHaveBeenCalled();
    }
  });

  it("does not announce or close an invented native channel when cancelled before preparation", async () => {
    const { session, sent, transport } = await build();
    await session.close("cancelled");
    expect(session.channelId).toBeNull();
    expect(sent).toEqual([]);
    expect(transport.openChannel).not.toHaveBeenCalled();
    expect(transport.closeChannel).not.toHaveBeenCalled();
  });

  it("waits for Core readiness and never prompts or emits readiness while registration is pending", async () => {
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const registering = new Promise<void>(resolve => { entered = resolve; });
    const { session, runner, sent, transport } = await build({
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      registerReady: async () => { entered(); return new Promise((_, fail) => { reject = fail; }); },
    });
    const boot = session.bootstrap();
    const outcome = boot.then(() => null, error => error);
    // Race against bootstrap so the missing registration implementation fails
    // immediately instead of leaving the characterization hanging.
    await Promise.race([registering, boot]);
    expect(transport.openChannel).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "early", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "too early" }] } });
    expect(runner.prompt).not.toHaveBeenCalled();
    reject(new Error("Core denied readiness"));
    expect(await outcome).toBeInstanceOf(Error);
    expect(runner.cancel).toHaveBeenCalledWith("acp-1");
    expect(runner.closeSession).toHaveBeenCalledWith("acp-1");
    expect(sent).toEqual([]);
  });

  it("replays both native attempts in one real mux sequence including their terminal frames", async () => {
    const emitted: Array<ToCoreRelayFrame | RelayAck> = [];
    const key = generateInstanceKey();
    const mux = new ChannelMux({ recoveryAuthority: () => "accepted-test-generation", clock, key: () => key, ackIntervalSeconds: 5, ackEveryFrames: 3, replayBufferBytes: 16_384, replayBufferAgeMs: 60_000,
      emit: frame => { emitted.push(frame); return true; }, onFrame: () => undefined, onStall: () => undefined, onReset: () => undefined, persistCursors: async () => undefined });
    const transport = { openChannel: (id: string) => mux.openChannel(id, "session"), closeChannel: (id: string) => mux.closeChannel(id),
      send: (message: OutboundMessage) => mux.send(message.channelId, message.channel, message.body, message.signature) } as TransportManager;
    for (const attempt of [1, 2]) {
      const work = { ...assignment, id: `asg-${attempt}`, attempt };
      const { session } = await build({ transport,
        prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: work.id, instanceId: "inst", attempt }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      }, work);
      await session.bootstrap();
      await session.close("cancelled");
    }
    expect(emitted).toEqual([]);
    mux.applyHandshake({ connectionEpoch: 7, resume: { "session:s": { to_core: 0, to_runtime: 0 } }, reset: [] });
    expect(emitted.map(frame => "seq" in frame ? [frame.channelId, frame.seq, frame.body.kind] : null)).toEqual([
      ["session:s", 1, "session_ready"], ["session:s", 2, "session_closed"],
      ["session:s", 3, "session_ready"], ["session:s", 4, "session_closed"],
    ]);
  });

  it("withholds unfiltered tool arguments/outputs and masks known secrets and private paths before relay persistence", async () => {
    const { session, sent } = await build();
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: `Test /private/native/checkout/src/index.ts using ${SECRET_CANARIES.openAiKey}`, status: "in_progress",
        rawInput: { password: "unshaped-input-secret" }, rawOutput: { value: "unshaped-output-secret" },
        locations: [{ path: "/Users/private-person/private-repo/secret.ts" }],
        content: [{ type: "content", content: { type: "text", text: `Read /Users/private-person/secret.txt with ${SECRET_CANARIES.bearer}` } }],
        _meta: { private: "metadata-canary" },
      },
    } });
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toMatch(/unshaped-input-secret|unshaped-output-secret|private-person|metadata-canary/);
    expect(serialized).not.toContain(SECRET_CANARIES.openAiKey);
    expect(serialized).not.toContain(SECRET_CANARIES.bearer);
    expect(serialized).not.toContain("/private/native/checkout");
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp", method: "session/update", params: { sessionId: "acp-1", update: { toolCallId: "tool", status: "in_progress" } } });
    expect(serialized).toContain("src/index.ts");
  });

  it.each(["completed", "failed"] as const)("relays a %s terminal for a deep private MCP result without changing its public outcome", async status => {
    const { session, sent } = await build();
    await session.bootstrap();
    const before = sent.length;
    const deepBreakdown = { result: { structuredContent: { breakdown: { roadmap: { milestones: [{ sprints: [{
      id: "S1", tickets: [{ ref: "T2", dependsOnRefs: ["T1"] }],
    }] }] } } } } };
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1", update: {
        sessionUpdate: "tool_call_update", toolCallId: "exec-breakdown", status,
        rawInput: { token: SECRET_CANARIES.openAiKey }, rawOutput: deepBreakdown,
        content: [{ type: "content", content: { type: "text", text: `Plan ready in /private/native/checkout with ${SECRET_CANARIES.bearer}` } }],
      },
    } });
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp", method: "session/update", params: {
      update: { toolCallId: "exec-breakdown", status, content: [{ type: "content", content: { type: "text", text: expect.stringContaining("Plan ready") } }] },
    } });
    const serialized = JSON.stringify(sent.at(-1)?.body);
    expect(serialized).not.toMatch(/rawInput|rawOutput|structuredContent|private\/native/);
    expect(serialized).not.toContain(SECRET_CANARIES.openAiKey);
    expect(serialized).not.toContain(SECRET_CANARIES.bearer);
    expect(serialized).toContain("Bearer [redacted]");
    expect(session.counters.malformedResponses).toBe(0);
  });

  it("allows an oversized private tool result without forwarding it", async () => {
    const { session, sent } = await build();
    await session.bootstrap();
    const before = sent.length;
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1", update: {
        sessionUpdate: "tool_call_update", toolCallId: "oversized-private", status: "completed",
        rawOutput: { result: "x".repeat(530_000) },
      },
    } });
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp", params: { update: { toolCallId: "oversized-private", status: "completed" } } });
    expect(JSON.stringify(sent.at(-1)?.body)).not.toContain("rawOutput");
    expect(session.counters.malformedResponses).toBe(0);
  });

  it("still rejects invalid public tool fields and oversized public content after private payload normalization", async () => {
    const { session, sent } = await build();
    await session.bootstrap();
    const before = sent.length;
    for (const update of [
      { sessionUpdate: "tool_call_update", toolCallId: "bad-title", status: "completed", title: "x".repeat(2049), rawOutput: { secret: "hidden" } },
      { sessionUpdate: "tool_call_update", toolCallId: "bad-content", status: "completed", content: [{ type: "content", content: { type: "text", text: "x".repeat(70_000) } }], rawOutput: { secret: "hidden" } },
    ]) {
      await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update } });
    }
    expect(sent).toHaveLength(before);
    expect(session.counters.malformedResponses).toBe(2);
  });

  it("relays every streamed chunk after one that ends inside a local path (D121)", async () => {
    const warn = vi.fn();
    const { session, sent } = await build({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as never });
    await session.bootstrap();
    const before = sent.length;
    const chunk = (text: string) => session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text } },
    } });
    // Codex streams a generator's reply a few tokens at a time; a path is split.
    await chunk("Editing /Users/private-person/rep");
    await chunk("o/src/index.ts now");
    await chunk(" and running the tests.");
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1", update: { sessionUpdate: "plan", entries: [{ content: "Run the tests", priority: "medium", status: "in_progress" }] },
    } });
    expect(session.counters.malformedResponses).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: "session.acp_message_rejected" }), expect.anything());
    const bodies = sent.slice(before).map(message => message.body as { kind: string; method: string; params: { update: { sessionUpdate: string; content?: { text: string } } } });
    expect(bodies.map(body => [body.kind, body.method, body.params.update.sessionUpdate])).toEqual([
      ["acp", "session/update", "agent_message_chunk"],
      ["acp", "session/update", "agent_message_chunk"],
      ["acp", "session/update", "agent_message_chunk"],
      ["acp", "session/update", "plan"],
    ]);
    const text = bodies.slice(0, 3).map(body => body.params.update.content?.text).join("");
    expect(text).toBe("Editing [local-path][local-path] now and running the tests.");
    expect(JSON.stringify(bodies)).not.toContain("private-person");
  });

  it("names the refused field when a redacted update still fails the relay contract (D121)", async () => {
    const warn = vi.fn();
    const { session, sent } = await build({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as never });
    await session.bootstrap();
    const before = sent.length;
    // Within the 2048-character title bound before redaction, past it after.
    const title = "/a ".repeat(680);
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1", update: { sessionUpdate: "tool_call", toolCallId: "long-title", title, status: "pending" },
    } });
    expect(sent).toHaveLength(before);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "session.acp_message_rejected", stage: "redacted_schema", sessionUpdate: "tool_call", issuePath: "params.update.title", issueCode: "too_big",
    }), expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/a /a");
  });

  it.each([
    ["Agent", "other"],
    ["ToolSearch", "search"],
  ] as const)("relays Claude %s identity without relaying private metadata", async (name, kind) => {
    const claudeAssignment = {
      ...assignment,
      agentRoute: { ...assignment.agentRoute, agentId: "claude-code" },
    };
    const { session, sent } = await build({}, claudeAssignment);
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${name}`,
        title: "Other",
        kind: "other",
        status: "in_progress",
        _meta: { "claude.ai/tool": { name, kind: "other", private: "metadata-canary" } },
      },
    } });
    expect(sent.at(-1)?.body).toMatchObject({
      kind: "acp",
      method: "session/update",
      params: { update: { title: name, name, kind } },
    });
    expect(JSON.stringify(sent.at(-1)?.body)).not.toContain("metadata-canary");

    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: `tool-${name}`,
        status: "completed",
      },
    } });
    expect(sent.at(-1)?.body).toMatchObject({
      kind: "acp",
      method: "session/update",
      params: { update: { title: name, name, kind, status: "completed" } },
    });
  });

  it("relays title-only Claude ToolSearch as the canonical search tool", async () => {
    const claudeAssignment = {
      ...assignment,
      agentRoute: { ...assignment.agentRoute, agentId: "claude-code" },
    };
    const { session, sent } = await build({}, claudeAssignment);
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: {
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-search-title-only",
        title: "ToolSearch",
        kind: "other",
        status: "in_progress",
      },
    } });

    expect(sent.at(-1)?.body).toMatchObject({
      kind: "acp",
      method: "session/update",
      params: { update: { title: "ToolSearch", name: "ToolSearch", kind: "search" } },
    });
  });

  it("prepares local inputs but refuses native mutation without execution admission", async () => {
    const beforePrompt = vi.fn(async () => undefined);
    const skillInstructions = "Read the required org skill at /private/native/org/review/SKILL.md";
    const prepareInputs = vi.fn(async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions, beforePrompt }));
    const { session, runner, sent, journal } = await build({ prepareInputs });
    await session.bootstrap();
    expect(prepareInputs).toHaveBeenCalledWith(assignment);
    expect(sent[0]?.body).toMatchObject({ kind: 'session_ready', attempt: 1, recoveryEpoch: 0, readyRevision: 1 });
    expect(runner.createSession.mock.calls[0]?.[0]).toMatchObject({ cwd: "/private/native/checkout" });
    await expect(session.onToRuntime({ kind: "acp", method: "session/prompt", id: "prepared-1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "do the work" }] } })).rejects.toMatchObject({ code: "execution_authority_unavailable" });
    expect(beforePrompt).not.toHaveBeenCalled();
    expect(runner.prompt).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toContain("/private/native");
    expect(JSON.stringify(journal.openRequests("acp-1"))).not.toContain(skillInstructions);
    expect(journal.openRequests("acp-1")).toHaveLength(0);
  });

  it("rejects a prepared checkout bound to a different assignment before runner creation", async () => {
    const { session, runner } = await build({ prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "other", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }) });
    await expect(session.bootstrap()).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("does not create an agent session after cancellation during input staging", async () => {
    let finish!: (value: { binding: { workspaceId: string; sessionId: string; assignmentId: string; instanceId: string; attempt: number }; cwd: string; skillInstructions: string; beforePrompt: () => Promise<void> }) => void;
    const preparation = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
    const { session, runner, sent } = await build({ prepareInputs: async () => preparation });
    const boot = session.bootstrap();
    await session.close("cancelled");
    finish({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined });
    await expect(boot).rejects.toMatchObject({ code: "assignment_conflict" });
    expect(runner.createSession).not.toHaveBeenCalled();
    expect(sent.some(message => (message.body as { kind?: string }).kind === "session_ready")).toBe(false);
  });

  it("settles a completed native Assistant assignment without retiring the logical session channel", async () => {
    const recordCompletedSettlement = vi.fn(async () => undefined);
    const release = vi.fn();
    const { session, sent, closed, transport, runner, journal } = await build({
      recordCompletedSettlement,
      reserveChannel: () => release,
      reserveExecutionReference: async () => undefined,
      recordExecutionProcessOwner: async () => undefined,
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    let assertGenerationCurrent: (() => void) | undefined;
    vi.mocked(runner.createSession).mockImplementation(async (_input, lifecycle) => {
      await lifecycle!.beforeCreate("acp-1");
      assertGenerationCurrent = lifecycle!.assertCurrent;
      lifecycle!.assertCurrent();
      return { acpSessionRef: "acp-1", resumed: false, capabilities: { forkSession: false, sessionResume: true } };
    });
    vi.mocked(runner.closeSession).mockImplementation(async () => {
      // The real SessionManager rechecks the lifecycle fence while obtaining
      // the completed-turn settlement receipt. Normal close must not fence
      // this exact operation before it can settle.
      assertGenerationCurrent!();
      return { completion: "native_continuation_ready" };
    });
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "unknown", result: { stopReason: "end_turn" } });
    expect(closed).toEqual([]);
    // Start at the completion boundary; operation admission has its own suite.
    await journal.pendingRequests.put({ acpSessionRef: "acp-1", id: "p1", method: "session/prompt", direction: "received", openedAt: clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } });
    expect(closed).toEqual(["completed"]);
    expect(runner.closeSession).toHaveBeenCalledWith("acp-1", { completed: true });
    expect(recordCompletedSettlement).toHaveBeenCalledWith("acp-1");
    expect(release).not.toHaveBeenCalled();
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(transport.closeChannel).not.toHaveBeenCalled();
    expect(sent.slice(-2).map(message => (message.body as { kind: string }).kind)).toEqual(["acp_result", "session_closed"]);
  });

  it.each(["close_failed", "missing_receipt", "write_failed"])("does not report completed or release the channel after %s", async failure => {
    const release = vi.fn();
    const recordCompletedSettlement = vi.fn(async () => { if (failure === "write_failed") throw new Error("disk unavailable"); });
    const { session, sent, closed, runner, journal } = await build({
      recordCompletedSettlement,
      reserveChannel: () => release,
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    if (failure === "close_failed") vi.mocked(runner.closeSession).mockRejectedValue(new Error("close failed"));
    else vi.mocked(runner.closeSession).mockResolvedValue(failure === "missing_receipt" ? undefined : { completion: "native_continuation_ready" });
    await session.bootstrap();
    await journal.pendingRequests.put({ acpSessionRef: "acp-1", id: "p1", method: "session/prompt", direction: "received", openedAt: clock.nowIso(), closedAt: null, deadlineAt: null, requestDigest: null });
    await expect(session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } })).rejects.toThrow();
    expect(closed).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(sent.some(message => (message.body as { kind?: string }).kind === "session_closed")).toBe(false);
    if (failure !== "write_failed") expect(recordCompletedSettlement).not.toHaveBeenCalled();
  });

  it.each([true, false])("requires independent recovery settlement after a completed journal failure (settled=%s)", async settled => {
    const release = vi.fn();
    const { session, sent, closed, runner } = await build({
      reserveChannel: () => release,
      recordCompletedSettlement: async () => { throw new Error("disk unavailable"); },
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    vi.mocked(runner.closeSession).mockResolvedValue({ completion: "native_continuation_ready" });
    const stop = vi.fn(async () => { if (!settled) throw new Error("unconfirmed stop"); });
    Object.assign(runner, { stopForRecovery: stop });
    await session.bootstrap();
    await expect(session.close("completed")).rejects.toThrow("disk unavailable");
    if (settled) await expect(session.stopForRecovery()).resolves.toBeUndefined();
    else await expect(session.stopForRecovery()).rejects.toThrow("unconfirmed stop");
    expect(stop).toHaveBeenCalledExactlyOnceWith("acp-1");
    expect(runner.closeSession).toHaveBeenCalledTimes(1);
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(sent.some(message => (message.body as { kind?: string }).kind === "session_closed")).toBe(false);
  });

  /** A native validation session: its checkout source has no execution gate, so ACP frames flow directly. */
  const validation: RemoteWorkAssignment = { ...assignment, kind: "validation", agentRoute: { requiredRole: "qa", agentId: "codex" },
    source: { kind: "harness_task_checkout", portability: "instance_bound", ownerInstanceId: "inst", workspaceRef: "ref" } };

  it("journals a received prompt, completes it once with the same id and method, and rejects duplicates/unknown completions", async () => {
    const { session, sent, runner, journal } = await build({}, validation);
    await session.bootstrap();
    await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "hi" }] } });
    expect(runner.prompt).toHaveBeenCalledWith("acp-1", "p1", { sessionId: "acp-1", prompt: [{ type: "text", text: "hi" }] });
    expect(journal.openRequests("acp-1")).toHaveLength(1);
    await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "again" }] } });
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp_error", id: "p1", error: { class: "unknown_request" } });
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } });
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp_result", id: "p1", method: "session/prompt", result: { stopReason: "end_turn" } });
    expect(journal.openRequests("acp-1")).toHaveLength(0);
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } });
    expect(session.counters.unknownCompletions).toBe(2);
  });

  describe("structured result (submit_result)", () => {
    const schema = { type: "object", properties: { verdict: { type: "string", enum: ["pass", "fail"] } }, required: ["verdict"], additionalProperties: false };
    const contract = renderStructuredOutputContract(schema);
    const promptWithContract = { sessionId: "acp-1", prompt: [{ type: "text" as const, text: "Review the change." }, { type: "text" as const, text: contract }] };

    /** The session's result tool as its agent reaches it; `relists` makes it behave like Claude Code (re-read tools on list_changed). */
    async function resultTool(runnerCalls: Array<[string, unknown[]]>, relists: boolean) {
      const servers = (runnerCalls[0]?.[1][0] as { mcpServers: Array<{ name: string; url: string; headers: Array<{ value: string }> }> }).mcpServers;
      const tool = servers.find(server => server.name === "konteks-result")!;
      const headers = { authorization: tool.headers[0]!.value, "content-type": "application/json" };
      const post = async (body: unknown) => (await fetch(tool.url, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<{ result: { tools?: Array<{ inputSchema: unknown }>; content: Array<{ text: string }>; isError?: boolean } }>;
      const list = () => post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const stream = await fetch(tool.url, { headers: { authorization: tool.headers[0]!.value, accept: "text/event-stream" } });
      const reader = stream.body!.getReader();
      // Re-reads the agent starts on its own; `stop` waits for them, so none is
      // still in flight (and rejects unhandled) when the session closes its server.
      const relisted: Array<Promise<unknown>> = [];
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          if (relists && new TextDecoder().decode(value).includes("list_changed")) relisted.push(list().catch(() => undefined));
        }
      })();
      const submit = (args: unknown) => post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_result", arguments: args } });
      const stop = async () => {
        await reader.cancel().catch(() => undefined);
        await Promise.all(relisted);
      };
      return { list, submit, stop };
    }

    it("lifts the contract into the tool, prompts with one line, and returns the tool's value with the completion", async () => {
      const { session, sent, runner, runnerCalls } = await build({}, validation);
      await session.bootstrap();
      const agent = await resultTool(runnerCalls, true);
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: promptWithContract });
      // The agent read the tool list again, so the schema is only in the tool definition.
      expect(runner.prompt).toHaveBeenCalledWith("acp-1", "p1", { sessionId: "acp-1", prompt: [{ type: "text", text: "Review the change." }, { type: "text", text: "When you are finished, call `submit_result` once with your result." }] });
      expect((await agent.list()).result.tools![0]!.inputSchema).toEqual(schema);
      const wrong = await agent.submit({ verdict: "maybe" });
      expect(wrong.result.isError).toBe(true);
      expect(wrong.result.content[0]!.text).toContain("/verdict");
      await agent.submit({ verdict: "pass" });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 } } });
      expect(sent.at(-1)?.body).toEqual({ kind: "acp_result", id: "p1", method: "session/prompt", result: { stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 }, structuredOutput: { source: "tool", value: { verdict: "pass" } } } });
      // The turn is over: the tool is generic again.
      expect((await agent.list()).result.tools![0]!.inputSchema).toEqual({ type: "object", additionalProperties: true });
      await agent.stop();
      await session.close("cancelled");
    });

    it("puts the schema in the prompt line for an agent that keeps its first tool list (Codex), and still validates the call", async () => {
      const { session, sent, runner, runnerCalls } = await build({}, validation);
      await session.bootstrap();
      const agent = await resultTool(runnerCalls, false);
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: promptWithContract });
      const forwarded = (vi.mocked(runner.prompt).mock.calls[0]![2] as { prompt: Array<{ text: string }> }).prompt;
      expect(forwarded[1]!.text).toContain("call the `submit_result` tool once with your whole result as its arguments");
      expect(forwarded[1]!.text).toContain(JSON.stringify(schema, null, 2));
      expect(forwarded[1]!.text).not.toContain("konteks-structured-output");
      await agent.submit({ verdict: "fail" });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } });
      expect(sent.at(-1)?.body).toMatchObject({ result: { structuredOutput: { source: "tool", value: { verdict: "fail" } } } });
      await agent.stop();
      await session.close("cancelled");
    });

    it("accepts a valid fenced result in the agent's text when the tool was not called", async () => {
      const { session, sent, runner } = await build({}, validation);
      await session.bootstrap();
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: promptWithContract });
      await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done.\n```konteks-structured-output\n{\"verdict\":" } } } });
      await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\"pass\"}\n```" } } } });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } });
      expect(runner.prompt).toHaveBeenCalledTimes(1);
      expect(sent.at(-1)?.body).toMatchObject({ kind: "acp_result", id: "p1", result: { structuredOutput: { source: "fence", value: { verdict: "pass" } } } });
      await session.close("cancelled");
    });

    it("asks once more in the same session when the turn ended with no result, and reports the original prompt after it", async () => {
      const { session, sent, runner, runnerCalls } = await build({}, validation);
      await session.bootstrap();
      const agent = await resultTool(runnerCalls, true);
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: promptWithContract });
      await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I think it passes." } } } });
      const before = sent.length;
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 } } });
      // Nothing reported yet: the follow-up runs in the same ACP session.
      expect(sent.slice(before).some(message => (message.body as { kind?: string }).kind === "acp_result")).toBe(false);
      expect(runner.prompt).toHaveBeenLastCalledWith("acp-1", "p1#konteks-result-follow-up", { prompt: [{ type: "text", text: "You did not call `submit_result` with a valid result. Call it now, once, with your whole result." }] });
      await agent.submit({ verdict: "pass" });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1#konteks-result-follow-up", result: { stopReason: "end_turn", usage: { totalTokens: 5, inputTokens: 4, outputTokens: 1 } } });
      expect(sent.at(-1)?.body).toEqual({ kind: "acp_result", id: "p1", method: "session/prompt", result: { stopReason: "end_turn", usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 }, structuredOutput: { source: "follow_up", value: { verdict: "pass" } } } });
      expect(runner.prompt).toHaveBeenCalledTimes(2);
      await agent.stop();
      await session.close("cancelled");
    });

    it("reports the turn without a result when the follow-up also fails, and never asks twice", async () => {
      const { session, sent, runner } = await build({}, validation);
      await session.bootstrap();
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: promptWithContract });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "end_turn" } });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1#konteks-result-follow-up", result: { stopReason: "end_turn" } });
      expect(sent.at(-1)?.body).toEqual({ kind: "acp_result", id: "p1", method: "session/prompt", result: { stopReason: "end_turn" } });
      expect(runner.prompt).toHaveBeenCalledTimes(2);
      // A follow-up that errors settles the original completion too.
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p2", params: promptWithContract });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p2", result: { stopReason: "end_turn" } });
      await session.onRunnerEvent({ kind: "request_error", acpSessionRef: "acp-1", requestId: "p2#konteks-result-follow-up", method: "session/prompt", code: -32603, class: "internal", message: "bridge gone", retryable: false });
      expect(sent.at(-1)?.body).toEqual({ kind: "acp_result", id: "p2", method: "session/prompt", result: { stopReason: "end_turn" } });
      await session.close("cancelled");
    });

    it("does not ask again after a turn that did not end normally, and leaves an ordinary prompt alone", async () => {
      const { session, sent, runner } = await build({}, validation);
      await session.bootstrap();
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p1", params: promptWithContract });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p1", result: { stopReason: "cancelled" } });
      expect(runner.prompt).toHaveBeenCalledTimes(1);
      expect(sent.at(-1)?.body).toEqual({ kind: "acp_result", id: "p1", method: "session/prompt", result: { stopReason: "cancelled" } });
      await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p2", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "Just chat." }] } });
      expect(runner.prompt).toHaveBeenLastCalledWith("acp-1", "p2", { sessionId: "acp-1", prompt: [{ type: "text", text: "Just chat." }] });
      await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p2", result: { stopReason: "end_turn" } });
      expect(sent.at(-1)?.body).toEqual({ kind: "acp_result", id: "p2", method: "session/prompt", result: { stopReason: "end_turn" } });
      await session.close("cancelled");
    });
  });

  it("backpressures a terminal-fenced prompt before journaling or emitting any transcript frame", async () => {
    const { session, sent, runner, journal } = await build({
      assertPromptAllowed: () => { throw new Error("terminal directive already fenced this prompt lane"); },
    }, validation);
    await session.bootstrap();
    const sentBeforePrompt = sent.length;

    await expect(session.onToRuntime({ kind: "acp", method: "session/prompt", id: "fenced", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "too late" }] } })).rejects.toThrow("terminal directive");
    expect(runner.prompt).not.toHaveBeenCalled();
    expect(journal.pendingRequests.get("acp-1:received:fenced")).toBeUndefined();
    expect(sent).toHaveLength(sentBeforePrompt);
  });

  it("converts a malformed bridge result into acp_error(malformed_response)", async () => {
    const { session, sent } = await build({}, validation);
    await session.bootstrap();
    await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p2", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "go" }] } });
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p2", result: { stopReason: "not-a-real-reason" } });
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp_error", id: "p2", error: { class: "malformed_response" } });
    expect(session.counters.malformedResponses).toBe(1);
  });

  it("rejects cross-session requests and notifications even on the correct channel", async () => {
    const { session, sent, runner, journal } = await build({}, validation);
    await session.bootstrap();
    await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "wrong", params: { sessionId: "other", prompt: [{ type: "text", text: "not this session" }] } });
    await session.onToRuntime({ kind: "acp", method: "session/cancel", params: { sessionId: "other" } });
    expect(runner.prompt).not.toHaveBeenCalled();
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(journal.openRequests("acp-1")).toHaveLength(0);
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp_error", id: "wrong", error: { class: "invalid_params" } });
    const count = sent.length;
    await session.onRunnerEvent({ kind: "session_update", acpSessionRef: "acp-1", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong" } } } });
    expect(sent).toHaveLength(count);
  });

  it("forwards a deferred permission once, delivers the first valid answer once, and rejects a mismatched completion", async () => {
    const { session, sent, runner } = await build({}, validation);
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "perm-1", params: permissionRequest });
    const forwarded = sent.at(-1)?.body as { kind: string; method: string; id: string; params: { options: unknown[] } };
    expect(forwarded).toMatchObject({ kind: "acp", method: "session/request_permission", id: "perm-1" });
    expect(forwarded.params).toMatchObject({ sessionId: "acp-1", toolCall: { toolCallId: "t1" } });
    expect(JSON.stringify(forwarded)).not.toContain("rawInput");
    await session.onToRuntime({ kind: "acp_result", id: "perm-1", method: "elicitation/create", result: { action: "accept" } });
    expect(runner.answer).not.toHaveBeenCalled();
    await session.onToRuntime({ kind: "acp_result", id: "perm-1", method: "session/request_permission", result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(runner.answer).toHaveBeenCalledTimes(1);
    await session.onToRuntime({ kind: "acp_result", id: "perm-1", method: "session/request_permission", result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(runner.answer).toHaveBeenCalledTimes(1);
  });

  it("registers a deferral with Core before surfacing it and journals Core's digest and earlier deadline", async () => {
    const order: string[] = [];
    const registered = vi.fn(async (body: DeferredPermissionBody) => {
      order.push("register");
      return { kind: "permission", pendingRef: "pend_1", requestId: body.requestId, requestDigest: "c".repeat(43), assignmentId: body.assignmentId, agentId: body.agentId,
        raisedAt: clock.nowIso(), deadlineAt: new Date(clock.now() + 30_000).toISOString(),
        permission: (body as Extract<DeferredPermissionBody, { kind: "permission" }>).permission } as unknown as PendingPermissionView;
    });
    const { session, sent, journal } = await build({ registerDeferral: registered });
    await session.bootstrap();
    const before = sent.length;
    const send = sent.push.bind(sent);
    sent.push = (...items) => { order.push("frame"); return send(...items); };
    await session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "perm-1", params: permissionRequest });
    expect(order).toEqual(["register", "frame"]);
    expect(registered).toHaveBeenCalledWith(expect.objectContaining({ kind: "permission", sessionId: "s", assignmentId: "asg", attempt: 1, agentId: "codex", requestId: "perm-1" }));
    expect(JSON.stringify(registered.mock.calls[0]?.[0])).not.toContain("rawInput");
    expect(sent.slice(before).map(message => (message.body as { method?: string }).method)).toEqual(["session/request_permission"]);
    expect(journal.pendingRequests.get("acp-1:issued:perm-1")).toMatchObject({ requestDigest: "c".repeat(43), deadlineAt: new Date(clock.now() + 30_000).toISOString() });
  });

  it("threads a native delivery's deferral onto its execution session", async () => {
    const registered = vi.fn(async () => { throw new RemoteInstanceError("schema_invalid", "stop here"); });
    const delivery = { ...assignment, kind: "delivery" as const, correlationId: "invocation",
      agentRoute: { ...assignment.agentRoute, requiredRole: "generator" as const },
      source: { kind: "harness_delivery" as const, portability: "instance_bound" as const, ownerInstanceId: "inst", executionSessionId: "exec-session",
      repositoryId: "https://git.example.com/acme/store", modelBinding: { canonicalProviderId: "openai", canonicalModelId: "model-a" },
      turn: { invocationId: "invocation", dispatchGeneration: 0 } } } as RemoteWorkAssignment;
    const { session } = await build({ registerDeferral: registered }, delivery);
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "perm-1", params: permissionRequest });
    expect(registered).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "exec-session", assignmentId: "asg" }));
  });

  it("fails a deferral closed without surfacing it when Core never registers it", async () => {
    const { session, sent, runner } = await build({ registerDeferral: vi.fn().mockRejectedValue(new RemoteInstanceError("schema_invalid", "refused")) });
    await session.bootstrap();
    const before = sent.length;
    await session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "perm-1", params: permissionRequest });
    expect(sent.slice(before)).toEqual([]);
    expect(runner.answer).toHaveBeenCalledWith("acp-1", "perm-1", { outcome: { outcome: "cancelled" } });
    await session.onRunnerEvent({ kind: "elicitation_request", acpSessionRef: "acp-1", requestId: "e2", params: { mode: "form", message: "Pick", requestedSchema: { type: "object", properties: {} } } as never });
    expect(sent.slice(before)).toEqual([]);
    expect(runner.answer).toHaveBeenCalledWith("acp-1", "e2", { action: "decline" });
  });

  it("a sign-in elicitation is never forwarded and fails closed", async () => {
    const { session, sent, runner } = await build();
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "elicitation_request", acpSessionRef: "acp-1", requestId: "e1", params: { mode: "url", url: "https://login.example", elicitationId: "x", message: "Sign in" } });
    expect(sent.some((message) => (message.body as { method?: string }).method === "elicitation/create")).toBe(false);
    expect(runner.answer).toHaveBeenCalledWith("acp-1", "e1", { action: "decline" });
  });

  it("closes with session_closed and cancels pending human requests", async () => {
    const { session, sent, closed } = await build();
    await session.bootstrap();
    await session.onRunnerEvent({ kind: "permission_request", acpSessionRef: "acp-1", requestId: "perm-9", params: permissionRequest });
    await session.close("relay_replay_gap");
    expect(sent.at(-1)?.body).toEqual({ kind: "session_closed", assignmentId: "asg", reason: "relay_replay_gap" });
    expect(closed).toEqual(["relay_replay_gap"]);
    await session.close("completed");
    expect(closed).toHaveLength(1);
  });
});
