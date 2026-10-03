import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { BROWSER_MCP_SERVER_NAME, DSH_READ_ONLY_TOOLS, isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { resolveIn } from "./host-decisions.js";

/**
 * Permission parity for DeepSeek Harness.
 *
 * dsh reports every tool call as ACP kind `other`, titled with its own tool
 * name, and its `session/request_permission` carries only the tool call id
 * (CP0 s4). The runtime policy judges a kind plus raw input, so on its own it
 * would see nothing: a shell `git push` or a write outside the workspace
 * would pass unjudged. dsh always sends the `tool_call` update before the
 * request (CP0: 13 of 13), so this keeps each session's recent tool calls and
 * rebuilds the request the policy needs. A request it cannot rebuild is
 * denied, never allowed by default.
 *
 * The Konteks ask hook (dsh-profile.ts) is what makes dsh ask at all, and dsh
 * treats a hook that cannot run as non-blocking. `observe` therefore also
 * trips when a gated tool completes without having asked.
 */
type DshPermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "evaluate"; request: RequestPermissionRequest };

interface ObservedCall { title: string; rawInput: Record<string, unknown> }

const EXECUTE = new Set(["bash", "pwsh"]);
const EDIT = new Set(["write", "edit", "str_replace_editor"]);
const READ_ONLY = new Set(DSH_READ_ONLY_TOOLS);
/**
 * The only MCP servers the runtime gives a session: Konteks' own — the
 * platform facade, the session's preview tools (which act only inside the
 * session's worktree and take no arguments) and the turn result tool
 * (`submit_result`, which only records a value on this computer).
 */
const KONTEKS_MCP = /^mcp__konteks-(platform|preview|result)__[A-Za-z0-9_-]+$/;
/**
 * The QA browser (O8: a connector capability, so dsh gets it too), allowed
 * only on a session given it and never for a tool the launcher hides
 * (`browser_run_code_unsafe`, the route tools): its gateway confines it to
 * the session's preview and the origins Core opened.
 */
const BROWSER_MCP = new RegExp(`^mcp__${BROWSER_MCP_SERVER_NAME}__([A-Za-z0-9_-]+)$`);
const SANDBOX_WITHIN_WORKSPACE = new Set(["read-only", "workspace-write"]);

/** ACP kinds for dsh's own tools, for activity; never a policy grant by itself. */
export const DSH_TOOL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  bash: "execute", pwsh: "execute",
  write: "edit", edit: "edit", str_replace_editor: "edit",
  read: "read", read_image: "read",
  glob: "search", grep: "search",
  web_fetch: "fetch", web_search: "fetch",
});

/** A sandbox escalation beyond the workspace. */
function widerSandbox(escalation: unknown): boolean {
  return escalation !== undefined && !(typeof escalation === "string" && SANDBOX_WITHIN_WORKSPACE.has(escalation));
}

/** Read-only and Konteks tools are allowed; the browser only where given; shell and edits go to policy with what they would touch. */
function toolDecision(request: RequestPermissionRequest, observed: ObservedCall, cwd: string, browserTools: boolean): DshPermissionDecision {
  const { title, rawInput } = observed;
  const toolCallId = request.toolCall.toolCallId;
  if (READ_ONLY.has(title) || KONTEKS_MCP.test(title)) return { kind: "allow" };
  const browserTool = BROWSER_MCP.exec(title)?.[1];
  if (browserTool !== undefined) return browserDecision(browserTool, browserTools);
  if (EXECUTE.has(title)) return executeDecision(request, toolCallId, title, rawInput.command);
  if (EDIT.has(title)) return editDecision(request, toolCallId, title, editPath(rawInput), cwd);
  return { kind: "deny", reason: `${title || "an unnamed tool"} is not a tool Konteks allows DeepSeek Harness to use` };
}

function browserDecision(browserTool: string, browserTools: boolean): DshPermissionDecision {
  return browserTools && !isDeniedBrowserTool(browserTool) ? { kind: "allow" } : { kind: "deny", reason: `the browser tool ${browserTool} is not allowed in this session` };
}

function executeDecision(request: RequestPermissionRequest, toolCallId: string, title: string, command: unknown): DshPermissionDecision {
  if (typeof command !== "string" || command.trim().length === 0) return { kind: "deny", reason: `${title} call has no command to judge` };
  return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "execute", title: command, rawInput: { command } } } };
}

function editPath(rawInput: Record<string, unknown>): string | undefined {
  if (typeof rawInput.file_path === "string") return rawInput.file_path;
  return typeof rawInput.path === "string" ? rawInput.path : undefined;
}

function editDecision(request: RequestPermissionRequest, toolCallId: string, title: string, path: string | undefined, cwd: string): DshPermissionDecision {
  if (path === undefined || path.length === 0) return { kind: "deny", reason: `${title} call has no path to judge` };
  const filePath = resolveIn(cwd, path);
  return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "edit", title, rawInput: { file_path: filePath } } } };
}

export class DshToolGovernance {
  private readonly calls = new Map<string, ObservedCall>();
  private readonly asked = new Set<string>();

  constructor(private readonly limit = 512) {}

  size(): number { return this.calls.size; }

  /** Record a session update; returns the call that ran without asking, if any. */
  observe(update: unknown): { toolCallId: string; title: string } | null {
    if (update === null || typeof update !== "object") return null;
    const value = update as Record<string, unknown>;
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (toolCallId === undefined) return null;
    if (value.sessionUpdate === "tool_call") {
      this.recordCall(toolCallId, value);
      return null;
    }
    if (value.sessionUpdate !== "tool_call_update") return null;
    return this.finishedWithoutAsking(toolCallId, value.status);
  }

  /** A newly announced call, newest last; the oldest are forgotten past the limit. */
  private recordCall(toolCallId: string, value: Record<string, unknown>): void {
    const rawInput = value.rawInput !== null && typeof value.rawInput === "object" && !Array.isArray(value.rawInput) ? value.rawInput as Record<string, unknown> : {};
    this.calls.delete(toolCallId);
    this.calls.set(toolCallId, { title: typeof value.title === "string" ? value.title : "", rawInput });
    while (this.calls.size > this.limit) {
      const oldest = this.calls.keys().next().value!;
      this.calls.delete(oldest);
      this.asked.delete(oldest);
    }
  }

  /** Only a call that ran to completion did something; a gated one must have asked. */
  private finishedWithoutAsking(toolCallId: string, status: unknown): { toolCallId: string; title: string } | null {
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return null;
    const observed = this.calls.get(toolCallId);
    const askedFirst = this.asked.has(toolCallId);
    this.calls.delete(toolCallId);
    this.asked.delete(toolCallId);
    if (observed && status === "completed" && !askedFirst && !READ_ONLY.has(observed.title)) return { toolCallId, title: observed.title };
    return null;
  }
  decide(request: RequestPermissionRequest, cwd: string, options: { browserTools?: boolean } = {}): DshPermissionDecision {
    const toolCallId = request.toolCall.toolCallId;
    this.asked.add(toolCallId);
    const observed = this.calls.get(toolCallId);
    if (!observed) return { kind: "deny", reason: "no tool call precedes this permission request" };
    if (widerSandbox(observed.rawInput.sandbox_permissions)) return { kind: "deny", reason: "a wider sandbox than workspace-write is never granted" };
    return toolDecision(request, observed, cwd, options.browserTools === true);
  }}
