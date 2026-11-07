import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { plainRecord, redactText } from "@konteks/remote-common";
import { boundTitle } from "./activity.js";
import type { PermissionToolIdentity } from "./permission-tool-identity.js";
import type { PermissionContext, PolicyDecision } from "./policy-responder.js";
import { isWithinReadRoots, isWithinWorkspace, POLICY_REFUSAL_PREFIX } from "./workspace-tool-policy.js";

/** `contextShell`: a shell command that reaches only into the session's context folder. */
interface Escalation { allowOptionId: string; valid?: boolean; title: string; contextShell?: true }
export type NativeEscalationDecision = Extract<PolicyDecision, { kind: "deny" | "defer" }>;

const REJECT_OPTION_IDS: Readonly<Record<string, readonly string[]>> = {
  allow_once: ["decline", "cancel"],
  allow_permissions_turn: ["reject_permissions"],
  "allow-once": ["reject"],
};

/** These are explicit native authority requests, not proof of command confinement.
 * Codex's separate permission grant lasts a turn; it is not a per-call grant. */
export function nativePermissionEscalation(
  request: RequestPermissionRequest, context: PermissionContext,
  identity: PermissionToolIdentity, canDefer: () => boolean,
): NativeEscalationDecision | null {
  const escalation = classifiedEscalation(request, context, identity);
  if (escalation === null) return null;
  const deny = safeRejectOption(request, escalation.allowOptionId);
  if (escalation.valid === false) return { kind: "deny", optionId: deny };
  if (escalation.contextShell) return { kind: "deny", optionId: deny, message: CONTEXT_SHELL_MESSAGE, refusal: { reason: "session_context_shell" } };
  const optionIds = safeOptionIds(request, escalation.allowOptionId);
  if (optionIds === null || !canDefer()) return { kind: "deny", optionId: deny };
  return { kind: "defer", allowOnceOnly: true, optionIds, title: escalation.title };
}

/** What the person reads on the card, before the agent's own words for the call. */
const OUTSIDE_FOLDER = "Outside this session's folder";

/**
 * The connector tells every agent to read its session context folder, and
 * Claude Code reaches for `wc`, `ls`, `cat` or `sed` there. Its shell runs
 * outside the working copy, so each asked a person, who waited up to ten
 * minutes: 46 of 54 such cards (11-01 to 11-05). The folder holds only data,
 * readable with the Read tool, so the command is refused at once instead.
 */
const CONTEXT_SHELL_MESSAGE = `${POLICY_REFUSAL_PREFIX} shell command: it reads this session's context folder, which is outside the working copy. Read those files with the Read tool (or Grep and Glob) instead.`;
const NEEDS_NETWORK = "Needs the network";

/** The permission title's contract limit, counted in code points and UTF-16 units. */
const TITLE_MAX = 256;

/** A recognizable Codex carrier with a missing kind is malformed, not an
 * ordinary auto-approvable tool. Known MCP calls retain their separate gate. */
function classifiedEscalation(request: RequestPermissionRequest, context: PermissionContext, identity: PermissionToolIdentity): Escalation | null {
  if (identity.kind === "native") return providerEscalation(request, context, identity.tool);
  if (identity.kind === "unidentified" && !identity.mcp && context.agentId === "codex") return codexEscalation(request, context);
  return null;
}

function providerEscalation(request: RequestPermissionRequest, context: PermissionContext, tool: string): Escalation | null {
  if (context.agentId === "codex") return codexEscalation(request, context);
  if (context.agentId !== "claude-code") return null;
  if (tool === "SandboxNetworkAccess") return { allowOptionId: "allow-once", title: escalationTitle(request, NEEDS_NETWORK, "network access") };
  return tool === "Bash" || tool === "PowerShell" ? claudeShellEscalation(request, context, tool) : null;
}

/** Claude names the path its shell would reach outside the working copy in `locations`. */
function claudeShellEscalation(request: RequestPermissionRequest, context: PermissionContext, tool: string): Escalation | null {
  const locations = request.toolCall.locations ?? [];
  if (locations.length === 0) return null;
  const escalation: Escalation = { allowOptionId: "allow-once", title: escalationTitle(request, OUTSIDE_FOLDER, tool) };
  return onlySessionContext(locations, context) ? { ...escalation, contextShell: true } : escalation;
}

/** Every path Claude flagged lies in the working copy or the session context folder, and one in the latter. */
function onlySessionContext(locations: ReadonlyArray<{ path: string }>, context: PermissionContext): boolean {
  const root = context.sessionContextRoot;
  if (root === undefined) return false;
  const cwd = context.cwd ?? context.workspaceRoot;
  return locations.every(location => isWithinReadRoots(location.path, cwd, [root]))
    && locations.some(location => !isWithinWorkspace(location.path, cwd));
}

function codexEscalation(request: RequestPermissionRequest, context: PermissionContext): Escalation | null {
  const input = plainRecord(request.toolCall.rawInput) ?? {};
  if (codexProfileRequest(request, input)) {
    return { allowOptionId: "allow_permissions_turn", valid: codexProfileValid(request, "other", input.permissions),
      title: "Let Codex reach more files or the network for this turn?" };
  }
  if ("additionalPermissions" in input) {
    return { allowOptionId: "allow_once", valid: codexProfileValid(request, "execute", input.additionalPermissions),
      title: escalationTitle(request, "Needs more access", "Codex command") };
  }
  if (codexNetworkRequest(request, input)) return { allowOptionId: "allow_once", valid: request.toolCall.kind === "execute", title: escalationTitle(request, NEEDS_NETWORK, "Codex network access") };
  if (request.toolCall.kind !== "execute") return null;
  return outsideCommandAuthority(request, context)
    ? { allowOptionId: "allow_once", title: escalationTitle(request, OUTSIDE_FOLDER, "Codex command") }
    : null;
}

function codexProfileRequest(request: RequestPermissionRequest, input: Record<string, unknown>): boolean {
  return "permissions" in input || request.options.some(option => option.optionId.startsWith("allow_permissions_"));
}

function codexProfileValid(request: RequestPermissionRequest, kind: "other" | "execute", value: unknown): boolean {
  return request.toolCall.kind === kind && permissionProfile(value);
}

/** The pinned producer grants only these two namespaces. Empty/malformed
 * bundles cannot become an ordinary kind=other automatic approval. */
function permissionProfile(value: unknown): boolean {
  const profile = plainRecord(value);
  if (profile === undefined) return false;
  return plainRecord(profile.network) !== undefined || plainRecord(profile.fileSystem) !== undefined;
}

function codexNetworkRequest(request: RequestPermissionRequest, input: Record<string, unknown>): boolean {
  // Non-HTTP protocols omit rawInput.url. This literal is emitted by the
  // pinned producer for networkApprovalContext; it only removes automatic approval.
  const metadata = plainRecord(plainRecord(request._meta)?.permission);
  return "url" in input || metadata?.title === "Allow network access?";
}

function outsideCommandAuthority(request: RequestPermissionRequest, context: PermissionContext): boolean {
  const cwd = context.cwd ?? context.workspaceRoot;
  const input = plainRecord(request.toolCall.rawInput) ?? {};
  if ("cwd" in input && !commandCwdWithin(input.cwd, cwd)) return true;
  return request.toolCall.locations?.some(location => !isWithinReadRoots(location.path, cwd, context.readOnlyRoots)) ?? false;
}

function commandCwdWithin(value: unknown, cwd: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && isWithinWorkspace(value, cwd);
}

function safeOptionIds(request: RequestPermissionRequest, allowOptionId: string): readonly string[] | null {
  const ids = request.options.map(option => option.optionId);
  if (new Set(ids).size !== ids.length) return null;
  const allow = request.options.filter(option => option.optionId === allowOptionId && option.kind === "allow_once");
  const rejectionIds = REJECT_OPTION_IDS[allowOptionId] ?? [];
  const reject = request.options.filter(option => rejectionIds.includes(option.optionId) && option.kind === "reject_once");
  if (allow.length !== 1 || reject.length === 0) return null;
  return [allowOptionId, ...reject.map(option => option.optionId)];
}

/** Native responses dispatch by ID, not by the displayed option kind. A
 * granting ID mislabeled reject_once must produce cancellation, never a grant. */
function safeRejectOption(request: RequestPermissionRequest, allowOptionId: string): string | null {
  const ids = REJECT_OPTION_IDS[allowOptionId] ?? [];
  return request.options.find(option => ids.includes(option.optionId) && option.kind === "reject_once")?.optionId ?? null;
}

function escalationTitle(request: RequestPermissionRequest, prefix: string, fallback: string): string {
  const head = `${prefix}: `;
  const command = executeCommand(request);
  if (command === undefined) return `${head}${request.toolCall.title ?? fallback}`;
  return `${head}${boundTitle(command, TITLE_MAX - head.length)}`;
}

/** The exact command an execute call runs, as one redacted line; undefined when it has none. */
function executeCommand(request: RequestPermissionRequest): string | undefined {
  if (request.toolCall.kind !== "execute") return undefined;
  const command = plainRecord(request.toolCall.rawInput)?.command;
  if (typeof command !== "string" || command.trim().length === 0) return undefined;
  const line = oneLine(command);
  return line.length > 0 ? line : undefined;
}

/** Redact first, then flatten and space out what the card sanitizer drops; the cut runs last. */
function oneLine(command: string): string {
  const flattened = redactText(command).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  return [...flattened].map(point => droppedByCard(point) ? " " : point).join("").replace(/\s+/g, " ").trim();
}

/** The code-point ranges `sanitizePermissionRequest`'s `plainText` drops. */
const CARD_DROPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x7f], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069],
];

function droppedByCard(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return CARD_DROPPED_RANGES.some(([from, to]) => code >= from && code <= to);
}
