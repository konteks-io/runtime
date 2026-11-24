import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  computeRemoteFileTreeDigest,
  REMOTE_FILE_TREE_LIMITS,
  RemoteFileTreeSchema,
  sha256Hex,
  type RemoteFileEntry,
  type RemoteFileTree,
} from "@konteks/remote-common";
import { readFully } from "../read-fully.js";

const unavailable = () => new Error("Local Skill is unavailable or has changed");
const { bytes, depth, files, skills } = REMOTE_FILE_TREE_LIMITS;
const MAX_CANDIDATES = skills * 2;
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const folderName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface LocalSkillSummary {
  localId: string;
  name: string;
  treeDigest: string;
  fileCount: number;
  sizeBytes: number;
}

interface Candidate {
  localId: string;
  name: string;
  directory: string;
}

function sameSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs && before.mode === after.mode &&
    before.nlink === after.nlink;
}

async function directoryStat(path: string): Promise<Stats> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw unavailable();
  return before;
}

async function boundedNames(path: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(path)) {
    if (names.length === limit) throw unavailable();
    names.push(entry.name);
  }
  return names.sort();
}

async function readBytes(path: string, before: Stats, remaining: number): Promise<Buffer> {
  if (!before.isFile() || before.nlink !== 1 || before.size > remaining) throw unavailable();
  const handle = await open(path, readFlags);
  try {
    if (!sameSnapshot(before, await handle.stat())) throw unavailable();
    const buffer = Buffer.alloc(before.size + 1);
    const count = await readFully(handle, buffer);
    if (count !== before.size || !sameSnapshot(before, await handle.stat()) ||
      !sameSnapshot(before, await lstat(path))) throw unavailable();
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

async function readEntry(path: string, wirePath: string, before: Stats, remaining: number): Promise<RemoteFileEntry> {
  const content = await readBytes(path, before, remaining);
  return {
    path: wirePath,
    mode: before.mode & 0o111 ? 0o700 : 0o600,
    sizeBytes: content.length,
    digest: `sha256:${sha256Hex(content)}`,
    contentBase64: content.toString("base64"),
  };
}

class SkillFolderReader {
  readonly entries: RemoteFileEntry[] = [];
  size = 0;
  private visited = 0;

  async visit(directory: string, prefix: string, level: number): Promise<void> {
    if (level >= depth) throw unavailable();
    const before = await directoryStat(directory);
    const names = await boundedNames(directory, files);
    for (const name of names) await this.readChild(directory, name, prefix, level);
    if (!sameSnapshot(before, await directoryStat(directory))) throw unavailable();
  }

  private async readChild(directory: string, name: string, prefix: string, level: number) {
    if (++this.visited > files * 2) throw unavailable();
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      await this.visit(path, `${prefix}${name}/`, level + 1);
      return;
    }
    if (this.entries.length >= files) throw unavailable();
    const file = await readEntry(path, prefix + name, stat, bytes - this.size);
    this.entries.push(file);
    this.size += file.sizeBytes;
  }
}

async function capture(directory: string): Promise<RemoteFileTree> {
  if (await realpath(directory) !== directory) throw unavailable();
  const reader = new SkillFolderReader();
  await reader.visit(directory, "", 0);
  if (await realpath(directory) !== directory || !reader.entries.some(entry => entry.path === "SKILL.md")) {
    throw unavailable();
  }
  return RemoteFileTreeSchema.parse({
    format: "konteks-file-tree-v1",
    entries: reader.entries,
    treeDigest: computeRemoteFileTreeDigest(reader.entries),
  });
}

async function candidatesForHome(home: string): Promise<Candidate[]> {
  await directoryStat(home);
  const skillsPath = join(home, "skills");
  await directoryStat(skillsPath);
  const directory = await realpath(skillsPath);
  const names = await boundedNames(directory, MAX_CANDIDATES);
  return names.filter(name => folderName.test(name)).map(name => {
    const path = join(directory, name);
    return { localId: sha256Hex(`konteks-personal-skill-v1\0${path}`), name, directory: path };
  });
}

async function candidates(homes: readonly string[]): Promise<Candidate[]> {
  if (homes.length > 16 || homes.some(home => !isAbsolute(home))) throw unavailable();
  const result = new Map<string, Candidate>();
  for (const home of new Set(homes)) {
    const items = await candidatesForHome(home).catch(() => []);
    for (const item of items) {
      result.set(item.localId, item);
      if (result.size >= MAX_CANDIDATES) return [...result.values()];
    }
  }
  return [...result.values()];
}

/** The owner-facing inventory includes only opaque selection metadata. */
export async function discoverLocalSkills(homes: readonly string[]): Promise<LocalSkillSummary[]> {
  const result: LocalSkillSummary[] = [];
  for (const candidate of await candidates(homes)) {
    if (result.length >= skills) break;
    const tree = await capture(candidate.directory).catch(() => undefined);
    if (!tree) continue;
    result.push({
      localId: candidate.localId,
      name: candidate.name,
      treeDigest: tree.treeDigest,
      fileCount: tree.entries.length,
      sizeBytes: tree.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    });
  }
  return result;
}

/** Call only after verifying the owner's signed selection, scoped to this runtime. */
export async function exportLocalSkill(
  homes: readonly string[],
  selection: Pick<LocalSkillSummary, "localId" | "treeDigest">,
): Promise<RemoteFileTree> {
  const candidate = (await candidates(homes)).find(item => item.localId === selection.localId);
  if (!candidate) throw unavailable();
  const tree = await capture(candidate.directory).catch(() => { throw unavailable(); });
  if (tree.treeDigest !== selection.treeDigest) throw unavailable();
  return tree;
}
