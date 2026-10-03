import { describe, expect, it } from "vitest";
import { nativeSkillHomeBinding } from "../native/skill-homes.js";

describe("installer-owned Skill profile binding", () => {
  it("binds Codex, current Codex discovery, Claude and an alternate Claude profile", () => {
    expect(nativeSkillHomeBinding("/person/.codex-custom", { CLAUDE_CONFIG_DIR: "/person/.claude-deepseek" }, "/person")).toEqual({
      claudeConfigDir: "/person/.claude-deepseek", agentSkillHomes: ["/person/.codex", "/person/.codex-custom", "/person/.agents", "/person/.claude", "/person/.claude-deepseek", "/person/.config/opencode", "/person/.dsh", "/person/.gemini/config"],
    });
  });
  it("does not duplicate the default Claude profile", () => {
    expect(nativeSkillHomeBinding(undefined, {}, "/person").agentSkillHomes).toEqual(["/person/.codex", "/person/.agents", "/person/.claude", "/person/.config/opencode", "/person/.dsh", "/person/.gemini/config"]);
  });
  it.each(["relative", "/", "/person", "/person/\u0000bad"])("rejects unsafe local profile %j", value => {
    expect(() => nativeSkillHomeBinding(undefined, { CLAUDE_CONFIG_DIR: value }, "/person")).toThrow(/local agent profile/);
  });
});

it("binds OpenCode's local XDG config without accepting a relative service path", () => {
  expect(nativeSkillHomeBinding(undefined, { XDG_CONFIG_HOME: "/person/custom-config" }, "/person").agentSkillHomes).toContain("/person/custom-config/opencode");
  expect(() => nativeSkillHomeBinding(undefined, { XDG_CONFIG_HOME: "relative" }, "/person")).toThrow();
});
