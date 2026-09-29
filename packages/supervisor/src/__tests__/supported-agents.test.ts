import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError, SupportedAgentListSchema, type ConnectedAgentView } from "@konteks/remote-common";
import { NotAddedAgentsDetector, SUPPORTED_AGENT_IDS, detectNotAddedAgent, projectSupportedAgents, stateForFailure, versionFromRefusal, type AddedAgentFacts, type NotAddedAgentDetection } from "../native/supported-agents.js";

const view = (agentId: string, readiness: ConnectedAgentView["readiness"], connectionState: ConnectedAgentView["connectionState"] = "ready"): ConnectedAgentView => ({
  agentId, displayName: agentId, connectionState, authMode: "agent_local_subscription", accountScope: "personal", readiness, tokenUsageObservable: true,
  acpCapabilities: { sessionResume: true, forkSession: false, structuredOutputShim: true, toolControl: "approve" },
});
const refusal = (diagnostic: string | undefined, message = "refused") => new RemoteInstanceError("prerequisite_missing", message, diagnostic ? { diagnostic } : {});

describe("supported agents on this computer (runtime-view R21)", () => {
  it("reports all five, in order, with a state each, the supported range and the install commands", () => {
    const added = new Map<string, AddedAgentFacts>([
      ["claude-code", { view: view("claude-code", "ready") }],
      ["codex", { view: view("codex", "not_configured") }],
      ["dsh", { view: view("dsh", "not_configured"), signInLost: true, version: "0.1.7-rc.2" }],
    ]);
    const notAdded = new Map<string, NotAddedAgentDetection>([
      ["opencode", { state: "installed_not_added", versionFound: "2.0.18" }],
      ["antigravity", { state: "not_added" }],
    ]);
    const entries = projectSupportedAgents({ added, notAdded });
    expect(entries.map(entry => entry.agentId)).toEqual([...SUPPORTED_AGENT_IDS]);
    expect(SupportedAgentListSchema.safeParse(entries).success).toBe(true);
    expect(entries).toEqual([
      { agentId: "claude-code", state: "ready", installCommand: "curl -fsSL https://claude.ai/install.sh | bash", windowsInstallCommand: "irm https://claude.ai/install.ps1 | iex" },
      { agentId: "codex", state: "needs_sign_in", installCommand: "npm install -g @openai/codex" },
      { agentId: "dsh", state: "sign_in_expired", versionFound: "0.1.7-rc.2", supportedRange: ">=0.1.5-rc.3 <0.1.8", installCommand: "npm install -g @deepseek-ai/dsh@0.1.7-rc.2" },
      { agentId: "opencode", state: "installed_not_added", versionFound: "2.0.18", supportedRange: ">=2.0.18 <3.0.0", installCommand: "curl -fsSL https://opencode.ai/v2/install | bash", windowsInstallCommand: "npm install -g @opencode/cli" },
      { agentId: "antigravity", state: "not_added", supportedRange: ">=1.2.1 <1.3.0", installCommand: "konteks-remote agent add antigravity" },
    ]);
  });

  it("an added agent that is left out says why in one word, with the version its refusal names", () => {
    const added = new Map<string, AddedAgentFacts>([
      ["claude-code", { view: view("claude-code", "unavailable", "failed") }],
      ["codex", { failure: new RemoteInstanceError("prerequisite_missing", "Open your local Codex once") }],
      ["dsh", { failure: refusal("dsh_unsupported_version", "DeepSeek Harness 0.1.9 is not a version Konteks supports (0.1.5-rc.3 up to, but not including, 0.1.8). Install it with `npm install -g @deepseek-ai/dsh@0.1.7-rc.2`, then retry.") }],
      ["opencode", { failure: refusal("opencode_not_found") }],
      ["antigravity", { failure: refusal("antigravity_unsupported_platform") }],
    ]);
    const states = projectSupportedAgents({ added, notAdded: new Map() }).map(entry => [entry.agentId, entry.state, entry.versionFound]);
    expect(states).toEqual([
      ["claude-code", "failed", undefined],
      ["codex", "not_installed", undefined],
      ["dsh", "unsupported_version", "0.1.9"],
      ["opencode", "not_installed", undefined],
      ["antigravity", "not_supported_on_this_os", undefined],
    ]);
  });

  it("reads refusals the way a person would act on them", () => {
    expect(stateForFailure("antigravity", refusal("antigravity_not_fetched"))).toBe("not_added");
    expect(stateForFailure("opencode", refusal("opencode_unsupported_version"))).toBe("unsupported_version");
    expect(stateForFailure("opencode", refusal("opencode_unsafe_install"))).toBe("failed");
    expect(stateForFailure("dsh", refusal("dsh_node_unsupported"))).toBe("failed");
    expect(stateForFailure("claude-code", new Error("boom"))).toBe("failed");
    expect(stateForFailure("claude-code", undefined)).toBe("failed");
    expect(versionFromRefusal(refusal(undefined, "OpenCode 1 is not supported (found 1.18.33): install OpenCode 2"))).toBe("1.18.33");
    expect(versionFromRefusal(refusal(undefined, "OpenCode v2.1.0-beta.1. is not"))).toBe("2.1.0-beta.1");
    expect(versionFromRefusal(refusal(undefined, "The installed OpenCode did not report its version."))).toBeUndefined();
  });

  it("detects agents the installation does not list without adding anything", async () => {
    const missing = async () => { throw refusal(undefined); };
    expect(await detectNotAddedAgent("claude-code", { claude: async () => "/usr/local/bin/claude" })).toEqual({ state: "installed_not_added" });
    expect(await detectNotAddedAgent("codex", { codex: async () => { throw new RemoteInstanceError("prerequisite_missing", "Open your local Codex once"); } })).toEqual({ state: "not_installed" });
    expect(await detectNotAddedAgent("dsh", { dsh: async () => ({ version: "0.1.7-rc.2" }) })).toEqual({ state: "installed_not_added", versionFound: "0.1.7-rc.2" });
    expect(await detectNotAddedAgent("opencode", { opencode: async () => { throw refusal("opencode_unsupported_version", "OpenCode 1 is not supported (found 1.18.33)"); } }))
      .toEqual({ state: "unsupported_version", versionFound: "1.18.33" });
    expect(await detectNotAddedAgent("opencode", { opencode: missing })).toEqual({ state: "failed" });
    expect(await detectNotAddedAgent("antigravity", { antigravityPinned: () => true })).toEqual({ state: "not_added" });
    expect(await detectNotAddedAgent("antigravity", { antigravityPinned: () => false })).toEqual({ state: "not_supported_on_this_os" });
  });

  it("re-detects in the background on the agent retry cadence, never on every heartbeat", async () => {
    let now = 1_000_000;
    const claude = vi.fn(async () => "/usr/local/bin/claude");
    const detector = new NotAddedAgentsDetector({ agentIds: ["claude-code"], now: () => now, deps: { claude } });
    expect(detector.detectedOnce()).toBe(false);
    await detector.refreshIfDue();
    expect(detector.detectedOnce()).toBe(true);
    expect(detector.current().get("claude-code")).toEqual({ state: "installed_not_added" });
    // Heartbeats in between ask; nothing runs until a minute passed.
    now += 30_000; await detector.refreshIfDue();
    expect(claude).toHaveBeenCalledTimes(1);
    now += 30_000; await detector.refreshIfDue();
    expect(claude).toHaveBeenCalledTimes(2);
    // Unchanged: the next one waits twice as long (two minutes), capped at fifteen.
    now += 60_000; await detector.refreshIfDue();
    expect(claude).toHaveBeenCalledTimes(2);
    now += 60_000; await detector.refreshIfDue();
    expect(claude).toHaveBeenCalledTimes(3);
    // A change brings the cadence back to a minute.
    claude.mockRejectedValue(new RemoteInstanceError("prerequisite_missing", "Install Claude Code"));
    now += 4 * 60_000; await detector.refreshIfDue();
    expect(detector.current().get("claude-code")).toEqual({ state: "not_installed" });
    now += 60_000; await detector.refreshIfDue();
    expect(claude).toHaveBeenCalledTimes(5);
  });
});
