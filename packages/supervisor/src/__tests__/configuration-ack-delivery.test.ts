import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, jcsDigest, type DesiredConfigurationAck } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import { DurableOutbox } from "../state/outbox.js";
import { ConfigurationAckDelivery } from "../control/configuration-ack-delivery.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "config-ack-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const ack = (revision = 1): DesiredConfigurationAck => ({ type: "desired_configuration_ack", instanceId: "instance", revision, digest: "A".repeat(43), status: "applied", acknowledgedAt: "2026-09-06T00:00:00Z", signature: "A".repeat(86) });
async function fixture(deliver = vi.fn<CoreClient["controlAck"]>(async () => true)) {
  const outbox = new DurableOutbox(dir);
  await outbox.load();
  let enabled = true;
  const delivery = new ConfigurationAckDelivery({ outbox, core: { controlAck: deliver }, instanceId: () => "instance", clock: new FixedClock(Date.parse(ack().acknowledgedAt)), canSend: () => enabled });
  return { outbox, delivery, deliver, stop: () => { enabled = false; } };
}
describe("durable configuration acknowledgement delivery", () => {
  it("persists supersession separately from acceptance and recovers without retrying it", async () => {
    const receipt = { instanceId: "instance", revision: 1, status: "superseded" as const, requestDigest: jcsDigest(ack()), appliedRevision: 2 };
    const f = await fixture(vi.fn(async () => receipt));
    await f.delivery.submit(ack());
    expect(f.outbox.depth).toBe(0);
    const records = (await readFile(join(dir, "outbox.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ op: "configuration_superseded", receipt });
    const restarted = await fixture();
    await restarted.delivery.flush();
    expect(restarted.deliver).not.toHaveBeenCalled();
  });
  it("retains superseded messages if the durable disposition write fails", async () => {
    const receipt = { instanceId: "instance", revision: 1, status: "superseded" as const, requestDigest: jcsDigest(ack()), appliedRevision: 2 };
    const f = await fixture(vi.fn(async () => receipt));
    vi.spyOn(f.outbox, "supersedeConfigurationAck").mockRejectedValueOnce(new Error("disk full"));
    await f.delivery.submit(ack());
    expect(f.outbox.depth).toBe(1);
    await f.delivery.flush();
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls[0]).toEqual(f.deliver.mock.calls[1]);
    expect((await fixture()).outbox.depth).toBe(0);
  });
  it.each([{ status: "applied" }, { appliedRevision: 1 }, { requestDigest: "B".repeat(43) }, { instanceId: "foreign" }, { revision: 2 }])("does not retire from a mismatched disposition", async change => {
    const f = await fixture(vi.fn(async () => false));
    await f.delivery.submit(ack());
    const item = f.outbox.all()[0]!;
    await expect(f.outbox.supersedeConfigurationAck(item.id, { instanceId: "instance", revision: 1, status: "superseded", requestDigest: jcsDigest(ack()), appliedRevision: 2, ...change })).rejects.toThrow();
    expect((await fixture()).outbox.all()[0]?.body).toEqual(ack());
  });
  it("allows an applied same revision to supersede its prior rejection, not other control messages", async () => {
    const rejected = { ...ack(), status: "rejected" as const, reason: "invalid_value" as const };
    const receipt = { instanceId: "instance", revision: 1, status: "superseded" as const, requestDigest: jcsDigest(rejected), appliedRevision: 1 };
    const f = await fixture(vi.fn(async () => receipt));
    await f.outbox.enqueue({ id: "other-control", key: "other-control", channel: "control", group: "control", order: 0, body: { type: "drain_ack" }, createdAt: ack().acknowledgedAt });
    await f.delivery.submit(rejected);
    expect(f.outbox.all().map(item => item.id)).toEqual(["other-control"]);
    await f.outbox.compact();
    expect((await fixture()).outbox.all().map(item => item.id)).toEqual(["other-control"]);
  });
  it("replays the exact persisted acknowledgement after restart and retires it only on confirmed acceptance", async () => {
    const first = await fixture(vi.fn(async () => { throw new Error("disconnected"); }));
    await first.delivery.submit(ack());
    expect(first.outbox.depth).toBe(1);
    const restarted = await fixture();
    await restarted.delivery.flush();
    expect(restarted.deliver).toHaveBeenCalledWith("instance", ack());
    expect(restarted.outbox.depth).toBe(0);
    expect((await fixture()).outbox.depth).toBe(0);
  });
  it("waits for durable persistence and coalesces overlapping flushes", async () => {
    let release!: (value: boolean) => void;
    const f = await fixture(vi.fn(() => new Promise<boolean>(resolve => { release = resolve; })));
    const submitted = f.delivery.submit(ack());
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    expect((await fixture()).outbox.depth).toBe(1);
    const duplicate = f.delivery.submit({ ...ack(), acknowledgedAt: "2026-09-06T00:00:01Z" });
    const flush = f.delivery.flush();
    release(true);
    await Promise.all([submitted, duplicate, flush]);
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.outbox.depth).toBe(0);
  });
  it("does not retire negative responses or send another instance's acknowledgement", async () => {
    const f = await fixture(vi.fn(async () => false));
    await f.delivery.submit(ack());
    expect(f.outbox.depth).toBe(1);
    await expect(f.delivery.submit({ ...ack(), instanceId: "foreign" })).rejects.toThrow();
    expect(f.deliver).toHaveBeenCalledOnce();
    f.stop();
    await f.delivery.flush();
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("does not send before persistence, and a disk failure remains retryable", async () => {
    const f = await fixture();
    vi.spyOn(f.outbox, "enqueue").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.delivery.submit(ack())).rejects.toThrow("disk full");
    expect(f.deliver).not.toHaveBeenCalled();
    await f.delivery.submit(ack());
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("retries unchanged when Core accepted but saving its receipt failed", async () => {
    const f = await fixture();
    vi.spyOn(f.outbox, "ack").mockRejectedValueOnce(new Error("disk unavailable"));
    await f.delivery.submit(ack());
    expect(f.outbox.depth).toBe(1);
    await f.delivery.flush();
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls[0]).toEqual(f.deliver.mock.calls[1]);
    expect(f.outbox.depth).toBe(0);
  });

  it("stops new sends while settling an in-flight accepted receipt", async () => {
    let release!: (value: boolean) => void;
    const f = await fixture(vi.fn(() => new Promise<boolean>(resolve => { release = resolve; })));
    const submitted = f.delivery.submit(ack());
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    f.stop();
    await f.delivery.submit(ack(2));
    release(true);
    await submitted;
    await f.delivery.settle();
    expect(f.deliver).toHaveBeenCalledOnce();
    const restarted = await fixture();
    await restarted.delivery.flush();
    expect(restarted.deliver).toHaveBeenCalledWith("instance", ack(2));
    expect(restarted.outbox.depth).toBe(0);
  });
});
