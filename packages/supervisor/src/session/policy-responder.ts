import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PolicyEvaluator } from "@konteks/agent-core";
import { nativePermissionEscalation, type NativeEscalationDecision } from "./native-permission-escalation.js";
import { BROWSER_MCP_SERVER_NAME, browserToolFromTitle, isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { permissionToolIdentity, type McpToolCallLedger, type PermissionToolIdentity } from "./permission-tool-identity.js";
import type { PolicyRefusal, WorkspaceToolPolicyContext, WorkspaceToolPolicyEvaluation } from "./workspace-tool-policy.js";

/**
 * The ACP policy responder: a permission request or elicitation
 * is answered FIRST by policy. A definitive allow/deny is answered locally
 * within the responder deadline; only when policy defers (and the assignment
 * allows human deferral) is the request forwarded to a human over the relay.
 * Sign-in elicitations are never remotely answerable and always fail
 * closed in headless execution.
 */
/**
 * A deny carries why (two "Edit files" refusals once ended a repair turn
 * and nothing said which path was wrong): `message` is the note for the
 * agent and Konteks, `refusal` the detail the connector logs.
 * `allowOnceOnly` excludes persistent choices; `optionIds` also excludes
 * native automatic-review choices. A Codex standalone manual grant is for the
 * turn, which its deferred title states; it is not a per-call grant.
 */
export type PolicyDecision =
  | { kind: "allow"; optionId: string }
  | { kind: "deny"; optionId: string | null; message?: string; refusal?: PolicyRefusal }
  | { kind: "defer"; allowOnceOnly?: true; optionIds?: readonly string[]; title?: string };

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
  /** Local preparation authority; never read from tool arguments. */
  readOnlyRoots?: readonly string[];
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

/** Apply the same finite choices before broker registration, digesting and
 * relay display, so a withheld native option can never be selected later. */
export function deferredPermissionRequest(request: RequestPermissionRequest, decision: Extract<PolicyDecision, { kind: "defer" }>): RequestPermissionRequest {
  const options = request.options.filter(option => {
    if (decision.allowOnceOnly && option.kind === "allow_always") return false;
    return decision.optionIds?.includes(option.optionId) ?? true;
  });
  return { ...request, options, toolCall: { ...request.toolCall, ...(decision.title ? { title: decision.title } : {}) } };
}

function answerOptions(request: RequestPermissionRequest, escalation: NativeEscalationDecision | null): AnswerOptions {
  const allow = preferredOption(request, ["allow_once"]);
  if (escalation?.kind === "deny") return { allow, deny: escalation.optionId };
  const eligible = escalation === null ? request : deferredPermissionRequest(request, escalation);
  return { allow, deny: preferredOption(eligible, ["reject_once", "reject_always"]) };
}

/** The pinned Claude bridge presents PowerShell as kind=other. Its patched
 * native identity still makes it an execution request subject to the blocklist. */
function policyToolName(request: RequestPermissionRequest, context: PermissionContext, identity: PermissionToolIdentity): string {
  const nativeShell = context.agentId === "claude-code" && identity.kind === "native" && (identity.tool === "Bash" || identity.tool === "PowerShell");
  if (nativeShell) return "execute";
  return request.toolCall.kind ?? request.toolCall.title ?? request.toolCall.toolCallId;
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
 * Explicit native authority escalation instead requires the finite human choice,
 * or refusal when that choice is unavailable.
 *
 * Tool identity comes from structured fields only (`permission-tool-identity.ts`):
 * a display title may refuse a call, never allow one.
 */
export class EvaluatorPolicyResponder implements PolicyResponder {
  constructor(private readonly evaluator: PolicyEvaluator | null, private readonly humanDeferralAllowed: () => boolean) {}

  async evaluatePermission(request: RequestPermissionRequest, context: PermissionContext): Promise<PolicyDecision> {
    const identity = context.toolIdentity ?? identityOf(request, context);
    const escalation = nativePermissionEscalation(request, context, identity, this.humanDeferralAllowed);
    const options = answerOptions(request, escalation);
    const ruled = browserRule(identity, request, context, options) ?? this.mcpRule(identity, context, options.deny);
    if (ruled) return ruled;
    if (this.evaluator === null) return escalation ?? this.deferOrDeny(options.deny);
    return this.evaluated(this.evaluator, request, context, options, identity, escalation);
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
   * Policy judges the ACP kind, with the pinned Claude native shell identity
   * normalized to execute. A shell lacking structured input uses its title.
   * `updatedInput` is never applied: an ACP answer can only allow or refuse
   * the call the agent named, never rewrite it.
   */
  private async evaluated(evaluator: PolicyEvaluator, request: RequestPermissionRequest, context: PermissionContext, options: AnswerOptions, identity: PermissionToolIdentity, escalation: NativeEscalationDecision | null): Promise<PolicyDecision> {
    const toolCall = request.toolCall as PolicyToolCall;
    const policyContext: WorkspaceToolPolicyContext = {
      toolName: policyToolName(request, context, identity),
      input: policyInput(toolCall),
      repoPath: context.cwd ?? context.workspaceRoot,
      workspaceRoot: context.workspaceRoot,
      readOnlyRoots: context.readOnlyRoots ?? [],
      agentId: context.agentId,
      toolUseId: request.toolCall.toolCallId,
    };
    const evaluation: WorkspaceToolPolicyEvaluation = await evaluator.evaluateToolUse(policyContext);
    if (!evaluation.allowed) return deniedBy(evaluation, options.deny);
    if (escalation !== null) return escalation;
    if (options.allow !== null) return { kind: "allow", optionId: options.allow };
    return this.deferOrDeny(options.deny);
  }

  async evaluateElicitation(request: CreateElicitationRequest): Promise<{ kind: "defer" } | { kind: "decline" }> {
    if (isSignInElicitation(request)) return { kind: "decline" };
    return this.humanDeferralAllowed() ? { kind: "defer" } : { kind: "decline" };
  }
}
