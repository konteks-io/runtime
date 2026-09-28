import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { DshToolGovernance } from "./dsh-tool-governance.js";
import { OpenCodeToolGovernance } from "./opencode-tool-governance.js";

/**
 * Tool governance for an agent used from the person's own installation
 * (DeepSeek Harness, OpenCode): the agent's permission requests do not carry
 * what the runtime policy needs, or the agent can be steered around them, so
 * each request is rebuilt from the tool call it names (or refused) before the
 * unchanged `EvaluatorPolicyResponder` + `createWorkspaceToolPolicy()` judge
 * it, and every finished call is checked for one that ran without Konteks'
 * approval (the tripwire: `RelayedSession` then cancels the turn and
 * quarantines the agent on this connector).
 */
export type HostPermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "evaluate"; request: RequestPermissionRequest };

export interface HostPermissionContext {
  /** The session's working copy. */
  cwd: string;
  /** The session's own MCP servers (Code Mode namespaces an OpenCode block may call). */
  servers: ReadonlySet<string>;
  /** The session was given the QA browser. */
  browserTools?: boolean;
}

/** A gated call that ran without Konteks' approval. */
export interface HostToolBypass { toolCallId: string; title: string }

export interface HostToolGovernance {
  /** The agent's name in logs and the quarantine line. */
  readonly agentName: string;
  readonly bypassDiagnostic: string;
  /** The plain line the person sees when the agent is taken out of service. */
  readonly quarantineMessage: string;
  /** Record a session update; returns the call that ran without approval, if any. */
  observe(update: unknown, cwd: string): HostToolBypass | null;
  decide(request: RequestPermissionRequest, context: HostPermissionContext): HostPermissionDecision;
}

/** The governance a host agent's session runs under; null for Claude Code and Codex (their requests carry what policy needs). */
export function hostToolGovernance(agentId: string): HostToolGovernance | null {
  if (agentId === "opencode") return new OpenCodeToolGovernance();
  if (agentId !== "dsh") return null;
  const dsh = new DshToolGovernance();
  return {
    agentName: "DeepSeek Harness",
    bypassDiagnostic: "dsh_tool_governance_bypassed",
    quarantineMessage: "DeepSeek Harness ran a tool without asking Konteks first. Update or reinstall DeepSeek Harness, then restart the connector.",
    observe: update => dsh.observe(update),
    decide: (request, context) => dsh.decide(request, context.cwd),
  };
}
