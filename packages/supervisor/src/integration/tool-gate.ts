import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  INTEGRATION_TASK_LIMITS,
  argsDigest,
  canonicalArgs,
  checkIntegrationToolCall,
  type IntegrationTaskSpec,
  type IntegrationToolCallRecord,
} from "@konteks/backstage-plugin-common";
import { RemoteInstanceError } from "@konteks/remote-common";
import { STRUCTURED_RESULT_MCP_SERVER_NAME, STRUCTURED_RESULT_TOOL_NAME } from "../structured-result/result-tool-server.js";
import { permissionToolIdentity, type McpToolCallLedger, type PermissionToolIdentity } from "../session/permission-tool-identity.js";
import type { IntegrationWriteRecord, SupervisorJournal } from "../state/journal.js";

/**
 * Durable one-use write grants, keyed by the spec's nonce. `consume` records
 * the grant for one tool call id, or refuses when the nonce already belongs to
 * another call (a repeated callback for the SAME call is the same grant).
 */
export interface IntegrationWriteLedger {
  consume(record: IntegrationWriteRecord): Promise<"consumed" | "same_call" | "consumed_elsewhere">;
}

/** The supervisor journal's `integration-writes` table as the gate's write ledger. */
export function journalWriteLedger(journal: SupervisorJournal): IntegrationWriteLedger {
  return {
    async consume(record) {
      let verdict: "consumed" | "same_call" | "consumed_elsewhere" = "consumed";
      await journal.integrationWrites.update(record.nonce, current => {
        if (current === undefined) return record;
        verdict = current.toolCallId === record.toolCallId && current.argsDigest === record.argsDigest ? "same_call" : "consumed_elsewhere";
        return current;
      });
      return verdict;
    },
  };
}

export type IntegrationDenyReason =
  | "not_admitted"
  | "args_mismatch"
  | "required_args_mismatch"
  | "non_canonical_args"
  | "missing_args"
  | "limit"
  | "nonce_consumed"
  | "no_allow_once";

export type IntegrationGateDecision =
  | { kind: "allow"; optionId: string }
  | { kind: "deny"; optionId: string | null; reason: IntegrationDenyReason };

export interface IntegrationToolGateDeps {
  agentId: string;
  /** The MCP servers this integration session gave its agent (the result tool, an E2E fixture). */
  sessionServers: ReadonlySet<string>;
  /** Codex's announced MCP calls: an approval names only the call id. */
  ledger: McpToolCallLedger;
  writes: IntegrationWriteLedger;
  now: () => string;
}

/** An allowed provider call, by the ACP tool call id the gate allowed it under. */
export interface AllowedIntegrationCall {
  server: string;
  tool: string;
  argsDigest: string;
  mode: "read" | "write";
}

const SERVER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOOL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const token = (value: string, pattern: RegExp, fallback: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._/-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 128);
  return pattern.test(cleaned) ? cleaned : fallback;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeDigest(args: unknown): string {
  try { return argsDigest(args); } catch { return argsDigest(null); }
}

/**
 * The integration sub-assignment's permission gate (capabilities-and-execution
 * "Required integration assignment policy", DESIGN §2). It is the WHOLE policy
 * of an integration session, not a layer over the general one:
 *
 * - the tool is read only from structured fields (Stage 0 S0-4); a title can
 *   never grant;
 * - only the spec's admitted tools pass, by server and tool identity
 *   (`checkIntegrationToolCall`), and only up to `limits.maxToolCalls`; a
 *   read with fixed arguments (`requiredArgs`, e.g. the generic
 *   `executeRead` with its operation `name` pinned) passes only when each one
 *   is present and equal, and `executeWrite`/`executeDestructive` never pass;
 * - a write passes only with arguments whose canonical digest equals the
 *   approved one, once per nonce, recorded durably BEFORE the answer;
 * - shell, edit, browser, every other server and every other tool are denied
 *   at once, never deferred to a person;
 * - every allow is `allow_once`; a request without that option is denied;
 * - the `konteks-result` tool (the agent's report, no provider authority) is
 *   the one platform channel allowed.
 */
export class IntegrationToolGate {
  private readonly allowed = new Map<string, AllowedIntegrationCall>();
  private readonly calls = new Map<string, IntegrationToolCallRecord>();
  /** Every tool call id the agent asked about, whatever the answer. */
  private readonly judged = new Set<string>();
  private allowedCount = 0;

  constructor(private readonly spec: IntegrationTaskSpec, private readonly deps: IntegrationToolGateDeps) {
    if (spec.phase === "discover") throw new RemoteInstanceError("schema_invalid", "Discovery admits no tools.");
  }

  async evaluate(request: RequestPermissionRequest): Promise<IntegrationGateDecision> {
    const allowOnce = request.options.find(option => option.kind === "allow_once")?.optionId ?? null;
    const reject = request.options.find(option => option.kind === "reject_once")?.optionId ?? null;
    const toolCallId = request.toolCall.toolCallId;
    this.judged.add(toolCallId);
    const identity = permissionToolIdentity(request, this.deps.agentId, { sessionServers: this.deps.sessionServers, ledger: this.deps.ledger });
    const deny = (reason: IntegrationDenyReason, call?: { server: string; tool: string; args: unknown }): IntegrationGateDecision => {
      this.note(toolCallId, identity, call, "denied");
      return { kind: "deny", optionId: reject, reason };
    };
    if (identity.kind !== "mcp") return deny("not_admitted");
    if (identity.server === STRUCTURED_RESULT_MCP_SERVER_NAME) {
      if (identity.tool !== STRUCTURED_RESULT_TOOL_NAME || allowOnce === null) return deny("not_admitted");
      return { kind: "allow", optionId: allowOnce };
    }
    const args = this.deps.agentId === "codex" ? this.deps.ledger.arguments(toolCallId) : record(request.toolCall)?.rawInput;
    const call = { server: identity.server, tool: identity.tool, args };
    const repeated = this.allowed.get(toolCallId);
    if (repeated) {
      // A repeated callback for an allowed call is the same grant, never a
      // second one, and only for the exact same identity and arguments.
      if (repeated.server !== call.server || repeated.tool !== call.tool || safeDigest(args) !== repeated.argsDigest) return deny("args_mismatch", call);
      return allowOnce === null ? deny("no_allow_once", call) : { kind: "allow", optionId: allowOnce };
    }
    if (args === undefined) return deny("missing_args", call);
    try {
      if (Buffer.byteLength(canonicalArgs(args), "utf8") > INTEGRATION_TASK_LIMITS.maxCanonicalArgsBytes) return deny("non_canonical_args", call);
    } catch {
      return deny("non_canonical_args", call);
    }
    const check = checkIntegrationToolCall(this.spec, call);
    if (!check.allowed) return deny(check.reason, call);
    if (allowOnce === null) return deny("no_allow_once", call);
    if (this.allowedCount >= this.spec.limits.maxToolCalls) return deny("limit", call);
    const mode = this.spec.admittedTools.find(tool => tool.server === call.server && tool.tool === call.tool)!.mode;
    if (mode === "write") {
      const write = this.spec.write!;
      const verdict = await this.deps.writes.consume({ nonce: write.nonce, taskId: this.spec.taskId, actionId: write.actionId, attemptId: write.attemptId,
        argsDigest: check.argsDigest, toolCallId, consumedAt: this.deps.now() });
      if (verdict === "consumed_elsewhere") return deny("nonce_consumed", call);
    }
    this.allowedCount += 1;
    this.allowed.set(toolCallId, { server: call.server, tool: call.tool, argsDigest: check.argsDigest, mode });
    this.note(toolCallId, identity, call, "allowed");
    return { kind: "allow", optionId: allowOnce };
  }

  /** The provider call the gate allowed under this ACP tool call id, if any. */
  allowedCall(toolCallId: string): AllowedIntegrationCall | undefined {
    return this.allowed.get(toolCallId);
  }

  /** Whether the agent asked the gate about this call at all (a call that ran without asking bypassed it). */
  wasJudged(toolCallId: string): boolean {
    return this.judged.has(toolCallId);
  }

  /** An allowed call reached its end: record what the connector observed. */
  settle(toolCallId: string, outcome: "succeeded" | "failed"): void {
    const current = this.calls.get(toolCallId);
    if (current && current.status === "allowed") this.calls.set(toolCallId, { ...current, outcome });
  }

  /** Every judged call (bounded), in the order they were first asked. */
  records(): IntegrationToolCallRecord[] {
    return [...this.calls.values()];
  }

  private note(toolCallId: string, identity: PermissionToolIdentity, call: { server: string; tool: string; args: unknown } | undefined, status: "allowed" | "denied"): void {
    if (this.calls.has(toolCallId) && status === "denied") return;
    if (!this.calls.has(toolCallId) && this.calls.size >= INTEGRATION_TASK_LIMITS.maxToolCalls) return;
    const server = call ? token(call.server, SERVER_TOKEN, "unknown")
      : identity.kind === "native" ? "native" : identity.kind === "mcp" ? token(identity.server, SERVER_TOKEN, "unknown") : "unidentified";
    const tool = call ? token(call.tool, TOOL_TOKEN, "unknown")
      : identity.kind === "native" ? token(identity.tool, TOOL_TOKEN, "unknown") : identity.kind === "mcp" ? token(identity.tool, TOOL_TOKEN, "unknown") : "unknown";
    this.calls.set(toolCallId, { server, tool, argsDigest: safeDigest(call?.args ?? null), status, outcome: status === "allowed" ? "unknown" : "not_run" });
  }
}
