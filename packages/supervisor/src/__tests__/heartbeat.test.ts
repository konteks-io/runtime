import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, computeAgentModelOfferedValuesSnapshotDigest, generateInstanceKey, verifyInstanceProof } from "@konteks/remote-common";
import { HeartbeatPublisher, type HeartbeatOptions } from "../heartbeat/heartbeat.js";
import { SupervisorStore } from "../state/store.js";
import { CORE_AUDIENCE } from "../core/client.js";

let root: string;
const publishers: HeartbeatPublisher[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "heartbeat-")); });
afterEach(async () => { for (const publisher of publishers.splice(0)) { publisher.stop(); await publisher.settle(); } vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const store = new SupervisorStore(root); await store.init(); await store.saveHeartbeatSequence(7);
  const key = generateInstanceKey(), clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const result = { instanceId: "instance", lease: "renewed", leaseExpiresAt: "2026-09-06T00:10:00Z", leaseMode: "active" as const, roles: [], strippedRoles: [], configRevision: 0, heartbeatIntervalSeconds: 15 };
  const heartbeat = vi.fn(async (_body: unknown) => result);
  const transport = { send: vi.fn(), activeKind: "relay" };
  const onResult = vi.fn(async () => undefined), onFailure = vi.fn(async () => undefined);
  const inventory = { collect: vi.fn(async () => ({ components: [], agents: [], browserToolAvailable: false, hostPressure: 0, activeSessions: 0, activeTurns: 0 })) };
  const options = { store, key: () => key, clock, instanceId: () => "instance", inventory, roleBindings: () => [], activeAssignmentIds: () => [], modelCapabilitySnapshots: () => [], configRevision: () => 0, bundleVersion: "1.0.0", softMaxConcurrent: () => undefined, acceptingWork: () => true, intervalSeconds: () => 15, renewalDelayMs: () => 5000, core: { heartbeat }, transport, onResult, onFailure };
  const publisher = new HeartbeatPublisher({ ...options, runnerIncarnation: () => "process" } as HeartbeatOptions); publishers.push(publisher);
  return { store, key, heartbeat, transport, inventory, onResult, onFailure, publisher, result, options };
}
describe("signed HTTPS heartbeat lifecycle", () => {
  it("honors a floor reserved after publisher startup and signs the actual process", async () => {
    const f = await fixture(); await f.publisher.start();
    await f.store.reserveHeartbeatFloor(20);
    const message = await f.publisher.publish();
    expect(message.sequence).toBe(21);
    expect(message.runnerIncarnation).toBe("process");
    expect(await f.store.heartbeatSequence()).toBe(21);
  });
  it("persists the monotonic sequence before HTTPS, even when relay is active, and awaits lease adoption", async () => {
    const f = await fixture();
    f.heartbeat.mockImplementationOnce(async body => {
      const { signature, ...message } = body as Record<string, unknown>;
      expect(await f.store.heartbeatSequence()).toBe(8);
      expect(verifyInstanceProof(f.key.publicKey, { method: "heartbeat", audience: CORE_AUDIENCE, subject: "instance", body: message as never }, { algorithm: "ES256", nonce: "seq:8", signature: signature as string })).toBe(true);
      return f.result;
    });
    await f.publisher.start(); await f.publisher.publish();
    expect(f.heartbeat).toHaveBeenCalledOnce();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.onResult).toHaveBeenCalledWith(f.result, expect.any(Function));
  });
  it("includes current model snapshots only inside the signed heartbeat body", async () => {
    const f = await fixture();
  const body = { version: 1 as const, snapshotId: "snapshot", snapshotRevision: 1, instanceId: "instance", agentId: "claude-code", authIdentityFingerprint: "identity-a", runnerIncarnation: "process", manifestId: "manifest", mappingId: "mapping", mappingRevision: 1, mappingDigest: "B".repeat(43), configId: "model", currentValue: "sonnet", offeredValues: ["sonnet"], observedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-06T00:05:00Z" };
    const snapshot = { ...body, snapshotDigest: computeAgentModelOfferedValuesSnapshotDigest(body) };
    f.options.modelCapabilitySnapshots = () => [snapshot];
    const publisher = new HeartbeatPublisher({ ...f.options, runnerIncarnation: () => "process" } as HeartbeatOptions); publishers.push(publisher);
    await publisher.start(); const message = await publisher.publish();
    expect(message.modelCapabilitySnapshots).toEqual([snapshot]);
  });
  it("joins concurrent publishes and does not reuse a failed request's sequence", async () => {
    const f = await fixture(), gate = Promise.withResolvers<typeof f.result>();
    f.heartbeat.mockImplementationOnce(() => gate.promise);
    await f.publisher.start();
    const first = f.publisher.publish(), second = f.publisher.publish();
    await vi.waitFor(() => expect(f.heartbeat).toHaveBeenCalledOnce());
    gate.resolve(f.result); await Promise.all([first, second]);
    expect(await f.store.heartbeatSequence()).toBe(8);
    f.heartbeat.mockRejectedValueOnce(new Error("lost response"));
    await expect(f.publisher.publish()).rejects.toThrow("lost response");
    await f.publisher.publish();
    expect(await f.store.heartbeatSequence()).toBe(10);
    expect(f.onFailure).toHaveBeenCalledOnce();
  });
  it("does not adopt an in-flight response or restart its timer after stop", async () => {
    const f = await fixture(), gate = Promise.withResolvers<typeof f.result>();
    f.heartbeat.mockImplementationOnce(() => gate.promise);
    await f.publisher.start(); const pending = f.publisher.publish();
    await vi.waitFor(() => expect(f.heartbeat).toHaveBeenCalledOnce());
    f.publisher.stop(); gate.resolve(f.result); await pending;
    expect(f.onResult).not.toHaveBeenCalled();
    await expect(f.publisher.publish()).rejects.toThrow();
    expect(f.heartbeat).toHaveBeenCalledOnce();
  });
  it("never sends after failed sequence persistence, and resumes above the durable sequence on restart", async () => {
    const f = await fixture(); await f.publisher.start();
    vi.spyOn(f.store, "allocateHeartbeatSequence").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.publisher.publish()).rejects.toThrow("disk unavailable"); expect(f.heartbeat).not.toHaveBeenCalled();
    await f.publisher.publish(); expect(await f.store.heartbeatSequence()).toBe(8);
    f.publisher.stop(); await f.publisher.settle();
    const restored = new HeartbeatPublisher({ ...f.options, runnerIncarnation: () => "successor" } as HeartbeatOptions); publishers.push(restored);
    await restored.start(); await restored.publish(); expect(await f.store.heartbeatSequence()).toBe(9);
  });
  it("uses the earlier lease deadline with one bounded periodic timer", async () => {
    const f = await fixture(); vi.useFakeTimers();
    await f.publisher.start(); await f.publisher.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4999); expect(f.inventory.collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.inventory.collect).toHaveBeenCalledOnce();
    f.publisher.stop();
    // Let the filesystem work from the fired heartbeat settle before teardown.
    vi.useRealTimers(); await f.publisher.settle(); expect(f.heartbeat).not.toHaveBeenCalled();
  });
});
