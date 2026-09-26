import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { ConnectedAgentViewSchema, type ConnectedAgentView } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { AgentScopeState } from "./auth/scope-store.js";

/**
 * The sanitized `ConnectedAgentView` this runner publishes. It is computed
 * from the ACP `initialize` result plus connection state — never from a parsed
 * credential file — and carries no account, email, path, token, or raw probe
 * output. Tool control per bridge comes from the CP0 matrix.
 */
const TOOL_CONTROL: Record<AgentBridgeFamily["agentId"], ConnectedAgentView["acpCapabilities"]["toolControl"]> = {
  "claude-code": "approve",
  codex: "approve",
  // Every non-read-only dsh tool asks through the Konteks hook (dsh-profile.ts).
  dsh: "approve",
};

export interface ReadinessInputs {
  family: AgentBridgeFamily;
  authMode: ConnectedAgentView["authMode"];
  connectionState: ConnectedAgentView["connectionState"];
  initializeResult: InitializeResponse | null;
  scope: AgentScopeState;
  identity: "signal" | "logged_out" | "no_official_signal" | "unknown";
  bridgeVersionCompatible: boolean;
  lastProbeAt: string | null;
}

export function projectReadiness(inputs: ReadinessInputs): ConnectedAgentView {
  const caps = inputs.initializeResult?.agentCapabilities;
  const readiness = deriveReadiness(inputs);
  const view: ConnectedAgentView = {
    agentId: inputs.family.agentId,
    displayName: inputs.family.displayName,
    connectionState: inputs.connectionState,
    authMode: inputs.authMode,
    accountScope: inputs.scope.accountScope,
    readiness,
    moneyObservable: inputs.authMode === "gateway_keyed",
    // DeepSeek Harness returns no usage with a turn; its usage_update is
    // context occupancy, not billing tokens (dsh-runtime-support D4).
    tokenUsageObservable: inputs.family.agentId !== "dsh",
    acpCapabilities: {
      sessionResume: caps?.loadSession === true || caps?.sessionCapabilities?.resume != null,
      forkSession: caps?.sessionCapabilities?.fork != null,
      structuredOutputShim: true,
      toolControl: TOOL_CONTROL[inputs.family.agentId],
    },
  };
  if (inputs.scope.authIdentityFingerprint !== null) view.authIdentityFingerprint = inputs.scope.authIdentityFingerprint;
  if (inputs.scope.scopeAttestedAt !== null) view.scopeAttestedAt = inputs.scope.scopeAttestedAt;
  if (inputs.lastProbeAt !== null) view.lastProbeAt = inputs.lastProbeAt;
  const recovery = deriveRecoveryAction(inputs, readiness);
  if (recovery) view.recoveryAction = recovery;
  return ConnectedAgentViewSchema.parse(view);
}

function deriveReadiness(inputs: ReadinessInputs): ConnectedAgentView["readiness"] {
  if (!inputs.bridgeVersionCompatible) return "reconnect_required";
  if (inputs.connectionState !== "ready") return inputs.connectionState === "starting" ? "unavailable" : "unavailable";
  if (inputs.authMode === "gateway_keyed") return "ready";
  switch (inputs.identity) {
    case "signal":
      return "ready";
    case "logged_out":
      return "not_configured";
    case "no_official_signal":
      return inputs.scope.lastLoginAt !== null ? "ready" : "not_configured";
    default:
      return "unavailable";
  }
}

function deriveRecoveryAction(inputs: ReadinessInputs, readiness: ConnectedAgentView["readiness"]): ConnectedAgentView["recoveryAction"] | undefined {
  if (!inputs.bridgeVersionCompatible) return "update_agent_bridge";
  if (readiness === "not_configured" || readiness === "reconnect_required") return "login_locally";
  if (inputs.connectionState === "failed") return "update_agent_bridge";
  return undefined;
}
