import { describe, expect, it, vi } from "vitest";
import { nativeShutdownSteps } from "../native/service.js";

describe("native service shutdown order", () => {
  it("starts owned bridge and app-server cleanup before closing the control server", async () => {
    const order: string[] = [];
    const supervisor = { stop: vi.fn(async () => { order.push("supervisor"); }) };
    const control = { close: vi.fn(async () => { order.push("control"); }) };

    for (const step of nativeShutdownSteps(() => supervisor, () => control)) await step.run();

    expect(order).toEqual(["supervisor", "control"]);
  });

  it("does not attest completed shutdown when an earlier cleanup step fails", async () => {
    const writeReceipt = vi.fn(async () => undefined);
    const control = { close: vi.fn(async () => undefined) };
    const steps = nativeShutdownSteps(
      () => ({ stop: async () => { throw new Error("owned process exit unconfirmed"); } }),
      () => control,
      writeReceipt,
    );
    for (const step of steps) await step.run().catch(() => undefined);

    expect(control.close).toHaveBeenCalledOnce();
    expect(writeReceipt).not.toHaveBeenCalled();
  });

  it("does not attest completed shutdown when control closure fails after supervisor cleanup", async () => {
    const writeReceipt = vi.fn(async () => undefined);
    const supervisor = { stop: vi.fn(async () => undefined) };
    const steps = nativeShutdownSteps(
      () => supervisor,
      () => ({ close: async () => { throw new Error("control still open"); } }),
      writeReceipt,
    );
    for (const step of steps) await step.run().catch(() => undefined);

    expect(supervisor.stop).toHaveBeenCalledOnce();
    expect(writeReceipt).not.toHaveBeenCalled();
  });
});
