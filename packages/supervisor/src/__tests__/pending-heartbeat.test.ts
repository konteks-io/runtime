import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof, REMOTE_INSTANCE_PROOF_AUDIENCE, type HeartbeatMessage } from "@konteks/remote-common";
import { HeartbeatPublisher, type HeartbeatOptions } from "../heartbeat/heartbeat.js";
import { SupervisorStore } from "../state/store.js";

let root: string;
const publishers: HeartbeatPublisher[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pending-heartbeat-")); });
afterEach(async () => { for (const publisher of publishers.splice(0)) { publisher.stop(); await publisher.settle(); } vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const store = new SupervisorStore(root); await store.init(); await store.reserveHeartbeatFloor(20);
  const key = generateInstanceKey(), clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const identity = { instanceId: "instance", incarnation: "process", epoch: 1 };
  const result = { instanceId: "instance", lease: "renewed", leaseExpiresAt: "2026-09-06T00:10:00Z", leaseMode: "active" as const, roles: [], strippedRoles: [], configRevision: 0, heartbeatIntervalSeconds: 15 };
  const heartbeat = vi.fn(async (_body: HeartbeatMessage & { signature: string }) => result);
  const inventory = { collect: vi.fn(async () => ({ components: [], agents: [], hostPressure: 0, activeSessions: 0, activeTurns: 0 })) };
  const onResult = vi.fn(async (_result: typeof result, assertCurrent: () => void) => { assertCurrent(); });
  const onFailure = vi.fn(async (_error: unknown) => undefined);
  const options: HeartbeatOptions = { store, key: () => key, clock, instanceId: () => identity.instanceId, runnerIncarnation: () => identity.incarnation,
    inventory, core: { heartbeat }, onResult, onFailure,
    captureLeaseFence: () => { const epoch = identity.epoch; return () => { if (identity.epoch !== epoch) throw new Error("lease authority changed"); }; },
    withLeaseAcquisition: operation => operation(),
    roleBindings: () => [], activeAssignmentIds: () => ["assignment"], configRevision: () => 4, bundleVersion: "1.0.0", softMaxConcurrent: () => undefined, acceptingWork: () => true, intervalSeconds: () => 15, renewalDelayMs: () => 5000 };
  const publisher = new HeartbeatPublisher(options); publishers.push(publisher);
  return { store, key, identity, heartbeat, inventory, onResult, onFailure, options, publisher, result };
}

describe("pending recovery signed HTTPS heartbeat", () => {
  it("publishes real signed inventory above the durable floor before start, without accepting work or scheduling", async () => {
    const f = await fixture(); vi.useFakeTimers();
    f.heartbeat.mockImplementationOnce(async body => {
      const { signature, ...message } = body;
      expect(await f.store.heartbeatSequence()).toBe(21);
      expect(verifyInstanceProof(f.key.publicKey, { method: "heartbeat", audience: REMOTE_INSTANCE_PROOF_AUDIENCE, subject: "instance", body: message as never }, { algorithm: "ES256", nonce: "seq:21", signature })).toBe(true);
      return f.result;
    });
    const message = await f.publisher.publishPending();
    expect(message).toMatchObject({ instanceId: "instance", runnerIncarnation: "process", sequence: 21, configRevision: 4, activeAssignmentIds: ["assignment"], utilization: { acceptingWork: false } });
    expect(f.inventory.collect).toHaveBeenCalledTimes(1); expect(f.onResult).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(f.publisher.publish()).rejects.toThrow();
  });

  it("coalesces only pending calls and prevents normal scheduling during their flight", async () => {
    const f = await fixture(), gate = Promise.withResolvers<typeof f.result>();
    f.heartbeat.mockImplementationOnce(() => gate.promise);
    const first = f.publisher.publishPending(), second = f.publisher.publishPending();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.heartbeat).toHaveBeenCalledTimes(1));
    await expect(f.publisher.start()).rejects.toThrow();
    gate.resolve(f.result); await first;
    expect(await f.store.heartbeatSequence()).toBe(21);
    await f.publisher.start();
  });

  it("never joins an ordinary accepting-work heartbeat", async () => {
    const f = await fixture(), gate = Promise.withResolvers<typeof f.result>();
    f.heartbeat.mockImplementationOnce(() => gate.promise);
    await f.publisher.start(); const ordinary = f.publisher.publish();
    await vi.waitFor(() => expect(f.heartbeat).toHaveBeenCalledTimes(1));
    try { await expect(f.publisher.publishPending()).rejects.toThrow(); }
    finally { gate.resolve(f.result); await ordinary; }
    expect(f.heartbeat.mock.calls[0]?.[0].utilization.acceptingWork).toBe(true);
  });

  it("waits on the existing acquisition lane before collecting or allocating", async () => {
    const f = await fixture(), lane = Promise.withResolvers<void>();
    f.options.withLeaseAcquisition = async operation => { await lane.promise; return operation(); };
    const pending = f.publisher.publishPending(); await Promise.resolve();
    expect(f.inventory.collect).not.toHaveBeenCalled(); expect(await f.store.heartbeatSequence()).toBe(20);
    lane.resolve(); await pending;
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
  });

  it.each(["lease", "instance", "incarnation"] as const)("rejects a late response after %s authority changes", async cause => {
    const f = await fixture(), gate = Promise.withResolvers<typeof f.result>();
    f.heartbeat.mockImplementationOnce(() => gate.promise);
    const pending = f.publisher.publishPending();
    await vi.waitFor(() => expect(f.heartbeat).toHaveBeenCalledTimes(1));
    if (cause === "lease") f.identity.epoch += 1;
    if (cause === "instance") f.identity.instanceId = "other";
    if (cause === "incarnation") f.identity.incarnation = "other";
    const rejected = expect(pending).rejects.toThrow(); gate.resolve(f.result); await rejected;
    expect(f.onResult).not.toHaveBeenCalled();
  });

  it("stop settles the pending request without adopting its response or creating a timer", async () => {
    const f = await fixture(), gate = Promise.withResolvers<typeof f.result>();
    f.heartbeat.mockImplementationOnce(() => gate.promise);
    const pending = f.publisher.publishPending();
    await vi.waitFor(() => expect(f.heartbeat).toHaveBeenCalledTimes(1));
    f.publisher.stop(); const rejected = expect(pending).rejects.toThrow();
    gate.resolve(f.result); await rejected; await f.publisher.settle();
    expect(f.onResult).not.toHaveBeenCalled(); expect(f.onFailure).not.toHaveBeenCalled();
    await expect(f.publisher.start()).rejects.toThrow(); await expect(f.publisher.publishPending()).rejects.toThrow();
  });

  it("failed delivery invokes lifecycle handling once and retries only explicitly with a fresh sequence", async () => {
    const f = await fixture(); vi.useFakeTimers();
    f.heartbeat.mockRejectedValueOnce(new Error("lost response"));
    await expect(f.publisher.publishPending()).rejects.toThrow("lost response");
    expect(f.onFailure).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    const message = await f.publisher.publishPending(); expect(message.sequence).toBe(22);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["captureLeaseFence", "withLeaseAcquisition"] as const)("rejects missing %s before any work", async field => {
    const f = await fixture(); delete f.options[field];
    await expect(f.publisher.publishPending()).rejects.toThrow();
    expect(f.inventory.collect).not.toHaveBeenCalled(); expect(f.heartbeat).not.toHaveBeenCalled();
  });

  it("does not send after allocation failure, and a retry still uses the shared durable allocator", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "allocateHeartbeatSequence").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.publisher.publishPending()).rejects.toThrow("disk unavailable");
    expect(f.heartbeat).not.toHaveBeenCalled();
    expect((await f.publisher.publishPending()).sequence).toBe(21);
  });

  it("rechecks lifecycle after an asynchronous lease adoption callback", async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>();
    f.onResult.mockImplementationOnce(async () => { await gate.promise; });
    const pending = f.publisher.publishPending();
    await vi.waitFor(() => expect(f.onResult).toHaveBeenCalledTimes(1));
    f.identity.epoch += 1;
    const rejected = expect(pending).rejects.toThrow(); gate.resolve(); await rejected;
    await expect(f.publisher.publish()).rejects.toThrow();
  });
});
