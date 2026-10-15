import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLoopWatch } from "../event-loop-watch.js";
import { lastSlowJournalWork, observeSlowJournalWork, timedJournalWork } from "../state/slow-work.js";

/** D175: a held event loop names how long, and the slow journal work before it. */
describe("event-loop watch", () => {
  afterEach(() => observeSlowJournalWork(undefined));

  it("stays quiet on time and logs a held loop with the last slow journal work", () => {
    let now = 0;
    const warn = vi.fn();
    const watch = new EventLoopWatch({ warn } as never, { tickMs: 1_000, stallMs: 2_000, now: () => now });
    watch.start();
    now = 1_050; watch.tick(1_000);
    expect(warn).not.toHaveBeenCalled();

    const slow = vi.fn();
    observeSlowJournalWork(slow);
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(900);
    expect(timedJournalWork("assignments", "all", 1_867, () => "copy")).toBe("copy");
    clock.mockRestore();
    expect(slow).toHaveBeenCalledWith(expect.objectContaining({ table: "assignments", operation: "all", rows: 1_867, ms: 900 }));

    now = 2_050 + 7_000; watch.tick(1_000);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "native.event_loop.stalled", stalledMs: 7_000,
      lastSlowJournalWork: lastSlowJournalWork() }), expect.any(String));
    watch.stop();
  });

  it("does not report quick journal work", () => {
    const slow = vi.fn();
    observeSlowJournalWork(slow);
    timedJournalWork("pending-requests", "all", 3, () => undefined);
    expect(slow).not.toHaveBeenCalled();
  });
});
