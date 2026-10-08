import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { plainRecord } from "@konteks/remote-common";
import type { PermissionToolIdentity } from "./permission-tool-identity.js";
import type { PermissionContext, PolicyDecision } from "./policy-responder.js";
import { isWithinReadRoots, isWithinWorkspace } from "./workspace-tool-policy.js";

interface Escalation { allowOptionId: string; valid?: boolean; title: string }
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
  const optionIds = safeOptionIds(request, escalation.allowOptionId);
  if (optionIds === null || !canDefer()) return { kind: "deny", optionId: deny };
  return { kind: "defer", allowOnceOnly: true, optionIds, title: escalation.title };
}

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
  if (tool === "SandboxNetworkAccess") return { allowOptionId: "allow-once", title: escalationTitle(request, "Additional network authority", "network access") };
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  return (request.toolCall.locations ?? []).length > 0
    ? { allowOptionId: "allow-once", title: escalationTitle(request, "Command outside normal session authority", tool) }
    : null;
}

function codexEscalation(request: RequestPermissionRequest, context: PermissionContext): Escalation | null {
  const input = plainRecord(request.toolCall.rawInput) ?? {};
  if (codexProfileRequest(request, input)) {
    return { allowOptionId: "allow_permissions_turn", valid: codexProfileValid(request, "other", input.permissions),
      title: "Grant additional Codex filesystem/network authority for this turn?" };
  }
  if ("additionalPermissions" in input) {
    return { allowOptionId: "allow_once", valid: codexProfileValid(request, "execute", input.additionalPermissions),
      title: escalationTitle(request, "Additional command authority", "Codex command") };
  }
  if (codexNetworkRequest(request, input)) return { allowOptionId: "allow_once", valid: request.toolCall.kind === "execute", title: escalationTitle(request, "Additional network authority", "Codex network access") };
  if (request.toolCall.kind !== "execute") return null;
  return outsideCommandAuthority(request, context)
    ? { allowOptionId: "allow_once", title: escalationTitle(request, "Command outside normal session authority", "Codex command") }
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
  return `${prefix}: ${request.toolCall.title ?? fallback}`;
}
