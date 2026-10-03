import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { ConnectedAgentViewSchema, type AvailableCommand, type ConnectedAgentCredential, type ConnectedAgentView } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { AgentScopeState } from "./auth/scope-store.js";
import { hostAgentRunnerAdapter } from "./host/registry.js";

/**
 * The sanitized `ConnectedAgentView` this runner publishes. It is computed
 * from the ACP `initialize` result plus connection state — never from a parsed
 * credential file — and carries no account, email, path, token, or raw probe
 * output. Tool control per bridge is fixed per agent.
 */
const TOOL_CONTROL: Record<AgentBridgeFamily["agentId"], ConnectedAgentView["acpCapabilities"]["toolControl"]> = {
  "claude-code": "approve",
  codex: "approve",
  // Every non-read-only dsh tool asks through the Konteks hook (dsh-profile.ts).
  dsh: "approve",
  // Every gated OpenCode tool asks through the locked Konteks config.
  opencode: "approve",
  // Every Antigravity tool that is not a read asks by default; mode stays
  // `default` and its permission requests reach the Konteks policy.
  antigravity: "approve",
};

interface ReadinessInputs {
  family: AgentBridgeFamily;
  authMode: ConnectedAgentView["authMode"];
  connectionState: ConnectedAgentView["connectionState"];
  initializeResult: InitializeResponse | null;
  scope: AgentScopeState;
  identity: "signal" | "logged_out" | "no_official_signal" | "unknown";
  /** What an agent with several sign-ins holds (OpenCode's `auth list`): provider, kind, billing, state; never a secret. */
  credentials?: readonly ConnectedAgentCredential[];
  bridgeVersionCompatible: boolean;
  /** The verified installed version of a host-installed agent; never an ACP bridge version. */
  hostAgentVersion?: string;
  /** Whether turns report billing usage under the current sign-in, when the agent says (Antigravity: only on its key relay). */
  tokenUsageObservable?: boolean;
  /** Signed in, but the provider's admin keeps Konteks tools out (Antigravity with MCP Servers off): no Konteks work can run on it. */
  providerAdminBlocked?: boolean;
  /** The slash commands this agent announced on this computer and when. */
  availableCommands?: { readonly commands: readonly AvailableCommand[]; readonly learntAt: string };
  lastProbeAt: string | null;
}

export function projectReadiness(inputs: ReadinessInputs): ConnectedAgentView {
  const readiness = deriveReadiness(inputs);
  const view: ConnectedAgentView = {
    agentId: inputs.family.agentId,
    displayName: inputs.family.displayName,
    connectionState: inputs.connectionState,
    authMode: inputs.authMode,
    accountScope: inputs.scope.accountScope,
    readiness,
    tokenUsageObservable: tokenUsageObservable(inputs),
    acpCapabilities: acpCapabilities(inputs.initializeResult, inputs.family.agentId),
    ...optionalViewFields(inputs),
  };
  const recovery = deriveRecoveryAction(inputs, readiness);
  if (recovery) view.recoveryAction = recovery;
  return ConnectedAgentViewSchema.parse(view);
}

/**
 * A host agent may send no billing usage with a turn (DeepSeek Harness: its
 * usage_update is context occupancy); the sign-in in use may say otherwise.
 */
function tokenUsageObservable(inputs: ReadinessInputs): boolean {
  return inputs.tokenUsageObservable ?? hostAgentRunnerAdapter(inputs.family.agentId)?.tokenUsageObservable ?? true;
}

function acpCapabilities(initializeResult: InitializeResponse | null, agentId: AgentBridgeFamily["agentId"]): ConnectedAgentView["acpCapabilities"] {
  const caps = initializeResult?.agentCapabilities;
  return {
    sessionResume: caps?.loadSession === true || caps?.sessionCapabilities?.resume != null,
    forkSession: caps?.sessionCapabilities?.fork != null,
    structuredOutputShim: true,
    toolControl: TOOL_CONTROL[agentId],
  };
}

function optionalViewFields(inputs: ReadinessInputs): Partial<ConnectedAgentView> {
  return {
    ...(inputs.family.hostInstall !== undefined && inputs.hostAgentVersion ? { hostAgentVersion: inputs.hostAgentVersion } : {}),
    ...(inputs.credentials !== undefined ? { credentials: inputs.credentials.map(credential => ({ ...credential })) } : {}),
    ...(inputs.scope.authIdentityFingerprint !== null ? { authIdentityFingerprint: inputs.scope.authIdentityFingerprint } : {}),
    ...(inputs.scope.scopeAttestedAt !== null ? { scopeAttestedAt: inputs.scope.scopeAttestedAt } : {}),
    ...(inputs.lastProbeAt !== null ? { lastProbeAt: inputs.lastProbeAt } : {}),
    ...(inputs.availableCommands !== undefined ? {
      availableCommands: inputs.availableCommands.commands.map(command => ({ ...command })),
      availableCommandsLearntAt: inputs.availableCommands.learntAt,
    } : {}),
  };
}

function deriveReadiness(inputs: ReadinessInputs): ConnectedAgentView["readiness"] {
  if (!inputs.bridgeVersionCompatible) return "reconnect_required";
  if (inputs.connectionState !== "ready") return "unavailable";
  switch (inputs.identity) {
    case "signal":
      return inputs.providerAdminBlocked ? "unavailable" : "ready";
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
  if (readiness === "unavailable" && inputs.providerAdminBlocked) return "contact_provider_admin";
  return undefined;
}
