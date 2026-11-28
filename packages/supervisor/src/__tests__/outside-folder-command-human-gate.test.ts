import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PolicyEvaluator } from "@konteks/agent-core";
import { FixedClock } from "@konteks/remote-common";
import { describe, expect, it, vi } from "vitest";
import { hostToolGovernance } from "../session/host-tool-governance.js";
import { PermissionBroker, sanitizePermissionRequest } from "../session/permissions.js";
import { deferredPermissionRequest, EvaluatorPolicyResponder, type PermissionContext, type PolicyDecision } from "../session/policy-responder.js";

/**
 * TKT-2/R4: a command outside the session's folder always waits for a person.
 *
 * The guard's matrix is the standing rule: an out-of-folder command permission
 * is never `allow`, whatever the evaluator says, whether or not human deferral
 * is available, and whatever the host adapter. Any new allow branch or host
 * adapter must extend this file; a failure names the rule and the case.
 */
const RULE = "RULE (TKT-2/R4): a command outside the session's folder always waits for a person";
const message = (caseName: string, decision: string): string => `${RULE} — ${caseName} was ${decision}`;

function described(decision: PolicyDecision | { kind: string }): string {
  return decision.kind === "defer"
    ? `deferred (${(decision as Extract<PolicyDecision, { kind: "defer" }>).optionIds?.join(", ") ?? "no exact options"})`
    : decision.kind;
}

type OptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
interface Option { optionId: string; name: string; kind: OptionKind }

const allowEverything: PolicyEvaluator = { evaluateToolUse: () => ({ allowed: true }) };
const denyEverything: PolicyEvaluator = { evaluateToolUse: () => ({ allowed: false, denyMessage: "refused by the deny-everything evaluator" }) };
const evaluators = [["allowing", allowEverything], ["denying", denyEverything], ["absent", null]] as const;
const deferrals = [["allowed", true], ["refused", false]] as const;

/** Options a native escalation can offer: the one-time allow, the reject forms, and two choices it must hide. */
const claudeOptions: Option[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
  { optionId: "auto-review", name: "Review automatically", kind: "allow_once" },
];
const codexOptions: Option[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "decline", name: "Decline", kind: "reject_once" },
  { optionId: "reject_always", name: "Always decline", kind: "reject_always" },
  { optionId: "auto_review", name: "Review automatically", kind: "allow_once" },
];
const codexProfileOptions: Option[] = [
  { optionId: "allow_permissions_turn", name: "Allow for this turn", kind: "allow_once" },
  { optionId: "allow_permissions_session", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_permissions", name: "Reject", kind: "reject_once" },
  { optionId: "allow_permissions_automatic_review", name: "Review automatically", kind: "allow_once" },
];

const WORKSPACE = "/work/session";
const SKILL_ROOT = "/work/skills/org-1";
const CONTEXT_ROOT = "/work/session-context/session-1/source";
const claudeContext: PermissionContext = {
  assignmentId: "assignment", agentId: "claude-code", workspaceRoot: WORKSPACE, cwd: WORKSPACE,
  readOnlyRoots: [SKILL_ROOT, CONTEXT_ROOT], sessionContextRoot: CONTEXT_ROOT,
};
const codexContext: PermissionContext = {
  assignmentId: "assignment", agentId: "codex", workspaceRoot: WORKSPACE, cwd: WORKSPACE, readOnlyRoots: [SKILL_ROOT],
};

function claudeRequest(tool: "Bash" | "PowerShell", locations: readonly string[]): RequestPermissionRequest {
  return {
    sessionId: "acp-1",
    options: claudeOptions as never,
    // The pinned bridge presents PowerShell as kind=other; its structured name makes it a shell.
    toolCall: { toolCallId: "tool-1", title: "Size of memory files", kind: tool === "Bash" ? "execute" : "other",
      locations: locations.map(path => ({ path })), rawInput: { command: "wc -l memory/conversation.md" },
      _meta: { claudeCode: { toolName: tool } } },
  };
}

function codexRequest(rawInput: Record<string, unknown>, options: readonly Option[] = codexOptions,
  kind: "execute" | "other" = "execute", locations: readonly string[] = [`${WORKSPACE}/src/a.ts`]): RequestPermissionRequest {
  return {
    sessionId: "acp-1", options: options as never,
    toolCall: { toolCallId: "tool-1", title: "Run command", kind, locations: locations.map(path => ({ path })), rawInput },
  };
}

interface PolicyCase {
  name: string;
  request: RequestPermissionRequest;
  context: PermissionContext;
  /** The only option a defer may carry, with its reject options. */
  expectedOptionIds: readonly string[];
  /** A context-folder read is refused, not deferred. */
  refusal?: "session_context_shell";
}

const POLICY_CASES: readonly PolicyCase[] = [
  { name: "Claude Bash outside the working copy", request: claudeRequest("Bash", ["/tmp/outside.txt"]), context: claudeContext, expectedOptionIds: ["allow-once", "reject"] },
  { name: "Claude PowerShell outside the working copy", request: claudeRequest("PowerShell", ["/tmp/outside.txt"]), context: claudeContext, expectedOptionIds: ["allow-once", "reject"] },
  { name: "Claude Bash outside the read roots", request: claudeRequest("Bash", ["/work/elsewhere/notes.txt"]), context: claudeContext, expectedOptionIds: ["allow-once", "reject"] },
  { name: "Claude Bash inside a skill folder", request: claudeRequest("Bash", [`${SKILL_ROOT}/scripts/run.sh`]), context: claudeContext, expectedOptionIds: ["allow-once", "reject"] },
  { name: "Claude Bash with mixed inside and outside locations", request: claudeRequest("Bash", ["/tmp/outside.txt", `${WORKSPACE}/src/a.ts`]), context: claudeContext, expectedOptionIds: ["allow-once", "reject"] },
  { name: "Claude Bash reading only the session context folder", request: claudeRequest("Bash", [`${CONTEXT_ROOT}/memory/conversation.md`]), context: claudeContext, expectedOptionIds: [], refusal: "session_context_shell" },
  { name: "Codex execute with an outside cwd", request: codexRequest({ command: "ls", cwd: "/tmp" }), context: codexContext, expectedOptionIds: ["allow_once", "decline"] },
  { name: "Codex execute with outside locations", request: codexRequest({ command: "ls" }, codexOptions, "execute", ["/tmp/outside.txt"]), context: codexContext, expectedOptionIds: ["allow_once", "decline"] },
  { name: "Codex execute with additionalPermissions", request: codexRequest({ command: "ls", additionalPermissions: { network: {} } }), context: codexContext, expectedOptionIds: ["allow_once", "decline"] },
  { name: "Codex permission profile", request: codexRequest({ permissions: { fileSystem: {} } }, codexProfileOptions, "other"), context: codexContext, expectedOptionIds: ["allow_permissions_turn", "reject_permissions"] },
  { name: "Codex network", request: codexRequest({ command: "curl", url: "https://example.com/" }), context: codexContext, expectedOptionIds: ["allow_once", "decline"] },
];

function expectNeverAllow(decision: PolicyDecision, caseName: string): void {
  expect(decision.kind, message(caseName, described(decision))).not.toBe("allow");
}

function expectHiddenChoicesGone(policyCase: PolicyCase, decision: Extract<PolicyDecision, { kind: "defer" }>): void {
  const label = `${policyCase.name} deferred`;
  expect(decision.allowOnceOnly, message(label, "a defer without allowOnceOnly")).toBe(true);
  expect(decision.optionIds, message(label, "a defer without exact optionIds")).toEqual(policyCase.expectedOptionIds);
  const kinds = (decision.optionIds ?? []).map(id => policyCase.request.options.find(option => option.optionId === id)?.kind);
  expect(kinds.filter(kind => kind === "allow_always"), message(label, "a defer carrying allow_always")).toEqual([]);
  expect(kinds.filter(kind => kind === "reject_always"), message(label, "a defer carrying reject_always")).toEqual([]);
  expect(kinds.filter(kind => kind === "allow_once"), message(label, "a defer carrying more than the one-time allow")).toHaveLength(1);
}

describe("policy matrix: Claude and Codex native escalations", () => {
  for (const policyCase of POLICY_CASES) {
    for (const [evaluatorName, evaluator] of evaluators) {
      for (const [deferralName, humanDeferral] of deferrals) {
        it(`${RULE} — ${policyCase.name} with the ${evaluatorName} evaluator and human deferral ${deferralName}`, async () => {
          const responder = new EvaluatorPolicyResponder(evaluator, () => humanDeferral);
          const decision = await responder.evaluatePermission(policyCase.request, policyCase.context);
          const label = `${policyCase.name} with the ${evaluatorName} evaluator and human deferral ${deferralName}`;
          expectNeverAllow(decision, label);
          if (policyCase.refusal !== undefined) {
            // The evaluator may refuse first; either way the context-folder read is a deny.
            if (evaluatorName !== "denying") {
              expect(decision, message(label, described(decision))).toMatchObject({ kind: "deny", refusal: { reason: policyCase.refusal } });
            } else {
              expect(decision.kind, message(label, described(decision))).toBe("deny");
            }
            return;
          }
          if (!humanDeferral || evaluatorName === "denying") {
            expect(decision.kind, message(label, described(decision))).toBe("deny");
            return;
          }
          expect(decision.kind, message(label, described(decision))).toBe("defer");
          const deferred = decision as Extract<PolicyDecision, { kind: "defer" }>;
          expectHiddenChoicesGone(policyCase, deferred);
          const asked = deferredPermissionRequest(policyCase.request, deferred);
          expect(asked.options.map(option => option.optionId), message(label, `the card carrying ${asked.options.map(option => option.optionId).join(", ")}`))
            .toEqual(policyCase.expectedOptionIds);
        });
      }
    }
  }
});

describe("deferred permission request", () => {
  it(`${RULE} — stripping every persistent option from a deferred card leaves only the one-time allow and its reject`, () => {
    const request = claudeRequest("Bash", ["/tmp/outside.txt"]);
    const exact = deferredPermissionRequest(request, { kind: "defer", allowOnceOnly: true, optionIds: ["allow-once", "reject"] });
    expect(exact.options.map(option => option.optionId), message("an exact deferral", `the card carrying ${exact.options.map(option => option.optionId).join(", ")}`))
      .toEqual(["allow-once", "reject"]);
    // Even without optionIds, a once-only deferral must not keep a persistent choice.
    const onceOnly = deferredPermissionRequest(request, { kind: "defer", allowOnceOnly: true });
    const persistent = onceOnly.options.filter(option => option.kind === "allow_always" || option.kind === "reject_always");
    expect(persistent.map(option => option.optionId), message("a once-only deferral", `the card carrying ${persistent.map(option => option.optionId).join(", ")}`))
      .toEqual([]);
  });
});

const HOST_CWD = "/rt/workspaces/host/assignment-1";
const hostOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

function openCodeDecision(folderKey: "cwd" | "workdir"): { kind: string; reason?: string } {
  const governance = hostToolGovernance("opencode")!;
  const toolCallId = "shell-1";
  const rawInput = { command: "ls", [folderKey]: "/etc" };
  governance.observe({ sessionUpdate: "tool_call", toolCallId, title: "shell", kind: "execute", status: "pending", locations: [], rawInput: {} }, HOST_CWD);
  governance.observe({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawInput }, HOST_CWD);
  const request = { sessionId: "s", toolCall: { toolCallId, kind: "execute", title: "ls", rawInput }, options: hostOptions as never };
  return governance.decide(request as never, { cwd: HOST_CWD, servers: new Set<string>() });
}

function dshDecision(folderKey: "cwd" | "workdir"): { kind: string; reason?: string } {
  const governance = hostToolGovernance("dsh")!;
  const toolCallId = "shell-1";
  governance.observe({ sessionUpdate: "tool_call", toolCallId, title: "bash", kind: "other", status: "in_progress",
    rawInput: { command: "ls", [folderKey]: "/etc" } }, HOST_CWD);
  const request = { sessionId: "s", toolCall: { toolCallId }, options: hostOptions as never };
  return governance.decide(request as never, { cwd: HOST_CWD, servers: new Set<string>() });
}

function antigravityDecision(folderKey: "Cwd" | "working_dir"): { kind: string; reason?: string } {
  const governance = hostToolGovernance("antigravity")!;
  const call = { toolCallId: "cmd-1", title: "ls", kind: "execute", rawInput: { CommandLine: "ls", [folderKey]: "/etc" } };
  governance.observe({ sessionUpdate: "tool_call", status: "pending", ...call }, HOST_CWD);
  const request = { sessionId: "s", toolCall: { ...call, status: "pending" }, options: hostOptions as never };
  return governance.decide(request as never, { cwd: HOST_CWD, servers: new Set<string>() });
}

describe("host adapters: a shell folder outside the working copy", () => {
  it.each([
    ["OpenCode cwd", "opencode", () => openCodeDecision("cwd")],
    ["OpenCode workdir", "opencode", () => openCodeDecision("workdir")],
    ["DeepSeek Harness cwd", "dsh", () => dshDecision("cwd")],
    ["DeepSeek Harness workdir", "dsh", () => dshDecision("workdir")],
    ["Antigravity Cwd", "antigravity", () => antigravityDecision("Cwd")],
    ["Antigravity working_dir", "antigravity", () => antigravityDecision("working_dir")],
  ])(`${RULE} — %s was refused, never answered allow_once`, (caseName, _agentId, decide) => {
    const decision = decide();
    const label = `${caseName} outside the working copy`;
    expect(decision.kind, message(label, decision.kind === "allow" ? "answered allow_once" : decision.kind)).toBe("deny");
    expect(decision, message(label, "answered allow_once")).toMatchObject({ kind: "deny", reason: "a command run outside the working copy" });
  });
});

describe("PermissionBroker hold and deadline", () => {
  const START = Date.parse("2026-09-06T00:00:00Z");
  const permission = {
    sessionId: "acp", toolCall: { toolCallId: "tool-1", title: "Run", kind: "execute" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
  };
  const allowAnswer = { outcome: { outcome: "selected", optionId: "allow" } };

  function deferred(clock: FixedClock, broker: PermissionBroker, requestId: string, registeredDeadlineAt?: string): void {
    broker.defer({ acpSessionRef: "acp", requestId, assignmentId: "assignment", attempt: 1, agentId: "claude-code",
      sanitized: sanitizePermissionRequest(permission as never, false) }, registeredDeadlineAt);
  }

  function brokerAt(clock: FixedClock, deadlineSeconds: number, timeouts: string[]): PermissionBroker {
    return new PermissionBroker({ clock, deadlineSeconds: () => deadlineSeconds, onTimeout: async request => void timeouts.push(request.requestId) });
  }

  it(`${RULE} — a card held past Core's earlier deadline was not timed out early and failed closed at the deadline`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clock = new FixedClock(START);
      const timeouts: string[] = [];
      const broker = brokerAt(clock, 600, timeouts);
      deferred(clock, broker, "r1", new Date(START + 30_000).toISOString());
      clock.advance(29_000);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(broker.count, message("Core's 30 s deadline after 29 s", `${broker.count} pending`)).toBe(1);
      expect(timeouts, message("Core's 30 s deadline after 29 s", `onTimeout(${timeouts.join(", ")})`)).toEqual([]);
      clock.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timeouts, message("Core's 30 s deadline at 30 s", `onTimeout(${timeouts.join(", ")})`)).toEqual(["r1"]);
      expect(broker.count, message("Core's 30 s deadline at 30 s", `${broker.count} pending`)).toBe(0);
      expect(broker.answer("acp", "r1", allowAnswer), message("an answer after the deadline", "accepted"))
        .toEqual({ ok: false, reason: "unknown_request" });
    } finally { vi.useRealTimers(); }
  });

  it(`${RULE} — a card held past the local earlier deadline was not timed out early and failed closed at the deadline`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clock = new FixedClock(START);
      const timeouts: string[] = [];
      const broker = brokerAt(clock, 30, timeouts);
      deferred(clock, broker, "r1", new Date(START + 600_000).toISOString());
      clock.advance(29_000);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(broker.count, message("the local 30 s deadline after 29 s", `${broker.count} pending`)).toBe(1);
      expect(timeouts, message("the local 30 s deadline after 29 s", `onTimeout(${timeouts.join(", ")})`)).toEqual([]);
      clock.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timeouts, message("the local 30 s deadline at 30 s", `onTimeout(${timeouts.join(", ")})`)).toEqual(["r1"]);
    } finally { vi.useRealTimers(); }
  });

  it(`${RULE} — only an explicit valid answer resolved the card, and a later answer was refused`, () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clock = new FixedClock(START);
      const timeouts: string[] = [];
      const broker = brokerAt(clock, 60, timeouts);
      deferred(clock, broker, "r1");
      expect(broker.answer("acp", "r1", { outcome: { outcome: "selected", optionId: "not-listed" } }),
        message("an unlisted answer", "accepted")).toEqual({ ok: false, reason: "permission_schema_mismatch" });
      expect(broker.count, message("an unlisted answer", `${broker.count} pending`)).toBe(1);
      expect(broker.answer("acp", "r1", allowAnswer).ok, message("an explicit valid answer", "refused")).toBe(true);
      expect(broker.answer("acp", "r1", allowAnswer), message("a later answer", "accepted"))
        .toEqual({ ok: false, reason: "unknown_request" });
      expect(timeouts, message("an answered card", `onTimeout(${timeouts.join(", ")})`)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it(`${RULE} — an unanswered card failed closed at the deadline and produced no allow`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clock = new FixedClock(START);
      const timedOut: Array<{ requestId: string; answered: boolean }> = [];
      const broker = new PermissionBroker({ clock, deadlineSeconds: () => 60,
        onTimeout: async request => void timedOut.push({ requestId: request.requestId, answered: request.answered }) });
      deferred(clock, broker, "r1");
      expect(timedOut, message("an unanswered card before the deadline", `onTimeout(${timedOut.length})`)).toEqual([]);
      clock.advance(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(timedOut, message("an unanswered card at the deadline", `onTimeout(${timedOut.length})`)).toEqual([{ requestId: "r1", answered: false }]);
      expect(broker.count, message("an unanswered card at the deadline", `${broker.count} pending`)).toBe(0);
      expect(broker.answer("acp", "r1", allowAnswer), message("an answer after the timeout", "accepted"))
        .toEqual({ ok: false, reason: "unknown_request" });
    } finally { vi.useRealTimers(); }
  });
});
