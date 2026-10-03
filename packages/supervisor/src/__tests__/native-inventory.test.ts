import { describe, expect, it, vi } from "vitest";
import { advertisesPreview, type ConnectedAgentView } from "@konteks/remote-common";
import { NativeInventoryCollector, machineHasDesktop } from "../native/inventory.js";
import { withAntigravityDownload } from "../native/antigravity-download.js";
import { deriveAdvertisedRoles } from "../inventory/roles.js";

const agent: ConnectedAgentView = { agentId: "codex", displayName: "Codex", connectionState: "ready", authMode: "agent_local_subscription", accountScope: "personal", readiness: "ready", tokenUsageObservable: true, acpCapabilities: { sessionResume: false, forkSession: false, structuredOutputShim: true, toolControl: "approve" } };
const signals = { cpuRatio: 0.2, memoryRatio: 0.3, diskFreeBytes: 100, diskTotalBytes: 200, loadAverage1m: 0, cpuCount: 4, observedAt: "2026-09-06T00:00:00.000Z" };
function fixture(executionPermitsReady?: () => boolean, cancellationDeliveryReady?: () => boolean, deliveryExecutionPermitsReady?: () => boolean) {
  const readiness = vi.fn(async () => ({ agent, utilization: { activeSessions: 2, activeTurns: 1 } }));
  const sample = vi.fn(async () => signals);
  const inventory = new NativeInventoryCollector({ runners: new Map([["codex", { readiness }]]), sampler: { sample }, bundleVersion: "1.0.0", now: () => new Date(signals.observedAt), ...(executionPermitsReady ? { executionPermitsReady } : {}), ...(cancellationDeliveryReady ? { cancellationDeliveryReady } : {}), ...(deliveryExecutionPermitsReady ? { deliveryExecutionPermitsReady } : {}) });
  return { readiness, sample, inventory };
}

describe("native host inventory (A4 D133)", () => {
  it("advertises Skill sync independently of sign-in only while the local owner supports it", async () => {
    let supported = true;
    const inventory = new NativeInventoryCollector({ runners: new Map(), sampler: { sample: async () => signals }, bundleVersion: "1.0.0", skillSyncReady: () => supported });
    expect((await inventory.collect()).components[0]?.capabilities).toContain("runtime-skill-sync-v1");
    supported = false;
    expect((await inventory.collect()).components[0]?.capabilities).not.toContain("runtime-skill-sync-v1");
    expect((await fixture().inventory.collect()).components[0]?.capabilities).not.toContain("runtime-skill-sync-v1");
  });
  it("discovers every signed installed runner without an agent-add registration step", async () => {
    const claude = { ...agent, agentId: "claude-code", displayName: "Claude Code", readiness: "not_configured" as const };
    const runners = new Map([
      ["codex", { readiness: vi.fn(async () => ({ agent, utilization: { activeSessions: 0, activeTurns: 0 } })) }],
      ["claude-code", { readiness: vi.fn(async () => ({ agent: claude, utilization: { activeSessions: 0, activeTurns: 0 } })) }],
    ]);
    const inventory = new NativeInventoryCollector({ runners, sampler: { sample: async () => signals }, bundleVersion: "1.0.0" });
    const snapshot = await inventory.collect();
    expect(snapshot.agents).toEqual([agent, claude]);
    expect(snapshot.components[0]).toMatchObject({ healthStatus: "healthy", capabilities: ["agent:codex", "session-label-v1", "core-contract-version-v1"] });
    expect(runners.get("codex")!.readiness).toHaveBeenCalledOnce();
    expect(runners.get("claude-code")!.readiness).toHaveBeenCalledOnce();
  });

  it('advertises delivery separately and removes it when ownership or local-agent readiness is lost', async () => {
    let owned = true;
    const f = fixture(() => true, undefined, () => owned);
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(['agent:codex', 'execution-permits-v1', 'delivery-execution-permits-v1', 'delivery-turn-renewal-v1', 'session-label-v1', 'core-contract-version-v1']);
    owned = false;
    expect((await f.inventory.collect()).components[0]?.capabilities).not.toContain('delivery-execution-permits-v1');
    owned = true;
    f.readiness.mockResolvedValue({ agent: { ...agent, readiness: 'not_configured' }, utilization: { activeSessions: 0, activeTurns: 0 } });
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["core-contract-version-v1"]);
  });
  it("offers a login from the site even while the agent is signed out, and Claude Code's only with a desktop (WS1-115)", async () => {
    let browser = true;
    const readiness = vi.fn(async () => ({ agent: { ...agent, readiness: "not_configured" as const }, utilization: { activeSessions: 0, activeTurns: 0 } }));
    const inventory = new NativeInventoryCollector({ runners: new Map([["codex", { readiness }]]), sampler: { sample: async () => signals }, bundleVersion: "1.0.0",
      agentLoginReady: () => true, agentLoginBrowserReady: () => browser });
    expect((await inventory.collect()).components[0]?.capabilities).toEqual(["agent-login-v1", "agent-login-browser-v1", "core-contract-version-v1"]);
    browser = false;
    expect((await inventory.collect()).components[0]?.capabilities).toEqual(["agent-login-v1", "core-contract-version-v1"]);
    expect(machineHasDesktop("darwin", {})).toBe(true);
    expect(machineHasDesktop("darwin", { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" })).toBe(false);
    expect(machineHasDesktop("linux", {})).toBe(false);
    expect(machineHasDesktop("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
  });
  it("advertises preview.dev_server on the agent_runner component while previews can reach a viewer", async () => {
    let relay = true;
    const readiness = vi.fn(async () => ({ agent, utilization: { activeSessions: 0, activeTurns: 0 } }));
    const inventory = new NativeInventoryCollector({ runners: new Map([["codex", { readiness }]]), sampler: { sample: async () => signals }, bundleVersion: "1.0.0", previewReady: () => relay });
    const snapshot = await inventory.collect();
    expect(snapshot.components[0]).toMatchObject({ kind: "agent_runner", capabilities: ["agent:codex", "session-label-v1", "core-contract-version-v1", "preview.dev_server"] });
    expect(advertisesPreview(snapshot.components)).toBe(true);
    relay = false;
    expect(advertisesPreview((await inventory.collect()).components)).toBe(false);
  });
  it("advertises the composed cancellation owner independently of agent sign-in", async () => {
    let owned = true;
    const f = fixture(undefined, () => owned);
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["agent:codex", "cancellation-delivery-v1", "session-label-v1", "core-contract-version-v1"]);
    f.readiness.mockResolvedValue({ agent: { ...agent, readiness: "not_configured" }, utilization: { activeSessions: 0, activeTurns: 0 } });
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["cancellation-delivery-v1", "core-contract-version-v1"]);
    owned = false;
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["core-contract-version-v1"]);
  });
  it("advertises permit admission only while a live owner and ready agent exist", async () => {
    let owned = true;
    const f = fixture(() => owned);
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["agent:codex", "execution-permits-v1", "session-label-v1", "core-contract-version-v1"]);
    owned = false;
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["agent:codex", "session-label-v1", "core-contract-version-v1"]);
    owned = true;
    f.readiness.mockRejectedValue(new Error("runner unavailable"));
    expect((await f.inventory.collect()).components[0]?.capabilities).toEqual(["core-contract-version-v1"]);
  });
  it("reports only the actual in-process runner and host pressure, never appliance components", async () => {
    const f = fixture();
    const snapshot = await f.inventory.collect();
    expect(snapshot.components).toEqual([{ kind: "agent_runner", version: "1.0.0", healthStatus: "healthy", capabilities: ["agent:codex", "session-label-v1", "core-contract-version-v1"], lastProbeAt: signals.observedAt }]);
    expect(snapshot).toMatchObject({ agents: [agent], hostPressure: 0.3, activeSessions: 2, activeTurns: 1, diskFreeBytes: 100 });
    expect(deriveAdvertisedRoles([
      { role: "generator", agentPreference: ["codex"] },
      { role: "qa", agentPreference: ["codex"] },
    ], snapshot.agents, snapshot)).toEqual(["generator", "qa"]);
    expect(f.sample).toHaveBeenCalledOnce();
  });

  it("distinguishes a healthy runner requiring local sign-in from an unavailable runner", async () => {
    const f = fixture();
    f.readiness.mockResolvedValue({ agent: { ...agent, readiness: "not_configured" }, utilization: { activeSessions: 0, activeTurns: 0 } });
    const loggedOut = await f.inventory.collect();
    expect(loggedOut.components[0]).toMatchObject({ healthStatus: "healthy", capabilities: ["core-contract-version-v1"] });
    f.readiness.mockRejectedValue(new Error("private runner failure"));
    const failed = await f.inventory.collect();
    expect(failed.components[0]).toMatchObject({ healthStatus: "unhealthy", capabilities: ["core-contract-version-v1"] });
    expect(failed.agents[0]).toMatchObject({ readiness: "unavailable", connectionState: "unavailable" });
    expect(JSON.stringify(failed)).not.toContain("private runner failure");
  });

  it("rejects cross-agent, BYOK and malformed readiness instead of advertising them", async () => {
    const f = fixture();
    for (const invalid of [{ ...agent, agentId: "other" }, { ...agent, authMode: "gateway_keyed" }, { ...agent, readiness: "invalid" }]) {
      f.readiness.mockResolvedValue({ agent: invalid as ConnectedAgentView, utilization: { activeSessions: 0, activeTurns: 0 } });
      const snapshot = await f.inventory.collect();
      expect(snapshot.agents).toEqual([]);
      expect(snapshot.components[0]?.healthStatus).toBe("unhealthy");
    }
  });

  it("fails closed for missing host signals and empty runner inventory", async () => {
    const f = fixture();
    f.sample.mockRejectedValue(new Error("cannot sample"));
    expect(await f.inventory.collect()).toMatchObject({ hostPressure: 1, diskFreeBytes: 0 });
    const empty = new NativeInventoryCollector({ runners: new Map(), sampler: { sample: async () => signals }, bundleVersion: "1.0.0" });
    expect((await empty.collect()).components[0]?.healthStatus).toBe("unhealthy");
  });

  it("does not expose mutable cached readiness", async () => {
    const f = fixture();
    const first = await f.inventory.collect();
    first.agents[0]!.readiness = "unavailable";
    f.inventory.agents()[0]!.acpCapabilities.toolControl = "none";
    expect(f.inventory.agents()[0]).toEqual(agent);
  });

  it("adds Google Antigravity's download state to what it reports, never to readiness or capabilities (antigravity CP3 prep)", async () => {
    const readiness = vi.fn(async () => ({ agent, utilization: { activeSessions: 0, activeTurns: 0 } }));
    let decorate = async (agents: ConnectedAgentView[]) => withAntigravityDownload(agents, { state: "not_downloaded", sizeBytes: 111_725_488 });
    const inventory = new NativeInventoryCollector({ runners: new Map([["codex", { readiness }]]), sampler: { sample: async () => signals }, bundleVersion: "1.0.0",
      decorateAgents: agents => decorate(agents) });
    const snapshot = await inventory.collect();
    expect(snapshot.agents).toEqual([agent, expect.objectContaining({ agentId: "antigravity", displayName: "Google Antigravity", readiness: "unavailable", connectionState: "unavailable",
      hostAgentDownload: { state: "not_downloaded", sizeBytes: 111_725_488 } })]);
    expect(snapshot.components[0]?.capabilities).toEqual(["agent:codex", "session-label-v1", "core-contract-version-v1"]);
    expect(inventory.agents()).toEqual([agent]);
    // On the agent's own view when its runner reports one.
    const running = withAntigravityDownload([{ ...agent, agentId: "antigravity", displayName: "Google Antigravity" }], { state: "ready" });
    expect(running).toEqual([{ ...agent, agentId: "antigravity", displayName: "Google Antigravity", hostAgentDownload: { state: "ready" } }]);
    // A decoration that fails never costs the heartbeat its agents.
    decorate = async () => { throw new Error("disk gone"); };
    expect((await inventory.collect()).agents).toEqual([agent]);
  });
  it("always advertises that it reads Core's contract version: no agent, OpenCode, Google Antigravity (antigravity CP6)", async () => {
    const view = (agentId: string, readiness: ConnectedAgentView["readiness"]) => ({ ...agent, agentId, displayName: agentId, readiness });
    const collect = (runners: Array<[string, ConnectedAgentView]>, additionalCapabilities?: () => string[]) => new NativeInventoryCollector({
      runners: new Map(runners.map(([id, value]) => [id, { readiness: vi.fn(async () => ({ agent: value, utilization: { activeSessions: 0, activeTurns: 0 } })) }])),
      sampler: { sample: async () => signals }, bundleVersion: "1.0.0", ...(additionalCapabilities ? { additionalCapabilities } : {}) }).collect();
    expect((await collect([])).components[0]?.capabilities).toEqual(["core-contract-version-v1"]);
    expect((await collect([["opencode", view("opencode", "not_configured")]], () => ["opencode-free-models-v1"])).components[0]?.capabilities)
      .toEqual(["opencode-free-models-v1", "core-contract-version-v1"]);
    const antigravity = (await collect([["antigravity", view("antigravity", "ready")]], () => ["agent-login-antigravity-v1", "agent-login-antigravity:gemini-enterprise"])).components[0]?.capabilities;
    expect(antigravity).toEqual(["agent:antigravity", "agent-login-antigravity-v1", "agent-login-antigravity:gemini-enterprise", "session-label-v1", "core-contract-version-v1"]);
    expect(antigravity).not.toContain("opencode-free-models-v1");
  });
});
