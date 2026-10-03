import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isFsErrorWithCode, RemoteInstanceError, sha256Hex } from "@konteks/remote-common";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { retainStagedSkill, verifyRetainedSkillTree, type StagedOrganizationSkills } from "./staging.js";

const linkName = z.string().regex(/^konteks-[a-f0-9]{64}$/);
const absolutePath = z.string().max(4096).refine(value => isAbsolute(value) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
const linksSchema = z.record(linkName, absolutePath);
const stateSchema = z.object({
  version: z.literal(1), workspaceId: z.string().min(1).max(128), instanceId: z.string().min(1).max(128),
  links: linksSchema,
  // Write-ahead ownership: a process death midway through a sweep can be
  // reconciled against either target without adopting somebody else's files.
  pending: linksSchema.optional(),
}).strict();
type State = z.infer<typeof stateSchema>;
const unsafe = () => new RemoteInstanceError("local_io_failure", "Shared Skill delivery found an unsafe profile or a changed managed Skill. Personal files were preserved.");

function owned(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw unsafe();
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) throw unsafe();
}
async function directory(path: string): Promise<Stats> {
  // Validate the parent before making a child; a symlinked profile/Skills
  // folder must never redirect creation or a later managed-link operation.
  try { return checked(await lstat(path)); }
  catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw unsafe();
    const before = await directory(parent);
    await mkdir(path, { mode: 0o700 });
    const after = checked(await lstat(parent));
    if (before.ino !== after.ino || before.dev !== after.dev) throw unsafe();
    return checked(await lstat(path));
  }
  function checked(stat: Stats) { owned(stat, true); return stat; }
}
async function readState(path: string): Promise<State | undefined> {
  let before: Stats;
  try { before = await lstat(path); }
  catch (error) { if (isFsErrorWithCode(error, "ENOENT")) return undefined; throw unsafe(); }
  owned(before, false);
  if (before.size > 128 * 1024) throw unsafe();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); owned(stat, false);
    if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw unsafe();
    const bytes = Buffer.alloc(stat.size + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) throw unsafe();
    return stateSchema.parse(JSON.parse(bytes.subarray(0, stat.size).toString("utf8")));
  } catch { throw unsafe(); }
  finally { await handle.close(); }
}
async function saveState(path: string, value: State): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(stateSchema.parse(value))); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (!isFsErrorWithCode(error, "ENOENT")) throw error; }); }
}
async function target(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) throw unsafe();
    // realpath would follow a broken target. readlink lets a deletion remove
    // only our link even after its immutable cache was removed externally.
    return resolve(await readlink(path));
  } catch (error) { if (isFsErrorWithCode(error, "ENOENT")) return undefined; throw error; }
}

/** Remove discovery only after the caller has stopped this runtime. Retained
 * trees stay outside discovery; never recursively delete an agent profile. */
export async function removeAgentHomeSkillLinks(options: {
  home: string; owner: { workspaceId: string; instanceId: string };
}): Promise<number> {
  const home = absolutePath.parse(options.home);
  const metadata = join(home, ".konteks-skill-sync");
  const statePath = join(metadata, "state.json");
  try { owned(await lstat(home), true); owned(await lstat(metadata), true); }
  catch (error) { if (isFsErrorWithCode(error, "ENOENT")) return 0; throw error; }
  const skills = join(home, "skills"); owned(await lstat(skills), true);
  const folders = [home, metadata, skills];
  const identities = await Promise.all(folders.map(path => lstat(path)));
  const lock = acquireNativeRootLock(metadata);
  try {
    const state = await readState(statePath); if (!state) return 0;
    if (state.workspaceId !== options.owner.workspaceId || state.instanceId !== options.owner.instanceId) {
      throw new RemoteInstanceError("workspace_binding_invalid", "This agent Skill folder belongs to another workspace or runtime. Its Skills were preserved.");
    }
    const known = state.links, pending = state.pending ?? {};
    const names = [...new Set([...Object.keys(known), ...Object.keys(pending)])];
    const assertCurrent = async () => {
      lock.assertOwned();
      for (const [index, path] of folders.entries()) {
        const current = await lstat(path); owned(current, true);
        if (current.ino !== identities[index]!.ino || current.dev !== identities[index]!.dev) throw unsafe();
      }
      if (JSON.stringify(await readState(statePath)) !== JSON.stringify(state)) throw unsafe();
    };
    // Check every collision before removing even one link. Preserve the receipt
    // until completion so an interruption can safely retry missing links.
    for (const name of names) {
      const current = await target(join(skills, name));
      if (current && current !== known[name] && current !== pending[name]) throw unsafe();
    }
    let removed = 0;
    for (const name of names) {
      await assertCurrent();
      const path = join(skills, name), current = await target(path);
      if (current && current !== known[name] && current !== pending[name]) throw unsafe();
      if (current) { await unlink(path); removed += 1; }
    }
    await assertCurrent(); await unlink(statePath);
    return removed;
  } finally { lock.release(); }
}

export interface AgentHomeSkillSyncOptions {
  /** Local operator-owned agent config folder. Never supplied by Core. */
  home: string;
  owner: { workspaceId: string; instanceId: string };
  /** The result of verified staging, not an arbitrary download/feed. */
  staged: StagedOrganizationSkills;
  /** Rechecks current signed selection, instance, and claim before publishing. */
  assertAuthorized: () => Promise<void>;
}

/** Retain and publish full immutable folders into native discovery without copying any
 * credentials or mutating personal Skill directories. Windows uses junctions,
 * so the operator does not need Developer Mode or symlink privileges. */
export async function syncAgentHomeSkills(options: AgentHomeSkillSyncOptions): Promise<string[]> {
  const { owner, staged } = options;
  const profile = absolutePath.parse(options.home);
  if (resolve(profile) === parse(profile).root || resolve(profile) === resolve(homedir())) throw unsafe();
  await options.assertAuthorized();
  const profileStat = await directory(profile);
  const canonicalHome = await realpath(profile);
  const skills = join(canonicalHome, "skills"); const skillsStat = await directory(skills);
  // Retained versions stay outside native discovery; agents must not index
  // old trees or see the same Skill both through storage and its live link.
  const metadata = join(canonicalHome, ".konteks-skill-sync"); await directory(metadata);
  const lock = acquireNativeRootLock(metadata);
  const statePath = join(metadata, "state.json");
  let treeStorage: { path: string; stat: Stats } | undefined;
  const assertCurrent = async () => {
    lock.assertOwned();
    const a = await lstat(profile), b = await lstat(skills);
    owned(a, true); owned(b, true);
    if (a.ino !== profileStat.ino || a.dev !== profileStat.dev || b.ino !== skillsStat.ino || b.dev !== skillsStat.dev) throw unsafe();
    if (treeStorage) {
      const stat = await lstat(treeStorage.path); owned(stat, true);
      if (stat.ino !== treeStorage.stat.ino || stat.dev !== treeStorage.stat.dev) throw unsafe();
    }
  };
  try {
    const previous = await readState(statePath);
    if (previous && (previous.workspaceId !== owner.workspaceId || previous.instanceId !== owner.instanceId)) {
      throw new RemoteInstanceError("workspace_binding_invalid", "This agent Skill folder belongs to another connected workspace or machine. Use a separate local agent profile.");
    }
    const trees = join(metadata, "trees"); treeStorage = { path: trees, stat: await directory(trees) };
    const next: Record<string, string> = {};
    owned(await lstat(absolutePath.parse(staged.root)), true);
    for (const skill of staged.skills) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill.name) || resolve(skill.directory) !== join(resolve(staged.root), skill.name) || skill.skillFile !== join(skill.directory, "SKILL.md")) throw unsafe();
      owned(await lstat(skill.directory), true); owned(await lstat(skill.skillFile), false);
      const name = `konteks-${sha256Hex(skill.skillId)}`;
      if (Object.hasOwn(next, name)) throw unsafe();
      await assertCurrent();
      next[name] = await retainStagedSkill(skill, trees);
    }
    const known = previous?.links ?? {};
    const pending = previous?.pending ?? {};
    const names = new Set([...Object.keys(known), ...Object.keys(pending), ...Object.keys(next)]);
    // Preflight the complete sweep before changing one link. Refuse collisions
    // and edited links; do not "repair" them by replacing somebody else's data.
    for (const name of names) {
      const current = await target(join(skills, name));
      if (current && current !== known[name] && current !== pending[name]) throw unsafe();
    }
    await options.assertAuthorized(); await assertCurrent();
    const receipt: State = { version: 1, ...owner, links: known, pending: next };
    // Keep interrupted targets in the write-ahead set until their links have
    // been removed; a second interruption must not lose their ownership.
    for (const [name, path] of Object.entries(pending)) if (!Object.hasOwn(known, name)) receipt.links[name] = path;
    await saveState(statePath, receipt);
    for (const name of names) {
      await assertCurrent();
      const path = join(skills, name); const current = await target(path);
      if (current && current !== known[name] && current !== pending[name] && current !== next[name]) throw unsafe();
      if (current === next[name]) continue;
      // Junction rename-over-existing is not portable on Windows. The
      // write-ahead receipt makes this bounded unlink/relink crash-recoverable.
      if (current) await unlink(path);
      if (next[name]) await symlink(next[name]!, path, process.platform === "win32" ? "junction" : "dir");
    }
    await options.assertAuthorized(); await assertCurrent();
    await saveState(statePath, { version: 1, ...owner, links: next });
    return Object.keys(next).map(name => join(skills, name));
  } finally { lock.release(); }
}

/** Read-only completion check against the current owned discovery link and
 * complete immutable tree. Neither a receipt nor a path alone establishes use. */
export async function verifyAgentHomeSkillRead(options: {
  home: string; owner: { workspaceId: string; instanceId: string };
  skill: StagedOrganizationSkills["skills"][number];
}): Promise<boolean> {
  try {
    const home = absolutePath.parse(options.home);
    const folders = [home, join(home, "skills"), join(home, ".konteks-skill-sync"), join(home, ".konteks-skill-sync", "trees")];
    for (const folder of folders) owned(await lstat(folder), true);
    const statePath = join(home, ".konteks-skill-sync", "state.json");
    const state = await readState(statePath);
    if (!state || state.pending || state.workspaceId !== options.owner.workspaceId || state.instanceId !== options.owner.instanceId) return false;
    const name = `konteks-${sha256Hex(options.skill.skillId)}`;
    const tree = join(await realpath(home), ".konteks-skill-sync", "trees", `tree-${sha256Hex(options.skill.treeDigest)}`);
    const link = join(home, "skills", name);
    if (state.links[name] !== tree || await target(link) !== tree) return false;
    await verifyRetainedSkillTree(options.skill, tree);
    const current = await readState(statePath);
    if (!current || JSON.stringify(current) !== JSON.stringify(state) || await target(link) !== tree) return false;
    for (const folder of folders) owned(await lstat(folder), true);
    return true;
  } catch { return false; }
}
