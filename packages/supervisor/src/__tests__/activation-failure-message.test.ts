import { describe, expect, it } from "vitest";
import { activationFailureMessage } from "../provisioning/activation.js";

describe("a code the site gave that does not connect this computer", () => {
  it("says what happened and where a new code comes from, in plain words", () => {
    for (const code of ["activation_expired", "activation_consumed"]) {
      const said = activationFailureMessage(code);
      expect(said).toContain("Customize → Runtimes → Connect a runtime");
      expect(said).not.toContain("App or MCP");
    }
    expect(activationFailureMessage("activation_expired")).toMatch(/^This code has expired\./);
    expect(activationFailureMessage("activation_consumed")).toMatch(/^This code was already used\./);
    expect(activationFailureMessage("activation_invalid")).toMatch(/^That code was not accepted\./);
    expect(activationFailureMessage("limit_exceeded")).toContain("Settings → Plan");
  });
});
