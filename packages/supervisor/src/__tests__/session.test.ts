import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, RemoteInstanceError, SECRET_CANARIES, generateInstanceKey, type PendingPermissionView, type RemoteWorkAssignment, type RelayAck, type ToCoreRelayFrame } from "@konteks/remote-common";
import { ChannelMux } from "../relay/channel-mux.js";
import { SupervisorJournal } from "../state/journal.js";
import { PermissionBroker, answerIsValid, registerDeferral, sanitizeElicitationRequest, sanitizePermissionRequest } from "../session/permissions.js";
import type { DeferredPermissionBody } from "../core/client.js";
import { EvaluatorPolicyResponder, isSignInElicitation } from "../session/policy-responder.js";
import { RelayedSession, type RelayedSessionDeps } from "../session/relayed-session.js";
import type { RunnerClient } from "../runner-client.js";
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
    expect(await deny.evaluatePermission(permissionRequest as never, { assignmentId: "a", agentId: "codex", workspaceRoot: "/w" })).toEqual({ kind: "deny", optionId: "reject" });
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
    } as unknown as RunnerClient;
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
      browserToolUrl: null,
      workspaceRoot: "/workspace",
      ...(overrides.deploymentKind === "native_connector" ? { registerReady: async (target: RemoteWorkAssignment, binding: { sessionId: string }, acpSessionRef: string) => ({ workspaceId: target.workspaceId, instanceId: target.instanceId, sessionId: binding.sessionId, channelId: `session:${binding.sessionId}`, assignmentId: target.id, attempt: target.attempt, claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "runner-process", agentId: target.agentRoute.agentId, acpSessionRef, readyRevision: 1, registeredAt: clock.nowIso() }) } : {}),
      onUsage: async () => undefined,
      onClosed: async (_session, reason) => void closed.push(reason),
      ...overrides,
    });
    return { session, sent, runner, runnerCalls, journal, closed, transport };
  }

  it("bootstraps with the redeemed token in mcpServers and announces session_ready", async () => {
    const { session, sent, runnerCalls, journal } = await build();
    await session.bootstrap();
    expect((runnerCalls[0]?.[1][0] as { mcpServers: unknown[] }).mcpServers).toEqual([{ type: "http", name: "konteks", url: "https://mcp.example", headers: [{ name: "authorization", value: "Bearer cap-token" }] }]);
    expect(sent[0]?.body).toMatchObject({ kind: "session_ready", assignmentId: "asg", acpSessionRef: "acp-1", resumed: false, agentId: "codex" });
    expect(JSON.stringify(journal.assignments.all())).not.toContain("cap-token");
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

  it("requires native preparation and never announces readiness after a staging failure", async () => {
    const missing = await build({ deploymentKind: "native_connector" });
    await expect(missing.session.bootstrap()).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(missing.runner.createSession).not.toHaveBeenCalled();
    expect(missing.sent).toEqual([]);
    const warn = vi.fn();
    const failed = await build({
      deploymentKind: "native_connector",
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
      deploymentKind: "native_connector",
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
    });

    await session.bootstrap();

    expect(order).toEqual(["inputs", "capability", "activate"]);
    expect(activateExecution).toHaveBeenCalledOnce();
    expect(vi.mocked(runner.createSession).mock.calls[0]?.[0]).toEqual(expect.objectContaining({ acpSessionRef: "continued-ref" }));
  });

  it("prefers a live continuation over the restart-only restore fallback", async () => {
    const { session, runner } = await build({
      deploymentKind: "native_connector",
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      reserveChannel: () => () => undefined,
      restoreReference: "durable-restart-ref",
      activateExecution: async () => ({ continueReference: "live-ref" }),
    });

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
      deploymentKind: "native_connector",
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
      deploymentKind: "native_connector",
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
      redeemCapabilityToken: async () => { throw new RemoteInstanceError("temporarily_unavailable", "Core is restarting.", { retryable: true }); },
      activateExecution,
    });

    await expect(session.bootstrap()).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(activateExecution).not.toHaveBeenCalled();
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("uses the verified logical session channel across native assignment attempts and retains replay on close", async () => {
    for (const attempt of [1, 2]) {
      const work = { ...assignment, id: `asg-${attempt}`, attempt };
      const { session, sent, transport } = await build({
        deploymentKind: "native_connector",
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
    const { session, sent, transport } = await build({ deploymentKind: "native_connector" });
    await session.close("cancelled");
    expect(session.channelId).toBeNull();
    expect(sent).toEqual([]);
    expect(transport.openChannel).not.toHaveBeenCalled();
    expect(transport.closeChannel).not.toHaveBeenCalled();
  });

  it("requires Core registration for native bootstrap before creating a local agent session", async () => {
    const { session, runner } = await build({ deploymentKind: "native_connector", registerReady: undefined,
      prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "asg", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }),
    });
    await expect(session.bootstrap()).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("waits for Core readiness and never prompts or emits readiness while registration is pending", async () => {
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const registering = new Promise<void>(resolve => { entered = resolve; });
    const { session, runner, sent, transport } = await build({ deploymentKind: "native_connector",
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
      const { session } = await build({ deploymentKind: "native_connector", transport,
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
      sessionId: "acp-1", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: `Test /workspace/asg/src/index.ts using ${SECRET_CANARIES.openAiKey}`, status: "in_progress",
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
    expect(serialized).not.toContain("/workspace/asg");
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp", method: "session/update", params: { sessionId: "acp-1", update: { toolCallId: "tool", status: "in_progress" } } });
    expect(serialized).toContain("src/index.ts");
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
    const { session, runner, sent, journal } = await build({ deploymentKind: "native_connector", prepareInputs });
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
    const { session, runner } = await build({ deploymentKind: "native_connector", prepareInputs: async () => ({ binding: { workspaceId: "ws", sessionId: "s", assignmentId: "other", instanceId: "inst", attempt: 1 }, cwd: "/private/native/checkout", skillInstructions: "", beforePrompt: async () => undefined }) });
    await expect(session.bootstrap()).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("does not create an agent session after cancellation during input staging", async () => {
    let finish!: (value: { binding: { workspaceId: string; sessionId: string; assignmentId: string; instanceId: string; attempt: number }; cwd: string; skillInstructions: string; beforePrompt: () => Promise<void> }) => void;
    const preparation = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
    const { session, runner, sent } = await build({ deploymentKind: "native_connector", prepareInputs: async () => preparation });
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
      deploymentKind: "native_connector",
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
      deploymentKind: "native_connector", recordCompletedSettlement,
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
      deploymentKind: "native_connector", reserveChannel: () => release,
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

  it("journals a received prompt, completes it once with the same id and method, and rejects duplicates/unknown completions", async () => {
    const { session, sent, runner, journal } = await build();
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

  it("backpressures a terminal-fenced prompt before journaling or emitting any transcript frame", async () => {
    const { session, sent, runner, journal } = await build({
      assertPromptAllowed: () => { throw new Error("terminal directive already fenced this prompt lane"); },
    });
    await session.bootstrap();
    const sentBeforePrompt = sent.length;

    await expect(session.onToRuntime({ kind: "acp", method: "session/prompt", id: "fenced", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "too late" }] } })).rejects.toThrow("terminal directive");
    expect(runner.prompt).not.toHaveBeenCalled();
    expect(journal.pendingRequests.get("acp-1:received:fenced")).toBeUndefined();
    expect(sent).toHaveLength(sentBeforePrompt);
  });

  it("converts a malformed bridge result into acp_error(malformed_response)", async () => {
    const { session, sent } = await build();
    await session.bootstrap();
    await session.onToRuntime({ kind: "acp", method: "session/prompt", id: "p2", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "go" }] } });
    await session.onRunnerEvent({ kind: "prompt_result", acpSessionRef: "acp-1", requestId: "p2", result: { stopReason: "not-a-real-reason" } });
    expect(sent.at(-1)?.body).toMatchObject({ kind: "acp_error", id: "p2", error: { class: "malformed_response" } });
    expect(session.counters.malformedResponses).toBe(1);
  });

  it("rejects cross-session requests and notifications even on the correct channel", async () => {
    const { session, sent, runner, journal } = await build();
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
    const { session, sent, runner } = await build();
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
