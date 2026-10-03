import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PolicyEvaluator } from "@konteks/agent-core";
import { BROWSER_MCP_SERVER_NAME, browserToolFromTitle, isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { permissionToolIdentity, type McpToolCallLedger, type PermissionToolIdentity } from "./permission-tool-identity.js";
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
 * `allowOnceOnly`: whoever answers a deferred request may allow it once, never always (an integration gate's call).
 */
export type PolicyDecision =
  | { kind: "allow"; optionId: string }
  | { kind: "deny"; optionId: string | null; message?: string; refusal?: PolicyRefusal }
  | { kind: "defer"; allowOnceOnly?: true };

/**
 * An MCP server and tools an integration binding admitted into this session
 * (a seam: no production caller admits any today). Server names are as
 * the agent reports them (`permission-tool-identity.ts`).
 */
export interface AdmittedMcpTool { server: string; tools: readonly string[] }

/**
 * `browserTools`: this session was given the QA browser (its gateway admits only the session's preview).
 * `cwd`: the session's working copy, which a refusal names; `workspaceRoot` stays the boundary.
 * `sessionServers`: the MCP servers this session gave its agent, by ACP name.
 * `ledger`: the MCP calls Codex announced, which its approvals name only by id.
 * `toolIdentity`: the request's structured tool identity when the caller already read it.
 * `admittedMcpTools`: tools of other servers an integration binding admitted (none today).
 */
export interface PermissionContext {
  assignmentId: string;
  agentId: string;
  workspaceRoot: string;
  cwd?: string;
  browserTools?: boolean;
  sessionServers?: ReadonlySet<string>;
  ledger?: McpToolCallLedger;
  toolIdentity?: PermissionToolIdentity;
  admittedMcpTools?: readonly AdmittedMcpTool[];
}

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

type AnswerOptions = { allow: string | null; deny: string | null };
type PolicyToolCall = { rawInput?: unknown; kind?: string | null; title?: string | null; locations?: unknown };

function identityOf(request: RequestPermissionRequest, context: PermissionContext): PermissionToolIdentity {
  return permissionToolIdentity(request, context.agentId,
    { ...(context.sessionServers ? { sessionServers: context.sessionServers } : {}), ...(context.ledger ? { ledger: context.ledger } : {}) });
}

/**
 * The QA browser's tools, by their server and tool name: allowed on a session
 * that was given the browser (its gateway already confines it to the
 * session's preview), refused on any other session, and the few it never
 * allows are refused everywhere. Anything else dressed as a browser tool (a
 * shell command whose model-written description imitates one, another
 * server's tool) is refused: a title can only ever take permission away.
 */
function browserRule(identity: PermissionToolIdentity, request: RequestPermissionRequest, context: PermissionContext, options: AnswerOptions): PolicyDecision | null {
  if (identity.kind === "mcp" && identity.server === BROWSER_MCP_SERVER_NAME) {
    if (context.browserTools === true && !isDeniedBrowserTool(identity.tool) && options.allow !== null) return { kind: "allow", optionId: options.allow };
    return { kind: "deny", optionId: options.deny };
  }
  if (browserToolFromTitle((request.toolCall as { title?: string | null }).title) !== null) return { kind: "deny", optionId: options.deny };
  return null;
}

function admittedTool(identity: { server: string; tool: string }, context: PermissionContext): boolean {
  return context.admittedMcpTools?.some(entry => entry.server === identity.server && entry.tools.includes(identity.tool)) ?? false;
}

function policyInput(toolCall: PolicyToolCall): Record<string, unknown> {
  const raw = toolCall.rawInput && typeof toolCall.rawInput === "object" && !Array.isArray(toolCall.rawInput) ? (toolCall.rawInput as Record<string, unknown>) : {};
  const input: Record<string, unknown> = { ...raw, ...(Array.isArray(toolCall.locations) ? { locations: toolCall.locations } : {}) };
  if (toolCall.kind === "execute" && typeof input.command !== "string" && toolCall.title) input.command = toolCall.title;
  return input;
}

function deniedBy(evaluation: WorkspaceToolPolicyEvaluation, deny: string | null): PolicyDecision {
  return {
    kind: "deny",
    optionId: deny,
    ...(evaluation.denyMessage ? { message: evaluation.denyMessage } : {}),
    ...(evaluation.refusal ? { refusal: evaluation.refusal } : {}),
  };
}

/**
 * Uses `@konteks/agent-core`'s PolicyEvaluator: a tool call the policy allows
 * is answered `allow_once`, never `allow_always` (a request that offers no
 * one-time allow is not allowed by policy); one it denies is answered
 * `reject_once`. With no evaluator the responder defers (when deferral is
 * allowed) so the governance loop's human path decides — never a silent allow.
 *
 * Tool identity comes from structured fields only (`permission-tool-identity.ts`):
 * a display title may refuse a call, never allow one.
 */
export class EvaluatorPolicyResponder implements PolicyResponder {
  constructor(private readonly evaluator: PolicyEvaluator | null, private readonly humanDeferralAllowed: () => boolean) {}

  async evaluatePermission(request: RequestPermissionRequest, context: PermissionContext): Promise<PolicyDecision> {
    const options = { allow: preferredOption(request, ["allow_once"]), deny: preferredOption(request, ["reject_once", "reject_always"]) };
    const identity = context.toolIdentity ?? identityOf(request, context);
    const ruled = browserRule(identity, request, context, options) ?? this.mcpRule(identity, context, options.deny);
    if (ruled) return ruled;
    if (this.evaluator === null) return this.deferOrDeny(options.deny);
    return this.evaluated(this.evaluator, request, context, options);
  }

  /**
   * An MCP call whose server and tool cannot be read is never guessed. Only
   * the MCP servers this session gave its agent are callable: the person's
   * claude.ai connectors and own Codex servers, a repository's servers,
   * anything else is refused, and never put to a person. A tool an
   * integration binding admitted goes to that binding's gate: asked, once.
   */
  private mcpRule(identity: PermissionToolIdentity, context: PermissionContext, deny: string | null): PolicyDecision | null {
    if (identity.kind === "unidentified" && identity.mcp) return { kind: "deny", optionId: deny };
    if (identity.kind !== "mcp" || context.sessionServers === undefined || context.sessionServers.has(identity.server)) return null;
    return admittedTool(identity, context) && this.humanDeferralAllowed() ? { kind: "defer", allowOnceOnly: true } : { kind: "deny", optionId: deny };
  }

  private deferOrDeny(deny: string | null): PolicyDecision {
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "deny", optionId: deny };
  }

  /**
   * Policy judges the ACP tool kind (execute/edit/read/...), not a display
   * title; a shell call without structured input is judged by its title.
   * `updatedInput` is never applied: an ACP answer can only allow or refuse
   * the call the agent named, never rewrite it.
   */
  private async evaluated(evaluator: PolicyEvaluator, request: RequestPermissionRequest, context: PermissionContext, options: AnswerOptions): Promise<PolicyDecision> {
    const toolCall = request.toolCall as PolicyToolCall;
    const evaluation: WorkspaceToolPolicyEvaluation = await evaluator.evaluateToolUse({
      toolName: toolCall.kind ?? toolCall.title ?? request.toolCall.toolCallId,
      input: policyInput(toolCall),
      repoPath: context.cwd ?? context.workspaceRoot,
      workspaceRoot: context.workspaceRoot,
      agentId: context.agentId,
      toolUseId: request.toolCall.toolCallId,
    });
    if (evaluation.allowed && options.allow !== null) return { kind: "allow", optionId: options.allow };
    if (!evaluation.allowed) return deniedBy(evaluation, options.deny);
    return this.deferOrDeny(options.deny);
  }
  async evaluateElicitation(request: CreateElicitationRequest): Promise<{ kind: "defer" } | { kind: "decline" }> {
    if (isSignInElicitation(request)) return { kind: "decline" };
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "decline" };
  }
}
