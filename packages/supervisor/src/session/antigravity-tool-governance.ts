import { isAbsolute, resolve } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { BROWSER_MCP_SERVER_NAME, isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { isWithinWorkspace } from "./workspace-tool-policy.js";
import type { HostPermissionContext, HostPermissionDecision, HostToolBypass, HostToolGovernance } from "./host-tool-governance.js";

/**
 * Permission parity for Google Antigravity (antigravity-runtime-support CP4,
 * decisions A4 and A21).
 *
 * Antigravity runs in its `default` mode with the connector's built-in tool
 * allowlist (`_meta.agy.enabledTools`, agent-runner `host/antigravity.ts`), so
 * commands, file changes, URL fetches and MCP calls ask through ACP
 * `session/request_permission` before they run. This judges each request by
 * the `tool_call` it names, never by its title alone:
 * - `run_command` (kind `execute`) → `rawInput.CommandLine` through the
 *   unchanged runtime policy (blocklist: `git push`, `sudo`, …); a `Cwd`
 *   outside the working copy is refused;
 * - `create_file`, `edit_file`, … (kind `edit`) → every `content[].path`,
 *   `locations[].path` and `rawInput.TargetFile`, resolved against the working
 *   copy, all inside it, then the policy's workspace check;
 * - `read_url_content` / `search_web` (kind `fetch`) → the URL or query, as
 *   every agent's web fetch;
 * - an MCP call (`call_mcp_tool`: kind `other`, `_meta.mcp {server, tool}`) →
 *   only this session's own Konteks servers (`konteks-platform`,
 *   `konteks-preview`, `konteks-result`), and `konteks-browser` only on a
 *   session given the QA browser and never for a tool it hides;
 * - the workspace-trust question ("Do you trust the authors of this
 *   workspace…", before a repository's `.agents/hooks.json` runs) → always
 *   "Don't Trust"; `invoke_subagent` and any other subagent or unknown tool →
 *   refused; a request with no `tool_call` before it, or one that disagrees
 *   with its call (title, kind, command, files, MCP names) → refused.
 * Never `allow_always` (the session strips it before anything else).
 *
 * `observe` is the tripwire. Antigravity's subagents' own calls never ask
 * (CP0 B8), and a Gemini Enterprise organisation's "Terminal auto-execution:
 * Always proceed" (Google's default) or "Proceed in sandbox" makes
 * `run_command` run with no request at all (A21). So a quarantine follows:
 * - a subagent tool (or the admin "Browser access" subagent's
 *   `chrome-devtools` tools) in any `tool_call`, the tool filter having failed;
 * - a gated call (command, file change, URL fetch, MCP, anything unknown) that
 *   completed without Konteks having allowed it;
 * - a read (`view_file`, `list_directory`, …) outside the working copy.
 * The server also reports what actually runs as its own call (id
 * `<conversationId>:<n>`, title `Running <tool>`, snake_case input). On
 * Gemini Enterprise an allowed `create_file` request then ends `failed`
 * ("approved but never executed") while a separate `Running edit_file` call
 * writes the file with no request of its own (packages dialect notes). Such a
 * call is paired with an earlier ALLOWED request for the same file (or the
 * same command), each allowance used once; one with no allowance behind it is
 * a bypass. A command that ran unasked is marked so the session can name the
 * Gemini Enterprise setting (A21).
 */

/** Antigravity's tool names and the ACP kind each one means (a runtime copy of packages' `ANTIGRAVITY_TOOL_KINDS`). */
export const ANTIGRAVITY_TOOL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  run_command: "execute",
  create_file: "edit", edit_file: "edit", write_to_file: "edit", replace_file_content: "edit", multi_replace_file_content: "edit",
  view_file: "read",
  list_directory: "search", list_dir: "search", search_directory: "search", find_file: "search", find_by_name: "search", grep_search: "search",
  read_url_content: "fetch", search_web: "fetch",
  call_mcp_tool: "other",
  invoke_subagent: "other", define_subagent: "other", manage_subagents: "other", start_subagent: "other", send_message: "other",
  ask_question: "other", generate_image: "other", schedule: "other", manage_task: "other",
  finish: "other",
});

/** Subagent tools: a subagent's own calls never ask, so any of these seen at all quarantines Antigravity. */
export const ANTIGRAVITY_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "invoke_subagent", "define_subagent", "manage_subagents", "start_subagent", "send_message", "browser_subagent",
]);

/** The Konteks servers a session may reach through `call_mcp_tool` (the browser apart). */
const KONTEKS_MCP_SERVERS: ReadonlySet<string> = new Set(["konteks-platform", "konteks-preview", "konteks-result"]);
const EDIT_TOOLS = new Set(["create_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);
const READ_TOOLS = new Set(["view_file", "list_directory", "list_dir", "search_directory", "find_file", "find_by_name", "grep_search"]);
/** Tools that touch nothing outside the model: they never ask and never trip. */
const INERT_TOOLS = new Set(["finish"]);
/**
 * A web search names a query, not a URL, and the runtime policy allows every
 * agent's web fetch (`createWorkspaceToolPolicy`), so an unasked search is at
 * parity (as OpenCode's Code Mode fetch); it is still judged when it asks.
 */
const UNASKED_AT_PARITY = new Set(["search_web"]);
/** The admin "Browser access" subagent drives `chrome-devtools-mcp` (A21): never on Konteks. */
const CHROME_DEVTOOLS = /chrome[-_]?devtools/i;

const TRUST_TITLE = /^do you trust the authors of this workspace\b/i;
const ASK_TITLE = /^Run ([a-z][a-z0-9_]*)\?$/;
const RUNNING_TITLE = /^Running ([a-z][a-z0-9_]*)$/;
const EDIT_PATH_KEYS = ["TargetFile", "target_file", "file_path", "FilePath", "path"] as const;
const READ_PATH_KEYS = ["AbsolutePath", "absolute_path", "DirectoryPath", "directory_path", "SearchPath", "search_path", "SearchDirectory", "file_path", "FilePath", "path"] as const;
const COMMAND_KEYS = ["CommandLine", "command_line", "command"] as const;
const CWD_KEYS = ["Cwd", "working_dir", "cwd"] as const;
const URL_KEYS = ["Url", "url", "URL"] as const;
const QUERY_KEYS = ["Query", "query"] as const;
/**
 * A command that names Antigravity's private home: its `HOME` (`~`, `$HOME`),
 * `$GEMINI_HOME`, `.gemini` or its sign-in files. The server counts its own
 * `GEMINI_HOME` as inside the workspace (its `allowed_dirs` add it to the
 * working copy), so neither its own scoping nor a Gemini Enterprise "Outside
 * file access: Deny" keeps a command there, and the Gemini Enterprise token
 * lives in it (CP4 live). A best-effort refusal by name; a read of it through
 * `view_file` trips instead.
 */
const PRIVATE_HOME_IN_COMMAND = [
  /(^|[^\w$])\$\{?(?:HOME|GEMINI_HOME|USERPROFILE)\b/,
  /(^|[\s'"=:(<>|;&])~(?=[/\s'"]|$)/,
  /\.gemini\b/,
  /antigravity-acp|acp_(?:business_)?token|trusted_workspaces/,
];

/** The Gemini Enterprise sign-in method (the credential A21's line is for). */
export const ANTIGRAVITY_ENTERPRISE_METHOD = "oauth-business";

export const ANTIGRAVITY_QUARANTINE_MESSAGE = "Google Antigravity ran a tool without Konteks' approval. Update the connector, then restart it.";
/** A21: the organisation's admin setting let a command run unasked. */
export const ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE = "Your organisation's Gemini Enterprise settings let Antigravity run commands without asking. Ask your Google Cloud admin to set Terminal auto-execution to Require review, then restart the connector.";

interface ObservedCall {
  /** Antigravity's tool name (from the first `tool_call`), `mcp` for an MCP call, `workspace_trust` for the trust question. */
  tool: string;
  kind: string | undefined;
  title: string;
  rawInput: Record<string, unknown>;
  mcp?: { server: string; tool: string };
  content: unknown;
  locations: unknown;
}

/** What an allowed request lets the server's own report of the work do once. */
interface Allowance { kind: "execute" | "edit"; command?: string; paths?: string[] }

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    // A replayed call (`session/load`, `session/resume`) may carry its input as a JSON string.
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function first(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = text(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function mcpOf(meta: unknown): { server: string; tool: string } | undefined {
  const mcp = record(record(meta).mcp);
  const server = text(mcp.server);
  const tool = text(mcp.tool);
  return server !== undefined && tool !== undefined ? { server, tool } : undefined;
}

function isEmptyInput(rawInput: unknown): boolean {
  if (rawInput === undefined || rawInput === null) return true;
  if (typeof rawInput === "string") return rawInput.trim() === "" || rawInput.trim() === "{}";
  return typeof rawInput === "object" && !Array.isArray(rawInput) && Object.keys(rawInput as Record<string, unknown>).length === 0;
}

/** The workspace-trust question: its title, an empty input, no tool kind (packages' `isAntigravityWorkspaceTrustRequest`). */
export function isAntigravityTrustQuestion(call: { title?: unknown; kind?: unknown; rawInput?: unknown }): boolean {
  if (call.kind !== undefined && call.kind !== null && call.kind !== "other") return false;
  if (!isEmptyInput(call.rawInput)) return false;
  return typeof call.title === "string" && TRUST_TITLE.test(call.title.trim());
}

/** Antigravity's tool name for a call: `Run <tool>?`, `Running <tool>`, a command's own title, `mcp`, or the trust question. */
export function antigravityCallTool(call: { title?: unknown; kind?: unknown; rawInput?: unknown; _meta?: unknown }): string | undefined {
  if (mcpOf(call._meta)) return "mcp";
  if (isAntigravityTrustQuestion(call)) return "workspace_trust";
  const title = typeof call.title === "string" ? call.title.trim() : "";
  const named = ASK_TITLE.exec(title) ?? RUNNING_TITLE.exec(title);
  if (named) return named[1]!;
  // A command's request (and a subagent's command) is titled with the command itself.
  if (call.kind === "execute") return "run_command";
  return undefined;
}

/** Every file a file change names: its diff entries, its locations and its input's target. */
function editPaths(call: { rawInput: Record<string, unknown>; content: unknown; locations: unknown }, cwd: string): string[] {
  const paths: string[] = [];
  for (const key of EDIT_PATH_KEYS) {
    const value = text(call.rawInput[key]);
    if (value !== undefined) paths.push(value);
  }
  if (Array.isArray(call.content)) {
    for (const entry of call.content) {
      const value = text(record(entry).path);
      if (value !== undefined) paths.push(value);
    }
  }
  paths.push(...locationPaths(call.locations));
  return [...new Set(paths.map(path => (isAbsolute(path) ? path : resolve(cwd, path))))];
}

function readPaths(call: { rawInput: Record<string, unknown>; locations: unknown }, cwd: string): string[] {
  const paths: string[] = [];
  for (const key of READ_PATH_KEYS) {
    const value = text(call.rawInput[key]);
    if (value !== undefined) paths.push(value);
  }
  paths.push(...locationPaths(call.locations));
  return [...new Set(paths.map(path => (isAbsolute(path) ? path : resolve(cwd, path))))];
}

function locationPaths(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  return locations.map(entry => text(record(entry).path)).filter((path): path is string => path !== undefined);
}

function sameMcp(a: { server: string; tool: string } | undefined, b: { server: string; tool: string } | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.server === b.server && a.tool === b.tool;
}

export class AntigravityToolGovernance implements HostToolGovernance {
  readonly agentName = "Google Antigravity";
  readonly bypassDiagnostic = "antigravity_tool_governance_bypassed";
  readonly quarantineMessage = ANTIGRAVITY_QUARANTINE_MESSAGE;
  private readonly calls = new Map<string, ObservedCall>();
  /** Calls that asked, with Konteks' answer once it is known (true: allowed). */
  private readonly asked = new Map<string, boolean | undefined>();
  /** What each asked command or file change would be allowed to do, until it is answered. */
  private readonly pending = new Map<string, Allowance>();
  /** Allowed commands and file changes the server's own report of the work may still use (each once). */
  private readonly allowances: Allowance[] = [];

  constructor(private readonly limit = 512) {}

  size(): number { return this.calls.size; }

  /** A21: a command that ran unasked on Gemini Enterprise names the organisation's setting. */
  quarantineMessageFor(bypass: HostToolBypass, credentialMethod: string | undefined): string {
    return bypass.unaskedCommand === true && credentialMethod === ANTIGRAVITY_ENTERPRISE_METHOD ? ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE : ANTIGRAVITY_QUARANTINE_MESSAGE;
  }

  observe(update: unknown, cwd: string): HostToolBypass | null {
    const value = record(update);
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (toolCallId === undefined) return null;
    if (value.sessionUpdate === "tool_call") {
      const tool = antigravityCallTool(value);
      const mcp = mcpOf(value._meta);
      // The tool filter failed: a subagent (whose calls never ask) or the admin browser subagent.
      if (tool !== undefined && ANTIGRAVITY_SUBAGENT_TOOLS.has(tool)) return this.trip(toolCallId, tool);
      if (mcp !== undefined && (CHROME_DEVTOOLS.test(mcp.server) || CHROME_DEVTOOLS.test(mcp.tool))) return this.trip(toolCallId, `mcp ${mcp.server}`);
      if (tool === undefined && typeof value.title === "string" && CHROME_DEVTOOLS.test(value.title)) return this.trip(toolCallId, "chrome_devtools");
      const known = this.calls.get(toolCallId);
      if (known && Object.keys(record(value.rawInput)).length > 0) known.rawInput = record(value.rawInput);
      if (known) return null;
      this.calls.set(toolCallId, {
        tool: tool ?? "",
        kind: typeof value.kind === "string" ? value.kind : undefined,
        title: typeof value.title === "string" ? value.title : "",
        rawInput: record(value.rawInput),
        ...(mcp ? { mcp } : {}),
        content: value.content,
        locations: value.locations,
      });
      while (this.calls.size > this.limit) this.forget(this.calls.keys().next().value!);
      return null;
    }
    if (value.sessionUpdate !== "tool_call_update") return null;
    const observed = this.calls.get(toolCallId);
    const status = value.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      // Input fills in as the call runs (an allowed command reports `command_line` + `working_dir`); the identity never changes.
      if (observed && Object.keys(record(value.rawInput)).length > 0) observed.rawInput = record(value.rawInput);
      if (observed && Array.isArray(value.locations)) observed.locations = value.locations;
      return null;
    }
    const answer = this.asked.get(toolCallId);
    const askedFirst = this.asked.has(toolCallId);
    this.forget(toolCallId);
    // Only a call that ran to completion did something.
    if (!observed || status !== "completed") return null;
    if (Object.keys(record(value.rawInput)).length > 0) observed.rawInput = record(value.rawInput);
    const { tool } = observed;
    // The trust question "completes" once answered; it is never work.
    if (tool === "workspace_trust") return null;
    if (askedFirst) {
      // A call Konteks refused must not have run anyway.
      if (answer === false) return { toolCallId, title: tool || observed.title, ...(this.isCommand(observed) ? { unaskedCommand: true } : {}) };
      // The allowed call did its own work: its allowance is spent.
      if (answer === true) this.spend(this.allowanceFor(observed, cwd));
      return null;
    }
    if (INERT_TOOLS.has(tool) || UNASKED_AT_PARITY.has(tool)) return null;
    if (READ_TOOLS.has(tool) && (observed.kind === undefined || observed.kind === "read" || observed.kind === "search")) {
      // Reads run unasked inside the working copy; one that left it should have been refused.
      return readPaths(observed, cwd).some(path => !isWithinWorkspace(path, cwd)) ? { toolCallId, title: tool } : null;
    }
    // The server's own report of an allowed request's work (Enterprise: `Running edit_file` after `create_file`).
    const wanted = this.allowanceFor(observed, cwd);
    if (wanted !== undefined && this.spend(wanted)) return null;
    return { toolCallId, title: tool || observed.title || "unnamed tool", ...(this.isCommand(observed) ? { unaskedCommand: true } : {}) };
  }

  /** Konteks' answer to a request (after policy or a person): an allowed command or file change may be carried out once. */
  answered(toolCallId: string, allowed: boolean): void {
    if (!this.asked.has(toolCallId)) return;
    this.asked.set(toolCallId, allowed);
    const allowance = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    if (allowed && allowance !== undefined) {
      this.allowances.push(allowance);
      while (this.allowances.length > 64) this.allowances.shift();
    }
  }

  decide(request: RequestPermissionRequest, context: HostPermissionContext): HostPermissionDecision {
    const toolCallId = request.toolCall.toolCallId;
    this.asked.set(toolCallId, undefined);
    const asked = request.toolCall as { title?: unknown; kind?: unknown; rawInput?: unknown; content?: unknown; locations?: unknown; _meta?: unknown };
    // A repository's hooks never run: the trust question is always answered "Don't Trust".
    if (isAntigravityTrustQuestion(asked)) return { kind: "deny", reason: "Konteks never trusts a repository's automated agent hooks" };
    const observed = this.calls.get(toolCallId);
    if (!observed) return { kind: "deny", reason: "no tool call precedes this permission request" };
    const tool = antigravityCallTool(asked);
    if (tool !== observed.tool) return { kind: "deny", reason: "the request does not name the tool its call reported" };
    if (typeof asked.title === "string" && observed.title !== "" && asked.title !== observed.title) return { kind: "deny", reason: "the request's title is not its call's" };
    if (typeof asked.kind === "string" && observed.kind !== undefined && asked.kind !== observed.kind) return { kind: "deny", reason: `the request (${asked.kind}) does not match its ${tool} call` };
    const input = record(asked.rawInput);
    const seen = observed.rawInput;
    const same = (keys: readonly string[]): string | null | undefined => {
      const a = first(input, keys);
      const b = first(seen, keys);
      if (a !== undefined && b !== undefined && a !== b) return null;
      return a ?? b;
    };

    if (tool === "mcp") {
      const mcp = mcpOf(asked._meta) ?? observed.mcp;
      if (!sameMcp(mcp, observed.mcp) || mcp === undefined) return { kind: "deny", reason: "the MCP call asked for is not the call reported" };
      if (!context.servers.has(mcp.server)) return { kind: "deny", reason: `${mcp.server} is not one of this session's servers` };
      if (mcp.server === BROWSER_MCP_SERVER_NAME) {
        return context.browserTools === true && !isDeniedBrowserTool(mcp.tool) ? { kind: "allow" } : { kind: "deny", reason: `the browser tool ${mcp.tool} is not allowed in this session` };
      }
      if (!KONTEKS_MCP_SERVERS.has(mcp.server)) return { kind: "deny", reason: `${mcp.server} is not a Konteks server` };
      return { kind: "allow" };
    }
    if (ANTIGRAVITY_SUBAGENT_TOOLS.has(tool ?? "")) return { kind: "deny", reason: `${tool} is never allowed: a subagent's own calls do not ask` };
    const kind = tool === undefined ? undefined : ANTIGRAVITY_TOOL_KINDS[tool];
    if (tool === undefined || kind === undefined) return { kind: "deny", reason: `${tool ?? "an unnamed tool"} is not a tool Konteks allows Google Antigravity to use` };

    if (tool === "run_command") {
      const command = same(COMMAND_KEYS);
      if (command === null) return { kind: "deny", reason: "the command asked for is not the command the call reported" };
      if (command === undefined) return { kind: "deny", reason: "the command call has no command to judge" };
      const folder = same(CWD_KEYS);
      if (folder === null) return { kind: "deny", reason: "the command's folder is not the one the call reported" };
      if (folder !== undefined && !isWithinWorkspace(isAbsolute(folder) ? folder : resolve(context.cwd, folder), context.cwd)) {
        return { kind: "deny", reason: "a command run outside the working copy" };
      }
      if (PRIVATE_HOME_IN_COMMAND.some(pattern => pattern.test(command))) return { kind: "deny", reason: "a command that reaches Google Antigravity's private home (its sign-in)" };
      this.pending.set(toolCallId, { kind: "execute", command: command.trim() });
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "execute", title: command, rawInput: { command } } } };
    }
    if (EDIT_TOOLS.has(tool)) {
      const target = same(EDIT_PATH_KEYS);
      if (target === null) return { kind: "deny", reason: "the file asked for is not the file the call reported" };
      const paths = [...new Set([
        ...editPaths({ rawInput: input, content: asked.content, locations: asked.locations }, context.cwd),
        ...editPaths(observed, context.cwd),
      ])];
      if (paths.length === 0) return { kind: "deny", reason: `the ${tool} call names no file to judge` };
      if (paths.some(path => !isWithinWorkspace(path, context.cwd))) return { kind: "deny", reason: "a file outside the working copy" };
      this.pending.set(toolCallId, { kind: "edit", paths });
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "edit", title: tool, rawInput: { file_path: paths[0] }, locations: paths.map(path => ({ path })) } } };
    }
    if (kind === "fetch") {
      const target = same(URL_KEYS) ?? same(QUERY_KEYS);
      if (!target) return { kind: "deny", reason: `the ${tool} call names nothing to fetch` };
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "fetch", title: tool, rawInput: { url: target } } } };
    }
    if (READ_TOOLS.has(tool)) {
      // Asked only when the organisation's outside-file setting says "Always ask": inside the working copy or not at all.
      const paths = [...new Set([...readPaths({ rawInput: input, locations: asked.locations }, context.cwd), ...readPaths(observed, context.cwd)])];
      if (paths.length === 0 || paths.some(path => !isWithinWorkspace(path, context.cwd))) return { kind: "deny", reason: "a path outside the working copy" };
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "read", title: tool, rawInput: {}, locations: paths.map(path => ({ path })) } } };
    }
    return { kind: "deny", reason: `${tool} is not a tool Konteks allows Google Antigravity to use` };
  }

  private trip(toolCallId: string, title: string): HostToolBypass {
    this.forget(toolCallId);
    return { toolCallId, title };
  }

  private isCommand(call: ObservedCall): boolean {
    return call.tool === "run_command" || call.kind === "execute";
  }

  /** What a call would need to have been allowed: its command, or the files it changes. */
  private allowanceFor(call: ObservedCall, cwd: string): Allowance | undefined {
    if (this.isCommand(call)) {
      const command = first(call.rawInput, COMMAND_KEYS) ?? (call.title.trim() || undefined);
      return command === undefined ? undefined : { kind: "execute", command: command.trim() };
    }
    if (EDIT_TOOLS.has(call.tool) || call.kind === "edit") {
      const paths = editPaths(call, cwd);
      return paths.length === 0 ? undefined : { kind: "edit", paths };
    }
    return undefined;
  }

  /** Use one allowance that covers `wanted`; false when none does. */
  private spend(wanted: Allowance | undefined): boolean {
    if (wanted === undefined) return false;
    const index = this.allowances.findIndex(allowance => allowance.kind === wanted.kind && (wanted.kind === "execute"
      ? allowance.command === wanted.command
      : (wanted.paths ?? []).every(path => allowance.paths?.includes(path))));
    if (index === -1) return false;
    this.allowances.splice(index, 1);
    return true;
  }

  private forget(toolCallId: string): void {
    this.calls.delete(toolCallId);
    this.asked.delete(toolCallId);
    this.pending.delete(toolCallId);
  }
}
