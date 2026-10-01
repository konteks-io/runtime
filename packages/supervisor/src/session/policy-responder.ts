import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PolicyEvaluator } from "@konteks/agent-core";
import { BROWSER_MCP_SERVER_NAME, browserToolFromTitle, isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { permissionToolIdentity, type McpToolCallLedger, type PermissionToolIdentity } from "./permission-tool-identity.js";

/**
 * The ACP policy responder (D87 step 1): a permission request or elicitation
 * is answered FIRST by policy. A definitive allow/deny is answered locally
 * within the responder deadline; only when policy defers (and the assignment
 * allows human deferral) is the request forwarded to a human over the relay.
 * Sign-in elicitations are never remotely answerable (D102) and always fail
 * closed in headless execution.
 */
/** `allowOnceOnly`: whoever answers a deferred request may allow it once, never always (an integration gate's call). */
export type PolicyDecision = { kind: "allow"; optionId: string } | { kind: "deny"; optionId: string | null } | { kind: "defer"; allowOnceOnly?: true };

/**
 * An MCP server and tools an integration binding admitted into this session
 * (external-integration CP2 seam; Stage 0 admits none). Server names are as
 * the agent reports them (`permission-tool-identity.ts`).
 */
export interface AdmittedMcpTool { server: string; tools: readonly string[] }

/**
 * `browserTools`: this session was given the QA browser (its gateway admits only the session's preview).
 * `sessionServers`: the MCP servers this session gave its agent, by ACP name.
 * `ledger`: the MCP calls Codex announced, which its approvals name only by id.
 * `toolIdentity`: the request's structured tool identity when the caller already read it.
 * `admittedMcpTools`: tools of other servers an integration binding admitted (none in Stage 0).
 */
export interface PermissionContext {
  assignmentId: string;
  agentId: string;
  workspaceRoot: string;
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

/**
 * Uses `@konteks/agent-core`'s PolicyEvaluator: a tool call the policy allows
 * is answered `allow_once`, never `allow_always` (a request that offers no
 * one-time allow is not allowed by policy); one it denies is answered
 * `reject_once`. With no evaluator the responder defers (when deferral is
 * allowed) so the governance loop's human path decides — never a silent allow.
 *
 * Tool identity comes from structured fields only (`permission-tool-identity.ts`,
 * Stage 0 S0-4): a display title may refuse a call, never allow one.
 */
export class EvaluatorPolicyResponder implements PolicyResponder {
  constructor(private readonly evaluator: PolicyEvaluator | null, private readonly humanDeferralAllowed: () => boolean) {}

  async evaluatePermission(request: RequestPermissionRequest, context: PermissionContext): Promise<PolicyDecision> {
    const allow = preferredOption(request, ["allow_once"]);
    const deny = preferredOption(request, ["reject_once", "reject_always"]);
    const identity = context.toolIdentity ?? permissionToolIdentity(request, context.agentId,
      { ...(context.sessionServers ? { sessionServers: context.sessionServers } : {}), ...(context.ledger ? { ledger: context.ledger } : {}) });
    // The QA browser's tools, by their server and tool name: allowed on a
    // session that was given the browser (its gateway already confines it to
    // the session's preview), refused on any other session, and the few it
    // never allows are refused everywhere.
    if (identity.kind === "mcp" && identity.server === BROWSER_MCP_SERVER_NAME) {
      if (context.browserTools === true && !isDeniedBrowserTool(identity.tool) && allow !== null) return { kind: "allow", optionId: allow };
      return { kind: "deny", optionId: deny };
    }
    // Anything else dressed as a browser tool is refused (a shell command
    // whose model-written description imitates one, another server's tool):
    // a title can only ever take permission away.
    if (browserToolFromTitle((request.toolCall as { title?: string | null }).title) !== null) return { kind: "deny", optionId: deny };
    // An MCP call whose server and tool cannot be read is never guessed.
    if (identity.kind === "unidentified" && identity.mcp) return { kind: "deny", optionId: deny };
    // Only the MCP servers this session gave its agent are callable (S0-2):
    // the person's claude.ai connectors and own Codex servers, a repository's
    // servers, anything else is refused, and never put to a person. A tool an
    // integration binding admitted goes to that binding's gate: asked, once.
    if (identity.kind === "mcp" && context.sessionServers !== undefined && !context.sessionServers.has(identity.server)) {
      const admitted = context.admittedMcpTools?.some(entry => entry.server === identity.server && entry.tools.includes(identity.tool)) ?? false;
      if (admitted && this.humanDeferralAllowed()) return { kind: "defer", allowOnceOnly: true };
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
