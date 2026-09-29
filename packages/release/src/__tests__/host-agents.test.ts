import { describe, expect, it } from "vitest";
import { FETCHED_AGENT_PINS, fetchedAgentFolderName, fetchedAgentPin, fetchedAgentPlatformKey, fetchedAgentPlatformPin } from "../fetched-agents.js";
import { HOST_AGENT_BRIDGES, SUPPORTED_AGENT_BRIDGES, compareAgentVersions, findAgentBridge, hostAgentFamily, hostAgentVersionSupported, hostInstallCommand, isFetchedAgentId, isHostAgentId, type HostAgentFamily } from "../bridges.js";

describe("host-installed agent families", () => {
  it("registers DeepSeek Harness as a host-installed family, outside the signed bundled matrix", () => {
    const dsh = findAgentBridge("dsh");
    expect(dsh?.displayName).toBe("DeepSeek Harness");
    expect(dsh?.package).toBe("@deepseek-ai/dsh");
    expect(dsh?.hostInstall?.bin).toBe("dsh");
    expect(dsh?.command).toEqual(["--profile", "acp"]);
    expect(HOST_AGENT_BRIDGES.map(bridge => bridge.agentId)).toEqual(["dsh", "opencode", "antigravity"]);
    expect(dsh?.hostInstall?.launch).toBe("node");
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

  it("registers OpenCode 2 as a host-installed native binary, never in the signed bundled matrix", () => {
    const opencode = hostAgentFamily("opencode");
    expect(opencode).toMatchObject({ displayName: "OpenCode", package: "@opencode/cli", command: ["acp"] });
    expect(opencode.hostInstall).toMatchObject({ launch: "binary", bin: "opencode", pathNames: ["opencode2", "opencode"], versions: { min: "2.0.18", belowCore: "3.0.0" } });
    expect(isHostAgentId("opencode")).toBe(true);
    expect(SUPPORTED_AGENT_BRIDGES.some(bridge => bridge.agentId === "opencode")).toBe(false);
    // The homepage's command, and npm's on Windows (the homepage installer needs Git Bash there).
    expect(hostInstallCommand(opencode, "darwin")).toBe("curl -fsSL https://opencode.ai/v2/install | bash");
    expect(hostInstallCommand(opencode, "linux")).toBe("curl -fsSL https://opencode.ai/v2/install | bash");
    expect(hostInstallCommand(opencode, "win32")).toBe("npm install -g @opencode/cli");
    expect(hostInstallCommand(hostAgentFamily("dsh"), "win32")).toBe("npm install -g @deepseek-ai/dsh@0.1.7-rc.2");
    expect(() => hostAgentFamily("codex")).toThrow(/not registered/);
  });

  it("accepts OpenCode 2 from 2.0.18 and refuses OpenCode 1, 3 and dev builds", () => {
    const opencode = findAgentBridge("opencode")!;
    for (const version of ["2.0.18", "2.0.19", "2.5.0", "2.99.1"]) expect(hostAgentVersionSupported(opencode, version), version).toBe(true);
    for (const version of ["2.0.17", "1.18.33", "1.2.0", "3.0.0", "3.0.0-beta.1", "0.0.0-beta-17236"]) expect(hostAgentVersionSupported(opencode, version), version).toBe(false);
  });

  it("names `agent add` as the install command of a fetched agent, whatever its record says", () => {
    const fetched = { ...hostAgentFamily("opencode"), agentId: "opencode", hostInstall: { ...hostAgentFamily("opencode").hostInstall, launch: "fetched" as const } } as HostAgentFamily;
    for (const platform of ["darwin", "linux", "win32"] as const) expect(hostInstallCommand(fetched, platform)).toBe("konteks-remote agent add opencode");
    expect(isFetchedAgentId("opencode")).toBe(false);
    expect(isFetchedAgentId("dsh")).toBe(false);
    expect(isFetchedAgentId("codex")).toBe(false);
  });

  it("registers Google Antigravity as a fetched host agent, never bundled, with Google's release pinned (A1, A3, A15)", () => {
    const antigravity = hostAgentFamily("antigravity");
    expect(antigravity).toMatchObject({ displayName: "Google Antigravity", package: "antigravity-acp", version: "1.2.1", command: [] });
    expect(antigravity.hostInstall).toMatchObject({ launch: "fetched", versions: { min: "1.2.1", belowCore: "1.3.0" } });
    expect(isHostAgentId("antigravity")).toBe(true);
    expect(isFetchedAgentId("antigravity")).toBe(true);
    expect(SUPPORTED_AGENT_BRIDGES.some(bridge => bridge.agentId === "antigravity")).toBe(false);
    for (const platform of ["darwin", "linux", "win32"] as const) expect(hostInstallCommand(antigravity, platform)).toBe("konteks-remote agent add antigravity");
    for (const version of ["1.2.1", "1.2.12"]) expect(hostAgentVersionSupported(antigravity, version), version).toBe(true);
    for (const version of ["1.1.1", "1.3.0", "1.3.0-rc.1", "2.0.0"]) expect(hostAgentVersionSupported(antigravity, version), version).toBe(false);
    // The pin: only macOS arm64 is proven (A11); the connector never follows the registry itself.
    expect(FETCHED_AGENT_PINS.map(pin => pin.agentId)).toEqual(["antigravity"]);
    const pin = fetchedAgentPin("antigravity")!;
    expect(pin).toMatchObject({ registryId: "antigravity-acp", version: "1.2.1", terms: "https://antigravity.google/terms" });
    expect(hostAgentVersionSupported(antigravity, pin.version)).toBe(true);
    expect(Object.keys(pin.platforms)).toEqual(["darwin-arm64"]);
    expect(fetchedAgentPlatformPin("antigravity", "darwin-arm64")).toEqual({
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip",
      archive: { format: "zip", size: 111725488, sha256: "0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c" },
      command: "agy_acp_server.par", args: [],
      files: [
        { path: "agy_acp_server.par", size: 276920768, sha256: "c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e" },
        { path: "localharness_external", size: 120663872, sha256: "1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456" },
      ],
      signer: { kind: "apple_team_id", teamId: "EQHXZ8M8AV" },
    });
    expect(fetchedAgentPlatformPin("antigravity", "linux-x64")).toBeUndefined();
    expect(fetchedAgentPlatformPin("antigravity", null)).toBeUndefined();
    expect(fetchedAgentPlatformPin("opencode", "darwin-arm64")).toBeUndefined();
    expect(fetchedAgentFolderName(pin, "darwin-arm64")).toBe("1.2.1-darwin-arm64");
    expect(fetchedAgentPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(fetchedAgentPlatformKey("win32", "x64")).toBe("win32-x64");
    expect(fetchedAgentPlatformKey("freebsd", "x64")).toBeNull();
    expect(Object.isFrozen(pin.platforms["darwin-arm64"]!.files[0])).toBe(true);
  });
});
