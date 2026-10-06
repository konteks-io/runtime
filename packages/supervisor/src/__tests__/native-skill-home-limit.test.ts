import { describe, expect, it } from "vitest";
import { RunnerConfigSchema } from "../../../agent-runner/src/config.js";
import { NativeRuntimeRecordSchema } from "../native/installation.js";

const record = {
  schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance", workspaceId: "workspace",
  releaseId: "release", manifestDigest: "digest", bundleVersion: "1.0.0",
  coreUrl: "https://core.example", relayUrl: "wss://relay.example", controlPort: 41800, agents: ["codex"],
};

describe("installer-bound Skill folders", () => {
  it.each([7, 32])("accepts %i folders through both installation and runner contracts", count => {
    const homes = Array.from({ length: count }, (_, index) => `/profiles/agent-${index}`);
    const parsed = NativeRuntimeRecordSchema.parse({ ...record, agentSkillHomes: homes });
    expect(RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_NATIVE_SKILL_HOMES: parsed.agentSkillHomes })
      .RUNNER_NATIVE_SKILL_HOMES).toEqual(homes);
  });

  it.each(["relative/home", "", "/profiles/bad\nname", "/profiles/" + "x".repeat(4096)])("still rejects an invalid folder", home => {
    expect(NativeRuntimeRecordSchema.safeParse({ ...record, agentSkillHomes: [home] }).success).toBe(false);
    expect(RunnerConfigSchema.safeParse({ RUNNER_AGENT_ID: "codex", RUNNER_NATIVE_SKILL_HOMES: [home] }).success).toBe(false);
  });
});
