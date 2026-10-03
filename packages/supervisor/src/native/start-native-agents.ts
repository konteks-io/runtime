/**
 * Starting the agents a native runtime hosts.
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

interface StartableOwner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface StartableRunner {
  agentId: string;
  start(): Promise<void>;
}

interface NativeAgentsStartResult<R extends StartableRunner> {
  started: R[];
  /** Runners whose own start failed; the caller leaves them out and retries them. */
  failed: R[];
  unavailable: Array<{ agentId: string; reason: string }>;
  codexOwnerStarted: boolean;
}

export async function startNativeAgents<R extends StartableRunner>(input: NativeAgentsStartInput<R>): Promise<NativeAgentsStartResult<R>> {
  const outcome: StartOutcome<R> = { started: [], failed: [], unavailable: [] };
  // Codex's shared server may take a while on a first start (a newer Codex
  // migrating its home); the other agents start meanwhile instead of waiting.
  const owner = input.codexOwner
    ? input.codexOwner.start().then(() => ({ started: true as const }), (error: unknown) => ({ started: false as const, error }))
    : Promise.resolve(null);
  const behindOwner = (runner: R) => runner.agentId === "codex" && input.codexOwner !== null;
  for (const runner of input.runners) if (!behindOwner(runner)) await startRunner(runner, input, outcome);
  const codexOwnerStarted = await settleCodexOwner(owner, input, outcome);
  if (codexOwnerStarted) for (const runner of input.runners) if (behindOwner(runner)) await startRunner(runner, input, outcome);
  return { ...outcome, codexOwnerStarted };
}

interface NativeAgentsStartInput<R extends StartableRunner> {
  codexOwner: StartableOwner | null;
  runners: R[];
  onUnavailable?: (agentId: string, error: unknown) => void;
}

type StartOutcome<R extends StartableRunner> = Omit<NativeAgentsStartResult<R>, "codexOwnerStarted">;

async function startRunner<R extends StartableRunner>(runner: R, input: NativeAgentsStartInput<R>, outcome: StartOutcome<R>): Promise<void> {
  try {
    await runner.start();
    outcome.started.push(runner);
  } catch (error) {
    input.onUnavailable?.(runner.agentId, error);
    outcome.unavailable.push({ agentId: runner.agentId, reason: error instanceof Error ? error.message : `${runner.agentId} could not start.` });
    outcome.failed.push(runner);
  }
}

/** Whether Codex's shared server started; a failure is reported first among the unavailable agents. */
async function settleCodexOwner<R extends StartableRunner>(
  owner: Promise<{ started: true } | { started: false; error: unknown } | null>,
  input: NativeAgentsStartInput<R>,
  outcome: StartOutcome<R>,
): Promise<boolean> {
  const result = await owner;
  if (result && !result.started) {
    input.onUnavailable?.("codex", result.error);
    outcome.unavailable.unshift({ agentId: "codex", reason: result.error instanceof Error ? result.error.message : "Codex could not start." });
  }
  return result?.started === true;
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

  /** `firstDelayMs`: when the first try runs (default a minute; Google Antigravity's update fetch starts at once). */
  park(agentId: string, start: () => Promise<void>, options: { firstDelayMs?: number } = {}): void {
    if (this.stopped) return;
    this.cancel(agentId);
    this.entries.set(agentId, { start, attempt: 0, timer: null });
    this.schedule(agentId, options.firstDelayMs);
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

  private schedule(agentId: string, firstDelayMs?: number): void {
    const entry = this.entries.get(agentId);
    if (!entry || this.stopped) return;
    const delay = firstDelayMs ?? Math.min(60_000 * 2 ** entry.attempt, 15 * 60_000);
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
