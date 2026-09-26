import { isAbsolute, resolve } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { DSH_READ_ONLY_TOOLS } from "@konteks/remote-agent-runner";

/**
 * Permission parity for DeepSeek Harness (dsh-runtime-support CP3).
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
export type DshPermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "evaluate"; request: RequestPermissionRequest };

interface ObservedCall { title: string; rawInput: Record<string, unknown> }

const EXECUTE = new Set(["bash", "pwsh"]);
const EDIT = new Set(["write", "edit", "str_replace_editor"]);
const READ_ONLY = new Set(DSH_READ_ONLY_TOOLS);
/**
 * The only MCP servers the runtime gives a session: Konteks' own — the
 * platform facade and the session's preview tools (which act only inside the
 * session's worktree and take no arguments).
 */
const KONTEKS_MCP = /^mcp__konteks-(platform|preview)__[A-Za-z0-9_-]+$/;
const SANDBOX_WITHIN_WORKSPACE = new Set(["read-only", "workspace-write"]);

/** ACP kinds for dsh's own tools, for activity; never a policy grant by itself. */
export const DSH_TOOL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  bash: "execute", pwsh: "execute",
  write: "edit", edit: "edit", str_replace_editor: "edit",
  read: "read", read_image: "read",
  glob: "search", grep: "search",
  web_fetch: "fetch", web_search: "fetch",
});

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
      const rawInput = value.rawInput !== null && typeof value.rawInput === "object" && !Array.isArray(value.rawInput) ? value.rawInput as Record<string, unknown> : {};
      this.calls.delete(toolCallId);
      this.calls.set(toolCallId, { title: typeof value.title === "string" ? value.title : "", rawInput });
      while (this.calls.size > this.limit) {
        const oldest = this.calls.keys().next().value!;
        this.calls.delete(oldest);
        this.asked.delete(oldest);
      }
      return null;
    }
    if (value.sessionUpdate !== "tool_call_update") return null;
    const status = value.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return null;
    const observed = this.calls.get(toolCallId);
    const askedFirst = this.asked.has(toolCallId);
    this.calls.delete(toolCallId);
    this.asked.delete(toolCallId);
    // Only a call that ran to completion did something; a gated one must have asked.
    if (observed && status === "completed" && !askedFirst && !READ_ONLY.has(observed.title)) return { toolCallId, title: observed.title };
    return null;
  }

  decide(request: RequestPermissionRequest, cwd: string): DshPermissionDecision {
    const toolCallId = request.toolCall.toolCallId;
    this.asked.add(toolCallId);
    const observed = this.calls.get(toolCallId);
    if (!observed) return { kind: "deny", reason: "no tool call precedes this permission request" };
    const { title, rawInput } = observed;
    const escalation = rawInput.sandbox_permissions;
    if (escalation !== undefined && !(typeof escalation === "string" && SANDBOX_WITHIN_WORKSPACE.has(escalation))) {
      return { kind: "deny", reason: "a wider sandbox than workspace-write is never granted" };
    }
    if (READ_ONLY.has(title) || KONTEKS_MCP.test(title)) return { kind: "allow" };
    if (EXECUTE.has(title)) {
      const command = rawInput.command;
      if (typeof command !== "string" || command.trim().length === 0) return { kind: "deny", reason: `${title} call has no command to judge` };
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "execute", title: command, rawInput: { command } } } };
    }
    if (EDIT.has(title)) {
      const path = typeof rawInput.file_path === "string" ? rawInput.file_path : typeof rawInput.path === "string" ? rawInput.path : undefined;
      if (path === undefined || path.length === 0) return { kind: "deny", reason: `${title} call has no path to judge` };
      const filePath = isAbsolute(path) ? path : resolve(cwd, path);
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "edit", title, rawInput: { file_path: filePath } } } };
    }
    return { kind: "deny", reason: `${title || "an unnamed tool"} is not a tool Konteks allows DeepSeek Harness to use` };
  }
}
