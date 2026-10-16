import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { CoordinationAgentToolNames, NativeCoordinationInvocationSchema, RemoteInstanceError, coordinationPayloadHash, plainRecord, type NativeCoordinationInvocation } from "@konteks/remote-common";
import type { SupervisorJournal } from "../state/journal.js";
import { coordinationInvocationKey } from "../state/coordination-invocation.js";
import { permissionToolIdentity, type McpToolCallLedger } from "../session/permission-tool-identity.js";
import type { PermissionToolIdentity } from "../session/permission-tool-identity.js";

type InvocationContext = Omit<NativeCoordinationInvocation, "version" | "toolCallId" | "tool" | "payloadHash">;
const MAX_RETAINED_CALLS = 8_000;
const CAPTURE_AGENTS = new Set(["claude-code", "codex"]);
const TOOLS: ReadonlySet<string> = new Set(CoordinationAgentToolNames);

export function coordinationInvocationAgent(agentId: string): boolean { return CAPTURE_AGENTS.has(agentId); }
export function coordinationInvocationTool(tool: string): boolean { return TOOLS.has(tool); }
function unavailable(): RemoteInstanceError { return new RemoteInstanceError("operation_conflict", "A unique captured native coordination invocation is required."); }
function capturedTool(identity: PermissionToolIdentity, servers: ReadonlySet<string>): identity is Extract<PermissionToolIdentity, { kind: "mcp" }> {
  return identity.kind === "mcp" && servers.has(identity.server) && coordinationInvocationTool(identity.tool);
}

/** Captures the provider's stable call before allow_once; HTTP never creates identity. */
export class NativeCoordinationInvocations {
  constructor(private readonly journal: SupervisorJournal, private readonly context: () => InvocationContext | null, private readonly now: () => Date = () => new Date()) {}

  async capture(request: RequestPermissionRequest, agentId: string, servers: ReadonlySet<string>, ledger?: McpToolCallLedger): Promise<void> {
    if (!coordinationInvocationAgent(agentId)) return;
    const identity = permissionToolIdentity(request, agentId, { sessionServers: servers, ...(ledger ? { ledger } : {}) });
    if (!capturedTool(identity, servers)) return;
    const context = this.context();
    if (!context || context.acpSessionRef !== request.sessionId) throw unavailable();
    const args = agentId === "codex" ? ledger?.arguments(request.toolCall.toolCallId) : request.toolCall.rawInput;
    const invocation = NativeCoordinationInvocationSchema.parse({ version: 1, ...context, toolCallId: request.toolCall.toolCallId, tool: identity.tool, payloadHash: await coordinationPayloadHash(args) });
    await this.retain(invocation);
  }

  private async retain(invocation: NativeCoordinationInvocation): Promise<void> {
    const key = coordinationInvocationKey(invocation);
    await this.journal.coordinationInvocations.update(key, current => {
      this.assertCurrent(invocation);
      if (current && (current.payloadHash !== invocation.payloadHash || current.tool !== invocation.tool)) throw unavailable();
      if (!current && this.journal.coordinationInvocations.all().length >= MAX_RETAINED_CALLS) throw unavailable();
      return current ?? { ...invocation, state: "captured", capturedAt: this.now().toISOString() };
    });
  }

  private assertCurrent(invocation: NativeCoordinationInvocation): void {
    const context = this.context();
    if (!context || coordinationInvocationKey({ ...context, toolCallId: invocation.toolCallId }) !== coordinationInvocationKey(invocation)) throw unavailable();
  }

  async resolve(tool: string, args: unknown): Promise<NativeCoordinationInvocation> {
    const context = this.context();
    if (!context) throw unavailable();
    const payloadHash = await coordinationPayloadHash(args);
    const matches = this.journal.coordinationInvocations.all().filter(record => record.state === "captured" && record.tool === tool && record.payloadHash === payloadHash &&
      coordinationInvocationKey({ ...context, toolCallId: record.toolCallId }) === coordinationInvocationKey(record));
    if (matches.length !== 1) throw unavailable();
    const { state: _state, capturedAt: _captured, ...invocation } = matches[0]!;
    this.assertCurrent(invocation);
    return NativeCoordinationInvocationSchema.parse(invocation);
  }

  /** Terminal ACP updates retire matching admission; a later identical call needs its own capture. */
  async observe(update: unknown): Promise<void> {
    const value = plainRecord(update);
    if (value?.sessionUpdate !== "tool_call_update" || !["completed", "failed"].includes(String(value.status))) return;
    const context = this.context();
    if (!context || typeof value.toolCallId !== "string") return;
    const key = coordinationInvocationKey({ ...context, toolCallId: value.toolCallId });
    if (!this.journal.coordinationInvocations.get(key)) return;
    await this.journal.coordinationInvocations.update(key, current => {
      if (!current) throw unavailable();
      return { ...current, state: "completed" };
    });
  }
}
