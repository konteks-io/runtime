import { describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary, redactText, redactValue } from "../redaction.js";

describe("redaction by construction", () => {
  it("masks every key-shaped canary in free text", () => {
    for (const [name, canary] of Object.entries(SECRET_CANARIES)) {
      // Activation codes are masked by key name, never by free-text pattern.
      if (name === "activationCode") continue;
      expect(redactText(`before ${canary} after`)).not.toContain(canary);
    }
  });

  it("masks secret-named keys wholesale and scrubs nested strings", () => {
    const out = redactValue({
      activationCode: SECRET_CANARIES.activationCode,
      nested: { api_key: "x", note: `token ${SECRET_CANARIES.openAiKey}` },
      list: [SECRET_CANARIES.anthropicKey],
      authorization: "Bearer abc",
    });
    const text = JSON.stringify(out);
    expect(containsCanary(text)).toBe(false);
    expect(text).not.toContain("abc");
  });

  it("reduces an Error to name and redacted message", () => {
    const out = redactValue(new Error(`boom ${SECRET_CANARIES.googleKey}`));
    expect(out).toEqual({ name: "Error", message: "boom [redacted]" });
  });
});
