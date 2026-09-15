import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { SupervisorStore } from "../state/store.js";

let dir: string;
let store: SupervisorStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kr-heartbeat-floor-")); store = new SupervisorStore(dir); await store.init(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("reserves Core's floor without fabricating accepted inventory and allocates above it", async () => {
  await store.saveHeartbeatSequence(4);
  await expect(store.reserveHeartbeatFloor(9)).resolves.toBe(9);
  expect(await store.heartbeatSequence()).toBe(9);
  expect(await store.allocateHeartbeatSequence()).toBe(10);
  const restored = new SupervisorStore(dir);
  expect(await restored.allocateHeartbeatSequence()).toBe(11);
});

it("never lowers an allocated floor, including legacy save callers", async () => {
  await store.reserveHeartbeatFloor(10);
  await store.saveHeartbeatSequence(4);
  expect(await store.reserveHeartbeatFloor(7)).toBe(10);
  expect(await store.allocateHeartbeatSequence()).toBe(11);
});

it("serializes allocations with an intervening reservation", async () => {
  const results = await Promise.all([store.allocateHeartbeatSequence(), store.reserveHeartbeatFloor(20), store.allocateHeartbeatSequence(), store.allocateHeartbeatSequence()]);
  expect(results).toEqual([1, 20, 21, 22]);
  expect(await store.heartbeatSequence()).toBe(22);
});

it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid floor %s before changing disk", async value => {
  await store.saveHeartbeatSequence(7);
  await expect(store.reserveHeartbeatFloor(value)).rejects.toThrow();
  await expect(store.saveHeartbeatSequence(value)).rejects.toThrow();
  expect(await store.heartbeatSequence()).toBe(7);
});

it("fails closed at safe integer exhaustion", async () => {
  await store.reserveHeartbeatFloor(Number.MAX_SAFE_INTEGER);
  await expect(store.allocateHeartbeatSequence()).rejects.toThrow();
  expect(await store.heartbeatSequence()).toBe(Number.MAX_SAFE_INTEGER);
});
