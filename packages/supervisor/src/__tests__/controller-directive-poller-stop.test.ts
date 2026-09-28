import { describe, expect, it, vi } from "vitest";
import { ControllerDirectivePoller } from "../work/controller-directive-poller.js";

describe("controller directive poller shutdown", () => {
  it("aborts an in-flight long poll so native shutdown can finish before its watchdog", async () => {
    let requestSignal: AbortSignal | undefined;
    let release!: () => void;
    const pending = new Promise<{ highWater: number; directives: never[] }>((_resolve, reject) => {
      release = () => reject(Object.assign(new Error("request cancelled"), { code: "operation_interrupted" }));
    });
    const warning = vi.fn();
    const storePulled = vi.fn();
    const pull = vi.fn((_instanceId: string, _request: unknown, signal?: AbortSignal) => {
      requestSignal = signal;
      signal?.addEventListener("abort", release, { once: true });
      return pending;
    });
    const poller = new ControllerDirectivePoller({
      core: { pullControllerDirectives: pull } as never,
      journal: { planning: { pendingDirectives: () => [], cursor: () => 0, storePulled } } as never,
      processor: { accept: vi.fn() } as never,
      instanceId: () => "test-instance",
      runnerIncarnation: () => "test-incarnation",
      canPoll: () => true,
      logger: { warn: warning } as never,
    });

    poller.start();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    const stopped = poller.stop();
    try {
      expect(requestSignal).toBeDefined();
      expect(requestSignal?.aborted).toBe(true);
      await expect(stopped).resolves.toBeUndefined();
      expect(storePulled).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      release();
      await stopped;
    }
  });
});
