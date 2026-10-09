import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sweepDshDiscoverySessions } from "../bridge/dsh-session-sweep.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const project = (folder: string) => `-${`/Users/me/Library/Application Support/konteks-remote/workspaces/dsh/${folder}`.replace(/\//g, "-").replace(/ /g, "~0020")}--`;

async function store(sessions: { folder: string; id: string; minutesAgo: number }[]) {
  const home = await mkdtemp(join(tmpdir(), "dsh-home-")); roots.push(home);
  const projections = join(home, "storages", "session_projcache", "sessions");
  await mkdir(projections, { recursive: true });
  for (const { folder, id, minutesAgo } of sessions) {
    const dir = join(home, "sessions", project(folder));
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, "session.lock"), "");
    await writeFile(join(projections, `${id}.json`), "{}");
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await utimes(dir, at, at);
  }
  return { home, projections };
}

// 10-09: 1,600 checks' sessions in a week, and from then on dsh failed `initialize`.
it("forgets settled model-check sessions and keeps the person's own and a check under way", async () => {
  const { home, projections } = await store([
    { folder: ".model-discovery-BzKBlm", id: "old-check-1", minutesAgo: 240 },
    { folder: ".model-discovery-uqy9b1", id: "old-check-2", minutesAgo: 60 * 24 * 7 },
    { folder: ".model-discovery-Fresh1", id: "running-check", minutesAgo: 1 },
    { folder: "session-0477158a/source", id: "persons-session", minutesAgo: 600 },
  ]);
  expect(await sweepDshDiscoverySessions(home)).toBe(2);
  expect((await readdir(join(home, "sessions"))).sort()).toEqual([project(".model-discovery-Fresh1"), project("session-0477158a/source")].sort());
  expect((await readdir(projections)).sort()).toEqual(["persons-session.json", "running-check.json"]);
  // Nothing more to do the second time.
  expect(await sweepDshDiscoverySessions(home)).toBe(0);
});

it("does nothing for a dsh home with no sessions yet", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-home-")); roots.push(home);
  expect(await sweepDshDiscoverySessions(home)).toBe(0);
});
