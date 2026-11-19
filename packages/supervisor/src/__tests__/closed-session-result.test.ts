import { describe, expect, it } from "vitest";
import { jcsDigest, type CancelDirective } from "@konteks/remote-common";
import type { AgentFailureReason } from "../session/relayed-session.js";
import { closedSessionResult } from "../work/orchestrator.js";

const exited = (failure: AgentFailureReason | null) => ({
  agentFailureReason: () => failure, deliveryAcceptanceReceipt: () => undefined, acpSessionRef: "acp",
});

const cancelled = (reason: CancelDirective["reason"] | null) => ({
  agentFailureReason: () => null, cancelledReason: () => reason, deliveryAcceptanceReceipt: () => undefined, acpSessionRef: "acp",
});

describe("a closed session whose route cannot serve the turn", () => {
  it("reports route_unavailable for any cause only to a Core that accepts it, provider_failure to an older one", () => {
    // The terminal reason names no cause, so a provider_unavailable-triggered
    // close keeps the same 7.15 reason gate as the existing causes.
    for (const version of ["7.15", "7.16"]) {
      expect(closedSessionResult(exited("route_unavailable"), "agent_exited", version)).toEqual({ class: "failed", reason: "route_unavailable",
        terminalResultHash: jcsDigest({ class: "failed", reason: "route_unavailable" }) });
    }
    for (const version of [undefined, "7.14", "invalid"]) {
      expect(closedSessionResult(exited("route_unavailable"), "agent_exited", version)).toEqual({ class: "failed", reason: "provider_failure",
        terminalResultHash: jcsDigest({ class: "failed", reason: "provider_failure" }) });
    }
  });

  it("keeps the agent's other failures and a plain exit as they were", () => {
    expect(closedSessionResult(exited("provider_failure"), "agent_exited", "7.15")).toMatchObject({ class: "failed", reason: "provider_failure" });
    expect(closedSessionResult(exited("agent_auth_required"), "agent_exited", "7.14")).toMatchObject({ class: "failed", reason: "agent_auth_required" });
    expect(closedSessionResult(exited(null), "agent_exited", "7.15")).toMatchObject({ class: "failed", reason: "agent_failed" });
  });
});

describe("a cancelled session whose stop named its cause", () => {
  it("reports that reason, and user_cancelled only when the close named none", () => {
    // The reason stays outside the hashed value, so retry and reassignment,
    // which compare terminalResultHash, cannot observe this change.
    for (const reason of ["superseded", "policy_denied"] as const) {
      expect(closedSessionResult(cancelled(reason), "cancelled")).toEqual({ class: "cancelled", reason,
        terminalResultHash: jcsDigest({ class: "cancelled" }) });
    }
    expect(closedSessionResult(cancelled(null), "cancelled")).toEqual({ class: "cancelled", reason: "user_cancelled",
      terminalResultHash: jcsDigest({ class: "cancelled" }) });
  });
});
