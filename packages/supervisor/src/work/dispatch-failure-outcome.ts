import { RemoteInstanceError, coreContractAtLeast, REMOTE_MODEL_UNAVAILABLE_MIN_CORE_CONTRACT_VERSION, REMOTE_WORKSPACE_POLICY_INVALID_MIN_CORE_CONTRACT_VERSION } from "@konteks/remote-common";
import { transientInputFailure } from "../native/input-client.js";

/** An ownership refusal interrupts the attempt; anything else is a failed dispatch (agent sign-in named as such). */
export function dispatchFailureOutcome(error: unknown, coreContractVersion?: string): { class: "interrupted"; reason: "agent_session_lost" | "not_resumable" | "lease_lost" } | { class: "failed"; reason: "agent_auth_required" | "internal" | "workspace_policy_invalid" | "model_unavailable" } {
  if (error instanceof RemoteInstanceError && error.code === "recovery_required") {
    return { class: "interrupted", reason: error.diagnostic === "agent_session_lost" ? "agent_session_lost" : "not_resumable" };
  }
  if (isWorkspacePolicyFailure(error) &&
      coreContractAtLeast(coreContractVersion, REMOTE_WORKSPACE_POLICY_INVALID_MIN_CORE_CONTRACT_VERSION)) {
    return { class: "failed", reason: "workspace_policy_invalid" };
  }
  // A transient Core failure is never the agent's: Core issues a successor (D132).
  if (transientInputFailure(error)) return { class: "interrupted", reason: "lease_lost" };
  return { class: "failed", reason: remainingFailureReason(error, coreContractVersion) };
}

/** The agent's own selector does not offer the turn's model (a typed verdict, never a message). */
export function isModelUnavailable(error: unknown): boolean {
  return error instanceof RemoteInstanceError && error.code === "agent_unavailable" && error.diagnostic === "model_unavailable";
}


/** Only a typed guard verdict identifies a policy failure; free-form messages never do. */
export function isWorkspacePolicyFailure(error: unknown): boolean {
  return error instanceof RemoteInstanceError && error.code === "capability_unavailable" && error.diagnostic === "workspace_policy_invalid";
}

/** An older Core's closed enum knows no `model_unavailable`, so it gets `internal`. */
function remainingFailureReason(error: unknown, coreContractVersion?: string): "agent_auth_required" | "internal" | "model_unavailable" {
  if (error instanceof RemoteInstanceError && error.code === "agent_auth_required") return "agent_auth_required";
  return isModelUnavailable(error) && coreContractAtLeast(coreContractVersion, REMOTE_MODEL_UNAVAILABLE_MIN_CORE_CONTRACT_VERSION)
    ? "model_unavailable" : "internal";
}
