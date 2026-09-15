import { describe, expect, it } from "vitest";
import { konteksSessionMetadata, konteksSessionTitle } from "../sessions/title.js";

describe("native session provenance title", () => {
  it("uses the exact prefix once and normalizes control characters", () => {
    expect(konteksSessionTitle("Fix\nfilters")).toBe("[konteks] Fix filters");
    expect(konteksSessionTitle("[konteks] Fix filters")).toBe("[konteks] Fix filters");
    expect(konteksSessionTitle("")).toBe("[konteks] Coding session");
    expect(konteksSessionTitle("a".repeat(500))).toHaveLength(160);
  });
  it("carries display metadata rather than a prompt or identity claim", () => {
    expect(konteksSessionMetadata("Review")).toEqual({ konteksSession: { version: 1, title: "[konteks] Review" } });
  });
  it("uses only the native title option for Claude", () => {
    expect(konteksSessionMetadata("Review", "claude-code")).toEqual({
      konteksSession: { version: 1, title: "[konteks] Review" },
      claudeCode: { options: { title: "[konteks] Review" } },
    });
    expect(konteksSessionMetadata("Review", "opencode")).not.toHaveProperty("claudeCode");
  });
});
