import { describe, expect, it, vi } from "vitest";
import { StateMutationGate } from "../state/mutation-gate.js";

describe("native state mutation fence", () => {
  it("waits for accepted writes and rejects late work before releasing ownership", async () => {
    const gate = new StateMutationGate(() => {});
    let finish!: () => void;
    const pending = gate.run(() => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    let closed = false;
    const close = gate.close().then(() => { closed = true; });
    const late = vi.fn(async () => {});
    await expect(gate.run(late)).rejects.toThrow();
    expect(late).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    finish();
    await pending;
    await close;
    expect(closed).toBe(true);
  });
  it("checks ownership before I/O and settles failed writes", async () => {
    const gate = new StateMutationGate(() => { throw new Error("ownership lost"); });
    const write = vi.fn(async () => {});
    await expect(gate.run(write)).rejects.toThrow("ownership lost");
    expect(write).not.toHaveBeenCalled();
    await gate.close();
  });
});
