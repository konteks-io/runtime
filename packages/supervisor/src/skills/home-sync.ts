import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isFsErrorWithCode, RemoteInstanceError, sha256Hex } from "@konteks/remote-common";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { retainStagedSkill, type StagedOrganizationSkills } from "./staging.js";

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

function validKind(stat: Stats, directory: boolean): boolean {
  if (stat.isSymbolicLink()) return false;
  return directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1;
}
function owned(stat: Stats, directory: boolean): void {
  if (!validKind(stat, directory)) throw unsafe();
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) throw unsafe();
}
async function directory(path: string): Promise<Stats> {
  // Validate the parent before making a child; a symlinked profile/Skills
  // folder must never redirect creation or a later managed-link operation.
  try { return checked(await lstat(path)); }
  catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700 });
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
    assertSameFile(before, stat);
    if (before.size !== stat.size) throw unsafe();
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

export interface AgentHomeSkillSyncOptions {
  /** Local operator-owned agent config folder. Never supplied by Core. */
  home: string;
  owner: { workspaceId: string; instanceId: string };
  /** The result of verified staging, not an arbitrary download/feed. */
  staged: StagedOrganizationSkills;
  /** Rechecks current signed selection, instance, and claim before publishing. */
  assertAuthorized: () => Promise<void>;
}


function assertSameFile(before: Stats, after: Stats): void {
  if (before.ino !== after.ino || before.dev !== after.dev) throw unsafe();
}
async function retainSkills(staged: StagedOrganizationSkills, trees: string, assertCurrent: () => Promise<void>): Promise<Record<string, string>> {
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
  return next;
}
function assertOwner(previous: State | undefined, owner: AgentHomeSkillSyncOptions["owner"]): void {
  if (previous && (previous.workspaceId !== owner.workspaceId || previous.instanceId !== owner.instanceId)) {
    throw new RemoteInstanceError("workspace_binding_invalid", "This agent Skill folder belongs to another connected workspace or machine. Use a separate local agent profile.");
  }
}
function receiptFor(owner: AgentHomeSkillSyncOptions["owner"], known: Record<string, string>, pending: Record<string, string>, next: Record<string, string>): State {
  const receipt: State = { version: 1, ...owner, links: known, pending: next };
  for (const [name, path] of Object.entries(pending)) if (!Object.hasOwn(known, name)) receipt.links[name] = path;
  return receipt;
}
async function preflightLinks(skills: string, names: Set<string>, known: Record<string, string>, pending: Record<string, string>): Promise<void> {
  for (const name of names) {
    const current = await target(join(skills, name));
    if (current && current !== known[name] && current !== pending[name]) throw unsafe();
  }
}
async function publishLinks(skills: string, names: Set<string>, known: Record<string, string>, pending: Record<string, string>, next: Record<string, string>, assertCurrent: () => Promise<void>): Promise<void> {
  for (const name of names) {
    await assertCurrent();
    const path = join(skills, name); const current = await target(path);
    assertManagedTarget(current, [known[name], pending[name], next[name]]);
    if (current === next[name]) continue;
    // Junction replacement is unlink/relink; the write-ahead receipt preserves interrupted ownership.
    if (current) await unlink(path);
    if (next[name]) await symlink(next[name]!, path, process.platform === "win32" ? "junction" : "dir");
  }
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
    assertSameFile(profileStat, a); assertSameFile(skillsStat, b);
    if (treeStorage) {
      const stat = await lstat(treeStorage.path); owned(stat, true);
      assertSameFile(treeStorage.stat, stat);
    }
  };
  try {
    const previous = await readState(statePath);
    assertOwner(previous, owner);
    const trees = join(metadata, "trees"); treeStorage = { path: trees, stat: await directory(trees) };
    const next = await retainSkills(staged, trees, assertCurrent);
    const known = previous?.links ?? {};
    const pending = previous?.pending ?? {};
    const names = new Set([...Object.keys(known), ...Object.keys(pending), ...Object.keys(next)]);
    // Preflight the complete sweep before changing one link. Refuse collisions
    // and edited links; do not "repair" them by replacing somebody else's data.
    await preflightLinks(skills, names, known, pending);
    await options.assertAuthorized(); await assertCurrent();
    const receipt = receiptFor(owner, known, pending, next);
    await saveState(statePath, receipt);
    await publishLinks(skills, names, known, pending, next, assertCurrent);
    await options.assertAuthorized(); await assertCurrent();
    await saveState(statePath, { version: 1, ...owner, links: next });
    return Object.keys(next).map(name => join(skills, name));
  } finally { lock.release(); }
}

function assertManagedTarget(current: string | undefined, allowed: Array<string | undefined>): void {
  if (current && !allowed.includes(current)) throw unsafe();
}
