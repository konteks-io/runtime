import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import {
  computeRemoteFileTreeDigest,
  LocalRuntimeSkillShareSchema,
  REMOTE_FILE_TREE_LIMITS,
  RemoteFileTreeSchema,
  type LocalRuntimeSkillShare,
  type LocalSkillPublication,
  type RemoteFileEntry,
  type RemoteFileTree,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

export interface LocalSkillSourceHome {
  profileId: string;
  home: string;
}

export interface LocalSkillTreeSnapshot {
  identity: string;
  name: string;
  tree: RemoteFileTree;
}

const unavailable = (message: string) => new RemoteInstanceError("capability_unavailable", message);
const digestBytes = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function explicitPath(value: string): boolean {
  return isAbsolute(value) || value.startsWith("./") || value.startsWith("../") ||
    value.includes("/") || value.includes("\\");
}

interface SkillTreeWalkState {
  root: string;
  entries: RemoteFileEntry[];
  totalBytes: number;
}

function assertSkillPathContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw unavailable("The selected Skill contains a path outside its folder.");
  }
}

async function appendSkillFile(
  state: SkillTreeWalkState,
  absolute: string,
  path: string,
  info: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  assertAllowedSkillFile(info, state.totalBytes);
  const bytes = await readStableSkillFile(absolute, info);
  state.totalBytes += bytes.length;
  state.entries.push({
    path,
    mode: Number(info.mode) & 0o111 ? 0o700 : 0o600,
    sizeBytes: bytes.length,
    digest: digestBytes(bytes),
    contentBase64: bytes.toString("base64"),
  });
}

function assertAllowedSkillFile(info: Awaited<ReturnType<typeof lstat>>, totalBytes: number): void {
  if (!info.isFile()) throw unavailable("Skill folders may contain only regular files and directories.");
  if (info.size > REMOTE_FILE_TREE_LIMITS.bytes - totalBytes) {
    throw unavailable("The selected Skill exceeds the transfer-size limit.");
  }
}

function assertStableSkillFile(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): void {
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw unavailable("A Skill file changed while it was being read; retry the share.");
  }
}

async function readStableSkillFile(absolute: string, info: Awaited<ReturnType<typeof lstat>>): Promise<Buffer> {
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  assertStableSkillFile(info, after);
  return bytes;
}

async function visitSkillEntry(
  state: SkillTreeWalkState,
  current: string,
  relativeDirectory: string,
  name: string,
): Promise<void> {
  if (state.entries.length >= REMOTE_FILE_TREE_LIMITS.files) throw unavailable("The selected Skill exceeds the file-count limit.");
  const absolute = join(current, name);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw unavailable("Skill folders cannot contain symbolic links.");
  assertSkillPathContained(state.root, await realpath(absolute));
  const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
  if (info.isDirectory()) {
    await walkSkillDirectory(state, absolute, path);
    return;
  }
  await appendSkillFile(state, absolute, path, info);
}

async function walkSkillDirectory(state: SkillTreeWalkState, current: string, relativeDirectory: string): Promise<void> {
  const names = (await readdir(current)).sort((a, b) => a.localeCompare(b, "en"));
  for (const name of names) await visitSkillEntry(state, current, relativeDirectory, name);
}

async function treeAt(directory: string): Promise<RemoteFileTree> {
  const rootInfo = await lstat(directory).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw unavailable("The selected Skill folder is unavailable or is a symlink.");
  const root = await realpath(directory);
  const state: SkillTreeWalkState = { root, entries: [], totalBytes: 0 };
  await walkSkillDirectory(state, root, "");
  if (!state.entries.some(entry => entry.path === "SKILL.md")) throw unavailable("The selected folder does not contain a root SKILL.md file.");
  return RemoteFileTreeSchema.parse({
    format: "konteks-file-tree-v1",
    entries: state.entries,
    treeDigest: computeRemoteFileTreeDigest(state.entries),
  });
}

function skillCandidates(value: string, homes: readonly LocalSkillSourceHome[]) {
  if (explicitPath(value)) {
    return [{ profileId: "path", directory: isAbsolute(value) ? value : resolve(value), identity: resolve(value) }];
  }
  return homes.map(home => ({
    profileId: home.profileId,
    directory: join(home.home, "skills", value),
    identity: `${home.profileId}:skills/${value}`,
  }));
}

function candidatesForExpectedIdentity(
  value: string,
  candidates: ReturnType<typeof skillCandidates>,
  expectedIdentity?: string,
) {
  if (expectedIdentity === undefined || !explicitPath(value)) return candidates;
  const selected = candidates.filter(candidate => candidate.identity === expectedIdentity);
  if (!selected.length) throw unavailable("The confirmed Skill source is no longer configured on this runtime.");
  return selected;
}

async function collectSkillSnapshots(candidates: ReturnType<typeof skillCandidates>): Promise<LocalSkillTreeSnapshot[]> {
  const snapshots: LocalSkillTreeSnapshot[] = [];
  for (const candidate of candidates) {
    const isDirectory = await lstat(candidate.directory)
      .then(info => info.isDirectory() && !info.isSymbolicLink())
      .catch(() => false);
    if (!isDirectory) continue;
    snapshots.push({ identity: candidate.identity, name: basename(candidate.directory), tree: await treeAt(candidate.directory) });
  }
  return snapshots;
}

function assertSkillSnapshots(
  value: string,
  snapshots: readonly LocalSkillTreeSnapshot[],
  expectedIdentity?: string,
): void {
  if (!snapshots.length) {
    throw unavailable(explicitPath(value)
      ? "The selected Skill folder could not be read."
      : "No configured coding-agent profile contains that Skill name.");
  }
  if (expectedIdentity !== undefined && !snapshots.some(item => item.identity === expectedIdentity)) {
    throw unavailable("The confirmed Skill source is no longer configured on this runtime.");
  }
  if (snapshots.some(item => item.tree.treeDigest !== snapshots[0]!.tree.treeDigest)) {
    throw unavailable("That Skill differs between coding-agent profiles. Choose a folder path to share one exact version.");
  }
}

function selectedSnapshot(snapshots: readonly LocalSkillTreeSnapshot[], expectedIdentity?: string): LocalSkillTreeSnapshot {
  if (expectedIdentity !== undefined) return snapshots.find(item => item.identity === expectedIdentity)!;
  return snapshots[0]!;
}

/** Resolves a user path or an installed native-home Skill without following links. */
export async function snapshotLocalSkill(
  selected: string,
  homes: readonly LocalSkillSourceHome[],
  expectedIdentity?: string,
): Promise<LocalSkillTreeSnapshot> {
  const value = selected.trim();
  if (!value) throw unavailable("Choose a Skill name or folder.");
  const candidates = skillCandidates(value, homes);
  const selectedCandidates = candidatesForExpectedIdentity(value, candidates, expectedIdentity);
  const snapshots = await collectSkillSnapshots(selectedCandidates);
  assertSkillSnapshots(value, snapshots, expectedIdentity);
  snapshots.sort((a, b) => a.identity.localeCompare(b.identity, "en"));
  return selectedSnapshot(snapshots, expectedIdentity);
}

export function makeLocalSkillShare(
  snapshot: LocalSkillTreeSnapshot,
  instanceId: string,
  publication: LocalSkillPublication,
  stableLocalId?: string,
): LocalRuntimeSkillShare {
  const localId = stableLocalId ?? createHash("sha256")
    .update(`konteks-local-skill-id-v1\0${instanceId}\0${snapshot.identity}`)
    .digest("hex");
  return LocalRuntimeSkillShareSchema.parse({ localId, publication, tree: snapshot.tree });
}

/** Private Skill identity is stable across the owner's runtimes; shared scopes reuse this id. */
export function makeLocalPersonalSkillShare(
  snapshot: LocalSkillTreeSnapshot,
  instanceId: string,
): LocalRuntimeSkillShare {
  const localId = createHash("sha256")
    .update(`konteks-personal-skill-id-v1\0${snapshot.identity}`)
    .digest("hex");
  return makeLocalSkillShare(snapshot, instanceId, {
    audience: { kind: "personal" },
    context: { kind: "global" },
  }, localId);
}
