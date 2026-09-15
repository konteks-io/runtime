import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import { ObservationDelivery } from "../control/observation-delivery.js";
import { DurableOutbox } from "../state/outbox.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "observation-delivery-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const at = "2026-09-15T00:00:00.000Z";
const observation = (assignmentId: string) => ({ instanceId: "instance", assignmentId, attempt: 1, agentId: "claude-code", totalTokens: 10, inputTokens: 4, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, moneyBasis: "unavailable_local_subscription", observedAt: at });

async function fixture(deliver = vi.fn<CoreClient["observation"]>(async () => true)) {
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  let enabled = true;
  const delivery = new ObservationDelivery({ outbox, core: { observation: deliver }, instanceId: () => "instance", clock: new FixedClock(Date.parse(at)), canSend: () => enabled });
  return { outbox, delivery, deliver, stop: () => { enabled = false; } };
}

describe("durable observation delivery", () => {
  it("persists before sending and retires only after Core's durable result", async () => {
    let release!: (stored: boolean) => void;
    const f = await fixture(vi.fn(() => new Promise<boolean>(resolve => { release = resolve; })));
    await f.delivery.submit("usage:assignment:time", observation("assignment"));
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    expect((await fixture()).outbox.depth).toBe(1);
    release(true);
    await f.delivery.settle();
    expect(f.outbox.depth).toBe(0);
  });

  it("replays the exact retained item after restart and accepts duplicate storage as final", async () => {
    const first = await fixture(vi.fn(async () => { throw new Error("offline"); }));
    await first.outbox.enqueue({ id: "observation-id", channel: "observation", key: "usage:assignment:time", group: "observation", order: 1, body: observation("assignment"), createdAt: at });
    await expect(first.delivery.flush()).rejects.toThrow("offline");
    expect(first.outbox.depth).toBe(1);

    const restarted = await fixture(vi.fn(async () => false));
    await restarted.delivery.flush();
    expect(restarted.deliver).toHaveBeenCalledWith("instance", observation("assignment"));
    expect(restarted.outbox.depth).toBe(0);
  });

  it("delivers retained observations serially in durable order and coalesces flushes", async () => {
    const f = await fixture();
    await f.outbox.enqueue({ id: "later", channel: "observation", key: "later", group: "observation", order: 2, body: observation("later"), createdAt: at });
    await f.outbox.enqueue({ id: "first", channel: "observation", key: "first", group: "observation", order: 1, body: observation("first"), createdAt: at });
    await Promise.all([f.delivery.flush(), f.delivery.flush(), f.delivery.flush()]);
    expect(f.deliver.mock.calls.map(call => call[1])).toEqual([observation("first"), observation("later")]);
    expect(f.outbox.depth).toBe(0);
  });

  it("does not start another send after local authority closes", async () => {
    const f = await fixture();
    await f.outbox.enqueue({ id: "pending", channel: "observation", key: "pending", group: "observation", order: 1, body: observation("pending"), createdAt: at });
    f.stop();
    await f.delivery.flush();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.outbox.depth).toBe(1);
  });
});
