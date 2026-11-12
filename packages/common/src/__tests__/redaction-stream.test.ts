import { describe, expect, it } from "vitest";
import { SecretTextStream } from "../redaction-stream.js";

const key = "sk-proj-SYNTHETICNONFUNCTIONAL0123456789ABCDEF";

describe("streamed credential redaction", () => {
  it.each([key, key.replace("sk-proj-", "sk-proj-*"), [...key].join("*")])("masks every split of %s before releasing its bytes", value => {
    for (let at = 1; at < value.length; at += 1) {
      const stream = new SecretTextStream();
      const out = stream.push(`before ${value.slice(0, at)}`) + stream.push(`${value.slice(at)} after`) + stream.finish();
      expect(out).toBe("before [redacted] after");
    }
  });

  it("handles character-sized chunks and turn completion without a final newline", () => {
    const stream = new SecretTextStream();
    expect([...key].map(character => stream.push(character)).join("") + stream.finish()).toBe("[redacted]");
    expect(stream.push("ordinary message")).toBe("ordinary message");
  });

  it("never releases a pending credential around an intervening tool event", () => {
    const stream = new SecretTextStream();
    const out = stream.push("before sk-") + stream.interrupt() + stream.push("proj-SYNTHETICNONFUNCTIONAL0123456789ABCDEF after") + stream.finish();
    expect(out).toBe("before [redacted] after");
  });

  it("preserves ordinary text, Markdown, URLs and an incomplete harmless final word", () => {
    for (const value of ["hi", "Done.", "https://github.com/example/repo", "**release notes**", "sk-short", "s", "risk-SYNTHETICNONFUNCTIONAL0123456789ABCDEF", "https://github.com/example/sk-short"]) {
      const stream = new SecretTextStream();
      expect([...value].map(character => stream.push(character)).join("") + stream.finish()).toBe(value);
    }
  });

  it("bounds a candidate with arbitrarily many asterisks and resumes after its delimiter", () => {
    const stream = new SecretTextStream();
    const out = stream.push(`s${"*".repeat(10_000)}`) + stream.push(`k-proj-${"X".repeat(20)} done`) + stream.finish();
    expect(out).toBe("[redacted] done");
  });

  it("does not weaken masking of a complete Bearer token", () => {
    const stream = new SecretTextStream();
    for (const value of ["Bearer SYNTHETIC000000000", "Bearer sk-short", "Bearer eyJshort"]) {
      expect([...value].map(character => stream.push(character)).join("") + stream.finish()).toBe("Bearer [redacted]");
    }
  });
});
