import { describe, expect, it } from "vitest";
import { HOST_AGENT_BRIDGES, SUPPORTED_AGENT_BRIDGES, compareAgentVersions, findAgentBridge, hostAgentVersionSupported } from "../bridges.js";

describe("host-installed agent families", () => {
  it("registers DeepSeek Harness as a host-installed family, outside the signed bundled matrix", () => {
    const dsh = findAgentBridge("dsh");
    expect(dsh?.displayName).toBe("DeepSeek Harness");
    expect(dsh?.package).toBe("@deepseek-ai/dsh");
    expect(dsh?.hostInstall?.bin).toBe("dsh");
    expect(dsh?.command).toEqual(["--profile", "acp"]);
    expect(HOST_AGENT_BRIDGES.map(bridge => bridge.agentId)).toEqual(["dsh"]);
    // The bundled matrix feeds the signed manifest and the release build; a
    // host-installed agent has no artifact and must never appear there.
    expect(SUPPORTED_AGENT_BRIDGES.some(bridge => bridge.agentId === "dsh")).toBe(false);
    expect(SUPPORTED_AGENT_BRIDGES.every(bridge => bridge.hostInstall === undefined)).toBe(true);
  });

  it("orders versions by semver precedence, prereleases before their release", () => {
    expect(compareAgentVersions("0.1.7-rc.2", "0.1.7")).toBeLessThan(0);
    expect(compareAgentVersions("0.1.7-rc.2", "0.1.7-rc.10")).toBeLessThan(0);
    expect(compareAgentVersions("0.1.7-alpha.2", "0.1.7-rc.1")).toBeLessThan(0);
    expect(compareAgentVersions("0.1.7-rc.2", "0.1.7-rc.2")).toBe(0);
    expect(compareAgentVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareAgentVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(() => compareAgentVersions("0.1", "0.1.0")).toThrow();
    expect(() => compareAgentVersions("0.1.7-", "0.1.7")).toThrow();
    expect(() => compareAgentVersions("01.1.7", "0.1.7")).toThrow();
  });

  it("accepts only the tested range: at least the minimum, and a release core below the ceiling", () => {
    const dsh = findAgentBridge("dsh")!;
    expect(hostAgentVersionSupported(dsh, "0.1.5-rc.3")).toBe(true);
    expect(hostAgentVersionSupported(dsh, "0.1.7-rc.2")).toBe(true);
    expect(hostAgentVersionSupported(dsh, "0.1.7-rc.3")).toBe(true);
    expect(hostAgentVersionSupported(dsh, "0.1.7")).toBe(true);
    expect(hostAgentVersionSupported(dsh, "0.1.5-rc.2")).toBe(false);
    expect(hostAgentVersionSupported(dsh, "0.1.3-alpha.2")).toBe(false);
    // An untested prerelease of the next release is outside the range too.
    expect(hostAgentVersionSupported(dsh, "0.1.8-alpha.1")).toBe(false);
    expect(hostAgentVersionSupported(dsh, "0.1.8")).toBe(false);
    expect(hostAgentVersionSupported(dsh, "not-a-version")).toBe(false);
    expect(hostAgentVersionSupported(findAgentBridge("codex")!, "1.10.0")).toBe(false);
  });
});
