import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ed25519Sign, FixedClock, generateEd25519, generateInstanceKey, remoteControlSigningBytes, type JsonValue } from "@konteks/remote-common";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { RuntimeUpdateReceiver } from "../native/runtime-update.js";
import { RuntimeUpdateStore } from "../native/runtime-update-store.js";
import type { NativeUpdateLedger } from "../native/update-ledger.js";
import type { StateMutation } from "../state/mutation-gate.js";
import type { NativeUpdateCoordinator } from "../native/update.js";
import { CoreClient } from "../core/client.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "runtime-update-proof-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture(mutate?: StateMutation) {
  const keys = generateEd25519();
  const verifier = new CoreSignatureVerifier([{ keyId: "release", publicKeyJwk: generateEd25519().publicJwk,
    coreControlKeys: [{ keyId: "control", publicKeyJwk: keys.publicJwk }] }]);
  const clock = { now: Date.parse("2026-10-01T00:00:00Z") };
  const path = join(dir, "updates.json");
  const store = new RuntimeUpdateStore(path, mutate);
  const intent = { updateId: "update", instanceId: "instance", tenantId: "tenant", leaseId: "lease", runnerIncarnation: "runner",
    targetBundle: "1.1.0", manifestDigest: "a".repeat(43), deadlineAt: new Date(clock.now + 60_000).toISOString() };
  const scope = { instanceId: "instance", tenantId: "tenant", leaseId: "lease", runnerIncarnation: "runner", connectionEpoch: 5,
    leaseExpiresAt: new Date(clock.now + 60_000).toISOString(), assertCurrent: vi.fn() };
  const proof = { bundleVersion: "1.0.0", manifestDigest: "b".repeat(43), runnerIncarnation: "runner", ready: true };
  const ledger: NativeUpdateLedger = { schemaVersion: 1, attempts: [] };
  const apply = vi.fn<NativeUpdateCoordinator["apply"]>(async (_reason, _target, assertCurrent) => { assertCurrent!(); return { started: true, reason: null, pid: 55, status: {} } as never; });
  const report = vi.fn(async () => ({ accepted: true }));
  const assertReportOwner = vi.fn();
  const reportOwner = { generation: 0 };
  const captureReportOwner = vi.fn(() => {
    const generation = reportOwner.generation;
    return () => {
      assertReportOwner();
      if (reportOwner.generation !== generation) throw new Error("report owner changed");
    };
  });
  const receiver = () => new RuntimeUpdateReceiver({ verifier, store: new RuntimeUpdateStore(path, mutate), coordinator: () => ({ apply }),
    now: () => clock.now, proof: () => proof, readLedger: async () => ledger, report, captureReportOwner });
  const sign = (body: Record<string, JsonValue>) => ({ ...body, signature: ed25519Sign(keys.privateKey, remoteControlSigningBytes(body)) });
  const make = (overrides: Record<string, JsonValue> = {}) => sign({ type: "runtime_update_delivery", method: "POST", path: { instanceId: "instance" },
    nodeId: "node", connectionRef: "connection", connectionEpoch: 5, intent, keyId: "control", nonce: "N".repeat(22),
    issuedAt: new Date(clock.now).toISOString(), expiresAt: new Date(clock.now + 30_000).toISOString(), ...overrides });
  return { clock, path, store, intent, scope, proof, ledger, apply, report, assertReportOwner, reportOwner, captureReportOwner, receiver, make };
}

function completeLauncherUpdate(f: ReturnType<typeof fixture>): void {
  f.ledger.attempts.push({ id: "replacement", bundleVersion: f.intent.targetBundle, manifestDigest: f.intent.manifestDigest, releaseId: "release", reason: "unattended",
    startedAt: new Date(f.clock.now).toISOString(), finishedAt: new Date(f.clock.now + 1).toISOString(), outcome: "applied", detail: null });
}

describe("fixed signed site runtime updates", () => {
  it("reports only the bounded fixed action through the current runtime's authenticated Core endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: true })));
    const core = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-10-01T00:00:00Z")),
      key: () => generateInstanceKey(), credential: () => "current-runtime-lease", fetchFn });
    const report = { updateId: "update", targetBundle: "1.1.0", manifestDigest: "a".repeat(43), state: "succeeded" as const };
    expect(await core.reportRuntimeUpdate("instance", report)).toEqual({ accepted: true });
    const [url, options] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/runtime-updates/report");
    expect(JSON.parse(String(options.body))).toEqual(report);
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer current-runtime-lease");
    await expect(core.reportRuntimeUpdate("instance", { ...report, output: "private logs" } as never)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("verifies the exact signed intent and current lease, instance, runner and epoch before touching disk", async () => {
    const f = fixture(), receiver = f.receiver();
    const signed = f.make();
    await expect(receiver.receive({ ...signed, intent: { ...f.intent, targetBundle: "8.0.0" } }, f.scope)).rejects.toMatchObject({ code: "permission_denied" });
    for (const field of ["tenantId", "instanceId", "leaseId", "runnerIncarnation"] as const) {
      await expect(receiver.receive(f.make({ intent: { ...f.intent, [field]: "foreign" }, path: { instanceId: field === "instanceId" ? "foreign" : "instance" } }), f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    }
    await expect(receiver.receive(f.make({ connectionEpoch: 6 }), f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    await expect(receiver.receive({ ...f.make(), command: "arbitrary" }, f.scope)).rejects.toMatchObject({ code: "permission_denied" });
    expect(await f.store.read()).toEqual({ schemaVersion: 1, records: [], deliveries: [] });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("refuses an expired or future delivery even with a valid signature", async () => {
    const f = fixture(), receiver = f.receiver();
    const delivery = f.make();
    f.clock.now += 30_000;
    await expect(receiver.receive(delivery, f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    await expect(receiver.receive(f.make({ issuedAt: new Date(f.clock.now + 1_001).toISOString() }), f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("accepts whole-second HTTP Date rounding without extending delivery expiry", async () => {
    const f = fixture();
    const coreNow = f.clock.now + 500;
    const clock = new FixedClock(coreNow);
    clock.observeCoreTime(f.clock.now, 0); // HTTP Date omits fractional seconds.
    f.clock.now = clock.coreNow();
    const delivery = f.make({ issuedAt: new Date(coreNow).toISOString() });
    await f.receiver().receive(delivery, f.scope);
    expect(f.apply).toHaveBeenCalledTimes(1);
    f.clock.now = Date.parse(String(delivery.expiresAt));
    await expect(f.receiver().receive(delivery, f.scope)).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("refuses a valid signed proof that outlives the current lease", async () => {
    const f = fixture();
    f.scope.leaseExpiresAt = new Date(f.clock.now + 5_000).toISOString();
    await expect(f.receiver().receive(f.make(), f.scope)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.apply).not.toHaveBeenCalled();
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists before launching and never launches a duplicate, including after restarting the receiver", async () => {
    const f = fixture(), receiver = f.receiver();
    f.apply.mockImplementation(async (_reason, target, assertCurrent) => {
      assertCurrent!();
      expect((await f.store.read()).records).toEqual([expect.objectContaining({ state: "updating", intent: f.intent })]);
      expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: "updating" }));
      expect((await f.store.read()).records[0]?.reportPending).toBe(false);
      expect(target).toEqual({ bundleVersion: f.intent.targetBundle, manifestDigest: f.intent.manifestDigest });
      return { started: true, reason: null, pid: 55, status: {} } as never;
    });
    await Promise.all([receiver.receive(f.make(), f.scope), receiver.receive(f.make(), f.scope)]);
    await f.receiver().receive(f.make({ nonce: "R".repeat(22) }), f.scope);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenCalledWith({ updateId: "update", targetBundle: "1.1.0", manifestDigest: "a".repeat(43), state: "updating" });
    await expect(receiver.receive(f.make({ intent: { ...f.intent, manifestDigest: "c".repeat(43) } }), f.scope)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("cannot launch until Core durably accepts updating, and a lost admission ACK causes no replacement", async () => {
    const f = fixture();
    const admission = Promise.withResolvers<{ accepted: boolean }>();
    f.report.mockImplementationOnce(() => admission.promise);
    const receiving = f.receiver().receive(f.make(), f.scope);
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: "updating" })));
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "updating", reportPending: true });
    admission.resolve({ accepted: false });
    await receiving;
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", failure: "unavailable" }));
  });

  it("rechecks the exact lease/socket after Core's updating admission and refuses a stale owner before launch", async () => {
    const f = fixture();
    f.report.mockImplementationOnce(async () => {
      f.scope.assertCurrent.mockImplementation(() => { throw new Error("owner changed"); });
      return { accepted: true };
    });
    await f.receiver().receive(f.make(), f.scope);
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "failed" });
  });

  it("an interrupted admission record is never re-executed by a restarted observer", async () => {
    let writes = 0;
    const f = fixture(async operation => {
      writes += 1;
      if (writes === 3) throw new Error("process interrupted after Core admission");
      return operation();
    });
    f.assertReportOwner.mockImplementation(() => { if (writes >= 3) throw new Error("process ended"); });
    await expect(f.receiver().receive(f.make(), f.scope)).rejects.toThrow("process ended");
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "updating", reportPending: true });
    f.assertReportOwner.mockReset();
    await f.receiver().recover();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("refuses a reused proof for a different signed operation", async () => {
    const f = fixture(), receiver = f.receiver();
    await receiver.receive(f.make(), f.scope);
    await expect(receiver.receive(f.make({ intent: { ...f.intent, updateId: "other" } }), f.scope)).rejects.toMatchObject({ code: "permission_denied" });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it("revalidates ownership under the persistence lane so an asynchronous lease/socket change prevents launch", async () => {
    let changeOwner = () => {};
    const f = fixture(async operation => { const result = await operation(); changeOwner(); return result; });
    changeOwner = () => { f.scope.assertCurrent.mockImplementation(() => { throw new Error("owner changed"); }); };
    await expect(f.receiver().receive(f.make(), f.scope)).rejects.toThrow("owner changed");
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.read()).records[0]?.state).toBe("requested");
  });

  it("refuses an unreadable durable history instead of permitting replay", async () => {
    const f = fixture();
    await writeFile(f.path, "{broken");
    await expect(f.receiver().receive(f.make(), f.scope)).rejects.toThrow();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it.each(["busy", "stale_target", "unavailable"] as const)("reports the bounded %s refusal", async failure => {
    const f = fixture();
    f.apply.mockResolvedValue({ started: false, reason: failure, pid: null, status: {} } as never);
    await f.receiver().receive(f.make(), f.scope);
    expect(f.report).toHaveBeenLastCalledWith({ updateId: "update", targetBundle: "1.1.0", manifestDigest: "a".repeat(43), state: "failed", failure });
  });

  it("recovers across restart and retries the terminal report without launching again", async () => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    completeLauncherUpdate(f);
    f.proof.bundleVersion = "1.1.0";
    f.proof.runnerIncarnation = "successor";
    await f.receiver().recover(); // Same version with different bytes cannot prove success.
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
    f.proof.manifestDigest = f.intent.manifestDigest;
    f.proof.ready = false;
    await f.receiver().recover(); // Candidate still under the launcher's health gate.
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
    f.proof.ready = true;
    f.report.mockRejectedValueOnce(new Error("HTTP unavailable"));
    await f.receiver().recover();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "succeeded", reportPending: true });
    await f.receiver().recover();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "succeeded", reportPending: false });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it("coalesces pending outcome reports so an unavailable Core cannot accumulate recovery polls", async () => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    completeLauncherUpdate(f);
    Object.assign(f.proof, { bundleVersion: "1.1.0", manifestDigest: f.intent.manifestDigest, runnerIncarnation: "successor" });
    const acknowledgement = Promise.withResolvers<{ accepted: boolean }>();
    f.report.mockImplementationOnce(() => acknowledgement.promise);
    const receiver = f.receiver();
    const one = receiver.recover();
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" })));
    const two = receiver.recover(), three = receiver.recover();
    expect(two).toBe(one); expect(three).toBe(one);
    acknowledgement.resolve({ accepted: true });
    await Promise.all([one, two, three]);
    expect(f.report).toHaveBeenCalledTimes(2); // One admission plus one terminal report.
  });

  it("does not consume a terminal receipt under a changed report owner and retries under fresh authority", async () => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    completeLauncherUpdate(f);
    Object.assign(f.proof, { bundleVersion: "1.1.0", manifestDigest: f.intent.manifestDigest, runnerIncarnation: "successor" });
    const acknowledgement = Promise.withResolvers<{ accepted: boolean }>();
    f.report.mockImplementationOnce(() => acknowledgement.promise);
    const recovering = f.receiver().recover();
    await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" })));
    f.reportOwner.generation += 1;
    acknowledgement.resolve({ accepted: true });
    await expect(recovering).rejects.toThrow("report owner changed");
    expect((await f.store.read()).records[0]).toMatchObject({ state: "succeeded", reportPending: true });
    await f.receiver().recover();
    expect((await f.store.read()).records[0]).toMatchObject({ state: "succeeded", reportPending: false });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it("does not report success while the replacement is still inside the launcher's health gate", async () => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    Object.assign(f.proof, { bundleVersion: "1.1.0", manifestDigest: f.intent.manifestDigest, runnerIncarnation: "successor" });
    await f.receiver().recover(); // An unreadable/missing ledger is never completion evidence.
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
    completeLauncherUpdate(f);
    Object.assign(f.ledger.attempts[0]!, { outcome: "in_progress", finishedAt: null });
    await f.receiver().recover();
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
    Object.assign(f.ledger.attempts[0]!, { outcome: "applied", finishedAt: new Date(f.clock.now + 1).toISOString() });
    await f.receiver().recover();
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "succeeded" }));
  });

  it("a healthy original process and updater exit never attest a successful replacement", async () => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    Object.assign(f.proof, { bundleVersion: "1.1.0", manifestDigest: f.intent.manifestDigest });
    await f.receiver().recover();
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
  });

  it.each(["failed", "rolled_back"] as const)("recovers a %s launcher result as update_failed without exposing its output", async outcome => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    f.ledger.attempts.push({ id: "attempt", bundleVersion: f.intent.targetBundle, manifestDigest: f.intent.manifestDigest, releaseId: "release", reason: "unattended",
      startedAt: new Date(f.clock.now).toISOString(), finishedAt: new Date(f.clock.now + 1).toISOString(), outcome, detail: "private tool output" });
    await f.receiver().recover();
    expect(f.report).toHaveBeenLastCalledWith({ updateId: "update", targetBundle: "1.1.0", manifestDigest: "a".repeat(43), state: "failed", failure: "update_failed" });
    expect(JSON.stringify(f.report.mock.calls)).not.toContain("private tool output");
  });

  it("never attributes an earlier failed attempt to the new action, even with skewed Core/local clocks", async () => {
    const f = fixture();
    f.ledger.attempts.push({ id: "previous", bundleVersion: f.intent.targetBundle, manifestDigest: f.intent.manifestDigest, releaseId: "release", reason: "unattended",
      startedAt: new Date(f.clock.now + 60_000).toISOString(), finishedAt: new Date(f.clock.now + 61_000).toISOString(), outcome: "failed", detail: "prior attempt" });
    await f.receiver().receive(f.make(), f.scope);
    await f.receiver().recover();
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }));
    expect((await f.store.read()).records[0]).toMatchObject({ state: "updating", knownAttemptIds: ["previous"] });
  });

  it("an interrupted requested/updating action expires without re-executing it", async () => {
    const f = fixture();
    await f.receiver().receive(f.make(), f.scope);
    f.clock.now += 60_000;
    await f.receiver().recover();
    expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", failure: "timed_out" }));
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
});
