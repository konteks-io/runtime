import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AvailableCommandListSchema, normalizeAvailableCommands, writeSecretFile, type AvailableCommand, type Logger, type RawAvailableCommand } from "@konteks/remote-common";

/** The file, in the agent's own connector folder, that keeps its learnt commands across restarts. */
export const AVAILABLE_COMMANDS_FILE = "available-commands.json";

/** A learnt list seen again is re-dated on disk at most this often (a new session re-announces it). */
const RELEARN_WRITE_INTERVAL_MS = 60 * 60_000;

const StoredSchema = z.object({ commands: z.array(z.unknown()), learntAt: z.string().datetime() });

interface LearntCommands {
  readonly commands: readonly AvailableCommand[];
  readonly learntAt: string;
}

/**
 * The slash commands one agent announced on this computer:
 * the latest ACP `available_commands_update` of any of its sessions, minus the
 * commands the runtime refuses (Antigravity's `/plan`, `/logout`), normalized
 * so the heartbeat schema always takes it. Kept in a small JSON file in the
 * agent's connector folder so a restarted connector still knows them before
 * the next session. Nothing here ever changes what the session stream carries.
 */
export class AvailableCommandsStore {
  private learnt: LearntCommands | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly refused: readonly string[],
    private readonly logger?: Logger,
  ) {}

  /** Reads what an earlier run learnt; a missing or unreadable file is simply nothing learnt yet. */
  async load(): Promise<void> {
    try {
      const parsed = StoredSchema.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      const commands = parsed.success ? AvailableCommandListSchema.safeParse(parsed.data.commands) : null;
      // A command refused since it was learnt (an update) never comes back from disk.
      if (parsed.success && commands?.success) this.learnt = { commands: normalizeAvailableCommands(commands.data.map(command => ({ name: command.name, description: command.description, ...(command.hint ? { input: { hint: command.hint } } : {}) })), this.refused), learntAt: parsed.data.learntAt };
    } catch { /* nothing learnt yet */ }
  }

  current(): LearntCommands | null {
    return this.learnt;
  }

  /** One `available_commands_update` from a session of this agent. */
  learn(update: unknown, now: Date): void {
    const raw = (update as { availableCommands?: unknown } | null)?.availableCommands;
    if (!Array.isArray(raw)) return;
    const commands = normalizeAvailableCommands(raw as RawAvailableCommand[], this.refused);
    const previous = this.learnt;
    const learntAt = now.toISOString();
    const same = previous !== null && JSON.stringify(previous.commands) === JSON.stringify(commands);
    if (same && now.getTime() - Date.parse(previous.learntAt) < RELEARN_WRITE_INTERVAL_MS) return;
    this.learnt = { commands, learntAt };
    const value = { commands, learntAt };
    this.writes = this.writes.then(() => writeSecretFile(this.path, `${JSON.stringify(value)}\n`)).catch((error: unknown) => {
      this.logger?.warn({ errorCode: (error as NodeJS.ErrnoException)?.code ?? "write_failed" }, "the agent's slash commands could not be remembered");
    });
  }

  /** Test seam: the pending write, if any. */
  settled(): Promise<void> {
    return this.writes;
  }
}
