import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PolicyEvaluator } from "@konteks/agent-core";
import { browserToolFromTitle, isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import type { PolicyRefusal, WorkspaceToolPolicyEvaluation } from "./workspace-tool-policy.js";

/**
 * The ACP policy responder (D87 step 1): a permission request or elicitation
 * is answered FIRST by policy. A definitive allow/deny is answered locally
 * within the responder deadline; only when policy defers (and the assignment
 * allows human deferral) is the request forwarded to a human over the relay.
 * Sign-in elicitations are never remotely answerable (D102) and always fail
 * closed in headless execution.
 */
/**
 * A deny carries why (T1, 2026-10-02: two "Edit files" refusals ended a repair
 * turn and nothing said which path was wrong): `message` is the note for the
 * agent and Konteks, `refusal` the detail the connector logs.
 */
export type PolicyDecision =
  | { kind: "allow"; optionId: string }
  | { kind: "deny"; optionId: string | null; message?: string; refusal?: PolicyRefusal }
  | { kind: "defer" };

/**
 * `browserTools`: this session was given the QA browser (its gateway admits only the session's preview).
 * `cwd`: the session's working copy, which a refusal names; `workspaceRoot` stays the boundary.
 */
export interface PermissionContext { assignmentId: string; agentId: string; workspaceRoot: string; cwd?: string; browserTools?: boolean }

export interface PolicyResponder {
  evaluatePermission(request: RequestPermissionRequest, context: PermissionContext): Promise<PolicyDecision>;
  evaluateElicitation(request: CreateElicitationRequest): Promise<{ kind: "defer" } | { kind: "decline" }>;
}

function preferredOption(request: RequestPermissionRequest, kinds: readonly string[]): string | null {
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option) return option.optionId;
  }
  return null;
}

export function isSignInElicitation(request: CreateElicitationRequest): boolean {
  const mode = (request as { mode?: string }).mode;
  if (mode === "url") return true;
  return /sign[ -]?in|log[ -]?in|authenticate|authorization code/i.test(request.message);
}

/**
 * Uses `@konteks/agent-core`'s PolicyEvaluator: a tool call the policy allows
 * is answered `allow_once`; one it denies is answered `reject_once`. With no
 * evaluator the responder defers (when deferral is allowed) so the governance
 * loop's human path decides — never a silent allow.
 */
export class EvaluatorPolicyResponder implements PolicyResponder {
  constructor(private readonly evaluator: PolicyEvaluator | null, private readonly humanDeferralAllowed: () => boolean) {}

  async evaluatePermission(request: RequestPermissionRequest, context: PermissionContext): Promise<PolicyDecision> {
    const allow = preferredOption(request, ["allow_once", "allow_always"]);
    const deny = preferredOption(request, ["reject_once", "reject_always"]);
    // The QA browser's tools: allowed on a session that was given the browser
    // (its gateway already confines it to the session's preview), refused on
    // any other session, and the few it never allows are refused everywhere.
    const browserTool = browserToolFromTitle((request.toolCall as { title?: string | null }).title);
    if (browserTool !== null) {
      if (context.browserTools === true && !isDeniedBrowserTool(browserTool) && allow !== null) return { kind: "allow", optionId: allow };
      return { kind: "deny", optionId: deny };
    }
    if (this.evaluator === null) return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "deny", optionId: deny };
    const toolCall = request.toolCall as { rawInput?: unknown; kind?: string | null; title?: string | null; locations?: unknown };
    const raw = toolCall.rawInput && typeof toolCall.rawInput === "object" && !Array.isArray(toolCall.rawInput) ? (toolCall.rawInput as Record<string, unknown>) : {};
    // Policy judges the ACP tool kind (execute/edit/read/...), not a display
    // title; a shell call without structured input is judged by its title.
    const input: Record<string, unknown> = { ...raw, ...(Array.isArray(toolCall.locations) ? { locations: toolCall.locations } : {}) };
    if (toolCall.kind === "execute" && typeof input.command !== "string" && toolCall.title) input.command = toolCall.title;
    const evaluation: WorkspaceToolPolicyEvaluation = await this.evaluator.evaluateToolUse({
      toolName: toolCall.kind ?? toolCall.title ?? request.toolCall.toolCallId,
      input,
      repoPath: context.cwd ?? context.workspaceRoot,
      workspaceRoot: context.workspaceRoot,
      agentId: context.agentId,
      toolUseId: request.toolCall.toolCallId,
    });
    // `updatedInput` is never applied: an ACP answer can only allow or refuse
    // the call the agent named, never rewrite it.
    if (evaluation.allowed && allow !== null) return { kind: "allow", optionId: allow };
    if (!evaluation.allowed) {
      return {
        kind: "deny",
        optionId: deny,
        ...(evaluation.denyMessage ? { message: evaluation.denyMessage } : {}),
        ...(evaluation.refusal ? { refusal: evaluation.refusal } : {}),
      };
    }
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "deny", optionId: deny };
  }

  async evaluateElicitation(request: CreateElicitationRequest): Promise<{ kind: "defer" } | { kind: "decline" }> {
    if (isSignInElicitation(request)) return { kind: "decline" };
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "decline" };
  }
}
