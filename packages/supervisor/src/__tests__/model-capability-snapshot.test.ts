import { describe, expect, it, vi } from "vitest";
import { FixedClock, catalogueModelAuthority, computeAgentModelCapabilityMappingDigest, keyedFingerprint } from "@konteks/remote-common";
import { ModelCapabilitySnapshotProducer, openCodeOptionBilling } from "../native/model-capability-snapshot.js";

const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
const body = { version: 1 as const, mappingId: "mapping", mappingRevision: 1, bridgeProfileRef: "claude-profile", bridgeArtifactDigest: `sha256:${"a".repeat(64)}`, configId: "exact-model-id", optionType: "select" as const, issuedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z" };
const mapping = { ...body, mappingDigest: computeAgentModelCapabilityMappingDigest(body), signature: { algorithm: "Ed25519" as const, keyId: "release", value: "AA" } };
const ready = { agentId: "claude-code", displayName: "Claude", authMode: "agent_local_subscription" as const, accountScope: "personal" as const, authIdentityFingerprint: "identity-a", connectionState: "ready" as const, readiness: "ready" as const, capabilities: [], acpCapabilities: { sessionResume: false, forkSession: false, structuredOutputShim: true, toolControl: "approve" as const }, tokenUsageObservable: true, lastProbeAt: "2026-09-06T00:00:00Z" };

describe("authenticated model offered-values snapshot producer", () => {
  it("coalesces discovery for one authority tuple and emits a bounded stable snapshot", async () => {
    const discover = vi.fn(async () => ({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] }));
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest", mappings: () => [{ agentId: "claude-code", mapping }], discover, newId: () => "snapshot" });
    await Promise.all([producer.refresh([ready]), producer.refresh([ready])]);
    await producer.refresh([ready]);
    expect(discover).toHaveBeenCalledOnce();
    expect(producer.snapshots()).toEqual([expect.objectContaining({ snapshotId: "snapshot", snapshotRevision: 1, agentId: "claude-code", authIdentityFingerprint: "identity-a", currentValue: "sonnet", offeredValues: ["sonnet", "opus"] })]);
  });

  it("invalidates immediately when identity, manifest, mapping, incarnation or expiry changes", async () => {
    let manifest = "manifest", process = "process", mappings = [{ agentId: "claude-code", mapping }];
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance", runnerIncarnation: () => process, manifestId: () => manifest, mappings: () => mappings, discover: async () => ({ currentValue: "sonnet", offeredValues: ["sonnet"] }), newId: () => "snapshot" });
    await producer.refresh([ready]); expect(producer.snapshots()).toHaveLength(1);
    producer.invalidateForAgents([{ ...ready, authIdentityFingerprint: "identity-b" }]); expect(producer.snapshots()).toEqual([]);
    await producer.refresh([{ ...ready, authIdentityFingerprint: "identity-b" }]); manifest = "next"; producer.invalidateForAgents([{ ...ready, authIdentityFingerprint: "identity-b" }]); expect(producer.snapshots()).toEqual([]);
    await producer.refresh([{ ...ready, authIdentityFingerprint: "identity-b" }]); mappings = [{ agentId: "claude-code", mapping: { ...mapping, mappingRevision: 2 } }]; producer.invalidateForAgents([{ ...ready, authIdentityFingerprint: "identity-b" }]); expect(producer.snapshots()).toEqual([]);
    mappings = [{ agentId: "claude-code", mapping }]; await producer.refresh([{ ...ready, authIdentityFingerprint: "identity-b" }]); process = "next"; producer.invalidateForAgents([{ ...ready, authIdentityFingerprint: "identity-b" }]); expect(producer.snapshots()).toEqual([]);
    process = "process"; await producer.refresh([{ ...ready, authIdentityFingerprint: "identity-b" }]); clock.advance(5 * 60_000 + 1); expect(producer.snapshots()).toEqual([]);
  });

  it("refreshes ahead without dropping a valid snapshot on transient discovery failure", async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] })
      .mockRejectedValueOnce(new Error("bridge busy"))
      .mockResolvedValueOnce({ currentValue: "opus", offeredValues: ["sonnet", "opus"] });
    let nextId = 0;
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest", mappings: () => [{ agentId: "claude-code", mapping }], discover, newId: () => `snapshot-${++nextId}`, ttlMs: 5 * 60_000, refreshAheadMs: 2 * 60_000 });
    await producer.refresh([ready]);
    const original = producer.snapshots()[0]!;
    clock.advance(3 * 60_000 + 1);
    await producer.refresh([ready]);
    expect(producer.snapshots()).toEqual([original]);
    clock.advance(5_000);
    await producer.refresh([ready]);
    expect(producer.snapshots()).toEqual([expect.objectContaining({ snapshotId: "snapshot-2", snapshotRevision: 2, currentValue: "opus" })]);
  });

  it("re-advertises a kept answer with the time it was observed and a fresh window Core accepts", async () => {
    const own = new FixedClock(Date.parse("2026-10-02T00:00:00Z"));
    const discover = vi.fn()
      .mockResolvedValueOnce({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"] })
      // The runner kept its last good answer while reading the agent again.
      .mockResolvedValueOnce({ currentValue: "sonnet", offeredValues: ["sonnet", "opus"], observedAgoMs: 4 * 60_000 });
    let nextId = 0;
    const producer = new ModelCapabilitySnapshotProducer({ clock: own, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest",
      mappings: () => [{ agentId: "claude-code", mapping: { ...mapping, expiresAt: "2026-10-09T00:00:00Z" } }], discover, newId: () => `snapshot-${++nextId}`, ttlMs: 5 * 60_000, refreshAheadMs: 2 * 60_000 });
    await producer.refresh([ready]);
    own.advance(4 * 60_000);
    await producer.refresh([ready]);
    const [kept] = producer.snapshots();
    expect(kept).toMatchObject({ snapshotId: "snapshot-2", snapshotRevision: 2 });
    // Not claimed as observed later than it was; valid for a full window from now.
    expect(Date.parse(kept!.observedAt)).toBe(Date.parse("2026-10-02T00:00:00Z"));
    expect(Date.parse(kept!.expiresAt)).toBe(own.now() + 5 * 60_000);
    expect(kept).not.toHaveProperty("observedAgoMs");
  });

  it("reports an agent the release signed nothing for under its catalogue authority, with names", async () => {
    const codex = { ...ready, agentId: "codex", displayName: "Codex", authIdentityFingerprint: "identity-codex" };
    const discover = vi.fn(async (agentId: string, configId: string) => ({
      currentValue: agentId === "codex" ? "gpt-5.6-sol" : "sonnet",
      offeredValues: agentId === "codex" ? ["gpt-5.6-sol", "gpt-9-preview"] : ["sonnet"],
      offeredOptions: agentId === "codex" ? [{ value: "gpt-5.6-sol", name: "Codex Sol" }, { value: "gpt-9-preview", name: "GPT-9" }] : [{ value: "sonnet" }],
      configId,
    }));
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest",
      mappings: () => [{ agentId: "claude-code", mapping }], catalogueAgents: () => ["claude-code", "codex", "pi"], discover, newId: () => "snapshot" });
    await producer.refresh([ready, codex, { ...ready, agentId: "pi" }]);
    // claude-code keeps its signed mapping; codex reports under its catalogue authority; a retired agent never does.
    expect(discover.mock.calls.map(call => call[0]).sort()).toEqual(["claude-code", "codex"]);
    expect(discover).toHaveBeenCalledWith("codex", "model");
    const snapshots = producer.snapshots();
    expect(snapshots.map(snapshot => [snapshot.agentId, snapshot.mappingId])).toEqual([["claude-code", "mapping"], ["codex", "catalogue-codex-models"]]);
    const codexSnapshot = snapshots.find(snapshot => snapshot.agentId === "codex")!;
    expect(codexSnapshot).toMatchObject({ ...catalogueModelAuthority("codex"), offeredOptions: [{ value: "gpt-5.6-sol", name: "Codex Sol" }, { value: "gpt-9-preview", name: "GPT-9" }] });
    expect(Date.parse(codexSnapshot.expiresAt) - clock.now()).toBe(5 * 60_000);
    // A sign-in change drops it at once.
    producer.invalidateForAgents([ready, { ...codex, authIdentityFingerprint: "identity-other" }]);
    expect(producer.snapshots().map(snapshot => snapshot.agentId)).toEqual(["claude-code"]);
  });

  it("falls back to the catalogue authority once an agent's signed mapping has expired", async () => {
    const expired = { agentId: "claude-code", mapping: { ...mapping, expiresAt: "2026-09-05T00:00:00Z" } };
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest",
      mappings: () => [expired], catalogueAgents: () => ["claude-code"], discover: async () => ({ currentValue: "sonnet", offeredValues: ["sonnet"] }), newId: () => "snapshot" });
    await producer.refresh([ready]);
    expect(producer.snapshots().map(snapshot => snapshot.mappingId)).toEqual(["catalogue-claude-code-models"]);
  });

  it("publishes DSH catalogue models when its HMAC digest begins with base64url punctuation", async () => {
    const dsh = { ...ready, agentId: "dsh", displayName: "DeepSeek Harness",
      authIdentityFingerprint: keyedFingerprint(Buffer.alloc(32), "identity-28") };
    const currentValue = '["deepseek-official","deepseek-flash"]';
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance",
      runnerIncarnation: () => "process", manifestId: () => "manifest", mappings: () => [],
      catalogueAgents: () => ["dsh"], discover: async () => ({ currentValue, offeredValues: [currentValue] }),
      newId: () => "snapshot" });

    await producer.refresh([dsh]);

    expect(producer.snapshots()).toEqual([expect.objectContaining({ agentId: "dsh",
      mappingId: "catalogue-dsh-models", authIdentityFingerprint: dsh.authIdentityFingerprint,
      offeredValues: [currentValue] })]);
  });

  it("labels each offered OpenCode route with how it is billed here, only when asked to (a 7.1.0 Core)", async () => {
    const own = new FixedClock(Date.parse("2026-09-28T00:00:00Z"));
    const opencode = { ...ready, agentId: "opencode", displayName: "OpenCode", authIdentityFingerprint: "identity-oc",
      credentials: [{ providerId: "openai", label: "ChatGPT Plus or Pro", kind: "sign_in" as const, state: "ready" as const }, { providerId: "opencode", label: "OpenCode Console account", kind: "sign_in" as const, state: "ready" as const }] };
    const values = ["openai/gpt-5.5", "opencode/claude-sonnet-5", "deepseek/deepseek-v4-pro", "github-copilot/claude-sonnet-4.5"];
    const discover = vi.fn(async () => ({ currentValue: values[0]!, offeredValues: values, offeredOptions: values.map(value => ({ value, name: value })) }));
    let accepts = true;
    const producer = new ModelCapabilitySnapshotProducer({ clock: own, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest",
      mappings: () => [], catalogueAgents: () => ["opencode"], discover, newId: () => "snapshot",
      optionBilling: (agentId, value, agent) => (accepts ? openCodeOptionBilling({ agentId, ...(agent.credentials ? { credentials: agent.credentials } : {}) }, value) : undefined) });
    await producer.refresh([opencode]);
    expect(producer.snapshots()[0]!.offeredOptions).toEqual([
      { value: "openai/gpt-5.5", name: "openai/gpt-5.5", billing: "subscription" },
      { value: "opencode/claude-sonnet-5", name: "opencode/claude-sonnet-5", billing: "pay_per_use" },
      { value: "deepseek/deepseek-v4-pro", name: "deepseek/deepseek-v4-pro", billing: "pay_per_use" },
      { value: "github-copilot/claude-sonnet-4.5", name: "github-copilot/claude-sonnet-4.5", billing: "subscription" },
    ]);
    // An older Core refuses the field: nothing is labelled.
    accepts = false;
    producer.invalidateAgent("opencode");
    await producer.refresh([opencode]);
    expect(JSON.stringify(producer.snapshots())).not.toContain("billing");
    expect(openCodeOptionBilling({ agentId: "codex" }, "gpt-5.5")).toBeUndefined();
    expect(openCodeOptionBilling({ agentId: "opencode" }, "no-provider")).toBeUndefined();
    expect(openCodeOptionBilling({ agentId: "opencode", credentials: [{ providerId: "openai", label: "OpenAI key", kind: "api_key", state: "ready" }] }, "openai/gpt-5.5")).toBe("pay_per_use");
  });
});
