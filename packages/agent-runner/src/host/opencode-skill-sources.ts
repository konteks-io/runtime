import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
const unavailable = () =>
  new RemoteInstanceError(
    "agent_unavailable",
    "OpenCode Skill discovery requires a closed, private authorized snapshot.",
  );
function privateModes(directory: boolean, executableSupport: boolean): number[] {
  if (directory) return [0o700];
  return executableSupport ? [0o600, 0o700] : [0o600];
}
function owned(stat: Stats, directory: boolean, executableSupport = false): void {
  if (stat.isSymbolicLink() || !expectedKind(stat, directory)) throw unavailable();
  if (process.platform === "win32") return;
  const modes = privateModes(directory, executableSupport);
  if (stat.uid !== process.getuid?.() || !modes.includes(stat.mode & 0o777))
    throw unavailable();
}
function expectedKind(stat: Stats, directory: boolean): boolean {
  return directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1;
}
async function closedSnapshot(parent: string, roots: readonly string[]): Promise<void> {
  owned(await lstat(parent), true);
  if ((await realpath(parent)) !== parent) throw unavailable();
  const expected = [".catalog.json", ...roots.map((root) => basename(root))].sort();
  if (JSON.stringify((await readdir(parent)).sort()) !== JSON.stringify(expected))
    throw unavailable();
  owned(await lstat(join(parent, ".catalog.json")), false);
  for (const root of roots) {
    owned(await lstat(root), true);
    owned(await lstat(join(root, "SKILL.md")), false, true);
    await selectedSkillOnly(root);
  }
  if (JSON.stringify((await readdir(parent)).sort()) !== JSON.stringify(expected))
    throw unavailable();
}
async function selectedSkillOnly(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "SKILL.md" && entry.parentPath !== root) throw unavailable();
    owned(await lstat(join(entry.parentPath, entry.name)), entry.isDirectory(), true);
  }
}
function canonicalRoot(root: string): void {
  if (!isAbsolute(root) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(root) || resolve(root) !== root)
    throw unavailable();
}
/** One explicit source per closed snapshot preserves folder-derived Skill IDs.
 * Digest and execution-scope verification remain the supervisor's authority. */
export async function openCodeSkillSources(readOnlyRoots: readonly string[]): Promise<string[]> {
  if (readOnlyRoots.length > 128) throw unavailable();
  const groups = new Map<string, string[]>();
  const identities = new Set<string>();
  for (const root of new Set(readOnlyRoots)) {
    canonicalRoot(root);
    const identity = basename(root);
    if (identities.has(identity)) throw unavailable();
    identities.add(identity);
    const parent = dirname(root);
    groups.set(parent, [...(groups.get(parent) ?? []), root]);
  }
  for (const [parent, roots] of groups) await closedSnapshot(parent, roots);
  return [...groups.keys()].sort();
}
