import { describe, expect, it } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { dispatchFailureOutcome } from "../work/dispatch-failure-outcome.js";

describe("repository policy dispatch failure", () => {
  const policy = () => new RemoteInstanceError("capability_unavailable", "guard refused", { diagnostic: "workspace_policy_invalid" });
  it("reports the exact permanent reason only to a Core that accepts it", () => {
    expect(dispatchFailureOutcome(policy(), "7.13")).toEqual({ class: "failed", reason: "workspace_policy_invalid" });
    for (const version of [undefined, "7.12", "invalid"]) {
      expect(dispatchFailureOutcome(policy(), version)).toEqual({ class: "failed", reason: "internal" });
    }
  });
  it("does not infer a policy failure from error text or an unrelated diagnostic", () => {
    expect(dispatchFailureOutcome(new Error("workspace_policy_invalid"), "7.13")).toEqual({ class: "failed", reason: "internal" });
    expect(dispatchFailureOutcome(new RemoteInstanceError("capability_unavailable", "workspace_policy_invalid"), "7.13")).toEqual({ class: "failed", reason: "internal" });
  });
  it("retains ownership and authentication failure outcomes", () => {
    expect(dispatchFailureOutcome(new RemoteInstanceError("recovery_required", "lost"), "7.13")).toEqual({ class: "interrupted", reason: "not_resumable" });
    expect(dispatchFailureOutcome(new RemoteInstanceError("agent_auth_required", "login"), "7.13")).toEqual({ class: "failed", reason: "agent_auth_required" });
  });
});

describe("unoffered model dispatch failure (10-31)", () => {
  const unoffered = () => new RemoteInstanceError("agent_unavailable", "not offered", { diagnostic: "model_unavailable" });
  it("names the unoffered model only to a Core that accepts the reason", () => {
    expect(dispatchFailureOutcome(unoffered(), "7.14")).toEqual({ class: "failed", reason: "model_unavailable" });
    for (const version of [undefined, "7.13", "invalid"]) {
      expect(dispatchFailureOutcome(unoffered(), version)).toEqual({ class: "failed", reason: "internal" });
    }
  });
  it("keeps an unconfirmed configuration without that verdict as internal", () => {
    expect(dispatchFailureOutcome(new RemoteInstanceError("agent_unavailable", "not confirmed"), "7.14")).toEqual({ class: "failed", reason: "internal" });
  });
});
