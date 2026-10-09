import { constants, type Stats } from "node:fs";
import { lstat, readdir, open, realpath, type FileHandle } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import {
  computeRemoteFileTreeDigest,
  RemoteFileTreeSchema,
  LocalSkillSummarySchema,
  type LocalSkillSummary,
  type RemoteFileEntry,
  type RemoteFileTree,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
const unavailable = () => new Error("Local Skill is unavailable or has changed");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const same = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) =>
  a.ino === b.ino && a.dev === b.dev;
interface TreeState { entries: RemoteFileEntry[]; bytes: number }
type FileStat = Stats;
function assertDirectory(stat: FileStat): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
}
function assertFile(stat: FileStat, state: TreeState): void {
  if (!stat.isFile() || stat.nlink !== 1 || state.entries.length >= 512 || stat.size + state.bytes > 8 * 1024 * 1024) throw unavailable();
}
function assertOpened(stat: FileStat, opened: FileStat): void {
  if (!opened.isFile() || opened.nlink !== 1 || !same(stat, opened) || opened.size !== stat.size) throw unavailable();
}
async function readBounded(file: FileHandle, expectedBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedBytes + 1);
  let received = 0;
  while (received < buffer.length) {
    const { bytesRead } = await file.read(buffer, received, buffer.length - received, received);
    if (!bytesRead) break;
    received += bytesRead;
  }
  if (received !== expectedBytes) throw unavailable();
  return buffer.subarray(0, received);
}
async function readEntry(path: string, relative: string, stat: FileStat, state: TreeState): Promise<void> {
  assertFile(stat, state);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertOpened(stat, await file.stat());
    const content = await readBounded(file, stat.size), after = await file.stat();
    if (!same(stat, await lstat(path)) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || content.length !== stat.size) throw unavailable();
    state.bytes += content.length;
    state.entries.push({ path: relative, mode: stat.mode & 0o111 ? 0o700 : 0o600,
      sizeBytes: content.length, digest: `sha256:${hash(content)}`, contentBase64: content.toString("base64") });
  } finally { await file.close(); }
}
async function walk(root: string, state: TreeState, prefix: string, depth: number): Promise<void> {
  if (depth > 16) throw unavailable();
  const before = await lstat(root); assertDirectory(before);
  const names = await readdir(root);
  if (names.length > 512) throw unavailable();
  for (const name of names.sort()) {
    const path = join(root, name), relative = prefix + name, stat = await lstat(path);
    if (stat.isSymbolicLink()) throw unavailable();
    if (stat.isDirectory()) await walk(path, state, `${relative}/`, depth + 1);
    else await readEntry(path, relative, stat, state);
  }
  const after = await lstat(root); assertDirectory(after);
  if (!same(before, after) || before.mtimeMs !== after.mtimeMs) throw unavailable();
}
async function tree(directory: string): Promise<RemoteFileTree> {
  const state: TreeState = { entries: [], bytes: 0 };
  await walk(directory, state, "", 0);
  if (!state.entries.some(entry => entry.path === "SKILL.md")) throw unavailable();
  return RemoteFileTreeSchema.parse({ format: "konteks-file-tree-v1",
    treeDigest: computeRemoteFileTreeDigest(state.entries), entries: state.entries });
}
interface Candidate { localId: string; directory: string; name: string }
async function profileCandidates(home: string): Promise<Candidate[]> {
  const skills = join(home, "skills");
  assertDirectory(await lstat(home)); assertDirectory(await lstat(skills));
  const canonical = await realpath(skills), names = await readdir(skills);
  if (names.length > 512) throw unavailable();
  const result: Candidate[] = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) continue;
    const directory = join(canonical, name), child = await lstat(directory);
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    result.push({ localId: hash(`konteks-personal-skill-v1\0${directory}`), directory, name });
  }
  return result;
}
/** Managed discovery links are never personal publication sources. */
async function candidates(homes: readonly string[]): Promise<Candidate[]> {
  if (homes.length > 16 || homes.some(home => !isAbsolute(home))) throw unavailable();
  const result: Candidate[] = [];
  for (const home of [...new Set(homes)]) {
    try { result.push(...await profileCandidates(home)); }
    catch { /* An unavailable profile is omitted from local inventory. */ }
  }
  return result;
}
export async function discoverLocalSkills(homes: readonly string[]): Promise<LocalSkillSummary[]> {
  const result: LocalSkillSummary[] = [];
  for (const item of await candidates(homes)) {
    if (result.length === 64) break;
    try {
      const files = await tree(item.directory);
      result.push(
        LocalSkillSummarySchema.parse({
          localId: item.localId,
          name: item.name,
          treeDigest: files.treeDigest,
          fileCount: files.entries.length,
          sizeBytes: files.entries.reduce((sum, file) => sum + file.sizeBytes, 0),
        }),
      );
    } catch {
      /* Unsafe or unsupported trees are never offered for promotion. */
    }
  }
  return result;
}
export async function exportLocalSkill(
  homes: readonly string[],
  selection: Pick<LocalSkillSummary, "localId" | "treeDigest">,
): Promise<RemoteFileTree> {
  const candidate = (await candidates(homes)).find((item) => item.localId === selection.localId);
  if (!candidate) throw unavailable();
  const result = await tree(candidate.directory);
  if (result.treeDigest !== selection.treeDigest) throw unavailable();
  return result;
}
