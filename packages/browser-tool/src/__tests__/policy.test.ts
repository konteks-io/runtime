import { describe, expect, it } from "vitest";
import { BrowserToolPolicySchema, decideNavigation } from "../policy.js";

describe("browser tool navigation policy", () => {
  const open = BrowserToolPolicySchema.parse({});
  const restricted = BrowserToolPolicySchema.parse({ allowedOrigins: ["http://127.0.0.1:5173"] });

  it("allows http(s) targets and refuses every other scheme", () => {
    expect(decideNavigation(open, "http://preview.internal:5173/").ok).toBe(true);
    expect(decideNavigation(open, "file:///etc/passwd").ok).toBe(false);
    expect(decideNavigation(open, "chrome://settings").ok).toBe(false);
    expect(decideNavigation(open, "javascript:alert(1)").ok).toBe(false);
    expect(decideNavigation(open, "not a url").ok).toBe(false);
  });

  it("restricts to configured preview origins when set", () => {
    expect(decideNavigation(restricted, "http://127.0.0.1:5173/app").ok).toBe(true);
    expect(decideNavigation(restricted, "http://127.0.0.1:9999/").ok).toBe(false);
    expect(decideNavigation(restricted, "https://api.anthropic.com/").ok).toBe(false);
  });

  it("refuses userinfo", () => {
    expect(decideNavigation(open, "http://user:pw@127.0.0.1:5173/").ok).toBe(false);
  });
});
