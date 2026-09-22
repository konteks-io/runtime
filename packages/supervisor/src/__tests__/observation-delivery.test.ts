import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock } from "@konteks/remote-common";
import { DurableOutbox } from "../state/outbox.js";
import { ObservationDelivery } from "../control/observation-delivery.js";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "observation-ack-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const usage = { instanceId: "i", assignmentId: "a", agentId: "claude-code", attempt: 1,
  moneyBasis: "unavailable_local_subscription" as const, observedAt: "2026-09-22T00:00:00Z", outputTokens: 3 };
async function fixture() {
  const outbox = new DurableOutbox(dir); await outbox.load();
  let enabled = true;
  const submitObservation = vi.fn(async () => undefined);
  const delivery = new ObservationDelivery({ outbox, core: { submitObservation }, instanceId: () => "i",
    clock: new FixedClock(Date.parse(usage.observedAt)), canSend: () => enabled });
  return { outbox, delivery, submitObservation, disable: () => { enabled = false; } };
}
it("retires historical usage only after the correlated Core receipt, across restart", async () => {
  const f = await fixture();
  await f.outbox.enqueue({ id: "old", key: "usage:a:old", group: "observation", channel: "observation", order: 1, body: usage, createdAt: usage.observedAt });
  f.submitObservation.mockRejectedValueOnce(new Error("response lost"));
  await f.delivery.flush();
  expect(f.outbox.depth).toBe(1);
  const restarted = await fixture();
  await restarted.delivery.flush();
  expect(restarted.submitObservation).toHaveBeenCalledWith("i", usage);
  expect(restarted.outbox.depth).toBe(0);
});
it("retains the exact record after local ACK persistence fails", async () => {
  const f = await fixture(); vi.spyOn(f.outbox, "ack").mockRejectedValueOnce(new Error("disk full"));
  await f.delivery.submit(usage); await f.delivery.flush();
  expect(f.outbox.depth).toBe(1);
  await f.delivery.flush(); expect(f.outbox.depth).toBe(0);
  expect(f.submitObservation.mock.calls[0]).toEqual(f.submitObservation.mock.calls[1]);
});
it("does not send foreign-instance history or send while recovery is blocked", async () => {
  const f = await fixture(); f.disable();
  await f.delivery.submit(usage); await f.delivery.flush();
  expect(f.submitObservation).not.toHaveBeenCalled(); expect(f.outbox.depth).toBe(1);
  const restarted = await fixture();
  await restarted.outbox.enqueue({ id: "foreign", key: "foreign", group: "observation", channel: "observation", order: 0,
    body: { ...usage, instanceId: "other" }, createdAt: usage.observedAt });
  await restarted.delivery.flush(); expect(restarted.submitObservation).toHaveBeenCalledTimes(1);
  expect(restarted.outbox.depth).toBe(1);
});
it("bounds each pass and shares simultaneous flushes", async () => {
  const f = await fixture();
  for (let n=0;n<20;n++) await f.outbox.enqueue({ id: `${n}`, key: `${n}`, group: "observation", channel: "observation", order:n, body:usage,createdAt:usage.observedAt });
  await Promise.all([f.delivery.flush(),f.delivery.flush()]);
  expect(f.submitObservation).toHaveBeenCalledTimes(8); expect(f.outbox.depth).toBe(12);
});
