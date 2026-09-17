/**
 * Starting the agents a native runtime hosts (WS1-018).
 *
 * Codex runs behind one shared app-server. When that server cannot start (a
 * broken login, a socket it cannot bind), the runtime used to fail its whole
 * startup and shut down, so a person lost their Claude Code work too because
 * of Codex. Now the Codex runners are left out, the reason is kept for status
 * and logs, and every other agent starts as before. A non-Codex runner that
 * fails still fails startup, as it always has.
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
  try {
    for (const runner of input.runners) {
      if (runner.agentId === "codex" && input.codexOwner && !codexOwnerStarted) continue;
      await runner.start();
      started.push(runner);
    }
  } catch (error) {
    if (codexOwnerStarted) await input.codexOwner!.stop();
    throw error;
  }
  return { started, unavailable, codexOwnerStarted };
}
