import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519Sign, generateEd25519, remoteControlSigningBytes, type JsonValue } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";
import { LEASE_AUDIENCE } from "../core/client.js";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { decodeLeaseClaims, leaseRecordFromClaims } from "../lease/lease.js";
import { RuntimeUpdateReceiver, type RuntimeUpdateScope } from "../native/runtime-update.js";
import { RuntimeUpdateStore } from "../native/runtime-update-store.js";
import type { StateMutation } from "../state/mutation-gate.js";

interface UpdateOwnershipInternals {
  instanceId: string;
  workspaceId: string;
  runnerIncarnation: string;
  nativeOwnership: { assertOwned(): void };
  stopping: boolean;
  leaseAuthorityEpoch: number;
  recoveryAuthority(): string | null;
  captureOwner(): unknown;
  ownerUnchanged(owner: unknown): boolean;
  runtimeUpdateScope(connection: { connectionEpoch: number; assertCurrent(): void }): RuntimeUpdateScope | null;
  captureRuntimeUpdateReportOwner(): () => void;
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "runtime-update-owner-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function ownershipFixture() {
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({
    SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: root,
    SUPERVISOR_CORE_URL: "https://core.example", SUPERVISOR_BUNDLE_VERSION: "1.0.0",
  }));
  const internal = supervisor as unknown as UpdateOwnershipInternals;
  Object.assign(internal, { instanceId: "instance", workspaceId: "tenant", runnerIncarnation: "runner",
    nativeOwnership: { assertOwned: vi.fn() }, leaseAuthorityEpoch: 0 });
  const clock = { now: Date.parse("2026-10-01T00:00:00Z") };
  vi.spyOn(supervisor.clock, "coreNow").mockImplementation(() => clock.now);
  const accepted = { generation: "accepted" };
  vi.spyOn(internal, "recoveryAuthority").mockImplementation(() => `${accepted.generation}:${internal.leaseAuthorityEpoch}`);
  const baseClaims = { iss: "konteks:control-plane", aud: LEASE_AUDIENCE, sub: "instance", workspace_id: "tenant",
    jti: "lease", iat: Math.floor(clock.now / 1000), exp: Math.floor(clock.now / 1000) + 60,
    protocol: "1.0", bundle_version: "1.0.0", deployment_kind: "native_connector", components: ["agent_runner"],
    ownership_scope: "personal", administrative_status: "active", lease_mode: "active" };
  const adopt = (patch: Record<string, unknown> = {}) => {
    // Lease metadata stands for input already accepted over Core HTTPS; this
    // decoder is not a JWT verifier. Remote deliveries below use real signatures.
    const token = `header.${Buffer.from(JSON.stringify({ ...baseClaims, ...patch })).toString("base64url")}.fixture`;
    const claims = decodeLeaseClaims(token, { instanceId: "instance", audience: LEASE_AUDIENCE });
    supervisor.lease.set(leaseRecordFromClaims(token, claims));
  };
  adopt();
  const connection = { connectionEpoch: 5, assertCurrent: vi.fn() };
  const scope = internal.runtimeUpdateScope(connection)!;
  const renew = (patch: Record<string, unknown> = {}) => adopt({ jti: "renewed", iat: baseClaims.iat + 1, exp: baseClaims.exp + 60, ...patch });
  return { supervisor, internal, clock, accepted, baseClaims, adopt, renew, connection, scope };
}

function receiverFixture(mutate?: StateMutation) {
  const f = ownershipFixture();
  const keys = generateEd25519();
  const verifier = new CoreSignatureVerifier([{ keyId: "release", publicKeyJwk: keys.publicJwk,
    coreControlKeys: [{ keyId: "control", publicKeyJwk: keys.publicJwk }] }]);
  const store = new RuntimeUpdateStore(join(root, "runtime-updates.json"), mutate);
  const intent = { updateId: "update", instanceId: "instance", tenantId: "tenant", leaseId: "lease", runnerIncarnation: "runner",
    targetBundle: "1.1.0", manifestDigest: "a".repeat(43), deadlineAt: new Date(f.clock.now + 60_000).toISOString() };
  const apply = vi.fn(async (_reason: unknown, target: unknown, assertCurrent?: () => void) => {
    assertCurrent!();
    expect(target).toEqual({ bundleVersion: intent.targetBundle, manifestDigest: intent.manifestDigest });
    return { started: true, reason: null, pid: 55, status: {} } as never;
  });
  const report = vi.fn(async () => ({ accepted: true }));
  const receiver = new RuntimeUpdateReceiver({ verifier, store, coordinator: () => ({ apply }), now: () => f.clock.now,
    proof: () => ({ bundleVersion: "1.0.0", manifestDigest: "b".repeat(43), runnerIncarnation: "runner", ready: true }),
    readLedger: async () => ({ schemaVersion: 1, attempts: [] }), report,
    captureReportOwner: () => f.internal.captureRuntimeUpdateReportOwner() });
  const make = (overrides: Record<string, JsonValue> = {}) => {
    const unsigned = { type: "runtime_update_delivery", method: "POST", path: { instanceId: "instance" }, nodeId: "node",
      connectionRef: "connection", connectionEpoch: 5, intent, keyId: "control", nonce: "N".repeat(22),
      issuedAt: new Date(f.clock.now).toISOString(), expiresAt: new Date(f.clock.now + 30_000).toISOString(), ...overrides };
    return { ...unsigned, signature: ed25519Sign(keys.privateKey, remoteControlSigningBytes(unsigned)) };
  };
  return { ...f, store, intent, apply, report, receiver, make };
}

function drainLease(f: ReturnType<typeof ownershipFixture>, patch: Record<string, unknown> = {}) {
  f.adopt({ lease_mode: "drain_only", administrative_status: "suspended", exp: f.baseClaims.exp + 60,
    drain_deadline: new Date((f.baseClaims.exp + 60) * 1000).toISOString(), ...patch });
}

describe("update-only Supervisor ownership across active lease renewal", () => {
  it.each(["same token", "new lease"])("retains a captured update scope after %s adoption without relaxing generic owners", kind => {
    const f = ownershipFixture();
    const genericOwner = f.internal.captureOwner();
    const reportOwner = f.internal.captureRuntimeUpdateReportOwner();
    if (kind === "same token") f.adopt();
    else f.renew();
    expect(f.internal.ownerUnchanged(genericOwner)).toBe(false);
    expect(() => f.scope.assertCurrent()).not.toThrow();
    expect(() => reportOwner()).not.toThrow();
    expect(f.scope).toMatchObject({ leaseId: "lease", connectionEpoch: 5,
      leaseExpiresAt: new Date(f.baseClaims.exp * 1000).toISOString() });
  });

  it.each([
    { protocol: "2.0" }, { bundle_version: "1.2.0" }, { ownership_scope: "organization" },
    { administrative_status: "draining" }, { workspace_id: "foreign" },
    { lease_mode: "drain_only", administrative_status: "suspended", drain_deadline: "2026-10-01T00:02:00Z" },
    { iat: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000) - 1 },
  ])("refuses renewed lease policy or issue-order changes %j", patch => {
    const f = ownershipFixture();
    const reportOwner = f.internal.captureRuntimeUpdateReportOwner();
    f.renew(patch);
    expect(() => f.scope.assertCurrent()).toThrow();
    expect(() => reportOwner()).toThrow();
  });

  it.each(["instance", "workspace", "runner", "root", "recovery", "authority epoch", "stopping"])("refuses a changed %s after renewal", kind => {
    const f = ownershipFixture();
    const reportOwner = f.internal.captureRuntimeUpdateReportOwner();
    f.renew();
    const changes: Record<string, () => void> = {
      instance: () => { f.internal.instanceId = "other"; }, workspace: () => { f.internal.workspaceId = "other"; },
      runner: () => { f.internal.runnerIncarnation = "successor"; },
      root: () => { f.internal.nativeOwnership = { assertOwned: vi.fn() }; },
      recovery: () => { f.accepted.generation = "replacement"; },
      "authority epoch": () => { f.internal.leaseAuthorityEpoch += 1; }, stopping: () => { f.internal.stopping = true; },
    };
    changes[kind]!();
    expect(() => f.scope.assertCurrent()).toThrow();
    expect(() => reportOwner()).toThrow();
  });

  it("refuses lost root ownership, expired/absent leases and a replaced socket", () => {
    const f = ownershipFixture();
    f.internal.nativeOwnership.assertOwned = () => { throw new Error("lost lock"); };
    expect(() => f.scope.assertCurrent()).toThrow("lost lock");
    f.internal.nativeOwnership.assertOwned = vi.fn();
    f.renew();
    f.clock.now += 120_000;
    expect(() => f.scope.assertCurrent()).toThrow();
    f.clock.now -= 120_000;
    f.supervisor.lease.set(null);
    expect(() => f.scope.assertCurrent()).toThrow();
    f.renew();
    f.connection.assertCurrent.mockImplementation(() => { throw new Error("socket replaced"); });
    expect(() => f.scope.assertCurrent()).toThrow("socket replaced");
  });

  it("refuses an unvalidated or mismatched lease record projection", () => {
    const f = ownershipFixture();
    const record = f.supervisor.lease.current()!;
    f.supervisor.lease.set({ ...record, lease: "not-a-lease" });
    expect(() => f.scope.assertCurrent()).toThrow();
    f.supervisor.lease.set({ ...record, expiresAt: new Date(f.clock.now + 90_000).toISOString() });
    expect(() => f.scope.assertCurrent()).toThrow();
  });
});

describe("signed runtime update renewal at durable admission barriers", () => {
  it("admits the original signed lease after a same-policy renewal and launches once", async () => {
    const f = receiverFixture();
    const signed = f.make();
    f.renew();
    await f.receiver.receive(signed, f.scope);
    await f.receiver.receive(signed, f.scope);
    expect(f.apply).toHaveBeenCalledOnce();
    expect((await f.store.read()).records).toEqual([expect.objectContaining({ intent: f.intent, state: "updating", reportPending: false })]);
  });

  it("survives renewal during Core's updating ACK without consuming it under a changed operation", async () => {
    const f = receiverFixture();
    const ack = Promise.withResolvers<{ accepted: boolean }>();
    f.report.mockImplementationOnce(() => ack.promise);
    const receiving = f.receiver.receive(f.make(), f.scope);
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce());
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "updating", reportPending: true });
    f.renew();
    ack.resolve({ accepted: true });
    await receiving;
    expect(f.apply).toHaveBeenCalledOnce();
    expect((await f.store.read()).records[0]).toMatchObject({ intent: f.intent, reportPending: false });
  });

  it("rechecks semantic renewal inside the persistence mutation lane", async () => {
    let renew = () => {};
    const f = receiverFixture(async operation => { const result = await operation(); renew(); return result; });
    renew = f.renew;
    await f.receiver.receive(f.make(), f.scope);
    expect(f.apply).toHaveBeenCalledOnce();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "updating", reportPending: false });
  });

  it("rechecks semantic renewal immediately before the updater would spawn", async () => {
    const f = receiverFixture();
    f.apply.mockImplementation(async (_reason, _target, assertCurrent) => {
      f.renew();
      assertCurrent!();
      return { started: true, reason: null, pid: 55, status: {} } as never;
    });
    await f.receiver.receive(f.make(), f.scope);
    expect((await f.store.read()).records[0]).toMatchObject({ state: "updating", reportPending: false });
    expect(f.report).toHaveBeenCalledOnce();
  });

  it.each(["socket", "policy", "recovery"])("does not launch or consume the admission ACK under changed %s", async kind => {
    const f = receiverFixture();
    f.report.mockImplementationOnce(async () => {
      const changes: Record<string, () => void> = {
        socket: () => { f.connection.assertCurrent.mockImplementation(() => { throw new Error("socket changed"); }); },
        policy: () => f.renew({ administrative_status: "draining" }),
        recovery: () => { f.accepted.generation = "changed"; },
      };
      changes[kind]!();
      return { accepted: true };
    });
    await f.receiver.receive(f.make(), f.scope).catch(() => undefined);
    expect(f.apply).not.toHaveBeenCalled();
    const record = (await f.store.read()).records[0]!;
    expect(record.intent).toEqual(f.intent);
    if (kind === "socket") {
      // A socket change denies admission, while the unchanged native report
      // owner may still acknowledge the resulting failure.
      expect(record.state).toBe("failed");
      expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed" }));
    } else expect(record.reportPending).toBe(true);
  });

  it("keeps the captured lease/signature window and refuses another frozen lease after renewal", async () => {
    const f = receiverFixture();
    f.renew();
    await expect(f.receiver.receive(f.make({ intent: { ...f.intent, leaseId: "renewed" } }), f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    const signed = f.make();
    f.clock.now += 30_000;
    await expect(f.receiver.receive(signed, f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    f.clock.now -= 30_000;
    f.adopt({ exp: f.baseClaims.iat + 5 });
    const shortScope = f.internal.runtimeUpdateScope(f.connection)!;
    f.renew();
    await expect(f.receiver.receive(f.make(), shortScope)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.apply).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual({ schemaVersion: 1, records: [], deliveries: [] });
  });

  it("still verifies signed target bytes before any renewal admission", async () => {
    const f = receiverFixture();
    const signed = f.make();
    f.renew();
    await expect(f.receiver.receive({ ...signed, intent: { ...f.intent, targetBundle: "8.0.0" } }, f.scope)).rejects.toMatchObject({ code: "permission_denied" });
    expect(f.apply).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual({ schemaVersion: 1, records: [], deliveries: [] });
  });
});

describe("terminal update reporting under a bounded drain-only owner", () => {
  it("flushes a retained failed terminal report under a freshly captured valid drain-only lease", async () => {
    const f = receiverFixture();
    await f.receiver.receive(f.make(), f.scope);
    const journal = await f.store.read();
    Object.assign(journal.records[0]!, { state: "failed", failure: "update_failed", reportPending: true });
    await f.store.write(journal, () => f.scope.assertCurrent());
    drainLease(f);
    f.report.mockClear();
    await f.receiver.recover();
    expect(f.report).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", failure: "update_failed" }));
    expect((await f.store.read()).records[0]).toMatchObject({ state: "failed", reportPending: false });
    expect(f.apply).toHaveBeenCalledOnce();
  });

  it("allows same-policy drain-only reporting renewal but rejects admission and a changed drain deadline", () => {
    const f = ownershipFixture();
    drainLease(f);
    const reportOwner = f.internal.captureRuntimeUpdateReportOwner();
    const scope = f.internal.runtimeUpdateScope(f.connection)!;
    drainLease(f, { jti: "renewed", iat: f.baseClaims.iat + 1 });
    expect(() => reportOwner()).not.toThrow();
    expect(() => scope.assertCurrent()).toThrow();
    drainLease(f, { jti: "later", iat: f.baseClaims.iat + 2,
      drain_deadline: new Date((f.baseClaims.exp + 61) * 1000).toISOString() });
    expect(() => reportOwner()).toThrow();
  });

  it("never retains a drain-only reporting owner beyond the captured matching drain deadline", () => {
    const f = ownershipFixture();
    drainLease(f);
    const reportOwner = f.internal.captureRuntimeUpdateReportOwner();
    f.clock.now = (f.baseClaims.exp + 60) * 1000;
    expect(() => reportOwner()).toThrow();
    expect(() => f.internal.captureRuntimeUpdateReportOwner()).toThrow();
  });
});
