import { isSecretKey, redactText } from "@konteks/remote-common";

const TOOL_TITLE_PLACEHOLDER = /^(?:other|tool|unknown[ _-]?tool)$/i;
const ACP_TOOL_KINDS = new Set([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
]);

const PLATFORM_MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+?__(platform__[A-Za-z0-9_-]+)$/;

/** The federated `platform__*` tool name behind a Claude `mcp__<server>__<tool>` label, if that is what it is. */
export function platformMcpToolName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return PLATFORM_MCP_TOOL_NAME.exec(value.trim())?.[1];
}

export interface CanonicalAcpToolIdentity {
  name?: string;
  kind?: string;
  title?: string;
}

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.sessionUpdate !== "tool_call" && candidate.sessionUpdate !== "tool_call_update") {
    return value;
  }
  if (dialectId !== "claude-code") return value;
  const meta = candidate._meta;
  const rawTool = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)["claude.ai/tool"]
    : undefined;
  const tool = rawTool !== null && typeof rawTool === "object" && !Array.isArray(rawTool)
    ? rawTool as Record<string, unknown>
    : undefined;
  const metaName = typeof tool?.name === "string" && tool.name.trim().length > 0
    ? tool.name
    : undefined;
  const metaKind = typeof tool?.kind === "string" && ACP_TOOL_KINDS.has(tool.kind)
    ? tool.kind
    : undefined;
  const currentName = typeof candidate.name === "string" && candidate.name.trim().length > 0
    ? candidate.name
    : undefined;
  const currentTitle = typeof candidate.title === "string" ? candidate.title : undefined;
  // Some claude-agent-acp releases already expose the safe ToolSearch label as
  // the public title but omit the private metadata entirely. Keep this a
  // closed, exact bridge quirk: arbitrary titles must never become tool names.
  const knownPublicName = currentName === "ToolSearch" || currentTitle === "ToolSearch"
    ? "ToolSearch"
    : undefined;
  // Claude names every MCP tool `mcp__<server>__<tool>` and the bridge echoes
  // that name as the call's title with the generic `other` kind. For the
  // platform facade the tool half is the federated `platform__*` name Core
  // and the Assistant already key their policy, projection, and handoff
  // watches on; without it the call reads as an anonymous "other" tool and
  // the terminal ideation hand-off is never recognized. Only that closed
  // namespace is promoted — an arbitrary title still never becomes a name.
  const platformToolName = platformMcpToolName(currentName) ?? platformMcpToolName(currentTitle);
  const identityName = metaName ?? prior?.name ?? knownPublicName ?? platformToolName;
  if (identityName === undefined && prior === undefined) return value;
  // Claude currently emits ToolSearch as ACP `other`; that one closed quirk is
  // normalized here. Other tools keep their protocol kind, including Agent.
  const identityKind = identityName === "ToolSearch" ? "search" : metaKind ?? prior?.kind;

  const currentKind = typeof candidate.kind === "string" ? candidate.kind : undefined;
  const name = currentName ?? identityName;
  const titleFallback = prior?.title ?? name;
  return {
    ...candidate,
    ...(name === undefined ? {} : { name }),
    ...((currentKind === undefined || currentKind === "other") && identityKind !== undefined
      ? { kind: identityKind }
      : {}),
    ...(titleFallback !== undefined && (currentTitle === undefined || TOOL_TITLE_PLACEHOLDER.test(currentTitle.trim()))
      ? { title: titleFallback }
      : {}),
  };
}

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
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "rawInput" || key === "rawOutput" || key === "_meta") continue;
    result[key] = isSecretKey(key) ? "[redacted]" : redactActivity(child, workspaceRoot, options);
  }
  return result;
}

export interface ActivityTextOptions {
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

const PATH_TOKEN_START = /^(?:\/(?!\/)|[A-Za-z]:(?:[\\/]|$)|\\\\)/;
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
  if (continuesPath) text = text.replace(/^[^\s"'<>`)\]}]+/, "[local-path]");
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
    .replace(/(^|[\s"'=(])\/(?!\/)[^\s"'<>`)\]}]+/g, "$1[local-path]");
  return startsAtBoundary ? out : out.slice(1);
}
