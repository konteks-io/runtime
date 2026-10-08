import { describe, expect, it, vi } from "vitest";
import { Supervisor } from "../supervisor.js";

// Source-only regression fixtures: these call actual production lifecycle
// methods with inert boundaries. They have not been executed in this review.
interface Lifecycle {
  startLeaseLossCleanup(): void;
  beginDrain(reason: string, deadline: string | null): Promise<number>;
  stopImpl(): Promise<void>;
  closePreviewsForShutdown(): Promise<{ reason: unknown } | null>;
}
const lifecycle = Supervisor.prototype as unknown as Lifecycle;

describe("preview cleanup participates in actual supervisor lifecycle", () => {
  it("keeps lease restoration drained when preview cleanup fails after work drained", async () => {
    const failure = new Error("preview group survives");
    const state = {
      leaseLossCleanup: null as Promise<void> | null,
      leaseLossCleanupFailed: false,
      previews: { stopAll: vi.fn().mockRejectedValue(failure) },
      work: { drainSessions: vi.fn().mockResolvedValue(undefined) },
      logger: { error: vi.fn() },
      restoreLeaseDrain: vi.fn(),
    };
    lifecycle.startLeaseLossCleanup.call(state);
    await state.leaseLossCleanup;
    expect(state.work.drainSessions).toHaveBeenCalledWith("lease_lost");
    expect(state.previews.stopAll).toHaveBeenCalledWith("lease_lost");
    expect(state.leaseLossCleanupFailed).toBe(true);
    expect(state.leaseLossCleanup).toBeNull();
  });

  it("detached-preview drain waits for all attempts and rejects an unconfirmed stop", async () => {
    const state = {
      draining: false,
      drainReason: null,
      drainDeadline: null,
      administrativeStatus: "active",
      work: { activeCount: () => 0, liveSessionIds: () => new Set<string>() },
      cancelDrainTimer: vi.fn(),
      logger: { info: vi.fn() },
      previews: {
        list: () => [{ sessionId: "a" }, { sessionId: "b" }],
        stop: vi.fn(async (id: string) => {
          if (id === "a") throw new Error("unknown stop");
        }),
      },
    };
    await expect(lifecycle.beginDrain.call(state, "drain", null)).rejects.toThrow(
      "cleanup remains unconfirmed",
    );
    expect(state.previews.stop).toHaveBeenCalledTimes(2);
    expect(state.draining).toBe(true);
  });

  it("shutdown still stops other agents and closes state before returning preview failure", async () => {
    const failure = new Error("preview stop unknown");
    const steps: string[] = [];
    const state = {
      noteShutdown: async () => undefined,
      stopLoopsForShutdown: async () => undefined,
      drainForShutdown: async () => undefined,
      closePreviewsForShutdown: (): Promise<{ reason: unknown } | null> =>
        lifecycle.closePreviewsForShutdown.call(state),
      previews: {
        close: async () => {
          throw failure;
        },
      },
      logger: { error: vi.fn() },
      previewChannel: { dispose: () => steps.push("streams") },
      stopAgentsForShutdown: async () => {
        steps.push("agents");
        return { runnerFailure: undefined, codexFailure: null };
      },
      runners: new Map(),
      transport: { stop: () => steps.push("transport") },
      stateMutations: {
        close: async () => {
          steps.push("state");
        },
      },
      nativeOwnership: { release: () => steps.push("lock") },
    };
    await expect(lifecycle.stopImpl.call(state)).rejects.toBe(failure);
    expect(steps).toEqual(["streams", "agents", "transport", "state", "lock"]);
  });
});
