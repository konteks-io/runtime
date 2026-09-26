import { describe, expect, it } from "vitest";
import { konteksCodingSessionTitle, konteksSessionMetadata, konteksSessionTitle } from "../sessions/title.js";

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
  it("limits managed Claude sessions to repository settings while preserving the title", () => {
    expect(konteksSessionMetadata("Review", "claude-code")).toEqual({
      konteksSession: { version: 1, title: "[konteks] Review" },
      claudeCode: { options: { title: "[konteks] Review", settingSources: ["project"] } },
    });
    expect(konteksSessionMetadata("Review", "codex")).not.toHaveProperty("claudeCode");
  });
});

describe("coding session title from Core's display label", () => {
  const ref = "3fa9c1d2";
  it("names the System, the collaboration object and its title", () => {
    expect(konteksCodingSessionTitle({ system: "Todo List", kind: "initiative", title: "[v3] Stand up the todo list API" }, ref))
      .toBe("[konteks/Todo List/initiative] [v3] Stand up the todo list API 3fa9c1d2");
  });
  it("omits missing parts and falls back to the legacy title without a label", () => {
    expect(konteksCodingSessionTitle({ kind: "issue", title: "Login fails" }, ref)).toBe("[konteks/issue] Login fails 3fa9c1d2");
    expect(konteksCodingSessionTitle({ system: "Todo List" }, ref)).toBe("[konteks/Todo List] Coding session 3fa9c1d2");
    expect(konteksCodingSessionTitle({ title: "Release 1.2" }, ref)).toBe("[konteks] Release 1.2 3fa9c1d2");
    expect(konteksCodingSessionTitle(undefined, ref)).toBe("[konteks] Coding session 3fa9c1d2");
    expect(konteksCodingSessionTitle({ system: " ", kind: "", title: "\u200b" }, ref)).toBe("[konteks] Coding session 3fa9c1d2");
  });
  it("strips control and format characters and path separators inside the scope", () => {
    expect(konteksCodingSessionTitle({ system: "Todo/List]\n", kind: "init\u202eiative", title: "Fix\tthe\n\nfilters\u0007" }, ref))
      .toBe("[konteks/Todo List/init iative] Fix the filters 3fa9c1d2");
  });
  it("cuts a long title at a word boundary, keeps the short ref and stays within 160", () => {
    const title = konteksCodingSessionTitle({ system: "Todo List", kind: "initiative", title: "word ".repeat(60) }, ref);
    expect(title.length).toBeLessThanOrEqual(160);
    expect(title).toMatch(/^\[konteks\/Todo List\/initiative\] (word )+word… 3fa9c1d2$/);
    const unbroken = konteksCodingSessionTitle({ system: "S".repeat(300), kind: "initiative", title: "x".repeat(400) }, ref);
    expect(unbroken.length).toBeLessThanOrEqual(160);
    expect(unbroken.endsWith("… 3fa9c1d2")).toBe(true);
  });
  it("keeps a labelled title intact through the provider metadata", () => {
    const title = konteksCodingSessionTitle({ system: "Todo List", kind: "release", title: "v1.2" }, ref);
    expect(konteksSessionTitle(title)).toBe(title);
    expect(konteksSessionMetadata(title, "claude-code")).toEqual({
      konteksSession: { version: 1, title },
      claudeCode: { options: { title, settingSources: ["project"] } },
    });
  });
});
