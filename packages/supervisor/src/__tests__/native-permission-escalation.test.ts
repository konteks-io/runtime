import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { FixedClock } from "@konteks/remote-common";
import { afterAll, describe, expect, it } from "vitest";
import { deferredPermissionRequest, EvaluatorPolicyResponder, type PermissionContext, type PolicyDecision } from "../session/policy-responder.js";
import { deferredPermissionBody, PermissionBroker, sanitizePermissionRequest } from "../session/permissions.js";
import { createWorkspaceToolPolicy } from "../session/workspace-tool-policy.js";

type PermissionOptions = RequestPermissionRequest["options"];
const commandOptions: PermissionOptions = [
  { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
  { optionId: "allow_for_session", name: "Allow this session", kind: "allow_always" },
  { optionId: "decline", name: "No", kind: "reject_once" },
];
const manualTurnOption: PermissionOptions[number] = { optionId: "allow_permissions_turn", name: "Grant for this turn", kind: "allow_once" };
const profileOptions: PermissionOptions = [
  manualTurnOption,
  { optionId: "allow_permissions_turn_strict_auto_review", name: "Grant with automatic review", kind: "allow_once" },
  { optionId: "allow_permissions_session", name: "Grant for this session", kind: "allow_always" },
  { optionId: "reject_permissions", name: "No", kind: "reject_once" },
];
const claudeOptions: PermissionOptions = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-with-updates", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];

function request(toolCall: RequestPermissionRequest["toolCall"], options = commandOptions): RequestPermissionRequest {
  return { sessionId: "native-session", toolCall, options };
}

function deferred(decision: PolicyDecision): Extract<PolicyDecision, { kind: "defer" }> {
  if (decision.kind !== "defer") throw new Error(`Expected human deferral, got ${decision.kind}`);
  return decision;
}

describe("explicit native authority requests", () => {
  const root = mkdtempSync(join(tmpdir(), "native-authority-"));
  const cwd = join(root, "work"), skill = join(root, "skill"), peer = join(root, "peer");
  for (const directory of [cwd, skill, peer]) mkdirSync(directory);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const context: PermissionContext = { assignmentId: "assignment", agentId: "codex", workspaceRoot: cwd, cwd, readOnlyRoots: [skill] };
  const responder = new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true);
  const profile = request({ toolCallId: "permissions", kind: "other", title: "Additional sandbox permissions",
    rawInput: { cwd, environmentId: "native-environment", permissions: { network: { enabled: true }, fileSystem: { read: [peer], write: [peer], entries: [{ path: { type: "glob_pattern", pattern: "/**" }, access: "read" }] } } } }, profileOptions);

  it("never automatically grants Codex's standalone turn authority and carries only the exact manual turn choice through Core and the broker", async () => {
    const decision = deferred(await responder.evaluatePermission(profile, context));
    const asked = deferredPermissionRequest(profile, decision);
    expect(asked.options.map(option => option.optionId)).toEqual(["allow_permissions_turn", "reject_permissions"]);
    expect(asked.toolCall.title).toContain("for this turn");
    const sanitized = sanitizePermissionRequest(asked);
    const body = deferredPermissionBody({ sessionId: "logical-session", assignmentId: "assignment", attempt: 1, agentId: "codex", requestId: "request", sanitized });
    expect(body.kind === "permission" ? body.permission.options : null).toEqual(sanitized.params.options);
    const broker = new PermissionBroker({ clock: new FixedClock(0), deadlineSeconds: () => 60, onTimeout: async () => undefined });
    broker.defer({ acpSessionRef: "reference", requestId: "request", assignmentId: "assignment", attempt: 1, agentId: "codex", sanitized });
    for (const optionId of ["allow_permissions_turn_strict_auto_review", "allow_permissions_session"]) {
      expect(broker.answer("reference", "request", { outcome: { outcome: "selected", optionId } })).toEqual({ ok: false, reason: "permission_schema_mismatch" });
    }
    const answer = broker.answer("reference", "request", { outcome: { outcome: "selected", optionId: "allow_permissions_turn" } });
    expect(answer.ok).toBe(true);
    expect(broker.answer("reference", "request", { outcome: { outcome: "selected", optionId: "allow_permissions_turn" } })).toEqual({ ok: false, reason: "unknown_request" });
  });

  it("applies the same finite turn choices when no automatic evaluator is configured", async () => {
    const noEvaluator = new EvaluatorPolicyResponder(null, () => true);
    const asked = deferredPermissionRequest(profile, deferred(await noEvaluator.evaluatePermission(profile, context)));
    expect(asked.options.map(option => option.optionId)).toEqual(["allow_permissions_turn", "reject_permissions"]);
  });

  it("requires a person for a command permission bundle even when its paths are inside the workspace", async () => {
    const command = request({ toolCallId: "command", kind: "execute", title: "Run command", rawInput: { command: "npm run build", cwd, additionalPermissions: { fileSystem: { write: [cwd] } } } });
    const asked = deferredPermissionRequest(command, deferred(await responder.evaluatePermission(command, context)));
    expect(asked.options.map(option => option.optionId)).toEqual(["allow_once", "decline"]);
    await expect(new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => false).evaluatePermission(command, context)).resolves.toEqual({ kind: "deny", optionId: "decline" });
  });

  it.each(["http", "tcp"])("requires a person for the producer's %s network approval, including protocols without rawInput.url", async protocol => {
    const network = { ...request({ toolCallId: "network", kind: "execute", title: `${protocol} network access`, rawInput: protocol === "http" ? { url: "https://example.test" } : {} }), _meta: { permission: { version: 1, title: "Allow network access?" } } };
    expect(deferred(await responder.evaluatePermission(network, context)).optionIds).toEqual(["allow_once", "decline"]);
  });

  it("preserves ordinary commands and selected-skill semantic read locations while requiring a person for an outside read or command cwd", async () => {
    const command = request({ toolCallId: "normal", kind: "execute", rawInput: { command: "npm test", cwd }, locations: [{ path: join(skill, "SKILL.md") }] });
    await expect(responder.evaluatePermission(command, context)).resolves.toEqual({ kind: "allow", optionId: "allow_once" });
    for (const toolCall of [
      { ...command.toolCall, locations: [{ path: join(peer, "private.txt") }] },
      { ...command.toolCall, rawInput: { command: "npm test", cwd: skill } },
    ]) expect((await responder.evaluatePermission(request(toolCall), context)).kind).toBe("defer");
    symlinkSync(peer, join(cwd, "escape"));
    expect((await responder.evaluatePermission(request({ ...command.toolCall, locations: [{ path: join(cwd, "escape", "private.txt") }] }), context)).kind).toBe("defer");
  });

  it("preserves blocklist denial before a wider native command request", async () => {
    const command = request({ toolCallId: "blocked", kind: "execute", rawInput: { command: "git push origin main", additionalPermissions: { network: { enabled: true } } } });
    await expect(responder.evaluatePermission(command, context)).resolves.toMatchObject({ kind: "deny", optionId: "decline", refusal: { reason: "bash_blocklist" } });
  });

  it.each([null, "not-a-profile", [], {}])("denies a malformed/unrepresentable Codex permission bundle %j", async permissions => {
    const malformed = request({ toolCallId: "malformed", kind: "other", rawInput: { permissions } }, profileOptions);
    await expect(responder.evaluatePermission(malformed, context)).resolves.toEqual({ kind: "deny", optionId: "reject_permissions" });
  });

  it("refuses recognizable Codex escalation carriers with missing or incorrect producer kinds", async () => {
    const malformed: RequestPermissionRequest[] = [
      request({ toolCallId: "missing-profile-kind", rawInput: { permissions: { network: { enabled: true } } } }, profileOptions),
      request({ toolCallId: "wrong-profile-kind", kind: "execute", rawInput: { permissions: { network: { enabled: true } } } }, profileOptions),
      request({ toolCallId: "missing-command-kind", rawInput: { additionalPermissions: { fileSystem: { write: [cwd] } } } }),
      request({ toolCallId: "wrong-command-kind", kind: "other", rawInput: { additionalPermissions: { network: { enabled: true } } } }),
      { ...request({ toolCallId: "missing-network-kind", rawInput: {} }), _meta: { permission: { title: "Allow network access?" } } },
      request({ toolCallId: "profile-options-only" }, profileOptions),
    ];
    for (const candidate of malformed) {
      expect((await responder.evaluatePermission(candidate, context)).kind).toBe("deny");
      expect((await new EvaluatorPolicyResponder(null, () => true).evaluatePermission(candidate, context)).kind).toBe("deny");
    }
  });

  it("denies absent, duplicated, incorrectly typed or automatic-review-only manual choices", async () => {
    const variants: PermissionOptions[] = [
      profileOptions.filter(option => option.optionId !== "allow_permissions_turn"),
      [...profileOptions, manualTurnOption],
      profileOptions.map((option): PermissionOptions[number] => option.optionId === "allow_permissions_turn" ? { ...option, kind: "allow_always" } : option),
      profileOptions.filter(option => option.kind !== "reject_once"),
      [manualTurnOption, { optionId: "allow_permissions_session", name: "No", kind: "reject_once" }],
    ];
    for (const options of variants) expect((await responder.evaluatePermission({ ...profile, options }, context)).kind).toBe("deny");
  });

  it("cancels rather than selecting a granting native ID mislabeled as rejection, even when the command blocklist denies first", async () => {
    const options: PermissionOptions = [{ optionId: "allow_once", name: "No", kind: "reject_once" }];
    const malformed = request({ toolCallId: "unsafe-reject", kind: "execute", rawInput: { command: "git push origin main", additionalPermissions: { network: { enabled: true } } } }, options);
    await expect(responder.evaluatePermission(malformed, context)).resolves.toMatchObject({ kind: "deny", optionId: null, refusal: { reason: "bash_blocklist" } });
    await expect(responder.evaluatePermission({ ...profile, options: [{ optionId: "allow_permissions_session", name: "No", kind: "reject_once" }] }, context)).resolves.toEqual({ kind: "deny", optionId: null });
  });

  it("applies the existing command blocklist to the producer's structured PowerShell identity despite its kind=other presentation", async () => {
    const command = request({ toolCallId: "powershell", kind: "other", rawInput: { command: "git push origin main" }, _meta: { claudeCode: { toolName: "PowerShell" } } }, claudeOptions);
    await expect(responder.evaluatePermission(command, { ...context, agentId: "claude-code" })).resolves.toMatchObject({ kind: "deny", optionId: "reject", refusal: { reason: "bash_blocklist" } });
  });

  it("uses Claude's patched native tool identity for network and blocked shell paths without granting by display title", async () => {
    const claude: PermissionContext = { ...context, agentId: "claude-code" };
    const network = request({ toolCallId: "claude-network", kind: "other", title: "example.test", rawInput: { host: "example.test" }, _meta: { claudeCode: { toolName: "SandboxNetworkAccess" } } }, claudeOptions);
    const asked = deferredPermissionRequest(network, deferred(await responder.evaluatePermission(network, claude)));
    expect(asked.options.map(option => option.optionId)).toEqual(["allow-once", "reject"]);
    for (const toolName of ["Bash", "PowerShell"]) {
      for (const path of [join(peer, "blocked.txt"), join(skill, "SKILL.md"), join(cwd, "local.txt")]) {
        const shell = request({ toolCallId: toolName, kind: toolName === "Bash" ? "execute" : "other", rawInput: { command: "npm test" }, locations: [{ path }], _meta: { claudeCode: { toolName } } }, claudeOptions);
        expect((await responder.evaluatePermission(shell, claude)).kind).toBe("defer");
      }
    }
    const ordinary = request({ toolCallId: "claude-normal", kind: "execute", title: "SandboxNetworkAccess", rawInput: { command: "npm test" }, _meta: { claudeCode: { toolName: "Bash" } } }, claudeOptions);
    await expect(responder.evaluatePermission(ordinary, claude)).resolves.toEqual({ kind: "allow", optionId: "allow-once" });
  });
});
