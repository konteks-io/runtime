import { describe, expect, it } from "vitest";
import { deliveryOutputFailure } from "../native/delivery-output-failure.js";
import { LoggedRefusal, NamedRefusal } from "../native/named-refusal.js";
import { checkpointCause } from "../native/workspace-checkpoint-failure.js";

/**
 * A log-only name must never change what Core receives: the same refusal,
 * unnamed, reported its bare code, no cause and runtime_condition evidence.
 */
describe("log-only refusal names", () => {
  const logged = () => new LoggedRefusal("capability_unavailable", "Durable generated output state is unavailable.",
    "output_head_missing", { gitStep: "reset_hard", exitCode: 128 });

  it("leaves a delivery-output failure report exactly as the unnamed refusal's", () => {
    expect(deliveryOutputFailure(logged())).toEqual(
      deliveryOutputFailure(new LoggedRefusal("capability_unavailable", "Durable generated output state is unavailable.", "other_name")));
    expect(deliveryOutputFailure(logged())).toMatchObject({
      code: "capability_unavailable", evidence: { kind: "runtime_condition" }, stage: "delivery_output_transfer" });
  });

  it("names no checkpoint cause", () => {
    expect(checkpointCause(logged())).toBeUndefined();
  });

  it("keeps a reported name for refusals that were already named", () => {
    const named = new NamedRefusal("capability_unavailable", "Capture refused.", "workspace_capture_file_hardlinked");
    expect(deliveryOutputFailure(named).code).toBe("workspace_capture_file_hardlinked");
    expect(checkpointCause(named)).toBe("workspace_capture_file_hardlinked");
  });
});
