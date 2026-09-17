import { createLogger, normalizeCaughtError, type Logger } from "@konteks/remote-common";

/**
 * Process lifecycle (adapted from bb `apps/host-daemon/daemon.ts`): ordered
 * shutdown steps, signal handling, and an exit watchdog so a wedged shutdown
 * cannot keep a container alive past its grace period.
 */
interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): void;
  off(event: NodeJS.Signals, listener: () => void): void;
}

type ProcessFailureEvent = "uncaughtException" | "unhandledRejection";
interface ProcessFailureSource {
  on(event: ProcessFailureEvent, listener: (error: unknown) => void): void;
  off(event: ProcessFailureEvent, listener: (error: unknown) => void): void;
}

export interface DaemonStep {
  name: string;
  run: () => Promise<void>;
}

export interface CreateDaemonOptions {
  name: string;
  onStart: () => Promise<void>;
  shutdownSteps: () => DaemonStep[];
  signalSource?: SignalSource;
  /** Where uncaught exceptions and unhandled rejections arrive; defaults to the process. */
  failureSource?: ProcessFailureSource;
  exitProcess?: (code: number) => void;
  shutdownExitGraceMs?: number;
  logger?: Logger;
}

export interface Daemon {
  start(): Promise<void>;
  shutdown(reason: string, exitCode: 0 | 1): Promise<void>;
  waitUntilStopped(): Promise<void>;
}

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const PROCESS_FAILURE_EVENTS: ProcessFailureEvent[] = ["uncaughtException", "unhandledRejection"];
const DEFAULT_SHUTDOWN_EXIT_GRACE_MS = 15_000;

export function createDaemon(options: CreateDaemonOptions): Daemon {
  const logger = options.logger ?? createLogger({ name: options.name });
  const signalSource = options.signalSource ?? process;
  const failureSource: ProcessFailureSource = options.failureSource ?? process;
  const listeners = new Map<NodeJS.Signals, () => void>();
  const failureListeners = new Map<ProcessFailureEvent, (error: unknown) => void>();
  let stopPromise: Promise<void> | null = null;
  let stopFailure: Error | null = null;
  let startupFailed = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let startupSettled: Promise<void> = Promise.resolve();
  let shutdownExitCode: 0 | 1 = 0;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  function unregister(): void {
    for (const [signal, listener] of listeners) signalSource.off(signal, listener);
    listeners.clear();
    for (const [event, listener] of failureListeners) failureSource.off(event, listener);
    failureListeners.clear();
  }

  async function stop(reason: string, exitCode: 0 | 1): Promise<void> {
    if (exitCode > shutdownExitCode) shutdownExitCode = exitCode;
    if (stopPromise) return stopPromise;
    const exitProcess = options.exitProcess;
    const watchdog = exitProcess
      ? setTimeout(() => {
          logger.error({ reason }, "shutdown did not end the process; forcing exit");
          exitProcess(shutdownExitCode);
        }, options.shutdownExitGraceMs ?? DEFAULT_SHUTDOWN_EXIT_GRACE_MS)
      : null;
    watchdog?.unref();
    stopPromise = (async () => {
      unregister();
      logger.info({ reason }, "shutting down");
      // Startup may still be acquiring ownership or spawning children. The
      // watchdog remains active, but cleanup cannot race those operations.
      await startupSettled;
      let failure: Error | null = null;
      for (const step of options.shutdownSteps()) {
        try {
          await step.run();
        } catch (error) {
          const stepError = normalizeCaughtError(error);
          failure ??= stepError;
          logger.error({ err: stepError, step: step.name }, "shutdown step failed");
        }
      }
      if (failure) {
        shutdownExitCode = 1;
        stopFailure = failure;
        resolveStopped?.();
        throw failure;
      }
      if (watchdog) clearTimeout(watchdog);
      resolveStopped?.();
      if (!startupFailed) exitProcess?.(shutdownExitCode);
    })();
    return stopPromise;
  }

  return {
    start(): Promise<void> {
      if (startPromise) return startPromise;
      if (started || stopPromise) return Promise.resolve();
      let settleStartup!: () => void;
      startupSettled = new Promise<void>(resolve => { settleStartup = resolve; });
      for (const signal of TERMINATION_SIGNALS) {
        const listener = (): void => {
          void stop(signal, 0).catch((error: unknown) => logger.error({ err: error, signal }, "signal shutdown failed"));
        };
        listeners.set(signal, listener);
        signalSource.on(signal, listener);
      }
      // Without these, an uncaught throw ends the process with only Node's
      // stderr trace, and an unhandled rejection can leave a loop dead while
      // the process lives on. Log both in the daemon's own log and shut down
      // non-zero so the service manager restarts a known-bad process.
      for (const event of PROCESS_FAILURE_EVENTS) {
        const listener = (error: unknown): void => {
          logger.error({ err: normalizeCaughtError(error), event }, "process-level failure; shutting down");
          void stop(event, 1).catch(() => undefined);
        };
        failureListeners.set(event, listener);
        failureSource.on(event, listener);
      }
      startPromise = (async () => {
        try {
          await options.onStart();
          settleStartup();
          if (stopPromise) return;
          started = true;
          logger.info("started");
        } catch (error) {
          startupFailed = true;
          // Say why before shutting down: shutdown can take a while, and the
          // error is otherwise only printed once it has finished.
          logger.error({ err: normalizeCaughtError(error) }, "startup failed");
          settleStartup();
          await stop("startup-failed", 1).catch(() => undefined);
          throw error;
        }
      })();
      return startPromise;
    },
    shutdown: stop,
    async waitUntilStopped(): Promise<void> {
      await stopped;
      if (stopFailure) throw stopFailure;
    },
  };
}
