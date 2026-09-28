import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PolicyEvaluator } from "@konteks/agent-core";
import { browserToolFromTitle, isDeniedBrowserTool } from "@konteks/remote-agent-runner";

/**
 * The ACP policy responder (D87 step 1): a permission request or elicitation
 * is answered FIRST by policy. A definitive allow/deny is answered locally
 * within the responder deadline; only when policy defers (and the assignment
 * allows human deferral) is the request forwarded to a human over the relay.
 * Sign-in elicitations are never remotely answerable (D102) and always fail
 * closed in headless execution.
 */
export type PolicyDecision = { kind: "allow"; optionId: string } | { kind: "deny"; optionId: string | null } | { kind: "defer" };

/** `browserTools`: this session was given the QA browser (its gateway admits only the session's preview). */
export interface PermissionContext { assignmentId: string; agentId: string; workspaceRoot: string; browserTools?: boolean }

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
    const evaluation = await this.evaluator.evaluateToolUse({
      toolName: toolCall.kind ?? toolCall.title ?? request.toolCall.toolCallId,
      input,
      repoPath: context.workspaceRoot,
      workspaceRoot: context.workspaceRoot,
      agentId: context.agentId,
      toolUseId: request.toolCall.toolCallId,
    });
    if (evaluation.allowed && allow !== null) return { kind: "allow", optionId: allow };
    if (!evaluation.allowed) return { kind: "deny", optionId: deny };
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "deny", optionId: deny };
  }

  async evaluateElicitation(request: CreateElicitationRequest): Promise<{ kind: "defer" } | { kind: "decline" }> {
    if (isSignInElicitation(request)) return { kind: "decline" };
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "decline" };
  }
}
