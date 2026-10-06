import { constants } from "node:fs";
import { lstat, readdir, open, realpath } from "node:fs/promises";
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
async function tree(directory: string): Promise<RemoteFileTree> {
  const entries: RemoteFileEntry[] = [];
  let bytes = 0;
  const walk = async (root: string, prefix = "", depth = 0): Promise<void> => {
    if (depth > 16) throw unavailable();
    const before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink()) throw unavailable();
    const names = await readdir(root);
    if (names.length > 512) throw unavailable();
    for (const name of names.sort()) {
      const path = join(root, name),
        relative = prefix + name,
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw unavailable();
      if (stat.isDirectory()) {
        await walk(path, `${relative}/`, depth + 1);
        continue;
      }
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        entries.length >= 512 ||
        stat.size + bytes > 8 * 1024 * 1024
      )
        throw unavailable();
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          !same(stat, opened) ||
          opened.size !== stat.size
        )
          throw unavailable();
        const content = await file.readFile();
        const after = await file.stat();
        if (
          !same(stat, await lstat(path)) ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          content.length !== stat.size
        )
          throw unavailable();
        bytes += content.length;
        entries.push({
          path: relative,
          mode: stat.mode & 0o111 ? 0o700 : 0o600,
          sizeBytes: content.length,
          digest: `sha256:${hash(content)}`,
          contentBase64: content.toString("base64"),
        });
      } finally {
        await file.close();
      }
    }
    const after = await lstat(root);
    if (!same(before, after) || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink())
      throw unavailable();
  };
  await walk(directory);
  if (!entries.some((entry) => entry.path === "SKILL.md")) throw unavailable();
  return RemoteFileTreeSchema.parse({
    format: "konteks-file-tree-v1",
    treeDigest: computeRemoteFileTreeDigest(entries),
    entries,
  });
}
/** Never follow discovery links: organization links and external file trees are not personal promotion sources. */
async function candidates(homes: readonly string[]) {
  if (homes.length > 16 || homes.some((home) => !isAbsolute(home))) throw unavailable();
  const result: Array<{ localId: string; directory: string; name: string }> = [];
  for (const home of [...new Set(homes)]) {
    try {
      const profile = await lstat(home),
        skills = join(home, "skills"),
        stat = await lstat(skills);
      if (
        !profile.isDirectory() ||
        profile.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.isSymbolicLink()
      )
        continue;
      const canonical = await realpath(skills);
      const names = await readdir(skills);
      if (names.length > 512) continue;
      for (const name of names.sort()) {
        if (name.startsWith(".") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) continue;
        const directory = join(canonical, name),
          child = await lstat(directory);
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        result.push({ localId: hash(`konteks-personal-skill-v1\0${directory}`), directory, name });
      }
    } catch {
      /* An absent agent profile is not a failed inventory. */
    }
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
