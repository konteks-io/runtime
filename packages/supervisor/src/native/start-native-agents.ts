/**
 * Starting the agents a native runtime hosts (WS1-018, dsh-runtime-support CP5).
 *
 * Codex runs behind one shared app-server. When that server cannot start (a
 * broken login, a socket it cannot bind), the runtime used to fail its whole
 * startup and shut down, so a person lost their Claude Code work too because
 * of Codex. The same held for any other agent: one runner that could not
 * start (a DeepSeek Harness upgraded out of the supported range, say) took
 * every other agent down with it. Now any agent that cannot start is left
 * out, the reason is kept for status and logs, it is tried again in the
 * background, and every other agent starts as before.
 */

export interface StartableOwner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartableRunner {
  agentId: string;
  start(): Promise<void>;
}

export interface NativeAgentsStartResult<R extends StartableRunner> {
  started: R[];
  /** Runners whose own start failed; the caller leaves them out and retries them. */
  failed: R[];
  unavailable: Array<{ agentId: string; reason: string }>;
  codexOwnerStarted: boolean;
}

export async function startNativeAgents<R extends StartableRunner>(input: {
  codexOwner: StartableOwner | null;
  runners: R[];
  onUnavailable?: (agentId: string, error: unknown) => void;
}): Promise<NativeAgentsStartResult<R>> {
  const unavailable: Array<{ agentId: string; reason: string }> = [];
  let codexOwnerStarted = false;
  if (input.codexOwner) {
    try {
      await input.codexOwner.start();
      codexOwnerStarted = true;
    } catch (error) {
      input.onUnavailable?.("codex", error);
      unavailable.push({ agentId: "codex", reason: error instanceof Error ? error.message : "Codex could not start." });
    }
  }
  const started: R[] = [];
  const failed: R[] = [];
  for (const runner of input.runners) {
    if (runner.agentId === "codex" && input.codexOwner && !codexOwnerStarted) continue;
    try {
      await runner.start();
      started.push(runner);
    } catch (error) {
      input.onUnavailable?.(runner.agentId, error);
      unavailable.push({ agentId: runner.agentId, reason: error instanceof Error ? error.message : `${runner.agentId} could not start.` });
      failed.push(runner);
    }
  }
  return { started, failed, unavailable, codexOwnerStarted };
}

/**
 * Background retries for agents left out at start: a minute, then doubling up
 * to fifteen minutes, at most ten tries. A passing failure (a busy socket, a
 * dsh the person has just reinstalled) comes back without a service restart.
 */
export class NativeAgentRetry {
  private readonly entries = new Map<string, { start: () => Promise<void>; attempt: number; timer: NodeJS.Timeout | null }>();
  private stopped = false;

  constructor(private readonly options: {
    onStarted: (agentId: string) => void | Promise<void>;
    onGaveUp: (agentId: string, error: unknown) => void;
    log: (agentId: string, attempt: number, error: unknown) => void;
  }) {}

  park(agentId: string, start: () => Promise<void>): void {
    if (this.stopped) return;
    this.cancel(agentId);
    this.entries.set(agentId, { start, attempt: 0, timer: null });
    this.schedule(agentId);
  }

  parked(): string[] { return [...this.entries.keys()]; }

  stop(): void {
    this.stopped = true;
    for (const agentId of [...this.entries.keys()]) this.cancel(agentId);
  }

  private cancel(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(agentId);
  }

  private schedule(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry || this.stopped) return;
    const delay = Math.min(60_000 * 2 ** entry.attempt, 15 * 60_000);
    entry.timer = setTimeout(() => { void this.retry(agentId); }, delay);
    entry.timer.unref?.();
  }

  private async retry(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry || this.stopped) return;
    entry.timer = null;
    try {
      await entry.start();
    } catch (error) {
      entry.attempt += 1;
      this.options.log(agentId, entry.attempt, error);
      if (entry.attempt >= 10) {
        this.entries.delete(agentId);
        this.options.onGaveUp(agentId, error);
        return;
      }
      this.schedule(agentId);
      return;
    }
    if (this.stopped || this.entries.get(agentId) !== entry) return;
    this.entries.delete(agentId);
    await this.options.onStarted(agentId);
  }
}
