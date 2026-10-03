import { afterEach, expect, it, vi } from "vitest";
import { SkillRefreshScheduler } from "../skills/refresh-scheduler.js";
afterEach(() => vi.useRealTimers());

it("retains reconnect intent while a startup refresh is pending", async () => {
 let finish!: () => void;
 const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
 const scheduler = new SkillRefreshScheduler({ refresh, active: () => true, failed: vi.fn() });
 scheduler.request(); scheduler.request(); scheduler.request();
 expect(refresh).toHaveBeenCalledTimes(1);
 finish(); await new Promise(resolve => setImmediate(resolve));
 expect(refresh).toHaveBeenCalledTimes(2);
 scheduler.stop();
});
it("retries a failed authorized startup with bounded backoff", async () => {
 vi.useFakeTimers();
 const refresh = vi.fn().mockRejectedValue(new Error("catalog unavailable")), failed = vi.fn();
 const scheduler = new SkillRefreshScheduler({ refresh, active: () => true, failed });
 scheduler.request(); await vi.advanceTimersByTimeAsync(0);
 for (const delay of [5000, 15000, 30000, 60000]) await vi.advanceTimersByTimeAsync(delay);
 expect(refresh).toHaveBeenCalledTimes(5);
 await vi.advanceTimersByTimeAsync(300000);
 expect(refresh).toHaveBeenCalledTimes(5);
 refresh.mockResolvedValue(undefined); scheduler.request(); await vi.advanceTimersByTimeAsync(0);
 expect(refresh).toHaveBeenCalledTimes(6);
 scheduler.stop();
});
it("does not retry after authority is lost or shutdown", async () => {
 vi.useFakeTimers();
 let active = true;
 const refresh = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
 const scheduler = new SkillRefreshScheduler({ refresh, active: () => active, failed: vi.fn() });
 scheduler.request(); await vi.advanceTimersByTimeAsync(0);
 active = false; await vi.advanceTimersByTimeAsync(5000);
 expect(refresh).toHaveBeenCalledTimes(1);
 active = true; scheduler.request(); await vi.advanceTimersByTimeAsync(0);
 scheduler.stop(); await vi.advanceTimersByTimeAsync(300000);
 scheduler.request(); expect(refresh).toHaveBeenCalledTimes(2);
});
it("cancels a queued reconnect refresh on shutdown", async () => {
 let finish!: () => void;
 const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
 const scheduler = new SkillRefreshScheduler({ refresh, active: () => true, failed: vi.fn() });
 scheduler.request(); scheduler.request(); scheduler.stop();
 finish(); await new Promise(resolve => setImmediate(resolve));
 expect(refresh).toHaveBeenCalledTimes(1);
});

it("wires automatic retries through the real supervisor trigger", async () => {
 vi.useFakeTimers();
 const { Supervisor } = await import("../supervisor.js");
 const refresh = vi.fn().mockRejectedValueOnce(new Error("catalog 422")).mockResolvedValue({});
 const supervisor = Object.assign(Object.create(Supervisor.prototype), {
  stopping: false, options: { native: {} }, nativeOwnership: {}, lease: { mode: () => "active" },
  reconciliation: { isComplete: true }, syncOrganizationSkills: refresh, logger: { warn: vi.fn() },
 });
 supervisor.triggerSkillRefresh();
 await vi.advanceTimersByTimeAsync(0);
 expect(refresh).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(5000);
 expect(refresh).toHaveBeenCalledTimes(2);
 supervisor.stopping = true;
 supervisor.triggerSkillRefresh();
 expect(refresh).toHaveBeenCalledTimes(2);
 supervisor.skillRefreshScheduler.stop();
});
