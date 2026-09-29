import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The worktrees a viewer may start a preview in, by session, kept on disk so
 * a delivered session's preview can still be opened after the session was
 * released or the connector restarted (09-30: a ticket's delivery preview read
 * "Nothing to preview yet" half an hour after the delivery, its worktree still
 * on disk). An entry whose worktree is gone is dropped when read.
 */
export class PreviewWorktreePermits {
  readonly #entries = new Map<string, string>();

  constructor(private readonly file: string, exists: (path: string) => boolean = existsSync) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [sessionId, cwd] of Object.entries(stored)) {
        if (typeof cwd === "string" && exists(cwd)) this.#entries.set(sessionId, cwd);
      }
    } catch { /* none kept yet, or unreadable: start empty */ }
  }

  get(sessionId: string): string | undefined {
    return this.#entries.get(sessionId);
  }

  set(sessionId: string, cwd: string): void {
    if (this.#entries.get(sessionId) === cwd) return;
    this.#entries.set(sessionId, cwd);
    this.#save();
  }

  delete(sessionId: string): void {
    if (this.#entries.delete(sessionId)) this.#save();
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify(Object.fromEntries(this.#entries)), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* the permits still hold for this run */ }
  }
}
