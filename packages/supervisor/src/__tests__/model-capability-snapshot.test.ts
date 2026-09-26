import { describe, expect, it, vi } from "vitest";
import { FixedClock, catalogueModelAuthority, computeAgentModelCapabilityMappingDigest } from "@konteks/remote-common";
import { ModelCapabilitySnapshotProducer } from "../native/model-capability-snapshot.js";

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

  it("reports an agent the release signed nothing for under its catalogue authority, with names (System One §6a, KM6)", async () => {
    const codex = { ...ready, agentId: "codex", displayName: "Codex", authIdentityFingerprint: "identity-codex" };
    const discover = vi.fn(async (agentId: string, configId: string) => ({
      currentValue: agentId === "codex" ? "gpt-5.6-sol" : "sonnet",
      offeredValues: agentId === "codex" ? ["gpt-5.6-sol", "gpt-9-preview"] : ["sonnet"],
      offeredOptions: agentId === "codex" ? [{ value: "gpt-5.6-sol", name: "Codex Sol" }, { value: "gpt-9-preview", name: "GPT-9" }] : [{ value: "sonnet" }],
      configId,
    }));
    const producer = new ModelCapabilitySnapshotProducer({ clock, instanceId: () => "instance", runnerIncarnation: () => "process", manifestId: () => "manifest",
      mappings: () => [{ agentId: "claude-code", mapping }], catalogueAgents: () => ["claude-code", "codex", "opencode"], discover, newId: () => "snapshot" });
    await producer.refresh([ready, codex, { ...ready, agentId: "opencode" }]);
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
});
