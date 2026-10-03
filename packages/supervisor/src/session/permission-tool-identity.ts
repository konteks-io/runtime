import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { plainRecord } from "@konteks/remote-common";

/**
 * Which tool a permission request asks for, read only from structured fields.
 * A request's `title` is
 * display text: Claude Code's shell title is the model-written description,
 * and an MCP tool chooses its own display title, so a title never identifies
 * a tool and never grants anything.
 *
 * - `mcp`: an MCP tool, by the server name the session knows and the tool name.
 * - `native`: the agent's own tool (Claude's `Bash`, `Edit`…; Codex's command
 *   and file-change approvals, by their ACP kind).
 * - `unidentified`: no structured identity. `mcp` is true when the request is
 *   known to be an MCP call (Codex marks its MCP approvals) but its server or
 *   tool cannot be read: such a call is refused, never guessed.
 */
export type PermissionToolIdentity =
  | { kind: "mcp"; server: string; tool: string }
  | { kind: "native"; tool: string }
  | { kind: "unidentified"; mcp: boolean };


const MAX_NAME = 256;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_NAME;

/** Claude Code's MCP name segment for a server (`normalizeNameForMCP`): anything but letters, digits, `_` and `-` becomes `_`. */
export function claudeMcpServerSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Codex's MCP server key for an ACP server name (codex-acp `sanitizeMcpServerName`): whitespace becomes `_`. */
function codexMcpServerName(name: string): string {
  return name.replace(/\s/g, "_");
}

function toolCallUpdate(value: Record<string, unknown> | undefined): value is Record<string, unknown> & { toolCallId: string } {
  return value !== undefined && (value.sessionUpdate === "tool_call" || value.sessionUpdate === "tool_call_update") && nonEmpty(value.toolCallId);
}

/**
 * A `tool_call` Codex marked as an MCP call, with its server, tool and the
 * call's own arguments, kept for an integration gate that must judge the
 * exact arguments of a Codex approval (which names only the id).
 */
function announcedMcpCall(value: Record<string, unknown>): { server: string; tool: string; arguments?: unknown } | null {
  if (value.sessionUpdate !== "tool_call" || plainRecord(value._meta)?.is_mcp_tool_call !== true) return null;
  const raw = plainRecord(value.rawInput);
  if (!raw || !nonEmpty(raw.server) || !nonEmpty(raw.tool)) return null;
  return { server: raw.server, tool: raw.tool, ...("arguments" in raw ? { arguments: raw.arguments } : {}) };
}

/**
 * The MCP tool calls Codex announced, by tool call id: codex-acp's `tool_call`
 * for an `mcpToolCall` item carries `_meta.is_mcp_tool_call` and the item's
 * own `rawInput: { server, tool, arguments }`, and the approval Codex then asks
 * for names only that tool call id. Bounded; a terminal update forgets it.
 */
export class McpToolCallLedger {
  private readonly calls = new Map<string, { server: string; tool: string; arguments?: unknown }>();

  constructor(private readonly limit = 512) {}

  observe(update: unknown): void {
    const value = plainRecord(update);
    if (!toolCallUpdate(value)) return;
    if (value.status === "completed" || value.status === "failed") {
      this.calls.delete(value.toolCallId);
      return;
    }
    const call = announcedMcpCall(value);
    if (!call) return;
    this.calls.delete(value.toolCallId);
    this.calls.set(value.toolCallId, call);
    while (this.calls.size > this.limit) this.calls.delete(this.calls.keys().next().value!);
  }
  get(toolCallId: string): { server: string; tool: string } | undefined {
    const call = this.calls.get(toolCallId);
    return call ? { server: call.server, tool: call.tool } : undefined;
  }

  /** The announced call's arguments; `undefined` when Codex announced none. */
  arguments(toolCallId: string): unknown {
    return this.calls.get(toolCallId)?.arguments;
  }
}

interface PermissionIdentityInputs {
  /** The MCP servers this session gave its agent (their ACP names). */
  sessionServers?: ReadonlySet<string>;
  /** Codex's announced MCP calls (relayed-session observes every session update). */
  ledger?: McpToolCallLedger;
}

/** `mcp__<server>__<tool>`: the session's own server when one matches (longest first), else the first `__` split. */
function claudeMcpIdentity(name: string, servers: ReadonlySet<string> | undefined): PermissionToolIdentity {
  const rest = name.slice("mcp__".length);
  const known = [...(servers ?? [])].sort((a, b) => b.length - a.length);
  for (const server of known) {
    const prefix = `${claudeMcpServerSegment(server)}__`;
    if (rest.startsWith(prefix) && rest.length > prefix.length) return { kind: "mcp", server, tool: rest.slice(prefix.length) };
  }
  const split = rest.indexOf("__");
  if (split <= 0 || split + 2 >= rest.length) return { kind: "unidentified", mcp: true };
  return { kind: "mcp", server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

export function permissionToolIdentity(request: RequestPermissionRequest, agentId: string, inputs: PermissionIdentityInputs = {}): PermissionToolIdentity {
  const toolCall = plainRecord(request.toolCall) ?? {};
  if (agentId === "claude-code") return claudeIdentity(toolCall, inputs);
  if (agentId === "codex") return codexIdentity(request, toolCall, inputs);
  return { kind: "unidentified", mcp: false };
}

/** The bridge names the tool in `_meta.claudeCode.toolName`. */
function claudeIdentity(toolCall: Record<string, unknown>, inputs: PermissionIdentityInputs): PermissionToolIdentity {
  const toolName = plainRecord(plainRecord(toolCall._meta)?.claudeCode)?.toolName;
  if (!nonEmpty(toolName)) return { kind: "unidentified", mcp: false };
  return toolName.startsWith("mcp__") ? claudeMcpIdentity(toolName, inputs.sessionServers) : { kind: "native", tool: toolName };
}

/**
 * codex-acp marks an MCP tool approval; an MCP server's own elicitation
 * carries its server name in rawInput. Both are MCP, never native.
 */
function codexIdentity(request: RequestPermissionRequest, toolCall: Record<string, unknown>, inputs: PermissionIdentityInputs): PermissionToolIdentity {
  if (plainRecord(request._meta)?.is_mcp_tool_approval === true || typeof plainRecord(toolCall.rawInput)?.serverName === "string") return codexMcpIdentity(toolCall, inputs);
  return nonEmpty(toolCall.kind) ? { kind: "native", tool: toolCall.kind } : { kind: "unidentified", mcp: false };
}

/** The announced call the approval names, under the session server it belongs to. */
function codexMcpIdentity(toolCall: Record<string, unknown>, inputs: PermissionIdentityInputs): PermissionToolIdentity {
  const call = nonEmpty(toolCall.toolCallId) ? inputs.ledger?.get(toolCall.toolCallId) : undefined;
  if (!call) return { kind: "unidentified", mcp: true };
  const server = [...(inputs.sessionServers ?? [])].find(name => codexMcpServerName(name) === call.server) ?? call.server;
  return { kind: "mcp", server, tool: call.tool };
}