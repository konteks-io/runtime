import type { ConnectedAgentView, RuntimeRole, RuntimeUtilization } from "@konteks/remote-common";

/**
 * Role advertisement is computed from `roleBindings` and READY agents' ACP
 * capabilities (D100/D101): a role appears only when at least one agent in
 * its preference list is ready and capable of the work kind that role maps
 * to. Core strips anything it disagrees with; the supervisor never claims a
 * role it cannot serve.
 */
export interface RoleBinding {
  role: RuntimeRole;
  agentPreference: string[];
}

export interface RoleCapabilityInputs {
  browserToolAvailable: boolean;
  /**
   * The git version this machine reports, or `null` when git is not on PATH.
   * The `onboard` role reads repositories and moves bytes with the machine's
   * own git (onboarding-mode OB6 §1), so without it the runtime advertises
   * neither onboard capability and Core reports it ineligible for both kinds.
   */
  gitVersion?: string | null;
}

export function agentSatisfiesRole(agent: ConnectedAgentView, role: RuntimeRole, inputs: RoleCapabilityInputs): boolean {
  if (agent.readiness !== "ready" || agent.connectionState !== "ready") return false;
  switch (role) {
    case "planner":
      return true;
    case "generator":
      return true;
    case "assistant":
      return true;
    case "qa":
      // Code validation and adversarial review require only the ready ACP
      // agent. Preview/UI assignments carry their browser requirement as a
      // per-work capability and are rejected at placement when unavailable.
      return true;
    case "ops":
      // The shared vocabulary is not proof of an installed operations carrier.
      return false;
    case "onboard":
      // Evidence collection and relocation are git work. A ready agent alone
      // is not enough, and an absent probe is not a licence to claim it.
      return typeof inputs.gitVersion === "string" && inputs.gitVersion.length > 0;
  }
}

/**
 * What an `onboard` runtime advertises when git is present (OB6 §1). Both
 * capabilities go together: one machine's git either reads repositories and
 * pushes mirrors or it does neither, and Core places both work kinds on the
 * same role. The git version rides along as its own advertised string so an
 * eligibility refusal can say what was actually found.
 */
export const ONBOARD_EVIDENCE_CAPABILITY = "onboard.evidence";
export const ONBOARD_RELOCATION_CAPABILITY = "onboard.relocation";

export function onboardCapabilities(gitVersion: string | null | undefined): string[] {
  if (typeof gitVersion !== "string" || gitVersion.length === 0) return [];
  return [ONBOARD_EVIDENCE_CAPABILITY, ONBOARD_RELOCATION_CAPABILITY, `git:${gitVersion}`];
}

export function deriveAdvertisedRoles(bindings: readonly RoleBinding[], agents: readonly ConnectedAgentView[], inputs: RoleCapabilityInputs): RuntimeRole[] {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const roles: RuntimeRole[] = [];
  for (const binding of bindings) {
    const capable = binding.agentPreference.some((agentId) => {
      const agent = byId.get(agentId);
      return agent !== undefined && agentSatisfiesRole(agent, binding.role, inputs);
    });
    if (capable && !roles.includes(binding.role)) roles.push(binding.role);
  }
  return roles;
}

/** The Core-placed agent must be ready at claim; the supervisor never substitutes (D100). */
export function placedAgentReady(agents: readonly ConnectedAgentView[], agentId: string, role: RuntimeRole, inputs: RoleCapabilityInputs): boolean {
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  return agent !== undefined && agentSatisfiesRole(agent, role, inputs);
}

export interface UtilizationInputs {
  hostPressure: number; // 0..1 from sysmon
  activeSessions: number;
  activeTurns: number;
  softMaxConcurrent?: number;
  acceptingWork: boolean;
}

/**
 * Self-reported utilization for D74/D153 ranking. Active execution against the
 * soft ceiling dominates when a ceiling is set; idle continuation/replay
 * sessions never consume a turn slot. Host pressure remains the other signal.
 *
 * CAPACITY IS SLOTS, NOT HOST PRESSURE. A busy host ranks last, but only its
 * own turn ceiling can make a runtime ineligible: a host metric that saturates
 * on an ordinary machine (macOS reports almost no wholly free memory even when
 * healthy) would otherwise refuse every assignment forever, which is what
 * `all_runtimes_saturated` looked like in practice. This mirrors bb, which
 * limits concurrency by counting running work rather than sampling resources.
 */
export function computeUtilization(inputs: UtilizationInputs): RuntimeUtilization {
  const turnRatio = inputs.softMaxConcurrent !== undefined && inputs.softMaxConcurrent > 0 ? Math.min(1, inputs.activeTurns / inputs.softMaxConcurrent) : 0;
  const ratio = Math.max(0, Math.min(1, Math.max(turnRatio, inputs.hostPressure)));
  const utilization: RuntimeUtilization = {
    acceptingWork: inputs.acceptingWork && turnRatio < 1,
    activeSessions: inputs.activeSessions,
    activeTurns: inputs.activeTurns,
    // Preserve the admission boundary exactly. Rounding 0.9995+ to 1.000
    // contradicts acceptingWork and makes Core reject a runtime that still
    // reports headroom. Presentation layers may round this advisory value.
    utilizationRatio: ratio,
  };
  if (inputs.softMaxConcurrent !== undefined) utilization.softMaxConcurrent = inputs.softMaxConcurrent;
  return utilization;
}
