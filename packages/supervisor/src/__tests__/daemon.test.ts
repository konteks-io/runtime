import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../daemon.js";

afterEach(() => vi.useRealTimers());

// Ported from bb's daemon lifecycle cases to the Konteks ordered-step interface.
describe("bb-derived native daemon lifecycle", () => {
  it("waits for the same startup completion for overlapping callers", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const daemon = createDaemon({ name: 'test', onStart: () => gate, shutdownSteps: () => [], signalSource: new EventEmitter() });
    const first = daemon.start();
    let secondDone = false;
    const second = daemon.start().then(() => { secondDone = true; });
    await Promise.resolve();
    expect(secondDone).toBe(false);
    finish();
    await Promise.all([first, second]);
    await daemon.shutdown('test', 0);
  });

  it("does not release ownership while interrupted startup can still create processes", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const signalSource = new EventEmitter();
    const order: string[] = [];
    const daemon = createDaemon({ name: 'test', onStart: async () => { await gate; order.push('startup-settled'); }, signalSource, shutdownSteps: () => [{ name: 'release-owner', run: async () => { order.push('released'); } }] });
    const start = daemon.start();
    signalSource.emit('SIGTERM');
    await Promise.resolve();
    expect(order).toEqual([]);
    finish();
    await start;
    await daemon.waitUntilStopped();
    expect(order).toEqual(['startup-settled', 'released']);
  });
  it("starts only once and registers one signal handler", async () => {
    const signalSource = new EventEmitter();
    const onStart = vi.fn(async () => undefined);
    const daemon = createDaemon({ name: 'test', onStart, shutdownSteps: () => [], signalSource });
    await daemon.start();
    await daemon.start();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(signalSource.listenerCount('SIGTERM')).toBe(1);
    await daemon.shutdown('test', 0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    await daemon.start();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("continues cleanup after a failed step and keeps the exit watchdog armed", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const exitProcess = vi.fn();
    const daemon = createDaemon({ name: 'test', onStart: async () => undefined, signalSource: new EventEmitter(), exitProcess, shutdownExitGraceMs: 100, shutdownSteps: () => [
      { name: 'flush', run: async () => { order.push('flush'); throw new Error('flush failed'); } },
      { name: 'stop-runners', run: async () => { order.push('stop-runners'); } },
      { name: 'release-lock', run: async () => { order.push('release-lock'); } },
    ] });
    await daemon.start();
    await expect(daemon.shutdown('deploy', 0)).rejects.toThrow('flush failed');
    expect(order).toEqual(['flush', 'stop-runners', 'release-lock']);
    await expect(daemon.waitUntilStopped()).rejects.toThrow('flush failed');
    await vi.advanceTimersByTimeAsync(100);
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("cleans up a failed startup exactly once and returns the original failure", async () => {
    const release = vi.fn(async () => undefined);
    const failure = new Error('relay startup failed');
    const daemon = createDaemon({ name: 'test', onStart: async () => { throw failure; }, signalSource: new EventEmitter(), shutdownSteps: () => [{ name: 'release', run: release }] });
    await expect(daemon.start()).rejects.toBe(failure);
    await daemon.shutdown('repeat', 0);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
