import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { isDeniedBrowserTool } from "@konteks/remote-agent-runner";
import { isWithinWorkspace } from "./workspace-tool-policy.js";
import { rebuiltRequest, refusal, resolveIn } from "./host-decisions.js";
import { CODE_MODE_ACCEPTED_FORM, parseKonteksCodeModeBlock, type CodeModeCall } from "./opencode-code-mode.js";
import type { HostPermissionContext, HostPermissionDecision, HostToolBypass, HostToolGovernance } from "./host-tool-governance.js";

/**
 * Permission parity for OpenCode 2.
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
 * What 2.0.18 does NOT let Konteks judge beforehand: Code Mode
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
  execute: "other",
});

const SHELL = new Set(["shell", "bash"]);
const EDIT = new Set(["write", "edit", "patch", "apply_patch"]);
const SEARCH = new Set(["read", "grep", "glob", "list"]);
/** Tools the locked configuration lets run without asking (`read` of a `.env` file excepted). */
const UNGATED = new Set(["read", "grep", "glob", "list", "todowrite", "todoread"]);
/** The Code Mode catalogue lookup (`tools.search`): it runs without asking and calls nothing. */
const CATALOGUE_LOOKUPS = new Set(["search", "tools.search"]);
/**
 * Code Mode's `fetch` runs without any permission request in 2.0.18, even
 * before the block's first Konteks call asks. It is a web fetch,
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
  return (childToolName(raw, meta) ?? subagentToolName(raw, toolCallId) ?? raw).toLowerCase();
}

/** A subagent's call titled with the child session's own title as prefix. */
function childToolName(raw: string, meta: unknown): string | undefined {
  const child = record(record(meta)[CHILD_SESSION_META]);
  const prefix = typeof child.title === "string" && child.title.length > 0 ? `${child.title}: ` : undefined;
  return prefix !== undefined && raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : undefined;
}

/** A subagent's call (`<childSessionId>:<callId>`) titled `<subagent>: <tool>`. */
function subagentToolName(raw: string, toolCallId: string): string | undefined {
  const colon = toolCallId.indexOf(":");
  if (colon <= 0 || colon >= toolCallId.length - 1) return undefined;
  const at = raw.lastIndexOf(": ");
  return at > 0 ? raw.slice(at + 2).trim() : undefined;
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

/** What Konteks decided for a Code Mode block before it ran. */
interface BlockDecision { askedFirst: boolean; approved: string[] | undefined; refusedBlock: boolean }

/**
 * A listed call that needs no approval: Code Mode's web fetch, a catalogue
 * lookup in a block that never asked, or, in a refused block, the call that
 * asked (listed as an error, Permission.DeclinedError: it never ran).
 */
function uncheckedCall(tool: string, status: string, block: BlockDecision): boolean {
  return tool === CODE_MODE_WEB_FETCH || (!block.askedFirst && CATALOGUE_LOOKUPS.has(tool)) || (block.refusedBlock && status === "error");
}

/** A call a Code Mode block ran without Konteks having approved it. A block may have run some of its calls even when it then failed. */
function unapprovedCodeModeCall(toolCallId: string, rawOutput: unknown, block: BlockDecision): HostToolBypass | null {
  const allowed = [...(block.approved ?? [])];
  for (const { tool, status } of codeModeCallsRan(rawOutput)) {
    if (uncheckedCall(tool, status, block)) continue;
    const index = allowed.indexOf(tool);
    if (index === -1) return { toolCallId, title: `execute: ${tool}` };
    allowed.splice(index, 1);
  }
  return null;
}

function privateEnvFile(path: string): boolean {
  return ENV_FILE.test(path) && !ENV_EXAMPLE.test(path);
}

/** An allowed read or search that reached a `.env` file or left the working copy should have asked or been refused. */
function ungatedOverreach(toolCallId: string, observed: ObservedCall, cwd: string): HostToolBypass | null {
  for (const path of namedPaths(observed.rawInput)) {
    const absolute = resolveIn(cwd, path);
    if ((observed.tool === "read" && privateEnvFile(absolute)) || !isWithinWorkspace(absolute, cwd)) return { toolCallId, title: observed.tool };
  }
  return null;
}

/** A permission request next to the input its call reported. */
interface AskedRequest {
  request: RequestPermissionRequest;
  toolCallId: string;
  asked: Record<string, unknown>;
  seen: Record<string, unknown>;
  context: HostPermissionContext;
}

/** The value both the request and its call give (either may omit it); null when they disagree. */
function agreed(r: AskedRequest, key: string): string | null | undefined {
  const a = text(r.asked[key]);
  const b = text(r.seen[key]);
  if (a !== undefined && b !== undefined && a !== b) return null;
  return a ?? b;
}

function namedAbsolutePaths(r: AskedRequest): string[] {
  return [...new Set([...namedPaths(r.asked), ...namedPaths(r.seen)])].map(path => resolveIn(r.context.cwd, path));
}

function shellDecision(r: AskedRequest): HostPermissionDecision {
  const command = agreed(r, "command");
  if (command === null) return refusal("the command asked for is not the command the call reported");
  if (command === undefined) return refusal("the shell call has no command to judge");
  const folders = [text(r.asked.cwd), text(r.asked.workdir), text(r.seen.workdir), text(r.seen.cwd)];
  if (folders.some(folder => folder !== undefined && !isWithinWorkspace(resolveIn(r.context.cwd, folder), r.context.cwd))) return refusal("a command run outside the working copy");
  return rebuiltRequest(r.request, r.toolCallId, { kind: "execute", title: command, rawInput: { command } });
}

function editDecision(r: AskedRequest, tool: string): HostPermissionDecision {
  const paths = namedAbsolutePaths(r);
  if (paths.length === 0) return refusal(`the ${tool} call names no file to judge`);
  if (paths.some(path => !isWithinWorkspace(path, r.context.cwd))) return refusal("a file outside the working copy");
  return rebuiltRequest(r.request, r.toolCallId, { kind: "edit", title: tool, rawInput: { file_path: paths[0] }, locations: paths.map(path => ({ path })) });
}

function searchDecision(r: AskedRequest, tool: string): HostPermissionDecision {
  const paths = namedAbsolutePaths(r);
  if (paths.some(path => !isWithinWorkspace(path, r.context.cwd))) return refusal("a path outside the working copy");
  if (tool === "read" && paths.some(privateEnvFile)) return refusal("reading a .env file is not allowed");
  return rebuiltRequest(r.request, r.toolCallId, { kind: "read", title: tool, rawInput: {}, locations: paths.map(path => ({ path })) });
}

function fetchDecision(r: AskedRequest, tool: string): HostPermissionDecision {
  const target = agreed(r, "url") ?? agreed(r, "query");
  if (!target) return refusal(`the ${tool} call names nothing to fetch`);
  return rebuiltRequest(r.request, r.toolCallId, { kind: "fetch", title: tool, rawInput: { url: target } });
}

/** The path Code Mode lists for an approved call. */
function codeModeCallPath(call: CodeModeCall): string { return `${call.server}.${call.tool}`; }

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

  observe(update: unknown, cwd: string): HostToolBypass | null {
    const value = record(update);
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (toolCallId === undefined) return null;
    const input = record(value.rawInput);
    if (value.sessionUpdate === "tool_call" || (value.sessionUpdate === "tool_call_update" && !this.terminal(value.status))) return this.observeRunning(toolCallId, value, input);
    if (value.sessionUpdate !== "tool_call_update") return null;
    return this.observeEnd(toolCallId, value, input, cwd);
  }

  private observeRunning(toolCallId: string, value: Record<string, unknown>, input: Record<string, unknown>): null {
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

  private observeEnd(toolCallId: string, value: Record<string, unknown>, input: Record<string, unknown>, cwd: string): HostToolBypass | null {
    const status = value.status;
    const observed = this.calls.get(toolCallId);
    const block: BlockDecision = { askedFirst: this.asked.has(toolCallId), approved: this.approved.get(toolCallId), refusedBlock: this.refused.has(toolCallId) };
    this.forget(toolCallId);
    if (!observed || status === "cancelled") return null;
    if (Object.keys(input).length > 0) observed.rawInput = input;
    if (observed.tool === "execute") return unapprovedCodeModeCall(toolCallId, value.rawOutput, block);
    // Only a call that ran to completion did something.
    if (status !== "completed" || block.askedFirst) return null;
    if (!UNGATED.has(observed.tool)) return { toolCallId, title: observed.tool };
    return ungatedOverreach(toolCallId, observed, cwd);
  }

  decide(request: RequestPermissionRequest, context: HostPermissionContext): HostPermissionDecision {
    const toolCallId = request.toolCall.toolCallId;
    this.asked.add(toolCallId);
    const observed = this.calls.get(toolCallId);
    if (!observed) return refusal("no tool call precedes this permission request");
    const { tool } = observed;
    const kind = OPENCODE_TOOL_KINDS[tool];
    if (kind === undefined) return refusal(`${tool} is not a tool Konteks allows OpenCode to use`);
    const requested = request.toolCall.kind;
    if (typeof requested === "string" && requested !== kind) return refusal(`the request (${requested}) does not match its ${tool} call`);
    return this.toolDecision({ request, toolCallId, asked: record(request.toolCall.rawInput), seen: observed.rawInput, context }, tool, kind);
  }

  private toolDecision(r: AskedRequest, tool: string, kind: string): HostPermissionDecision {
    if (SHELL.has(tool)) return shellDecision(r);
    if (EDIT.has(tool)) return editDecision(r, tool);
    if (tool === "execute") return this.codeModeDecision(r);
    if (SEARCH.has(tool)) return searchDecision(r, tool);
    if (kind === "fetch") return fetchDecision(r, tool);
    // A subagent's own calls ask and are judged like these; a todo list touches nothing.
    if (kind === "think") return { kind: "allow" };
    return refusal(`${tool} is not a tool Konteks allows OpenCode to use`);
  }

  /** A Code Mode block counts as refused until every call in it is approved. */
  private codeModeDecision(r: AskedRequest): HostPermissionDecision {
    this.approved.set(r.toolCallId, []);
    this.refused.add(r.toolCallId);
    const code = agreed(r, "code");
    if (code === null) return refusal("the code asked for is not the code the call reported");
    const block = parseKonteksCodeModeBlock(code ?? "", r.context.servers);
    if (!block.ok) return refusal(`Code Mode block refused (${block.reason}): ${CODE_MODE_ACCEPTED_FORM}`);
    const browser = block.calls.find(call => call.server === "konteks-browser" && (r.context.browserTools !== true || isDeniedBrowserTool(call.tool)));
    if (browser) return refusal(`the browser tool ${browser.tool} is not allowed in this session`);
    this.refused.delete(r.toolCallId);
    this.approved.set(r.toolCallId, block.calls.map(codeModeCallPath));
    return { kind: "allow" };
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
