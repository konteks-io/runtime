import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { ConnectedAgentViewSchema, type AvailableCommand, type ConnectedAgentCredential, type ConnectedAgentView } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { AgentScopeState } from "./auth/scope-store.js";
import { hostAgentRunnerAdapter } from "./host/registry.js";

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
  // Every gated OpenCode tool asks through the locked Konteks config (CP2/CP4).
  opencode: "approve",
  // Every Antigravity tool that is not a read asks by default; mode stays
  // `default` and its permission requests reach the Konteks policy (CP4).
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
  /** The slash commands this agent announced on this computer and when (runtime-view R19). */
  availableCommands?: { readonly commands: readonly AvailableCommand[]; readonly learntAt: string };
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
    // A host agent may send no billing usage with a turn (DeepSeek Harness:
    // its usage_update is context occupancy, dsh-runtime-support D4).
    tokenUsageObservable: inputs.tokenUsageObservable ?? hostAgentRunnerAdapter(inputs.family.agentId)?.tokenUsageObservable ?? true,
    acpCapabilities: {
      sessionResume: caps?.loadSession === true || caps?.sessionCapabilities?.resume != null,
      forkSession: caps?.sessionCapabilities?.fork != null,
      structuredOutputShim: true,
      toolControl: TOOL_CONTROL[inputs.family.agentId],
    },
  };
  if (inputs.family.hostInstall !== undefined && inputs.hostAgentVersion) view.hostAgentVersion = inputs.hostAgentVersion;
  if (inputs.credentials !== undefined) view.credentials = inputs.credentials.map(credential => ({ ...credential }));
  if (inputs.scope.authIdentityFingerprint !== null) view.authIdentityFingerprint = inputs.scope.authIdentityFingerprint;
  if (inputs.scope.scopeAttestedAt !== null) view.scopeAttestedAt = inputs.scope.scopeAttestedAt;
  if (inputs.lastProbeAt !== null) view.lastProbeAt = inputs.lastProbeAt;
  if (inputs.availableCommands !== undefined) {
    view.availableCommands = inputs.availableCommands.commands.map(command => ({ ...command }));
    view.availableCommandsLearntAt = inputs.availableCommands.learntAt;
  }
  const recovery = deriveRecoveryAction(inputs, readiness);
  if (recovery) view.recoveryAction = recovery;
  return ConnectedAgentViewSchema.parse(view);
}

function deriveReadiness(inputs: ReadinessInputs): ConnectedAgentView["readiness"] {
  if (!inputs.bridgeVersionCompatible) return "reconnect_required";
  if (inputs.connectionState !== "ready") return inputs.connectionState === "starting" ? "unavailable" : "unavailable";
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
