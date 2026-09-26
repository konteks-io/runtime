import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, canonicalize, ed25519Sign, generateEd25519, generateInstanceKey, jcsDigest, verifyBody, withoutMembers, type ControlAck, type JsonValue } from "@konteks/remote-common";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { ControlHandlers, compareSemver } from "../control/handlers.js";
import { SupervisorJournal } from "../state/journal.js";
import { SupervisorStore } from "../state/store.js";
import { computeUtilization, deriveAdvertisedRoles, placedAgentReady } from "../inventory/roles.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-ctl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const coreKey = generateEd25519();
const roots = [{ keyId: "root", publicKeyJwk: coreKey.publicJwk, coreControlKeys: [{ keyId: "core-control-1", publicKeyJwk: coreKey.publicJwk }] }];
const signByCore = <T extends { [key: string]: JsonValue }>(body: T): T & { signature: string } => ({ ...body, signature: ed25519Sign(coreKey.privateKey, Buffer.from(canonicalize(withoutMembers(body, ["signature"])))) });

async function harness(overrides: Partial<ConstructorParameters<typeof ControlHandlers>[0]> = {}) {
  const store = new SupervisorStore(dir);
  await store.init();
  const journal = new SupervisorJournal(dir);
  await journal.load();
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const key = generateInstanceKey();
  const acks: ControlAck[] = [];
  const drains: string[] = [];
  const handlers = new ControlHandlers({
    store,
    journal,
    clock,
    key: () => key,
    replaceKey: async () => undefined,
    verifier: new CoreSignatureVerifier(roots),
    instanceId: () => "inst-1",
    bundleVersion: "1.2.0",
    protocolVersion: "1.0",
    manifestDigest: () => "digest",
    localCapacity: () => 4,
    onDrain: async (directive) => {
      drains.push(directive.reason);
      return 2;
    },
    eraseAssignments: async (ids) => ({ failed: ids.filter((id) => id.startsWith("busy")), reason: "data_in_use" }),
    eraseAll: async () => ({ ok: true }),
    onUpdateRequired: () => undefined,
    sendAck: (ack) => acks.push(ack),
    ...overrides,
  });
  await handlers.load();
  return { handlers, acks, drains, clock, key, journal, store };
}

const configuration = { heartbeatIntervalSeconds: 15, logLevel: "info" as const, updateChannel: "stable" as const, evidenceUpload: "selected_artifacts" as const, permissionResponderDeadlineSeconds: 120, humanDeferralAllowed: true, deploymentKind: "native_connector" as const, roleBindings: [] };
/** The retired appliance shape: a gateway stage and no native deployment kind. */
const applianceConfiguration = { heartbeatIntervalSeconds: 15, logLevel: "info" as const, updateChannel: "stable" as const, evidenceUpload: "selected_artifacts" as const, gateway: { capEnforcementStage: "provider_enforce" as const, egressAllowlistRevision: "allow-1" }, permissionResponderDeadlineSeconds: 120, humanDeferralAllowed: true };
const envelope = (revision: number, extra: Record<string, JsonValue> = {}) => {
  const value = { ...configuration, ...extra } as never;
  return signByCore({ type: "desired_configuration" as const, instanceId: "inst-1", revision, issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z", digest: jcsDigest(value), configuration: value });
};

describe("desired configuration", () => {
  it("serializes overlapping native deliveries so a slower write cannot roll back a newer revision", async () => {
    const f = await harness();
    const native = { ...configuration };
    const message = (revision: number) => signByCore({ type: "desired_configuration", instanceId: "inst-1", revision, issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z", digest: jcsDigest(native), configuration: native });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const save = f.store.saveConfig.bind(f.store);
    vi.spyOn(f.store, "saveConfig").mockImplementation(async value => {
      if (value.revision === 1) { entered(); await blocked; }
      await save(value);
    });
    const first = f.handlers.handle(message(1));
    await writing;
    const second = f.handlers.handle(message(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await Promise.all([first, second]);
    expect(f.handlers.configRevision).toBe(2);
    expect((await f.store.config())?.revision).toBe(2);
    expect(f.acks.map(ack => (ack as { revision: number }).revision)).toEqual([1, 2]);
  });

  it("applies and reloads native roles without a gateway, and re-acks an identical retry", async () => {
    const applied: unknown[] = [];
    const f = await harness({ onConfigurationApplied: value => { applied.push(value); } });
    const native = { ...configuration, roleBindings: [{ role: "assistant", agentPreference: ["codex"] }] };
    const message = signByCore({ type: "desired_configuration", instanceId: "inst-1", revision: 1, issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z", digest: jcsDigest(native), configuration: native });
    await f.handlers.handle(message);
    expect(f.acks[0]).toMatchObject({ status: "applied", revision: 1 });
    expect(applied).toEqual([native]);
    expect((await f.store.config())?.configuration).toEqual(native);
    await f.handlers.handle(message);
    expect(f.acks[1]).toMatchObject({ status: "applied", revision: 1 });
    expect(applied).toHaveLength(1);
    const restored: unknown[] = [];
    await harness({ onConfigurationApplied: value => { restored.push(value); } });
    expect(restored).toEqual([native]);
    await f.handlers.handle(signByCore({ ...message, revision: 2, digest: "d".repeat(43) }));
    expect(f.acks.at(-1)).toMatchObject({ status: "rejected", reason: "invalid_value" });
    expect(f.handlers.configRevision).toBe(1);
    const changed = { ...native, humanDeferralAllowed: false };
    await f.handlers.handle(signByCore({ ...message, configuration: changed, digest: jcsDigest(changed) }));
    expect(f.acks.at(-1)).toMatchObject({ status: "rejected", reason: "unsupported_revision" });
    f.clock.advance(2 * 86400_000);
    await f.handlers.handle(message);
    expect(f.acks.at(-1)).toMatchObject({ status: "rejected", reason: "unsupported_revision" });
    await f.handlers.handle(signByCore({ ...message, issuedAt: f.clock.nowIso(), expiresAt: "2026-09-10T00:00:00Z" }));
    expect(f.acks.at(-1)).toMatchObject({ status: "applied", revision: 1 });
    expect(applied).toHaveLength(1);
  });

  it("never acknowledges failed native persistence and recovers on the next delivery", async () => {
    const applied: unknown[] = [];
    const f = await harness({ onConfigurationApplied: value => { applied.push(value); } });
    const native = { ...configuration };
    const message = signByCore({ type: "desired_configuration", instanceId: "inst-1", revision: 1, issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z", digest: jcsDigest(native), configuration: native });
    vi.spyOn(f.store, "saveConfig").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.handlers.handle(message)).rejects.toThrow("disk unavailable");
    expect(f.acks).toHaveLength(0);
    expect(applied).toHaveLength(0);
    expect(f.handlers.configRevision).toBe(0);
    await f.handlers.handle(message);
    expect(f.acks[0]).toMatchObject({ status: "applied" });
    expect(applied).toEqual([native]);
  });

  it("rejects a signed appliance configuration (the retired gateway shape)", async () => {
    const f = await harness();
    await f.handlers.handle(signByCore({ type: "desired_configuration" as const, instanceId: "inst-1", revision: 1, issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z", digest: jcsDigest(applianceConfiguration), configuration: applianceConfiguration as never }));
    expect(f.acks[0]).toMatchObject({ status: "rejected", reason: "invalid_value" });
    expect(await f.store.config()).toBeNull();
  });
  it("applies a signed monotonic revision and acks with a signed body", async () => {
    const { handlers, acks, key } = await harness();
    await handlers.handle(envelope(1));
    expect(acks[0]).toMatchObject({ type: "desired_configuration_ack", revision: 1, status: "applied" });
    const { signature, ...body } = acks[0] as { signature: string } & Record<string, JsonValue>;
    expect(verifyBody(key.publicKey, body, signature)).toBe(true);
    expect(handlers.configRevision).toBe(1);
  });

  it("rejects a stale revision, a forged signature and an unknown field", async () => {
    const { handlers, acks } = await harness();
    await handlers.handle(envelope(2));
    await handlers.handle(envelope(1));
    expect(acks[1]).toMatchObject({ status: "rejected", reason: "unsupported_revision" });
    await handlers.handle({ ...envelope(3), signature: "forged" });
    expect(acks).toHaveLength(2);
    expect(handlers.counters.rejectedSignature).toBe(1);
    await handlers.handle({ ...envelope(4), shell: "rm -rf /" });
    expect(handlers.counters.rejectedUnknown).toBe(1);
  });

  it("rejects a soft ceiling above local capacity", async () => {
    const { handlers, acks } = await harness();
    await handlers.handle(envelope(1, { softMaxConcurrent: 99 }));
    expect(acks[0]).toMatchObject({ status: "rejected", reason: "local_capacity_too_low" });
  });
});

describe("erase, drain, version, rotation", () => {
  it("erase is idempotent by directiveId and a partial failure never becomes a completed receipt", async () => {
    const { handlers, acks } = await harness();
    const directive = signByCore({ type: "erase_directive" as const, directiveId: "e1", instanceId: "inst-1", scope: "assignment_data" as const, assignmentIds: ["a1", "busy-2"], issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-07T00:00:00Z" });
    await handlers.handle(directive);
    await handlers.handle(directive);
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ type: "erase_receipt", status: "partially_completed", failedAssignmentIds: ["busy-2"], reason: "data_in_use" });
  });

  it("drain acknowledges with the active assignment count", async () => {
    const { handlers, acks, drains } = await harness();
    await handlers.handle(signByCore({ type: "drain" as const, instanceId: "inst-1", reason: "limit_loss" as const, issuedAt: "2026-09-06T00:00:00Z" }));
    expect(drains).toEqual(["limit_loss"]);
    expect(acks[0]).toMatchObject({ type: "drain_ack", activeAssignments: 2 });
  });

  it("acknowledges a version policy and flags update_required below the minimum", async () => {
    const { handlers, acks } = await harness();
    await handlers.handle(signByCore({ type: "version_policy" as const, instanceId: "inst-1", targetBundle: "1.3.0", manifestDigest: "d".repeat(43), updateAvailable: true, minimumSupportedBundle: "1.0.0", issuedAt: "2026-09-06T00:00:00Z" }));
    expect(acks[0]).toMatchObject({ type: "version_ack", bundleVersion: "1.2.0", status: "running" });
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
  });

  it("answers a rotation challenge with both signatures and never swaps before commit", async () => {
    const { handlers, acks, key } = await harness();
    await handlers.handle({ type: "key_rotation_challenge", instanceId: "inst-1", rotationId: "r1", nonce: "n".repeat(22), expiresAt: "2026-09-07T00:00:00Z" });
    const complete = acks[0] as Extract<ControlAck, { type: "key_rotation_complete" }>;
    expect(complete.type).toBe("key_rotation_complete");
    const material = { type: "key_rotation", instanceId: "inst-1", rotationId: "r1", nonce: "n".repeat(22), newPublicKeyJwk: complete.newPublicKeyJwk as JsonValue };
    expect(verifyBody(key.publicKey, material, complete.oldKeySignature)).toBe(true);
    await handlers.handle({ type: "key_rotation_challenge", instanceId: "inst-1", rotationId: "r1", nonce: "n".repeat(22), expiresAt: "2026-09-07T00:00:00Z" });
    expect((acks[1] as typeof complete).newPublicKeyJwk).toEqual(complete.newPublicKeyJwk);
  });

  it("ignores directives addressed to another instance", async () => {
    const { handlers, acks } = await harness();
    await handlers.handle(signByCore({ type: "drain" as const, instanceId: "other", reason: "user" as const, issuedAt: "2026-09-06T00:00:00Z" }));
    expect(acks).toHaveLength(0);
    expect(handlers.counters.rejectedUnknown).toBe(1);
  });
});

describe("roles and utilization", () => {
  const ready = { agentId: "codex", displayName: "Codex", connectionState: "ready" as const, authMode: "agent_local_subscription" as const, accountScope: "personal" as const, readiness: "ready" as const, moneyObservable: false, tokenUsageObservable: true, acpCapabilities: { sessionResume: true, forkSession: false, structuredOutputShim: true, toolControl: "approve" as const } };
  it("advertises a role only when a preferred agent is ready and capable", () => {
    const bindings = [{ role: "planner" as const, agentPreference: ["claude-code", "codex"] }, { role: "generator" as const, agentPreference: ["codex"] }, { role: "qa" as const, agentPreference: ["codex"] }, { role: "assistant" as const, agentPreference: ["pi"] }];
    expect(deriveAdvertisedRoles(bindings, [ready], { browserToolAvailable: false })).toEqual(["planner", "generator", "qa"]);
    expect(deriveAdvertisedRoles([{ role: "ops", agentPreference: [ready.agentId] }], [ready], { browserToolAvailable: true })).toEqual([]);
    expect(deriveAdvertisedRoles(bindings, [ready], { browserToolAvailable: true })).toEqual(["planner", "generator", "qa"]);
    expect(deriveAdvertisedRoles(bindings, [{ ...ready, readiness: "not_configured" }], { browserToolAvailable: true })).toEqual([]);
    // Enrollment binds a machine's roles before it has said what it has, so
    // the preference is empty. Reading that as "no candidate" made the machine
    // refuse its own workspace's first assignment as role_not_advertised.
    expect(deriveAdvertisedRoles([{ role: "assistant", agentPreference: [] }], [ready], { browserToolAvailable: true })).toEqual(["assistant"]);
    expect(deriveAdvertisedRoles([{ role: "assistant", agentPreference: [] }], [{ ...ready, readiness: "not_configured" }], { browserToolAvailable: true })).toEqual([]);
    expect(deriveAdvertisedRoles([{ role: "assistant", agentPreference: [] }], [], { browserToolAvailable: true })).toEqual([]);
    expect(placedAgentReady([ready], "codex", "planner", { browserToolAvailable: false })).toBe(true);
    expect(placedAgentReady([ready], "codex", "generator", { browserToolAvailable: false })).toBe(true);
    expect(placedAgentReady([ready], "claude-code", "planner", { browserToolAvailable: false })).toBe(false);
  });

  it("utilization is the max of active-turn load against the soft ceiling and host pressure", () => {
    expect(computeUtilization({ hostPressure: 0.2, activeSessions: 2, activeTurns: 1, softMaxConcurrent: 4, acceptingWork: true })).toEqual({ acceptingWork: true, activeSessions: 2, activeTurns: 1, utilizationRatio: 0.25, softMaxConcurrent: 4 });
    expect(computeUtilization({ hostPressure: 0.2, activeSessions: 4, activeTurns: 0, softMaxConcurrent: 4, acceptingWork: true }).acceptingWork).toBe(true);
    expect(computeUtilization({ hostPressure: 0.9, activeSessions: 4, activeTurns: 4, softMaxConcurrent: 4, acceptingWork: true }).acceptingWork).toBe(false);
  });

  it("does not round advisory pressure into a contradictory saturated heartbeat", () => {
    expect(computeUtilization({ hostPressure: 0.9996, activeSessions: 0, activeTurns: 0, acceptingWork: true })).toMatchObject({ acceptingWork: true, utilizationRatio: 0.9996 });
  });

  it("a pressed host ranks last but still accepts work; only its own turn ceiling refuses", () => {
    // Host pressure alone made an ordinary machine permanently ineligible
    // (`all_runtimes_saturated`): capacity is turn slots, pressure is ranking.
    expect(computeUtilization({ hostPressure: 1, activeSessions: 0, activeTurns: 0, acceptingWork: true })).toMatchObject({ acceptingWork: true, utilizationRatio: 1 });
    expect(computeUtilization({ hostPressure: 1, activeSessions: 3, activeTurns: 2, softMaxConcurrent: 4, acceptingWork: true })).toMatchObject({ acceptingWork: true, utilizationRatio: 1 });
    expect(computeUtilization({ hostPressure: 0.1, activeSessions: 4, activeTurns: 4, softMaxConcurrent: 4, acceptingWork: true }).acceptingWork).toBe(false);
    // A drained or administratively paused runtime still refuses.
    expect(computeUtilization({ hostPressure: 0.1, activeSessions: 0, activeTurns: 0, acceptingWork: false }).acceptingWork).toBe(false);
  });
});
