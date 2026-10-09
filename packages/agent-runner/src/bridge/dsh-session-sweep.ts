import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** A model-capability check's private folder (`model-capability.ts`), as dsh names the project it files that session under. */
const DISCOVERY_PROJECT = /-\.model-discovery-[A-Za-z0-9]+--$/;
/** A check still under way is left alone: it lasts seconds, and a retry at most minutes. */
const DISCOVERY_SETTLED_MS = 10 * 60_000;

/**
 * Forget the sessions the runtime's model-capability checks left in dsh's
 * store. Each check is one `session/new` in a fresh folder that is removed
 * afterwards, but dsh keeps that session as a project of its own forever: on
 * 10-09, 1,600 of them had piled up in a week, and from the one that made
 * 1,600 on, every dsh process failed `initialize` (-32603). The person's own
 * sessions are never touched: only projects named for a check's folder, and
 * their sessions' cached projections.
 */
export async function sweepDshDiscoverySessions(dshHome: string, now = Date.now()): Promise<number> {
  const sessionsDir = join(dshHome, "sessions");
  const projections = join(dshHome, "storages", "session_projcache", "sessions");
  let projects: string[];
  try { projects = await readdir(sessionsDir); } catch { return 0; }
  let swept = 0;
  for (const project of projects.filter(name => DISCOVERY_PROJECT.test(name))) {
    const dir = join(sessionsDir, project);
    if (!(await settled(dir, now))) continue;
    for (const session of await readdir(dir).catch(() => [] as string[])) {
      await rm(join(projections, `${session}.json`), { force: true });
    }
    await rm(dir, { recursive: true, force: true });
    swept += 1;
  }
  return swept;
}

async function settled(dir: string, now: number): Promise<boolean> {
  try { return now - (await stat(dir)).mtimeMs >= DISCOVERY_SETTLED_MS; } catch { return false; }
}
