import { isSecretKey, plainRecord, redactText } from "@konteks/remote-common";
import { ANTIGRAVITY_TOOL_KINDS, antigravityCallTool } from "./antigravity-tool-governance.js";
import { DSH_TOOL_KINDS } from "./dsh-tool-governance.js";
import { KONTEKS_CODE_MODE_SERVERS, parseKonteksCodeModeBlock } from "./opencode-code-mode.js";
import { OPENCODE_TOOL_KINDS, openCodeToolName } from "./opencode-tool-governance.js";

const TOOL_TITLE_PLACEHOLDER = /^(?:other|tool|unknown[ _-]?tool)$/i;
const ACP_TOOL_KINDS = new Set([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
]);

const PLATFORM_MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+?__(platform__[A-Za-z0-9_-]+)$/;

/** The federated `platform__*` tool name behind a Claude `mcp__<server>__<tool>` label, if that is what it is. */
function platformMcpToolName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return PLATFORM_MCP_TOOL_NAME.exec(value.trim())?.[1];
}

export interface CanonicalAcpToolIdentity {
  name?: string;
  kind?: string;
  title?: string;
}

/**
 * Tool arguments, results, and bridge metadata are private to the local
 * agent. Remove them before the first bounded wire parse: a legitimate deep
 * result must not make the public tool completion disappear. The ordinary
 * activity redaction still checks every field that is allowed onto the wire.
 */
export function omitPrivateAcpToolPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const update = value as Record<string, unknown>;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return value;
  return Object.fromEntries(Object.entries(update).filter(([key]) =>
    key !== "rawInput" && key !== "rawOutput" && key !== "_meta"));
}

type ToolCanonicalizer = (candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined) => unknown;

/**
 * Promote a bridge-specific tool identity into ACP's ordinary public fields
 * before `_meta` is discarded. The relay intentionally never persists private
 * metadata, so this local boundary is the last place Claude's safe Agent and
 * ToolSearch names can be retained for both live and durable cloud views.
 */
export function canonicalizeAcpToolActivity(
  value: unknown,
  dialectId: string | undefined,
  prior?: CanonicalAcpToolIdentity,
): unknown {
  const candidate = plainRecord(value);
  if (candidate?.sessionUpdate !== "tool_call" && candidate?.sessionUpdate !== "tool_call_update") return value;
  const canonicalize = dialectId === undefined ? undefined : DIALECT_CANONICALIZERS.get(dialectId);
  return canonicalize === undefined ? value : canonicalize(candidate, prior);
}

/** A tool identity while it is worked out: any part may still be unknown. */
type ToolIdentity = { name: string | undefined; kind: string | undefined; title: string | undefined };

function priorIdentity(prior: CanonicalAcpToolIdentity | undefined): ToolIdentity {
  return { name: prior?.name, kind: prior?.kind, title: prior?.title };
}

function definedName(name: string | undefined): { name?: string } {
  return name === undefined ? {} : { name };
}

/** The identified kind, filled in only where the call's own kind is generic (absent or `other`). */
function filledKind(candidate: Record<string, unknown>, kind: string | undefined): { kind?: string } {
  return kind !== undefined && (typeof candidate.kind !== "string" || candidate.kind === "other") ? { kind } : {};
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function claudeCanonicalizer(candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined): unknown {
  const currentName = nonBlank(candidate.name);
  const currentTitle = typeof candidate.title === "string" ? candidate.title : undefined;
  const meta = claudeMetaTool(candidate);
  const identityName = claudeIdentityName(meta.name, prior, currentName, currentTitle);
  if (identityName === undefined && prior === undefined) return candidate;
  const name = currentName ?? identityName;
  return {
    ...candidate,
    ...definedName(name),
    ...filledKind(candidate, claudeIdentityKind(identityName, meta.kind, prior)),
    ...placeholderTitle(currentTitle, prior?.title ?? name),
  };
}

/** The tool Claude's bridge names in private `_meta`, before the relay drops it. */
function claudeMetaTool(candidate: Record<string, unknown>): { name: string | undefined; kind: string | undefined } {
  const tool = plainRecord(plainRecord(candidate._meta)?.["claude.ai/tool"]);
  return {
    name: nonBlank(tool?.name),
    kind: typeof tool?.kind === "string" && ACP_TOOL_KINDS.has(tool.kind) ? tool.kind : undefined,
  };
}

function claudeIdentityName(metaName: string | undefined, prior: CanonicalAcpToolIdentity | undefined, currentName: string | undefined, currentTitle: string | undefined): string | undefined {
  // Some claude-agent-acp releases already expose the safe ToolSearch label as
  // the public title but omit the private metadata entirely. Keep this a
  // closed, exact bridge quirk: arbitrary titles must never become tool names.
  const knownPublicName = currentName === "ToolSearch" || currentTitle === "ToolSearch" ? "ToolSearch" : undefined;
  // Claude names every MCP tool `mcp__<server>__<tool>` and the bridge echoes
  // that name as the call's title with the generic `other` kind. For the
  // platform facade the tool half is the federated `platform__*` name Core
  // and the Assistant already key their policy, projection, and handoff
  // watches on; without it the call reads as an anonymous "other" tool and
  // the terminal ideation hand-off is never recognized. Only that closed
  // namespace is promoted — an arbitrary title still never becomes a name.
  const platformToolName = platformMcpToolName(currentName) ?? platformMcpToolName(currentTitle);
  return metaName ?? prior?.name ?? knownPublicName ?? platformToolName;
}

/**
 * Claude currently emits ToolSearch as ACP `other`; that one closed quirk is
 * normalized here. Other tools keep their protocol kind, including Agent.
 */
function claudeIdentityKind(identityName: string | undefined, metaKind: string | undefined, prior: CanonicalAcpToolIdentity | undefined): string | undefined {
  return identityName === "ToolSearch" ? "search" : metaKind ?? prior?.kind;
}

/** The fallback title, only over a missing or placeholder one (`other`, `tool`, `unknown tool`). */
function placeholderTitle(currentTitle: string | undefined, fallback: string | undefined): { title?: string } {
  return fallback !== undefined && (currentTitle === undefined || TOOL_TITLE_PLACEHOLDER.test(currentTitle.trim())) ? { title: fallback } : {};
}

/**
 * DeepSeek Harness reports every tool call as ACP `other`, titled with its own
 * tool name from a closed set. Give those their ACP kind for activity, and
 * promote the federated `platform__*` name behind an MCP title as for Claude.
 * An arbitrary title still never becomes a name.
 */
function dshCanonicalizer(candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined): unknown {
  const title = typeof candidate.title === "string" ? candidate.title : undefined;
  const name = platformMcpToolName(title) ?? prior?.name;
  const kind = dshKind(title, prior);
  if (name === undefined && kind === undefined) return candidate;
  return {
    ...candidate,
    ...(typeof candidate.name !== "string" ? definedName(name) : {}),
    ...filledKind(candidate, kind),
  };
}

function dshKind(title: string | undefined, prior: CanonicalAcpToolIdentity | undefined): string | undefined {
  return (title !== undefined ? DSH_TOOL_KINDS[title] : undefined) ?? prior?.kind;
}

/** OpenCode's Code Mode, named so policy and people never read it as a shell command. */
const OPENCODE_CODE_MODE_NAME = "code_mode";

/**
 * OpenCode 2 names its tool only in a call's first `tool_call` title (later
 * updates retitle it with the command or the path), so that name and its ACP
 * kind are carried forward. A Code Mode block (`execute`) is shown as the
 * Konteks tool it calls (`submit_result`, `platform__harness__plan_get`), read
 * from its code with the same parser that approves it; any other block reads
 * "Code Mode". An arbitrary title still never becomes a name.
 */
function openCodeCanonicalizer(candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined): unknown {
  const identity = codeModeIdentity(candidate, openCodeFirstIdentity(candidate, prior));
  if (identity.name === undefined && identity.kind === undefined) return candidate;
  return {
    ...candidate,
    ...definedName(identity.name),
    ...filledKind(candidate, identity.kind),
    ...openCodeTitle(candidate, identity),
  };
}

function openCodeFirstIdentity(candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined): ToolIdentity {
  if (candidate.sessionUpdate !== "tool_call" || prior !== undefined) return priorIdentity(prior);
  const toolCallId = typeof candidate.toolCallId === "string" ? candidate.toolCallId : "";
  const tool = openCodeToolName(toolCallId, candidate.title, candidate._meta);
  if (tool === undefined || !Object.hasOwn(OPENCODE_TOOL_KINDS, tool)) return priorIdentity(undefined);
  if (tool === "execute") return { name: OPENCODE_CODE_MODE_NAME, kind: OPENCODE_TOOL_KINDS[tool], title: "Code Mode" };
  return { name: tool, kind: OPENCODE_TOOL_KINDS[tool], title: undefined };
}

/** A Code Mode block that only calls Konteks tools, shown as those tools. */
function codeModeIdentity(candidate: Record<string, unknown>, identity: ToolIdentity): ToolIdentity {
  const code = (candidate.rawInput as { code?: unknown } | undefined)?.code;
  if ((identity.name !== OPENCODE_CODE_MODE_NAME && identity.kind !== "other") || typeof code !== "string") return identity;
  const block = parseKonteksCodeModeBlock(code, KONTEKS_CODE_MODE_SERVERS);
  if (!block.ok) return identity;
  const tools = [...new Set(block.calls.map(call => call.tool))];
  return { name: tools[0], kind: "other", title: tools.join(", ") };
}

/** Code Mode's own title is always `execute`; show what it runs instead. */
function openCodeTitle(candidate: Record<string, unknown>, { kind, title }: ToolIdentity): { title?: string } {
  const currentTitle = typeof candidate.title === "string" ? candidate.title.trim() : undefined;
  return title !== undefined && (currentTitle === undefined || currentTitle === "execute" || kind === "other") ? { title } : {};
}

/** Google Antigravity's own tools in plain words (the titles `Run <tool>?` and `Running <tool>` name them). */
const ANTIGRAVITY_PLAIN_TITLES: Readonly<Record<string, string>> = Object.freeze({
  create_file: "Create file", edit_file: "Edit file", write_to_file: "Write file", replace_file_content: "Edit file", multi_replace_file_content: "Edit file",
  view_file: "Read file", list_directory: "List folder", list_dir: "List folder", search_directory: "Search folder", find_file: "Find file",
  find_by_name: "Find file", grep_search: "Search files", read_url_content: "Fetch web page", search_web: "Search the web", finish: "Finish",
});
const ANTIGRAVITY_TOOL_TITLE = /^(?:Run [a-z][a-z0-9_]*\?|Running [a-z][a-z0-9_]*)$/;

/**
 * Google Antigravity names a tool in its title (`Run create_file?`, `Running
 * view_file`, a command's own text) and an MCP call in `_meta.mcp`, which the
 * relay never keeps: carry the name and ACP kind forward from the first
 * `tool_call`, show an MCP call as the Konteks tool it calls (the federated
 * `platform__*` name, `submit_result`, `preview_start`, …) and the trust
 * question as such. A command keeps its own text as the title; an arbitrary
 * title never becomes a name.
 */
function antigravityCanonicalizer(candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined): unknown {
  const identity = antigravityFirstIdentity(candidate, prior);
  if (identity.name === undefined && identity.kind === undefined) return candidate;
  return {
    ...candidate,
    ...definedName(identity.name),
    ...filledKind(candidate, identity.kind),
    ...(antigravityReplacesTitle(candidate, identity) ? { title: identity.title } : {}),
  };
}

function antigravityFirstIdentity(candidate: Record<string, unknown>, prior: CanonicalAcpToolIdentity | undefined): ToolIdentity {
  if (candidate.sessionUpdate !== "tool_call" || prior !== undefined) return priorIdentity(prior);
  return konteksMcpIdentity(candidate) ?? antigravityToolIdentity(antigravityCallTool(candidate)) ?? priorIdentity(undefined);
}

function konteksMcpIdentity(candidate: Record<string, unknown>): ToolIdentity | undefined {
  const meta = candidate._meta !== null && typeof candidate._meta === "object" ? (candidate._meta as { mcp?: { server?: unknown; tool?: unknown } }).mcp : undefined;
  if (typeof meta?.server !== "string" || typeof meta.tool !== "string" || !meta.server.startsWith("konteks-")) return undefined;
  return { name: meta.tool, kind: "other", title: meta.tool };
}

function antigravityToolIdentity(tool: string | undefined): ToolIdentity | undefined {
  if (tool === "workspace_trust") return { name: tool, kind: "other", title: "Workspace trust question" };
  if (tool === undefined || tool === "mcp" || !Object.hasOwn(ANTIGRAVITY_TOOL_KINDS, tool)) return undefined;
  return { name: tool, kind: ANTIGRAVITY_TOOL_KINDS[tool], title: ANTIGRAVITY_PLAIN_TITLES[tool] };
}

function antigravityReplacesTitle(candidate: Record<string, unknown>, { name, kind, title }: ToolIdentity): boolean {
  const currentTitle = typeof candidate.title === "string" ? candidate.title.trim() : undefined;
  return title !== undefined && (currentTitle === undefined || ANTIGRAVITY_TOOL_TITLE.test(currentTitle) || name === title || name === "workspace_trust" || kind === "other");
}

const DIALECT_CANONICALIZERS: ReadonlyMap<string, ToolCanonicalizer> = new Map([
  ["claude-code", claudeCanonicalizer],
  ["dsh", dshCanonicalizer],
  ["opencode", openCodeCanonicalizer],
  ["antigravity", antigravityCanonicalizer],
]);

/**
 * Defense in depth after strict ACP parsing and before replay persistence.
 * Raw tool arguments/results have no public projection contract; retain the
 * correlated lifecycle and declared public content, not those raw objects.
 * This is not a proof of arbitrary secret detection or split-chunk scanning.
 */
export function redactActivity(value: unknown, workspaceRoot: string, options: ActivityTextOptions = {}): unknown {
  if (typeof value === "string") return publicText(value, workspaceRoot, options.startsAtBoundary ?? true, options.continuesPath ?? false);
  if (Array.isArray(value)) return value.map(item => redactActivity(item, workspaceRoot, options));
  if (value === null || typeof value !== "object") return value;
  return redactedRecord(value, workspaceRoot, options);
}

function redactedRecord(value: object, workspaceRoot: string, options: ActivityTextOptions): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "rawInput" || key === "rawOutput" || key === "_meta") continue;
    result[key] = isSecretKey(key) ? "[redacted]" : redactActivity(child, workspaceRoot, options);
  }
  return result;
}
/**
 * Redact a relayed session message. A streamed chunk's continuation options
 * describe that chunk's text alone: applied to every string they turned the
 * message's own `kind`, `method` and `sessionUpdate` into `[local-path]`
 * whenever the previous chunk ended inside a path, so the relay contract
 * refused the chunk and every update after it in that word.
 */
export function redactSessionMessage(message: unknown, workspaceRoot: string, chunk: ActivityTextOptions = {}): unknown {
  const redacted = redactActivity(message, workspaceRoot);
  const text = (message as { params?: { update?: { content?: { type?: unknown; text?: unknown } } } } | null)?.params?.update?.content;
  if (text?.type !== "text" || typeof text.text !== "string") return redacted;
  const content = (redacted as { params: { update: { content: Record<string, unknown> } } }).params.update.content;
  content.text = redactActivity(text.text, workspaceRoot, chunk);
  return redacted;
}

interface ContractIssue {
  code: string;
  path: ReadonlyArray<PropertyKey>;
  errors?: ReadonlyArray<ReadonlyArray<ContractIssue>>;
}

/**
 * The deepest field a contract parse refused, as a dotted path and the zod
 * issue code, never the value. A union reports each branch; the branch that
 * got furthest is the one the message meant.
 */
export function contractIssue(issues: ReadonlyArray<ContractIssue>): { issuePath: string; issueCode: string } | undefined {
  let best: { path: PropertyKey[]; code: string } | undefined;
  const visit = (list: ReadonlyArray<ContractIssue>, prefix: PropertyKey[]) => {
    for (const issue of list) {
      const path = [...prefix, ...issue.path];
      if (issue.code === "invalid_union" && issue.errors && issue.errors.length > 0) {
        for (const branch of issue.errors) visit(branch, path);
        continue;
      }
      if (best === undefined || path.length > best.path.length) best = { path, code: issue.code };
    }
  };
  visit(issues, []);
  // A key inside an open JSON payload is the agent's text: name only safe segments.
  const segment = (key: PropertyKey) => typeof key === "number" || /^[A-Za-z0-9_]{1,64}$/.test(String(key)) ? String(key) : "*";
  return best === undefined ? undefined : { issuePath: best.path.map(segment).join("."), issueCode: best.code };
}

interface ActivityTextOptions {
  /**
   * False for a streamed chunk that continues a word: its first character is
   * not the start of a token, so `default` + `/name` or `componen` + `t:x/y`
   * split at a chunk boundary is not a local path (that corrupted catalog refs
   * in a planner's JSON answer into `component:default[local-path]`).
   */
  startsAtBoundary?: boolean;
  /** The previous chunk ended inside a local path: redact this chunk's leading continuation too. */
  continuesPath?: boolean;
}

const PATH_TOKEN_START = /^(?:\/(?![/*])|[A-Za-z]:(?:[\\/]|$)|\\\\)/;
const TOKEN_DELIMITER = /[\s"'<>`)\]}=(]/;

/**
 * Whether streamed text ends inside a local-path token, given whether the
 * text before it already did. Used to keep a path split across chunks private.
 */
export function endsInsidePath(text: string, previousEndedInPath: boolean, startsAtBoundary: boolean): boolean {
  let start = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (TOKEN_DELIMITER.test(text[index]!)) { start = index; break; }
  }
  if (start === -1) return previousEndedInPath || (startsAtBoundary && PATH_TOKEN_START.test(text));
  return PATH_TOKEN_START.test(text.slice(start + 1));
}

/** Whether text following `previous` starts a new token for path detection. */
export function continuesAtBoundary(previous: string | undefined): boolean {
  return previous === undefined || previous.length === 0 || /[\s"'=(]$/.test(previous);
}

function publicText(value: string, workspaceRoot: string, startsAtBoundary: boolean, continuesPath: boolean): string {
  let text = redactText(value);
  if (continuesPath) text = text.replace(/^(?=[\w.~\\/-])[^\s"'<>`)\]}*]+/, "[local-path]");
  // A chunk opening `:/…` or `:\…` continues a drive path whose letter was
  // emitted in the previous chunk. `://` is excluded because that is a URL
  // scheme, and a chunk ending exactly at the separator defers rather than
  // guessing: `:/` alone is ambiguous until the next chunk arrives.
  if (!startsAtBoundary) text = text.replace(/^:[\\/](?!\/)[^\s"'<>`)\]}]+/, "[local-path]");
  if (workspaceRoot.length > 1) {
    const root = workspaceRoot.replace(/[\\/]$/, "");
    // The prefix marker keeps approved source paths relative and recognizable.
    text = text.split(`${root}/`).join("[workspace]/").split(`${root}\\`).join("[workspace]/");
    if (text === root) text = "[workspace]";
  }
  // A DIGIT sentinel keeps a mid-token chunk start from matching a path at
  // position 0, and it must not be a letter: `x` before a chunk opening `://…`
  // reads as the drive-letter pattern below, so the sentinel matched as its own
  // drive letter, the whole probe collapsed to the mask, and `slice(1)` then
  // removed the mask's `[` instead of the sentinel — turning `https` + `://g…`
  // into `httpslocal-path]…` and corrupting every repository URL a planner
  // streamed. Secrets were already scrubbed on the original text.
  const probe = startsAtBoundary ? text : `0${text}`;
  const out = probe
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>`)\]}]+/g, "[local-path]")
    .replace(/\\\\[^\s"'<>`)\]}]+/g, "[local-path]")
    // A path starts with a path character after the slash, and `*` is never
    // part of one: `sudo ls /**` (a root slash and Markdown bold) is not a
    // private path, and redacting it broke the bold.
    .replace(/(^|[\s"'=(])\/(?!\/)(?=[\w.~-])[^\s"'<>`)\]}*]+/g, "$1[local-path]");
  return startsAtBoundary ? out : out.slice(1);
}
