import { afterEach, expect, it, vi } from "vitest";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";
import type { RelayRuntimeHandshakeResult } from "@konteks/remote-common";

// Composition test: no bridge, listener, filesystem mutation or cloud request.
interface StartupInternals {
  startActiveLoop(): Promise<void>;
  recoveryAuthority(): string | null;
  captureLeaseFence(): () => void;
  validateRelayHandshake(result: RelayRuntimeHandshakeResult): void;
  onRelayConnected(result: RelayRuntimeHandshakeResult): Promise<void>;
  stopping: boolean;
  nativeOwnership: { assertOwned(): void } | null;
  instanceId: string;
  runnerIncarnation: string;
  activeLoopStarted: boolean;
  ordinaryHeartbeatStarted: boolean;
  administrativeStatus: "active" | "provisioning";
  refreshConfiguration(): Promise<void>;
  openCoreChannels(): void;
}
function fixture() {
  vi.useFakeTimers();
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: "/unused-native-startup-fixture", SUPERVISOR_CORE_URL: "https://core.example" }));
  const internal = supervisor as unknown as StartupInternals;
  const events: string[] = [];
  let complete = false;
  const record = { state: "applied", intent: { instanceId: "instance", runnerIncarnation: internal.runnerIncarnation }, manifest: { manifestId: "manifest", ownerRevision: 1 }, receipt: { digest: "digest" }, acceptedAt: "2026-09-06T00:00:00Z" };
  internal.instanceId = "instance";
  vi.spyOn(supervisor.store, "provisioning").mockResolvedValue(null);
  internal.nativeOwnership = { assertOwned: vi.fn() };
  internal.openCoreChannels = vi.fn();
  // The managed-git binding reload reads the key store from disk; under fake
  // timers that real I/O would never settle before a retry is asserted.
  internal.reloadManagedGitBinding = vi.fn(async () => undefined);
  internal.refreshConfiguration = vi.fn(async () => { events.push("configuration"); });
  const run = vi.fn(async () => { events.push("recovery"); complete = true; });
  supervisor.reconciliation = { run, get isComplete() { return complete; } } as never;
  vi.spyOn(supervisor.journal.recovery, "current").mockImplementation(() => record as never);
  vi.spyOn(supervisor.lease, "isValid").mockReturnValue(true);
  vi.spyOn(supervisor.lease, "mode").mockReturnValue("active");
  const heartbeatStart = vi.fn(async () => { events.push("heartbeat"); });
  supervisor.heartbeat = { start: heartbeatStart, settle: vi.fn(async () => undefined), stop: vi.fn() } as never;
  const transportStart = vi.fn(() => { events.push("transport"); });
  supervisor.transport = { start: transportStart, resumeAfterRecovery: vi.fn(() => { events.push("replay"); }) } as never;
  const flushAll = vi.fn(async () => { events.push("reports"); });
  const pull = vi.fn();
  supervisor.work = { reports: { flushAll }, pull } as never;
  supervisor.relay = null;
  return { supervisor, internal, events, run, heartbeatStart, transportStart, flushAll, pull, record, setComplete: (value: boolean) => { complete = value; } };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("clears uncertain provisioning only after accepted signed recovery", async () => {
  const f = fixture();
  const identity = { instanceId: "instance", workspaceId: "tenant", activationId: "activation", activatedAt: "2026-09-06T00:00:00Z", administrativeStatus: "provisioning" as const, exchangeNonce: "nonce" };
  vi.mocked(f.supervisor.store.provisioning).mockResolvedValue({ provisioningCredential: "test-expired", provisioningCredentialExpiresAt: "2026-09-06T00:00:00Z", provisioningWindowExpiresAt: "2027-09-06T00:00:00Z", manifestDigest: "digest", lastRefreshAt: null });
  vi.spyOn(f.supervisor.store, "identity").mockResolvedValue(identity);
  const save = vi.spyOn(f.supervisor.store, "saveIdentity").mockResolvedValue();
  const clear = vi.spyOn(f.supervisor.store, "clearProvisioning").mockResolvedValue();
  f.run.mockRejectedValueOnce(new Error("Core has not accepted recovery"));
  await f.internal.startActiveLoop();
  expect(save).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  f.internal.administrativeStatus = "active"; // accepted lease adoption
  await f.internal.startActiveLoop();
  expect(save).toHaveBeenCalledWith({ ...identity, administrativeStatus: "active" });
  expect(clear).toHaveBeenCalledOnce();
});

it("establishes accepted recovery before ordinary heartbeat, transport, replay and reports", async () => {
  const f = fixture();
  await f.internal.startActiveLoop();
  expect(f.events).toEqual(["recovery", "configuration", "heartbeat", "transport", "replay", "reports"]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.pull).toHaveBeenCalledOnce();
});

it("coalesces concurrent startup and does not repeat initialization after acceptance", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  f.run.mockImplementation(async () => { await gate.promise; f.setComplete(true); });
  const one = f.internal.startActiveLoop(), two = f.internal.startActiveLoop();
  expect(f.heartbeatStart).not.toHaveBeenCalled();
  gate.resolve();
  await Promise.all([one, two]);
  await f.internal.startActiveLoop();
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.heartbeatStart).toHaveBeenCalledOnce();
  expect(f.transportStart).toHaveBeenCalledOnce();
});

it("failed recovery starts no ordinary loop and retries once on the bounded timer", async () => {
  const f = fixture();
  f.run.mockRejectedValueOnce(new Error("receipt response lost"));
  await f.internal.startActiveLoop();
  expect(f.heartbeatStart).not.toHaveBeenCalled();
  expect(f.transportStart).not.toHaveBeenCalled();
  expect(f.flushAll).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.heartbeatStart).toHaveBeenCalledOnce();
});

it.each(["expired", "superseded", "establishment_conflict"])("does not automatically recreate a %s recovery", async state => {
  const f = fixture();
  f.run.mockImplementation(async () => { f.record.state = state; throw new Error("explicit recovery required"); });
  await f.internal.startActiveLoop();
  await vi.advanceTimersByTimeAsync(45000);
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.transportStart).not.toHaveBeenCalled();
});

it("stop during recovery cannot start ordinary work or schedule a retry", async () => {
  const f = fixture();
  f.run.mockImplementation(async () => { f.internal.stopping = true; f.setComplete(true); });
  await f.internal.startActiveLoop();
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.heartbeatStart).not.toHaveBeenCalled();
  expect(f.transportStart).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledOnce();
});

it("lost root ownership after recovery cannot release ordinary work", async () => {
  const f = fixture();
  f.run.mockImplementation(async () => { f.setComplete(true); f.internal.nativeOwnership = null; });
  await f.internal.startActiveLoop();
  expect(f.heartbeatStart).not.toHaveBeenCalled();
  expect(f.transportStart).not.toHaveBeenCalled();
});

it("retains the ordinary publisher transition when authority is lost during heartbeat start", async () => {
  const f = fixture();
  f.heartbeatStart.mockImplementationOnce(async () => { f.setComplete(false); });
  await f.internal.startActiveLoop();
  expect(f.internal.ordinaryHeartbeatStarted).toBe(true);
  expect(f.transportStart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.heartbeatStart).toHaveBeenCalledOnce();
  expect(f.transportStart).toHaveBeenCalledOnce();
});

it("authority requires current durable receipt, root ownership and live lease", () => {
  const f = fixture();
  expect(f.internal.recoveryAuthority()).toBeNull();
  f.setComplete(true);
  const authority = f.internal.recoveryAuthority();
  expect(authority).toBeTypeOf("string");
  f.record.manifest.ownerRevision++;
  expect(f.internal.recoveryAuthority()).not.toBe(authority);
  f.record.acceptedAt = null as never;
  expect(f.internal.recoveryAuthority()).toBeNull();
  f.record.acceptedAt = "2026-09-06T00:00:00Z";
  vi.mocked(f.supervisor.lease.isValid).mockReturnValue(false);
  expect(f.internal.recoveryAuthority()).toBeNull();
  vi.mocked(f.supervisor.lease.isValid).mockReturnValue(true);
  f.internal.nativeOwnership!.assertOwned = () => { throw new Error("lost"); };
  expect(f.internal.recoveryAuthority()).toBeNull();
});

it("closes transport authority at the effective drain deadline despite an unexpired token", () => {
  const f = fixture();
  f.setComplete(true);
  vi.mocked(f.supervisor.lease.mode).mockReturnValue("drain_only");
  expect(f.internal.recoveryAuthority()).not.toBeNull();
  vi.mocked(f.supervisor.lease.mode).mockReturnValue("none");
  expect(f.supervisor.lease.isValid()).toBe(true);
  expect(f.internal.recoveryAuthority()).toBeNull();
});

it("the heartbeat lease fence includes live native root ownership", () => {
  const f = fixture();
  const assertCurrent = f.internal.captureLeaseFence();
  expect(() => assertCurrent()).not.toThrow();
  f.internal.nativeOwnership = null;
  expect(() => assertCurrent()).toThrow();
});

it("matching transport-only handshakes reuse accepted recovery without rerunning decisions", async () => {
  const f = fixture();
  f.setComplete(true);
  const result = { connectionEpoch: 2, resume: {}, reset: [], runtimeReconciliation: { state: "confirmed", manifestId: "manifest", receiptDigest: "digest", acceptedAt: f.record.acceptedAt } } as RelayRuntimeHandshakeResult;
  await f.internal.onRelayConnected(result);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.events).toEqual(["replay", "reports"]);
});

it.each(["manifestId", "receiptDigest", "acceptedAt"] as const)("rejects relay confirmation with a changed %s", field => {
  const f = fixture();
  f.setComplete(true);
  const result = { connectionEpoch: 2, resume: {}, reset: [], runtimeReconciliation: { state: "confirmed", manifestId: "manifest", receiptDigest: "digest", acceptedAt: f.record.acceptedAt, [field]: "different" } } as RelayRuntimeHandshakeResult;
  expect(() => f.internal.validateRelayHandshake(result)).toThrow();
  expect(f.flushAll).not.toHaveBeenCalled();
});
