import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseLane } from "../lease/lease-lane.js";

afterEach(() => { vi.useRealTimers(); });

describe("the lease lane", () => {
  it("runs lease operations one at a time, in order", async () => {
    const lane = new LeaseLane({ holdMs: 60_000, onOverrun: vi.fn() });
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = lane.run(() => new Promise<void>(resolve => { finishFirst = () => { order.push("first"); resolve(); }; }), "heartbeat");
    const second = lane.run(async () => { order.push("second"); }, "reconnect");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  // 10-09: one lease operation never settled; every later heartbeat waited
  // behind it, the lease lapsed and the computer stayed "not connected".
  it("moves on past an operation that never settles, names it, and fences it out", async () => {
    vi.useFakeTimers();
    const onOverrun = vi.fn();
    const lane = new LeaseLane({ holdMs: 120_000, onOverrun });
    let fenceOfStuck = -1;
    void lane.run(() => { fenceOfStuck = lane.current(); return new Promise<never>(() => undefined); }, "reconnect");
    const renewed = vi.fn(async () => "lease-2");
    const next = lane.run(renewed, "heartbeat");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(renewed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).resolves.toBe("lease-2");
    expect(onOverrun).toHaveBeenCalledWith({ operation: "reconnect", heldMs: 120_000 });
    // The stuck operation's fence no longer matches: if it ever settles, it cannot adopt.
    expect(lane.current()).not.toBe(fenceOfStuck);
  });

  it("frees the lane when an operation fails", async () => {
    const lane = new LeaseLane({ holdMs: 60_000, onOverrun: vi.fn() });
    await expect(lane.run(async () => { throw new Error("refused"); }, "heartbeat")).rejects.toThrow("refused");
    await expect(lane.run(async () => "next", "heartbeat")).resolves.toBe("next");
    await expect(lane.idle()).resolves.toBeUndefined();
  });
});
