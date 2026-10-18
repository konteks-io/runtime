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
const absolutePath = z
  .string()
  .max(4096)
  .refine((value) => isAbsolute(value) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
const linksSchema = z.record(linkName, absolutePath);
const skillRecordSchema = z
  .object({
    skillId: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    treeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const skillRecordsSchema = z.record(linkName, skillRecordSchema);
const stateSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1).max(128),
    instanceId: z.string().min(1).max(128),
    links: linksSchema,
    skills: skillRecordsSchema.optional(),
    // Write-ahead ownership: a process death midway through a sweep can be
    // reconciled against either target without adopting somebody else's files.
    pending: linksSchema.optional(),
    pendingSkills: skillRecordsSchema.optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const unsafe = () =>
  new RemoteInstanceError(
    "local_io_failure",
    "Shared Skill delivery found an unsafe profile or a changed managed Skill. Personal files were preserved.",
  );

function owned(stat: Stats, directory: boolean): void {
  if (unsafeType(stat, directory) || unsafeOwner(stat)) throw unsafe();
}
function unsafeType(stat: Stats, directory: boolean): boolean {
  return (
    stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  );
}
function unsafeOwner(stat: Stats): boolean {
  return (
    process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
  );
}
async function directory(path: string): Promise<Stats> {
  // Validate the parent before making a child; a symlinked profile/Skills
  // folder must never redirect creation or a later managed-link operation.
  try {
    return checked(await lstat(path));
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700 });
    return checked(await lstat(path));
  }
  function checked(stat: Stats) {
    owned(stat, true);
    return stat;
  }
}
async function readState(path: string): Promise<State | undefined> {
  const before = await readStateStat(path);
  if (!before) return undefined;
  owned(before, false);
  if (before.size > 128 * 1024) throw unsafe();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await parseStateHandle(handle, before);
  } catch {
    throw unsafe();
  } finally {
    await handle.close();
  }
}
async function readStateStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return undefined;
    throw unsafe();
  }
}
async function parseStateHandle(
  handle: Awaited<ReturnType<typeof open>>,
  before: Stats,
): Promise<State> {
  const stat = await handle.stat();
  owned(stat, false);
  if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size)
    throw unsafe();
  const bytes = Buffer.alloc(stat.size + 1);
  const read = await handle.read(bytes, 0, bytes.length, 0);
  if (read.bytesRead !== stat.size) throw unsafe();
  return stateSchema.parse(JSON.parse(bytes.subarray(0, stat.size).toString("utf8")));
}
async function saveState(path: string, value: State): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(stateSchema.parse(value)));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isFsErrorWithCode(error, "ENOENT")) throw error;
    });
  }
}
async function target(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) throw unsafe();
    // realpath would follow a broken target. readlink lets a deletion remove
    // only our link even after its immutable cache was removed externally.
    return resolve(await readlink(path));
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
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
  const profile = safeProfile(options.home);
  await options.assertAuthorized();
  const profileStat = await directory(profile);
  const canonicalHome = await realpath(profile);
  const skills = join(canonicalHome, "skills");
  const skillsStat = await directory(skills);
  // Retained versions stay outside native discovery; agents must not index
  // old trees or see the same Skill both through storage and its live link.
  const metadata = join(canonicalHome, ".konteks-skill-sync");
  await directory(metadata);
  const lock = acquireNativeRootLock(metadata);
  const statePath = join(metadata, "state.json");
  const treeStorage: { path: string; stat?: Stats } = { path: join(metadata, "trees") };
  const assertCurrent = () =>
    assertHomeCurrent({ profile, skills, profileStat, skillsStat, lock, treeStorage });
  try {
    const previous = await readState(statePath);
    assertOwner(previous, owner);
    treeStorage.stat = await directory(treeStorage.path);
    const plan = await buildSyncPlan({
      staged,
      owner,
      previous,
      treeStorage: treeStorage.path,
      assertCurrent,
    });
    await preflightManagedLinks(skills, plan);
    await options.assertAuthorized();
    await assertCurrent();
    await savePendingState(statePath, owner, previous, plan);
    await publishManagedLinks(skills, plan, assertCurrent);
    await options.assertAuthorized();
    await assertCurrent();
    await saveState(statePath, { version: 1, ...owner, links: plan.next, skills: plan.nextSkills });
    return Object.keys(plan.next).map((name) => join(skills, name));
  } finally {
    lock.release();
  }
}

type HomeSyncPlan = {
  previous: State | undefined;
  known: Record<string, string>;
  pending: Record<string, string>;
  next: Record<string, string>;
  nextSkills: Record<string, z.infer<typeof skillRecordSchema>>;
  names: Set<string>;
};
async function buildSyncPlan(input: {
  staged: StagedOrganizationSkills;
  owner: AgentHomeSkillSyncOptions["owner"];
  previous: State | undefined;
  treeStorage: string;
  assertCurrent: () => Promise<void>;
}): Promise<HomeSyncPlan> {
  const { staged, previous, treeStorage, assertCurrent } = input;
  const next: Record<string, string> = {};
  const nextSkills: Record<string, z.infer<typeof skillRecordSchema>> = {};
  await assertStagedRoot(staged.root);
  for (const skill of staged.skills)
    await retainSkillForPlan(skill, staged, treeStorage, next, nextSkills, assertCurrent);
  const known = previous?.links ?? {};
  const pending = previous?.pending ?? {};
  return {
    previous,
    known,
    pending,
    next,
    nextSkills,
    names: new Set([...Object.keys(known), ...Object.keys(pending), ...Object.keys(next)]),
  };
}
async function assertStagedRoot(root: string): Promise<void> {
  owned(await lstat(absolutePath.parse(root)), true);
}
async function retainSkillForPlan(
  skill: StagedOrganizationSkills["skills"][number],
  staged: StagedOrganizationSkills,
  treeStorage: string,
  next: Record<string, string>,
  nextSkills: Record<string, z.infer<typeof skillRecordSchema>>,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill.name) ||
    resolve(skill.directory) !== join(resolve(staged.root), skill.name) ||
    skill.skillFile !== join(skill.directory, "SKILL.md")
  )
    throw unsafe();
  owned(await lstat(skill.directory), true);
  owned(await lstat(skill.skillFile), false);
  const name = `konteks-${sha256Hex(skill.skillId)}`;
  if (Object.hasOwn(next, name)) throw unsafe();
  await assertCurrent();
  next[name] = await retainStagedSkill(skill, treeStorage);
  nextSkills[name] = skillRecordSchema.parse({
    skillId: skill.skillId,
    version: skill.version,
    name: skill.name,
    treeDigest: skill.treeDigest,
  });
}
function assertOwner(previous: State | undefined, owner: AgentHomeSkillSyncOptions["owner"]): void {
  if (
    previous &&
    (previous.workspaceId !== owner.workspaceId || previous.instanceId !== owner.instanceId)
  ) {
    throw new RemoteInstanceError(
      "workspace_binding_invalid",
      "This agent Skill folder belongs to another connected workspace or machine. Use a separate local agent profile.",
    );
  }
}
async function preflightManagedLinks(skills: string, plan: HomeSyncPlan): Promise<void> {
  // Preflight the complete sweep before changing one link; edited links and collisions stay untouched.
  for (const name of plan.names) {
    const current = await target(join(skills, name));
    if (current && current !== plan.known[name] && current !== plan.pending[name]) throw unsafe();
  }
}
async function savePendingState(
  path: string,
  owner: AgentHomeSkillSyncOptions["owner"],
  previous: State | undefined,
  plan: HomeSyncPlan,
): Promise<void> {
  const receipt: State = {
    version: 1,
    ...owner,
    links: { ...plan.known },
    skills: previous?.skills ?? {},
    pending: plan.next,
    pendingSkills: plan.nextSkills,
  };
  // Retain interrupted removals in the write-ahead set so another interruption cannot lose ownership.
  for (const [name, link] of Object.entries(plan.pending))
    if (!Object.hasOwn(plan.known, name)) receipt.links[name] = link;
  await saveState(path, receipt);
}
async function publishManagedLinks(
  skills: string,
  plan: HomeSyncPlan,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  for (const name of plan.names)
    await publishManagedLink(join(skills, name), name, plan, assertCurrent);
}
async function publishManagedLink(
  path: string,
  name: string,
  plan: HomeSyncPlan,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  await assertCurrent();
  const current = await target(path);
  const next = plan.next[name];
  if (current && !isAllowedManagedTarget(current, name, plan)) throw unsafe();
  if (current === next) return;
  // Junction rename-over-existing is not portable on Windows; receipt makes unlink/relink crash-recoverable.
  if (current) await unlink(path);
  if (next) await symlink(next, path, process.platform === "win32" ? "junction" : "dir");
}
function isAllowedManagedTarget(current: string, name: string, plan: HomeSyncPlan): boolean {
  return (
    current === plan.known[name] || current === plan.pending[name] || current === plan.next[name]
  );
}
async function assertHomeCurrent(input: {
  profile: string;
  skills: string;
  profileStat: Stats;
  skillsStat: Stats;
  lock: ReturnType<typeof acquireNativeRootLock>;
  treeStorage: { path: string; stat?: Stats };
}): Promise<void> {
  input.lock.assertOwned();
  const profile = await lstat(input.profile);
  const skills = await lstat(input.skills);
  owned(profile, true);
  owned(skills, true);
  if (
    profile.ino !== input.profileStat.ino ||
    profile.dev !== input.profileStat.dev ||
    skills.ino !== input.skillsStat.ino ||
    skills.dev !== input.skillsStat.dev
  )
    throw unsafe();
  if (input.treeStorage.stat) {
    const trees = await lstat(input.treeStorage.path);
    owned(trees, true);
    if (trees.ino !== input.treeStorage.stat.ino || trees.dev !== input.treeStorage.stat.dev)
      throw unsafe();
  }
}
function safeProfile(home: string): string {
  const profile = absolutePath.parse(home);
  if (resolve(profile) === parse(profile).root || resolve(profile) === resolve(homedir()))
    throw unsafe();
  return profile;
}

export interface AgentHomeSkillInventory {
  profileState: "ready" | "not_configured";
  skills: Array<{
    skillId: string;
    name: string;
    installedVersion: string | null;
    installedDigest: string | null;
    status: "installed" | "missing" | "changed" | "unknown" | "pending";
  }>;
}

/** Read only: reports the last recorded managed revision without claiming agent load. */
export async function inspectAgentHomeSkillSync(options: {
  home: string;
  owner: { workspaceId: string; instanceId: string };
  skills: readonly { skillId: string; name: string }[];
}): Promise<AgentHomeSkillInventory> {
  const context = await inspectContext(options.home, options.owner);
  if (!context) return emptyInventory(options.skills);
  const rows = await Promise.all(options.skills.map((skill) => inspectSkill(context, skill)));
  return { profileState: "ready", skills: rows };
}

type InspectionContext = { skillHome: string; state: State };
async function inspectContext(
  home: string,
  owner: AgentHomeSkillSyncOptions["owner"],
): Promise<InspectionContext | undefined> {
  const profile = safeProfile(home);
  const profileStat = await optionalDirectory(profile);
  if (!profileStat) return undefined;
  const canonicalHome = await realpath(profile);
  if ((await lstat(profile)).ino !== profileStat.ino) throw unsafe();
  const skillHome = join(canonicalHome, "skills");
  if (
    !(await optionalDirectory(skillHome)) ||
    !(await optionalDirectory(join(canonicalHome, ".konteks-skill-sync")))
  )
    return undefined;
  const state = await readState(join(canonicalHome, ".konteks-skill-sync", "state.json"));
  if (!state) return undefined;
  if (state.workspaceId !== owner.workspaceId || state.instanceId !== owner.instanceId) {
    throw new RemoteInstanceError(
      "workspace_binding_invalid",
      "This agent Skill folder belongs to another connected workspace or machine.",
    );
  }
  return { skillHome, state };
}
async function optionalDirectory(path: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path);
    owned(stat, true);
    return stat;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
}
async function inspectSkill(
  context: InspectionContext,
  skill: { skillId: string; name: string },
): Promise<AgentHomeSkillInventory["skills"][number]> {
  const name = `konteks-${sha256Hex(skill.skillId)}`;
  const current = await target(join(context.skillHome, name));
  const record = context.state.skills?.[name];
  const status = managedSkillStatus(context.state, name, current, skill.skillId);
  return {
    skillId: skill.skillId,
    name: skill.name,
    installedVersion: status === "installed" ? record!.version : null,
    installedDigest: status === "installed" ? record!.treeDigest : null,
    status,
  };
}
function managedSkillStatus(
  state: State,
  name: string,
  current: string | undefined,
  skillId: string,
): AgentHomeSkillInventory["skills"][number]["status"] {
  if (hasPendingSkill(state, name)) return "pending";
  if (current === undefined) return "missing";
  if (!matchesManagedLink(state, name, current)) return "changed";
  if (!hasExpectedSkillRecord(state, name, skillId)) return "unknown";
  return "installed";
}
function hasPendingSkill(state: State, name: string): boolean {
  return Boolean(state.pending?.[name] || state.pendingSkills?.[name]);
}
function matchesManagedLink(state: State, name: string, current: string): boolean {
  return state.links[name] !== undefined && current === state.links[name];
}
function hasExpectedSkillRecord(state: State, name: string, skillId: string): boolean {
  return state.skills?.[name]?.skillId === skillId;
}

function emptyInventory(
  skills: readonly { skillId: string; name: string }[],
): AgentHomeSkillInventory {
  return {
    profileState: "not_configured",
    skills: skills.map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      installedVersion: null,
      installedDigest: null,
      status: "missing",
    })),
  };
}
