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


describe("asterisk-obfuscated credentials", () => {
  const keys = [
    "sk-proj-SYNTHETICNONFUNCTIONAL0123456789ABCDEF",
    "sk-ant-SYNTHETICNONFUNCTIONAL0123456789",
    "AIzaSYNTHETICNONFUNCTIONAL0123456789",
    "ghp_SYNTHETICNONFUNCTIONAL0123456789",
    "eyJSYNTHETIC000000.SYNTHETIC000000.SYNTHETIC000000",
    "kxrp_SYNTHETIC000000",
  ];

  it.each(keys)("masks a synthetic key with asterisks at every internal position: %s", key => {
    for (let split = 1; split < key.length; split += 1) {
      const encoded = `${key.slice(0, split)}*${key.slice(split)}`;
      expect(redactText(`before ${encoded} after`)).toBe("before [redacted] after");
    }
    expect(redactText([...key].join("**"))).toBe("[redacted]");
  });

  it("preserves Markdown framing and ordinary text", () => {
    expect(redactText(`**${keys[0]}**`)).toBe("**[redacted]**");
    for (const text of ["a*b*c", "**release notes**", "sk-short", "repo/name", "https://github.com/example/repo"]) {
      expect(redactText(text)).toBe(text);
    }
  });

  it("scrubs nested ordinary properties and errors, not only secret-named keys", () => {
    const encoded = keys[0]!.replace("sk-proj-", "sk-proj-*");
    expect(redactValue({ note: encoded, details: [new Error(encoded)] })).toEqual({
      note: "[redacted]", details: [{ name: "Error", message: "[redacted]" }],
    });
  });
});
