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
    const progress: string[] = [];
    const steps = nativeShutdownSteps(
      () => ({ stop: async () => { throw new Error("owned process exit unconfirmed"); } }),
      () => control,
      writeReceipt,
      async (phase, state) => { progress.push(`${phase}:${state}`); },
    );
    for (const step of steps) await step.run().catch(() => undefined);

    expect(control.close).toHaveBeenCalledOnce();
    expect(writeReceipt).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
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

  it("records completed cleanup only after the ordinary service receipt is written", async () => {
    const events: string[] = [];
    const steps = nativeShutdownSteps(
      () => ({ stop: async () => { events.push("supervisor stopped"); } }),
      () => ({ close: async () => { events.push("control closed"); } }),
      async () => { events.push("receipt written"); },
      async (phase, state) => { events.push(`${phase}:${state}`); },
    );
    for (const step of steps) await step.run();

    expect(events).toEqual([
      "supervisor stopped", "control_close:entered", "control closed", "control_close:completed",
      "receipt:entered", "receipt written", "receipt:completed",
    ]);
  });

  it("leaves control closure incomplete and withholds the receipt if control still has clients", async () => {
    const progress: string[] = [];
    const writeReceipt = vi.fn(async () => undefined);
    const steps = nativeShutdownSteps(
      () => ({ stop: async () => undefined }),
      () => ({ close: async () => { throw new Error("control still has clients"); } }),
      writeReceipt,
      async (phase, state) => { progress.push(`${phase}:${state}`); },
    );
    for (const step of steps) await step.run().catch(() => undefined);

    expect(progress).toEqual(["control_close:entered"]);
    expect(writeReceipt).not.toHaveBeenCalled();
  });

  it("keeps shutdown and receipt success independent of diagnostic storage failures", async () => {
    const writeReceipt = vi.fn(async () => undefined);
    const steps = nativeShutdownSteps(
      () => ({ stop: async () => undefined }),
      () => ({ close: async () => undefined }),
      writeReceipt,
      async () => { throw new Error("diagnostic disk unavailable"); },
    );
    for (const step of steps) await step.run();
    expect(writeReceipt).toHaveBeenCalledOnce();
  });
});
