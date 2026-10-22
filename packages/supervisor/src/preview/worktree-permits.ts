import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The worktrees a viewer may start a preview in, by session, kept on disk so
 * a delivered session's preview can still be opened after the session was
 * released or the connector restarted (09-30: a ticket's delivery preview read
 * "Nothing to preview yet" half an hour after the delivery, its worktree still
 * on disk). A session that ends any other way keeps its entry too (D96: a
 * ticket's QA that failed, a drain for an update or a cancelled turn keeps
 * the changes on disk); a later bootstrap of the session replaces it. An
 * entry whose worktree is gone is dropped when the store is loaded.
 */
type Permit = { cwd: string; managedRepository?: true };

function readPermit(value: unknown): Permit | undefined {
  if (typeof value === "string") return { cwd: value };
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<Permit>;
  if (typeof candidate.cwd !== "string" || candidate.managedRepository !== true) return undefined;
  if (Object.keys(candidate).some(key => key !== "cwd" && key !== "managedRepository")) return undefined;
  return { cwd: candidate.cwd, managedRepository: true };
}

export class PreviewWorktreePermits {
  readonly #entries = new Map<string, Permit>();

  constructor(private readonly file: string, exists: (path: string) => boolean = existsSync) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [sessionId, value] of Object.entries(stored)) {
        const permit = readPermit(value);
        if (permit && exists(permit.cwd)) this.#entries.set(sessionId, permit);
      }
    } catch { /* none kept yet, or unreadable: start empty */ }
  }

  get(sessionId: string): string | undefined {
    return this.#entries.get(sessionId)?.cwd;
  }

  managedRepository(sessionId: string): true | undefined {
    return this.#entries.get(sessionId)?.managedRepository;
  }

  set(sessionId: string, cwd: string, managedRepository?: true): void {
    const previous = this.#entries.get(sessionId);
    if (previous?.cwd === cwd && previous.managedRepository === managedRepository) return;
    this.#entries.set(sessionId, { cwd, ...(managedRepository ? { managedRepository } : {}) });
    this.#save();
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify(Object.fromEntries([...this.#entries].map(([id, permit]) => [id, permit.managedRepository ? permit : permit.cwd]))), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* the permits still hold for this run */ }
  }
}
