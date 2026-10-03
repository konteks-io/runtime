import { describe, expect, it } from "vitest";
import { RunnerConfigSchema } from "@konteks/remote-agent-runner";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { codexSetupLaunch } from "../integration/compose.js";

describe("integration composition", () => {
  it("runs a setup command with Codex's own pinned CLI on the person's Codex profile, never a shell", () => {
    const config = { ...RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_BRIDGE_PREFIX: "/opt/konteks/agents/codex" }),
      RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile, RUNNER_NATIVE_CODEX_HOME: "/operator/.codex" };
    const launch = codexSetupLaunch(config);
    expect(launch.command.startsWith("/opt/konteks/agents/codex/")).toBe(true);
    expect(launch.args.every(arg => arg.startsWith("/opt/konteks/agents/codex/"))).toBe(true);
    expect(launch.env.CODEX_HOME).toBe("/operator/.codex");
    expect(launch.command).not.toMatch(/(^|\/)(sh|bash|zsh)$/);
  });
});
