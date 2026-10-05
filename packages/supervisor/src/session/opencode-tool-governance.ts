import { isAbsolute, resolve } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { isWithinWorkspace } from "./workspace-tool-policy.js";
import { CODE_MODE_ACCEPTED_FORM, parseKonteksCodeModeBlock, type CodeModeCall } from "./opencode-code-mode.js";
import type { HostPermissionContext, HostPermissionDecision, HostToolBypass, HostToolGovernance } from "./host-tool-governance.js";

/**
 * Permission parity for OpenCode 2 (opencode-runtime-support CP4).
 *
 * OpenCode runs with the locked Konteks configuration (`* ask` first, reads
 * and searches allowed, `external_directory` and the built-in browser denied;
 * agent-runner `host/opencode.ts`), so every other tool asks through ACP
 * `session/request_permission` before it runs. This judges each request by
 * what the tool call really is, never by the request's own title:
 * - the tool is the name OpenCode gives the call's FIRST `tool_call` (`shell`,
 *   `edit`, `execute`, …), recorded as calls are seen; a subagent's calls
 *   (`<childSessionId>:<callId>`, titled `<subagent>: <tool>`) are judged
 *   exactly as the parent's;
 * - its input comes from the request and must agree with the latest input
 *   the call itself reported;
 * - shell → the command, through the unchanged runtime policy (blocklist:
 *   `git push`, `sudo`, …), and a shell folder outside the working copy is
 *   refused; edit/write/patch → every file, resolved against the working copy,
 *   all inside it, then the policy's workspace check; Code Mode (`execute`)
 *   → approved only in the accepted form (opencode-code-mode.ts) and only for
 *   this session's own Konteks servers; a `.env` read → refused; a subagent,
 *   todo list or web fetch → as for the other agents;
 * - an uncorrelated request, an unknown tool or a mismatch → refused. Never
 *   `allow_always` (OpenCode would store it in its database and stop asking).
 *
 * The locked configuration is one environment variable a future release could
 * stop honouring, so `observe` is the tripwire (as for DeepSeek Harness): a
 * gated tool that completes without having asked, a Code Mode block whose
 * `rawOutput.metadata.toolCalls` lists a call Konteks did not approve, or a
 * read of `.env` or outside the working copy that ran unasked, all report a
 * bypass and the session quarantines OpenCode on this connector.
 *
 * What 2.0.18 does NOT let Konteks judge beforehand (live, CP4): Code Mode
 * asks at a block's first MCP call, not before the block runs, and only for
 * MCP tools. OpenCode's own Code Mode tools and its built-in browser never
 * ask, so the locked configuration removes them from the catalogue (`deny`
 * `opencode_*` and `browser`; the tripwire still trips if one ever runs);
 * Code Mode's `fetch` can only be observed (see CODE_MODE_WEB_FETCH).
 */

/** OpenCode 2's own tool names and the ACP kind each one means (the bridge's `kind`, packages' `OPENCODE_TOOL_KINDS`). */
export const OPENCODE_TOOL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  shell: "execute", bash: "execute",
  write: "edit", edit: "edit", patch: "edit", apply_patch: "edit",
  read: "read",
  grep: "search", glob: "search", list: "search",
  webfetch: "fetch", websearch: "fetch",
  subagent: "think", task: "think", todowrite: "think", todoread: "think",
  execute: "other", skill: "other",
});

const SHELL = new Set(["shell", "bash"]);
const EDIT = new Set(["write", "edit", "patch", "apply_patch"]);
const SEARCH = new Set(["read", "grep", "glob", "list"]);
/** Tools the locked configuration lets run without asking (`read` of a `.env` file excepted). */
const UNGATED = new Set(["read", "grep", "glob", "list", "todowrite", "todoread"]);
/** The Code Mode catalogue lookup (`tools.search`): it runs without asking and calls nothing. */
const CATALOGUE_LOOKUPS = new Set(["search", "tools.search"]);
/**
 * Code Mode's `fetch` runs without any permission request in 2.0.18 (live,
 * CP4), even before the block's first Konteks call asks. It is a web fetch,
 * which the runtime policy allows every agent (`createWorkspaceToolPolicy`),
 * so it is at parity and never trips; it just cannot be judged beforehand.
 */
const CODE_MODE_WEB_FETCH = "fetch";
const ENV_FILE = /(^|[\\/])\.env(\.[^\\/]*)?$/;
const ENV_EXAMPLE = /(^|[\\/])\.env\.example$/;
const PATH_KEYS = ["filePath", "filepath", "file_path", "path", "movePath"] as const;
const CHILD_SESSION_META = "opencode/child-session";

interface ObservedCall {
  /** OpenCode's tool name, from the first `tool_call` title; never replaced by a later retitle. */
  tool: string;
  rawInput: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** OpenCode's tool name behind a first `tool_call` title; a subagent's calls are titled `<subagent>: <tool>`. */
export function openCodeToolName(toolCallId: string, title: unknown, meta?: unknown): string | undefined {
  const raw = text(title)?.trim();
  if (raw === undefined) return undefined;
  const child = record(record(meta)[CHILD_SESSION_META]);
  const prefix = typeof child.title === "string" && child.title.length > 0 ? `${child.title}: ` : undefined;
  if (prefix !== undefined && raw.startsWith(prefix)) return raw.slice(prefix.length).trim().toLowerCase();
  const colon = toolCallId.indexOf(":");
  if (colon > 0 && colon < toolCallId.length - 1) {
    const at = raw.lastIndexOf(": ");
    if (at > 0) return raw.slice(at + 2).trim().toLowerCase();
  }
  return raw.toLowerCase();
}

/** Every file a file-changing (or reading) call names: `files[].file`/`movePath` and the single-path keys. */
function namedPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = text(input[key]);
    if (value !== undefined) paths.push(value);
  }
  if (Array.isArray(input.files)) {
    for (const entry of input.files) {
      const file = record(entry);
      for (const key of ["file", "movePath", "path"] as const) {
        const value = text(file[key]);
        if (value !== undefined) paths.push(value);
      }
    }
  }
  return paths;
}

/** Code Mode's own record of the calls a block made (`rawOutput.metadata.toolCalls[]`: tool path and status). */
function codeModeCallsRan(rawOutput: unknown): Array<{ tool: string; status: string }> {
  const calls = record(record(rawOutput).metadata).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.map(entry => record(entry)).map(entry => ({
    tool: typeof entry.tool === "string" ? entry.tool : "<unnamed>",
    status: typeof entry.status === "string" ? entry.status : "unknown",
  }));
}

/** The path Code Mode lists for an approved call. */
export function codeModeCallPath(call: CodeModeCall): string { return `${call.server}.${call.tool}`; }

export class OpenCodeToolGovernance implements HostToolGovernance {
  readonly agentName = "OpenCode";
  readonly bypassDiagnostic = "opencode_tool_governance_bypassed";
  readonly quarantineMessage = "OpenCode ran a tool without Konteks' approval. Update or reinstall OpenCode, then restart the connector.";
  private readonly calls = new Map<string, ObservedCall>();
  private readonly asked = new Set<string>();
  /** Per Code Mode block: the calls Konteks approved (empty when refused). */
  private readonly approved = new Map<string, string[]>();
  /** Code Mode blocks Konteks refused. */
  private readonly refused = new Set<string>();

  constructor(private readonly limit = 512) {}

  size(): number { return this.calls.size; }

  observe(update: unknown, cwd: string): HostToolBypass | null {
    const value = record(update);
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (toolCallId === undefined) return null;
    const input = record(value.rawInput);
    if (value.sessionUpdate === "tool_call" || (value.sessionUpdate === "tool_call_update" && !this.terminal(value.status))) {
      const known = this.calls.get(toolCallId);
      if (known) {
        // A retitle (the command, the path) never renames the tool; input fills in as it streams.
        if (Object.keys(input).length > 0) known.rawInput = input;
        return null;
      }
      if (value.sessionUpdate !== "tool_call") return null;
      const tool = openCodeToolName(toolCallId, value.title, value._meta);
      if (tool === undefined) return null;
      this.calls.set(toolCallId, { tool, rawInput: input });
      while (this.calls.size > this.limit) {
        const oldest = this.calls.keys().next().value!;
        this.forget(oldest);
      }
      return null;
    }
    if (value.sessionUpdate !== "tool_call_update") return null;
    const status = value.status;
    const observed = this.calls.get(toolCallId);
    const askedFirst = this.asked.has(toolCallId);
    const approved = this.approved.get(toolCallId);
    const refusedBlock = this.refused.has(toolCallId);
    this.forget(toolCallId);
    if (!observed || status === "cancelled") return null;
    if (Object.keys(input).length > 0) observed.rawInput = input;
    if (observed.tool === "execute") {
      // A block may have run some of its calls even when it then failed.
      const allowed = [...(approved ?? [])];
      for (const { tool, status } of codeModeCallsRan(value.rawOutput)) {
        if (tool === CODE_MODE_WEB_FETCH || (!askedFirst && CATALOGUE_LOOKUPS.has(tool))) continue;
        // In a refused block the call that asked is listed as an error (Permission.DeclinedError): it never ran.
        if (refusedBlock && status === "error") continue;
        const index = allowed.indexOf(tool);
        if (index === -1) return { toolCallId, title: `execute: ${tool}` };
        allowed.splice(index, 1);
      }
      return null;
    }
    // Only a call that ran to completion did something.
    if (status !== "completed" || askedFirst) return null;
    if (!UNGATED.has(observed.tool)) return { toolCallId, title: observed.tool };
    // An allowed read or search that reached a `.env` file or left the working copy should have asked or been refused.
    for (const path of namedPaths(observed.rawInput)) {
      const absolute = isAbsolute(path) ? path : resolve(cwd, path);
      if ((observed.tool === "read" && ENV_FILE.test(absolute) && !ENV_EXAMPLE.test(absolute)) || !isWithinWorkspace(absolute, cwd)) {
        return { toolCallId, title: observed.tool };
      }
    }
    return null;
  }

  decide(request: RequestPermissionRequest, context: HostPermissionContext): HostPermissionDecision {
    const toolCallId = request.toolCall.toolCallId;
    this.asked.add(toolCallId);
    const observed = this.calls.get(toolCallId);
    if (!observed) return { kind: "deny", reason: "no tool call precedes this permission request" };
    const { tool } = observed;
    const kind = OPENCODE_TOOL_KINDS[tool];
    if (kind === undefined) return { kind: "deny", reason: `${tool} is not a tool Konteks allows OpenCode to use` };
    const requested = request.toolCall.kind;
    if (typeof requested === "string" && requested !== kind) return { kind: "deny", reason: `the request (${requested}) does not match its ${tool} call` };
    const asked = record(request.toolCall.rawInput);
    const seen = observed.rawInput;
    const same = (key: string): string | null | undefined => {
      const a = text(asked[key]);
      const b = text(seen[key]);
      if (a !== undefined && b !== undefined && a !== b) return null;
      return a ?? b;
    };

    if (tool === "skill") {
      const id = same("name");
      if (!id || !context.managedSkillIds?.has(id)) return { kind: "deny", reason: "the Skill is not authorized for this session" };
      return { kind: "allow" };
    }

    if (SHELL.has(tool)) {
      const command = same("command");
      if (command === null) return { kind: "deny", reason: "the command asked for is not the command the call reported" };
      if (command === undefined) return { kind: "deny", reason: "the shell call has no command to judge" };
      for (const folder of [text(asked.cwd), text(asked.workdir), text(seen.workdir), text(seen.cwd)]) {
        if (folder !== undefined && !isWithinWorkspace(isAbsolute(folder) ? folder : resolve(context.cwd, folder), context.cwd)) {
          return { kind: "deny", reason: "a command run outside the working copy" };
        }
      }
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "execute", title: command, rawInput: { command } } } };
    }
    if (EDIT.has(tool)) {
      const paths = [...new Set([...namedPaths(asked), ...namedPaths(seen)])].map(path => (isAbsolute(path) ? path : resolve(context.cwd, path)));
      if (paths.length === 0) return { kind: "deny", reason: `the ${tool} call names no file to judge` };
      if (paths.some(path => !isWithinWorkspace(path, context.cwd))) return { kind: "deny", reason: "a file outside the working copy" };
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "edit", title: tool, rawInput: { file_path: paths[0] }, locations: paths.map(path => ({ path })) } } };
    }
    if (tool === "execute") {
      this.approved.set(toolCallId, []);
      this.refused.add(toolCallId);
      const code = same("code");
      if (code === null) return { kind: "deny", reason: "the code asked for is not the code the call reported" };
      const block = parseKonteksCodeModeBlock(code ?? "", context.servers);
      if (!block.ok) return { kind: "deny", reason: `Code Mode block refused (${block.reason}): ${CODE_MODE_ACCEPTED_FORM}` };
      for (const call of block.calls) {
        if (call.server === "konteks-browser" && (context.browserTools !== true || isDeniedBrowserTool(call.tool))) {
          return { kind: "deny", reason: `the browser tool ${call.tool} is not allowed in this session` };
        }
      }
      this.refused.delete(toolCallId);
      this.approved.set(toolCallId, block.calls.map(codeModeCallPath));
      return { kind: "allow" };
    }
    if (SEARCH.has(tool)) {
      const paths = [...new Set([...namedPaths(asked), ...namedPaths(seen)])].map(path => (isAbsolute(path) ? path : resolve(context.cwd, path)));
      if (paths.some(path => !isWithinWorkspace(path, context.cwd))) return { kind: "deny", reason: "a path outside the working copy" };
      if (tool === "read" && paths.some(path => ENV_FILE.test(path) && !ENV_EXAMPLE.test(path))) return { kind: "deny", reason: "reading a .env file is not allowed" };
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "read", title: tool, rawInput: {}, locations: paths.map(path => ({ path })) } } };
    }
    if (kind === "fetch") {
      const target = same("url") ?? same("query");
      if (!target) return { kind: "deny", reason: `the ${tool} call names nothing to fetch` };
      return { kind: "evaluate", request: { ...request, toolCall: { toolCallId, kind: "fetch", title: tool, rawInput: { url: target } } } };
    }
    // A subagent's own calls ask and are judged like these; a todo list touches nothing.
    if (kind === "think") return { kind: "allow" };
    return { kind: "deny", reason: `${tool} is not a tool Konteks allows OpenCode to use` };
  }

  private terminal(status: unknown): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private forget(toolCallId: string): void {
    this.calls.delete(toolCallId);
    this.asked.delete(toolCallId);
    this.approved.delete(toolCallId);
    this.refused.delete(toolCallId);
  }
}
