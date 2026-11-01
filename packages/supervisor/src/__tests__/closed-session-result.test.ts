import { describe, expect, it } from "vitest";
import { jcsDigest } from "@konteks/remote-common";
import type { AgentFailureReason } from "../session/relayed-session.js";
import { closedSessionResult } from "../work/orchestrator.js";

const exited = (failure: AgentFailureReason | null) => ({
  agentFailureReason: () => failure, deliveryAcceptanceReceipt: () => undefined, acpSessionRef: "acp",
});

describe("a closed session whose route cannot serve the turn", () => {
  it("reports route_unavailable only to a Core that accepts it, provider_failure to an older one", () => {
    expect(closedSessionResult(exited("route_unavailable"), "agent_exited", "7.15")).toEqual({ class: "failed", reason: "route_unavailable",
      terminalResultHash: jcsDigest({ class: "failed", reason: "route_unavailable" }) });
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
